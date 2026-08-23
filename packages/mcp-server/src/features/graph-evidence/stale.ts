// ---------------------------------------------------------------------------
// graph-evidence/stale.ts — V11-01 generation / SHA stamping.
//
// Plan §V11-01 受入基準: "stale edge 0 件". This module is where that invariant
// is enforced, and it is enforced by CONSTRUCTION rather than by inspection:
// `filterStaleEdges()` returns a set from which every edge that cannot re-prove
// both of its stamps has been removed and counted, so a downstream result
// cannot contain a stale edge to begin with.
//
// FAIL-CLOSED. An edge is discarded when its generation or SHA MISMATCHES and
// equally when either is UNPROVABLE — an unstamped edge, a provider whose
// current generation the caller cannot supply, a path whose current digest the
// caller cannot supply. "We could not check" is not a pass; it is an
// exclusion, counted under its own reason so the caller can see it was a
// coverage problem and not a churn problem.
//
// PURE. No I/O, no clock. The caller supplies the current view; deviation E-1
// forbids this overlay from owning a daemon or a persistent store, so the
// freshness oracle is always an input.
// ---------------------------------------------------------------------------

import type { GraphEdge } from "./model.js";

// ---------------------------------------------------------------------------
// The freshness oracle
// ---------------------------------------------------------------------------

/**
 * The caller's view of "current". Both maps are authoritative: a key that is
 * ABSENT means the caller cannot prove freshness for it, which fails closed.
 */
export interface GenerationView {
  /** provider id → the provider's current index generation. */
  readonly generations: ReadonlyMap<string, string>;
  /** workspace-relative path → the file's current content digest. */
  readonly sourceShas: ReadonlyMap<string, string>;
}

export function makeGenerationView(
  generations: Iterable<readonly [string, string]>,
  sourceShas: Iterable<readonly [string, string]>,
): GenerationView {
  return { generations: new Map(generations), sourceShas: new Map(sourceShas) };
}

// ---------------------------------------------------------------------------
// Exclusion reasons
// ---------------------------------------------------------------------------

export type StaleReason =
  /** The edge itself carries no stamp — it was never provable. */
  | "edge-unstamped"
  /** The provider moved to a different generation. */
  | "generation-mismatch"
  /** The caller cannot say what generation the provider is on. */
  | "generation-unknown"
  /** The proving file's content changed. */
  | "source-sha-mismatch"
  /** The caller cannot say what the proving file's digest is. */
  | "source-sha-unknown";

export const STALE_REASONS: readonly StaleReason[] = [
  "edge-unstamped",
  "generation-mismatch",
  "generation-unknown",
  "source-sha-mismatch",
  "source-sha-unknown",
];

export interface StaleExclusion {
  readonly edge: GraphEdge;
  readonly reason: StaleReason;
  /** What the current view says (empty when unknown). */
  readonly expected: string;
  /** What the edge carried. */
  readonly found: string;
}

export interface StaleReport {
  /** Total edges removed. The `stale edge 0` invariant is about what SURVIVES. */
  readonly excluded: number;
  readonly counts: Readonly<Record<StaleReason, number>>;
  /** Bounded sample, for telemetry and review. */
  readonly samples: readonly StaleExclusion[];
  readonly samplesTruncated: boolean;
}

export const MAX_STALE_SAMPLES = 16;

function zeroCounts(): Record<StaleReason, number> {
  return {
    "edge-unstamped": 0,
    "generation-mismatch": 0,
    "generation-unknown": 0,
    "source-sha-mismatch": 0,
    "source-sha-unknown": 0,
  };
}

export const EMPTY_STALE_REPORT: StaleReport = {
  excluded: 0,
  counts: zeroCounts(),
  samples: [],
  samplesTruncated: false,
};

// ---------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------

/**
 * Why this edge is stale, or `undefined` when it re-proves both stamps.
 *
 * Order matters: an unstamped edge is reported as unstamped rather than as a
 * mismatch, because the two say different things about the producing provider.
 */
export function staleReasonFor(edge: GraphEdge, view: GenerationView): StaleReason | undefined {
  if (edge.indexGeneration === "" || edge.sourceSha === "" || edge.sourceShaPath === "") {
    return "edge-unstamped";
  }
  const currentGeneration = view.generations.get(edge.provider);
  if (currentGeneration === undefined) return "generation-unknown";
  if (currentGeneration !== edge.indexGeneration) return "generation-mismatch";

  const currentSha = view.sourceShas.get(edge.sourceShaPath);
  if (currentSha === undefined) return "source-sha-unknown";
  if (currentSha !== edge.sourceSha) return "source-sha-mismatch";

  return undefined;
}

export function isFreshEdge(edge: GraphEdge, view: GenerationView): boolean {
  return staleReasonFor(edge, view) === undefined;
}

export interface StaleFilterResult {
  /** Guaranteed to contain ZERO stale edges — the plan's `stale edge 0` row. */
  readonly fresh: readonly GraphEdge[];
  readonly report: StaleReport;
}

export interface StaleFilterOptions {
  readonly maxSamples?: number;
}

/**
 * Remove every edge that cannot re-prove its generation and source digest, and
 * count what went, by reason.
 */
export function filterStaleEdges(
  edges: readonly GraphEdge[],
  view: GenerationView,
  options: StaleFilterOptions = {},
): StaleFilterResult {
  const maxSamples = options.maxSamples ?? MAX_STALE_SAMPLES;
  const fresh: GraphEdge[] = [];
  const counts = zeroCounts();
  const samples: StaleExclusion[] = [];
  let excluded = 0;
  let samplesTruncated = false;

  for (const edge of edges) {
    const reason = staleReasonFor(edge, view);
    if (reason === undefined) {
      fresh.push(edge);
      continue;
    }
    excluded += 1;
    counts[reason] += 1;
    if (samples.length < maxSamples) {
      samples.push({
        edge,
        reason,
        expected: expectedFor(reason, edge, view),
        found: foundFor(reason, edge),
      });
    } else {
      samplesTruncated = true;
    }
  }

  return {
    fresh,
    report: { excluded, counts, samples, samplesTruncated },
  };
}

function expectedFor(reason: StaleReason, edge: GraphEdge, view: GenerationView): string {
  switch (reason) {
    case "generation-mismatch":
      return view.generations.get(edge.provider) ?? "";
    case "source-sha-mismatch":
      return view.sourceShas.get(edge.sourceShaPath) ?? "";
    case "edge-unstamped":
    case "generation-unknown":
    case "source-sha-unknown":
      return "";
  }
}

function foundFor(reason: StaleReason, edge: GraphEdge): string {
  switch (reason) {
    case "generation-mismatch":
    case "generation-unknown":
      return edge.indexGeneration;
    case "source-sha-mismatch":
    case "source-sha-unknown":
      return edge.sourceSha;
    case "edge-unstamped":
      return `${edge.indexGeneration}|${edge.sourceSha}|${edge.sourceShaPath}`;
  }
}

export function mergeStaleReports(a: StaleReport, b: StaleReport): StaleReport {
  const counts = zeroCounts();
  for (const reason of STALE_REASONS) {
    counts[reason] = a.counts[reason] + b.counts[reason];
  }
  const samples = [...a.samples, ...b.samples].slice(0, MAX_STALE_SAMPLES);
  return {
    excluded: a.excluded + b.excluded,
    counts,
    samples,
    samplesTruncated:
      a.samplesTruncated || b.samplesTruncated || a.samples.length + b.samples.length > MAX_STALE_SAMPLES,
  };
}
