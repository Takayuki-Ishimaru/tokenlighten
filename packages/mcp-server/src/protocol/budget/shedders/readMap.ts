// ---------------------------------------------------------------------------
// protocol v1 — the `read.map` shed ladder (P3a S3).
//
// NORMATIVE SOURCE: TL-PROTOCOL-V1-PHASE3A-PLAN-DRAFT.md §5.3, §5.7;
// DESIGN-v0.10-protocol-v1-contract-freeze.md A.5.3 (six forms), A.6.2,
// A.8.1 E-7; erratum E1 (rung 6).
//
// LADDER: 1 (prose inside `outline`) -> 6 (drop whole `files[]` / `surfaces[]`
// entries, FLOOR ONE ENTRY).
//
// THE SHEDDER DISPATCHES ON `outline.form` ([R4-4]): the required set is stated
// per form, so what may be dropped is too. `signatures`, `digest`, `markdown`
// and `overview` register NO rung-6 step — see `SHED_ELIGIBLE_FORMS` below for
// the per-form argument, which is the same kind of argument A.5.3's own
// per-form table makes.
// ---------------------------------------------------------------------------

import type { ToolCall } from "@tokenlighten/types";

import { emittableToolCall } from "../../refusal.js";
import {
  arrayAt,
  dropInBlock,
  dropTrailingEntry,
  isRecord,
  recordAt,
  str,
  withKey,
  type ShedOutcome,
  type ShedPayload,
  type Shedder,
} from "./registry.js";

/**
 * Prose inside `outline`, cheapest-loss-first.
 *
 *   `note`     the `files` form's serve commentary (E-7 canonical).
 *   `summary`  the `markdown` form's document abstract (E-7 canonical).
 *   `hint`     the `signatures` form's truncation affordance — emitted ONLY
 *              when the skeleton was truncated, so it is the last prose to go:
 *              on a capped outline it is the sentence that says what to do.
 *
 * `title`, `profile_used`, `coverage`, `missing`, `sections_total` are NOT
 * prose: they are the structural facts the forms' own truncation disclosures
 * rest on (`sections_total` is the pre-cap count, and without it a capped index
 * reads as a complete one).
 */
const MAP_PROSE: readonly string[] = ["note", "summary", "hint"];

function shedOutlineProse(payload: ShedPayload): ShedOutcome | undefined {
  for (const key of MAP_PROSE) {
    const outcome = dropInBlock(payload, "outline", [key], 1);
    if (outcome !== undefined) return outcome;
  }
  return undefined;
}

/**
 * The two forms whose rung-6 cut §5.3 states outright: "Rung 6 drops
 * `files[]`/`surfaces[]` entries; the floor is one entry."
 *
 * THE OTHER FOUR FORMS REGISTER NOTHING, each for its own reason:
 *
 *   `signatures` / `digest`   the member IS one file's outline. There is no
 *       list of records to trim — `signatures` is a rendered blob or a row set
 *       that the caller picks a zoom target from, and cutting rows off it
 *       silently is the downgrade-that-names-no-zoom-target defect
 *       `structuralOutline` calls out in its own comment.
 *   `markdown`   `sections` is the R1 navigation index. It is the wire source
 *       of a valid `sections:[…]` argument, i.e. the same recovery-index class
 *       ruling 8 makes non-removable on a refusal, and its truncation already
 *       has a first-class disclosure (`sections_total`) the EMITTER owns.
 *   `overview`   `recommended_reading_order` is required and A.5.3 calls it the
 *       member's reason to exist; whether it has a non-zero rung-6 floor is
 *       recon open question §12.4, unresolved in any plan document. Declining
 *       to shed an unresolved floor is the fail-closed direction.
 */
const SHED_ELIGIBLE_FORMS: Readonly<Record<string, string>> = {
  surfaces: "surfaces",
  files: "files",
};

/**
 * Drop one trailing entry from the live form's record array.
 *
 * THE CONTINUATION NAMES WHAT WAS DROPPED. A map entry carries its own `path`
 * (both eligible forms require it), so the recovery is a map read scoped to
 * that path — narrower than the call that produced this response, and it
 * returns exactly the outline this rung withheld. Where the call cannot be
 * built (no path, or the server's own request validator refuses it) the step
 * DECLINES rather than ship a `wire` limit with no `next` (E5).
 */
function shedOutlineEntry(payload: ShedPayload): ShedOutcome | undefined {
  const outline = recordAt(payload, "outline");
  if (outline === undefined) return undefined;
  const form = str(outline["form"]);
  if (form === undefined) return undefined;
  const key = SHED_ELIGIBLE_FORMS[form];
  if (key === undefined) return undefined;

  const entries = arrayAt(outline, key);
  if (entries === undefined) return undefined;
  const trimmed = dropTrailingEntry(entries, 1);
  if (trimmed === undefined) return undefined;

  const dropped = trimmed.dropped;
  const path = isRecord(dropped) ? str(dropped["path"]) : undefined;
  if (path === undefined) return undefined;
  const continuation = mapCall(form, path);
  if (continuation === undefined) return undefined;

  return {
    next: withKey(payload, "outline", withKey(outline, key, trimmed.next)),
    note: { rung: 6, refs: [path] },
    continuation,
  };
}

/**
 * The narrower map call for one dropped path.
 *
 * `mode` mirrors the FORM this response is in, so the recovery returns the same
 * shape at a smaller scope rather than a different member the caller then has
 * to re-map. Built through `emittableToolCall`, so the server's own inbound
 * validator decides whether the mode is addressable that way — if it is not,
 * this returns `undefined` and the step declines.
 */
function mapCall(form: string, path: string): ToolCall | undefined {
  const mode = form === "surfaces" ? "surfaces" : "map";
  return emittableToolCall({ tool: "read_file", arguments: { mode, paths: [path] } });
}

export const READ_MAP_SHEDDER: Shedder = {
  kind: "read.map",
  rungs: [
    { rung: 1, step: shedOutlineProse },
    { rung: 6, step: shedOutlineEntry },
  ],
  refusalConvertible: true,
};
