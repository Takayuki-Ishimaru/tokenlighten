// ---------------------------------------------------------------------------
// protocol v1 — the receipt union (§2.3), the `read.receipt` payload.
//
// NORMATIVE SOURCE: DESIGN-v0.10 §10.3 Appendix A (Revision 4, approved
// 2026-08-13), A.4. Implements the A.9.1 `receipts.ts` row.
// ---------------------------------------------------------------------------

import type { PriorEvidence, ToolCall } from "./protocol.js";
import type { TaskRef, CertificateRef } from "./decision.js";

/**
 * A receipt is a response that says "you already hold this" or "the decision
 * has not moved", and therefore deliberately carries no new payload (§2.3).
 *
 * WHAT THE `receipt` TAG FIXES. Four of the five kinds are signalled today by
 * the PRESENCE OF A BOOLEAN (`pack_unchanged`, `code_unchanged`,
 * `kit_unchanged`, `closure_complete`), so a client must probe up to five field
 * names to classify a receipt. One `receipt` tag makes it two lookups with no
 * probing. The booleans do NOT survive: they were the discriminator, and v1
 * has one.
 *
 * [R4-4], adjudicated 2026-08-13 — THE REQUIRED SET IS STATED PER RECEIPT FORM.
 * §4.3's "`receipt` tag; `prior` OR `handle`" was never a receipt-family rule;
 * it is a RESIDENCY rule, and only two of the five forms make a residency claim:
 *
 *   | Form                 | Class         | Required beyond the tag       |
 *   |----------------------|---------------|-------------------------------|
 *   | `pack-unchanged`     | residency     | `task` + >=1 `PriorEvidence`  |
 *   | `code-unchanged`     | residency     | `handle` + `sha`              |
 *   | `decision-unchanged` | non-residency | `certificate`                 |
 *   | `kit-unchanged`      | non-residency | `kit_ref`                     |
 *   | `closure-complete`   | non-residency | `done` + `total`              |
 *
 * The member envelope (A.5.6) therefore requires only `receipt`. This narrows
 * nothing: each form still carries the addressing its own claim needs, and the
 * §6.1(d) impossible-state tests assert per form — INCLUDING the negative
 * direction, that a non-residency form carrying `prior` or `handle` is a bug.
 *
 * [R5-10], adjudicated 2026-08-14 — THE CONTINUATION DUTY.
 *
 * The ruling: "a receipt may only be issued for the fact of having SERVED: only
 * bytes that actually reached the consumer on the wire can ground `served_by`.
 * A serve dropped by a cap is UNSERVED and remains discovery-eligible."
 *
 * Its structural consequence for this union. A receipt WITHHOLDS — that is its
 * entire purpose. A withholding response that names no way forward is not a
 * compression of a turn, it is the deletion of one: the F-1 reproduction shipped
 * `{"receipt":{"receipt":"decision-unchanged","certificate":{…}}}` and nothing
 * else, for a file the session had never served, leaving a non-editing consumer
 * with no in-protocol path to the bytes at all.
 *
 * So every WITHHOLDING form (all but `closure-complete`, which withholds
 * nothing) must carry at least one of:
 *   1. an evidence restatement — prior-addressed entries for the content it
 *      attests (`pack-unchanged`'s `evidence`), or
 *   2. an executable `next` (below): a fully-substituted `ToolCall`, never a
 *      placeholder template, which is why it is minted through
 *      `emittableToolCall` and not hand-built.
 * `readFamily.ts`'s projector makes this total by construction: a would-be
 * receipt that can satisfy neither is repaired with the one transition this
 * server accepts unconditionally (`taskEpoch:"new"`) rather than emitted bare.
 *
 * NOT HERE:
 *  - `query_mismatch` — §2.3 reclassifies it to `refusal` with `retry:"new-task"`
 *    and its executable re-pack `next` (§2.6). Its `certified_query` disclosure
 *    survives on the refusal, and separately on `decision-unchanged`.
 *  - `closure-unchanged` — D3(a), and its name is NOT reserved.
 */
export type Receipt =
  /** The exact prior pack re-issued; every surface file unchanged.
   *  Entries carry addressing + `prior`, never a body (§4.4 receipt
   *  convergence: when every Evidence would carry `prior` and no `body`,
   *  the response IS a receipt). */
  | {
      receipt: "pack-unchanged";
      task: TaskRef;
      evidence: [PriorEvidence, ...PriorEvidence[]];
      /** [R5-10] continuation. Optional on this form alone: the `evidence`
       *  restatement above already discharges the duty. */
      next?: ToolCall;
    }

  /** THESE bytes were served earlier this session and are unchanged. */
  | {
      receipt: "code-unchanged";
      handle: string;
      sha: string;
      /** Provenance naming the earlier call that put the bytes on the wire —
       *  NOT a new read (§2.3). Emitted iff the server can name that call;
       *  absence means provenance is not recoverable, and the `sha` still
       *  proves the bytes. */
      served_by?: string;
      /** [R5-10] continuation: the executable call that supersedes this
       *  suppression. Present on every emitted `code-unchanged`. */
      next?: ToolCall;
    }

  /** The certified DECISION stands. Asserts nothing about file bytes —
   *  the 2026-08-13 honesty fix (state/session.ts:2698-2704). Requiring a
   *  handle here would re-import the very claim that fix removed. */
  | {
      receipt: "decision-unchanged";
      certificate: CertificateRef;
      /** Emitted iff the caller's request differs from the certified query, or
       *  disclosure is owed. Absence means the request matches the certificate. */
      certified_query?: string;
      /** [R5-10] continuation: the executable route out of the standing
       *  decision. This form asserts nothing about bytes, so `next` is the
       *  ONLY thing that keeps it followable — F-1's bare emission is exactly
       *  this field's absence. Present on every emitted `decision-unchanged`. */
      next?: ToolCall;
    }

  /** The verification kit is byte-identical to the one already served. The kit
   *  is addressed by `kit_ref`, not by a file handle. */
  | {
      receipt: "kit-unchanged";
      kit_ref: string;
      /** [R5-10] continuation. */
      next?: ToolCall;
    }

  /** All registered checks closed; fires once, on the edit that closed the
   *  last one. Counts transcribed from the measured closure body (§4.3 [M]).
   *  There is no file this claim is about. */
  | {
      receipt: "closure-complete";
      done: number;
      total: number;
    };
