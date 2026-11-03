// identifierAbsence — extracted implementation; imports point to the owning modules.
import * as path from "path";
import type { TaskPackResult } from "../model.js";
import type { TaskPackSurface } from "../model.js";
import type { TaskReadinessObligation } from "@tokenlighten/types";
import { codeTaskPackSurfaces } from "../artifactSections.js";
import { currentSessionLane } from "../../../util/laneKey.js";
import { executedSearchResults } from "../../../util/packServeLog.js";
import { identifierAbsenceByResult } from "./identifierAbsence2.js";
import { identifierNamesSymbol } from "./anchorFocus3.js";
import { normIdent } from "./createAndWiringEndpoints2.js";
import { recordedAbsenceIsStale } from "./identifierAbsence2.js";
import { servedSurfaceText } from "./changeAndReadinessEvidence2.js";
import { verifiedAbsentIdentifiersByResult } from "./facetClosure2.js";

/**
 * SHOULD-FIX 28 (2026-09-14, review round 4) — NO RESPONSE MAY SERVE A BODY
 * CONTAINING AN IDENTIFIER AND CERTIFY THAT IDENTIFIER ABSENT.
 *
 * R2-B14 established that invariant for the EXECUTED-SEARCH ledger's absences
 * (`recordedAbsenceIsStale` test (a)). The INTERNAL absence prover writes here
 * directly and had no such check — `buildSeededTaskPack`'s `scanLiteral` over the
 * bounded SOURCE universe, which does not enumerate extensionless files, while
 * `tl_search_files find`'s generic-text floor does. So a pack that served
 * `bin/tool` (`plasmaConduitMode=true`, located by that very find) certified
 * `identifier:plasmaConduitMode` with the decision-grade wording "has zero
 * literal occurrences in the workspace". Latent before SHOULD-FIX 28 only
 * because such a file was never served at all; serving it is what made the
 * disagreement reachable, so the guard belongs with the change that reached it.
 *
 * Enforced at the single READER rather than at the four writers: a claim is
 * withdrawn whenever this pack's own bytes contradict it, whichever prover made
 * it, and a future prover inherits the guard. Word-boundary over
 * `servedSurfaceText` plus the surface's anchor `symbol` — byte-for-byte the same
 * test (a) uses, including its deliberate indifference to whether the occurrence
 * is code-bearing: an occurrence of ANY kind withdraws a claim, even though only
 * a code-bearing one may PROVE something (SHOULD-FIX 29).
 *
 * The obligation then falls back to "no served evidence", which keeps discovery
 * open and makes `uncoveredIdentifierFindCall` propose the workspace-wide find —
 * a bounded extra call rather than a false certificate. No I/O.
 */
export function verifiedAbsentIdentifiersFor(result: TaskPackResult): readonly string[] {
  const recorded = verifiedAbsentIdentifiersByResult.get(result) ?? [];
  if (recorded.length === 0) return recorded;
  const surfaces = codeTaskPackSurfaces(result.surfaces ?? []);
  if (surfaces.length === 0) return recorded;
  return recorded.filter((identifier) => !servedSurfacesMentionIdentifier(surfaces, identifier));
}

