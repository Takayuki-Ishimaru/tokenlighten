// seedResolution — extracted implementation; imports point to the owning modules.
import * as fs from "fs";
import * as path from "path";
import type { AnchorFocusResult } from "./anchorFocus.js";
import type { ClauseHygieneItem } from "../concernRecovery.js";
import type { ClauseRecoveryLocateResult } from "../concernRecovery.js";
import type { CollectedSymbol } from "../../../symbols/collectSymbols.js";
import type { ImpactCandidate } from "@tokenlighten/types";
import type { TaskPackArgs } from "../model.js";
import type { TaskPackPathEntry } from "../model.js";
import type { TaskPackSurface } from "../model.js";
import type { TaskProfileBinding } from "@tokenlighten/types";
import { BEHAVIOR_QUERY_RE } from "./changeAndReadinessEvidence2.js";
import { CUMULATIVE_LOCATE_BUDGET_MS } from "../concernRecovery.js";
import { FileReadCache } from "./packBasics2.js";
import { LIGHT_ANSWER_MAX_BYTES } from "../lightAnswer.js";
import { LIGHT_ANSWER_MAX_LINES } from "../lightAnswer.js";
import { MAX_CLAUSE_LOCATES } from "../concernRecovery.js";
import { MAX_SURFACES_DISTINCT } from "./packBasics2.js";
import { anchorWindowStartLine } from "./anchorFocus3.js";
import { bindTaskProfile } from "./coverageAndContinuation4.js";
import { clauseCoverageTokenSet } from "../concernRecovery.js";
import { collectSymbols } from "../../../symbols/collectSymbols.js";
import { countLines } from "../../../util/countLines.js";
import { distinctMatchedTokenCount } from "../concernRecovery.js";
import { effLightAnswerEnabled } from "../../../util/flags.js";
import { explicitCodeIdentifiers } from "./anchorFocus2.js";
import { extractFacetRequirements } from "./packBasics2.js";
import { extractRequestItems } from "./packBasics2.js";
import { extractSymbolsFromFile } from "../../../tools/readCodeModes.js";
import { framedCodeNamesIn } from "../requestFacets.js";
import { hasDefectSymptomMarker } from "./coverageAndContinuation4.js";
import { hasRequestedMutationIntent } from "./coverageAndContinuation3.js";
import { hasServedCode } from "./wiringEvidence2.js";
import { hygienicClauseWorkList } from "../concernRecovery.js";
import { identifierNamesSymbol } from "./anchorFocus3.js";
import { isStructuralOnlyRequest } from "../requestFacets.js";
import { isTestConcernPath } from "./literalAndConcernSeeds.js";
import { isWithin } from "../../../util/safePath.js";
import { lightAnswerDependencyLine } from "../lightAnswer.js";
import { lightAnswerHasWholeIdentifier } from "../lightAnswer.js";
import { lightAnswerLanguage } from "../lightAnswer.js";
import { lightAnswerLineCount } from "../lightAnswer.js";
import { lightAnswerSubjectElsewhere } from "./seedResolution2.js";
import { locateTaskContext } from "../../locator/locateTaskContext.js";
import { normalizePathEntry } from "./packBasics2.js";
import { parsePackLineRange } from "./packState2.js";
import { queryNamedPathTokens } from "./queryIntent3.js";
import { readFileForRequest } from "../../../util/requestFileCache.js";
import { readServedText } from "../../../util/textDecode.js";
import { resolveReal } from "../../../util/safePath.js";
import { safeResolve } from "../../../util/safePath.js";
import { selectAnchorFocus } from "./anchorFocus3.js";
import { tokenizeQuery as tokenizeQueryForDiversification } from "../../retrieval/tokenize.js";
import { unqualifiedSymbolTail } from "./anchorFocus3.js";
import { walkCodeFiles } from "../../../tools/walkRepo.js";

/**
 * Workspace-relative POSIX directory that contains every path in `relPaths`.
 * Returns "" when the paths share no ancestor below the workspace root
 * itself (locator fill is then confined to the whole workspace, i.e.
 * effectively unconfined — this only happens for seeds scattered across
 * unrelated top-level directories, which is rare and safe to leave
 * unscoped rather than wrongly excluding a legitimate top-level file).
 */
export function commonAncestorDir(relPaths: string[]): string {
  if (relPaths.length === 0) return "";
  const segLists = relPaths.map((p) => p.split("/").slice(0, -1)); // drop the basename
  let common = segLists[0]!;
  for (const segs of segLists.slice(1)) {
    let i = 0;
    while (i < common.length && i < segs.length && common[i] === segs[i]) i++;
    common = common.slice(0, i);
    if (common.length === 0) break;
  }
  return common.join("/");
}

