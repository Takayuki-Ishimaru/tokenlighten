// requestItemAbsence — extracted implementation; imports point to the owning modules.
import * as fs from "fs";
import type { FindTextUniverse } from "../../search/find/findText.js";
import type { LineSpan } from "./sourceAndConcernTerms.js";
import type { RequestItem } from "../requestItems.js";
import type { ScanContentCache } from "../../search/find/findText.js";
import type { TaskPackResult } from "../model.js";
import type { TaskPackSurface } from "../model.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { DOC_MENTION_WORDS } from "../concernRecovery.js";
import { anyWalkOmission } from "../../../tools/walkRepo.js";
import { classifySurface } from "../../../util/impact.js";
import { clauseNamesOwnFacetSubject } from "../requestItems.js";
import { createScanContentCache } from "../../search/find/findText.js";
import { enumerateFindTextUniverse } from "../../search/find/findText.js";
import { extractFacetRequirements } from "./packBasics2.js";
import { facetClauseMatchesItem } from "../facetGate.js";
import { hasServedCode } from "./wiringEvidence2.js";
import { isAuxiliaryTreePath } from "./queryIntent3.js";
import { widenFindUniverseForAbsence } from "../../search/find/findText.js";

export interface RequestItemPrewalk {
  universe: FindTextUniverse;
  boundedClauseRecovery?: boolean;
  contentCache: ScanContentCache;
  /** `relPath -> identifier -> AST-resolved declaration range`, consulted by `declarationRangeInFile` above. An ABSENT entry is the honest "the AST could not bound this" answer, never an invitation to estimate. Never mutated after `prepareRequestItemPrewalk` returns. */
  astDeclarationRanges: ReadonlyMap<string, ReadonlyMap<string, LineSpan>>;
}

/** `undefined` outside a `buildTaskPack` call, or when the pre-pass determined nothing needed resolving (a single-item query, or a composite query with no `decision` item) — `declarationRangeInFile` treats a missing store, a missing file entry and a missing identifier entry identically: `{source:"unresolved"}`, i.e. only whole-file coverage can prove that candidate. See the module doc comment just above for the full ALS rationale. */
export const requestItemPrewalkStorage = new AsyncLocalStorage<RequestItemPrewalk | undefined>();

/** A conservative work proof over the existing composite-request prewalk.
 * Its full-recall, 8 MiB text inventory includes docs and manifests and is a
 * superset of locate's code/CSS and wide-literal scans. Artifacts never enter
 * locate ranking or parsing. Unknown/omitted inventories keep the old time
 * guards. This performs at most 128 stats, and never another directory walk.
 */
export function clauseRecoveryInventoryIsBounded(universe: FindTextUniverse): boolean {
  if (universe.scopes.length !== 1 || universe.scopes[0] !== "."
    || anyWalkOmission(universe.omissions) || universe.files.length > 128) return false;
  let bytes = 0;
  for (const file of universe.files) {
    try {
      const stat = fs.statSync(file.absPath);
      if (!stat.isFile()) return false;
      bytes += stat.size;
      if (bytes > 1024 * 1024) return false;
    } catch { return false; }
  }
  return true;
}

export function boundedClauseRecoveryWork(): boolean {
  const prewalk = requestItemPrewalkStorage.getStore();
  if (prewalk === undefined) return false;
  return prewalk.boundedClauseRecovery ??= clauseRecoveryInventoryIsBounded(prewalk.universe);
}

export interface RequestItemPassCache {
  universe: FindTextUniverse;
  contentCache: ScanContentCache;
  /**
   * Review finding 2(b) fix (2026-09-08): lazily computed and memoized by
   * `ensureAbsenceUniverse` — mutated in place (not re-assigned to a new
   * object identity) so it survives across the several `buildRequestItemReadiness`
   * calls one pack build can make (see `cachedRequestItemPass`'s own doc
   * comment), the SAME per-`TaskPackResult` cache lifetime `universe`/
   * `contentCache` already get from `requestItemPassCache` below.
   */
  absenceUniverse?: FindTextUniverse;
}

