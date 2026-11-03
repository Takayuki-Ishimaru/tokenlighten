// epochContract — extracted implementation; imports point to the owning modules.
import type { ImpactCandidate } from "@tokenlighten/types";
import type { ServedSurfaceEntry } from "../../../util/packServeLog.js";
import type { TaskContractObservationUpdate } from "../taskContractStore.js";
import type { TaskExecutionContract } from "@tokenlighten/types";
import type { TaskPackResult } from "../model.js";
import type { TaskPackSurface } from "../model.js";
import { calleesOf } from "./packTrimming.js";
import { codeTaskPackSurfaces } from "../artifactSections.js";
import { expandOneHop } from "../openUniverseExpansion.js";
import { explicitCodeIdentifiers } from "./anchorFocus2.js";
import { getSession } from "../../../state/session.js";
import { hasOpenUniverseIntent } from "../openUniverseIntent.js";
import { hasServedCode } from "./wiringEvidence2.js";
import { importEdgeCandidates } from "../../locator/locateTaskContext.js";
import { isAdditiveEnumIntent } from "../openUniverseIntent.js";
import { languageForPath } from "../../../util/languages.js";
import { readCached } from "./packBasics2.js";
import { recordEvidenceExpansion } from "../taskContractStore.js";
import { recordExpansionExplicitGap } from "../taskContractStore.js";
import { recordTaskContract } from "../taskContractStore.js";
import { servedSurfaceText } from "./changeAndReadinessEvidence2.js";
import { shaOfText } from "../../../util/handles.js";
import { sliceLinesToText } from "../../../util/countLines.js";
import { tokenizeForEpoch } from "../../../state/session.js";
import { walkCodeFiles } from "../../../tools/walkRepo.js";

/**
 * Turn served-surface LOG ENTRIES into evidence the caller genuinely still
 * holds.
 *
 * DESIGN-v0.15 R1 / validation appendix §1 row 2 fix (2026-09-07): the serve
 * log only proves a path was served at SOME earlier revision — it carries no
 * range/sha. Reconstructing "evidence" by re-reading the whole CURRENT file
 * (the prior behaviour here) let a same-epoch challenge certify a concern from
 * bytes that may have diverged from what this caller actually received (a file
 * edited between two packs of the epoch, by the user, a native tool, or this
 * task's own `tl_edit_file`). The session's OWN served-range ledger
 * (`state/session.ts`) is the one structure that records BOTH a sha and the
 * exact merged line spans served under it — use ONLY that, sliced, and only
 * when its `fileSha` still matches the file on disk right now. A stale sha, or
 * no ledger entry at all (served only through some other path this ledger
 * never saw), yields NO evidence for this path rather than a whole-file guess.
 *
 * WP-S11 extracted this from `epochServedEvidence` unchanged, so the
 * read-only serve view's entries are subject to the identical sha gate — that
 * gate, not the view, is what makes carried-forward evidence honest.
 */
export function reconstructServedEntryEvidence(
  workspace: string,
  entries: readonly ServedSurfaceEntry[],
): TaskPackSurface[] {
  return entries.flatMap((entry) => {
    const ledger = getSession(workspace).servedRangeLedger.get(entry.path);
    if (ledger === undefined || ledger.ranges.length === 0) return [];
    const current = readCached(workspace, entry.path);
    if (current === undefined) return [];
    if (shaOfText(current) !== ledger.fileSha) return [];
    const code = ledger.ranges
      .map(([start, end]) => sliceLinesToText(current, start, end))
      .join("\n");
    if (code.length === 0) return [];
    return [{
      role: entry.role,
      handle: entry.handle ?? "",
      path: entry.path,
      range: ledger.ranges.map(([start, end]) => `${start}-${end}`).join(","),
      code,
    }];
  });
}

/**
 * Fold THIS pack into the epoch's standing contract: what it required, what it
 * named as a concern, and what it actually served. Runs AFTER the
 * reconciliation above, so a pack is never measured against its own record.
 */
export interface PersistedEvidenceExpansion {
  targets: readonly string[];
  remaining: readonly string[];
  gaps: readonly string[];
}

export const MAX_EVIDENCE_EXPANSION_TARGETS = 4;

