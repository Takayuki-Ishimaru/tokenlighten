// ---------------------------------------------------------------------------
// protocol v1 — the three SE-STABLE ladders: ZERO RUNGS (P3a S3).
//
// NORMATIVE SOURCE: DESIGN-v0.10-protocol-v1-contract-freeze.md §4.2.1(1) and
// §4.2.1(4), A.5.11-A.5.14, A.13 ruling 7 ([R5-25]);
// TL-PROTOCOL-V1-PHASE3A-PLAN-DRAFT.md §7;
// prep/C-phase3a-errata-dispositions.md E2 (scope note) and E5 (interaction).
//
// THIS FILE IS A DELIBERATE NON-IMPLEMENTATION, and that is its whole content.
//
// `edit.applied`, `edit.rolled_back` and `edit.state_unknown` report a
// COMPLETED EFFECT on the caller's files. Three properties follow, and all
// three are expressed as the ABSENCE of a ladder rather than as guards inside
// one:
//
//   1. NO REFUSAL CONVERSION (§4.2.1(1)). A refusal in their place asserts that
//      nothing happened, about a disk where something did.
//      `refusalConvertible: false` is the second expression of a rule the
//      funnel already enforces structurally.
//   2. NO SHEAR. §4.2.1(3)'s minimal core — the paths, the counts, the
//      workspace marker — is what makes the report usable at all, and a ladder
//      that could cut ANY of it would be a delivery mechanism editing a
//      statement about the caller's files. The reserve
//      (`WIRE_RESERVE_BYTES = 32 KiB`, proved by S4) is the mechanism that
//      makes "it always fits" true, so the ladder does not need to be the one.
//   3. NO LEDGER COMPACTION IN P3a. Ruling 7 EXCLUDES §4.2.1(4)'s
//      ledger-compaction recovery handle from this phase: "the reserve is the
//      mechanism, S4's job is the floor-fits proof, `ledger` stays
//      declared-absent, and no `ledgerStore.ts` is built. The edit-family
//      shedders therefore have ZERO RUNGS." Compaction is the only rung anyone
//      proposed for these kinds; with it out of scope there is nothing left to
//      register.
//
// P10 ("no `ShedRecord` on an SE-STABLE kind") therefore holds BY
// CONSTRUCTION, not by assertion — there is no step that could book one. The
// sweep's predicate is a fence against a future edit to this file, not a
// runtime check on this one.
//
// `edit.reclassified` is DELIBERATELY NOT HERE. Its own §2.4 row says nothing
// was written, so ordinary fail-closed applies and it is convertible; see
// `editReclassified.ts`.
// ---------------------------------------------------------------------------

import type { Kind } from "@tokenlighten/types";

import type { Shedder } from "./registry.js";

/** Zero rungs, conversion-forbidden. The only shape §4.2.1(1) permits. */
function sideEffectLadder(kind: Kind): Shedder {
  return { kind, rungs: [], refusalConvertible: false };
}

export const EDIT_APPLIED_SHEDDER: Shedder = sideEffectLadder("edit.applied");
export const EDIT_ROLLED_BACK_SHEDDER: Shedder = sideEffectLadder("edit.rolled_back");
export const EDIT_STATE_UNKNOWN_SHEDDER: Shedder = sideEffectLadder("edit.state_unknown");
