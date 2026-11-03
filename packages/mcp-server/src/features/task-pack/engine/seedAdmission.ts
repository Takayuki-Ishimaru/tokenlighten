// seedAdmission — extracted implementation; imports point to the owning modules.
import * as fs from "fs";
import type { TaskPackArgs } from "../model.js";
import type { TaskPackPathEntry } from "../model.js";
import { FileReadCache } from "./packBasics2.js";
import { SINGLE_SITE_SHORT_CIRCUIT_MAX_CODE_BYTES } from "./semanticFrontier2.js";
import { SINGLE_SITE_SHORT_CIRCUIT_PATH_RE } from "./semanticFrontier2.js";
import { blockCommentOpenerFor } from "../../../util/lineClassify.js";
import { centeredSliceForCap } from "./packBasics2.js";
import { classifyCommentLines } from "../../../util/lineClassify.js";
import { classifySurface } from "../../../util/impact.js";
import { commentSyntaxIsKnown } from "../../../util/lineClassify.js";
import { commentSyntaxLanguageForPath } from "../../../util/lineClassify.js";
import { countLines } from "../../../util/countLines.js";
import { currentSessionLane } from "../../../util/laneKey.js";
import { decodeTextBuffer } from "../../../util/textDecode.js";
import { exactReplacementFromQuery } from "./servedStateAndEdits2.js";
import { executedSearchResults } from "../../../util/packServeLog.js";
import { explicitCodeIdentifiers } from "./anchorFocus2.js";
import { hasExplicitIndependentConcernMarker } from "./roleAndConcernScope2.js";
import { hasIndependentEditConcernClauses } from "./roleAndConcernScope2.js";
import { isWithin } from "../../../util/safePath.js";
import { languageForPath } from "../../../util/languages.js";
import { languageForPathWithContent } from "../../../util/languages.js";
import { lineCommentPrefixesFor } from "../../../util/lineClassify.js";
import { queryServedSurfaces } from "../../../util/packServeLog.js";
import { readFileForRequest } from "../../../util/requestFileCache.js";
import { readServedText } from "../../../util/textDecode.js";
import { resolveReal } from "../../../util/safePath.js";
import { safeResolve } from "../../../util/safePath.js";
import { servedTextOrUndefined } from "../../../util/textDecode.js";
import { statKindCached } from "../../../util/packServeLog.js";
import { tokenizeForEpoch } from "../../../state/session.js";

/**
 * The query carries a second, independent change or a rename relation, so
 * seeding the one file it names would hide the rest of the request (T2's
 * fail-open rule, shared by `explicitSingleEditRequestPath`'s seed).
 */
export function asksBeyondOneNamedSite(query: string): boolean {
  if (hasIndependentEditConcernClauses(query) || hasExplicitIndependentConcernMarker(query)) return true;
  if (/(?:,|;|\n)\s*(?:and\s+)?(?:also\s+)?(?:fix|add|implement|change|replace|rename|refactor|wire|connect|update|create)\b/iu.test(query)
    || /(?:、|。|\n)\s*(?:さらに|加えて)?[^\n]{0,80}(?:修正|追加|実装|変更|置換|改名|接続|作成)/u.test(query)) return true;
  return /\b(?:rename|renamed|renaming)\b/iu.test(query) || /(?:改名|リネーム)/u.test(query);
}

/** True when `relPath` resolves, through its realpath, to a regular file inside `workspace`. */
export function isExistingWorkspaceFile(relPath: string, workspace: string): boolean {
  const abs = safeResolve(relPath, workspace);
  if (abs === undefined) return false;
  try {
    const real = fs.realpathSync(abs);
    return isWithin(real, resolveReal(workspace)) && fs.statSync(real).isFile();
  } catch {
    return false;
  }
}

