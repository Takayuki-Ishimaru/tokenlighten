// concernProof — extracted implementation; imports point to the owning modules.
import * as path from "path";
import type { ConcernAbsenceProbe } from "./sourceAndConcernTerms3.js";
import type { ConcernCoverageVerdict } from "./sourceAndConcernTerms4.js";
import type { ConcernStatus } from "./sourceAndConcernTerms3.js";
import type { ConcernTermVariants } from "./sourceAndConcernTerms3.js";
import type { FindTextUniverse } from "../../search/find/findText.js";
import type { LineSpan } from "./sourceAndConcernTerms.js";
import type { RequestItem } from "../requestItems.js";
import type { RequestItemProof } from "./recursiveClosure5.js";
import type { ScanContentCache } from "../../search/find/findText.js";
import type { TaskPackSurface } from "../model.js";
import type { TaskReadinessEvidence } from "@tokenlighten/types";
import { FileReadCache } from "./packBasics2.js";
import { GENERIC_PROCESS_VERB_WORDS } from "./concernProof3.js";
import { MAX_REQUEST_ITEM_TOPIC_CANDIDATES } from "./recursiveClosure5.js";
import { classifySurface } from "../../../util/impact.js";
import { concernAbsenceProbe } from "./sourceAndConcernTerms3.js";
import { concernAdmitsDocAnchor } from "./sourceAndConcernTerms3.js";
import { concernNamesDeclaredSymbol } from "./sourceAndConcernTerms3.js";
import { concernNamesServedPath } from "./sourceAndConcernTerms3.js";
import { concernTermAnchoredInSurface } from "./sourceAndConcernTerms3.js";
import { concernTopicTerms } from "./sourceAndConcernTerms3.js";
import { concernVariantMap } from "./sourceAndConcernTerms3.js";
import { concernWindowInUnservedPart } from "./concernProof2.js";
import { configurationEvidenceSpan } from "../evidenceClosure.js";
import { configurationFileQuestion } from "./concernProof2.js";
import { containsJapanese } from "../../retrieval/jaQueryBridge.js";
import { contentPredicateWords } from "./requestItemAbsence.js";
import { createScanCoverage } from "../../search/find/findText.js";
import { currentFileLineCount } from "./sourceAndConcernTerms2.js";
import { declarationCandidatePaths } from "./sourceAndConcernTerms.js";
import { declarationRangeInFile } from "./sourceAndConcernTerms2.js";
import { definitionKeyTokensOf } from "./sourceAndConcernTerms2.js";
import { disclosableAbsenceForms } from "./requestItemAbsence.js";
import { disclosableAbsenceTerm } from "./requestItemAbsence.js";
import { evidenceSurfacesForPath } from "./sourceAndConcernTerms.js";
import { familyMemberCandidates } from "../familyMemberSeeds.js";
import { fileTermCandidatePaths } from "./sourceAndConcernTerms.js";
import { hasServedCode } from "./wiringEvidence2.js";
import { headRelatesPresentThings } from "./requestItemAbsence.js";
import { hitLineHoldsWholeIdentifier } from "./identifierAbsence2.js";
import { identifierGroundingEnabled } from "../../../util/flags.js";
import { isCallOrImportOccurrence } from "./sourceAndConcernTerms2.js";
import { isCodeShapedTerm } from "../requestItems.js";
import { isTestConcernPath } from "./literalAndConcernSeeds.js";
import { isWholeAuthoritySurface } from "./changeAndReadinessEvidence2.js";
import { jaQueryBridgeEnabled } from "../../../util/flags.js";
import { jaTopicNounPhrase } from "../requestItems.js";
import { languageForPath } from "../../../util/languages.js";
import { lineSpansCover } from "./sourceAndConcernTerms.js";
import { looksLikeFileTerm } from "../requestItems.js";
import { manifestCandidatePaths } from "./sourceAndConcernTerms.js";
import { matchIsManagedGuideText } from "./guideAndArtifactSurfaces.js";
import { noDisclosableTermReason } from "./requestItemAbsence.js";
import { pathServedWholeFile } from "./sourceAndConcernTerms3.js";
import { quotedLiteralTerm } from "./sourceAndConcernTerms3.js";
import { readCached } from "./packBasics2.js";
import { readinessEvidence } from "./changeAndReadinessEvidence2.js";
import { relationConsumerCandidatePaths } from "./sourceAndConcernTerms2.js";
import { requestIntroducesName } from "../familyMemberSeeds.js";
import { salientWords } from "../requestItems.js";
import { scanRequestItemLiteral } from "../requestItemScan.js";
import { scopeCompletenessAfterScan } from "./sourceAndConcernTerms3.js";
import { servedLineSpansOf } from "./sourceAndConcernTerms.js";
import { servedPathSet } from "./sourceAndConcernTerms.js";
import { servedRangeSourceHasSalientWord } from "./sourceAndConcernTerms3.js";
import { servedSurfaceText } from "./changeAndReadinessEvidence2.js";
import { sharesSignificantSubstring } from "../requestItems.js";
import { subtractLineSpans } from "./sourceAndConcernTerms.js";
import { surfaceEvidencesSalientWord } from "./sourceAndConcernTerms3.js";
import { textHasWordVariant } from "../salientWordMatch.js";
import { unservedRemainderCarriesMissingTerm } from "./sourceAndConcernTerms4.js";

/**
 * THE policy's coverage half — "is this concern backed by evidence served in
 * this epoch?", asked identically by every request-item path. See this
 * section's header for the rule and why it is positional.
 */