/** SHOULD-FIX 28's withdrawal test, shared: does any served body (or anchor symbol) of `surfaces` name `identifier` on a word boundary? */
export function servedSurfacesMentionIdentifier(surfaces: readonly TaskPackSurface[], identifier: string): boolean {
  const matcher = new RegExp(`\\b${identifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
  return surfaces.some((surface) =>
    matcher.test(servedSurfaceText(surface))
    || (surface.symbol !== undefined && matcher.test(surface.symbol)));
}

/** Union-writes the PROOF set (never drops an identifier another writer already proved absent). */
export function recordVerifiedAbsentIdentifiers(result: object, identifiers: readonly string[]): void {
  if (identifiers.length === 0) return;
  const prior = verifiedAbsentIdentifiersByResult.get(result) ?? [];
  const merged = [...prior];
  for (const identifier of identifiers) if (!merged.includes(identifier)) merged.push(identifier);
  verifiedAbsentIdentifiersByResult.set(result, merged);
}

/**
 * WP-N rule 2 — the certificate DISCLOSES an absent identifier it proved.
 *
 * `request_item_absences` entries (`identifier:<X>` ids, the vocabulary
 * `promoteExecutedSearchAbsences` already uses for an external find's proof)
 * for every `identifier:<X>` obligation this contract PROVED while `<X>` has
 * no whole-identifier occurrence: proved BY that absence (no evidence), or by
 * the semantic-responsibility owner of a name the codebase never spells —
 * either way the name the caller asked about does not exist, and the only
 * channel a certified `act.answer` has for saying so is `certificate.gaps`
 * (decisionWire.ts `projectCertificate`). Never for an obligation proved by a
 * row whose own symbol or file name IS the identifier (exact evidence), never
 * for an UNPROVED one (the pack is still looking — replay v0142a2a's first
 * pack prescribes the confirming search, and "absent" beside that search
 * would contradict it), and never when this response's own served bytes name
 * the identifier (SHOULD-FIX 28's withdrawal test).
 */
export function identifierAbsenceDisclosures(
  result: TaskPackResult,
  obligations: readonly TaskReadinessObligation[],
): Array<{ id: string; term: string; scope_complete: boolean; omitted_count: number }> {
  const recorded = identifierAbsenceByResult.get(result);
  if (recorded === undefined || recorded.size === 0) return [];
  const surfaces = codeTaskPackSurfaces(result.surfaces ?? []);
  const out: Array<{ id: string; term: string; scope_complete: boolean; omitted_count: number }> = [];
  for (const obligation of obligations) {
    if (obligation.kind !== "explicit-identifier" || obligation.status !== "proved") continue;
    if (!obligation.id.startsWith("identifier:")) continue;
    const identifier = obligation.id.slice("identifier:".length);
    const absence = recorded.get(identifier);
    if (absence === undefined) continue;
    const named = normIdent(identifier);
    if ((obligation.evidence ?? []).some((row) =>
      (row.symbol !== undefined && identifierNamesSymbol(row.symbol, identifier))
      || normIdent(path.basename(row.path, path.extname(row.path))) === named)) continue;
    if (servedSurfacesMentionIdentifier(surfaces, identifier)) continue;
    out.push({
      id: obligation.id,
      term: identifier,
      scope_complete: absence.scopeComplete,
      omitted_count: absence.scopeComplete ? 0 : absence.omittedCount,
    });
  }
  return out;
}

/**
 * TL142-01B (2026-09-13, v0.14.2 hands-on report §4 TL142-01 "B") —
 * A SEARCH THE CALLER ALREADY RAN IS A PROOF THIS PACK MAY USE.
 *
 * `Explain validateToken and quantumTeleportationMode.` opens with a pack that
 * serves `validateToken` and prescribes `tl_search_files find
 * quantumTeleportationMode`. The caller runs it; the response is an exhaustive,
 * literal, un-narrowed absence certificate ("no file under the scanned root
 * references this token"). Resuming then returned
 * `await_input:"no-grounded-call-remains"` — the pack had nothing left to
 * search, nothing left to serve, and no way to say so — because the only
 * absence this file could act on was the one it scanned for ITSELF
 * (`distinctiveSalientAbsence`/`proveUnbindableRequestItem`, both gated behind
 * `extractRequestItems(query).length >= 2`, which a two-identifier explain
 * query does not reach).
 *
 * This folds the EXTERNAL proof into the two mechanisms the internal one
 * already feeds, so there is exactly one absence vocabulary on the wire:
 *  - the verified-absent identifier set, which `buildReadinessObligations`
 *    reads to mark `identifier:<term>` PROVED with decision-grade wording and
 *    `uncoveredIdentifierFindCall` reads to stop re-searching it;
 *  - `result.request_item_absences`, which `buildCapabilityGaps` projects onto
 *    a `discover` decision's `gaps` and `decisionWire.ts`'s
 *    `projectCertificate` projects onto a CERTIFIED decision's
 *    `certificate.gaps` — the latter being what makes the resume reach
 *    `act.answer` while still disclosing the absent term.
 *
 * Only scope-COMPLETE absences count (`ExecutedSearchAbsence` is recorded only
 * for a workspace-wide, literal, caveat-free certificate — see server.ts's
 * `provenFindAbsence`), and only for a term the query itself names verbatim.
 * A partial-scope zero result is not a proof and leaves the pack proposing the
 * search, which is the fail-closed direction.
 *
 * R2-B14 (2026-09-13 review round 2): and only while the absence is still TRUE —
 * see `recordedAbsenceIsStale`. A recorded absence used to be projected forever,
 * so a file created after the scan made one response serve the declaration and
 * certify the identifier absent "scope complete" in the same breath.
 */
export function promoteExecutedSearchAbsences(
  workspace: string,
  query: string,
  result: TaskPackResult,
  taskBinding?: string,
): void {
  const recorded = executedSearchResults(workspace, currentSessionLane(), taskBinding)
    .filter((entry) => entry.absence !== undefined && entry.hits.length === 0 && query.includes(entry.term))
    // R1-B1 (2026-09-13 review round): READ the recorded scope verdict, never
    // assume it. `server.ts`'s `provenFindAbsence` is the only writer that sets
    // `scopeComplete`, and this projection mints a `request-item-absent` gap on a
    // CERTIFIED decision — so a recorder that ever relaxes its gate must not be
    // able to make this certificate lie on its behalf. Fail-closed: an absence
    // this filter drops leaves the obligation uncovered and the search proposed.
    .filter((entry) => entry.absence?.scopeComplete === true)
    // R2-B14 (2026-09-13 review round 2): RE-VALIDATE. Nothing checked a recorded
    // absence against the workspace it claims to describe, so it outlived its own
    // truth — see `recordedAbsenceIsStale`.
    .filter((entry) => !recordedAbsenceIsStale(workspace, result, entry));
  if (recorded.length === 0) return;
  const priorAbsent = verifiedAbsentIdentifiersFor(result);
  const absentIdentifiers = [...priorAbsent];
  for (const entry of recorded) {
    if (!absentIdentifiers.includes(entry.term)) absentIdentifiers.push(entry.term);
  }
  if (absentIdentifiers.length > priorAbsent.length) {
    verifiedAbsentIdentifiersByResult.set(result, absentIdentifiers);
  }
  const absences = [...(result.request_item_absences ?? [])];
  for (const entry of recorded) {
    if (absences.some((existing) => existing.term === entry.term)) continue;
    absences.push({
      id: `identifier:${entry.term}`,
      term: entry.term,
      // R1-B1: the RECORDED facts, not two literals. Both were hard-coded here
      // (`scope_complete: true, omitted_count: 0`) while the `queries[]` recorder
      // could reach this with a caveated per-term verdict over a workspace that
      // disclosed `omitted:{tokenlighten_ignored:1}` — so the wire gap asserted
      // "scope complete" and "nothing omitted" about a scan that was neither.
      // The recorder now proves both (server.ts's `provenFindAbsence`) and this
      // projection carries them.
      scope_complete: entry.absence!.scopeComplete,
      omitted_count: entry.absence!.omittedCount,
    });
  }
  if (absences.length > 0) result.request_item_absences = absences;
}
