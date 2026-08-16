// ---------------------------------------------------------------------------
// protocol v1 — the `read.closure` shed ladder (P3a S3).
//
// NORMATIVE SOURCE: TL-PROTOCOL-V1-PHASE3A-PLAN-DRAFT.md §5.4 ("floor-only"),
// §5.7; DESIGN-v0.10-protocol-v1-contract-freeze.md A.5.7, A.8.1 E-7.
//
// LADDER: rung 1 ONLY, same argument as `read.receipt` — 358 B on the committed
// pin, every remaining field required (`open`, `done`, `total`), and a budget
// that cannot fit it is a startup misconfiguration (S4), not a wire outcome.
//
// Like `read.receipt`, this kind carries NO emitter `limit` — `projectClosure`
// never calls `limitFrom` — and rung 1 emits none (E5), so a `limit` on a
// closure has no legitimate producer at all.
// ---------------------------------------------------------------------------

import {
  peelOrdered,
  type ShedOutcome,
  type ShedPayload,
  type Shedder,
} from "./registry.js";

/**
 * `note` and `summary` are both E-7 canonical prose tokens and both are what
 * `projectClosure` keeps beside the required triple.
 *
 * `summary` LAST: it is kept in its OBJECT form (`{edits, files, checks_closed,
 * checks_open}`) by an explicit 2026-08-13 adjudication — "flattening now is
 * irreversible information loss; flattening later is free" — so it is the one
 * of the two that carries counts rather than sentences.
 *
 * `applicability` is NOT prose: A.8.2 emits it iff no checks are registered,
 * which is the difference between "nothing is open" and "nothing was ever
 * asked", and `open.length === 0` alone cannot say which. `verification` is the
 * kit reference, not commentary.
 */
const CLOSURE_PROSE: readonly string[] = ["note", "summary"];

function shedClosureProse(payload: ShedPayload): ShedOutcome | undefined {
  return peelOrdered(payload, CLOSURE_PROSE, 1);
}

export const READ_CLOSURE_SHEDDER: Shedder = {
  kind: "read.closure",
  rungs: [{ rung: 1, step: shedClosureProse }],
  refusalConvertible: true,
};