export function concernCoveredByServedEvidence(
  itemText: string,
  terms: readonly string[],
  variantsByTerm: ReadonlyMap<string, ConcernTermVariants>,
  priorEvidence: readonly TaskPackSurface[],
  workspace: string,
  /** R-B3 (ruling 1): the collision rule's whole-scope absence test; callers without a scan universe pass none and keep the single-anchor route unconditionally (their own terms are a single absence claim, so there is no OTHER term to collide with). */
  absenceProbe?: ConcernAbsenceProbe,
): ConcernCoverageVerdict {
  if (terms.length === 0) {
    return { covered: false, surfaces: [], matchedTerms: [], codeAnchored: false, reason: "no topic term to look for" };
  }
  const docAnchorsAllowed = concernAdmitsDocAnchor(itemText);
  // R-B3 (ruling 2): the clause's generic PROCESS predicate(s), read only by
  // the sliver guard below — see `GENERIC_PROCESS_VERB_WORDS`.
  const processPredicates = salientWords(itemText).filter((word) => GENERIC_PROCESS_VERB_WORDS.has(word.toLowerCase()));
  const processPredicateVariants = processPredicates.length > 0 ? concernVariantMap(processPredicates, workspace) : undefined;
  // R-B3 (ruling 1): the clause's content predicates — the only terms the
  // collision rule below lets block a single anchor.
  const contentPredicates = contentPredicateWords(itemText);
  const surfaces: TaskPackSurface[] = [];
  const matchedTerms = new Set<string>();
  let anchoredAnywhere = false;
  let codeAnchoredAnywhere = false;
  let firstCollision: string | undefined;
  for (const surface of priorEvidence) {
    if (!hasServedCode(surface)) continue;
    const haystack = `${surface.path}\n${servedSurfaceText(surface)}`;
    const distinct = new Set<string>();
    /** Terms carried by the served CONTENT, not merely by the file's name. */
    const contentEvidenced = new Set<string>();
    /** Terms ANCHORED in the served content (code position or repeated use) — GATE-B's partial-serve route reads this. */
    const anchoredTerms = new Set<string>();
    let anchored = false;
    let codePosition = false;
    let literalCodeAnchor = false;
    for (const term of terms) {
      const variants = variantsByTerm.get(term)?.variants ?? [term];
      // A Japanese term reaches a workspace only through the JA bridge, so
      // every one of its variants is a TRANSLATION guess; an EN term's
      // variants are its own inflections. Only the latter can carry the
      // "the user literally named this and it is in the served code" signal
      // the multi-term anchor route below requires.
      const literalTerm = !containsJapanese(term);
      let evidenced = false;
      for (const variant of variants) {
        if (
          textHasWordVariant(haystack, variant)
          || surfaceEvidencesSalientWord(surface, variant)
          // TL_IDENTIFIER_GROUNDING: the body on the wire has its doc
          // comments elided, so a concern whose wording lives in the served
          // member's OWN doc comment must still count — the reviewed
          // 2026-09-20 widening, carried into the single policy unchanged.
          || (identifierGroundingEnabled() && servedRangeSourceHasSalientWord(surface, variant, workspace))
        ) {
          evidenced = true;
        }
        if (
          textHasWordVariant(servedSurfaceText(surface), variant)
          || (identifierGroundingEnabled() && servedRangeSourceHasSalientWord(surface, variant, workspace))
        ) {
          evidenced = true;
          contentEvidenced.add(term.toLowerCase());
        }
        const anchor = concernTermAnchoredInSurface(surface, variant, docAnchorsAllowed);
        if (anchor.anchored) {
          evidenced = true;
          anchored = true;
          anchoredTerms.add(term.toLowerCase());
          if (anchor.codePosition) {
            codePosition = true;
            if (literalTerm) literalCodeAnchor = true;
          }
        }
        if (evidenced && codePosition) break;
      }
      if (evidenced) distinct.add(term.toLowerCase());
    }
    // GATE-B (2026-09-21): a concern that NAMES this served artefact — by
    // this surface's own path/basename, or by a symbol DECLARED in it — is
    // covered by SERVING that artefact, even when nothing below concentrates
    // (a single-topic-word concern whose only wording IS the file's own
    // name, e.g. "Explain what calc.ts does", can never concentrate inside
    // calc.ts's own body: the file's name is not a word inside itself).
    // Two independent forms, each gated on its OWN "the artefact is actually
    // on the wire" condition so this can never reopen the false anchor the
    // very next comment documents (a bare path/segment match with an
    // unrelated line served):
    //   - PATH: `concernNamesServedPath` requires the concern's own text to
    //     spell this surface's FULL relative path or its basename WITH
    //     EXTENSION — never a bare directory name or an extension-less word
    //     that merely equals a path segment (that stays exactly as
    //     uncovered as FIX-C2 left it). Covered when this path's served
    //     spans leave no real remainder of the CURRENT file (the naming
    //     term cannot concentrate against its own file, so the whole file
    //     must be on the wire), or when some OTHER topic term's CONTENT
    //     (not merely its path) is already evidenced, even over a partial
    //     serve.
    //   - SYMBOL: a topic term is a symbol AST-declared in this surface's
    //     file, with the declaration's own range inside this epoch's served
    //     spans — authoritative, so unlike the anchor below it needs
    //     neither a second term nor a literal-EN code-position match to
    //     fire.
    let namedArtefactCovered = false;
    if (concernNamesServedPath(itemText, surface.path)) {
      const namingStem = path.basename(surface.path).replace(/\.[^./]+$/u, "").toLowerCase();
      // R-B1 (2026-09-21, held item 2): over a PARTIAL serve the other topic
      // term must be ANCHORED in the served lines (a code position or
      // repeated use — the same positional test every other route uses),
      // not merely present once. "Present once" let a naming concern be
      // covered by a partly served file whose only other hit was a word in a
      // header comment. Coverage by NAME alone still needs the whole file
      // (`pathServedWholeFile`); coverage by CONTENT needs an anchor.
      const otherContentAnchored = [...anchoredTerms].some((t) => t !== namingStem);
      if (otherContentAnchored || pathServedWholeFile(priorEvidence, surface.path, workspace)) {
        namedArtefactCovered = true;
      }
    }
    if (!namedArtefactCovered) {
      for (const term of terms) {
        if (concernNamesDeclaredSymbol(term, surface.path, priorEvidence, workspace)) {
          namedArtefactCovered = true;
          break;
        }
      }
    }
    if (distinct.size === 0 && !namedArtefactCovered) continue;
    // TWO distinct topic terms in one surface is the pre-existing
    // concentration bar and stays exactly as it was. The ANCHOR route is what
    // this wave adds, under one of two conditions:
    //
    //  (a) the concern HAS no second term to concentrate on — one term is the
    //      whole clause (an EN clause reduced by light-verb filtering, or a JA
    //      clause that is one unsegmented run), so the two-term bar is
    //      unreachable by construction and WHERE the term lives is the only
    //      discriminator left; or
    //  (b) a term the user LITERALLY typed (never a JA-bridge translation
    //      guess) is in the served CODE itself — "Explain what the
    //      `ParseResult` type looks like" against a served `export interface
    //      ParseResult`, where the clause's other words ("type", "looks",
    //      "like") were never going to match anything.
    //
    // A multi-term concern anchored only through a BRIDGED term keeps the old
    // two-term bar deliberately: a JA request listing several distinctive
    // points ("… の API endpoint、… の cancel 処理 …") must not be certified
    // covered off one vague run translating onto whatever was served — that
    // is the reviewed `TL_IDENTIFIER_GROUNDING (C)` contract ("the rule
    // widens 'served', it does not waive the point").
    const anchorRouteAvailable = terms.length === 1 || literalCodeAnchor;
    // R-B1 (2026-09-21, held item 1 — "coverage must not certify off a
    // sliver"): route (b) lets ONE literal term at a code position cover a
    // multi-term concern because the clause's other words usually never
    // match anything. That premise is false when the SAME file's unserved
    // part carries another of the concern's terms at a code position: the
    // body that answers the point is right there, just not on the wire.
    // Confirmed live: "how refunds are processed" certified from a served
    // four-line slice whose only hit was the `RefundRequest` interface name,
    // while `processRefund` sat unserved six lines below. Such a surface does
    // not cover; the point stays open and its continuation addresses the
    // unserved window (`concernWindowInUnservedPart`). Positional and
    // language-agnostic; it can only ever REMOVE a route-(b) coverage and
    // never turns a concern absent (the term demonstrably occurs), so the
    // two-term bar, route (a) and the named-artefact route are untouched.
    const slivered = anchored
      && anchorRouteAvailable
      && contentEvidenced.size < 2
      && !namedArtefactCovered
      && (
        (terms.length > 1 && unservedRemainderCarriesMissingTerm(surface.path, terms, contentEvidenced, variantsByTerm, priorEvidence, workspace))
        // R-B3 (ruling 2): excluding the generic process verbs from the topic
        // terms must not reopen this very sliver through route (a): "how
        // refunds are processed" reduces to ONE term, and one served
        // `RefundRequest` interface line anchors it — while `processRefund`,
        // the body the clause asks for, sits unserved in the same file. The
        // predicate stays non-evidential (it never covers and is never
        // disclosed); it only says the processing body is not on the wire.
        || (processPredicateVariants !== undefined
          && !processPredicates.some((word) => (processPredicateVariants.get(word)?.variants ?? [word]).some((variant) => textHasWordVariant(servedSurfaceText(surface), variant)))
          && unservedRemainderCarriesMissingTerm(surface.path, processPredicates, new Set<string>(), processPredicateVariants, priorEvidence, workspace))
      );
    // A file NAME never covers a concern: the BYTES on the wire must carry
    // it. Confirmed live on the matrix: a clause naming "session renewal"
    // was certified covered by `src/sessionRenewal.ts` while only that file's
    // unrelated interface header line had been delivered — two terms
    // "matched", one of them off the path alone, and the function that
    // answers the point was never sent. A path match still makes the file a
    // CANDIDATE (so the concern can never be certified absent over it — see
    // the path-name pass in `proveUnbindableRequestItem`); it just does not
    // COVER anything by itself. plan §5: "covered は『同じファイルが見つかった』
    // 『単語が一つ出現した』だけでは成立させ[ない]". GATE-B's own named-artefact
    // route above is the one deliberate exception this ruling carves out —
    // gated on the concern SPELLING the artefact's own path/declaration,
    // never merely on it happening to be the file a candidate scan turned up.
    // R-B3 (2026-09-21, orchestrator ruling 1) — THE COLLISION RULE. A
    // concern is covered by ONE anchored topic term only if none of its OTHER
    // topic terms is provably absent from the whole scanned scope (every
    // variant — literal, identifier split, inflection, derivation — occurs
    // nowhere; `ConcernAbsenceProbe`). Confirmed live (R-B1's matrix, the
    // copied multi-package tree): "how inventory is replenished" was
    // certified covered by a served `inventory_files` field in unrelated
    // budget code while replenishment exists nowhere — a word collision, not
    // an implementation. When a term is provably absent the concern needs the
    // two-term bar; failing it, the absent term is what the caller discloses
    // (`collisionAbsentTerm`). A term that merely occurs somewhere unserved
    // never blocks the anchor, so today's recall and hop count are kept, and
    // route (a) (one topic term, nothing else to collide with) and the
    // named-artefact route are untouched.
    const singleAnchor = anchored && anchorRouteAvailable && !slivered;
    let collision: string | undefined;
    // The one thing a collision can never be: an anchor that NAMES the served
    // file itself (`src/cache.ts` anchoring "cache"). The surface is then
    // about the concern's subject, and a provably absent modifier is a
    // synonym gap the lexical scan cannot bridge (a TTL-only cache answering
    // "how expired cache entries are handled"), not a coincidence — the
    // recall control this rule is checked against.
    const nameWithoutExtension = surface.path.replace(/\.[^./]+$/u, "");
    const anchorNamesFile = [...anchoredTerms].some((anchoredTerm) => {
      const original = terms.find((term) => term.toLowerCase() === anchoredTerm) ?? anchoredTerm;
      return (variantsByTerm.get(original)?.variants ?? [original]).some((variant) => !containsJapanese(variant) && textHasWordVariant(nameWithoutExtension, variant));
    });
    if (singleAnchor && contentEvidenced.size < 2 && !namedArtefactCovered && terms.length > 1 && absenceProbe !== undefined && !anchorNamesFile) {
      // The blocking term is the clause's own CONTENT PREDICATE ("is
      // replenished", "are renewed" — an auxiliary-governed participle outside
      // the light/generic class, `contentPredicateWords`): what the concern
      // says happens to its subject. Never a framing word — route (b)'s own
      // reviewed case ("what the `ParseResult` type looks like": "looks",
      // "like" occur nowhere and were never going to) and C5's example
      // phrases ("a comment like \"// TODO\"") keep their single anchor.
      collision = terms.find((term) => contentPredicates.has(term.toLowerCase())
        && !anchoredTerms.has(term.toLowerCase())
        && absenceProbe.provablyAbsent(term));
      if (collision !== undefined && firstCollision === undefined) firstCollision = collision;
    }
    if (contentEvidenced.size >= 2 || (singleAnchor && collision === undefined) || namedArtefactCovered) {
      surfaces.push(surface);
      for (const term of distinct) matchedTerms.add(term);
      if (anchored) anchoredAnywhere = true;
      if (codePosition) codeAnchoredAnywhere = true;
      if (namedArtefactCovered) anchoredAnywhere = true;
    }
  }
  if (surfaces.length === 0) {
    if (firstCollision !== undefined) {
      return {
        covered: false,
        surfaces: [],
        matchedTerms: [],
        codeAnchored: false,
        reason: `a served surface names this point only through one term while ${firstCollision} occurs nowhere in the scanned scope`,
        collisionAbsentTerm: firstCollision,
      };
    }
    return { covered: false, surfaces: [], matchedTerms: [], codeAnchored: false, reason: "no served surface concentrates this point's wording" };
  }
  return {
    covered: true,
    surfaces,
    matchedTerms: [...matchedTerms],
    codeAnchored: codeAnchoredAnywhere,
    reason: anchoredAnywhere
      ? "a served surface carries this point's wording where it is implemented (path, code position, or repeated use)"
      : "a served surface already contains this point's salient wording",
  };
}

