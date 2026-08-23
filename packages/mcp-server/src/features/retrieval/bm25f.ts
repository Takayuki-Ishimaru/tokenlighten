/**
 * retrieval/bm25f.ts — V10-08 Hybrid Retrieval v1: BM25F scoring.
 *
 * Field-weighted BM25 (Robertson/Zaragoza BM25F), implemented by hand — no
 * npm dependency (AGENTS.md's license gate; the design doc itself sizes this
 * at "~100 lines"). Field weights below started as the design doc's OWN
 * initial values ("field weightの初期値を...設定し、holdoutで調整する" —
 * V10-08 実装内容) and are now the holdout-tuned result — see
 * bench/workflows/retrieval/TUNING-2026-08-20.md for the corpus, sweep
 * method, and full before/after table.
 */

import type { FieldName, IndexUnit } from "./units.js";

/**
 * Field weights — the SHIPPED DEFAULT, holdout-tuned per
 * bench/workflows/retrieval/TUNING-2026-08-20.md (coordinate descent from
 * the design doc's original {4.0, 3.0, 2.5, 2.0, 1.5, 1.0} starting point;
 * path/doc/body held at their starting values — no holdout-tested
 * perturbation of those three beat the start). Every production call site
 * (the ONE real one: features/retrieval/index.ts's runBm25f, reached only
 * from locateTaskContext.ts when TL_BM25F_CANDIDATE is on) constructs
 * Bm25fIndex with NO options argument, so it always gets exactly this
 * vector — see Bm25fOptions below for the (tuner-only) override seam.
 *
 * qualifiedSymbol === symbolName is a holdout finding, not a typo: for a
 * non-nested declaration (no enclosing class/module — most of this
 * codebase's top-level functions, Go package-level funcs, Python module
 * functions) `qualified` reduces to the bare name, so the two fields' token
 * sets are IDENTICAL and the sweep found no benefit to ranking one above
 * the other. See bm25f.spec.ts's ordering test for the now->
 * toBeGreaterThanOrEqual assertion this justifies.
 */
export const FIELD_WEIGHTS: Record<FieldName, number> = {
  qualifiedSymbol: 6.0,
  symbolName: 6.0,
  path: 2.5,
  signature: 1.6,
  doc: 1.5,
  body: 1.0,
};

/** Standard Okapi BM25 term-frequency saturation constant. */
const K1 = 1.2;
/** Standard BM25 length-normalization constant (0 = no normalization, 1 = full). */
const B = 0.75;

interface Posting {
  unitIndex: number;
  weightedTf: number;
}

export interface Bm25fHit {
  unit: IndexUnit;
  score: number;
}

/**
 * Tuner-only weight override. NOT an env var / CLI flag — a plain
 * constructor argument nobody but bench/workflows/retrieval/tune-bm25f.mjs
 * ever passes (it drives the retrieval module through the built dist, one
 * field-weight vector per candidate under evaluation). Every field is
 * optional; an omitted field falls back to FIELD_WEIGHTS' own value for it,
 * so a partial override (e.g. tuning `body` alone) never silently zeroes the
 * other five fields.
 */
export interface Bm25fOptions {
  weights?: Partial<Record<FieldName, number>>;
}

function fieldWeightOf(field: FieldName, weights: Record<FieldName, number>): number {
  return weights[field] ?? 1;
}

/** BM25F combines fields BEFORE length normalization: weighted token count summed across fields. */
function weightedUnitLength(unit: IndexUnit, weights: Record<FieldName, number>): number {
  let total = 0;
  for (const field of Object.keys(unit.fields) as FieldName[]) {
    const tokens = unit.fields[field];
    if (!tokens) continue;
    total += fieldWeightOf(field, weights) * tokens.length;
  }
  return total;
}

export class Bm25fIndex {
  private readonly units: readonly IndexUnit[];
  private readonly weights: Record<FieldName, number>;
  private readonly unitLength: number[];
  private readonly avgUnitLength: number;
  /** term -> postings list (one entry per unit containing that term in any field). */
  private readonly postings = new Map<string, Posting[]>();

  constructor(units: readonly IndexUnit[], options?: Bm25fOptions) {
    this.units = units;
    // Default is FIELD_WEIGHTS itself (spread, not a reference) so a caller
    // mutating its own override object post-construction can never reach
    // back into this index — and the zero-arg call every production site
    // makes is byte-identical to the pre-Bm25fOptions constructor.
    this.weights = { ...FIELD_WEIGHTS, ...options?.weights };
    this.unitLength = units.map((unit) => weightedUnitLength(unit, this.weights));
    const totalLength = this.unitLength.reduce((a, b) => a + b, 0);
    this.avgUnitLength = units.length > 0 ? totalLength / units.length : 0;

    units.forEach((unit, unitIndex) => {
      // Combine per-field weighted term frequency BEFORE building postings —
      // one posting per (unit, term), not per (unit, field, term).
      const termWeighted = new Map<string, number>();
      for (const field of Object.keys(unit.fields) as FieldName[]) {
        const tokens = unit.fields[field];
        if (!tokens) continue;
        const weight = fieldWeightOf(field, this.weights);
        for (const term of tokens) {
          termWeighted.set(term, (termWeighted.get(term) ?? 0) + weight);
        }
      }
      for (const [term, weightedTf] of termWeighted) {
        let list = this.postings.get(term);
        if (!list) {
          list = [];
          this.postings.set(term, list);
        }
        list.push({ unitIndex, weightedTf });
      }
    });
  }

  get size(): number {
    return this.units.length;
  }

  private idf(term: string): number {
    const df = this.postings.get(term)?.length ?? 0;
    const n = this.units.length;
    if (n === 0) return 0;
    // BM25 IDF with +1 smoothing: always non-negative (the classic
    // Robertson-Sparck-Jones form goes negative once df > N/2, which would
    // let a common term PENALIZE a unit — wrong for a candidate-recall use).
    return Math.log(1 + (n - df + 0.5) / (df + 0.5));
  }

  /** Score every unit sharing >= 1 query term; returns hits sorted by score descending (ties broken by unit key for determinism). */
  score(queryTokens: readonly string[]): Bm25fHit[] {
    if (this.units.length === 0 || queryTokens.length === 0) return [];
    const scores = new Map<number, number>();
    for (const term of new Set(queryTokens)) {
      const list = this.postings.get(term);
      if (!list || list.length === 0) continue;
      const idf = this.idf(term);
      if (idf <= 0) continue;
      for (const { unitIndex, weightedTf } of list) {
        const length = this.unitLength[unitIndex] ?? 0;
        const norm = this.avgUnitLength > 0 ? length / this.avgUnitLength : 1;
        const denom = weightedTf + K1 * (1 - B + B * norm);
        const termScore = denom > 0 ? idf * ((weightedTf * (K1 + 1)) / denom) : 0;
        scores.set(unitIndex, (scores.get(unitIndex) ?? 0) + termScore);
      }
    }
    const hits: Bm25fHit[] = [];
    for (const [unitIndex, score] of scores) {
      if (score > 0) hits.push({ unit: this.units[unitIndex]!, score });
    }
    hits.sort((a, b) => b.score - a.score || a.unit.key.localeCompare(b.unit.key));
    return hits;
  }
}
