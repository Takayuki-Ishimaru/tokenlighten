// roleAndConcernScope — extracted implementation; imports point to the owning modules.
import { basename } from "node:path";
import { concreteIdentifierTokens } from "./createAndWiringEndpoints2.js";
import { escapeRegExp } from "../../search/find/findText.js";
import { hasRequestedMutationIntent } from "./coverageAndContinuation3.js";
import { isEnumLikeQuery } from "../../../util/queryShape.js";
import { stripPathSpans } from "../../../util/queryShape.js";
import { tokenizeForEpoch } from "../../../state/session.js";
import { tokenizeQuery } from "../../../util/queryShape.js";

/**
 * The enum/variant-shape keyword set the pack's role-derivation keys on
 * (mirrors queryShape.ts's isEnumLikeQuery vocabulary AND the locator's
 * MULTI_SURFACE_KEYWORDS). Kept as a token SET here so a camelCase-only query
 * ("TicketPriority byTicket") matches after tokenizeForEpoch splits the hump.
 */
export const ENUM_SHAPE_TOKENS: ReadonlySet<string> = new Set(["enum", "priority", "role"]);

/**
 * Item 5 (pack-side camelCase-robust enum gate): a strict SUPERSET of the
 * imported `isEnumLikeQuery` that also fires on camelCase/snake/kebab identifier
 * forms. The imported classifier uses bare English word-boundary regexes
 * plus a guarded `status` case, and a word boundary does NOT fall
 * inside a camelCase hump — so "TicketPriority byTicket" (the live TP4
 * regression) matched nothing and the whole enum role/check derivation was
 * skipped. Tokenizing via `tokenizeForEpoch` (the SAME normalization the
 * locator's looksLikeMultiSurface now uses — camelCase/snake/kebab split +
 * lowercase) and matching the keyword SET makes the gate fire on those forms
 * while staying a strict superset: it can only ADD enum recognition (the
 * `isEnumLikeQuery` OR-arm preserves every case that already matched), never
 * remove one, so no role-derivation semantics change for queries that were
 * already recognized. Language-agnostic: Japanese task prose with English
 * identifiers still tokenizes the identifier and matches.
 */
