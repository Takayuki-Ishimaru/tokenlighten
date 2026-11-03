// queryIntent — extracted implementation; imports point to the owning modules.
import * as path from "path";
import { AsyncLocalStorage } from "node:async_hooks";
import { MAX_QUERY_NAMED_FILES } from "./queryIntent2.js";
import { QUERY_NAMED_EXTRA_EXTS } from "./queryIntent2.js";
import { TEXT_SCAN_MAX_FILE_SIZE_BYTES } from "../../../tools/walkRepo.js";
import { isWithinRoleSearchScope } from "../../locator/locateTaskContext.js";
import { queryNamedFilesWalkStorage } from "./queryIntent2.js";
import { readServedText } from "../../../util/textDecode.js";
import { roleSearchScopePrefixes } from "../../locator/locateTaskContext.js";
import { walkCodeFiles } from "../../../tools/walkRepo.js";

/**
 * B1c (2026-08-01 retrieval-scope): FILES the query literally names.
 *
 * A caller who writes `control/mixer.cpp` (or just `mixer.hpp`, or
 * `CONTRACT.md`) has already done the locating — that file is not a candidate
 * to be ranked, it is a stated requirement. Live forensics (run
 * 2026-07-31-semantic-signal5-2, T05c rep0): follow-up packs whose query named
 * exactly those three files came back as candidate LISTS containing none of
 * them, so the caller re-asked for files it had already named twice.
 *
 * Resolution is by workspace inventory, never by guess: a token must equal a
 * walked file's relative path or be its path SUFFIX (so a bare basename works),
 * and the extension must be alphabetic-leading so version strings ("v0.9") and
 * numeric fragments never look like filenames.
 *
 * TL142-05 (2026-09-13, v0.14.2 hands-on report): originally landed here as
 * an unconditional `fullRecall: true` on the walk below. Root cause,
 * confirmed directly (not inferred): a query naming
 * `src/generated/schemaStamp.ts` verbatim, by its own full path and
 * extension — the strongest possible "this is a stated requirement" signal —
 * still failed to resolve, because the DEFAULT walk drops any path under a
 * `/generated/` segment as build noise (`BUILD_DIR_EXCLUDED_SEGMENTS` in
 * walkRepo.ts), the same class of exclusion `findReferences`/`renameSymbol`
 * already opt out of via `fullRecall` for the identical reason ("legitimately
 * -named source... not silently dropped" — that option's own doc comment).
 *
 * BLOCKER 3 (2026-09-13, review round): unconditional `fullRecall` was too
 * broad — it re-includes EVERY class the fullRecall re-inclusion covers
 * (`dist/`, `build/`, `out/`, `*.min.*`, `*.generated.*`, `*.map`, `*.pb.*`),
 * not only the `/generated/` segment TL142-05 needed. Live regression: a
 * workspace with both `src/cache.ts` (source) and `dist/cache.ts` (its own
 * compiled copy) resolved the bare-basename token "cache.ts" to
 * `dist/cache.ts` — first alphabetically among the fullRecall walk's suffix
 * matches — making a BUILD ARTIFACT the stated requirement and demoting the
 * real source to supporting evidence. Fix: resolve against the DEFAULT
 * (non-fullRecall) walk FIRST; consult the fullRecall walk only when the
 * token is unresolved there, and only for a token that ITSELF names a
 * directory (a path separator, e.g. "src/generated/schemaStamp.ts" — the
 * same signal that made this file's resolution correct in the first place).
 * A bare basename ("cache.ts") therefore never falls through to the
 * fullRecall walk at all, so it can never resolve to build output — and
 * because the default walk is always consulted first and used immediately
 * when it resolves, a source file the default walk finds always wins over a
 * compiled copy the fullRecall walk would otherwise have offered. Never a
 * broader recall than the ONE token this function was already given to
 * resolve.
 */
