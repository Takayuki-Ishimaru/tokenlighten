// ---------------------------------------------------------------------------
// protocol v1 — the `edit.reclassified` shed ladder (P3a S3).
//
// NORMATIVE SOURCE: TL-PROTOCOL-V1-PHASE3A-PLAN-DRAFT.md §5.8 ("required
// `action`. Nothing was written, so ordinary §4.2 fail-closed applies; ladder
// is rung 1 only, then refusal. It is DELIBERATELY OUTSIDE SE-STABLE.");
// DESIGN-v0.10-protocol-v1-contract-freeze.md A.5.12.
//
// LADDER: rung 1 only — AND IT IS VACUOUS AT THIS HEAD.
//
// A.5.12 closes the member at ONE field, `action: string`, and
// `projectReclassified` returns exactly `{action}`. There is no prose on it to
// shed, so the rung below always declines and the ladder always falls through
// to the fail-closed refusal §5.8 names. The step is registered anyway, for two
// reasons that are not symmetry:
//
//   1. The member is RESERVED, NOT EMITTED AT HEAD (`editFamily.ts`: every real
//      reclassification today rides `EditApplied.reclassification`, because
//      every one of them is attached to a write that already landed). The arm
//      exists so a future GENUINELY-no-write reclassification has a projection;
//      when that arrives it will carry prose, and the rung is where it goes.
//   2. `refusalConvertible: true` is the LOAD-BEARING declaration in this file.
//      §5.8 puts this kind outside SE-STABLE on purpose — nothing was written,
//      so a refusal in its place asserts nothing false — and that is the
//      distinction a reader of `editSideEffect.ts` next door must be able to
//      find stated, not inferred from an absence.
//
// A CITATION DISCREPANCY, RECORDED NOT REPAIRED: `editFamily.ts`'s reserved-arm
// comment cites "ruling 2, 2026-08-14" for the not-emitted status, and DESIGN's
// own ruling 2 is receipt-convergence placement (E4), a different subject. The
// status itself is independently evidenced by the projector and by the absence
// of any emitter; only the citation is suspect. Flagged in the S3 report rather
// than edited here — this module does not own that comment.
// ---------------------------------------------------------------------------

import {
  peelOrdered,
  type ShedOutcome,
  type ShedPayload,
  type Shedder,
} from "./registry.js";

/**
 * A.8.1 E-7's canonical prose tokens, swept defensively.
 *
 * None of them is emitted on this member today, so this always returns
 * `undefined`. It is a forward guard, not dead weight: a future
 * reclassification that gains a `detail` gets it shed here rather than in a
 * refusal conversion, which is the difference between losing a sentence and
 * losing the response.
 */
const RECLASSIFIED_PROSE: readonly string[] = ["note", "detail", "hint", "why", "summary"];

function shedReclassifiedProse(payload: ShedPayload): ShedOutcome | undefined {
  return peelOrdered(payload, RECLASSIFIED_PROSE, 1);
}

export const EDIT_RECLASSIFIED_SHEDDER: Shedder = {
  kind: "edit.reclassified",
  rungs: [{ rung: 1, step: shedReclassifiedProse }],
  refusalConvertible: true,
};
