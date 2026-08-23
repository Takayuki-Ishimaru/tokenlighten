// ---------------------------------------------------------------------------
// protocol v1 -- shared shape-detection helpers (V10-11).
//
// Kept separate from `types.ts` (the codec contract) and from `tlTable1.ts`
// (one codec's own extraction) because `policy.ts`'s row-count gain gate
// needs the SAME "how many rows would a table give us" answer regardless of
// which codec ends up winning, without importing a specific codec module.
// ---------------------------------------------------------------------------

import type { Kind } from "@tokenlighten/types";
import { isNonEmptyObjectArray, isPlainObject, type CodecPayload } from "./types.js";

/** The `{columns: string[], rows: unknown[][]}` shape read.artifact's
 *  `xlsx.table`/`csv` forms (and `xlsx.roster`'s `inlined`) use -- every row
 *  the same length as `columns`. */
export function isPositionalRowsShape(
  container: CodecPayload,
): container is CodecPayload & { columns: string[]; rows: unknown[][] } {
  const columns = container["columns"];
  const rows = container["rows"];
  if (!Array.isArray(columns) || !columns.every((c) => typeof c === "string")) return false;
  if (!Array.isArray(rows)) return false;
  return rows.every((r) => Array.isArray(r) && r.length === columns.length);
}

/**
 * Sum of the lengths of every qualifying tabular region found anywhere in
 * `payload` (uniform non-empty object arrays, and `{columns,rows}`
 * positional tables) -- used ONLY for `policy.ts`'s minimum-row-count gain
 * gate. A codec's own `canEncode` remains the sole source of truth for
 * whether it can actually represent the payload.
 */
export function countUniformArrayRows(payload: unknown): number {
  let total = 0;
  const visit = (value: unknown): void => {
    if (isNonEmptyObjectArray(value)) {
      total += value.length;
      return;
    }
    if (Array.isArray(value)) {
      for (const el of value) visit(el);
      return;
    }
    if (isPlainObject(value)) {
      for (const [key, v] of Object.entries(value)) {
        if (key === "rows" && isPositionalRowsShape(value)) {
          total += value["rows"].length;
          continue;
        }
        visit(v);
      }
    }
  };
  visit(payload);
  return total;
}

// ---------------------------------------------------------------------------
// V11-07 addendum -- shape CLASSES for the break-even table (breakeven.ts).
//
// Additive to the module above: `countUniformArrayRows`/`isPositionalRowsShape`
// answer "how many rows", this answers "what KIND of payload is this",
// coarsely enough to stay a small, finite Map key component, never a
// per-payload-specific bucket. Two independent axes, collapsed into one
// enum so a breakeven cell key stays a flat string:
//   - a dominant single string field big enough to matter (tl-raw-1's own
//     territory -- reimplemented locally, `longestStringFieldLength` below,
//     rather than importing tlRaw1.ts's own `bodyFieldOf`, so this module
//     keeps its stated invariant of never depending on one specific codec's
//     module), OR
//   - a uniform-rows payload, banded by row count, further split by whether
//     the sampled cell values are mostly numeric (tables of measurements)
//     or not (tables of names/paths/identifiers) -- gain characteristics
//     differ enough between the two that a single row-count band would
//     cover both badly.
// ---------------------------------------------------------------------------

export type ShapeClass =
  | "none"
  | "string-heavy"
  | "rows-small-numeric"
  | "rows-small-mixed"
  | "rows-medium-numeric"
  | "rows-medium-mixed"
  | "rows-large-numeric"
  | "rows-large-mixed";

/** Byte length past which a single dominant string field is "big enough to matter" for shape classification -- a classification cutoff only, not a codec eligibility gate (tl-raw-1's own `canEncode` has no minimum size). */
const STRING_HEAVY_MIN_LENGTH = 200;

const ROW_BAND_SMALL_MAX = 9;
const ROW_BAND_MEDIUM_MAX = 49;

/** Local re-derivation of "the biggest string field" -- see the module header for why this is not imported from tlRaw1.ts. */
function longestStringFieldLength(payload: CodecPayload): number {
  let best = 0;
  for (const value of Object.values(payload)) {
    if (typeof value === "string" && value.length > best) best = value.length;
  }
  return best;
}