export function isEnumLikeQueryShaped(query: string): boolean {
  if (isEnumLikeQuery(query)) return true;
  for (const t of tokenizeForEpoch(query)) {
    if (ENUM_SHAPE_TOKENS.has(t)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// A4: route honesty. `missingRequired` alone is a bad proxy for "reading is
// done" — for bug-fix queries it is usually empty even when the pack covers
// only one of several bug sites. The self-contradiction (coverage:partial +
// "0 more calls needed") is exactly the escape license this design closes.
// A separate, INDEPENDENT signal — unmatched query concern tokens — decides
// whether the returned surfaces actually address what the query asked for.
// ---------------------------------------------------------------------------

/**
 * Tiny generic stopword set for concern-token extraction. Deliberately NOT
 * the full STOP_WORDS list from locateTaskContext.ts (which also drops
 * domain/code vocabulary like "function"/"error"/"array") — a concern token
 * IS allowed to be code vocabulary; only filler words are dropped here. Not
 * merged with findText.ts's FIND_STOP_WORDS (see that set's own comment) —
 * the two lists already disagreed on some filler words before this
 * consolidation, and the consolidation is the shared pipeline
 * (util/queryShape.ts's tokenizeQuery), not the word lists.
 */
export const CONCERN_STOP_WORDS = new Set([
  "the", "and", "for", "with", "this", "that", "from", "into", "when",
  "where", "which", "should", "have", "been", "will", "your", "about",
]);

export const CONCERN_NOISE_WORDS = new Set([
  ...CONCERN_STOP_WORDS,
  "add", "adds", "added", "adding", "bug", "bugs", "fix", "fixes", "fixed", "fixing",
  "wrong", "broken", "normal", "abnormal", "incorrect", "invalid", "reported", "report",
  "symptom", "symptoms", "complete", "completion", "criteria", "root", "cause", "causes",
  "identify", "identified", "update", "updated", "connect", "connected", "connection",
  "reflect", "reflected", "reuse", "reused", "existing", "using", "path", "paths",
  "file", "files", "side", "task", "tasks", "code", "works", "work", "working",
  "wire", "wired", "wiring",
  "all", "each", "every", "separate", "independent", "one", "two", "three",
  "first", "second", "third", "fourth", "fifth",
]);

export const META_CONCERN_EVIDENCE_TOKENS = new Set([
  "auto", "json", "query", "semantic", "generic", "helper", "regression", "implementation",
  "candidate", "ranking", "routing", "skeleton", "prefix", "range", "slice", "slicing", "symbol",
  "test", "tests", "mode", "large", "file", "files", "exact", "current",
]);

export const WEAK_CONCERN_TOKENS = new Set([
  "controller", "manager", "service", "handler", "status", "system", "mode", "state",
  "input", "output", "task", "health",
]);

export interface ConcernGroup {
  query: string;
  tokens: string[];
}

/**
 * Extract "significant query tokens": split on non-word characters,
 * lowercase, keep tokens of length >= 4, drop CONCERN_STOP_WORDS. These are
 * the tokens a returned pack is expected to visibly address — not every
 * query word (short/filler words carry no locate-able concern), but enough
 * to catch a query like "fix the failsafe windup mode transition" naming
 * several distinct bug sites. Thin wrapper over the shared pipeline in
 * util/queryShape.ts ("simple" mode — no camelCase splitting, no
 * distinctiveness sort, unlike findText.ts's "identifier" mode) with this
 * file's own minLen/stop-word list.
 *
 * W9: `query` is scrubbed of generic path spans FIRST (stripPathSpans("",
 * query)) — a path segment mentioned in prose is not a locate-able concern
 * word (see the module comment above concernHarvestText).
 */
export function significantQueryTokens(query: string): string[] {
  return tokenizeQuery(stripPathSpans("", query), { minLen: 4, stopWords: CONCERN_STOP_WORDS, mode: "simple" });
}

/**
 * A3: the tokens a csv cell may match. One letter shorter than the task pack's
 * concern tokens, because a table's own codes and names are often that short.
 */
export function artifactQueryTokens(query: string): string[] {
  return tokenizeQuery(stripPathSpans("", query), { minLen: 3, stopWords: CONCERN_STOP_WORDS, mode: "simple" });
}

// R0 (2026-08-21, W4-A): dedupe case-insensitively but PRESERVE the
// first-seen original casing on output — matching moduleShapedQueryTokens'
// established idiom (key = lowercase, pushed value = original). Before this
// fix, every token was silently lowercased on the way out, so a camelCase
// identifier concernAnchorTokens's own concreteIdentifierTokens had
// carefully case-preserved (e.g. "buildInitializeInstructions") lost its
// casing here, then failed identifierShapedConcernSet's case-sensitive
// `shaped.has(t)` filter (shaped stores lowercase) while a separately-
// produced ALL-LOWERCASE duplicate of the SAME token (from
// significantQueryTokens' "simple" tokenizer, which lowercases at the
// source) survived that filter — reporting a served, already-anchored
// symbol as an "uncovered concern" purely because of a casing mismatch
// between two representations of the identical token.
export function orderedUniqueTokens(tokens: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const token of tokens) {
    const key = token.toLowerCase();
    if (key.length === 0 || seen.has(key)) continue;
    seen.add(key);
    out.push(token);
  }
  return out;
}

export function markedConcernClauses(query: string, marker: RegExp): string[] {
  const matches = [...query.matchAll(marker)];
  return matches
    .map((match, index) => {
      const start = (match.index ?? 0) + match[0].length;
      const end = matches[index + 1]?.index ?? query.length;
      // A blank paragraph after the final list item is task-level completion
      // guidance, not part of that last concern.
      return query.slice(start, end).split(/\n\s*\n/, 1)[0]!.trim();
    })
    .filter((part) => part.length >= 12)
    .slice(0, 4);
}

export function splitConcernClauses(query: string): string[] {
  const normalized = query.replace(/\r/g, "\n");
  // Explicit lists are authoritative concern boundaries. Extract only the
  // marked entries: the former newline splitter also promoted the preamble and
  // completion criteria into synthetic concerns (a live three-symptom report
  // became four locates).
  const circled = markedConcernClauses(normalized, /(?:^|[\s:;；])\s*[①②③④⑤⑥⑦⑧⑨⑩]\s*/g);
  if (circled.length >= 2) return circled;
  // Inline incident reports commonly use "bugs: (1) ... (2) ... (3) ...".
  // Treat two or more parenthesized numeric markers as authoritative list
  // boundaries just like newline lists; ordinary one-off parentheticals do
  // not bind because markedConcernClauses must return at least two entries.
  const parenthesized = markedConcernClauses(normalized, /(?:^|[\s:;；])\(\d{1,2}\)\s*/g);
  if (parenthesized.length >= 2) return parenthesized;
  const listed = markedConcernClauses(normalized, /(?:^|\n)\s*(?:[-*]|\d+[.)])\s+/g);
  if (listed.length >= 2) return listed;

  const sentenceParts = normalized
    .split(/[。;；\n]+/)
    .map((part) => part.trim())
    .filter((part) => part.length >= 12);
  const commaParts = sentenceParts.length === 1
    ? sentenceParts[0]!
      .split(/[,、]/)
      .flatMap((part) => part.split(/\s+and\s+/i))
      .map((part) => part.trim())
      .filter((part) => part.length >= 12)
    : sentenceParts;
  // Retrieval and coverage still need the semantic clauses even when the
  // overall edit verb appears only in the preamble (for example "bugs: parser,
  // encoder, scheduler"). Whether those clauses are safe to bind as the stricter
  // multi_concern profile is decided separately by classifyTaskProfile.
  return commaParts.length >= 2 ? commaParts.slice(0, 4) : [];
}

export function hasExplicitConcernList(query: string): boolean {
  const normalized = query.replace(/\r/g, "\n");
  return markedConcernClauses(normalized, /(?:^|[\s:;；])\s*[①②③④⑤⑥⑦⑧⑨⑩]\s*/g).length >= 2
    || markedConcernClauses(normalized, /(?:^|[\s:;；])\(\d{1,2}\)\s*/g).length >= 2
    || markedConcernClauses(normalized, /(?:^|\n)\s*(?:[-*]|\d+[.)])\s+/g).length >= 2;
}