/**
 * What the CALLER's own candidate resolution established for a concern the
 * policy did not find covered. Each path resolves candidates its own way
 * (literal/variant scan, declaration sites, relation consumers, manifests) —
 * only the STATUS mapping below is shared.
 */
export type ConcernScanOutcome =
  /** The caller ran no scan of its own (a structural arm that already has its verdict). */
  | { kind: "not-scanned"; reason: string }
  /** Zero occurrences anywhere in the scanned scope. */
  | { kind: "no-occurrence"; scopeComplete: boolean; omittedCount: number; everyTermNormalized: boolean }
  /** Every candidate is served, none concentrates the concern — a scope-bound absence. */
  | { kind: "served-unconcentrated"; scopeComplete: boolean; omittedCount: number }
  /** Candidates exist but are not served yet. */
  | { kind: "unserved-candidates"; candidatePaths: readonly string[] }
  /** The scan could not be bounded (caps, too many candidates, no usable normalisation). */
  | { kind: "indeterminate"; reason: string };

export interface ConcernVerdict {
  status: ConcernStatus;
  evidence: TaskReadinessEvidence[];
  reason: string;
  candidatePaths: string[];
  absentTerm?: string;
  scopeComplete?: boolean;
  omittedCount?: number;
  /** R-B3 (ruling 5): the served-unconcentrated outcome — the term occurs, only in passing. */
  incidental?: boolean;
  /**
   * R-D2 (2026-09-21, item B, plan §5): set ONLY on the two `could-not-
   * determine` shapes below that carry NO `absentTerm` (a term with no
   * confirmed normalisation to search against, or an unboundable/
   * indeterminate scan) — the genuinely SILENT case before this fix: with no
   * `absentTerm`, `requestItemProofFromVerdict` maps them to `proved:false`
   * with no candidate and no disclosure at all, so the caller learns
   * NOTHING happened for this concern. The `scopeComplete:false` could-not-
   * determine shapes just below already carry `absentTerm` and are already
   * disclosed via the existing "N paths excluded" wording — this field is
   * never set alongside `absentTerm` (invariant (i): never beside a
   * covered/disclosed claim for the SAME concern). The one term this
   * verdict is about, so a caller can name it without re-deriving
   * `termLabel`.
   */
  undeterminedTerm?: string;
}

/**
 * THE ONE concern-status policy. Coverage is asked FIRST and wins over every
 * scan outcome (invariant (i)); only then is the caller's own scan mapped
 * onto the remaining three statuses.
 *
 * `coverage` is passed in rather than recomputed because every caller must
 * consult it BEFORE running its own (expensive) candidate scan — that
 * short-circuit is the point. It is only ever produced by
 * `concernCoveredByServedEvidence`, the single coverage rule above.
 */
export function decideConcernStatus(
  terms: readonly string[],
  coverage: ConcernCoverageVerdict,
  outcome: ConcernScanOutcome,
): ConcernVerdict {
  if (coverage.covered) {
    return { status: "covered", evidence: coverage.surfaces.map(readinessEvidence), reason: coverage.reason, candidatePaths: [] };
  }
  const termLabel = terms.join("/");
  switch (outcome.kind) {
    case "not-scanned":
      return { status: "covered", evidence: [], reason: outcome.reason, candidatePaths: [] };
    case "no-occurrence":
      if (!outcome.everyTermNormalized) {
        // Ruling C1/C6: a raw literal miss for a term the normalisation
        // MECHANISM never ran for is "could not determine", never absent.
        // FIX-G (2026-09-27): the parenthetical must be TRUE — with the bridge
        // ON (its default for answer packs) the cause is that this term has no
        // confirmed normalisation (a kanji glossary word or a meta fragment,
        // R-B3 ruling 3), never "the bridge is disabled" (eval-0927 §4 read the
        // old wording on every Japanese pack).
        return {
          status: "could-not-determine",
          evidence: [],
          reason: `no confirmed normalisation available to search ${termLabel} against (${jaQueryBridgeEnabled() ? "this Japanese term has no loanword or glossary counterpart to search" : "TL_JA_QUERY_BRIDGE is disabled for a Japanese term"}) — not a verified absence`,
          candidatePaths: [],
          undeterminedTerm: termLabel,
        };
      }
      return {
        status: outcome.scopeComplete ? "absent-in-scope" : "could-not-determine",
        evidence: [],
        reason: outcome.scopeComplete
          ? `verified absent: no occurrence of ${termLabel} in scanned workspace files; scope complete`
          : `verified absent: no occurrence of ${termLabel} in scanned workspace files; ${outcome.omittedCount} ${outcome.omittedCount === 1 ? "path" : "paths"} excluded from the scan`,
        candidatePaths: [],
        absentTerm: termLabel,
        scopeComplete: outcome.scopeComplete,
        omittedCount: outcome.omittedCount,
      };
    case "served-unconcentrated":
      return {
        status: outcome.scopeComplete ? "absent-in-scope" : "could-not-determine",
        evidence: [],
        reason: `every already-served candidate for ${termLabel} shows only an incidental, unconcentrated mention — treated as verified absent, not covered`,
        candidatePaths: [],
        absentTerm: termLabel,
        scopeComplete: outcome.scopeComplete,
        omittedCount: outcome.omittedCount,
        incidental: true,
      };
    case "unserved-candidates":
      return {
        status: "open",
        evidence: [],
        reason: `literal-find candidate(s) not yet served for ${termLabel}`,
        candidatePaths: [...outcome.candidatePaths],
        };
    case "indeterminate":
    default:
      return { status: "could-not-determine", evidence: [], reason: outcome.reason, candidatePaths: [], undeterminedTerm: termLabel };
  }
}

/**
 * `ConcernVerdict` -> the pre-existing `RequestItemProof` shape, which
 * conflates status into `proved` + `absentTerm`. Kept as ONE adapter so the
 * mapping (and therefore `requestItemTraceStatus`'s inverse of it) is written
 * down once: a concern is `proved` when it is covered OR when its status is a
 * verified, disclosable absence; `open` and an indeterminate/unnormalisable
 * outcome are both `proved: false` — the latter with no candidate, which is
 * how "could not determine" has always reached the wire from here.
 */
export function requestItemProofFromVerdict(verdict: ConcernVerdict): RequestItemProof {
  const proved = verdict.status === "covered" || verdict.absentTerm !== undefined;
  return {
    proved,
    evidence: verdict.evidence,
    reason: verdict.reason,
    candidatePaths: verdict.candidatePaths,
    ...(verdict.absentTerm !== undefined
      ? {
          absentTerm: verdict.absentTerm,
          absentScopeComplete: verdict.scopeComplete ?? false,
          absentOmittedCount: verdict.omittedCount ?? 0,
          ...(verdict.incidental === true ? { absentIncidental: true } : {}),
        }
      : {}),
    // R-D2 (item B): carried independently of the `absentTerm` branch above —
    // `ConcernVerdict`'s own doc comment guarantees the two never both be set.
    ...(verdict.undeterminedTerm !== undefined ? { undeterminedTerm: verdict.undeterminedTerm } : {}),
  };
}

/**
 * Proof for an unbindable item (a `topic` point, or any other kind whose own
 * structural resolution found no candidate at all): design §4.2's absence
 * path. Reuses the shared walk (`enumerateFindTextUniverse`/`scanLiteral`)
 * for exactly ONE literal find over the point's salient words — never a
 * fabricated frontier, and a zero-candidate result is treated as verified
 * absence (limited closure) rather than an unresolvable block.
 *
 * `universe` is the caller's choice of scan universe — every caller in this
 * file now passes the widened, find-consistent one (`ensureAbsenceUniverse`)
 * so this function's own "no workspace occurrence" claim cannot disagree
 * with what `tl_search_files find` would report for the same term (review
 * finding 2(b)); `universe.omissions` (after that widening) is also the
 * source for `absentScopeComplete`/`absentOmittedCount` below.
 */