export function queryNamedWorkspaceFiles(
  query: string,
  workspace: string,
  anchorPaths: readonly string[] = [],
): string[] {
  if (query.trim().length === 0) return [];
  const tokens = queryNamedPathTokens(query);
  // README is also a conventional document name without its extension. Only
  // resolve a unique root document actually present in the ordinary inventory;
  // never guess a nested project's README or choose among several root copies.
  const prose = query.replace(/https?:\/\/\S+/g, "");
  if (/(?<![A-Za-z0-9_/.-])README(?![A-Za-z0-9_/-]|\.[A-Za-z0-9])/i.test(prose)) {
    const readmes = walkedFilesForQueryNamedResolution(workspace, false)
      .filter(file => /^readme\.(?:md|markdown|txt)$/i.test(file));
    if (readmes.length === 1 && !tokens.includes(readmes[0]!)) tokens.push(readmes[0]!);
  }
  if (tokens.length === 0) return [];
  // R0 (2026-08-21, W4-A): a bare basename token (no directory component,
  // e.g. "server.ts") can suffix-match MULTIPLE workspace files when the
  // same name exists under more than one project root (routinely true for a
  // `bench/fixtures/` tree hosting several independent synthetic projects).
  // Without a root preference, resolution silently took whichever candidate
  // the walk's alphabetical sort put first — an arbitrary, workspace-layout-
  // dependent pick with no relation to the task at hand. When the caller
  // supplies anchor paths (its own already-trusted surfaces), prefer a
  // suffix match that IS one of them outright (BLOCKER 3: stronger than mere
  // root membership — the caller's own already-served surface, never just
  // alphabetical order), else one inside THEIR root; falls back to the prior
  // first-match behavior when no anchors are supplied or none of the
  // candidates is in-root, so recall is never reduced versus before either
  // fix.
  const scopePrefixes = roleSearchScopePrefixes(anchorPaths);
  const resolved: string[] = [];
  for (const token of tokens) {
    let match = resolveQueryNamedToken(
      token, walkedFilesForQueryNamedResolution(workspace, false), anchorPaths, scopePrefixes,
    );
    // BLOCKER 3: only a token that names a directory of its own (a path
    // separator) may consult the wider, build-output-inclusive walk, and
    // only once the default walk has already failed to resolve it.
    if (match === undefined && token.includes("/")) {
      match = resolveQueryNamedToken(
        token, walkedFilesForQueryNamedResolution(workspace, true), anchorPaths, scopePrefixes,
      );
    }
    // 2026-11 (external A/B of v0.16.4, TokenLighten's own repository): a bare
    // basename whose only default-walk match sits under an auxiliary tree
    // (`isAuxiliaryTreePath`) may name a PRODUCT file the default walk's size
    // cap excluded — TL's own `packages/mcp-server/src/server.ts` is 1.5 MB,
    // so "server.ts" resolved to `bench/fixtures/trackerly/…/server.ts` and
    // the pack certified an answer about a synthetic project. Consult the
    // oversize-inclusive walk once, and take its match only when it is a
    // product-tree file; a workspace whose every copy is auxiliary keeps the
    // default pick, so recall is never reduced.
    if (match !== undefined && !token.includes("/") && isAuxiliaryTreePath(match)) {
      const oversize = resolveQueryNamedToken(
        token, walkedFilesForQueryNamedResolution(workspace, false, true), anchorPaths, scopePrefixes,
      );
      if (oversize !== undefined && !isAuxiliaryTreePath(oversize)) match = oversize;
    }
    if (match !== undefined && !resolved.includes(match)) resolved.push(match);
    if (resolved.length >= MAX_QUERY_NAMED_FILES) break;
  }
  return resolved;
}