export function hasExplicitIndependentConcernMarker(query: string): boolean {
  return /\b(?:independent|unrelated|separate|distinct)\b[^.!?\n]{0,40}\b(?:bugs?|defects?|issues?)\b/i.test(query)
    || /(?:関連しない|独立した|別々の|別の)(?:[^。\n]{0,16})?(?:バグ|不具合|問題)/.test(query)
    || /(?:バグ|不具合|問題)(?:[^。\n]{0,16})?(?:独立|別々|無関係)/.test(query);
}

export function hasIndependentEditConcernClauses(query: string): boolean {
  const clauses = splitConcernClauses(query);
  return clauses.filter((part) =>
    hasRequestedMutationIntent(part) && concreteIdentifierTokens(part).length > 0
  ).length >= 2;
}

// ---------------------------------------------------------------------------
// concernHarvestText / filterConcernQueryEntries — workspace-identity
// scrubbing for concern-token harvest sources (W9, 2026-08-22 root-leak
// forensics).
//
// concernAnchorTokens tokenizes whatever free text it is handed with no
// awareness of the workspace's own path — by design, since it also has to
// work on arbitrary bug-report prose. That is exactly the hazard: a
// workspace root whose folder name reads as ordinary words when
// hyphen/underscore/dot-split (e.g. "m365-drive-mount") turns into concern
// tokens ("m365", "drive", "mount") the moment that name is mentioned
// anywhere in the harvested text — including a bare `path` fallback (see
// buildTaskPackCore), which IS a path under the workspace root and therefore
// names the root outright. Those tokens then collide with unrelated
// identifiers later (buildConcernNote / buildSmallFileConcernNote in
// readCodeModes.ts) and fire a spurious "session-query tokens ... hit
// outside served range" note on a file that has nothing to do with the
// query.
//
// Filtering the derived TOKENS after the fact cannot be precise: a plain
// word like "mount" is a legitimate concern token in a mounting-related bug
// report, so any rule keyed on the word alone either keeps the leak or drops
// real concerns — precision over breadth. The fix instead scrubs the SOURCE
// TEXT before tokenization of exactly two things that are unambiguously not
// free-text concerns: the workspace root's own folder name, and path-shaped
// spans (the task pack already resolves real paths structurally elsewhere —
// a path SPAN mentioned in prose carries no free-text concern of its own, so
// the whole span is dropped, not narrowed to a file stem). Standalone
// dictionary words are left untouched.
//
// W9 (2026-08-22, find-next path-token leak): the same hazard exists for
// EVERY identifier/concern-token extractor in this file, not just the
// concern-harvest source above — a query that mentions an absolute path in
// prose ("…in /Users/…/TokenLighten/packages/… how does X work") had its
// path SEGMENTS tokenized as if they were free-text/identifier content,
// which could surface as a wasted `tl_search_files action=find` `next`
// suggestion (or, worse, an `explicit-identifier` obligation the pack could
// never certify, since the segment is provably absent from every served
// surface). The scrub is now `util/queryShape.ts`'s workspace-agnostic
// `stripPathSpans("", text)` — see that module for the full rule set — used
// by every low-level identifier/token extractor below (explicitCodeIdentifiers,
// concreteIdentifierTokens, significantQueryTokens, concernAnchorTokens,
// dottedOrScopedIdentifiersIn) so every caller of those shared primitives is
// fixed at the source, plus the few `next`-builders that tokenize `query`
// directly instead of going through a shared primitive (nextCallForUnresolved,
// wiringCandidateTokens). `concernHarvestText` itself is now a thin wrapper
// over the same shared `stripPathSpans`, with its workspace-root rules intact.
// ---------------------------------------------------------------------------