/**
 * True when `surface` already SERVES every line of `range`: it carries a
 * body, its own range contains `range`, and none of the windows it admits it
 * did not serve (`remaining_ranges`) intersects it. Anything unparseable is
 * "not covered" -- the callers use this to SKIP work, so the safe answer is no.
 */
export function surfaceBodyCoversRange(surface: TaskPackSurface, range: string): boolean {
  if (surface.code === undefined) return false;
  const outer = parsePackLineRange(surface.range);
  const inner = parsePackLineRange(range);
  if (outer === undefined || inner === undefined) return false;
  if (inner[0] < outer[0] || inner[1] > outer[1]) return false;
  for (const window of surface.remaining_ranges ?? []) {
    const hole = parsePackLineRange(window);
    if (hole === undefined) return false;
    if (hole[0] <= inner[1] && hole[1] >= inner[0]) return false;
  }
  return true;
}

/** True when this surface's served body shows line `line` of its file (the main range minus its holes, or an appended window). */
export function surfaceServesLine(surface: TaskPackSurface, line: number): boolean {
  // A `code_unchanged` residency pointer is the caller's own copy of the same bytes: it serves
  // exactly what its code would (a re-pack of an answered task must stay answered).
  if (!hasServedCode(surface)) return false;
  const outer = parsePackLineRange(surface.range);
  if (outer !== undefined && line >= outer[0] && line <= outer[1]) {
    const inHole = (surface.remaining_ranges ?? []).some((window) => {
      const hole = parsePackLineRange(window);
      return hole === undefined || (line >= hole[0] && line <= hole[1]);
    });
    if (!inHole) return true;
  }
  return (surface.appended_windows ?? []).some((window) => {
    const bounds = parsePackLineRange(window.range);
    return bounds !== undefined && line >= bounds[0] && line <= bounds[1];
  });
}

/** True when `relPath` lies at or under the ancestor directory `dir` (both workspace-relative POSIX). An empty `dir` scopes to the whole workspace (no filtering). */
export function isUnderAncestor(relPath: string, dir: string): boolean {
  if (dir === "") return true;
  return relPath === dir || relPath.startsWith(dir + "/");
}

/**
 * True when `relPath` resolves to a DIRECTORY inside `workspace` (safe-path
 * contained). Used by the seeded flow to tell a caller-supplied directory
 * entry (readFileSafe returned null because fs.readFile threw EISDIR) apart
 * from a genuinely missing/out-of-workspace path — the former is a usable
 * confinement scope for a locate, the latter is a bare `missing` entry.
 * Synchronous (matches the surrounding fs style) and never throws.
 */
export function isDirectoryWithin(relPath: string, workspace: string): boolean {
  const abs = safeResolve(relPath, workspace);
  if (abs === undefined) return false;
  try {
    const real = fs.realpathSync(abs);
    if (!isWithin(real, resolveReal(workspace))) return false;
    return fs.statSync(real).isDirectory();
  } catch {
    return false;
  }
}

/**
 * WP-S8 (TL_NAMED_TARGET_RESOLUTION, 2026-09-20): at most this many
 * locate-recovered surfaces per caller-named DIRECTORY, and across every
 * caller-named directory in one pack. A directory is a "look here" scope, not
 * an earned file list, so its evidence is bounded independently of the
 * surface budget it also has to fit inside: three is the same per-scope width
 * `MAX_CLAUSE_LOCATES` already gives the answer path's own clause recovery,
 * and six is `MAX_SURFACES_DISTINCT` — a pack whose caller-named files
 * already fill the budget adds nothing here.
 */
export const MAX_NAMED_DIR_SURFACES = 3;

export const MAX_NAMED_DIR_SURFACES_TOTAL = MAX_SURFACES_DISTINCT;

/**
 * WP-S8: shared wall-clock ceiling across every caller-named directory in one
 * pack. `runClauseLocateRecovery` budgets each CALL independently
 * (CUMULATIVE_LOCATE_BUDGET_MS), so N directories would otherwise cost N
 * times that; this stops starting a further directory once the pack as a
 * whole has spent twice one call's budget, which keeps the worst case at the
 * same order as the answer path's own single recovery pass.
 */
export const NAMED_DIR_LOCATE_BUDGET_MS = 2 * CUMULATIVE_LOCATE_BUDGET_MS;