export async function importEvidenceExpansion(
  workspace: string,
  primaries: readonly ImpactCandidate[],
  query: string,
  surfaces: readonly TaskPackSurface[],
): Promise<PersistedEvidenceExpansion> {
  // P1-g (2026-08-28 review-fix wave): this called walkCodeFiles(workspace)
  // — an ignore-aware walk of the ENTIRE workspace — unconditionally for
  // every pack, including the overwhelming majority that are not an
  // open-universe/exhaustive request and have no use for the result: both of
  // this function's own callers feed `evidenceExpansion` into
  // dedupeTrimAndPersist, which reads only `.gaps` (via
  // hasCurrentEvidenceExpansionGap, itself gated on hasOpenUniverseIntent)
  // and passes the whole object into recordEpochTaskContract, whose
  // `expansionTargets`/`expansionGaps` both force to `[]` when
  // `!hasOpenUniverseIntent(query)`. A non-open-universe task's expansion
  // result is therefore fully inert downstream today — gating the walk
  // (and the importEdgeCandidates/calleesOf work below it) behind the same
  // canonical predicate changes no observable behavior for that majority and
  // removes the per-pack full-repository walk from its cost. Deliberately
  // NOT also gated on `primaries.length === 0`: even with zero primaries the
  // pre-wave code still derived `directCallees` from already-served surface
  // bodies via calleesOf below, independent of `files`/importEdgeCandidates
  // — preserving that path keeps this change scoped to the walk-avoidance
  // fix alone.
  if (!hasOpenUniverseIntent(query)) {
    return { targets: [], remaining: [], gaps: [] };
  }
  // In-pack memoization: `files` is computed once here and shared by every
  // `primary` in the Promise.all below — this function's own two call sites
  // (the general and answer-shaped pack builders) are mutually exclusive per
  // pack build, so there is no second walk to memoize across within one pack.
  const files = walkCodeFiles(workspace);
  const queryTokens = query.toLowerCase().match(/[a-z_$][a-z0-9_$]*/g) ?? [];
  const details = await Promise.all(primaries.slice(0, MAX_EVIDENCE_EXPANSION_TARGETS).map((primary) =>
    importEdgeCandidates(workspace, primary as unknown as Parameters<typeof importEdgeCandidates>[1], queryTokens, files),
  ));
  const served = codeTaskPackSurfaces([...surfaces]).filter(hasServedCode);
  const directCallees = served.flatMap((surface) =>
    calleesOf(surface.code!, surface.symbol ? [surface.symbol] : []),
  );
  const candidates = [...new Set([
    ...details.flatMap((detail) => detail.candidates.map((candidate) => candidate.symbol ?? candidate.path)),
    ...directCallees,
  ])];
  const remaining = details.flatMap((detail) => detail.remaining.map((candidate) => candidate.symbol ?? candidate.path));
  const primaryPath = served[0]?.path ?? primaries[0]?.path;
  const language = primaryPath === undefined ? "unknown" : (languageForPath(primaryPath) ?? "unknown");
  const expansion = expandOneHop(language, candidates, MAX_EVIDENCE_EXPANSION_TARGETS);
  return {
    targets: expansion.targets.map((entry) => entry.target),
    remaining: [...expansion.remaining, ...remaining],
    gaps: [
      ...(expansion.explicitGap === undefined ? [] : [expansion.explicitGap]),
      ...(remaining.length === 0 ? [] : [`import-edge expansion has ${remaining.length} unserved target(s)`]),
    ],
  };
}

/** Whether this response itself carries an extractor-capability proof that
 * must be visible to its final readiness rebuild. Ordinary unresolved
 * expansions remain post-decision epoch bookkeeping so their prescribed
 * discovery next is emitted before the ledger grows. */
export function hasCurrentEvidenceExpansionGap(
  result: TaskPackResult,
  query: string,
): boolean {
  if (!hasOpenUniverseIntent(query) || isAdditiveEnumIntent(query)) return false;
  const requestedSymbols = explicitCodeIdentifiers(query).slice(0, 1);
  return codeTaskPackSurfaces(result.surfaces)
    .filter(hasServedCode)
    .some((surface) => expandOneHop(
      languageForPath(surface.path) ?? "unknown",
      calleesOf(servedSurfaceText(surface), surface.symbol ? [surface.symbol] : requestedSymbols),
      MAX_EVIDENCE_EXPANSION_TARGETS,
    ).explicitGap !== undefined);
}

export interface EpochTaskContractObservation extends TaskContractObservationUpdate {
  readonly transition: boolean;
}

export function applyEpochTaskContractObservation(workspace: string, observation: EpochTaskContractObservation): void {
  recordTaskContract(workspace, observation.epochTokens, observation.taskContract);
  recordEvidenceExpansion(
    workspace,
    observation.expansion.targets,
    observation.expansion.servedDefinitions,
  );
  if (observation.literalSourceUniverse) {
    recordEvidenceExpansion(workspace, ["literal-source-universe"], ["literal-source-universe"]);
  }
  if (observation.explicitGap !== undefined) {
    recordExpansionExplicitGap(
      workspace,
      observation.explicitGap.parent,
      observation.explicitGap.targets,
      observation.explicitGap.witness,
    );
  }
}

/**
 * R2: bound on declarations scanned out of ONE served body when proving which
 * expansion targets are resident. Generous next to `MAX_EVIDENCE_EXPANSION_TARGETS`
 * so a dependency file's own helpers cannot crowd out the target under proof,
 * and bounded so a large served body cannot make the recorder super-linear.
 */
export const MAX_SERVED_DEFINITION_SYMBOLS = 64;

