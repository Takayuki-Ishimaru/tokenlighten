// ---------------------------------------------------------------------------
// protocol v1 — the EXHAUSTIVE shedder registry (P3a S3).
//
// NORMATIVE SOURCE: TL-PROTOCOL-V1-PHASE3A-PLAN-DRAFT.md §3 (module layout),
// §5 (per-kind ladders); DESIGN-v0.10-protocol-v1-contract-freeze.md §1.4's
// tier-2 classifier, A.5.x (the closed fifteen-member vocabulary).
//
// WHY A `Record<Kind, Shedder>` AND NOT A LOOKUP WITH A DEFAULT. A default
// trimmer is how a future SIXTEENTH `kind` would get shed by rules written for
// something else — a member nobody designed a ladder for, quietly cut by the
// nearest one. The exhaustive record makes that a COMPILE error at this file,
// which is the mechanism the tier-2 classifier expects and the same fence
// `budget/requiredSets.ts` and `budget/validate.ts` each raise once.
//
// THE SECOND FENCE is `assertExhaustive` below: `Object.keys` over the record
// must cover the union at RUNTIME too, so a `Record` satisfied by a cast or by
// a widened key type still fails here. Two independent checks, because the
// first one is only as strong as the types it is written against.
// ---------------------------------------------------------------------------

import type { Kind } from "@tokenlighten/types";

import { EDIT_RECLASSIFIED_SHEDDER } from "./editReclassified.js";
import {
  EDIT_APPLIED_SHEDDER,
  EDIT_ROLLED_BACK_SHEDDER,
  EDIT_STATE_UNKNOWN_SHEDDER,
} from "./editSideEffect.js";
import { READ_ARTIFACT_SHEDDER } from "./readArtifact.js";
import { READ_BATCH_SHEDDER } from "./readBatch.js";
import { READ_CLOSURE_SHEDDER } from "./readClosure.js";
import { READ_MAP_SHEDDER } from "./readMap.js";
import { READ_RECEIPT_SHEDDER } from "./readReceipt.js";
import { READ_TASK_PACK_SHEDDER } from "./readTaskPack.js";
import { READ_TEXT_SHEDDER } from "./readText.js";
import { REFUSAL_SHEDDER } from "./refusal.js";
import { SEARCH_MATCHES_SHEDDER } from "./searchMatches.js";
import { SEARCH_REFERENCES_SHEDDER } from "./searchReferences.js";
import { SEARCH_TREE_SHEDDER } from "./searchTree.js";
import type { Shedder } from "./registry.js";

/**
 * Kind -> Shedder, EXHAUSTIVE by type and re-checked at construction.
 *
 * Each entry's ladder is defined and argued in its own module; this file only
 * says which module owns which member.
 */
export const SHEDDERS: Readonly<Record<Kind, Shedder>> = {
  "read.task_pack": READ_TASK_PACK_SHEDDER,
  "read.text": READ_TEXT_SHEDDER,
  "read.map": READ_MAP_SHEDDER,
  "read.batch": READ_BATCH_SHEDDER,
  "read.artifact": READ_ARTIFACT_SHEDDER,
  "read.receipt": READ_RECEIPT_SHEDDER,
  "read.closure": READ_CLOSURE_SHEDDER,
  "search.matches": SEARCH_MATCHES_SHEDDER,
  "search.references": SEARCH_REFERENCES_SHEDDER,
  "search.tree": SEARCH_TREE_SHEDDER,
  "edit.applied": EDIT_APPLIED_SHEDDER,
  "edit.reclassified": EDIT_RECLASSIFIED_SHEDDER,
  "edit.rolled_back": EDIT_ROLLED_BACK_SHEDDER,
  "edit.state_unknown": EDIT_STATE_UNKNOWN_SHEDDER,
  "refusal": REFUSAL_SHEDDER,
};

/**
 * Every entry's `kind` field agrees with the key it is filed under, and every
 * ladder's rungs are ordered non-decreasing.
 *
 * BOTH ARE STRUCTURAL CLAIMS THE TYPE CANNOT MAKE. A shedder filed under the
 * wrong key would be applied to the wrong member — the exact
 * "shed by rules written for something else" failure the exhaustive record
 * exists to prevent, arriving through the one door it leaves open. And the
 * runner walks `rungs` in array order and stops at the first fit, so a ladder
 * whose rungs ran 4 -> 1 would cut evidence before prose, inverting §5's whole
 * ordering argument.
 *
 * Checked at module load: this is a table, it is small, and a wrong table is
 * worth failing the process over rather than shipping a mislabelled cut.
 */
function assertWellFormed(): void {
  for (const [key, shedder] of Object.entries(SHEDDERS)) {
    if (shedder.kind !== key) {
      throw new Error(`shedder registry: ${key} is filed under a shedder for ${shedder.kind}`);
    }
    let previous = 0;
    for (const rung of shedder.rungs) {
      if (rung.rung < previous) {
        throw new Error(`shedder registry: ${key} declares rung ${rung.rung} after rung ${previous}`);
      }
      if (rung.rung === 2) {
        throw new Error(`shedder registry: ${key} declares the reserved-empty rung 2`);
      }
      previous = rung.rung;
    }
  }
}

assertWellFormed();

/** The ladder for `kind`. Total by construction — there is no default arm. */
export function shedderFor(kind: Kind): Shedder {
  return SHEDDERS[kind];
}

export type {
  ShedContext,
  ShedNote,
  ShedOutcome,
  ShedPayload,
  ShedStep,
  Shedder,
} from "./registry.js";