/** WP-S8: symbol-less candidates one directory-confined locate may re-point (see `namedDirClauseLocate`). Bounded because each re-point parses one file. */
export const MAX_NAMED_DIR_ANCHOR_REPOINTS = 3;

/**
 * WP-S8: ONE directory-confined locate for the per-clause recovery below,
 * with every symbol-less candidate re-pointed at its best query-matching
 * symbol.
 *
 * WHY THE RE-POINT: `pickCoveredClauseLocateCandidate` accepts a symbol-less
 * ABSTAIN candidate only under a much stricter self-coverage bar than a
 * symbol-bearing one (its doc comment explains why: an abstain's top rank is
 * lexical confidence, not relevance). A locate confined to a directory the
 * caller NAMED routinely abstains with exactly the right files and no symbol
 * -- measured on the recorded session, the three service classes came back
 * symbol-less and every one of them was rejected. The re-point is the SAME
 * one the required-role and directory fills above already apply
 * (`anchorFocusForLocatorCandidate`), minus its oversized-file gate: there the
 * symbol only decides which slice to embed, here it is what makes the
 * candidate addressable at all, and a class that answers exactly one clause of
 * the request is routinely well under that gate's size.
 * `selectAnchorFocus` abstains (nothing scores above zero overlap) rather than
 * guessing, which leaves the candidate exactly as the locator ranked it, and
 * the clause coverage check still has to pass afterwards.
 *
 * `queryText` is whatever `runClauseLocateRecovery` is locating with -- the
 * clause itself on the first attempt, and its neighbour-expanded or
 * TL_JA_QUERY_BRIDGE-recovered form on the retry, which is what gives a
 * Japanese clause English tokens to anchor against.
 */
export async function namedDirClauseLocate(
  queryText: string,
  limit: number,
  context: {
    dir: string;
    workspace: string;
    lang: TaskPackArgs["lang"];
    cache: FileReadCache;
    focusByCandidate: Map<ImpactCandidate, AnchorFocusResult>;
  },
): Promise<ClauseRecoveryLocateResult<ImpactCandidate>> {
  const { dir, workspace, lang, cache, focusByCandidate } = context;
  const result = await locateTaskContext(workspace, {
    action: "locate",
    query: queryText,
    path: dir,
    ...(lang ? { lang } : {}),
    limit,
  });
  const ranked: ImpactCandidate[] = result.hit ? [...result.primary] : [...(result.candidateDetails ?? [])];
  if (!result.hit && ranked.length > 1) {
    // WP-P2 A (2026-09-20): on an ABSTAIN the locator's order is lexical
    // confidence, not relevance -- the same fact the re-point above exists for
    // -- and every candidate inside one named directory routinely ties at the
    // top confidence. `pickCoveredClauseLocateCandidate` then takes the FIRST
    // one that clears its coverage bar, and that bar is met by a SINGLE shared
    // token of >= DIVERSIFY_MIN_LONG_TOKEN_CHARS: measured on the recorded
    // session, the clause "order service cancellation" was answered by the
    // first unrelated `*Service` class in the tie, purely on the word
    // "service", while the class the clause actually names sat third. Order the
    // tie by how much of the CLAUSE each candidate matches (its own path/symbol
    // tokens, the same scorer every coverage check in `concernRecovery.ts`
    // uses), keeping the locator's order as the stable tie-break. This also
    // spends the bounded re-point budget below on the closest candidates first.
    const clauseTokens = clauseCoverageTokenSet(queryText, tokenizeQueryForDiversification);
    const overlap = new Map<ImpactCandidate, number>(
      ranked.map((candidate) => [
        candidate,
        distinctMatchedTokenCount(clauseTokens, candidate, tokenizeQueryForDiversification),
      ]),
    );
    if (new Set(overlap.values()).size > 1) {
      const order = new Map(ranked.map((candidate, index) => [candidate, index]));
      ranked.sort((left, right) =>
        (overlap.get(right) ?? 0) - (overlap.get(left) ?? 0)
        || (order.get(left) ?? 0) - (order.get(right) ?? 0)
      );
    }
  }
  const anchored: ImpactCandidate[] = [];
  let repointed = 0;
  for (const candidate of ranked) {
    if (candidate.symbol !== undefined || repointed >= MAX_NAMED_DIR_ANCHOR_REPOINTS) {
      anchored.push(candidate);
      continue;
    }
    const content = cache.read(workspace, candidate.path);
    if (content === undefined) {
      anchored.push(candidate);
      continue;
    }
    repointed += 1;
    // eslint-disable-next-line no-await-in-loop -- at most MAX_NAMED_DIR_ANCHOR_REPOINTS per locate, and each parse is only worth starting once the previous candidate failed to be the answer.
    const focus = await selectAnchorFocus(content, candidate.path, queryText, cache);
    if (focus === undefined) {
      anchored.push(candidate);
      continue;
    }
    // WP-P2 C3 (2026-09-20) -- DEFECT. Keyed by the RE-POINTED CANDIDATE, not
    // by its path: this locate runs once per clause, and two clauses of the
    // same request routinely re-point the SAME file at different symbols
    // ("OrderService" at its constructor, "cancel" at the cancel method). A
    // path-keyed map kept only the last focus, so the pack served the window
    // one clause picked under the symbol NAME another clause picked -- a row
    // that said `cancel` and carried the constructor. Candidate identity is
    // preserved end to end (`runClauseLocateRecovery` passes picks through
    // untouched), so the focus that named a window always travels with it.
    const anchoredCandidate: ImpactCandidate = {
      ...candidate,
      symbol: focus.best.name,
      range: focus.best.range,
      line: anchorWindowStartLine(focus.best.range) ?? candidate.line,
    };
    focusByCandidate.set(anchoredCandidate, focus);
    anchored.push(anchoredCandidate);
  }
  return result.hit ? { hit: true, primary: anchored } : { hit: false, candidateDetails: anchored };
}