/** Cap on how many unserved caller paths are disclosed (they share the W2 guidance-metadata budget). */
export const MAX_UNSERVED_CALLER_PATHS = 6;

/** Bound on the proof-preserving byte-budget fallback's own `missing` list (its cap check has no trim pass after it). */
export const MAX_FALLBACK_MISSING_ENTRIES = 4;

/**
 * B1c: the candidate paths of the most recent candidate-list pack per
 * workspace. Paired with the session's own `candidatePackPending` brake (which
 * records only that a choice is outstanding, not WHAT the choices were), it
 * lets a query-only re-pack bind the pending candidates as paths instead of
 * degrading into a second candidate list over the same ambiguity.
 */
export const pendingCandidatePaths = new Map<string, { paths: string[]; tokens: string[] }>();

/** Test hook: drop the pending-candidate binding for every workspace. */
export function resetPendingCandidatePaths(): void {
  pendingCandidatePaths.clear();
}

// ---------------------------------------------------------------------------
// C2 (2026-08-09): a qref re-pack that only adds CONTEXT keeps its certificate.
//
// The documented qref contract is "keeps the certified working set" — the guide
// tells a paths-bearing retry to drop `query` and re-send `qref=… paths=[…]`
// precisely so the certified set survives. It did not. Measured on the T05c
// cell: after the (over-shrunk) first pack omitted CONTRACT.md, every rep
// re-packed with qref + paths:[CONTRACT.md] and got a pack that
//   - demoted execution_contract.typestate.phase prepared → discovery,
//   - flipped all three concerns covered → needs-followup, and
//   - prescribed blocking_next_steps ["find saturation","find contract",
//     "find failsafe"] — three more searches
// for a request that asked for one context document. One rep obeyed two of the
// three literally. Nothing had been falsified: the seeded re-pack simply
// rebuilt its concern coverage from the ONE file it was handed and reported the
// other seven as unresolved, forgetting that the caller still holds them.
//
// So: remember what a prepared pack certified, and when a qref replay adds only
// context material (doc-role, not edit-frontier scope), carry that certificate
// forward instead of re-deriving it from the re-pack's narrower surface set. A
// replay that adds genuine NEW CODE scope is a real re-scope and keeps today's
// behaviour — the working set changed, so the proof must be redone.
// ---------------------------------------------------------------------------

/** The proof a prepared pack shipped, retained per (workspace, lane) for one epoch. */
export interface CertifiedWorkingSet {
  /**
   * F-V13-3 (2026-08-30): the lane the certificate was ISSUED in. The map key
   * already partitions by lane, so this is defence in depth — a certificate is
   * an authorization, and an authorization must be able to state who it was
   * issued to, independently of where it happens to be filed. The live incident
   * was a cross-lane clone of `contract` (see carryForwardCertifiedWorkingSet),
   * which reinstalls a peer lane's `execution_contract` wholesale: in one
   * direction that fenced lane `canon-plan`'s create behind lane
   * `canon-ledger`'s frontier, and in the other it would have AUTHORIZED an
   * edit on evidence the calling lane never held.
   */
  lane: string;
  epochTokens: string[];
  contract: TaskExecutionContract;
  concerns: TaskPackResult["concerns"];
  coverage: TaskPackResult["coverage"];
  coverageReason: TaskPackResult["coverage_reason"];
  coverageBasis: TaskPackResult["coverage_basis"];
  routeAction: NonNullable<TaskPackResult["route"]>["action"];
  /** Workspace-relative paths of the certified surfaces (normalized). */
  paths: string[];
  /** Content sha of each certified surface file — the staleness proof. */
  fileShas: Array<{ path: string; sha: string }>;
}

export const certifiedWorkingSets = new Map<string, CertifiedWorkingSet>();

/** Test hook: drop every retained certificate. */
export function resetCertifiedWorkingSets(): void {
  certifiedWorkingSets.clear();
}

/** Minimum share of the smaller token set two queries must share to be "the same request restated". */
export const PENDING_CANDIDATE_TOKEN_OVERLAP = 0.6;

/**
 * B1c: is `query` a restatement of the request whose candidate list is still
 * pending? The session brake only records THAT a choice is outstanding, so
 * without this check an unrelated NEXT task issued while the brake is armed
 * would silently inherit the previous task's candidate paths as a hard scope.
 * Token-overlap gated (never a substring test) so a genuine re-ask binds and a
 * new subject does not.
 */
export function isPendingCandidateRestatement(entry: { tokens: string[] }, query: string): boolean {
  const current = new Set(tokenizeForEpoch(query));
  const prior = new Set(entry.tokens);
  if (current.size === 0 || prior.size === 0) return false;
  let shared = 0;
  for (const token of current) if (prior.has(token)) shared++;
  return shared / Math.min(current.size, prior.size) >= PENDING_CANDIDATE_TOKEN_OVERLAP;
}
