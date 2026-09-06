// ---------------------------------------------------------------------------
// protocol v1 — the `read.closure` shed ladder (P3a S3).
//
// NORMATIVE SOURCE: TL-PROTOCOL-V1-PHASE3A-PLAN-DRAFT.md §5.4 ("floor-only"),
// §5.7; DESIGN-v0.10-protocol-v1-contract-freeze.md A.5.7, A.8.1 E-7.
//
// LADDER: rung 1 ONLY on the default path, same argument as `read.receipt` —
// 358 B on the committed pin, every remaining field required (`open`, `done`,
// `total`), and a budget that cannot fit it is a startup misconfiguration (S4),
// not a wire outcome. W-VERIFY-CLOSURE adds a rung-3 step for the two OPTIONAL
// verify-first fields (`gaps`, then `remaining`), both absent unless
// `TL_SF_VERIFY_FIRST` is on; the required triple is still peeled by nothing.
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
/*
 * W-VERIFY-CLOSURE (DESIGN-v0.15-sf-verification-first.md §3.4). `gaps` joins
 * this list LAST and `remaining` does NOT join it at all.
 *
 * THE ORDERING ARGUMENT, in this shedder's own terms. `gaps` is the
 * human-readable restatement — one sentence per entry, built at population time
 * from the `kind`/`targets` that `remaining` still carries — so shedding it
 * loses phrasing, not facts. `remaining` is the MACHINE-READABLE owed work
 * (the obligations themselves, `satisfied_by` included) and is the only place
 * the caller can read WHICH evidence class is missing; it is peeled one rung
 * later, as a rare extension (rung 3).
 *
 * `open`/`done`/`total` are peeled by NEITHER step, on either flag setting: the
 * required triple is what a closure IS, and a rollup that shed its counts to
 * fit would be a completion claim with nothing behind it. Both keys are absent
 * on every default-path response (`TL_SF_VERIFY_FIRST` off), so `peelOrdered`
 * declines them and the pinned ladder is unchanged — flag-off byte identity is
 * not affected by this list growing.
 */
// VF-16 (round-11, 2026-09-03): `note` carries the "closure NOT complete"
// warning (VERIFY_WITHHELD_NOTE in readFamily.ts) — the single most
// important human-readable signal that completion is being withheld. It must
// be the LAST thing this ladder sheds, not the first: `summary`/`gaps` go at
// rung 1, `remaining` then `note` (in that order) at rung 3, so `note`
// outlives every other optional field under budget pressure.
const CLOSURE_PROSE: readonly string[] = ["summary", "gaps"];

function shedClosureProse(payload: ShedPayload): ShedOutcome | undefined {
  return peelOrdered(payload, CLOSURE_PROSE, 1);
}

/** Rung 3, not 4/5/6: E5 forbids a `limit` on this kind, and rungs 1/3 emit
 *  none. The obligations are recoverable by re-issuing the same closure call.
 *  `note` is peeled LAST of the two (VF-16): the withhold prose survives
 *  even after `remaining` is gone. */
const CLOSURE_FLOOR: readonly string[] = ["remaining", "note"];

function shedVerifyRemaining(payload: ShedPayload): ShedOutcome | undefined {
  return peelOrdered(payload, CLOSURE_FLOOR, 3);
}

export const READ_CLOSURE_SHEDDER: Shedder = {
  kind: "read.closure",
  rungs: [
    { rung: 1, step: shedClosureProse },
    { rung: 3, step: shedVerifyRemaining },
  ],
  refusalConvertible: true,
};
