/**
 * entryHeldout.ts — shared item shape and scorer for the structure-map ENTRY
 * held-out sets (entryHeldout1.ts, entryHeldout2.ts; 2026-10-24).
 *
 * The structure map is served only when a request passes BOTH detectors:
 *   - `asksForStructureMap` (features/task-pack/structureMap.ts): the request
 *     asks for a short or map-shaped answer, and
 *   - a `flow` facet from `extractFacetRequirements`
 *     (features/task-pack/requestFacets.ts): the request asks for the order /
 *     sequence / flow of calls.
 * Every item carries a GOLD label for each of the two (adjudicated by the
 * author BEFORE the item was scored) and the scorer reports precision/recall of
 * each detector and of their conjunction (the entry).
 *
 * Why the two are scored separately as well as together: a false positive costs
 * differently on each side. A request wrongly judged map-shaped is answered
 * from the structure map's rows instead of the type's whole members (LESS
 * evidence than the question needed), so the map side is held to a precision
 * floor of 1.0 on the negatives. A request wrongly judged to ask for a flow
 * only makes the pack look for MORE evidence.
 */
import { asksForStructureMap } from "../../features/task-pack/structureMap.js";
import { extractFacetRequirements } from "../../features/task-pack/requestFacets.js";

export interface EntryHeldOutItem {
  readonly id: string;
  readonly lang: "en" | "ja";
  readonly text: string;
  /** GOLD: the request asks for a short, brief or map-shaped answer. */
  readonly map: boolean;
  /** GOLD: the request asks for the order / sequence / flow of calls or steps. */
  readonly flow: boolean;
  /** "audit" = one of the 16 paraphrases of the generality audit (§3.3.3) the rule design started from; "fresh" = written for the set. */
  readonly source: "audit" | "fresh";
  /** What the item exercises (for the report table only). */
  readonly category: string;
}

export interface DetectorStats {
  readonly tp: number;
  readonly fp: number;
  readonly fn: number;
  readonly tn: number;
  readonly precision: number;
  readonly recall: number;
}

export interface EntryScore {
  readonly map: DetectorStats;
  readonly flow: DetectorStats;
  readonly entry: DetectorStats;
  /** One line per disagreement between a detector and its gold label. */
  readonly misses: readonly string[];
  /** The ids whose predicted entry is true although the gold entry is false (the costly direction for `map`). */
  readonly entryFalsePositives: readonly string[];
}

export function predictedFlow(text: string): boolean {
  return extractFacetRequirements(text).some((requirement) => requirement.facet === "flow");
}

function stats(tp: number, fp: number, fn: number, tn: number): DetectorStats {
  return {
    tp, fp, fn, tn,
    precision: tp + fp === 0 ? 1 : tp / (tp + fp),
    recall: tp + fn === 0 ? 1 : tp / (tp + fn),
  };
}

export function scoreEntryHeldOut(items: readonly EntryHeldOutItem[]): EntryScore {
  const counts = {
    map: { tp: 0, fp: 0, fn: 0, tn: 0 },
    flow: { tp: 0, fp: 0, fn: 0, tn: 0 },
    entry: { tp: 0, fp: 0, fn: 0, tn: 0 },
  };
  const misses: string[] = [];
  const entryFalsePositives: string[] = [];
  const bump = (kind: "map" | "flow" | "entry", gold: boolean, predicted: boolean): "tp" | "fp" | "fn" | "tn" => {
    const key = gold ? (predicted ? "tp" : "fn") : (predicted ? "fp" : "tn");
    counts[kind][key] += 1;
    return key;
  };
  for (const item of items) {
    const map = asksForStructureMap(item.text);
    const flow = predictedFlow(item.text);
    const mapResult = bump("map", item.map, map);
    const flowResult = bump("flow", item.flow, flow);
    const entryResult = bump("entry", item.map && item.flow, map && flow);
    if (mapResult === "fp" || mapResult === "fn") misses.push(`${mapResult === "fp" ? "MAP+" : "MAP-"} ${item.id} [${item.category}] ${item.text}`);
    if (flowResult === "fp" || flowResult === "fn") misses.push(`${flowResult === "fp" ? "FLOW+" : "FLOW-"} ${item.id} [${item.category}] ${item.text}`);
    if (entryResult === "fp") entryFalsePositives.push(item.id);
  }
  return {
    map: stats(counts.map.tp, counts.map.fp, counts.map.fn, counts.map.tn),
    flow: stats(counts.flow.tp, counts.flow.fp, counts.flow.fn, counts.flow.tn),
    entry: stats(counts.entry.tp, counts.entry.fp, counts.entry.fn, counts.entry.tn),
    misses,
    entryFalsePositives,
  };
}

/** One printable row per detector: "map P=1.00 R=0.62 (tp 31 fp 0 fn 19 tn 80)". */
export function formatEntryScore(label: string, score: EntryScore): string {
  const row = (name: string, s: DetectorStats): string =>
    `${name} P=${s.precision.toFixed(2)} R=${s.recall.toFixed(2)} (tp ${s.tp} fp ${s.fp} fn ${s.fn} tn ${s.tn})`;
  return `${label}: ${row("map", score.map)} | ${row("flow", score.flow)} | ${row("entry", score.entry)}`;
}