export const requestItemPassCache = new WeakMap<TaskPackResult, RequestItemPassCache>();

export function cachedRequestItemPass(workspace: string, result: TaskPackResult): RequestItemPassCache | undefined {
  const cached = requestItemPassCache.get(result);
  if (cached !== undefined) return cached;
  // Reuse the async pre-pass's own walk (if one ran for this buildTaskPack
  // call) instead of walking again — see the module doc comment above
  // `MAX_DECISION_TREE_SITTER_CANDIDATES` for why this must stay exactly one
  // walk per composite pack build.
  const prewalk = requestItemPrewalkStorage.getStore();
  if (prewalk !== undefined) {
    const fromPrewalk: RequestItemPassCache = { universe: prewalk.universe, contentCache: prewalk.contentCache };
    requestItemPassCache.set(result, fromPrewalk);
    return fromPrewalk;
  }
  let universe: FindTextUniverse;
  try {
    universe = enumerateFindTextUniverse(workspace);
  } catch {
    return undefined;
  }
  const built: RequestItemPassCache = { universe, contentCache: createScanContentCache() };
  requestItemPassCache.set(result, built);
  return built;
}

/**
 * Review finding 2(b) fix (2026-09-08): lazily widens `pass.universe` to
 * match `tl_search_files find`'s own generic-text fallback tier
 * (`widenFindUniverseForAbsence`) and memoizes the result on `pass` — at
 * most one extra workspace walk per pack build, reused by every
 * `distinctiveSalientAbsence`/`proveUnbindableRequestItem` call the build
 * makes (see `RequestItemPassCache.absenceUniverse`'s own doc comment).
 */
export function ensureAbsenceUniverse(workspace: string, pass: RequestItemPassCache): FindTextUniverse {
  if (pass.absenceUniverse === undefined) {
    pass.absenceUniverse = widenFindUniverseForAbsence(workspace, pass.universe);
  }
  return pass.absenceUniverse;
}

export const DOC_MENTION_WORD_RE = new RegExp(`\\b(?:${DOC_MENTION_WORDS.join("|")})\\b`, "iu");

/**
 * C5 (fix-c, 2026-09-21, plan §6.1) — an item whose text OPENS with one of
 * these markers is itself an example/elaboration of a preceding point
 * ("such as X", "like Y", "e.g. Z", "for example/for instance W"), never an
 * independent concern — see the call site's own doc comment.
 */
export const EXAMPLE_FRAGMENT_LEAD_RE = /^(?:such as|for example|for instance|like|e\.g\.?|i\.e\.?)\b/iu;

/**
 * TL-04 (fix-b, 2026-09-21) — "no noise file standing in for a concern".
 *
 * `proveUnbindableRequestItem` (this file, the absence-proof engine FIX-C
 * owns) reports every literal/inflection-variant occurrence of a point's
 * salient words as a candidate, with no doc-role awareness of its own — it
 * is an absence proof, not a relevance ranker. Once a reported candidate is
 * served, its own "every literal-find candidate for this point is served"
 * close certifies the point PROVED regardless of what that candidate
 * actually explains. Confirmed live (four-concern fixture, 2026-09-21): a
 * README that narrates every concern next to its own file paths ("...
 * authentication (`src/auth.ts`) ...") literally CONTAINS the word
 * "authentication", `proveUnbindableRequestItem`'s exact-match scan finds
 * ONLY that README (never trying the auth.ts-matching inflection variant,
 * since the exact pass already found something — a second, separate
 * candidate-discovery defect, also inside that same excluded engine and
 * reported alongside this fix), and once the README is served the point is
 * certified proved from a file that never explains authentication at all.
 *
 * This does not — cannot, from here — fix candidate DISCOVERY inside the
 * excluded proof engine. It narrows what THIS file (the request-item gap →
 * next-target selection, squarely this fix's own region) offers as a
 * point's candidate: a DOC-role path (`classifySurface(path) === "doc"`,
 * the same classification `runClauseLocateRecovery`'s own `isDocPath` guard
 * and `isClauseCoveredBySeededSurfaces`'s new one (B5) already trust) is
 * dropped from a point's own candidate list unless the point's text itself
 * asks about documentation (recall control — a point that really asks
 * about the README/docs still gets it offered). Never touches
 * `proof.proved`/`evidence`/`reason` — an item whose ONLY candidate was
 * doc-role is simply left with none here, which reads as an honest, bounded
 * dead end for THAT item (its own obligation stays `"uncovered"`,
 * `gapIds` still names it) rather than a false "proved". Other items'
 * candidates, and the overall chain's ability to progress on THEM, are
 * unaffected.
 */
