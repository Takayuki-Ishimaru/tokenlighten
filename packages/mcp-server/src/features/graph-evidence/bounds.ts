// ---------------------------------------------------------------------------
// graph-evidence/bounds.ts — V11-01 bounded expansion.
//
// Plan §V11-01: "edge depth、type、fan-out、bytes、provider timeout を bounded に
// する" and 受入基準 "graph explosion fixture で budget／fan-out cap を超えない".
//
// THE RULE THIS FILE EXISTS TO ENFORCE
// ------------------------------------
// Every bound is a REQUIRED input. There is no default, no `?? Infinity`, no
// "unset means unlimited". `validateBounds()` rejects a non-finite, non-
// integral, or non-positive budget before a single node is expanded, so the
// dense-graph failure mode named in the plan's 副作用 section cannot be reached
// by forgetting a field.
//
// And truncation is never silent. When a bound bites, the tracker records the
// reason, where it bit, and how much was dropped; `coverageUnderTruncation()`
// then degrades coverage so a truncated expansion can never be reported as
// `complete`.
//
// DETERMINISTIC. The only ambient input is the clock, which is INJECTED
// (`now`), so a spec can drive the duration bound without sleeping.
// ---------------------------------------------------------------------------

import { weakerCoverage, type Coverage } from "./model.js";

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

/** Every field mandatory. See this file's header for why. */
export interface ExpansionBounds {
  /** Maximum distinct nodes admitted into the result, seeds included. */
  readonly maxNodes: number;
  /** Maximum hop distance from a seed. */
  readonly maxDepth: number;
  /** Maximum edges followed out of any single node. */
  readonly maxFanout: number;
  /** Maximum estimated byte cost of the admitted node set. */
  readonly maxBytes: number;
  /** Wall-clock ceiling for the whole expansion, provider calls included. */
  readonly maxDurationMs: number;
}

export const BOUND_FIELDS: readonly (keyof ExpansionBounds)[] = [
  "maxNodes",
  "maxDepth",
  "maxFanout",
  "maxBytes",
  "maxDurationMs",
];

/**
 * Reject anything that is not a positive, finite integer — `Infinity`, `NaN`,
 * `0`, negatives, and fractions all throw. An unbounded expansion is not a
 * configuration this module offers.
 */
export function validateBounds(bounds: ExpansionBounds): void {
  for (const field of BOUND_FIELDS) {
    const value = bounds[field];
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new RangeError(`graph-evidence bounds: ${field} must be a finite number (got ${String(value)})`);
    }
    if (!Number.isInteger(value)) {
      throw new RangeError(`graph-evidence bounds: ${field} must be an integer (got ${value})`);
    }
    if (value < 1) {
      throw new RangeError(`graph-evidence bounds: ${field} must be >= 1 (got ${value})`);
    }
  }
}

// ---------------------------------------------------------------------------
// Truncation reporting
// ---------------------------------------------------------------------------

export type TruncationReason =
  | "max-nodes"
  | "max-depth"
  | "max-fanout"
  | "max-bytes"
  | "max-duration";

export const TRUNCATION_REASONS: readonly TruncationReason[] = [
  "max-nodes",
  "max-depth",
  "max-fanout",
  "max-bytes",
  "max-duration",
];

export interface TruncationDetail {
  readonly reason: TruncationReason;
  /** Where the bound bit — a node id, or "<expansion>" for whole-run bounds. */
  readonly at: string;
  /** How many candidates were dropped at that point. */
  readonly dropped: number;
  readonly limit: number;
}

export interface TruncationReport {
  readonly truncated: boolean;
  readonly counts: Readonly<Record<TruncationReason, number>>;
  readonly details: readonly TruncationDetail[];
  /** The detail list itself is bounded; this says whether it was cut. */
  readonly detailsTruncated: boolean;
}

export const MAX_TRUNCATION_DETAILS = 32;

function zeroTruncationCounts(): Record<TruncationReason, number> {
  return {
    "max-nodes": 0,
    "max-depth": 0,
    "max-fanout": 0,
    "max-bytes": 0,
    "max-duration": 0,
  };
}