/**
 * WP-S8: the workspace's unique file whose basename is exactly the one
 * `namedPath` spells — case-sensitive, extension included. When several
 * exist, the unique one under the named path's OWN parent directory subtree
 * wins (`frontend/order.js` -> `frontend/js/order.js`, because the caller got
 * the folder wrong, not the file); anything still ambiguous stays
 * unresolved. Never a fuzzy/nearest-name match: a basename the caller did not
 * spell exactly is a different file, and serving it would be a guess.
 */
export function uniqueBasenameResolution(
  namedPath: string,
  byBasename: ReadonlyMap<string, readonly string[]>,
): string | undefined {
  const matches = byBasename.get(path.posix.basename(namedPath));
  if (matches === undefined || matches.length === 0) return undefined;
  if (matches.length === 1) return matches[0];
  const parent = path.posix.dirname(namedPath);
  if (parent === "" || parent === "." || parent === "/") return undefined;
  const underParent = matches.filter((relPath) => relPath.startsWith(parent + "/"));
  return underParent.length === 1 ? underParent[0] : undefined;
}

/**
 * WP-S8 (TL_NAMED_TARGET_RESOLUTION): re-point caller-named FILE paths that
 * do NOT exist at the workspace's unique same-basename file, in place, before
 * the seed read below — so a resolved target is then read, embedded, budgeted
 * and trimmed exactly as if the caller had spelled it. Recorded in
 * `resolvedFromByPath` (resolved path -> the path the caller wrote) so the
 * surface's `why` can disclose the inference and `missing` can still name
 * what the caller actually wrote if the resolution later fails to hold.
 *
 * Deliberately narrow, because every resolution is this server's own guess:
 *   - a path that EXISTS is never re-pointed (that includes a directory, and
 *     a file this server cannot read -- unreadable is not "not there");
 *   - a path outside the workspace is never re-pointed;
 *   - the inventory is `walkCodeFiles`, the SAME walk (and therefore the same
 *     ignore rules) the seeded builder's own directory locate uses, widened
 *     by exactly the extensions/basenames the unresolved paths spell, so an
 *     ignored file can never become a resolution target;
 *   - a resolution onto a path this pack ALREADY seeds is dropped rather than
 *     duplicated -- the caller who named both spellings still gets the honest
 *     `missing` entry for the one that does not exist.
 * Artifact extensions never reach here (`ARTIFACT_EXT_SET` is handled and
 * reported before `toRead` is built), so this resolves text/code targets only.
 */