export function singleSiteShortCircuitSeed(
  query: string,
  workspace: string,
): TaskPackPathEntry | undefined {
  if (query.trim().length === 0) return undefined;
  if (asksBeyondOneNamedSite(query)) return undefined;

  const candidates: Array<{ relPath: string; real: string }> = [];
  const seenRelPaths = new Set<string>();
  for (const match of query.matchAll(SINGLE_SITE_SHORT_CIRCUIT_PATH_RE)) {
    const relPath = match[0]!.replace(/\\/g, "/").replace(/^\.\//, "");
    if (seenRelPaths.has(relPath)) continue;
    seenRelPaths.add(relPath);
    const abs = safeResolve(relPath, workspace);
    if (abs === undefined) continue;
    try {
      const real = fs.realpathSync(abs);
      if (!isWithin(real, resolveReal(workspace)) || !fs.statSync(real).isFile()) continue;
      candidates.push({ relPath, real });
    } catch {
      continue;
    }
    if (candidates.length > 1) break;
  }
  if (candidates.length !== 1) return undefined;
  const { relPath, real } = candidates[0]!;

  let buf: Buffer;
  try {
    // served-bytes: readServedText
    buf = readFileForRequest(real);
  } catch {
    return undefined;
  }
  // served-bytes: readServedText
  // SHOULD-FIX 58 (AB1, 2026-09-14, review round 11). AA1 listed this binder as
  // a NON-door because "a file it matches is then sliced through door 1, which
  // refuses it: consistent fail-closed". It is not consistent: BINDING here is
  // what surfaces the path, and `augmentQueryNamedFileSurfaces` — the only
  // caller of `noteUnreadableNamedPath` on door 1 — skips a path the locator
  // already surfaced (`if (already.has(rel)) continue;`). So an undecodable
  // named file bound here came back as `evidence:[{why:"filename-match", len:0}]`
  // with NO disclosure and a prescribed `next` that refuses — measured for 4 of
  // AA1's own 5 undecodable fixtures in `aa1-doors-final.log`. Declining here
  // hands the file to the augmentation path, which discloses it. Also removes
  // the last `decodeTextBuffer` (4 KB NUL probe) from a path that decides which
  // lines a pack serves.
  // served-bytes: readServedText
  const content = servedTextOrUndefined(buf);
  if (content === undefined) return undefined;

  // Bind to a literal already provable inside this exact file: the parsed
  // replacement's search text when T1 recognized one, else the strongest
  // explicit identifier the query names. Neither is inferred from prose --
  // both come from the same conservative extractors the rest of this file
  // already trusts.
  const parsedReplacement = exactReplacementFromQuery(query);
  const needle = parsedReplacement === undefined
    ? undefined
    : "identifierOldValue" in parsedReplacement
      ? parsedReplacement.identifierOldValue
      : parsedReplacement.search;
  const identifierCandidates = needle !== undefined ? [needle] : explicitCodeIdentifiers(query);
  if (identifierCandidates.length === 0) return undefined;

  let matchLine: number | undefined;
  for (const identifier of identifierCandidates) {
    if (identifier.length === 0) continue;
    if (content.split(identifier).length - 1 !== 1) continue;
    const offset = content.indexOf(identifier);
    matchLine = content.slice(0, offset).split(/\r?\n/).length;
    break;
  }
  if (matchLine === undefined) return undefined;

  // Byte-budgeted, not line-budgeted: dense real code (long lines) and
  // sparse code (short lines) both land under the same response-size target
  // this way, reusing the exact growth algorithm every other slice in this
  // file already goes through (centeredSliceForCap) rather than a second,
  // hand-rolled approximation of it. Seed a throwaway cache with the buffer
  // already decoded above so this does not re-read the file from disk.
  // FIX-ORIG (2026-09-27, eval-0927 P1 §6.1): was content.split(/\r?\n/).length,
  // which counts a PHANTOM final segment for content ending in a trailing
  // newline (util/countLines.ts's own doc comment) -- a 16-line file minted
  // "1-17" here, and for a file small enough to take centeredSliceForCap's
  // whole-range fast path (no `remaining_ranges` to re-derive `end` from
  // below), that inflated value shipped verbatim as this seed's `range`.
  // countLines() is the shared, trailing-newline-aware count the mint and
  // tl_edit_file's own bounds check already agree on.
  const totalLines = countLines(content);
  const sliceCache = new FileReadCache();
  // served-bytes: readServedText
  sliceCache.seed(relPath, content, readServedText(buf));
  const slice = centeredSliceForCap(
    workspace, relPath, `1-${totalLines}`, sliceCache, matchLine, SINGLE_SITE_SHORT_CIRCUIT_MAX_CODE_BYTES,
  );
  if (slice === undefined) return undefined;
  // Recover the served bounds from centeredSliceForCap's remaining_ranges
  // by POSITION relative to matchLine, not by boundary VALUE: T3's own
  // DEFECT B fix (2026-08-27) caps each side's disclosed width, so a
  // "before" entry's start is no longer guaranteed to be exactly 1 (nor an
  // "after" entry's end exactly totalLines) once the true leftover exceeds
  // that cap -- matching on those exact values silently produced the
  // WRONG served range (falling back to the whole-file default) the
  // moment a real target file was large enough to trigger the cap.
  let start = 1;
  let end = totalLines;
  for (const remaining of slice.remaining_ranges) {
    const bounds = /^(\d+)-(\d+)$/.exec(remaining);
    if (bounds === null) continue;
    const [, remStart, remEnd] = bounds.map(Number) as [number, number, number];
    if (remEnd < matchLine) start = remEnd + 1;
    else if (remStart > matchLine) end = remStart - 1;
  }
  return { path: relPath, range: `${start}-${end}` };
}

/** TL142-01A: at most this many located paths may be promoted to seeds on one rebuild. */
export const MAX_EXECUTED_SEARCH_SEED_PATHS = 4;

/**
 * R1-B2 (2026-09-13 review round): the `why` for a path a server-prescribed
 * search LOCATED. Deliberately carries no `caller-supplied` marker — the readers
 * that key off that marker (`whySummary`'s summarizer, the caller-scoped
 * evidence-trust gates) must not mistake a server-derived promotion for the
 * caller's own explicit location.
 */
export const EXECUTED_SEARCH_LOCATED_WHY = "executed-search-located";

/**
 * SHOULD-FIX 28 (2026-09-14, review round 4): the same provenance with the
 * weaker claim stated on the wire — an executed search DID locate this file for
 * a term the query names, and this server cannot classify the file's comment
 * syntax, so it cannot say the occurrence is a declaration rather than a comment.
 *
 * The caller gets the bytes and judges for itself; the certificate stays open
 * (nothing discharges `identifier:<term>` from such a surface). The alternative
 * this replaces was to discard the file, which left the chain with no `next` at
 * all one call after the search had found it.
 */
/**
 * EXACTLY 60 CHARACTERS, deliberately: `whySummary`'s default branch passes a
 * raw `why` through untouched up to 60 and hard-truncates past it, so a longer
 * spelling would reach the wire cut mid-word. Keep it at or under 60 if it is
 * ever reworded.
 */
export const EXECUTED_SEARCH_UNCLASSIFIED_WHY = "executed-search-located; language not classified, unverified";

/**
 * R1-B2 (2026-09-13 review round): file classes whose occurrence of an
 * identifier is PROSE ABOUT code, never the code.
 *
 * Extension-driven and deliberately coarse: `classifySurface` answers "doc" only
 * for markdown outside `docs/`, so `docs/notes.md` — the exact shape that
 * produced the false certificate — falls through it entirely. Office/PDF
 * containers are here for the same reason: a find hit in one is text, not a
 * declaration.
 */
export const PROSE_HIT_EXTENSIONS = [
  ".md", ".markdown", ".mdx", ".rst", ".txt", ".adoc", ".asciidoc", ".rtf", ".log",
  ".docx", ".doc", ".pptx", ".ppt", ".xlsx", ".xls", ".pdf", ".csv", ".tsv",
] as const;

/**
 * R2-B13 (2026-09-13 review round 2): interface-markup and stylesheet
 * extensions, whose CONTENT is presentation rather than a declaration.
 *
 * The `classifySurface` rule below catches most of these (`"ui"`/`"style"`), but
 * only by directory or filename convention: `src/page.html` is `"ui"` while
 * `src/markup.html` is `"unknown"`, and the same markup would then be credited as
 * this identifier's declaration purely because of where it happens to live. This
 * makes the class decide, not the path — and matches this wave's own
 * `looksLikeMarkupOrCssWindow`, which already refuses such a window as answer
 * evidence.
 */
export const MARKUP_HIT_EXTENSIONS = [
  ".html", ".htm", ".xhtml", ".xml", ".svg", ".vue", ".svelte",
  ".css", ".scss", ".less", ".sass", ".styl",
] as const;

/** Cap on the file a code-bearing check will read (mirrors the locator's own comment-scan ceiling). */
export const EXECUTED_SEARCH_HIT_SCAN_MAX_BYTES = 512 * 1024;

/**
 * R2-B13 (2026-09-13 review round 2): `classifySurface` classes whose content is
 * PROSE, INTERFACE MARKUP or STYLING — never a declaration that may discharge an
 * `identifier:<term>` obligation.
 *
 * Round 1 closed the markdown carrier by extension; round 2 reached the exact
 * same false certificate through `src/page.html`, whose class is `"ui"` and
 * whose extension is in no prose list. This wave's own
 * `looksLikeMarkupOrCssWindow` already treats markup/CSS windows as non-evidence
 * for an answer — the promotion gate must agree with it rather than credit the
 * same bytes as a declaration.
 *
 * `"unknown"` is deliberately NOT here: it is the class of an ordinary
 * `src/auth.ts` / `src/retry.ts`, so refusing it would delete TL142-01A/01B
 * altogether. The fail-closed treatment of an unclassifiable file happens on the
 * LANGUAGE axis instead (`commentSyntaxIsKnown` below) — an extension whose
 * comment syntax this server cannot recognize never counts as code.
 *
 * BLOCKER 30 (2026-09-14, review round 5): round 4 widened this set to
 * `{"doc","ui","style"}`, reasoning (correctly) that `"ui"`/`"style"` catch the
 * SAME `src/page.html` shape the extension lists already independently close.
 * What that missed: `classifySurface`'s `"ui"`/`"style"` rules are NOT
 * extension-only — `"ui"` also fires for ANY path containing `/component`,
 * `/page`, `/web/`; `"style"` also fires for ANY path containing `/theme`. So
 * `src/components/settings.ts` (an ordinary `.ts` file whose declaration is
 * real code) was refused solely because of a DIRECTORY NAME, while the
 * byte-identical `src/core/settings.ts` was not — a path-segment heuristic
 * deciding code-bearing-ness, exactly the failure mode this constant's own
 * original doc comment (above) warns against ("This makes the class decide,
 * not the path"). `"doc"` is kept — `classifySurface` returns it ONLY for a
 * bare `.md` outside `docs/`/`proto/` (`util/impact.ts`'s case 2e), which
 * `PROSE_HIT_EXTENSIONS`'s unconditional `.md` entry and the
 * `languageForPath === "markdown"` check below already refuse regardless of
 * directory — so keeping it here is redundant with, never narrower than,
 * those two extension-driven checks, and every markup/stylesheet EXTENSION
 * R1-B2/R2-B13 actually closed (`.html/.htm/.xhtml/.xml/.svg/.vue/.svelte/
 * .css/.scss/.less/.sass/.styl`) stays refused via `MARKUP_HIT_EXTENSIONS`
 * below, which is extension-only by construction. `.tsx`/`.jsx` deliberately
 * fall OUT of this set now: JSX/TSX source is code, and `pathClassCanCarryCode`
 * still requires `termOccursOutsideComments` to pass — a comment-only mention
 * there is refused by that conjunct, not this one.
 */
export const NON_CODE_HIT_SURFACE_CLASSES: ReadonlySet<string> = new Set(["doc"]);

/**
 * R1-B2: is this recorded hit CODE-BEARING EVIDENCE FOR THIS TERM — i.e. may it
 * discharge an `identifier:<term>` obligation?
 *
 * `find` matches anywhere in a file: comments, string literals, markdown prose.
 * Promoting such a hit to a surface made the pack's own certificate assert that
 * `identifier:quantumTeleportationMode` was proved by served evidence whose text
 * said *"it is not implemented anywhere in this codebase"* — the certificate and
 * the bytes backing it disagreed.
 *
 * Four conjuncts, all fail-closed (a hit that cannot be shown code-bearing is
 * treated as "no code hit", which leaves the obligation uncovered and the
 * discovery open — never a certificate):
 *  - the file is not a prose/document class (`PROSE_HIT_EXTENSIONS`,
 *    `languageForPath` = markdown, or `classifySurface` = doc);
 *  - R2-B13: the file's `classifySurface` class is not prose/interface-markup/
 *    styling (`NON_CODE_HIT_SURFACE_CLASSES`);
 *  - R2-B13: this server actually KNOWS the file's comment syntax
 *    (`commentSyntaxIsKnown`). Round 1's conjunct below is only as strong as
 *    `util/lineClassify.ts`'s table, whose `default: []` meant "this language has
 *    no comments" for every language the table never learned — so a term inside
 *    an HTML `<!-- ... -->` comment, a SQL `--` comment or an ini `;` comment read
 *    as code and minted the round-1 certificate again. An unknown language is now
 *    "not provably code", not "comment-free";
 *  - the term occurs at least once OUTSIDE comments and outside a trailing
 *    inline comment, via the same parse-free classifier the locator's
 *    comment-only precision penalty uses (`util/lineClassify.ts`). A word-
 *    boundary match, so `quantumTeleportationModeFlag` does not prove
 *    `quantumTeleportationMode`.
 *
 * Deliberately NOT a declaration-only rule: a call site is real code evidence
 * for the identifier, and requiring a declaration would drop the common
 * "defined in a dependency, used here" answer. Deliberately NOT string-aware
 * either — that is the documented imprecision of the cheap lexical pass this
 * shares with the locator, and it errs toward ADMITTING a string occurrence in a
 * code file, which is the same direction the pre-existing
 * `exactIdentifierEvidence` test already takes for any served surface.
 */
/**
 * SHOULD-FIX 28/29 (2026-09-14, review round 4): does `term` occur at least once
 * in `content` OUTSIDE every comment, for a language whose comment syntax is
 * KNOWN?
 *
 * Extracted verbatim from the original `executedSearchHitIsCodeBearing`'s tail so the
 * promotion gate (does a `find` hit deserve a surface?) and the obligation gate
 * (may a served surface DISCHARGE `identifier:<term>`? — finding 29) can never
 * disagree about what "occurs in code" means. Word-boundary, so
 * `quantumTeleportationModeFlag` does not prove `quantumTeleportationMode`.
 *
 * Fails closed on an unknown language: `classifyCommentLines` would then be
 * asked with an EMPTY prefix list and answer "not a comment" for every line,
 * which is not a fact about the file (R2-B13). Deliberately NOT string-aware —
 * the documented imprecision of this cheap lexical pass, shared with the
 * locator.
 */
export function termOccursOutsideComments(content: string, relPath: string, term: string): boolean {
  // SHOULD-FIX 28: ask THIS module's own comment-syntax map after the grammar
  // map, so `.swift` / `.sql` / `.ini` (taught in `LINE_COMMENT_PREFIXES`, absent
  // from `EXT_TO_LANGUAGE`) resolve instead of reading as "unknown language".
  const language = commentSyntaxLanguageForPath(relPath, languageForPathWithContent(relPath, content));
  if (!commentSyntaxIsKnown(language)) return false;
  const matcher = new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
  const commentFlags = classifyCommentLines(content, language!);
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!matcher.test(line)) continue;
    if (commentFlags[i] === true) continue;
    // A trailing line comment on an otherwise-real code line: the classifier
    // above deliberately leaves such a line unflagged (its code portion is
    // real), so test the code portion itself before crediting the match.
    const codePortion = codePortionOfLine(line, language!);
    if (matcher.test(codePortion)) return true;
  }
  return false;
}