export function nonDocNoiseCandidatePaths(candidatePaths: readonly string[], itemText: string): string[] {
  const kept = DOC_MENTION_WORD_RE.test(itemText)
    ? [...candidatePaths]
    : candidatePaths.filter((p) => classifySurface(p) !== "doc");
  // 2026-11 (external A/B of v0.16.4, TokenLighten's own repository — T3
  // "where is the tool surface decided"): a point about the product's
  // behaviour is not answered by a spec file, a bench fixture or an issue
  // template that happens to spell its words. When a product-tree candidate
  // exists, the auxiliary-tree ones are dropped from this point's own list —
  // unless the point itself asks about tests/benchmarks/examples (recall
  // control). A point whose ONLY candidates are auxiliary keeps them, exactly
  // as before: an honest bounded dead end beats a silent one.
  if (AUXILIARY_TREE_POINT_RE.test(itemText)) return kept;
  const product = kept.filter((p) => !isAuxiliaryTreePath(p));
  return product.length > 0 ? product : kept;
}

/** A point that itself asks about tests, fixtures, benchmarks, examples or templates (EN/JA) — auxiliary-tree files ARE its evidence. */
export const AUXILIARY_TREE_POINT_RE = /\b(?:tests?|specs?|fixtures?|bench(?:marks?)?|examples?|samples?|templates?)\b|テスト|スペック|フィクスチャ|ベンチ|例/iu;

/**
 * 2026-11 (external A/B of v0.16.4, TokenLighten's own repository — T3 "where
 * is the tool surface decided": the pack served the decision site, then spent
 * two more calls and ~27 KB on spec files and `.github` issue templates that
 * spell the question's words). True when every remaining candidate for a point
 * sits under an auxiliary tree (`isAuxiliaryTreePath`), the point does not ask
 * about tests/fixtures itself, and this task has ALREADY served product source
 * — the signal that the product tree, not its tests, is where the answer
 * lives. The caller then discloses the point as could-not-determine instead of
 * fetching those files. With no product evidence served yet (a question whose
 * only hits are in tests), nothing changes: the candidates are fetched as
 * before.
 */
export function auxiliaryOnlyCandidatesAfterProductEvidence(
  candidatePaths: readonly string[],
  itemText: string,
  priorEvidence: readonly TaskPackSurface[],
): boolean {
  if (candidatePaths.length === 0) return false;
  if (AUXILIARY_TREE_POINT_RE.test(itemText)) return false;
  if (!candidatePaths.every((p) => isAuxiliaryTreePath(p))) return false;
  return priorEvidence.some((surface) => hasServedCode(surface) && !isAuxiliaryTreePath(surface.path) && classifySurface(surface.path) !== "doc");
}

/**
 * R2-T2 (2026-09-30, review-0929 P0-5 and its follow-up ruling) — the
 * NON-blocking `request-item-undetermined` disclosure for a coordinated point
 * (`RequestItem.coordinated`: "Explain X and the health probe" → "the health
 * probe") that this pack could not locate: named by its topic words, with the
 * unserved candidate path(s) it has. One wording for both loops of
 * `buildRequestItemReadiness` that mint it (the all-topic pass, and the
 * mixed-kind loop when no fetchable candidate is left).
 */