export function resolveGuessedSeedPaths(
  toRead: TaskPackPathEntry[],
  workspace: string,
  seenPaths: Set<string>,
  resolvedFromByPath: Map<string, string>,
): void {
  const guessedIndexes: number[] = [];
  for (let index = 0; index < toRead.length; index += 1) {
    const relPath = toRead[index]!.path;
    const abs = safeResolve(relPath, workspace);
    if (abs === undefined) continue;
    try {
      if (fs.existsSync(abs)) continue;
    } catch {
      continue;
    }
    guessedIndexes.push(index);
  }
  if (guessedIndexes.length === 0) return;
  // Widen the walk by exactly what the unresolved paths spell. `extraExts`/
  // `extraBasenames` are additive extension/name matches, so this costs one
  // directory walk and reads no file content -- unlike the generic-text lane,
  // which has to decode every untracked file to classify it.
  const wantedExts = new Set<string>();
  const wantedBasenames = new Set<string>();
  for (const index of guessedIndexes) {
    const basename = path.posix.basename(toRead[index]!.path);
    const ext = path.posix.extname(basename).toLowerCase();
    if (ext.length > 0) wantedExts.add(ext);
    else wantedBasenames.add(basename);
  }
  const byBasename = new Map<string, string[]>();
  for (const file of walkCodeFiles(workspace, {
    ...(wantedExts.size > 0 ? { extraExts: [...wantedExts] } : {}),
    ...(wantedBasenames.size > 0 ? { extraBasenames: [...wantedBasenames] } : {}),
  })) {
    const basename = path.posix.basename(file.relPath);
    const bucket = byBasename.get(basename);
    if (bucket === undefined) byBasename.set(basename, [file.relPath]);
    else bucket.push(file.relPath);
  }
  for (const index of guessedIndexes) {
    const entry = toRead[index]!;
    const resolved = uniqueBasenameResolution(entry.path, byBasename);
    if (resolved === undefined) continue;
    if (seenPaths.has(resolved)) continue;
    seenPaths.add(resolved);
    resolvedFromByPath.set(resolved, entry.path);
    toRead[index] = { ...entry, path: resolved };
  }
}

/**
 * WP-S8: does the caller's own `range`/`symbol` still mean something on the
 * file this server resolved their path to? A range whose START is past the
 * end of the resolved file, or a symbol the resolved file does not define,
 * means the resolution does not hold -- report the named path as today
 * instead of serving a slice the caller never asked for. (An END past the
 * last line is NOT a failure: every other seeded path has its end clamped by
 * the slicer, and holding a resolution to a stricter contract than a spelled
 * path would be arbitrary.)
 */
export async function resolvedSeedHonorsSlice(entry: TaskPackPathEntry, content: string): Promise<boolean> {
  if (entry.range !== undefined) {
    // An unparseable range is not a claim this check can falsify -- the
    // slicer normalizes it for a spelled path too.
    const parsed = /^(\d+)-\d+$/.exec(entry.range);
    if (parsed !== null) {
      const start = parseInt(parsed[1]!, 10);
      if (!(start >= 1 && start <= countLines(content))) return false;
    }
  }
  if (entry.symbol !== undefined && entry.symbol.length > 0) {
    const symbols = await extractSymbolsFromFile(content, entry.path, 256, [entry.symbol]);
    if (!symbols.some((symbol) => identifierNamesSymbol(symbol.name, entry.symbol!))) return false;
  }
  return true;
}

/**
 * WP-S8: insert a qualifier into a seed's `why` BEFORE a trailing
 * "caller-supplied" token rather than appending after it -- exactly the
 * placement SHOULD-FIX 37's "nul-stripped" qualifier uses, and for the same
 * reason (`candidateToSurface` re-appends "; caller-supplied" whenever any
 * `;`-separated segment is exactly that token, so appending after it would
 * sandwich the qualifier between two provenance tokens).
 */
export function whyWithQualifier(why: string, qualifier: string): string {
  const segments = why.split("; ");
  if (segments[segments.length - 1] === "caller-supplied") {
    segments.splice(segments.length - 1, 0, qualifier);
    return segments.join("; ");
  }
  return appendWhySegmentOnce(why, qualifier);
}

/**
 * P2 (2026-09-27 evaluation §6.3): the ONE general join rule every site in
 * this module that appends a trailing `; `-separated marker to an existing
 * `why` must use, so a `why` string never repeats an identical segment --
 * confirmed live: `buildSeededTaskPack`'s default per-path stamp for a
 * plain caller-named seed is the BARE marker "caller-supplied" (correctly --
 * that IS the whole fact for that seed), and `candidateToSurface` used to
 * unconditionally re-append "; caller-supplied" whenever `surfaceWhyHasMarker`
 * found that token ANYWHERE in the candidate's `why`, producing the wire
 * shape `why:"caller-supplied; caller-supplied"` (model.ts's R1-B2 doc
 * comment records the same defect class for a different producer: an
 * executed-search-located seed wrongly defaulted to the plain
 * "caller-supplied" stamp). `surfaceWhyHasMarker` itself is the wrong
 * predicate for this -- it asks "is the marker ANYWHERE in the list", which
 * is right for gating (e.g. "is this candidate caller-scoped at all") but
 * would refuse to re-add a marker that legitimately appears earlier for an
 * unrelated reason; the join-time hygiene bug is specifically about the
 * LAST segment, the one this exact call is about to write again.
 */