/**
 * Remove workspace-identity text from a concern-harvest source BEFORE
 * tokenization — see the module comment above. A no-op on already-clean
 * prose: absent a literal root basename or a path-shaped span, the text
 * passes through unchanged. Thin wrapper over the shared, workspace-agnostic
 * `stripPathSpans` (util/queryShape.ts) — kept exported under its original
 * name since it is still the concern-harvest-specific entry point (recordConcernTokens)
 * and existing tests import it by this name.
 */
export function rootBasenameVocabulary(workspaceRoot: string): string[] {
  const root = basename((workspaceRoot ?? "").trim());
  // F-R20 (2026-08-23): ANY multi-segment root name is project identity, not
  // ordinary prose — camelCase (`M365DriveMounter`) and hyphen/underscore/
  // dot-segmented (`m365-drive-mount`) roots get the same fragment guard.
  // Splitting only camelCase roots used to leave hyphen-style segments as a
  // "legacy precision guarantee", but a segment like "mount" or "drive" is
  // exactly as much the project's own namespace when the folder name spells
  // it with hyphens as when it spells it in camelCase — leaving it as
  // "ordinary prose" let a bare queries[] entry or prose mention of that
  // word seed a concern token that then matched the whole project (the
  // NetResourceMountPoint false-fire class). Gate on the RAW segment count
  // (before the length filter below) so a root like "my-app" still counts
  // as two segments even though "my" is later dropped for being under 3
  // characters — a single-word root (e.g. "ledger") contributes nothing
  // here, since its one segment IS the literal basename
  // concernHarvestText/filterConcernQueryEntries already strip/compare
  // directly.
  const rawParts = root
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter((part) => part.length > 0);
  if (rawParts.length < 2) return [];
  const parts = rawParts.map((part) => part.toLowerCase()).filter((part) => part.length >= 3);
  return [...new Set(parts)];
}

export function concernHarvestText(workspaceRoot: string, text: string): string {
  let cleaned = stripPathSpans(workspaceRoot, text);
  for (const word of rootBasenameVocabulary(workspaceRoot)) {
    cleaned = cleaned.replace(new RegExp(`(?<![-.])\\b${escapeRegExp(word)}\\b(?![-.])`, "gi"), " ");
  }
  return cleaned;
}

