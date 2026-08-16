// ---------------------------------------------------------------------------
// protocol v1 — the `refusal` shed ladder (P3a S3).
//
// NORMATIVE SOURCE: TL-PROTOCOL-V1-PHASE3A-PLAN-DRAFT.md §5.8, §5.7;
// DESIGN-v0.10-protocol-v1-contract-freeze.md A.5.15, A.8.1 E-7, A.8.2,
// A.13 ruling 8 ([R5-22]).
//
// LADDER, §5.8 VERBATIM: `detail` -> `keys` -> `remaining` -> `fields[]` tail
// (keeping `fields[0] === field`). Successor to `REFUSAL_MAX_BYTES = 1024`
// (`validation/requestShape.ts`).
//
// ---------------------- WHAT IS NEVER SHED, AND WHY -------------------------
//
//   `for`, `code`, `retry`   the required set (A.5.15). A refusal that does not
//        say which tool refused, why, or what transition is sanctioned is not a
//        refusal.
//   `next`                   §2.6's transition. Shedding it converts a
//        recoverable refusal into a dead end — the `refusal_without_next` class
//        the 2026-07-16a forensics named.
//   `did_you_mean`           ORCHESTRATOR CONDITION (2)'s ONE-ROUND-TRIP
//        recovery mechanism. §5.8 is explicit: shedding it "converts a
//        recoverable refusal into a turn tax".
//   `field`                  names WHICH property the caller must fix; `fields`
//        without it is a list with no anchor, which is why the tail trim below
//        keeps `fields[0]`.
//   `certificate_id`         left the advisory class in the 2026-08-14
//        adjudication and is now CONDITIONALLY REQUIRED: `retry:"challenge"` is
//        unauthorable without it, so shedding it would degrade a real
//        transition into a label.
//   the RECOVERY-INDEX trio  `headings` / `headings_truncated` /
//        `headings_total`, ruling 8 — never shed WHILE `next` references them.
//        See `nextNeedsRecoveryIndex` below for how "references" is decided.
//   the A.8.3 disclosure class (`root_note`, `workspace`, `workspace_crossing`)
//        applied by `carryDisclosures()` outside the allowlist loop; it answers
//        "WHICH TREE REFUSED?", the question the 2026-08-09 root-mismatch wave
//        made load-bearing. No plan document assigns it a rung; treated here as
//        unsheddable by that silence.
//
// ----------------------- WHY THIS LADDER EMITS NO `limit` -------------------
//
// A.5.15 has no `limit` slot and this ladder never adds one: every rung here is
// 1 or 3, and E5 makes those rungs record-only. That is not a workaround — it
// is the same reading E-7 gives for every other member's prose, applied to a
// member whose entire optional surface is recovery advice rather than content.
// ---------------------------------------------------------------------------

import {
  REFUSAL_CALLER_RECOVERABLE_KEYS,
  REFUSAL_RECOVERY_INDEX_KEYS,
} from "../../refusal.js";
import {
  arrayAt,
  isRecord,
  peelOrdered,
  str,
  withKey,
  withoutKeys,
  type ShedOutcome,
  type ShedPayload,
  type Shedder,
} from "./registry.js";

/**
 * RUNG 1 — the advisory PROSE, in §5.8's order (`detail` first) then the rest.
 *
 *   `detail`         §5.8's own first rung. The prose half of the verdict; the
 *                    machine half is `code`, which stays.
 *   `note`, `hint`   general recovery prose (A.8 E-7 makes prose sheddable,
 *                    not deletable).
 *   `headings_note`  commentary ABOUT the recovery index. The index itself is
 *                    not here.
 *   `sections_hint`  ruling 8 keeps this in the plain-advisory class and rung 1
 *                    is where prose goes. It says `sections:[…]` exists — which
 *                    on a refusal the `next` already says, and on a `read.text`
 *                    success it does not (which is why `readText.ts` protects
 *                    its copy and this one does not).
 *   `receipt_note`   the escalation receipt's completeness sentence.
 */
const REFUSAL_PROSE: readonly string[] = [
  "detail",
  "note",
  "hint",
  "headings_note",
  "sections_hint",
  "receipt_note",
];

function shedRefusalProse(payload: ShedPayload): ShedOutcome | undefined {
  return peelOrdered(payload, REFUSAL_PROSE, 1);
}

/**
 * RUNG 3, first — the CALLER-RECOVERABLE class (ruling 8): `missing`.
 *
 * It echoes the caller's own unmatched `sections` argument, so the caller can
 * reconstruct it from the request it just sent. Cheapest structured loss on the
 * member, therefore first among the structured rungs.
 */
function shedCallerRecoverable(payload: ShedPayload): ShedOutcome | undefined {
  return peelOrdered(payload, REFUSAL_CALLER_RECOVERABLE_KEYS, 3);
}