/**
 * R2-T2 follow-up (2026-09-30, orchestrator ruling on the round-2 combined
 * run: "a facet-owned clause → never") — sets `RequestItem.facetSubject` on
 * every point that a facet clause (requestFacets.ts) claims with identifiers
 * INHERITED from the query's lead, unless the point names a subject of its
 * own (`clauseNamesOwnFacetSubject`: "…the default values OF the flux
 * capacitor"). Measured leak: with the lead's identifier absent from the
 * workspace no facet resolves a focal, so `reconcileRequestItemsWithFacets`
 * owns nothing and a bullet's participants were certified absent ("For the
 * grace_table …:" + "- under which conditions is a customer refused a
 * refund" → customer/refund). Such a point is about the lead's identifier:
 * it is covered, owned by the facet, or disclosed undetermined — never
 * certified absent through a plain word (`disclosableAbsenceTerm`).
 */
export function markFacetOwnedPoints(items: readonly RequestItem[], query: string): void {
  const inherited = extractFacetRequirements(query)
    .filter((requirement) => requirement.inheritedFromLead && requirement.subjectIdentifiers.length > 0);
  if (inherited.length === 0) return;
  for (const item of items) {
    if (clauseNamesOwnFacetSubject(item.text)) continue;
    const owner = inherited.find((requirement) => facetClauseMatchesItem(requirement.clause, item.text));
    if (owner !== undefined) item.facetSubject = [...owner.subjectIdentifiers];
  }
}

/**
 * C1 consistency veto (fix-c, 2026-09-21, plan §6.1) — a defense-in-depth
 * backstop consulted at every point this function turns an absence into a
 * wire entry: an absence whose concern is backed by served evidence, per
 * the SAME normalisation (C2's `concernTermVariants`) the scanners above
 * already used to look for it, must never reach the wire beside the
 * evidence that answers it (Q03: the whole cache module served, plus two
 * `explicit-gap:request-item-absent:` entries quoting the very JP clauses
 * that module answers). The per-candidate scanners in `distinctiveSalient
 * Absence`/`proveUnbindableRequestItem` already skip a term their OWN loop
 * finds evidenced FIRST — this is the one place every absence THIS
 * function mints funnels through before joining `absences[]`, so a
 * multi-hop pack where the evidence and the absence claim are computed a
 * turn apart (or a future absence source) can never reintroduce the
 * contradiction by skipping that upstream check.
 *
 * FIX-C2 (2026-09-21): this is no longer a SECOND concentration rule of its
 * own — it delegates to the single policy
 * (`concernCoveredByServedEvidence`), so "covered" and "not absent" can
 * never disagree by construction (invariant (i)). `itemText` is the concern
 * the absence belongs to: the policy needs it for the doc-role recall
 * control (a concern that really asks about documentation still accepts a
 * README as its anchor).
 */
/** Han ideographs (CJK Unified + Extension A). */
export const KANJI_CHAR_RE = /[㐀-䶿一-鿿]/u;

/**
 * FIX-D (TL-06, 2026-09-21, plan §8.3) — compact, opt-in per-request-item
 * diagnostics on the EXISTING `TL_TRACE=1` channel (util/trace.ts). Off by
 * default (`isTraceEnabled()` false) and a guaranteed no-op then — every
 * caller below checks it FIRST, before doing any of the extra work these
 * helpers do, so a disabled channel costs nothing beyond that one check.
 * Never reaches the wire: `trace()` only ever appends to a local JSONL file.
 *
 * Deliberately terse and bounded: a request item's own clause text is
 * capped at 80 chars, term/evidence lists are capped small, and evidence
 * carries `{path, range, sha}` only — never a served body, a full query, or
 * a credential. `capWords` bounds `reason` to <=12 words on a word
 * boundary, matching the "why" a human skimming a trace file needs without
 * re-deriving the internal proof engine's own long-form comments.
 */
export function capWords(text: string, maxWords: number): string {
  const words = text.trim().split(/\s+/).filter((w) => w.length > 0);
  return words.length <= maxWords ? words.join(" ") : words.slice(0, maxWords).join(" ") + "...";
}