/**
 * tl_search_files find `queries[]` entries are recorded VERBATIM (they are
 * already literal identifier tokens by contract — see the call site's own
 * doc in server.ts), so there is no free-text span to scrub. Drop an entry
 * that IS, in its entirety, the workspace root's basename or one of its
 * multi-segment name-words (rootBasenameVocabulary — any camelCase or
 * hyphen/underscore/dot segmentation, F-R20), that is itself a >=4-char
 * prefix of one of those words (so "mount" drops against root word
 * "mounter"), or that contains a path separator (a sign the caller passed a
 * path through queries[] rather than a literal token). A longer identifier
 * that merely CONTAINS a root word as a substring (e.g.
 * "NetResourceMountPoint") is left alone.
 */
export function filterConcernQueryEntries(workspaceRoot: string, queries: readonly string[]): string[] {
  const base = basename((workspaceRoot ?? "").trim()).toLowerCase();
  const rootWords = rootBasenameVocabulary(workspaceRoot);
  return queries.filter((q) => {
    const token = q.trim().toLowerCase();
    if (/[/\\]/.test(q)) return false;
    if (base && token === base) return false;
    if (rootWords.some((word) => token === word || (token.length >= 4 && word.startsWith(token)))) return false;
    return true;
  });
}

/** Han / Hiragana / Katakana. */
export const CJK_ANCHOR_CHAR_RE = /[぀-ヿ㐀-䶿一-鿿]/u;

/**
 * Is this token usable as a CONCERN ANCHOR — a claim that the repository must
 * contain something matching it?
 *
 * 2026-08-27 (field-eval integration). `util/queryShape.ts` began routing
 * `extractCjkTokens` into BOTH of its shared tokenizers, so a CJK-bearing
 * query now contributes CJK runs AND their 2-character bigrams
 * (`センサー` -> also `セン`, `ンサ`) to every consumer of
 * `concreteIdentifierTokens` / `significantQueryTokens`. For RETRIEVAL that is
 * the point and it stays: a Japanese query could previously match nothing at
 * all, and find/locate recall is exactly what those fragments are for.
 *
 * Concern anchoring is a different axis with the opposite polarity. An anchor
 * is not a search term — it is an OBLIGATION: `concernTokenMatchesSurfaces`
 * must find it in a served surface's path, symbol, or body, or the concern
 * stays uncovered and the pack is demoted. This function's own FIX-A rule
 * already states the standard ("a clause whose only unmatched wording is
 * free-text prose ... contributes NOTHING here"), and a symptom description in
 * Japanese prose — still less a sub-word kana bigram — is exactly that prose,
 * not an identifier the repository ever promised to contain.
 *
 * Measured on the aeroctl three-symptom fixture: the CJK fragments crowded the
 * real ASCII identifiers out of this function's `limit`-capped output, so
 * `augmentConcernGroupSurfaces` stopped resolving the mixer and mode-transition
 * clusters, two of three concerns went permanently uncovered, and a pack that
 * had certified `complete` fell to `awaiting-input` / choose-candidate. That is
 * an obligation nothing in an ASCII codebase can ever discharge.
 *
 * Scoped to the anchor axis ONLY — this changes no tokenizer and removes
 * nothing from retrieval, so it restores pre-wave parity here while leaving the
 * CJK recall win intact everywhere else.
 *
 * DELIBERATE NON-GOAL: a codebase whose identifiers or comments are themselves
 * CJK could in principle ground a CJK anchor (`concernTokenMatchesSurface`
 * substring-matches surface bodies). Admitting those would need a grounding
 * test — membership in the located candidates' own vocabulary, the
 * `knownIdentifiers` allowance `identifierShapedConcernSet` already takes —
 * not a shape test, because CJK has no case/underscore/dot shape signal to
 * separate an identifier from a noun. Until that evidence is plumbed here,
 * refusing to mint the obligation is the honest side to fail on.
 */
export function isConcernAnchorable(token: string): boolean {
  return !CJK_ANCHOR_CHAR_RE.test(token);
}
