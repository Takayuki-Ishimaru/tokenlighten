// requestItemAbsence — extracted implementation; imports point to the owning modules.
import type { RequestItem } from "../requestItems.js";
import type { RequestItemProof } from "./recursiveClosure5.js";
import type { TaskPackSurface } from "../model.js";
import type { TaskReadinessEvidence } from "@tokenlighten/types";
import type { TaskReadinessObligation } from "@tokenlighten/types";
import { capWords } from "./requestItemAbsence2.js";
import { concernCoveredByServedEvidence } from "./concernProof.js";
import { concernTopicTerms } from "./sourceAndConcernTerms3.js";
import { concernVariantMap } from "./sourceAndConcernTerms3.js";
import { docAnchorsEligible } from "./sourceAndConcernTerms3.js";
import { hasServedCode } from "./wiringEvidence2.js";
import { isTraceEnabled } from "../../../util/trace.js";
import { japaneseClauseUnverifiableBesideServedSubject } from "./requestItemAbsence.js";
import { readinessEvidence } from "./changeAndReadinessEvidence2.js";
import { requestIntroducesName } from "../familyMemberSeeds.js";
import { salientWords } from "../requestItems.js";
import { surfaceFileSha } from "./packState2.js";
import { textHasWordVariant } from "../salientWordMatch.js";
import { trace } from "../../../util/trace.js";

export function absenceContradictsServedEvidence(
  term: string,
  itemText: string,
  priorEvidence: readonly TaskPackSurface[],
  workspace: string,
): boolean {
  // FIX-C2: `absentTerm` is a "/"-joined word list from the topic-scan path,
  // but the structured `definition`/`relation` arms fall back to the item's
  // WHOLE CLAUSE (`fromTerms[0] ?? item.text`). A clause is not a searchable
  // term — `concernTermVariants` passes it through untouched, so the veto
  // could never match anything and a served implementation sat next to an
  // absence claim quoting the very clause it answers (confirmed live on the
  // matrix's derived-name column). Decompose any multi-word piece into the
  // same topic terms every other path uses; a genuine single distinctive
  // term (`p12d`'s "Redis") is left exactly as it is.
  const words = term
    .split("/")
    .map((w) => w.trim())
    .filter((w) => w.length > 0)
    .flatMap((w) => (/\s/u.test(w) ? concernTopicTerms(w) : [w]));
  if (words.length === 0) return false;
  const variantsByTerm = concernVariantMap(words, workspace);
  if (concernCoveredByServedEvidence(itemText, words, variantsByTerm, priorEvidence, workspace).covered) return true;
  // Only when EVERY word of the claim is such a clause: an absence that also
  // names a checkable term ("Redis" beside キャッシュ無効化の実装) is still true
  // about that term and must keep being disclosed.
  if (words.every((word) => japaneseClauseUnverifiableBesideServedSubject(word, itemText, priorEvidence, workspace))) return true;
  // Ruling C1 in its widest form: "absent" is certified only when NEITHER the
  // literal term NOR any of its normalised variants occurs in the searched
  // scope — and a served file whose own NAME carries the term IS such an
  // occurrence, whatever the coverage bar says about its bytes. Coverage and
  // absence answer different questions: `src/localeTag.ts` served but not
  // concentrated enough to COVER "how locale resolution is applied" still
  // makes "no occurrence in scanned workspace files; scope complete" a false
  // statement. This half of the veto only ever REMOVES an absence claim (the
  // concern stays uncovered and keeps its own routing), so it can never
  // manufacture a completion — it closes the derivational-morphology gaps
  // (resolution/resolve, renewal/renew) no variant generator reaches.
  return priorEvidence.some((surface) => {
    if (!hasServedCode(surface)) return false;
    if (!docAnchorsEligible(itemText, surface)) return false;
    const nameWithoutExtension = surface.path.replace(/\.[^./]+$/u, "");
    return words.some((word) => (variantsByTerm.get(word)?.variants ?? [word]).some((variant) => textHasWordVariant(nameWithoutExtension, variant)));
  });
}

