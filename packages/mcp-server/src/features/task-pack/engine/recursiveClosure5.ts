// recursiveClosure — extracted implementation; imports point to the owning modules.
import type { TaskPackResult } from "../model.js";
import type { TaskPackSurface } from "../model.js";
import type { TaskReadinessEvidence } from "@tokenlighten/types";
import { exactIdentifierEvidence } from "./changeAndReadinessEvidence.js";
import { explicitCodeIdentifiers } from "./anchorFocus2.js";
import { isArtifactTaskPackSurface } from "../artifactSections.js";
import { readinessEvidence } from "./changeAndReadinessEvidence2.js";
import { sameNameDeclarationRows } from "./sameNameSubjects.js";
import { sameNameSubjectsFor } from "./sameNameSubjects.js";
import { surfaceWhyHasMarker } from "./recursiveClosure.js";

export function groundedAnalysisEvidence(
  result: TaskPackResult,
  query: string,
  served: readonly TaskPackSurface[],
): TaskReadinessEvidence[] {
  const evidence: TaskReadinessEvidence[] = [];
  for (const surface of served) {
    if (
      surfaceWhyHasMarker(surface.why, "caller-supplied")
      || surfaceWhyHasMarker(surface.why, "caller-supplied-dir")
    ) {
      evidence.push(readinessEvidence(surface));
    }
  }
  for (const surface of result.surfaces.filter(isArtifactTaskPackSurface)) {
    evidence.push({ handle: surface.handle, path: surface.path });
  }
  // WP-O: a same-name subject grounds the analysis only through the
  // declaration the question means — never through a call site of it.
  const sameNameSubjects = sameNameSubjectsFor(result);
  for (const identifier of explicitCodeIdentifiers(query).slice(0, 6)) {
    const sameNameSubject = sameNameSubjects.get(identifier);
    evidence.push(...(sameNameSubject === undefined
      ? exactIdentifierEvidence(served, identifier)
      : sameNameDeclarationRows(sameNameSubject, served).map(readinessEvidence)));
  }
  const seen = new Set<string>();
  return evidence.filter((item) => {
    const key = `${item.handle}\u0000${item.path}\u0000${item.range ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 6);
}

// ---------------------------------------------------------------------------
// DESIGN-v0.15 R1 (2026-09-07): request-item obligations
// (features/task-pack/requestItems.ts's extraction; wave1-contract.md §3).
//
// Deliberately parallel to the enumerated-item/F-V13-6 mechanism above rather
// than merged into it: F-V13-6 proves a single-facet-per-segment substring
// hit, which is exactly the "同名identifierでは呼出関係を証明しない" shape
// design §4.1 forbids for a `decision`/`relation` point (a decoy sharing an
// identifier, or two definitions served side by side, must not close a
// point). Kept as an ADDITIVE obligation source so an existing single-target
// query — `extractRequestItems` returns 0-1 items for those by construction
// — never engages this path and stays byte-identical (contract §3.4).
// ---------------------------------------------------------------------------

export const REQUEST_ITEM_OBLIGATION_PREFIX = "request-item:";

/** A `request_item_absences` entry minted by this pack's OWN request-item pass (`extractRequestItems`' `ri-N` ids), as opposed to an external `identifier:*` proof. */
export const REQUEST_ITEM_ABSENCE_ID_RE = /^ri-\d+$/u;

/** Bound on one batched discover call for still-uncovered request items. */
export const MAX_REQUEST_ITEM_BATCH = 8;

/** Bound on distinct candidate files a topic item's literal find may return before it is too ambiguous to batch. */
export const MAX_REQUEST_ITEM_TOPIC_CANDIDATES = 8;

export interface RequestItemProof {
  proved: boolean;
  evidence: TaskReadinessEvidence[];
  reason: string;
  /** Real, existing workspace paths still worth fetching when NOT proved. Empty when nothing more can be fetched for this point (never re-requested). */
  candidatePaths: string[];
  /**
   * DESIGN-v0.15 R1 (2026-09-07): set ONLY by `proveUnbindableRequestItem`'s
   * verified-absence arm (`matchedPaths.size === 0`) — the exact salient-word
   * phrase the workspace-wide literal scan found zero occurrences of. Absent
   * on every other proof path (served-surface match, candidate coverage,
   * "no salient wording"), including the OTHER `proved:true` arms above,
   * which close by positive evidence, not absence.
   */
  absentTerm?: string;
  /**
   * Review finding 2(b) fix (2026-09-08): always set alongside `absentTerm`.
   * `true` only when the scan that certified the absence had ZERO omissions
   * over its own scope — for `proveUnbindableRequestItem`'s workspace-wide
   * literal scan this is `!anyWalkOmission(widenedUniverse.omissions)`; for
   * the definition/relation arms below (absence bounded to "every candidate
   * is served in full and none declares/calls it") this is unconditionally
   * `true` — that scope has no omission concept, every candidate the proof
   * is ABOUT was read in full by construction. Never disclosed as "scope
   * complete" when `false` — see `absentOmittedCount`.
   */
  absentScopeComplete?: boolean;
  /** Paired with `absentScopeComplete`: the raw excluded-path count backing an incomplete scope's wording ("N paths excluded from the scan"). `0` whenever `absentScopeComplete` is `true`. */
  absentOmittedCount?: number;
  /** R-B3 (ruling 5): the absence is "served but only mentioned in passing" — the term DOES occur, so the disclosure must not say "no occurrence". */
  absentIncidental?: boolean;
  /**
   * DESIGN-v0.15 R1 false-completion fix (2026-09-07, P1): set when a
   * candidate PATH is served but the proof-critical line range (a decision
   * identifier's own declaration/implementation body; see
   * `declarationRangeInFile`) is not yet covered by the union of served
   * windows for that path (see `servedLineSpansOf`/`lineSpansCover`) — a
   * range:"1-20" prefix read of a file whose real decision logic sits past
   * line 20 must never be credited as "this file is served" (design §4.2:
   * "単なる...path単位の既読...を禁止する"). The proof-critical range is the
   * identifier's AST-resolved declaration span, or — when the AST cannot
   * bound it at all (P1 ruling, 2026-09-07) — the WHOLE file at the current
   * revision; either way the follow-up fetches exactly the UNSERVED lines,
   * never a whole-file re-read of bytes this task already holds — see
   * `buildRequestItemReadiness`'s own use of this field. An
   * explicit `range` (never `symbol:`) — verified empirically that a
   * `{path,symbol}` target for a path this task already touched resolves
   * back to the EXISTING served range rather than the symbol's own bounds
   * (a pre-existing wire-layer limitation outside this fix's ownership),
   * while an explicit overlapping/wider `range` for the same path reliably
   * serves fresh bytes for the new span.
   */
  rangeCandidates?: Array<{ path: string; range: string }>;
  /**
   * R-D2 (2026-09-21, item B): mirrors `ConcernVerdict.undeterminedTerm` —
   * set only for a could-not-determine verdict that carries no `absentTerm`
   * (see that field's own doc comment for why those two never overlap).
   * `proved` is `false` whenever this is set, exactly like the plain "open,
   * no candidate" case it used to be indistinguishable from.
   */
  undeterminedTerm?: string;
  /**
   * WP-C2 (2026-09-29, eval-0929 §6/§8, rule 2): set ONLY by the two rule-1
   * call sites that mint `undeterminedTerm` because no word of this point
   * passed the structural literal-eligibility gate (never by the PRE-
   * EXISTING R-D2 indeterminate arms above — an unreadable-only candidate,
   * or too many candidates to batch — which keep blocking exactly as
   * before: those DO have a real, fetchable path this proof cannot itself
   * chase, so staying blocking is what invites a caller to try something
   * else). This flags the DIFFERENT shape: `candidatePaths` is always empty
   * for it (nothing to fetch, ever), so blocking on it is a genuine DEAD
   * END (common brief rule 10) rather than useful pressure toward a next
   * call. The independent-questions loop (`buildRequestItemReadiness`)
   * reads this to flip the obligation to non-blocking while still
   * disclosing the point via `undetermined` — never silently.
   */
  undeterminedNonBlocking?: boolean;
}