export function appendWhySegmentOnce(why: string | undefined, marker: string): string {
  if (why === undefined || why === "") return marker;
  const segments = why.split("; ");
  return segments[segments.length - 1] === marker ? why : `${why}; ${marker}`;
}

/**
 * WP-S8: the clauses a caller-named DIRECTORY is located with. The target's
 * OWN `purpose` leads -- it is the caller saying what this directory is for --
 * and the task query's own clauses fill any remaining per-directory slot, so a
 * one-line purpose ("order / refund / inventory services") still reaches the
 * several distinct concerns the request spells. A purpose that
 * `extractRequestItems` does not split is kept whole rather than dropped.
 * Order is significant: `runClauseLocateRecovery` takes the first
 * MAX_CLAUSE_LOCATES clauses its coverage window leaves uncovered.
 */
/**
 * Clause-id prefixes for `namedDirClauseWorkList`. They are what tells the
 * per-clause coverage window (WP-P2 A, at the WP-S8 call site) a concern the
 * caller wrote ON this directory apart from one it wrote in the task query.
 */
export const NAMED_DIR_PURPOSE_CLAUSE_PREFIX = "dir-purpose-";

export const NAMED_DIR_QUERY_CLAUSE_PREFIX = "dir-query-";

export function namedDirClauseWorkList(purposeText: string, query: string): ClauseHygieneItem[] {
  const out: ClauseHygieneItem[] = [];
  const seen = new Set<string>();
  const add = (items: readonly ClauseHygieneItem[], prefix: string): void => {
    for (const item of items) {
      const key = item.text.trim().toLowerCase();
      if (key.length === 0 || seen.has(key)) continue;
      seen.add(key);
      out.push({ id: `${prefix}${item.id}`, text: item.text });
    }
  };
  if (purposeText.length > 0) {
    const purposeClauses = hygienicClauseWorkList(extractRequestItems(purposeText));
    add(
      purposeClauses.length > 0 ? purposeClauses : [{ id: "whole", text: purposeText }],
      NAMED_DIR_PURPOSE_CLAUSE_PREFIX,
    );
  }
  if (out.length < MAX_CLAUSE_LOCATES && query.trim().length > 0) {
    add(hygienicClauseWorkList(extractRequestItems(query)), NAMED_DIR_QUERY_CLAUSE_PREFIX);
  }
  return out;
}

// ---------------------------------------------------------------------------
// TL_EFF_LIGHT_ANSWER (2026-10-10, small-task cost; class (B), default OFF).
//
// An answer question about ONE small, self-contained file is built by the
// seeded builder a caller-supplied target takes, entered straight from
// buildTaskPackCore: nothing that DISCOVERS runs — the named-project inference,
// the routing shortcuts, and for a file the query names, the whole pathless
// answer path (source-index build and its git calls, symbol search, reference
// scan, the answer builder's augmentation passes). Measured 2026-10-10 on the
// built CLI, a 1,501-file synthetic TypeScript workspace: the query-named
// question took ~640 ms warm against ~165 ms for the same question with the
// file as a target. What certifies is unchanged: the seeded builder's facet
// plan and the shared tail (`dedupeTrimAndPersist`: profile binding, answer
// dependency closure, readiness contract, decision, persistence) run exactly
// as for a target, so this path cannot certify an answer the seeded pack
// would not — and `lightAnswerTarget` admits only questions the differential
// spec (smallTaskLightAnswerDifferential.spec.ts) shows the full pipeline
// answers from the same file.
// ---------------------------------------------------------------------------

/** The one file a light answer pack serves, and where its path came from. */
export interface LightAnswerTarget {
  readonly path: string;
  readonly origin: "query-named" | "caller-supplied";
}

/** `lightAnswerVerdict`'s answer: the target, or the first condition that failed. */
export type LightAnswerVerdict = { readonly target: LightAnswerTarget } | { readonly skip: string };

/** Facets a light pack may answer: what the file's own code computes or decides. */
export const LIGHT_ANSWER_FACETS: ReadonlySet<string> = new Set(["value", "condition"]);