/**
 * D1 (F-C2b) -- the read.text-only nested counterpart of
 * `longestStringFieldLength` above. A real `read.text` payload's dominant
 * text lives at `evidence[i].body` (protocol/readFamily.ts's
 * `ReadTextResult`), never in a top-level field -- without this,
 * `classifyShape` always mis-sees a single-window read.text response as a
 * small "rows" table (`evidence` IS a non-empty object array to
 * `countUniformArrayRows` below) instead of "string-heavy", and the
 * registered `read.text`/`string-heavy` breakeven cell (breakeven.ts) is
 * never looked up -- eligibility that V11-07 wired but tlRaw1.ts's own
 * top-level-only `bodyFieldOf` (now `locateDominantBody`) could never
 * actually reach.
 *
 * Local re-derivation, same reasoning as `longestStringFieldLength`: this
 * module never imports one specific codec's module. KEPT IN SYNC BY HAND
 * with tlRaw1.ts's `singleEvidenceBodyIndex` -- both must agree on when a
 * payload has exactly one dominant nested body. Zero or several
 * body-bearing evidence entries return 0 (not this classification), same
 * "multi-body payloads stay ineligible" rule tlRaw1.ts applies.
 */
function dominantEvidenceBodyLength(payload: CodecPayload): number {
  const evidence = payload["evidence"];
  if (!Array.isArray(evidence)) return 0;
  let bodyLen = -1;
  for (const entry of evidence) {
    if (!isPlainObject(entry)) continue;
    const body = entry["body"];
    if (typeof body !== "string") continue;
    if (bodyLen !== -1) return 0; // more than one body-bearing entry -- not this classification
    bodyLen = body.length;
  }
  return bodyLen === -1 ? 0 : bodyLen;
}

/** True when at least `threshold` of the SAMPLED scalar cell values across every qualifying row are numbers (null/boolean cells are skipped -- neither numeric nor stringy, so they are not informative either way). */
function isNumericDominant(payload: unknown, threshold = 0.6): boolean {
  let numeric = 0;
  let total = 0;
  const sampleRow = (row: unknown): void => {
    const values = isPlainObject(row) ? Object.values(row) : Array.isArray(row) ? row : undefined;
    if (values === undefined) return;
    for (const v of values) {
      if (v === null || typeof v === "boolean") continue;
      total += 1;
      if (typeof v === "number") numeric += 1;
    }
  };
  const visit = (value: unknown): void => {
    if (isNonEmptyObjectArray(value)) {
      for (const row of value) sampleRow(row);
      return;
    }
    if (Array.isArray(value)) {
      for (const el of value) visit(el);
      return;
    }
    if (isPlainObject(value)) {
      for (const [key, v] of Object.entries(value)) {
        if (key === "rows" && isPositionalRowsShape(value)) {
          for (const row of value["rows"]) sampleRow(row);
          continue;
        }
        visit(v);
      }
    }
  };
  visit(payload);
  if (total === 0) return false;
  return numeric / total >= threshold;
}

/**
 * Classifies `payload` into one of the finite shape classes above -- pure and
 * deterministic (same payload/kind, same class, every time), used as a
 * breakeven cell key component.
 *
 * `kind` gates D1's nested-evidence check to `read.text` ONLY (the sole
 * `V2_WIDENED_KIND`, selectV2.ts) -- no other reachable kind's payload has an
 * `evidence` field (search.matches/search.references/read.map/read.batch/
 * read.artifact use `matches`/`references`/`outline`/`entries`/`content`;
 * read.task_pack's own `evidence` field is HARD_JSON_FIXED and never reaches
 * this function), so the gate is defence in depth against a future field
 * name collision rather than a live ambiguity today.
 */
export function classifyShape(payload: CodecPayload, kind: Kind): ShapeClass {
  const dominantLength = Math.max(
    longestStringFieldLength(payload),
    kind === "read.text" ? dominantEvidenceBodyLength(payload) : 0,
  );
  if (dominantLength >= STRING_HEAVY_MIN_LENGTH) return "string-heavy";
  const rows = countUniformArrayRows(payload);
  if (rows === 0) return "none";
  const numeric = isNumericDominant(payload);
  if (rows <= ROW_BAND_SMALL_MAX) return numeric ? "rows-small-numeric" : "rows-small-mixed";
  if (rows <= ROW_BAND_MEDIUM_MAX) return numeric ? "rows-medium-numeric" : "rows-medium-mixed";
  return numeric ? "rows-large-numeric" : "rows-large-mixed";
}
