// answerCertificates — extracted implementation; imports point to the owning modules.
import * as path from "path";
import type { CertificateCitation } from "../certificateWireInvariant.js";
import type { CertificateWireBreach } from "../certificateWireInvariant.js";
import type { CertifiedSurface } from "../certificateWireInvariant.js";
import type { ServedSpans } from "../certificateWireInvariant.js";
import type { TaskPackArgs } from "../model.js";
import type { TaskPackResult } from "../model.js";
import type { TaskPackResultSurface } from "../model.js";
import type { TaskPackSurface } from "../model.js";
import type { TaskProfile } from "@tokenlighten/types";
import { applyCanonicalTaskDecision } from "../canonicalDecision.js";
import { buildTaskExecutionContract } from "./executionContract.js";
import { buildTaskWorkspaceState } from "./epochEvidence2.js";
import { certificateCitations } from "../certificateWireInvariant.js";
import { certificateWireBreaches } from "../certificateWireInvariant.js";
import { certifiedWorkingSets } from "./epochContract3.js";
import { codeTaskPackSurfaces } from "../artifactSections.js";
import { computeWorkspaceInventoryState } from "./epochEvidence2.js";
import { decisionInvariantStrictEnabled } from "../../../util/flags.js";
import { enforceNoDeadEndContract } from "./contractReconciliation.js";
import { failClosedToEvidenceReread } from "./answerCertificates2.js";
import { isTraceEnabled } from "../../../util/trace.js";
import { laneScopedKey } from "../../../util/laneKey.js";
import { normalizeContractLane } from "../../../util/packServeLog.js";
import { packServedSpans } from "./packState2.js";
import { parseSurfaceSpan } from "./packState2.js";
import { reconcileTaskPackExecutionContract } from "./contractReconciliation.js";
import { servedClusterRanges } from "../../../state/session.js";
import { servedZoomScopeForArgs } from "./packState2.js";
import { trace } from "../../../util/trace.js";
import { trimNextAgainstShippedEvidence } from "./answerCertificates2.js";
import { withdrawProvisionalServedRanges } from "../../../state/session.js";
import { wouldIntroduceBreach } from "../certificateWireInvariant.js";

/**
 * WP-B: a spec seam standing in for a FUTURE post-certification remover. It
 * runs where one would (after the named-path cap, before the invariant), so
 * `evaluation0929.certificateWireInvariant.spec.ts` can prove the invariant
 * downgrades a pack whose cited evidence a late pass withdrew. Unset outside
 * that spec; a no-op call otherwise.
 */
export let postCertificationPassForTest: ((surfaces: TaskPackResultSurface[]) => void) | undefined;

export function setPostCertificationPassForTest(pass: ((surfaces: TaskPackResultSurface[]) => void) | undefined): void {
  postCertificationPassForTest = pass;
}

/**
 * WP-B (eval-0929 §5/§8): the certification-time facts the post-certification
 * passes of `buildAnswerTaskPack` are judged against — the certificate's
 * citations and the line spans THIS response carried in a body when it was
 * minted. `keep` is the named-path cap's prevention predicate (`undefined`
 * when nothing is certified, which leaves the cap exactly as it was).
 */
export interface AnswerCertificationSnapshot {
  readonly citations: readonly CertificateCitation[];
  readonly certifiedSpans: ServedSpans;
  readonly keep: ((candidate: TaskPackSurface, current: readonly TaskPackSurface[]) => boolean) | undefined;
}

/** `result`'s code surfaces as `certificateCitations` reads them. */
export function certifiedSurfacesOf(result: TaskPackResult): CertifiedSurface[] {
  return codeTaskPackSurfaces(result.surfaces).map((surface) => ({
    handle: surface.handle,
    path: surface.path,
    range: String(surface.range ?? ""),
    required: surface.required === true,
    shipped: (surface.code?.length ?? 0) > 0,
  }));
}

export function answerCertificationSnapshot(result: TaskPackResult): AnswerCertificationSnapshot {
  const certifiedSpans = packServedSpans(result);
  const citations = certificateCitations(result.execution_contract, certifiedSurfacesOf(result));
  const spansOf = (surfaces: readonly TaskPackSurface[]): ServedSpans => packServedSpans({ ...result, surfaces: [...surfaces] });
  return {
    citations,
    certifiedSpans,
    keep: citations.length === 0
      ? undefined
      : (candidate, current) => wouldIntroduceBreach(
        citations,
        certifiedSpans,
        spansOf(current),
        spansOf(current.filter((surface) => surface !== candidate)),
      ),
  };
}

/** The withdrawn lines of `breaches`, one window per contiguous span. */
export function certificateBreachWindows(
  breaches: readonly CertificateWireBreach[],
): Array<{ path: string; start: number; end: number }> {
  const seen = new Set<string>();
  const windows: Array<{ path: string; start: number; end: number }> = [];
  for (const breach of breaches) {
    for (const [start, end] of breach.lost) {
      const key = `${breach.path}:${start}-${end}`;
      if (seen.has(key)) continue;
      seen.add(key);
      windows.push({ path: breach.path, start, end });
    }
  }
  return windows;
}

