// ---------------------------------------------------------------------------
// protocol v1 — the `read.receipt` shed ladder (P3a S3).
//
// NORMATIVE SOURCE: TL-PROTOCOL-V1-PHASE3A-PLAN-DRAFT.md §5.4 ("floor-only"),
// §5.7; DESIGN-v0.10-protocol-v1-contract-freeze.md A.4 (the five receipt
// forms), A.5.6, A.8.1 E-7.
//
// LADDER: rung 1 ONLY.
//
// §5.4: the member measures 337-565 B on the committed pins, every field is
// required, and "a configured budget below ~400 B cannot fit them =>
// STARTUP MISCONFIGURATION" — which S4's floor check catches at boot rather
// than the ladder catching it on the wire. The ladder is a rung of prose and a
// stop.
//
// THIS KIND CAN NEVER CARRY A `limit`, FROM EITHER SIDE. The emitter never
// calls `limitFrom` for a receipt ("a receipt withholds nothing", A.5.6), and
// rung 1 emits none (E5). That is a property worth stating because it is the
// only kind where both halves are absent, and a future `limit` on a receipt
// would therefore be a defect with no legitimate producer.
// ---------------------------------------------------------------------------

import {
  dropInBlock,
  peelOrdered,
  type ShedOutcome,
  type ShedPayload,
  type Shedder,
} from "./registry.js";

/**
 * The prose a receipt carries, cheapest-loss-first.
 *
 * The receipt block's own prose (`note`, `served_note`, `why`) are E-7
 * canonical tokens; `receipt_note` is the escalation receipt's completeness
 * statement in the same class.
 *
 * `concern_note` IS NOT SHED, and that is deliberate. `readFamily.ts`'s
 * `KEPT_ON_RECEIPT` note records the measured loss: it states an UNRELATED fact
 * — that the session's query has a hit OUTSIDE the window being vouched for —
 * and the guard that produces it is ONE-SHOT per (session, path), so a receipt
 * that dropped it would consume the caller's only warning and then not carry
 * it. A receipt is 350 B; there is no budget pressure that makes that trade,
 * and encoding "never" here is cheaper than encoding "last".
 *
 * `verification`, `certificate`, `next`, `task`, `evidence`, `handle`, `sha`,
 * `kit_ref`, `done`, `total` are the forms' own required claims (A.4) and are
 * not prose at all.
 */
const RECEIPT_PROSE: readonly string[] = ["note", "served_note", "why", "receipt_note"];

function shedReceiptProse(payload: ShedPayload): ShedOutcome | undefined {
  // Inside the `receipt` block first — that is where every form's own prose
  // lives — then the response level, which is where the projector's own
  // passthrough can leave a stray token.
  for (const key of RECEIPT_PROSE) {
    const outcome = dropInBlock(payload, "receipt", [key], 1);
    if (outcome !== undefined) return outcome;
  }
  return peelOrdered(payload, RECEIPT_PROSE, 1);
}

export const READ_RECEIPT_SHEDDER: Shedder = {
  kind: "read.receipt",
  rungs: [{ rung: 1, step: shedReceiptProse }],
  refusalConvertible: true,
};