export function proveUnbindableRequestItem(
  item: RequestItem,
  priorEvidence: readonly TaskPackSurface[],
  workspace: string,
  universe: FindTextUniverse,
  contentCache?: ScanContentCache,
  // H-2 (2026-09-19), rescoped by FIX-C2 (2026-09-21): this is ROUTING, not a
  // status rule. The concern's STATUS now comes from the one policy
  // (`decideConcernStatus`) for every caller alike; this flag only decides
  // whether THIS path may additionally turn "every candidate is served and
  // none of them concentrates the concern" into a scope-bound ABSENCE
  // (`served-unconcentrated`). Every pre-existing caller omits it and keeps
  // falling through to the pre-existing "candidates are served" close, so
  // no path that never minted an absence starts minting one.
  options?: {
    requireDistinctConcentration?: boolean;
    /**
     * R-B1 (2026-09-21, held item 1): the caller mints a BLOCKING obligation
     * from this proof (the mixed-kind loop, via `proveRequestItem`'s
     * fallbacks), so the "candidate only partly served" frontier below
     * applies to it exactly as it does to the independent-question route.
     * Without it, a passive-voice clause that `extractRequestItems` routed
     * through the mixed-kind branch fell to the "every literal-find
     * candidate is served" close and was certified off the ONE served line
     * of its module (confirmed: the `concernStatusPolicyMatrix` derived-name
     * cell, `src/sessionRenewal.ts:1-1`, `renewSessionToken` never served).
     * It never enables the served-unconcentrated ABSENCE, which stays
     * `requireDistinctConcentration`-only.
     */
    partialServeFrontier?: boolean;
  },
): RequestItemProof {
  // FIX-C2 (2026-09-21): the concern's topic terms and its coverage verdict
  // both come from the ONE policy above (`concernTopicTerms` /
  // `decideConcernStatus`). The two word-count floors this function used to
  // carry (`concentrationFloor` from the PRE-light-verb-filter count, and
  // the post-search `majorityFloor`) are gone: sized from a word count they
  // were simultaneously UNREACHABLE for a one-topic-word EN clause (Q05) and
  // TRIVIAL for a one-run JA clause (Q02). The policy asks WHERE the term
  // lives instead — see that section's header for the rule, the two
  // confirmed reproductions, and why the doc-role recall control that FIX-C's
  // `rawWordCount` sizing was protecting is now explicit rather than
  // emergent.
  const words = concernTopicTerms(item.text);
  if (words.length === 0) {
    return { proved: true, evidence: [], reason: "residual point has no salient searchable wording", candidatePaths: [] };
  }
  const mayCertifyUnconcentratedAbsence = options?.requireDistinctConcentration === true;
  // C2: ONE variant set per sampled word, computed once and reused by the
  // policy's coverage check and by the literal+variant scan below — never a
  // second, independently-tuned normalisation, and never re-derived per
  // surface.
  const wordVariants = concernVariantMap(words, workspace);
  const absenceProbe = concernAbsenceProbe(workspace, universe, wordVariants, contentCache);
  // Copilot retest r3 (2026-10-02, rule (c)): a head noun whose modifier occurs in
  // the workspace is never a disclosable absence — see `headRelatesPresentThings`.
  const relatesPresentThings = (word: string): boolean =>
    headRelatesPresentThings(word, item.text, (modifier) => !absenceProbe.provablyAbsent(modifier));
  const covered = concernCoveredByServedEvidence(item.text, words, wordVariants, priorEvidence, workspace, absenceProbe);
  if (covered.covered) {
    return { proved: true, evidence: covered.surfaces.map(readinessEvidence), reason: covered.reason, candidatePaths: [] };
  }
  if (covered.collisionAbsentTerm !== undefined) {
    // R-B3 (ruling 1): the concern's single anchor was blocked by a topic
    // term that occurs nowhere in the scanned scope, and no served surface
    // meets the two-term bar. That term is what the concern asks about and
    // the workspace does not have — disclosed as absent-in-scope now
    // (invariant (iii): a certification with a truthful disclosure, no
    // extra hop), never re-scanned into a candidate chase the anchor's own
    // file already answered.
    const { scopeComplete, omittedCount } = absenceProbe.scope();
    // WP-C2 (2026-09-29, eval-0929 §6/§8, rule 1): the collision rule's own
    // blocking-term selection (`concernCoveredByServedEvidence`, just above)
    // is UNCHANGED — a content predicate like "missing"/"replenished" still
    // correctly blocks a spurious single-anchor coverage claim (ruling 1's
    // own job: "how inventory is replenished" must not be certified covered
    // by an unrelated "inventory_files" mention). But that blocking term may
    // never ITSELF be the DISCLOSED literal-absence text unless it passes
    // rule 1's structural gate — measured leak: "under which conditions
    // widgetLimit ever gives up or is missing a value" certified
    // `request-item-absent:missing`, an ordinary participle, bypassing
    // `disclosableAbsenceTerm` entirely because this branch never consulted
    // it. When the term fails the gate, the honest outcome is indeterminate
    // (never a silent "covered" — that would resurrect the exact spurious-
    // coverage false positive this collision rule exists to prevent, and
    // never a certified absence of a term rule 1 forbids disclosing).
    //
    // WP-C3 (orchestrator RULING rule 2(b)): the blocking term is by
    // construction the clause's content PREDICATE ("is replenished"), and a
    // predicate is never certified absent — so this is the arm that keeps
    // that promise; the subject beside it demonstrably occurs (it is what
    // anchored), so there is no subject absence to certify either.
    if (!disclosableAbsenceTerm(covered.collisionAbsentTerm, item.text, item.facetSubject)) {
      return {
        ...requestItemProofFromVerdict(decideConcernStatus(words, covered, {
          kind: "indeterminate",
          reason: `${words.join("/")} is blocked from single-anchor coverage by ${covered.collisionAbsentTerm}, a predicate whose absence is never certified — not a verified absence`,
        })),
        undeterminedNonBlocking: true,
      };
    }
    return requestItemProofFromVerdict(decideConcernStatus([covered.collisionAbsentTerm], covered, {
      kind: "no-occurrence",
      scopeComplete,
      omittedCount,
      everyTermNormalized: true,
    }));
  }
  const matchedPaths = new Set<string>();
  // C4 (fix-c, 2026-09-21): accumulates across EVERY scanLiteral call this
  // function makes, so a file the walk enumerated but could not decode as
  // text is never silently invisible to the scope-completeness verdict
  // below — see `scopeCompletenessAfterScan`'s own doc comment.
  const coverage = createScanCoverage();
  // WP-S5 (B): a hit inside TokenLighten's OWN managed guide block is not a
  // candidate — see `managedGuideBlockSpan`'s section comment. Counted, never
  // silently dropped: the absence branch below must not read "no occurrence in
  // scanned workspace files" when the word demonstrably occurs, so a
  // guide-only match falls through to its own non-absence outcome.
  const guideExcluded = identifierGroundingEnabled();
  let guideOnlyMatch = false;
  const addMatch = (matchPath: string, line: number | undefined): void => {
    if (guideExcluded && matchIsManagedGuideText(workspace, matchPath, line)) {
      guideOnlyMatch = true;
      return;
    }
    matchedPaths.add(matchPath);
  };
  for (const word of words.slice(0, 4)) {
    // WP-N (eval-0929 §8): a CODE-SHAPED topic word is an explicit identifier
    // the request spelled, and a line holding it only inside a longer
    // identifier (`X_V2`, `APP_X`) is a near-miss — never a candidate. It was
    // one: the point's `next` read two docs that only say `X_V2`, and the
    // "every literal-find candidate is served" close then certified the point
    // off them. A concept word keeps the substring candidate scan unchanged
    // (its segment matches are deliberate: `replenish` in
    // `replenishInventory`), and so does every word's variant/path-name scan.
    const explicitIdentifier = isCodeShapedTerm(word);
    const lineCache = explicitIdentifier ? new FileReadCache() : undefined;
    for (const match of scanRequestItemLiteral(word, workspace, { files: universe.files, caseInsensitive: true, coverage, ...(contentCache ? { contentCache } : {}) })) {
      if (explicitIdentifier && !hitLineHoldsWholeIdentifier(workspace, match, word, lineCache)) continue;
      addMatch(match.path, match.line);
    }
  }
  // D2 (fix-c, 2026-09-21): a literal hit confined to DOC-classified paths
  // (a README that narrates a concern's name next to its file path) is not
  // a real candidate in the sense this veto cares about — see
  // `nonDocNoiseCandidatePaths`'s own doc comment just below this function
  // for the confirmed live repro (four-concern fixture: the exact-match
  // pass found ONLY README.md for "authentication", and under the OLD
  // "widen only when literally nothing matched" rule this never even tried
  // the inflected "authenticate" that would have found the real `auth.ts` —
  // a doc-role mention silently outranked the implementing code surface by
  // never letting it compete at all). Widen with C2's normalised variants
  // (English inflection, or the SAME workspace-vocabulary-gated JA bridge
  // retrieval uses) whenever every literal match so far is doc-role —
  // including the zero-match case (trivially "every match is doc" over an
  // empty set) — never only on an exact zero count.
  const hasNonDocLiteralMatch = [...matchedPaths].some((p) => classifySurface(p) !== "doc");
  // Ruling C1: whether EVERY sampled word had a confirmed normalisation to
  // search against — false only for a Japanese word the bridge could not
  // expand (disabled, or not in the workspace vocabulary), which this scan
  // could then only ever check by its raw literal spelling against
  // (typically) an English-only codebase. That is not a meaningful check
  // either way, so it must end in "could not determine", never "absent".
  // R-B3 (ruling 3): that per-word verdict is now read at the no-occurrence
  // branch below (strong words only), so this scan no longer aggregates it.
  if (!hasNonDocLiteralMatch) {
    for (const word of words.slice(0, 4)) {
      const { variants } = wordVariants.get(word)!;
      // TL-03 (fix-c, 2026-09-21): a Japanese `word` can never be
      // re-verified against the matched line via `textHasWordVariant` —
      // that check is EN-only (salientWordMatch.ts's own module doc) and
      // would reject every bridged hit, silently reproducing TL-03's exact
      // defect one level down (a bridge lookup that "succeeds" in finding
      // the right file, then gets discarded by a verification step that
      // was never able to confirm it in the first place — observed live:
      // クーポン割引はどこで判定されますか bridged to "coupon"/"discount",
      // found `couponEngine.ts` via literal scan, then every hit was
      // rejected here and the clause fell through to "verified absent").
      // A bridged variant found literally IS the confirmation for a
      // Japanese word — there is no separate EN re-check to run.
      const isJapaneseWord = containsJapanese(word);
      for (const variant of variants) {
        if (variant === word.toLowerCase()) continue;
        for (const match of scanRequestItemLiteral(variant, workspace, { files: universe.files, caseInsensitive: true, coverage, ...(contentCache ? { contentCache } : {}) })) {
          if (isJapaneseWord || (match.text !== undefined && textHasWordVariant(match.text, word))) {
            addMatch(match.path, match.line);
          }
        }
      }
    }
  }
  // FIX-C2 (2026-09-21): a file whose own NAME carries the concern's term is
  // an occurrence too. `scanLiteral` only ever looks inside file CONTENT, so
  // a concern spelled only in a path ("how renewal works" against
  // `src/sessionRenewal.ts`, whose code spells it `renewSessionToken`)
  // reached the absence branch and shipped "no occurrence in scanned
  // workspace files; scope complete" beside the very file that answers it —
  // a false statement about the workspace, confirmed live on the matrix.
  // Added AFTER the content scan so it can only ever ADD a candidate, never
  // remove one, and bounded by the same candidate cap as the rest.
  const pathNameMatches = new Set<string>();
  if (matchedPaths.size <= MAX_REQUEST_ITEM_TOPIC_CANDIDATES) {
    for (const word of words.slice(0, 4)) {
      const { variants } = wordVariants.get(word)!;
      for (const file of universe.files) {
        if (matchedPaths.has(file.relPath)) continue;
        // The trailing EXTENSION is not part of the name: a point naming a
        // `.json` file must not turn every manifest in the repo into its
        // candidate (`requestItemCompletion.spec.ts`'s verified-absence case
        // regressed exactly that way).
        const nameWithoutExtension = file.relPath.replace(/\.[^./]+$/u, "");
        if (variants.some((variant) => textHasWordVariant(nameWithoutExtension, variant))) {
          pathNameMatches.add(file.relPath);
          addMatch(file.relPath, undefined);
        }
      }
    }
  }
  // R-B1 (2026-09-21): a candidate this process cannot read as text is not a
  // candidate a bounded call can ever serve. Found by its NAME (the content
  // scan skips an undecodable file and books it in `coverage.undecodable`),
  // it used to become the point's `next` target; reading it fails, the point
  // stays open, and the identical `next` came back every hop (confirmed live:
  // an eight-hop oscillation on a binary file named after the concern).
  // Removed from the candidate set, never silently: when it was the ONLY
  // candidate the status is "could not determine" — the workspace does name
  // the concern, so it is not absent, and nothing on the wire answers it.
  const unreadableCandidates = [...matchedPaths].filter((candidatePath) => currentFileLineCount(workspace, candidatePath) === undefined);
  for (const candidatePath of unreadableCandidates) {
    matchedPaths.delete(candidatePath);
    pathNameMatches.delete(candidatePath);
  }
  if (matchedPaths.size === 0 && unreadableCandidates.length > 0) {
    return requestItemProofFromVerdict(decideConcernStatus(words, covered, {
      kind: "indeterminate",
      reason: `the only candidate(s) for ${words.join("/")} could not be read as text (${unreadableCandidates.slice(0, 3).join(", ")}) — not a verified absence`,
    }));
  }
  if (matchedPaths.size === 0 && guideOnlyMatch) {
    // WP-S5 (B): every occurrence was TokenLighten's own injected instructions.
    // NOT an absence (the word does occur, so no `absentTerm` and no
    // verified-absent wording ships) and NOT a discoverable gap either: the
    // host already handed that exact text to the model, so no bounded call can
    // turn it into repository evidence. Closing the point here is what stops
    // the pack prescribing a re-pack of its own guide files.
    return {
      proved: true,
      evidence: [],
      reason: `the only workspace occurrences of ${words.join("/")} are inside TokenLighten's own managed guide block, which is not repository evidence`,
      candidatePaths: [],
    };
  }
  if (matchedPaths.size === 0) {
    // Ruling C1/C6 lives in the policy now: with no usable normalisation
    // (`TL_JA_QUERY_BRIDGE=0` for a Japanese term) a raw literal miss is
    // "could not determine", never a fabricated absence.
    //
    // R-B3 (ruling 3): a verified absence is certified off the item's STRONG
    // words only — an English word, or a Japanese term whose katakana
    // loanword has no counterpart (`ConcernTermVariants.hasNormalization`).
    // Nothing occurs anywhere, so every strong word IS provably absent, and
    // the disclosure names exactly those. A weak word (a kanji glossary term,
    // or a meta fragment such as 点すべて) is never claimed and never poisons
    // the strong ones; an item with no strong word at all is "could not
    // determine".
    const unionScope = scopeCompletenessAfterScan(universe, coverage);
    const strongWords = words.filter((word) => wordVariants.get(word)?.hasNormalization === true || quotedLiteralTerm(item, word));
    const candidateWords = strongWords.length > 0 ? strongWords : words;
    // R2-T2 (2026-09-30, orchestrator RULING): a katakana loanword neither the
    // workspace bridge nor the glossary can spell in English
    // (`ConcernTermVariants.unmappedKatakana`) is never certified absent — the
    // workspace would spell the concept in English, so its literal miss proves
    // nothing. With no strong word beside it the point is disclosed
    // undetermined, NON-blocking like rule 1's arms below: nothing occurs
    // anywhere, so there is no candidate a later call could fetch for it.
    const unmappedKatakanaWords = words.filter((word) => wordVariants.get(word)?.unmappedKatakana === true && !quotedLiteralTerm(item, word));
    if (strongWords.length === 0 && unmappedKatakanaWords.length > 0) {
      // Named by its subject noun phrase (descriptor の-segments removed, rule
      // 1(d): 「クォーブレックスの仕組み」 → 「クォーブレックス」).
      const subjects = [...new Set(unmappedKatakanaWords.map((word) => jaTopicNounPhrase(word) ?? word))];
      return {
        ...requestItemProofFromVerdict(decideConcernStatus(subjects, covered, {
          kind: "indeterminate",
          reason: `${subjects.join("/")}: katakana term with no known English spelling to search — not a verified absence`,
        })),
        undeterminedNonBlocking: true,
      };
    }
    // WP-C2 (2026-09-29, eval-0929 §6/§8, rule 1): `disclosableAbsenceTerm`
    // — the structural eligibility gate — decides the DISCLOSED term now,
    // never `words`/`covered` above (which still sample and check the FULL,
    // unfiltered set — see `concernTopicTerms`'s own doc comment for the
    // coverage-check regression widening the shared pool caused and
    // reverted). Falls back to the ORIGINAL candidate set when every word
    // is ineligible — never silently expand what counts as absent, only
    // ever narrow it (same fallback shape WP-C's own list-based filter had).
    //
    // WP-C3 (orchestrator RULING): the gate admits the clause's subject noun
    // phrase again (never a descriptor or predicate). A Japanese phrase that
    // is only eligible once its descriptor の-segments are removed is
    // disclosed as that trimmed phrase, and — since the union scan above
    // looked for the whole run, not for the trimmed one — only after the
    // absence probe proves the trimmed phrase occurs nowhere either (its scans
    // join the scope qualifier). A weak item (no strong word) ends
    // could-not-determine below whatever the form, so it needs no proof.
    const disclosed = disclosableAbsenceForms(
      candidateWords,
      item.text,
      (term) => strongWords.length === 0 || absenceProbe.provablyAbsent(term),
      item.facetSubject,
      relatesPresentThings,
    );
    const disclosableWords = disclosed.terms;
    const probeScope = disclosed.anyTrimmed ? absenceProbe.scope() : undefined;
    const scopeComplete = unionScope.scopeComplete && (probeScope?.scopeComplete ?? true);
    const omittedCount = scopeComplete ? 0 : Math.max(unionScope.omittedCount, probeScope?.omittedCount ?? 0);
    if (disclosableWords.length === 0) {
      // WP-C2 (2026-09-29, eval-0929 §6/§8, rule 2): no word of this point is
      // literal-eligible — never `absent` (that would certify an ordinary
      // verb/adjective/common-noun clause as a verified "no occurrence"
      // claim, exactly the leak this fix closes), but never a SILENT close
      // either (common brief rule 10: an honest "unknown" must never become
      // a dead end with no trace at all — confirmed live:
      // concernRetentionMatrix.spec.ts's MATRIX-A2 "database migrations are
      // executed" sample, whose only topic words are ordinary content nouns
      // with no code shape/quote/existence-check, depends on SOME trace of
      // a genuinely absent concern surviving to the wire). `could-not-
      // determine`/undetermined — the existing vocabulary — disclosed with
      // the item's own (unfiltered) topic words: this point's real wording
      // was never checked by a scan that could safely disclose it as a
      // verified literal absence, which is the honest status, not a proof.
      return {
        ...requestItemProofFromVerdict(decideConcernStatus(words, covered, {
          kind: "indeterminate",
          reason: noDisclosableTermReason(words),
        })),
        undeterminedNonBlocking: true,
      };
    }
    return requestItemProofFromVerdict(decideConcernStatus(disclosableWords, covered, {
      kind: "no-occurrence",
      scopeComplete,
      omittedCount,
      everyTermNormalized: strongWords.length > 0,
    }));
  }
  if (matchedPaths.size > MAX_REQUEST_ITEM_TOPIC_CANDIDATES) {
    // Too ambiguous to batch; leave uncovered with no candidate — the
    // decision falls back to await-input once nothing else can progress,
    // rather than a fabricated/oversized frontier.
    return requestItemProofFromVerdict(decideConcernStatus(words, covered, {
      kind: "indeterminate",
      reason: `${matchedPaths.size} candidate files for ${words.join("/")} exceed the batch bound`,
    }));
  }
  const served = servedPathSet(priorEvidence);
  const missing = [...matchedPaths].filter((p) => !served.has(p));
  if (missing.length === 0) {
    const matchedServedSurfaces = [...matchedPaths].flatMap((p) => evidenceSurfacesForPath(priorEvidence, p));
    // Guard (fix-c, 2026-09-21, kept): a surface that is only PARTIALLY
    // served (non-empty `remaining_ranges`) was never actually checked for
    // concentration — the policy reads `servedSurfaceText`, which is a
    // FRAGMENT for such a surface (e.g. one symbol's body), not the whole
    // candidate file `matchedPaths`' own literal/inflection scan matched
    // against. A concentration miss against that fragment proves nothing
    // about the unserved remainder (confirmed live: a query word literally
    // present only in the file's header comment or a sibling function
    // neither one of THIS pack's served ranges covers) — declaring absence
    // there would be exactly the self-contradiction ruling C1 exists to
    // prevent, just one level removed (served-path-but-not-really-served-
    // content). Only declare absent when every matched, served candidate is
    // FULLY served; otherwise fall through to the pre-existing "candidates
    // are served" close.
    //
    // FIX-C2 (2026-09-21): judged per PATH over the UNION of that path's
    // served spans, not per SURFACE. A path is routinely represented twice in
    // `priorEvidence` — this pack's own (partial) surface plus the
    // epoch-served view's reconstruction of the whole served ledger for it —
    // and the old per-surface `.every()` let the partial half veto a file the
    // caller demonstrably holds in full, so a genuinely absent concern could
    // never be disclosed once its only candidate had been zoomed into in two
    // hops (confirmed live on the JA two-concern acceptance chain).
    //
    // R-B1 (2026-09-21, held item 2): ONLY the union test. The shortcut that
    // stood in front of it — "some surface for this path has no
    // `remaining_ranges`" — read a surface's OWN claimed range arriving
    // untrimmed as "the file is served whole". A narrow caller/symbol range
    // has no remainder of its own, and neither does a served-view
    // reconstruction (`reconstructServedEntryEvidence` never sets the field),
    // so a four-line slice of a 419-line file passed as fully served and the
    // concern whose function sat below it was certified ABSENT as "only an
    // incidental mention" (confirmed live, both on the first pack and on the
    // bare-`{qref}` re-pack). A whole small file served through an explicit
    // full-length range still passes: its union covers every line.
    const candidateFullyServed = (candidatePath: string): boolean => pathServedWholeFile(priorEvidence, candidatePath, workspace);
    const fullyServedCandidates = [...matchedPaths].every(candidateFullyServed);
    if ((mayCertifyUnconcentratedAbsence || options?.partialServeFrontier === true) && !fullyServedCandidates) {
      // FIX-C2 (2026-09-21), plan §5: `covered` may not be granted because
      // "the same file was found" — it must bind to the BODY that answers the
      // point. The policy already said this concern is NOT covered by what is
      // on the wire, and its candidate is only PARTLY served, so the honest
      // status is OPEN with the unserved remainder as the frontier — not a
      // silent "every candidate is served" close. Confirmed live on the
      // matrix: a one-topic-word concern certified itself covered from a
      // single served interface line of its own module while the function
      // that answers it was never delivered. Scoped to the blocking
      // (independent-question) route exactly like the absence branch below,
      // so no path that never blocked starts blocking.
      const rangeCandidates: Array<{ path: string; range: string }> = [];
      const unservedPaths: string[] = [];
      for (const candidatePath of matchedPaths) {
        if (candidateFullyServed(candidatePath)) continue;
        const surfacesForPath = evidenceSurfacesForPath(priorEvidence, candidatePath);
        const totalLines = currentFileLineCount(workspace, candidatePath);
        if (surfacesForPath.length === 0 || totalLines === undefined) {
          unservedPaths.push(candidatePath);
          continue;
        }
        const missingPieces = subtractLineSpans({ start: 1, end: totalLines }, servedLineSpansOf(surfacesForPath));
        if (missingPieces.length === 0) continue;
        // R-B1 (review B2): address the point's own wording inside the
        // UNSERVED part when it occurs there, instead of the hull of every
        // missing piece (confirmed live: a 413-line hull of filler around a
        // ten-line function — three hops and ~27 KB to reach it). Only when
        // no position is known does the whole remainder stay the target.
        const window = concernWindowInUnservedPart(workspace, candidatePath, missingPieces, wordVariants);
        rangeCandidates.push({
          path: candidatePath,
          range: window !== undefined
            ? `${window.start}-${window.end}`
            : `${missingPieces[0]!.start}-${missingPieces[missingPieces.length - 1]!.end}`,
        });
      }
      if (rangeCandidates.length > 0 || unservedPaths.length > 0) {
        return {
          proved: false,
          evidence: [],
          reason: `the candidate(s) for ${words.join("/")} are only partly served; the body that would answer this point is not on the wire yet`,
          candidatePaths: unservedPaths,
          rangeCandidates,
        };
      }
    }
    // A candidate found by its FILE NAME is a real, checkable occurrence of
    // the concern's wording — the concentration test simply does not apply to
    // it (there is no "mention" in the content to be incidental). Certifying
    // absence over it would state "no occurrence in scanned workspace files"
    // about a workspace that demonstrably names the concern, which ruling C1
    // forbids; the honest close is the pre-existing "every candidate for this
    // point is served".
    const anyPathNameCandidate = [...matchedPaths].some((candidatePath) => pathNameMatches.has(candidatePath));
    // WP-C2 (2026-09-29, eval-0929 §6/§8, rule 1): the disclosed term is
    // restricted to `words`' own literal-eligible subset (same gate as the
    // no-occurrence branch above) — an item whose every topic word is
    // ordinary descriptive prose never had a literal claim to disclose in
    // the first place. When nothing survives, this falls through to the
    // pre-existing "every candidate is served" close just below — which,
    // unlike the no-occurrence branch's own zero-eligible-words fallback,
    // already carries REAL served evidence (`matchedServedSurfaces`), so it
    // is a safe, evidence-backed closure rather than a silent one.
    //
    // WP-C3 (orchestrator RULING rule 4 — a non-eligible point is never
    // silently dropped): that fall-through was NOT safe here. The policy just
    // judged this concern NOT covered by those very surfaces (they only
    // mention it in passing — a README narrating a module that is not in the
    // checkout), so closing it as "every candidate is served" certified a
    // genuinely absent concern with nothing on the wire naming it —
    // concernStatusPolicyMatrix.spec.ts's readme-only cell ("…how session
    // tokens are renewed?" certified `act.answer` with `disclosures=[]`).
    // With the subject noun phrase eligible again ("session tokens") this
    // branch discloses it as the incidental absence it was before WP-C2; a
    // point with NO eligible word (only predicates/descriptors) is disclosed
    // as undetermined, non-blocking — never proved by bytes the policy
    // already rejected.
    const disclosableUnconcentratedWords = words.filter((word) => disclosableAbsenceTerm(word, item.text, item.facetSubject, relatesPresentThings));
    if (mayCertifyUnconcentratedAbsence && fullyServedCandidates && !anyPathNameCandidate && disclosableUnconcentratedWords.length === 0) {
      return {
        ...requestItemProofFromVerdict(decideConcernStatus(words, covered, {
          kind: "indeterminate",
          reason: `served candidates mention ${words.join("/")} only in passing, and no subject term's absence could be certified — not a verified absence`,
        })),
        undeterminedNonBlocking: true,
      };
    }
    if (mayCertifyUnconcentratedAbsence && fullyServedCandidates && !anyPathNameCandidate && disclosableUnconcentratedWords.length > 0) {
      // The policy already said this concern is NOT covered, and every
      // candidate the scan found is fully served — so the mention that made
      // it a candidate is incidental (D1's confirmed shape: a comment that
      // only names "migration" while explicitly disclaiming the concept).
      const { scopeComplete, omittedCount } = scopeCompletenessAfterScan(universe, coverage);
      return requestItemProofFromVerdict(decideConcernStatus(disclosableUnconcentratedWords, covered, {
        kind: "served-unconcentrated",
        scopeComplete,
        omittedCount,
      }));
    }
    const evidence = matchedServedSurfaces.map(readinessEvidence);
    return { proved: true, evidence, reason: "every literal-find candidate for this point is served", candidatePaths: [] };
  }
  return requestItemProofFromVerdict(decideConcernStatus(words, covered, { kind: "unserved-candidates", candidatePaths: missing }));
}