/**
 * SHOULD-FIX 27/28/29 (2026-09-14, review round 4): one bounded, symlink-safe
 * whole-file text read for the three honesty gates that need to ask a file a
 * question rather than trust a stamp.
 *
 * Returns `undefined` for anything the caller must treat as unknowable: outside
 * the workspace real root, not a regular file, over
 * `EXECUTED_SEARCH_HIT_SCAN_MAX_BYTES`, unreadable, or undecodable. Every caller
 * fails CLOSED on `undefined` — none of them may read "I could not look" as "the
 * answer is no".
 */
export function boundedWorkspaceText(workspace: string, relPath: string): string | undefined {
  const abs = safeResolve(relPath, workspace);
  if (abs === undefined) return undefined;
  try {
    const real = fs.realpathSync(abs);
    if (!isWithin(real, resolveReal(workspace))) return undefined;
    const stat = fs.statSync(real);
    if (!stat.isFile() || stat.size > EXECUTED_SEARCH_HIT_SCAN_MAX_BYTES) return undefined;
    // served-bytes: not-served (executed-search hit VERIFICATION: undefined means 'I could not look', never 'the answer is no')
    return decodeTextBuffer(readFileForRequest(real)) ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * SHOULD-FIX 28 (2026-09-14, review round 4): is this path's CONTENT CLASS
 * capable of carrying a declaration at all?
 *
 * The path/class refusals the original `executedSearchHitIsCodeBearing`
 * always applied, factored out: prose/document extensions, markdown, interface
 * markup/stylesheet extensions, and (BLOCKER 30, 2026-09-14 review round 5:
 * narrowed from `doc`/`ui`/`style` back to `doc` alone — see
 * `NON_CODE_HIT_SURFACE_CLASSES`'s own doc for why `ui`/`style` were a
 * path-segment heuristic in disguise, not a content-class one) the `doc`
 * surface class. Unlike the LANGUAGE axis, a refusal here is about the file's
 * kind and is never softened to "serve it anyway" — a README or a stylesheet
 * is not an unclassified declaration, it is a non-declaration.
 */
export function pathClassCanCarryCode(relPath: string): boolean {
  const lower = relPath.toLowerCase();
  if (PROSE_HIT_EXTENSIONS.some((ext) => lower.endsWith(ext))) return false;
  // R2-B13: markup/stylesheet content is presentation, not a declaration.
  if (MARKUP_HIT_EXTENSIONS.some((ext) => lower.endsWith(ext))) return false;
  if (languageForPath(relPath) === "markdown") return false;
  // BLOCKER 30 (2026-09-14, review round 5): EXTENSION-only from here down —
  // `classifySurface`'s `doc` class is a strict subset of the `.md` checks
  // above, so this conjunct never refuses anything the extension lists
  // above did not already refuse. It no longer consults `ui`/`style`, which
  // mixed in `classifySurface`'s directory-name heuristics
  // (`/component`, `/page`, `/web/`, `/theme`) — a path's ROLE, not what its
  // bytes are — and refused an ordinary `src/components/settings.ts`
  // declaration purely for living under `components/`.
  return !NON_CODE_HIT_SURFACE_CLASSES.has(classifySurface(relPath));
}

/**
 * SHOULD-FIX 28 (2026-09-14, review round 4) — THREE ANSWERS, NOT TWO.
 *
 * The original `executedSearchHitIsCodeBearing` conflated two facts behind one
 * `false`: "these bytes are not a declaration" and "this server cannot TELL
 * whether these bytes are a declaration". The second answer was costing real
 * recall: a `let quantumTeleportationMode = true` in `src/feature.swift`, or a
 * `plasmaConduitMode=true` in an extensionless `bin/tool`, was LOCATED by the
 * prescribed `find` and then discarded — the pack never served the file and the
 * chain dead-ended at `await_input:"no-grounded-call-remains"` with no `next`,
 * one call after TL had the answer in hand. The `.mjs` control certified.
 *
 *  - `"code"`    — a known language, term outside comments. May be promoted AND
 *                  may discharge the `identifier:<term>` obligation.
 *  - `"located"` — the file's CLASS can carry code, but this server cannot
 *                  classify its comment syntax, so it cannot prove the
 *                  occurrence is a declaration rather than a comment. Promoted
 *                  and SERVED (the caller reads it and judges), never allowed to
 *                  discharge anything: `exactIdentifierEvidence` runs the same
 *                  `termOccursOutsideComments` test on the served surface, so an
 *                  unclassified language leaves the obligation uncovered and the
 *                  certificate open. Certification is unchanged — fail-closed —
 *                  and only the SERVE decision is relaxed.
 *  - `"refused"`  — prose/markup/doc-class content, an unreadable/oversize file,
 *                  or a KNOWN language whose only occurrences are inside
 *                  comments (round 1's BLOCKER 2 and round 2's BLOCKER 13 —
 *                  those must stay out of the pack entirely, because serving a
 *                  markdown sentence as the identifier's surface is what minted
 *                  the false certificate in the first place).
 */
export function classifyExecutedSearchHit(
  workspace: string,
  relPath: string,
  term: string,
): "code" | "located" | "refused" {
  if (!pathClassCanCarryCode(relPath)) return "refused";
  const content = boundedWorkspaceText(workspace, relPath);
  if (content === undefined) return "refused";
  const language = commentSyntaxLanguageForPath(relPath, languageForPathWithContent(relPath, content));
  // R2-B13/SHOULD-FIX 28: an unknown language is still not provably code — but
  // it is now SERVED under its own `why` instead of vanishing.
  if (!commentSyntaxIsKnown(language)) return "located";
  return termOccursOutsideComments(content, relPath, term) ? "code" : "refused";
}

/**
 * R1-B2's original predicate now reads `classifyExecutedSearchHit(...) === "code"`
 * at each call site: `"code"` is the only verdict that may DISCHARGE an
 * `identifier:<term>` obligation, and both promotion sites additionally admit
 * `"located"` for SERVING only (SHOULD-FIX 28). A single boolean cannot express
 * that split, so the wrapper is gone rather than kept as a lossy alias.
 */

/**
 * R1-B2: the part of one line that is not a trailing comment.
 *
 * R2-B13: reads `util/lineClassify.ts`'s OWN table instead of guessing a prefix
 * from the path. The guess was `["#"]` for five languages and `["//"]` for
 * everything else — so it stripped a `//` that is not a comment in CSS, SQL or
 * an ini file, and stripped nothing at all where the real syntax is `--`, `;` or
 * `<!--`. One table, one answer: whatever `classifyCommentLines` treats as
 * comment syntax is exactly what this strips. The caller has already refused an
 * unknown language, so `lineCommentPrefixesFor` never returns `undefined` here;
 * the `?? []` keeps this total (an unknown language then keeps the whole line,
 * which is the pre-existing conservative behaviour).
 */
export function codePortionOfLine(line: string, language: string): string {
  let cut = line.length;
  for (const prefix of lineCommentPrefixesFor(language) ?? []) {
    if (prefix.length === 0) continue;
    const at = line.indexOf(prefix);
    if (at >= 0 && at < cut) cut = at;
  }
  const opener = blockCommentOpenerFor(language);
  if (opener !== undefined) {
    const at = line.indexOf(opener);
    if (at >= 0 && at < cut) cut = at;
  }
  return line.slice(0, cut);
}

/**
 * TL142-01A: the workspace-relative paths an executed search LOCATED for a term
 * this query itself names, in deterministic order.
 *
 * Three gates, all fail-closed:
 *  - the recorded term must occur VERBATIM in the query (case-sensitive). The
 *    result ledger merges this lane's unbound partition, so without this a
 *    search another task ran could seed files into an unrelated pack.
 *  - the hit must still exist on disk (a stale ledger entry seeds nothing).
 *  - at most `MAX_EXECUTED_SEARCH_SEED_PATHS` paths, so a broad find cannot
 *    turn a focused rebuild into a sweep.
 *
 * Deliberately NOT filtered on whether the epoch already served the path: a
 * seed says which files this pack is ABOUT, and the pack's own dedup passes
 * (`applyPackDedupe`/`applyResidentFileDedup`) decide whether its bytes are
 * re-sent. Filtering here would drop the located file from the surface set on
 * the very next rebuild and re-open the obligation it just closed.
 */
export function executedSearchHitSeeds(
  workspace: string,
  args: TaskPackArgs,
  query: string,
): { code: string[]; unclassified: string[] } {
  const recorded = executedSearchResults(workspace, currentSessionLane(), args.taskBinding);
  if (recorded.length === 0) return { code: [], unclassified: [] };
  const code: string[] = [];
  const unclassified: string[] = [];
  for (const entry of recorded) {
    if (entry.hits.length === 0) continue;
    if (!query.includes(entry.term)) continue;
    for (const hit of entry.hits) {
      if (code.includes(hit.path) || unclassified.includes(hit.path)) continue;
      if (statKindCached(workspace, workspace, hit.path) !== "file") continue;
      // R1-B2 (2026-09-13 review round): a hit is promoted to this rebuild's
      // surface only when it is CODE-BEARING EVIDENCE FOR THE TERM. `find`
      // matches prose too, and a markdown sentence mentioning the identifier
      // was being promoted as that identifier's surface — which the ordinary
      // obligation pass (`exactIdentifierEvidence`, a word-boundary text test)
      // then accepted as proof, certifying `act.answer` over a doc whose own
      // body said the identifier is not implemented anywhere.
      //
      // SHOULD-FIX 28 (2026-09-14, review round 4): `"refused"` still keeps the
      // hit out of the pack entirely — that is R1-B2/R2-B13's own rule. What
      // changes is `"located"`: a file whose class CAN carry code but whose
      // comment syntax this server cannot classify (`.swift`, `bin/tool`) is
      // SERVED under its own `why` instead of being discarded, so the chain
      // progresses. It still cannot DISCHARGE anything —
      // `exactIdentifierEvidence` applies the same code-bearing test to the
      // served surface — so certification stays exactly as fail-closed as before.
      const verdict = classifyExecutedSearchHit(workspace, hit.path, entry.term);
      if (verdict === "refused") continue;
      (verdict === "code" ? code : unclassified).push(hit.path);
      if (code.length + unclassified.length >= MAX_EXECUTED_SEARCH_SEED_PATHS) {
        return { code: code.sort(), unclassified: unclassified.sort() };
      }
    }
  }
  return { code: code.sort(), unclassified: unclassified.sort() };
}

/**
 * R1-B2 (2026-09-13 review round): the still-valid surfaces THIS EPOCH already
 * served, carried alongside an executed search's located paths so promoting a
 * hit cannot evict evidence the task already proved from.
 *
 * `queryServedSurfaces` does the honest work: it is epoch-gated (a different
 * task's surfaces are never returned) and it re-stats every entry it returns, so
 * a file edited or deleted since it was served is invalidated rather than
 * carried. Bounded by the same seed cap the located list uses — this is a
 * continuation aid, not a licence to re-pack the whole session.
 */
export function retainedServedSeedPaths(
  workspace: string,
  query: string,
  located: readonly string[],
): string[] {
  const exclude = new Set(located);
  const carried: string[] = [];
  for (const entry of queryServedSurfaces(workspace, workspace, {
    excludePaths: exclude,
    epochTokens: tokenizeForEpoch(query),
  })) {
    if (carried.includes(entry.path)) continue;
    if (statKindCached(workspace, workspace, entry.path) !== "file") continue;
    carried.push(entry.path);
    if (carried.length >= MAX_EXECUTED_SEARCH_SEED_PATHS) break;
  }
  return carried;
}
