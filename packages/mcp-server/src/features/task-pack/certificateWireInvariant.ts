/**
 * WP-B (eval-0929 §5, §8) — A CERTIFICATE NEVER OUTLIVES ITS EVIDENCE.
 *
 * The invariant (eval-0929 §8): every requirement an `act.answer` certificate
 * lists is backed by evidence that reached the client — a body in this
 * response, or a residency an earlier call of the task established — or the
 * pack does not stay `act.answer`.
 *
 * WHY A SEPARATE CHECK IS NEEDED. The certificate is minted inside
 * `dedupeTrimAndPersist`, over the surfaces that exist at that moment. Several
 * answer-path passes run AFTER it and change the final surface set
 * (`buildAnswerTaskPack`'s post-trim tail: the import/anchor augmenters and
 * TL142-05's named-path size cap). Measured on v0.14.4 (eval-0929 §5): "In
 * src/policy.ts, explain all conditions of shouldRetry, including the actual
 * values in TRANSIENT_CODES." — the facet gate certified the value from
 * `src/constants.ts:1-1`, then the named-path cap removed that surface because
 * it is not the named file, and the certificate shipped with its value
 * evidence gone and no disclosure. Nothing re-checked it.
 *
 * WHAT A CERTIFICATE CITES. Every PROVED obligation carries the evidence
 * windows that proved it (`TaskReadinessObligation.evidence`). How much of that
 * list the claim DEPENDS on differs by obligation, and this module states it
 * once, for both the prevention (a post-certification remover asks
 * `wouldIntroduceBreach` before removing anything) and the check
 * (`certificateWireBreaches` after the last remover):
 *
 *   - `every` — a `request-item:*` obligation (a facet requirement: the value /
 *     condition / callers / flow windows the facet gate required; or an
 *     explicit request item): each cited window is part of the proof, so
 *     losing any of it breaks the claim.
 *   - `any` — every other obligation (`identifier:*`, `surface-content`,
 *     `behavior-body`, enumerated items, ...): the evidence list is the set of
 *     served surfaces that SHOW the fact, so the claim stands while at least
 *     one of them still does.
 *   - a `required` surface is load-bearing whatever cites it: `surface-content`
 *     proves that every required surface carries served content, which a
 *     removal of one falsifies.
 *
 * WHAT COUNTS AS LOST. Only lines THIS response carried in a body when the
 * certificate was minted (`certified`) and no longer carries (`final`). A cited
 * window credited from an earlier call's residency was never this response's
 * to lose, and lines no body ever carried were already the certificate
 * builder's own decision — this module adjudicates only what a later pass
 * withdrew.
 *
 * Pure: every input is data the caller computed (spans come from
 * `packServedSpans`, the one projection of "what this response ships"), so the
 * checker is testable without a workspace.
 */
import type { TaskExecutionContract } from "@tokenlighten/types";

/** Line spans per workspace-relative path, 1-based inclusive — `packServedSpans`' shape. */
export type ServedSpans = ReadonlyMap<string, ReadonlyArray<readonly [number, number]>>;

/** One evidence window a certificate cites, in file coordinates. */
export interface CitedWindow {
  readonly handle: string;
  readonly path: string;
  readonly spans: ReadonlyArray<readonly [number, number]>;
}

/** How an obligation's cited windows back its claim (see the module header). */
export type CitationMode = "every" | "any";

export interface CertificateCitation {
  readonly obligationId: string;
  readonly mode: CitationMode;
  readonly windows: readonly CitedWindow[];
}

/** A cited window whose lines this response carried at certification and no longer carries. */
export interface CertificateWireBreach {
  readonly obligationId: string;
  readonly handle: string;
  readonly path: string;
  /** The withdrawn lines, merged, as `[start, end]` pairs. */
  readonly lost: ReadonlyArray<readonly [number, number]>;
}

/** A certification-time surface, as far as this module needs one. */
export interface CertifiedSurface {
  readonly handle: string;
  readonly path: string;
  readonly range: string;
  readonly required?: boolean;
  readonly shipped: boolean;
}

/**
 * WP-H (eval-0929 §5/§8, wire budget shedding): exported so
 * `protocol/budget/actFloor.ts` can read the SAME obligation-id rule this
 * module uses for `every`/`any` — the wire's `CertificateRef` carries only
 * bare obligation id strings (`decision.ts`'s A.2.4: `obligations: string[]`),
 * never per-obligation evidence, so the ONLY per-obligation signal that
 * survives to that layer is the id's own prefix. Reusing the exact constant
 * (never a second string literal) is what keeps the wire-level citation and
 * this module's citation the SAME notion of "cited".
 */
export const REQUEST_ITEM_OBLIGATION_PREFIX = "request-item:";

/**
 * Parse an evidence `range`: `"a-b"`, or the comma-joined list a carried
 * (ledger-reconstructed) surface uses (`"1-4,9-12"`). Anything else yields no
 * span — an unaddressable window cannot be judged lost.
 */