export function proveRequestItem(
  item: RequestItem,
  allItems: readonly RequestItem[],
  priorEvidence: readonly TaskPackSurface[],
  workspace: string,
  universe: FindTextUniverse,
  /**
   * Review finding 2(b) fix (2026-09-08): the find-consistent, WIDENED
   * universe (`ensureAbsenceUniverse`) — passed through to every
   * `proveUnbindableRequestItem` fallback below instead of the narrower
   * `universe` above, which this function's own candidate-resolution calls
   * (`declarationCandidatePaths`/`fileTermCandidatePaths`/
   * `relationConsumerCandidatePaths`) keep using unchanged. Kept as a
   * SEPARATE parameter rather than widening `universe` itself: candidate
   * resolution for a structured `decision`/`definition`/`relation` item must
   * stay scoped to real code/tracked-doc candidates, never a generic-text
   * file pulled in only for the absence fallback's sake.
   */
  absenceUniverse: FindTextUniverse,
  contentCache?: ScanContentCache,
  /**
   * OWNERSHIP RULE (2026-09-07, R1 x F-V13-6/F-V14 reconciliation).
   *
   * Lowercased facets the query's OWN enumerated-item obligation
   * (`enumeratedQueryItemsForEpoch`, minted independently in
   * `buildReadinessObligations`) already tracks for this same query. When
   * an item's salient wording overlaps one of them, this item is the SAME
   * plain-prose checklist point the enumerated-item mechanism already
   * mints its own `enumerated-item:<hash>:<facet>` obligation for — most
   * visibly the checklist's own LEADING item, which a stray keyword
   * collision can misclassify as a structured `definition`/`decision`
   * point with no real term (observed: "explain what the settings panel
   * does with clipboard, autosave, telemetry and shortcuts" — "settings"
   * inside "settings panel" trips `DEFINITION_KEYWORDS_RE` even though the
   * segment names no actual config key, so it fell to
   * `manifestCandidatePaths`' "any manifest in the repo" fallback and
   * manufactured a `tl_read_file package.json` obligation the request never
   * asked about — package.json was never going to answer "does it handle
   * clipboard"). Two independent obligations about the identical fact must
   * not disagree (the same principle `buildRequestItemReadiness`'s own
   * "reconciled from request-item" comment below already applies to a
   * `decision`/`identifier:` pair), and mining a second, differently-proved
   * obligation over a fact `enumeratedQueryItemsForEpoch` already covers is
   * double-counting, not extra rigor — precisely what that mechanism's own
   * "ANYTHING THE EXISTING ROUTES ALREADY OWN IS DROPPED" rule already does
   * in the other direction (an identifier/behavior-body-shaped item is
   * dropped from ITS candidate set). Deferring is safe because both
   * mechanisms converge on the SAME conservative "served body mentions it /
   * verifiably absent" standard for anything this unstructured — R1 is not
   * skipping a check, it is not re-running one the wire already reports
   * under `enumerated-item:*`, which keeps its own `tl_search_files` bounded
   * follow-up as the pack's ONE next call instead of racing R1's batched
   * `tl_read_file` for an unrelated fallback target. A well-grounded item
   * (real file/identifier/relation candidates) is unaffected in every other
   * query — `ownedFacets` is empty whenever `enumeratedQueryItemsForEpoch`
   * found nothing (the overwhelming majority of requests), so this check is
   * inert there.
   */
  ownedFacets: ReadonlySet<string> = new Set(),
): RequestItemProof {
  if (ownedFacets.size > 0 && salientWords(item.text).some((word) => ownedFacets.has(word.toLowerCase()))) {
    return {
      proved: true,
      evidence: [],
      reason: "this point's salient wording is already tracked by the query's own enumerated-item obligation (F-V13-6/F-V14); not duplicated as a separate request-item obligation",
      candidatePaths: [],
    };
  }
  const served = servedPathSet(priorEvidence);

  if (item.kind === "decision" && item.terms.length > 0) {
    const identifier = item.terms[0]!;
    const candidates = declarationCandidatePaths(workspace, universe, identifier, contentCache);
    if (candidates.length === 0) return proveUnbindableRequestItem(item, priorEvidence, workspace, absenceUniverse, contentCache, { partialServeFrontier: true });
    const missing = candidates.filter((p) => !served.has(p));
    if (missing.length > 0) {
      return { proved: false, evidence: [], reason: `decision identifier ${identifier} has ${missing.length} unserved candidate definition site(s)`, candidatePaths: missing };
    }
    // DESIGN-v0.15 §4.2 false-completion fix (2026-09-07, P1) + the P1
    // RULING that replaced its lexical half: a served PATH is not proof by
    // itself — the window backing this point must actually be on the wire
    // (never a partial-prefix read, e.g. `range:"1-20"` of a 35-line
    // function whose real decision sits in its last lines). What "the
    // window" IS depends on what the AST could establish, and NOTHING else
    // is allowed to answer that question (see `declarationRangeInFile`):
    //
    // - `ast`: the identifier's own resolved declaration span must be fully
    //   covered by the union of served windows for that path.
    // - `unresolved`: the declaration range is UNCONFIRMED (no grammar, no
    //   parse, past the pre-pass bound, ...). The candidate is proved only
    //   when the served windows cover the WHOLE current file, which bounds
    //   ANY declaration range in it without trusting a heuristic. This is
    //   the third reported P1's own shape: nine same-named candidates, the
    //   ninth a `.gradle` file outside tree-sitter's analysis, whose range
    //   a hand-written lexer got wrong by 32 lines.
    //
    // Either way the follow-up asks for exactly the UNSERVED lines
    // (`rangeCandidates`), never a whole-file re-read and never
    // `{path,symbol}` — symbol resolution on a non-AST file falls back to
    // the same class of heuristics this ruling removed from the proof path,
    // and for an already-bounded candidate a symbol-addressed target for a
    // path this task already touched was verified empirically to resolve
    // back to the EXISTING served range instead of the symbol's own bounds.
    const uncovered: string[] = [];
    const unresolvedUncovered: string[] = [];
    const unreadable: string[] = [];
    const rangeCandidates: Array<{ path: string; range: string }> = [];
    const evidence: TaskReadinessEvidence[] = [];
    for (const candidate of candidates) {
      const surfacesForCandidate = evidenceSurfacesForPath(priorEvidence, candidate);
      const servedSpans = servedLineSpansOf(surfacesForCandidate);
      const resolution = declarationRangeInFile(workspace, candidate, identifier);
      let required: LineSpan;
      if (resolution.source === "ast") {
        required = resolution.span;
      } else {
        const totalLines = currentFileLineCount(workspace, candidate);
        if (totalLines === undefined) {
          // Unreadable/undecodable: nothing to bound and nothing to slice —
          // fail closed and ask for the path itself rather than invent a
          // range for a file this process cannot read.
          uncovered.push(candidate);
          unreadable.push(candidate);
          continue;
        }
        required = { start: 1, end: totalLines };
      }
      if (lineSpansCover(servedSpans, required)) {
        evidence.push(...surfacesForCandidate.map(readinessEvidence));
        continue;
      }
      uncovered.push(candidate);
      if (resolution.source === "unresolved") unresolvedUncovered.push(candidate);
      const missingPieces = subtractLineSpans(required, servedSpans);
      const hull = missingPieces.length > 0
        ? { start: missingPieces[0]!.start, end: missingPieces[missingPieces.length - 1]!.end }
        : required;
      rangeCandidates.push({ path: candidate, range: `${hull.start}-${hull.end}` });
    }
    if (uncovered.length > 0) {
      const baseReason = `decision identifier ${identifier} is served at the path level but its declaration body is not fully covered by a served window in ${uncovered.join(", ")}`;
      return {
        proved: false,
        evidence: [],
        // Design §4.2 ("対象外・解析未対応・意味の曖昧さは未確認として明示
        // する"): an AST-unresolved candidate says so, in the obligation's
        // own reason, instead of quietly demanding a range some heuristic
        // made up.
        reason: unresolvedUncovered.length > 0
          ? `${baseReason}; ${unresolvedUncovered.join(", ")} is outside AST analysis, so its declaration range is UNCONFIRMED and only whole-file coverage at the current revision can prove it`
          : baseReason,
        candidatePaths: unreadable,
        rangeCandidates,
      };
    }
    return { proved: true, evidence, reason: `decision identifier ${identifier} is served from every candidate definition site`, candidatePaths: [] };
  }

  if (item.kind === "definition") {
    const fileTerm = item.terms.find(looksLikeFileTerm);
    if (fileTerm === undefined && allItems.some((other) => configurationFileQuestion(other.text))) {
      const names = [...new Set(allItems.flatMap((other) => [...other.terms, ...other.aliases]))];
      const fileCache = new FileReadCache();
      const connected = [...new Set(priorEvidence.map((surface) => surface.path))]
        .filter((candidate) => !isTestConcernPath(candidate))
        .flatMap((candidate) => {
          const content = readCached(workspace, candidate, fileCache);
          if (content === undefined) return [];
          const span = configurationEvidenceSpan(content.split(/\r?\n/), candidate, names);
          return span === undefined ? [] : [{ path: candidate, ...span }];
        });
      if (connected.length > 0) {
        const missing = connected.flatMap((span) => subtractLineSpans(span,
          servedLineSpansOf(evidenceSurfacesForPath(priorEvidence, span.path)))
          .map((piece) => ({ path: span.path, range: `${piece.start}-${piece.end}` })));
        const evidence = connected.flatMap((span) => evidenceSurfacesForPath(priorEvidence, span.path)).map(readinessEvidence);
        return missing.length > 0
          ? { proved: false, evidence, reason: "configuration reader, defaults and path implementation are not fully served", candidatePaths: [], rangeCandidates: missing }
          : { proved: true, evidence, reason: "the connected configuration reader, defaults and path implementation is served", candidatePaths: [] };
      }
    }
    const candidates = fileTerm !== undefined
      ? fileTermCandidatePaths(workspace, universe, fileTerm)
      : manifestCandidatePaths(workspace);
    if (candidates.length === 0) return proveUnbindableRequestItem(item, priorEvidence, workspace, absenceUniverse, contentCache, { partialServeFrontier: true });
    const missing = candidates.filter((p) => !served.has(p));
    if (missing.length > 0) {
      return { proved: false, evidence: [], reason: `definition candidate(s) not yet served: ${missing.join(", ")}`, candidatePaths: missing };
    }
    // Every candidate is served — design §4.2: a served file is not proof by
    // itself. Finding 2 fix: require a genuine KEY/IDENTIFIER TOKEN (a JSON
    // object key, a declared identifier) relating to a term/alias named
    // anywhere in this same request — never a raw substring hunt over the
    // whole body (that credited an unrelated description sentence).
    const relatedTerms = [...new Set(allItems.flatMap((other) => [...other.terms, ...other.aliases]))];
    const servedBodies = candidates.flatMap((p) => evidenceSurfacesForPath(priorEvidence, p));
    const matched = servedBodies.some((surface) => {
      const keyTokens = definitionKeyTokensOf(surface.path, servedSurfaceText(surface));
      return keyTokens.some((key) => relatedTerms.some((term) => sharesSignificantSubstring(term, key, 8)));
    });
    if (matched) {
      return { proved: true, evidence: servedBodies.map(readinessEvidence), reason: "a served definition candidate contains a key/identifier related to the request", candidatePaths: [] };
    }
    // Mirror of the relation arm's finding-3 closure (2026-09-07), narrowed to
    // a definition item that NAMES a concrete key (a dotted key, quoted string
    // or identifier — never just a file such as package.json): every candidate
    // is served in FULL and none declares that key, so the scope-bound verified
    // absence ("<key> is not defined in the served manifests/files") closes the
    // point with a `request-item-absent` disclosure naming the key (design §3.3
    // progress invariant, §4.2 限定結論). A file-only or term-less definition
    // item keeps the `proved:false` path below on purpose: the absent KEY is
    // then named by the epoch contract / identifier obligations derived from
    // the served bodies, which the negative language-setting cases rely on.
    // Partial/truncated serves never qualify: an unseen remainder could hold it.
    const namedKey = item.terms.find((term) => !looksLikeFileTerm(term));
    if (namedKey !== undefined && servedBodies.length > 0 && servedBodies.every((surface) => isWholeAuthoritySurface(surface, workspace))) {
      return {
        proved: true,
        evidence: servedBodies.map(readinessEvidence),
        reason: `every definition candidate is served in full and none declares ${namedKey}`,
        candidatePaths: [],
        absentTerm: namedKey,
        // Review finding 2(b) fix: this absence's own scope IS "every
        // candidate definition file", and every one of them was just proved
        // served IN FULL two lines above — nothing was excluded from what
        // this specific claim is about, so scope-complete is unconditionally
        // true here (unlike proveUnbindableRequestItem's workspace-wide scan,
        // which depends on the walk's own omissions).
        absentScopeComplete: true,
        absentOmittedCount: 0,
      };
    }
    // 2026-11-02 (external evaluation T2): the item names a FILE and the
    // request ADDS a new name ("document it in docs/config.rst" beside "add a
    // SESSION_COOKIE_SALT config key"): the served named file is where the
    // new name goes, and nothing in it can relate to a name that does not
    // exist yet. A documentation page has no declared identifier for the
    // key-token test above to find either.
    if (fileTerm !== undefined && servedBodies.length > 0) {
      const requestText = allItems.map((other) => other.text).join("\n");
      const added = familyMemberCandidates(requestText).find((name) =>
        requestIntroducesName(requestText, name)
        && !servedBodies.some((surface) => servedSurfaceText(surface).includes(name)));
      if (added !== undefined) {
        return { proved: true, evidence: servedBodies.map(readinessEvidence), reason: `${fileTerm} is served; ${added} is the name to add there`, candidatePaths: [] };
      }
    }
    return { proved: false, evidence: servedBodies.map(readinessEvidence), reason: "every definition candidate is served but none contains a related key/identifier", candidatePaths: [] };
  }

  if (item.kind === "relation" && item.relation !== undefined && item.relation.to.length > 0) {
    const relation = item.relation;
    const candidates = relationConsumerCandidatePaths(workspace, universe, item, relation.to);
    if (candidates.length === 0) return proveUnbindableRequestItem(item, priorEvidence, workspace, absenceUniverse, contentCache, { partialServeFrontier: true });
    const missing = candidates.filter((p) => !served.has(p));
    if (missing.length > 0) {
      return { proved: false, evidence: [], reason: `relation consumer candidate(s) not yet served: ${missing.join(", ")}`, candidatePaths: missing };
    }
    const servedBodies = candidates.flatMap((p) => evidenceSurfacesForPath(priorEvidence, p));
    const fromTerms = relation.from.length > 0 ? relation.from : item.terms;
    // Finding 2 fix: a producer term is evidence of the relation only at a
    // non-comment, non-string, call/import-shaped position — never a bare
    // mention (a comment, a TODO, a string, two definitions served side by
    // side).
    const matched = servedBodies.some((surface) => {
      const text = servedSurfaceText(surface);
      const language = languageForPath(surface.path);
      return fromTerms.some((term) => isCallOrImportOccurrence(text, term, language));
    });
    if (matched) {
      return { proved: true, evidence: servedBodies.map(readinessEvidence), reason: "a served consumer window contains the producer term at a call/import site", candidatePaths: [] };
    }
    // Finding 3 fix (2026-09-07): every consumer candidate is served AND
    // fully served (whole-file authority, not a partial/truncated slice) —
    // there is nothing further to fetch for THIS relation. Design §4.2 does
    // allow a scope-bound verified absence ("定義がない"等の限定結論) — here
    // the limited conclusion is narrowly "this consumer's fully-read body
    // does not call/import the producer", never a claim about the producer's
    // existence or behavior elsewhere. Closing this way is what lets the
    // pack make honest progress instead of leaving an uncovered point with
    // no further candidate (design §3.3's progress invariant) — the
    // alternative is a dead end: no candidate left to fetch, so no
    // request_item_gap gets minted, and the pack falls through to whatever
    // OTHER obligation the generic dispatch finds next.
    if (servedBodies.length > 0 && servedBodies.every((surface) => isWholeAuthoritySurface(surface, workspace))) {
      return {
        proved: true,
        evidence: servedBodies.map(readinessEvidence),
        reason: "every relation consumer candidate is served in full and none calls/imports the producer term",
        candidatePaths: [],
        absentTerm: fromTerms[0] ?? item.text,
        // Review finding 2(b) fix: same reasoning as the definition arm
        // above — this claim's own scope is "every consumer candidate",
        // every one just proved served IN FULL, so scope-complete for THIS
        // narrower claim is unconditionally true.
        absentScopeComplete: true,
        absentOmittedCount: 0,
      };
    }
    return { proved: false, evidence: servedBodies.map(readinessEvidence), reason: "every relation consumer candidate is served but none contains the producer term", candidatePaths: [] };
  }

  return proveUnbindableRequestItem(item, priorEvidence, workspace, absenceUniverse, contentCache, { partialServeFrontier: true });
}