/**
 * WP-B (eval-0929 §5, §8) — A CERTIFICATE NEVER OUTLIVES ITS EVIDENCE, enforced
 * at ONE point: `buildAnswerTaskPack`, after the last pass that can change the
 * final surface set (the import/anchor augmenters, the 1.25x named-path cap,
 * `trimNextAgainstShippedEvidence`) and before the re-booking records it.
 *
 * The certificate was minted inside `dedupeTrimAndPersist`. When a later pass
 * withdrew lines it cites (`certificateWireInvariant.ts` says which citations
 * a claim depends on), the pack may not keep it:
 *
 *  1. This call's provisional ledger bookings of the withdrawn lines are
 *     retracted first (`withdrawProvisionalServedRanges`) — the funnel exit
 *     would retract them anyway, and until it does the re-derivation below
 *     would read them back as carried evidence.
 *  2. The contract is re-derived over the FINAL surfaces with the same
 *     sequence `rebuildFinalExecutionContract`'s rebuild arm runs, so
 *     decision, `next` and certificate come from one derivation: the facet
 *     gate reports the withdrawn window `open` with its exact range as the
 *     next read (or discloses it undetermined), an identifier that lost its
 *     last evidence is uncovered, and nothing re-reads a line this response
 *     ships (`trimNextAgainstShippedEvidence` again).
 *  3. Fail closed: if the re-derived certificate still cites a withdrawn line
 *     (a carried-evidence path the retraction did not reach), it is withdrawn
 *     outright — a discovery contract whose one call re-reads exactly those
 *     lines. Strict mode (the test suites) throws instead, so the class is
 *     heard rather than papered over.
 *
 * The prevention (`answerCertificationSnapshot().keep`, passed to the cap)
 * makes step 1-3 unreachable for every remover this file has today; this is
 * the backstop that keeps the NEXT post-trim remover from silently
 * reintroducing the class (`evaluation0929.certificateWireInvariant.spec.ts`).
 * An unbreached pack returns before touching anything: byte-identical.
 */
export function enforceCertificateWireInvariant(
  result: TaskPackResult,
  certification: AnswerCertificationSnapshot,
  args: TaskPackArgs,
  workspace: string,
): void {
  if (certification.citations.length === 0) return;
  const breaches = certificateWireBreaches(certification.citations, certification.certifiedSpans, packServedSpans(result));
  if (breaches.length === 0) return;
  const withdrawn = certificateBreachWindows(breaches);
  if (isTraceEnabled()) {
    trace("certificate_wire_breach", {
      obligations: [...new Set(breaches.map((breach) => breach.obligationId))],
      withdrawn: withdrawn.map((window) => `${window.path}:${window.start}-${window.end}`),
    }, workspace);
  }
  withdrawProvisionalServedRanges(workspace, withdrawn);
  // A certificate rides forward on a qref replay only while it stands; this one
  // no longer does (the same rule bookShippedPackServeState applies to a
  // non-prepared final result).
  certifiedWorkingSets.delete(laneScopedKey(path.resolve(workspace)));
  const effectiveQuery = args.query ?? args.symbol ?? args.path ?? "";
  const profile: TaskProfile = result.coverage_basis === "cumulative"
    ? "generic"
    : result.profile_binding?.selected ?? "answer";
  result.execution_contract = buildTaskExecutionContract(
    result,
    profile,
    effectiveQuery,
    buildTaskWorkspaceState(result, workspace, computeWorkspaceInventoryState(workspace)),
    workspace,
    false,
    servedZoomScopeForArgs(args, effectiveQuery),
  );
  reconcileTaskPackExecutionContract(result);
  enforceNoDeadEndContract(result, effectiveQuery, { workspace, lane: normalizeContractLane(args.lane) });
  applyCanonicalTaskDecision(result);
  trimNextAgainstShippedEvidence(result);
  // The re-derived certificate may cite a withdrawn line only where the client
  // holds it anyway: shipped by another surface of this response, or resident
  // from an earlier call (the ledger, which no longer carries this call's own
  // withdrawn bookings).
  const withdrawnPaths = [...new Set(withdrawn.map((window) => window.path))];
  const withdrawnSpans: ServedSpans = new Map(withdrawnPaths.map((windowPath) => [
    windowPath,
    withdrawn.filter((window) => window.path === windowPath).map((window) => [window.start, window.end] as const),
  ] as const));
  const deliveredSpans = withResidentSpans(packServedSpans(result), workspace, withdrawnPaths);
  const rebuilt = certificateCitations(result.execution_contract, []);
  if (certificateWireBreaches(rebuilt, withdrawnSpans, deliveredSpans).length === 0) return;
  if (decisionInvariantStrictEnabled()) {
    throw new Error(`certificate wire invariant: a re-derived certificate still cites withdrawn evidence (${withdrawn.map((window) => `${window.path}:${window.start}-${window.end}`).join(", ")})`);
  }
  failClosedToEvidenceReread(
    result,
    withdrawn,
    "certified evidence did not reach this response; read the withdrawn window(s) before answering",
    [...new Set(breaches.map((breach) => breach.obligationId))],
  );
}

/**
 * `spans` plus what the served-range ledger holds for each of `paths` — the
 * lines a client holds after this response: its bodies, and an earlier call's
 * residency. Inside `dedupeTrimAndPersist` the ledger has none of THIS call's
 * bookings yet (they land at its exit); after it, `enforceCertificateWireInvariant`
 * retracts this call's withdrawn ones first.
 */
export function withResidentSpans(spans: ServedSpans, workspace: string, paths: Iterable<string>): Map<string, Array<readonly [number, number]>> {
  const delivered = new Map<string, Array<readonly [number, number]>>(
    [...spans].map(([spanPath, entries]) => [spanPath, [...entries]] as const),
  );
  for (const windowPath of new Set(paths)) {
    const resident = servedClusterRanges(workspace, windowPath).flatMap((range) => {
      const span = parseSurfaceSpan(range);
      return span === undefined ? [] : [[span.start, span.end] as [number, number]];
    });
    delivered.set(windowPath, [...(delivered.get(windowPath) ?? []), ...resident]);
  }
  return delivered;
}