export function parseCitedSpans(range: string | undefined): Array<[number, number]> {
  if (typeof range !== "string") return [];
  const spans: Array<[number, number]> = [];
  for (const part of range.split(",")) {
    const match = /^\s*(\d+)-(\d+)\s*$/.exec(part);
    if (match === null) continue;
    const start = Number(match[1]);
    const end = Number(match[2]);
    if (Number.isInteger(start) && Number.isInteger(end) && start >= 1 && end >= start) spans.push([start, end]);
  }
  return spans;
}

/**
 * The citations of the ACCEPTED certificate on `contract` (none when it carries
 * none — nothing is certified, so nothing can outlive its evidence).
 *
 * THE COMPACTED FORM. A pack over its byte cap ships the certificate through
 * `contractForTrim`/`certificateBindingFor`, which drop every obligation's
 * `evidence` and keep only the flat `evidence_handles`. Per-obligation modes are
 * then unknowable, so every cited handle is treated as load-bearing (`every`) —
 * the conservative direction for both the check and the prevention.
 */
export function certificateCitations(
  contract: TaskExecutionContract | undefined,
  surfaces: readonly CertifiedSurface[],
): CertificateCitation[] {
  const certificate = contract?.readiness_certificate;
  if (certificate === undefined) return [];
  const proved = certificate.obligations.filter((obligation) => obligation.status === "proved");
  const citations: CertificateCitation[] = [];
  for (const obligation of proved) {
    const windows = (obligation.evidence ?? []).flatMap((item) => {
      const spans = parseCitedSpans(item.range);
      return spans.length > 0 && typeof item.path === "string" && item.path !== ""
        ? [{ handle: item.handle, path: item.path, spans }]
        : [];
    });
    if (windows.length === 0) continue;
    citations.push({
      obligationId: obligation.id,
      mode: obligation.id.startsWith(REQUEST_ITEM_OBLIGATION_PREFIX) ? "every" : "any",
      windows,
    });
  }
  const shippedByHandle = new Map(surfaces.filter((surface) => surface.shipped).map((surface) => [surface.handle, surface] as const));
  const windowOf = (surface: CertifiedSurface): CitedWindow[] => {
    const spans = parseCitedSpans(surface.range);
    return spans.length > 0 ? [{ handle: surface.handle, path: surface.path, spans }] : [];
  };
  const perObligationEvidence = proved.some((obligation) => (obligation.evidence?.length ?? 0) > 0);
  if (!perObligationEvidence) {
    const windows = (certificate.evidence_handles ?? []).flatMap((handle) => {
      const surface = shippedByHandle.get(handle);
      return surface === undefined ? [] : windowOf(surface);
    });
    if (windows.length > 0) citations.push({ obligationId: "certificate", mode: "every", windows });
  }
  if (proved.some((obligation) => obligation.id === "surface-content")) {
    const windows = surfaces.filter((surface) => surface.shipped && surface.required === true).flatMap(windowOf);
    if (windows.length > 0) citations.push({ obligationId: "surface-content", mode: "every", windows });
  }
  return citations;
}

function mergeSpans(spans: ReadonlyArray<readonly [number, number]>): Array<[number, number]> {
  const sorted = [...spans].map(([start, end]) => [start, end] as [number, number]).sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const [start, end] of sorted) {
    const last = merged[merged.length - 1];
    if (last !== undefined && start <= last[1] + 1) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

/** `spans ∩ within`, merged. */
function intersectSpans(
  spans: ReadonlyArray<readonly [number, number]>,
  within: ReadonlyArray<readonly [number, number]>,
): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const [start, end] of spans) {
    for (const [wStart, wEnd] of within) {
      const lo = Math.max(start, wStart);
      const hi = Math.min(end, wEnd);
      if (lo <= hi) out.push([lo, hi]);
    }
  }
  return mergeSpans(out);
}

/** `spans \ minus`, merged. */
function subtractSpans(
  spans: ReadonlyArray<readonly [number, number]>,
  minus: ReadonlyArray<readonly [number, number]>,
): Array<[number, number]> {
  const holes = mergeSpans(minus);
  const out: Array<[number, number]> = [];
  for (const [start, end] of mergeSpans(spans)) {
    let cursor = start;
    for (const [hStart, hEnd] of holes) {
      if (hEnd < cursor || hStart > end) continue;
      if (hStart > cursor) out.push([cursor, hStart - 1]);
      cursor = Math.max(cursor, hEnd + 1);
      if (cursor > end) break;
    }
    if (cursor <= end) out.push([cursor, end]);
  }
  return out;
}

/** The lines of `window` this response carried at certification and no longer carries. */
function lostLines(window: CitedWindow, certified: ServedSpans, final: ServedSpans): Array<[number, number]> {
  const carried = intersectSpans(window.spans, certified.get(window.path) ?? []);
  if (carried.length === 0) return [];
  return subtractSpans(carried, final.get(window.path) ?? []);
}