/**
 * The light answer path's applicability test: `{target}` when EVERY condition
 * holds, else `{skip}` naming the first that failed (the full pipeline runs).
 * The request-shape checks run before the one file read, and nothing here
 * writes anything.
 *
 *  1. TL_EFF_LIGHT_ANSWER is on.
 *  2. An answer task: the binding selected `answer` — declared, or inferred
 *     from an interrogative with no defect-symptom marker (the §14 guardrail
 *     `bindTaskProfile` already applies) — and the query carries no mutation
 *     or defect-symptom wording either way.
 *  3. A fresh task: `task.epoch:"new"`, and no qref replay, task handle,
 *     inherited profile, forced serve, budget, symbol, language, limit,
 *     surface-role selector or credential.
 *  4. Exactly one file named: either one `targets[]` entry (no range, symbol
 *     or purpose) whose path every path token of the query repeats exactly, or
 *     no targets and exactly one path token in the query, directory-qualified
 *     (`src/math.ts`; a bare basename could name several files).
 *  5. The file is a regular file inside the workspace, not a test, in a light
 *     answer language, at most LIGHT_ANSWER_MAX_BYTES / LIGHT_ANSWER_MAX_LINES,
 *     decodes clean under the serve policy, and names no other module
 *     (features/task-pack/lightAnswer.ts).
 *  6. One concern about that file's own code: at most one request item (none
 *     coordinated), at most one facet and only a value/condition facet, not a
 *     locate/relate request, and every name the question asks about — a code
 *     identifier it spells, a name it frames as code ("the add function"), a
 *     facet's subject — is DECLARED in the file (its parsed symbols), so
 *     nothing the question names has to be looked for anywhere else.
 */