/** `RequestItemProof` -> the plan §8.3 four-way status vocabulary, from fields every proof already sets. */
export function requestItemTraceStatus(proof: RequestItemProof): "covered" | "absent-in-scope" | "could-not-determine" | "open" {
  if (!proof.proved) {
    // R-D2 (item B): before `undeterminedTerm` existed, this branch could
    // not distinguish a genuinely open candidate from a could-not-determine
    // verdict (both were `proved:false` with no `absentTerm`) and always
    // reported "open" — see `requestItemProofFromVerdict`'s own comment on
    // how "could not determine" reached the wire (nowhere) before this fix.
    return proof.undeterminedTerm !== undefined ? "could-not-determine" : "open";
  }
  if (proof.absentTerm === undefined) return "covered";
  return proof.absentScopeComplete === true ? "absent-in-scope" : "could-not-determine";
}

/** Bounded `{path, range, sha}` refs for a proof's own evidence — never a body. Sha is a live disk read (cheap, single stat+hash per evidence row, and only under the trace gate). */
export function traceEvidenceRefs(workspace: string, evidence: readonly TaskReadinessEvidence[], cap = 4): Array<{ path: string; range?: string; sha?: string }> {
  return evidence.slice(0, cap).map((e) => ({
    path: e.path,
    ...(e.range ? { range: e.range } : {}),
    ...(surfaceFileSha(workspace, e.path) ? { sha: surfaceFileSha(workspace, e.path) } : {}),
  }));
}

/**
 * ONE record per request item per pack, at the exact point `buildRequest-
 * ItemReadiness`'s three status-minting sites (the H-2 independent-question
 * loop, the mixed-kind per-item loop, and the all-topic absence-only pass)
 * decide it. `terms` are `salientWords(item.text)` — the SAME base word set
 * every proof path samples from (before any per-proof light-verb/variant
 * filtering) — words only, never the query they came from.
 *
 * Takes a plain descriptor rather than a `RequestItemProof` directly: the
 * absence-only pass decides some items via `distinctiveSalientAbsence`
 * (a differently-shaped result, no `RequestItemProof` ever built for those),
 * so `traceRequestItemProof` below adapts the common `RequestItemProof`
 * shape into this same descriptor rather than this function knowing about
 * two call shapes.
 */
export function traceRequestItemStatus(
  workspace: string | undefined,
  item: RequestItem,
  info: {
    status: "covered" | "absent-in-scope" | "could-not-determine" | "open";
    evidence: readonly TaskReadinessEvidence[];
    reason: string;
    scopeComplete?: boolean;
  },
): void {
  if (!isTraceEnabled() || workspace === undefined) return;
  trace("request_item_status", {
    item_id: item.id,
    kind: item.kind,
    clause: item.text.slice(0, 80),
    status: info.status,
    evidence: traceEvidenceRefs(workspace, info.evidence),
    terms: salientWords(item.text).slice(0, 6),
    ...(info.scopeComplete !== undefined ? { scope_complete: info.scopeComplete } : {}),
    caps_hit: /exceed the batch bound/.test(info.reason),
    reason: capWords(info.reason, 12),
  }, workspace);
}

/** `traceRequestItemStatus` for the common `RequestItemProof` shape (the H-2 and mixed-kind per-item loops). */
/**
 * FIX-C2 (2026-09-21) — the `analysis-source` obligation's EVIDENCE LOOKUP,
 * routed through the same policy every request item uses.
 *
 * `buildReadinessObligations` mints `analysis-source` from this call's OWN
 * fresh surfaces only (`groundedAnalysisEvidence(result, query, served)`),
 * with no epoch carry-forward of any kind. Confirmed live on the JA
 * two-concern acceptance chain: hop 0 serves a slice and proposes a zoom,
 * hop 1 delivers it as a decision-less `read.text`, and hop 2's bare
 * `{qref}` re-pack then holds `analysis-source` uncovered forever — every
 * request-item concern is resolved, the caller holds the whole module, and
 * the pack still ends `await_input` naming only this obligation. A verbatim
 * follower loops there (the same class of stall FIX-D closed for request
 * items themselves).
 *
 * Reconciled IN PLACE, exactly like the `identifier:<X>` reconciliation in
 * the mixed-kind loop — the reviewed precedent for "two obligations about
 * the identical fact must not disagree", and for the same reason: this one
 * checks only fresh surfaces while the request-item engine already proved
 * the same fact from the sha-gated epoch-served view. STANDARD, deliberately
 * high: the concern must be covered by a CODE-POSITION anchor
 * (`codeAnchored` — the caller holds the implementation itself, not merely a
 * matching file name or that file's header comment) and no request item may
 * still be open. So this can only ever DISCHARGE an obligation the caller's
 * own held evidence already satisfies; it never grounds an analysis in a
 * file-name match, and it never un-proves anything.
 */