/**
 * THE CHECK: every cited window whose withdrawal breaks its obligation's claim
 * (see the module header for `every`/`any`). Empty means the certificate still
 * stands on what this response delivers.
 */
export function certificateWireBreaches(
  citations: readonly CertificateCitation[],
  certified: ServedSpans,
  final: ServedSpans,
): CertificateWireBreach[] {
  const breaches: CertificateWireBreach[] = [];
  for (const citation of citations) {
    const losses = citation.windows.map((window) => ({ window, lost: lostLines(window, certified, final) }));
    const broken = citation.mode === "every"
      ? losses.filter((entry) => entry.lost.length > 0)
      : losses.every((entry) => entry.lost.length > 0) ? losses : [];
    for (const { window, lost } of broken) {
      breaches.push({ obligationId: citation.obligationId, handle: window.handle, path: window.path, lost });
    }
  }
  return breaches;
}

function breachKey(breach: CertificateWireBreach): string {
  return `${breach.obligationId}|${breach.handle}|${breach.path}`;
}

/**
 * THE PREVENTION: does moving from `before` to `after` (a post-certification
 * pass removing or narrowing a surface) break a citation that `before` still
 * satisfied? A remover asks this before it removes anything, so the check
 * below it never has anything to catch in the organic path.
 */
export function wouldIntroduceBreach(
  citations: readonly CertificateCitation[],
  certified: ServedSpans,
  before: ServedSpans,
  after: ServedSpans,
): boolean {
  if (citations.length === 0) return false;
  const existing = new Set(certificateWireBreaches(citations, certified, before).map(breachKey));
  return certificateWireBreaches(citations, certified, after).some((breach) => !existing.has(breachKey(breach)));
}

/** `[start, end]` pairs as the wire's `"a-b"` range strings. */
export function spanRanges(spans: ReadonlyArray<readonly [number, number]>): string[] {
  return spans.map(([start, end]) => `${start}-${end}`);
}

// ---------------------------------------------------------------------------
// R2-T1 (eval-0929 review P0-3 / P1-1) — THE RESTORING READ.
//
// A post-certification pass that must withdraw cited lines (the byte-budget
// tiers of `dedupeTrimAndPersist` under a client / caller ceiling) cannot keep
// the certificate; the honest response is `discover` with ONE read that gives
// the client back everything the breached citations need. These two helpers
// name that read; `readCodeTaskPack.ts`'s `enforceCeilingCertificateInvariant`
// is their caller.
// ---------------------------------------------------------------------------

/** The windows of `citations` that `breaches` name, as citations (same obligation, same mode). */
export function breachedCitations(
  citations: readonly CertificateCitation[],
  breaches: readonly CertificateWireBreach[],
): CertificateCitation[] {
  const keys = new Set(breaches.map(breachKey));
  return citations.flatMap((citation) => {
    const windows = citation.windows.filter((window) =>
      keys.has(breachKey({ obligationId: citation.obligationId, handle: window.handle, path: window.path, lost: [] })));
    return windows.length === 0 ? [] : [{ ...citation, windows }];
  });
}

/** What a restoring read must name: see `unservedCitedWindows`. */
export interface UnservedCitedWindows {
  /** Merged per path, paths in first-citation order. */
  readonly windows: ReadonlyArray<{ readonly path: string; readonly start: number; readonly end: number }>;
  /** Every obligation one of `windows` belongs to, first-citation order. */
  readonly obligationIds: readonly string[];
}

/**
 * Every line of `citations`' windows the client does not hold — `delivered` is
 * this response's bodies plus what an earlier call of the task left resident.
 *
 * THE WHOLE WINDOW, NOT ONLY THE WITHDRAWN LINES (`CertificateWireBreach.lost`).
 * A cited window's lines no body carried at certification were disclosed by
 * the row that carried the rest (its `remaining`); a pass that removed that row
 * removed the disclosure with it. So the read that restores a cut callable
 * body names the rest of its cited window — the declaration the question is
 * about — not only the lines this response happened to lose.
 */
export function unservedCitedWindows(
  citations: readonly CertificateCitation[],
  delivered: ServedSpans,
): UnservedCitedWindows {
  const byPath = new Map<string, Array<[number, number]>>();
  const obligationIds = new Set<string>();
  for (const citation of citations) {
    for (const window of citation.windows) {
      const unserved = subtractSpans(window.spans, delivered.get(window.path) ?? []);
      if (unserved.length === 0) continue;
      obligationIds.add(citation.obligationId);
      byPath.set(window.path, [...(byPath.get(window.path) ?? []), ...unserved]);
    }
  }
  return {
    windows: [...byPath].flatMap(([path, spans]) => mergeSpans(spans).map(([start, end]) => ({ path, start, end }))),
    obligationIds: [...obligationIds],
  };
}