export const EMPTY_TRUNCATION_REPORT: TruncationReport = {
  truncated: false,
  counts: zeroTruncationCounts(),
  details: [],
  detailsTruncated: false,
};

/**
 * Plan 副作用を抑える方法: a truncated expansion is NEVER complete. `unknown`
 * stays `unknown` — it is already weaker than `partial`.
 */
export function coverageUnderTruncation(base: Coverage, report: TruncationReport): Coverage {
  return report.truncated ? weakerCoverage(base, "partial") : base;
}

// ---------------------------------------------------------------------------
// Tracker
// ---------------------------------------------------------------------------

export interface BoundTrackerOptions {
  readonly bounds: ExpansionBounds;
  /** Injected clock. Defaults to `Date.now`; specs pass a fake. */
  readonly now?: () => number;
}

/** Whole-run bounds report against this label rather than a node id. */
export const EXPANSION_SCOPE = "<expansion>";

/**
 * The budget holder for one expansion. Every admission goes through it, so
 * "was the cap respected?" is answerable from `nodesAdmitted`/`bytesCharged`
 * alone, and "what did we lose?" from `report()`.
 */
export class BoundTracker {
  readonly bounds: ExpansionBounds;

  private readonly now: () => number;
  private readonly startedAt: number;
  private readonly counts = zeroTruncationCounts();
  private readonly details: TruncationDetail[] = [];
  private detailsTruncated = false;
  private nodes = 0;
  private bytes = 0;
  private expiredLatched = false;

  constructor(options: BoundTrackerOptions) {
    validateBounds(options.bounds);
    this.bounds = options.bounds;
    this.now = options.now ?? Date.now;
    this.startedAt = this.now();
  }

  get nodesAdmitted(): number {
    return this.nodes;
  }

  get bytesCharged(): number {
    return this.bytes;
  }

  get truncated(): boolean {
    return this.details.length > 0 || this.detailsTruncated;
  }

  private record(reason: TruncationReason, at: string, dropped: number, limit: number): void {
    this.counts[reason] += 1;
    if (this.details.length < MAX_TRUNCATION_DETAILS) {
      this.details.push({ reason, at, dropped, limit });
    } else {
      this.detailsTruncated = true;
    }
  }

  /**
   * Admit one node at `byteCost`. Charges the node and byte budgets together —
   * a node is either fully admitted or not admitted at all, so the byte total
   * can never overshoot by a partially-charged node.
   */
  admitNode(byteCost: number, at: string): boolean {
    if (this.nodes >= this.bounds.maxNodes) {
      this.record("max-nodes", at, 1, this.bounds.maxNodes);
      return false;
    }
    const cost = Number.isFinite(byteCost) && byteCost > 0 ? Math.ceil(byteCost) : 1;
    if (this.bytes + cost > this.bounds.maxBytes) {
      this.record("max-bytes", at, 1, this.bounds.maxBytes);
      return false;
    }
    this.nodes += 1;
    this.bytes += cost;
    return true;
  }

  /** May the expansion continue to `depth`? */
  admitDepth(depth: number, at: string): boolean {
    if (depth > this.bounds.maxDepth) {
      this.record("max-depth", at, 1, this.bounds.maxDepth);
      return false;
    }
    return true;
  }

  /** Cut a node's out-edges to `maxFanout`, recording what was dropped. */
  limitFanout<T>(items: readonly T[], at: string): readonly T[] {
    if (items.length <= this.bounds.maxFanout) return items;
    this.record("max-fanout", at, items.length - this.bounds.maxFanout, this.bounds.maxFanout);
    return items.slice(0, this.bounds.maxFanout);
  }

  /**
   * Has the duration budget run out? Latches on first expiry so one expansion
   * records the timeout once, however many times it is polled.
   */
  expired(at: string = EXPANSION_SCOPE): boolean {
    if (this.expiredLatched) return true;
    if (this.now() - this.startedAt >= this.bounds.maxDurationMs) {
      this.expiredLatched = true;
      this.record("max-duration", at, 0, this.bounds.maxDurationMs);
      return true;
    }
    return false;
  }

  report(): TruncationReport {
    return {
      truncated: this.truncated,
      counts: { ...this.counts },
      details: [...this.details],
      detailsTruncated: this.detailsTruncated,
    };
  }
}