export async function lightAnswerVerdict(
  args: TaskPackArgs,
  query: string,
  workspace: string,
  binding: TaskProfileBinding,
): Promise<LightAnswerVerdict> {
  if (!effLightAnswerEnabled()) return { skip: "flag-off" };
  // 2. answer task
  if (binding.selected !== "answer") return { skip: "not-answer" };
  if (binding.source !== "explicit" && binding.source !== "inferred") return { skip: "profile-source" };
  if (query.trim().length === 0) return { skip: "empty-query" };
  if (hasRequestedMutationIntent(query)) return { skip: "mutation-wording" };
  if (hasDefectSymptomMarker(query)) return { skip: "defect-wording" };
  // 3. fresh task, plain request
  if (args.taskEpoch !== "new") return { skip: "not-new-epoch" };
  if (
    args.taskQueryRefReplay === true
    || args.taskBinding !== undefined
    || args.taskProfileInherited === true
    || args.forceServe === true
    || args.forceServeCallerTargetsOnly === true
    || args.namedScopeRequest !== undefined
    || args.autoDiscoveredLocation === true
    || (args.executedSearchLocated?.length ?? 0) > 0
    || (args.executedSearchLocatedUnclassified?.length ?? 0) > 0
    || args.lightAnswer !== undefined
  ) return { skip: "continuation" };
  if (
    args.symbol !== undefined
    || args.lang !== undefined
    || args.limit !== undefined
    || (args.surfaceRoles?.length ?? 0) > 0
    || args.maxBytes !== undefined
    || args.maxTokens !== undefined
    || args.credentialRef !== undefined
  ) return { skip: "request-option" };
  // 4. exactly one file named
  const tokens = queryNamedPathTokens(query);
  let relPath: string;
  let origin: LightAnswerTarget["origin"];
  if ((args.paths?.length ?? 0) > 0) {
    if (args.path !== undefined || args.paths!.length !== 1) return { skip: "target-count" };
    const entry = normalizePathEntry(args.paths![0]!);
    if (entry.range !== undefined || entry.symbol !== undefined || entry.purpose !== undefined) return { skip: "target-window" };
    relPath = entry.path.replace(/\\/g, "/").replace(/^\.\//, "");
    if (tokens.some((token) => token !== relPath)) return { skip: "query-names-another-path" };
    origin = "caller-supplied";
  } else {
    if (args.path !== undefined) return { skip: "legacy-path" };
    if (tokens.length !== 1) return { skip: "query-path-count" };
    if (!tokens[0]!.includes("/")) return { skip: "bare-basename" };
    relPath = tokens[0]!;
    origin = "query-named";
  }
  if (relPath.length === 0 || relPath.startsWith("/") || relPath.split("/").includes("..")) return { skip: "path-shape" };
  // 6 (request side, before the read).
  const items = extractRequestItems(query);
  if (items.length > 1 || items.some((item) => item.coordinated === true)) return { skip: "multi-item" };
  const facets = extractFacetRequirements(query);
  if (facets.length > 1) return { skip: "multi-facet" };
  if (facets.some((facet) => !LIGHT_ANSWER_FACETS.has(facet.facet))) return { skip: "relation-facet" };
  if (isStructuralOnlyRequest(query)) return { skip: "structural" };
  // A behaviour question ("when …", "how …") owes a `behavior-body` proof,
  // which the full pipeline's answer path discharges from the callable it
  // FOCUSES on; a whole-file surface proves it only through declaration-shape
  // text tests that miss some forms (a Go method's receiver, measured by the
  // differential spec). A target takes the same seeded builder either way, so
  // only a query-named file is held back.
  if (origin === "query-named" && BEHAVIOR_QUERY_RE.test(query)) return { skip: "behavior-question" };
  // 5. the file
  const language = lightAnswerLanguage(relPath);
  if (language === undefined) return { skip: "language" };
  if (isTestConcernPath(relPath)) return { skip: "test-file" };
  const abs = safeResolve(relPath, workspace);
  if (abs === undefined) return { skip: "outside-workspace" };
  let text: string;
  try {
    const real = fs.realpathSync(abs);
    if (!isWithin(real, resolveReal(workspace))) return { skip: "outside-workspace" };
    const stat = fs.statSync(real);
    if (!stat.isFile()) return { skip: "not-a-file" };
    if (stat.size > LIGHT_ANSWER_MAX_BYTES) return { skip: "over-bytes" };
    // served-bytes: readServedText (the serve policy's verdict; never served from here)
    const verdict = readServedText(readFileForRequest(real));
    if (verdict.kind !== "clean") return { skip: "not-clean-text" };
    text = verdict.text;
  } catch {
    return { skip: "unreadable" };
  }
  if (lightAnswerLineCount(text) > LIGHT_ANSWER_MAX_LINES) return { skip: "over-lines" };
  if (lightAnswerDependencyLine(text, language) !== undefined) return { skip: "dependency-line" };
  // 6 (file side): every name the question asks about is declared here.
  const subjects = new Set<string>([
    ...explicitCodeIdentifiers(query),
    ...framedCodeNamesIn(query),
    ...facets.flatMap((facet) => [...facet.subjectIdentifiers, ...(facet.subjectCallables ?? [])]),
  ]);
  if (subjects.size > 0) {
    let parsed: CollectedSymbol[] | undefined;
    try {
      parsed = await collectSymbols(text, language, {});
    } catch {
      parsed = undefined;
    }
    if (parsed === undefined || parsed.length === 0) return { skip: "no-parse" };
    const declared = new Set(parsed.map((symbol) => unqualifiedSymbolTail(symbol.name)));
    for (const name of subjects) if (!declared.has(name)) return { skip: `undeclared:${name}` };
  }
  for (const facet of facets) {
    if (
      facet.subjectIdentifiers.length === 0
      && (facet.subjectCallables?.length ?? 0) === 0
      && facet.subjectTerms.length > 0
      && !facet.subjectTerms.some((term) => lightAnswerHasWholeIdentifier(text, term, true))
    ) return { skip: "facet-subject-absent" };
  }
  // 7. A file the QUERY names (no target) goes down the pathless answer path in
  // the full pipeline, which locates the question's words across the whole
  // workspace: measured on the bench fixtures, a plain-word subject
  // ("capitalize", "port") drew in another project's `util/` and ended
  // `discover`, and a name re-exported by a barrel file added that file.
  // So the question must name what it asks about — a code identifier or a
  // framed name — and none of those names may occur in the CODE (comments and
  // strings masked) of any other workspace file. A caller-supplied target
  // takes the seeded builder in both arms and needs neither test.
  if (origin === "query-named") {
    if (subjects.size === 0) return { skip: "no-named-subject" };
    const elsewhere = lightAnswerSubjectElsewhere(workspace, relPath, [...subjects]);
    if (elsewhere !== undefined) return { skip: `named-elsewhere:${elsewhere}` };
  }
  return { target: { path: relPath, origin } };
}

/** Test seam: `lightAnswerVerdict` with the request's own profile binding (smallTaskLightAnswer.spec.ts). */
export function lightAnswerVerdictForTest(
  args: TaskPackArgs,
  query: string,
  workspace: string,
): Promise<LightAnswerVerdict> {
  return lightAnswerVerdict(args, query, workspace, bindTaskProfile(args.taskProfile, query, args.writeAllowed));
}