export function reconcileAnalysisSourceFromRequestItems(
  otherObligations: readonly TaskReadinessObligation[],
  items: readonly RequestItem[],
  anyItemOpen: boolean,
  priorEvidence: readonly TaskPackSurface[],
  workspace: string,
): void {
  if (anyItemOpen) return;
  const stale = otherObligations.find((obligation) => obligation.id === "analysis-source" && obligation.status !== "proved");
  if (stale === undefined) return;
  for (const item of items) {
    const terms = concernTopicTerms(item.text);
    if (terms.length === 0) continue;
    const coverage = concernCoveredByServedEvidence(item.text, terms, concernVariantMap(terms, workspace), priorEvidence, workspace);
    if (!coverage.covered || !coverage.codeAnchored) continue;
    stale.status = "proved";
    stale.evidence = coverage.surfaces.map(readinessEvidence).slice(0, 6);
    stale.reason = `analysis is grounded in evidence already served for request-item:${item.id} in this epoch`;
    return;
  }
}

export function traceRequestItemProof(workspace: string | undefined, item: RequestItem, proof: RequestItemProof): void {
  traceRequestItemStatus(workspace, item, {
    status: requestItemTraceStatus(proof),
    evidence: proof.evidence,
    reason: proof.reason,
    scopeComplete: proof.absentScopeComplete,
  });
}

/**
 * ONE record per pack when a re-pack's request-item proofs consulted
 * SAME-EPOCH evidence this call did not itself (re-)serve — i.e.
 * `priorEvidence` (`epochServedEvidence`) held a path outside this pack's
 * OWN fresh surfaces. Names which paths were reused and leaves the
 * per-item detail to `request_item_status` above; never a body, never the
 * full query.
 */
export function traceRequestItemEpochReuse(
  workspace: string | undefined,
  priorEvidence: readonly TaskPackSurface[],
  ownSurfaces: readonly TaskPackSurface[],
): void {
  if (!isTraceEnabled() || workspace === undefined) return;
  const ownPaths = new Set(ownSurfaces.map((s) => s.path));
  const reused = priorEvidence.filter((s) => hasServedCode(s) && !ownPaths.has(s.path));
  if (reused.length === 0) return;
  const seen = new Set<string>();
  const refs: Array<{ path: string; sha?: string }> = [];
  for (const surface of reused) {
    if (seen.has(surface.path) || refs.length >= 8) continue;
    seen.add(surface.path);
    const sha = surfaceFileSha(workspace, surface.path);
    refs.push({ path: surface.path, ...(sha ? { sha } : {}) });
  }
  trace("request_item_epoch_reuse", { reused_refs: refs }, workspace);
}

/**
 * 2026-11-02 (external evaluation T2): the absence of a name the item itself
 * asks to ADD ("add a SESSION_COOKIE_SALT config key", 「SESSION_COOKIE_SALT
 * 設定を追加」) is the expected starting state of the change, not missing
 * code. The entry keeps every absence field (the scan still happened) and
 * carries `create` so neither wire reader words it as `request-item-absent`.
 */
export function asCreateIfIntroduced<T extends { readonly term: string }>(item: RequestItem, entry: T): T & { create?: boolean; create_reason?: string } {
  if (!requestIntroducesName(item.text, entry.term)) return entry;
  return { ...entry, create: true, create_reason: `the request adds ${entry.term}; it occurs nowhere yet, so define it beside its siblings` };
}