/**
 * RUNG 3 — `keys`, then `remaining`, in §5.8's order.
 *
 *   `keys`       §4.3 calls it "budget-conditional" outright: the list of what
 *                IS advertised, offered so a caller can find the right spelling
 *                without a round trip. `did_you_mean` covers the near-miss case
 *                and is never shed, so the loss here is the exhaustive list,
 *                not the suggestion.
 *   `remaining`  the owed work a `retry:"none"` names. Shed after `keys`
 *                because a caller that cannot proceed at all benefits more from
 *                knowing what is still owed than from a vocabulary list.
 */
// `cwd_candidates` is the only member of refusal.ts's
// REFUSAL_WORKSPACE_RECOVERY_ADVISORY_KEYS. Keep the literal here to avoid the
// refusal -> emit -> shedder -> refusal initialization cycle.
const REFUSAL_STRUCTURED: readonly string[] = ["cwd_candidates", "keys", "remaining"];

function shedRefusalStructured(payload: ShedPayload): ShedOutcome | undefined {
  return peelOrdered(payload, REFUSAL_STRUCTURED, 3);
}

/**
 * RUNG 3, last — trim the TAIL of `fields[]`, KEEPING `fields[0] === field`.
 *
 * §5.8 states the invariant and this is the whole of it: `field` names the one
 * property the caller must fix and `fields[]` is the full violation ledger, so
 * the head must keep naming the same property the anchor does. Where `field` is
 * absent the head is still kept — a one-entry ledger is a refusal that names
 * one problem, and an empty one is a refusal that names none.
 */
function shedFieldsTail(payload: ShedPayload): ShedOutcome | undefined {
  const fields = arrayAt(payload, "fields");
  if (fields === undefined || fields.length <= 1) return undefined;

  const anchor = str(payload["field"]);
  // If the anchor is not the head, the invariant §5.8 asks for does not hold on
  // the INPUT, and a trim would not establish it. Decline rather than reshape a
  // ledger this module did not build.
  if (anchor !== undefined && fields[0] !== anchor) return undefined;

  return {
    next: withKey(payload, "fields", fields.slice(0, fields.length - 1)),
    note: { rung: 3, refs: ["fields[]"] },
  };
}

/**
 * RUNG 3 — the recovery index, ONLY when the refusal's `next` does not need it.
 *
 * RULING 8's shed rule is conditional, not absolute: "never shed while the
 * refusal's `next` references them". The predicate is decided on the `next`
 * this refusal actually carries — a `read_file` call with a `sections` argument
 * IS the markdown-navigation recovery, and `headings` is the only wire source
 * of a valid value for it. A refusal whose `next` is anything else (or which
 * carries no `next` at all, e.g. `retry:"none"`) has an index no transition
 * depends on, and A.8.1 E-7's reading applies to it like any other disclosure.
 *
 * The trio moves TOGETHER. `headings` without its truncation flags reads as a
 * complete index; shedding the flags while keeping the index would be strictly
 * worse than shedding all three.
 */
function shedRecoveryIndex(payload: ShedPayload): ShedOutcome | undefined {
  if (nextNeedsRecoveryIndex(payload)) return undefined;
  const stripped = withoutKeys(payload, REFUSAL_RECOVERY_INDEX_KEYS);
  if (stripped === undefined) return undefined;
  return { next: stripped.next, note: { rung: 3, refs: stripped.dropped } };
}

/** True iff this refusal's `next` is the `sections:[…]` recovery the index feeds. */
function nextNeedsRecoveryIndex(payload: ShedPayload): boolean {
  const next = payload["next"];
  if (!isRecord(next)) return false;
  if (next["tool"] !== "read_file") return false;
  const args = next["arguments"];
  return isRecord(args) && args["sections"] !== undefined;
}

export const REFUSAL_SHEDDER: Shedder = {
  kind: "refusal",
  rungs: [
    { rung: 1, step: shedRefusalProse },
    { rung: 3, step: shedCallerRecoverable },
    { rung: 3, step: shedRefusalStructured },
    { rung: 3, step: shedFieldsTail },
    { rung: 3, step: shedRecoveryIndex },
  ],
  /**
   * TRUE, and vacuously so. The flag's meaning is "may be converted to a
   * refusal when its floor will not fit", and it is FALSE for exactly the three
   * SE-STABLE kinds — a property `editSideEffect.ts` states and the funnel
   * enforces a second time. A refusal is already the conversion target, so
   * `emit.ts`'s fail-closed tail has nothing to convert it INTO and emits it as
   * it stands; declaring `false` here would overload the flag with a second
   * meaning ("cannot convert" vs "must not convert") and blur the one
   * distinction it exists to make.
   */
  refusalConvertible: true,
};