/** The path-shaped tokens of `query` (`src/http.ts`, `http.ts`), deduplicated, `./` dropped. */
export function queryNamedPathTokens(query: string): string[] {
  return [...new Set(
    (query.match(/[A-Za-z0-9_$][A-Za-z0-9_$.\-/]*\.[A-Za-z][A-Za-z0-9]{0,5}\b/g) ?? [])
      .map((token) => token.replace(/^\.\//, "")),
  )];
}

/**
 * Every workspace file one path token of `query` can mean: the file AT that
 * path when there is one (`src/http.ts`, or a root-level `http.ts` for the
 * bare basename — `resolveQueryNamedToken`'s own first rule), else every file
 * the token is a path suffix of — narrowed to the one match whose own
 * directory the question also names ("…in fixtures/aeroctl/firmware/src and
 * … CONTRACT.md" means `fixtures/aeroctl/CONTRACT.md`, not the four sibling
 * families' contracts). Several entries mean the question does not say which
 * file it is about.
 */
export function filesNamedByPathToken(token: string, walked: readonly string[], query: string): string[] {
  const exact = walked.find((rel) => rel === token);
  if (exact !== undefined) return [exact];
  const matches = walked.filter((rel) => rel.endsWith(`/${token}`));
  if (matches.length < 2) return matches;
  const dirsOf = (rel: string): string[] => rel.slice(0, rel.length - token.length).split("/").filter(Boolean).map((segment) => segment.toLowerCase());
  const shared = new Set(dirsOf(matches[0]!).filter((segment) => matches.every((rel) => dirsOf(rel).includes(segment))));
  const words = new Set(query.toLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter((word) => word.length >= 3));
  const mentioned = matches.filter((rel) => dirsOf(rel).some((segment) => !shared.has(segment) && words.has(segment)));
  return mentioned.length === 1 ? mentioned : matches;
}

export interface NamedCallableDefinitions {
  /** The explicit identifier the located file defines. */
  readonly identifier: string;
  /** The located file first, then every other implementation file defining it. */
  readonly paths: readonly string[];
  /** Every implementation file spelling the name was checked. */
  readonly complete: boolean;
}

/**
 * The files `query`'s path tokens name, keeping EVERY file a shared bare
 * basename can mean (`settings.ts` → `a/settings.ts` and `b/settings.ts`)
 * rather than `queryNamedWorkspaceFiles`' single alphabetical pick. Used where
 * a name decides which same-name declaration a question means: a basename
 * two roots share decides nothing.
 */
export function queryNamedWorkspaceFilesKeepingSharedBasenames(query: string, workspace: string): string[] {
  const walked = walkedFilesForQueryNamedResolution(workspace, false);
  const named: string[] = [];
  for (const token of queryNamedPathTokens(query)) {
    const files = token.includes("/") ? queryNamedWorkspaceFiles(token, workspace) : filesNamedByPathToken(token, walked, query);
    for (const file of files.slice(0, MAX_QUERY_NAMED_FILES)) if (!named.includes(file)) named.push(file);
  }
  return named;
}

/**
 * BLOCKER 3: single-token resolution against ONE already-walked file list —
 * shared by the default-walk pass and the fullRecall fallback above so both
 * apply the IDENTICAL anchor-preference order: an exact anchor-path match
 * wins outright, then a same-root suffix match (R0's pre-existing
 * behaviour), then the first alphabetical suffix match. Never mixes
 * candidates across the two walks — the caller decides which list to pass,
 * and a match found in the default list is returned before the fullRecall
 * list is ever computed, so a source file always wins over a compiled copy.
 */
export function resolveQueryNamedToken(
  token: string,
  walked: readonly string[],
  anchorPaths: readonly string[],
  scopePrefixes: readonly string[] | null,
): string | undefined {
  const exact = walked.find((rel) => rel === token);
  if (exact !== undefined) return exact;
  const suffixMatches = walked.filter((rel) => rel.endsWith(`/${token}`));
  if (suffixMatches.length === 0) return undefined;
  // 2026-11 (external A/B of v0.16.4, TokenLighten's own repository): with no
  // anchor to prefer, a bare basename ("server.ts") used to resolve to the
  // walk's FIRST suffix match — `bench/fixtures/trackerly/apps/api/src/
  // server.ts`, a vendored synthetic project, ahead of the product's own
  // `packages/mcp-server/src/server.ts` — and the pack certified an answer
  // about the wrong project's file. A product-tree match outranks one under
  // an auxiliary tree (bench, fixtures, tests, examples, vendored copies);
  // the alphabetical first match remains the fallback when every candidate
  // is auxiliary, so recall is never reduced.
  return suffixMatches.find((rel) => anchorPaths.includes(rel))
    ?? suffixMatches.find((rel) => isWithinRoleSearchScope(rel, scopePrefixes) && !isAuxiliaryTreePath(rel))
    ?? suffixMatches.find((rel) => isWithinRoleSearchScope(rel, scopePrefixes))
    ?? suffixMatches.find((rel) => !isAuxiliaryTreePath(rel))
    ?? suffixMatches[0];
}

/**
 * A path under a tree that hosts benchmarks, fixtures, tests, examples or
 * vendored copies rather than the product's own source (see
 * `resolveQueryNamedToken`). Segment-exact, never a substring of a real name.
 */
export function isAuxiliaryTreePath(relPath: string): boolean {
  return /(?:^|\/)(?:bench|benchmarks?|fixtures?|__fixtures__|__tests__|__mocks__|tests?|spec|specs|examples?|samples?|demos?|vendor|vendored|third[-_]party|node_modules|dist|build|out|\.github)(?:\/|$)/i.test(relPath);
}

/**
 * BLOCKER 25 (2026-09-14, review round 4): the query-named files THIS CALL
 * resolved but could not READ, keyed by workspace-relative path.
 *
 * Recorded by `augmentQueryNamedFileSurfaces`' own `content === undefined`
 * branch — the one place in the build that holds the fact — and consumed at
 * `dedupeTrimAndPersist`, the choke point EVERY builder funnels through. The
 * indirection is what makes the disclosure survive the answer pack giving up:
 * `buildAnswerTaskPack` can return `undefined` (an empty surface set after the
 * focus gate drops a markup/CSS sole survivor), and the fallback builder that
 * then produces the shipped pack never calls `augmentQueryNamedFileSurfaces`
 * again — so a value returned from that function, or stashed on its `surfaces`
 * array, would be thrown away exactly in the case the finding is about.
 *
 * ALS, not a module-level Map, for the same reason the walk cache above is one:
 * scoped to ONE `buildTaskPack` call (see the `.run()` in `buildTaskPack`), so
 * a file a later call can read is never reported unreadable on its account, and
 * two interleaved calls cannot see each other's rows.
 */
/**
 * SHOULD-FIX 65 (AC1, 2026-09-14, review round 12): the value carries the
 * PROVENANCE alongside the cause.
 *
 * Round 11 measured a 5-file workspace where a query naming ONE file produced
 * THREE `unreadable-named-path` rows, each saying "this request names <file>" —
 * two of them about files the request never mentions. AB1 correctly made the
 * disclosure a property of the VERDICT (`candidateToSurface` notes ANY candidate
 * path the serve policy will not read), but reused the message written when the
 * only callers were query-named paths. `await_input` means "`unresolved[]` names
 * the blocker", so a caller acting on that asks the user to re-save two files it
 * never mentioned. Direction is over-disclosure, so this is honesty, not safety —
 * and the fix is to say WHICH it is, not to stop disclosing.
 */
export type UnreadableNamedPathProvenance = "request" | "resolution";

export interface UnreadableNamedPathRow {
  readonly reason: "unreadable" | "undecodable";
  readonly provenance: UnreadableNamedPathProvenance;
}

export const unreadableNamedPathStorage = new AsyncLocalStorage<Map<string, UnreadableNamedPathRow> | undefined>();

/*
 * AA1 (2026-09-14, review round 10): `readNamedFileTextLenient` lived here from
 * SHOULD-FIX 32 (round 4/5) through round 9. Its whole job was to ask a SECOND,
 * more permissive reader whether bytes the STRICT `readCached` had refused could
 * be served anyway — because the slice route (`buildSmallFile`) used a
 * different, more permissive rule and the two doors disagreed about the same
 * file. That disagreement is what findings 32/35/37/40/49/50/51 kept re-
 * discovering at one door after another.
 *
 * It is deleted, not adjusted: `FileReadCache.read` now applies the ONE
 * `readServedText` policy (util/textDecode.ts) that `buildSmallFile`, the
 * seeded-targets loop, the direct slice route and `probeFileText` also apply, so
 * a second opinion is definitionally unobtainable — asking again can only return
 * the same verdict. `augmentQueryNamedFileSurfaces` below therefore trusts
 * `readCached` outright and asks `cache.verdictFor(rel)` only for the one thing
 * the text alone cannot tell it: whether a NUL was STRIPPED, which it must state
 * in `why`.
 */

/**
 * BLOCKER 25: WHY `readCached` could not serve this file — the two causes are
 * different facts for the caller ("fix the permissions" vs "this is not text"),
 * and the response says which.
 *
 * Only ever called on the failure path (at most once per named path per call),
 * so the extra `readFileSync` costs nothing on a normal pack. Fails toward
 * `"unreadable"`: if the re-read throws we know only that the read failed.
 *
 * AA1 (2026-09-14, review round 10): both branches are live and mean exactly
 * what they say, because ONE policy decides. `noteUnreadableNamedPath` is now
 * called from three places -- this augmentation (a path `readCached` refused),
 * the seeded-targets loop (an `"undecodable"` verdict) and nothing else -- and
 * all three refusals come from `readServedText`. So: `"unreadable"` = the READ
 * failed (ENOENT/permissions/a directory); `"undecodable"` = the read succeeded
 * but the bytes are not text in this encoding (invalid UTF-8, a BOM-less UTF-16
 * save, or NULs too dense to be incidental). The history this comment used to
 * record -- SHOULD-FIX 32's lenient second reader and SHOULD-FIX 35's re-
 * reachability argument -- is obsolete: that second reader is gone.
 */
export function classifyUnreadableNamedPath(workspace: string, relPath: string): "unreadable" | "undecodable" {
  // AA1 (2026-09-14, review round 10): re-derive through the SAME
  // `readServedText` policy the serve doors are gated on, never a
  // differently-spelled second predicate. Round 9's finding 50 measured the
  // consequence of the old `decodeTextBuffer` re-derivation: for a file whose
  // NULs begin past `UNDECODABLE_PROBE_BYTES`, the strict-ish decoder SUCCEEDED
  // here while the serve door refused the bytes, so the wire said
  // `"unreadable"` — "this server could not read the file" — about a file it
  // had read and certified one call earlier. With one policy the two can no
  // longer disagree: `"unreadable"` now means only that the READ ITSELF failed
  // (ENOENT/permissions/a directory), and every "these bytes are not text in
  // this encoding" case reports `"undecodable"`.
  // served-bytes: readServedText
  const verdict = readServedText(path.join(workspace, relPath));
  if (verdict.kind !== "undecodable") return "unreadable";
  return verdict.reason === "unreadable" ? "unreadable" : "undecodable";
}

/**
 * BLOCKER 25: record one file this call resolved but could not read.
 *
 * SHOULD-FIX 65 (AC1, round 12): `provenance` says whether the REQUEST named this
 * path (`"request"` — the query's own text, or a caller-supplied target) or the
 * server reached it while RESOLVING the request (`"resolution"` — a locator
 * candidate). `"request"` UPGRADES an existing `"resolution"` note for the same
 * path: the same file can be reached both ways within one call, and the stronger
 * statement is the true one.
 */
export function noteUnreadableNamedPath(
  workspace: string,
  relPath: string,
  provenance: UnreadableNamedPathProvenance,
): void {
  const store = unreadableNamedPathStorage.getStore();
  if (store === undefined) return;
  const existing = store.get(relPath);
  if (existing !== undefined) {
    if (existing.provenance === "request" || provenance === "resolution") return;
    store.set(relPath, { reason: existing.reason, provenance });
    return;
  }
  store.set(relPath, { reason: classifyUnreadableNamedPath(workspace, relPath), provenance });
}

export function walkedFilesForQueryNamedResolution(workspace: string, fullRecall: boolean, includeOversize = false): string[] {
  const store = queryNamedFilesWalkStorage.getStore();
  const key = `${workspace}|${fullRecall ? "fullRecall" : "default"}${includeOversize ? "|oversize" : ""}`;
  const cached = store?.get(key);
  if (cached !== undefined) return cached;
  // 2026-11: `includeOversize` lifts the walk's 1 MB default ceiling to the
  // text-scan ceiling for the ONE resolution that asked for it (see
  // `queryNamedWorkspaceFiles`): a file the question names by basename is a
  // stated requirement even when it is large, and the default walk's cap hid
  // TokenLighten's own 1.5 MB `server.ts` behind a bench fixture's copy.
  const walked = walkCodeFiles(workspace, {
    extraExts: QUERY_NAMED_EXTRA_EXTS, fullRecall,
    ...(includeOversize ? { sizeCapBytes: TEXT_SCAN_MAX_FILE_SIZE_BYTES } : {}),
  })
    .map((file) => file.relPath).sort();
  store?.set(key, walked);
  return walked;
}
