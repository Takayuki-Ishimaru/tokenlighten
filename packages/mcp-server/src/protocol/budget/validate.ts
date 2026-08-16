// ---------------------------------------------------------------------------
// protocol v1 — THE REQUIRED-SET VALIDATOR (P3a S2).
//
// NORMATIVE SOURCE: DESIGN-v0.10-protocol-v1-contract-freeze.md §4.2 (the
// validator and the fail-closed rule), §4.3 (the per-member required sets),
// §4.2.1 (SE-STABLE), A.8.1 rule E-5 ([R5-9], the five `Limit` causes);
// TL-PROTOCOL-V1-PHASE3A-PLAN-DRAFT.md §4.2.
//
// ------------------------------ WHAT IT DECIDES ----------------------------
//
// One question, twice:
//
//   1. BEFORE A RUNG IS ACCEPTED. `emit.ts`'s ladder asks whether a SHED
//      CANDIDATE still satisfies its member's required set. A candidate that
//      does not is refused and the ladder stops — the response ships whole
//      rather than shipping mutilated. This is the step the C-wave ladder
//      lacked (`d7150ec3`, 2026-08-09): it ran to its last rung, removed
//      3,158 B to close a 1,465 B overage, and deleted the authority document's
//      surface entirely, because nothing was judging the result.
//   2. AFTER THE LADDER, ON THE PAYLOAD THAT ACTUALLY SHIPS. §4.2's "a
//      not-enforced invariant is the thing the validator exists to prevent",
//      applied to this server's own output.
//
// -------------------------- WHAT IT DELIBERATELY IS NOT --------------------
//
// NOT A REFLECTION OVER `packages/types`. The declared types and the wire
// disagree in two known, disclosed places — `EditApplied.core` et al. are
// declared non-optional while `buildCore()` omits them, and a receipt's
// `certificate` is `{id}` or `{id, obligations}` while `CertificateRef`
// declares a full triple. A validator derived from the types would reject
// bodies the server legitimately emits today. `requiredSets.ts` is therefore
// the source of truth, and each row cites the evidence it was derived from.
//
// NOT A CLOSED-KEY CHECK. See `requiredSets.ts`'s header: disclosed-carry
// fields are legal, so the test is subset, never equality.
//
// NOT THE ACT FLOOR — WITH ONE EXACT EXCEPTION (S5). FLOOR-ANSWER quantifies
// over certificate obligations and over what the client received EARLIER IN THE
// SESSION; that is not a property of one body, and it stays
// `budget/actFloor.ts`'s. FLOOR-EDIT is different in kind: since [R5-23] it
// reads two keys of the body in front of it (`frontier` non-empty OR a create
// target), so `requiredSets.ts` states it as the `read.task_pack/act-edit-floor`
// predicate — DELEGATING to `decisionWire.ts`'s `editFloorHolds`, so there is
// one definition and not two. Everything else about `decision` is checked here
// only for presence and tagging.
//
// NOT THE KIND ORACLE. By the time a payload reaches here the funnel has
// already resolved one final `kind`. The validator trusts that discriminator
// and looks up the matching row; whether the RIGHT kind was chosen is a
// pre-validator question (`envelope.ts`'s `kindForCall`) that no check on the
// body alone can answer.
// ---------------------------------------------------------------------------

import type { Kind } from "@tokenlighten/types";

import {
  REQUIRED_SETS,
  hasKey,
  isRecord,
  type RequiredSetRow,
  type WireBody,
} from "./requiredSets.js";

// ---------------------------------------------------------------------------
// The non-wire violation ledger
// ---------------------------------------------------------------------------

/**
 * The violation ledger, declared HERE rather than in `envelope.ts`, by
 * ownership: `emittedBytes` is the funnel's own measurement, and this is the
 * validator's finding about the same emission. Merging it onto
 * `ProtocolCallContext` keeps both on the one per-call `AsyncLocalStorage`
 * slot, so a later stage reading "what did this call emit, and was it well
 * formed" has one object to read and two concurrent calls cannot
 * cross-contaminate.
 *
 * NON-WIRE, WITHOUT EXCEPTION. Nothing copies this into a payload. §0.3 makes
 * P3a byte-invisible, and a validator that could add a byte to a response would
 * be reporting on a response it had changed.
 */
declare module "../envelope.js" {
  interface ProtocolCallContext {
    /**
     * Required-set violations found on the payload this call actually emitted.
     * Absent means none were found — never "the validator did not run", which
     * only `emitOpaqueText`'s kind-less path produces and which records no
     * budget row either.
     */
    protocolViolations?: readonly ProtocolViolation[];
  }
}

// ---------------------------------------------------------------------------
// The verdict
// ---------------------------------------------------------------------------

/**
 * What was wrong with one body.
 *
 * `missing` names REQUIRED KEYS that were absent, path-qualified for a tagged
 * member (`outline.handle`, not `handle`). `violated` names the structural
 * predicates that returned false, by their stable ids. Both can be non-empty at
 * once; the verdict reports everything it found rather than the first thing,
 * because a body that is missing three keys is one bug, not three round trips.
 */
export type ProtocolViolation = {
  readonly kind: Kind;
  readonly form?: string;
  readonly missing: readonly string[];
  readonly violated: readonly string[];
};

/** `{ok: true}` or the finding. Deliberately not an exception: the caller picks the policy. */
export type ValidationVerdict = { readonly ok: true } | ({ readonly ok: false } & ProtocolViolation);

// ---------------------------------------------------------------------------
// A.8.1 E-5 — the five `Limit` causes ([R5-9], ratified 2026-08-14)
// ---------------------------------------------------------------------------

/**
 * `wire`/`records` are recoverable by another call and REQUIRE `next`;
 * `source`/`capped` are not and FORBID it; `time` carries one iff the server
 * can name a narrower call, so either way is legal.
 *
 * The two `next`-less arms are not interchangeable and this table keeps them
 * apart on purpose: `source` = the underlying content ran out, `capped` = it
 * exists and this response could not reach it.
 */
const LIMIT_NEXT_RULE: Readonly<Record<string, "required" | "forbidden" | "optional">> = {
  wire: "required",
  records: "required",
  source: "forbidden",
  capped: "forbidden",
  time: "optional",
};

/**
 * A.8.1 E-4/E-5, checked on every kind that can carry a `limit`.
 *
 * This is where `search.references`' paging duty becomes checkable: DESIGN:1986
 * requires "`limit` with `cause:"records"` and `limit.next` iff more pages
 * exist", and the "more pages exist" half is server-side state no body reveals.
 * The half that IS a property of the body — a `records` limit carries `next` —
 * is universal, so it is asserted here for all fifteen members rather than
 * duplicated into one row.
 */
function limitCoherence(body: WireBody): readonly string[] {
  if (!hasKey(body, "limit")) return [];
  const limit = body["limit"];
  if (!isRecord(limit)) return ["limit/not-an-object"];

  const cause = limit["cause"];
  if (typeof cause !== "string") return ["limit/cause-missing"];
  const rule = LIMIT_NEXT_RULE[cause];
  if (rule === undefined) return [`limit/unknown-cause:${cause}`];

  const carriesNext = hasKey(limit, "next");
  if (rule === "required" && !carriesNext) return [`limit/next-required-for-${cause}`];
  if (rule === "forbidden" && carriesNext) return [`limit/next-forbidden-for-${cause}`];
  return [];
}

// ---------------------------------------------------------------------------
// The exhaustive arm
// ---------------------------------------------------------------------------

/** Where a row's `keys` are resolved, and what to prefix a missing key with. */
type Scope = { readonly scope: WireBody; readonly prefix: string };

type Resolution =
  | { readonly ok: true; readonly row: RequiredSetRow; readonly at: Scope; readonly form?: string }
  | { readonly ok: false; readonly missing: readonly string[]; readonly violated: readonly string[]; readonly form?: string };

/**
 * Resolve `(kind, body)` to the row that governs it and the object that row's
 * keys are read from.
 *
 * THE SWITCH IS THE POINT. A sixteenth `Kind` matches no `case`, falls into
 * `default`, and fails to assign to `never` — a COMPILE error at this file,
 * which is the mechanism §1.4's tier-2 classifier expects and the reason this
 * is a switch rather than a lookup with a default arm. It is the second of two
 * independent fences; the first is `requiredSets.ts`'s `Record<Kind, …>`.
 *
 * The idiom is the house one — an inline `const exhaustive: never = …; throw`,
 * as in `__tests__/protocolConformance.spec.ts`'s `rawChangeToClassification`,
 * which itself cites DESIGN:445-446's `assertNever` sketch. No shared helper
 * exists in this tree and this file does not introduce one.
 */
function resolve(body: WireBody, kind: Kind, declaredForm: string | undefined): Resolution {
  const entry = REQUIRED_SETS[kind];

  switch (kind) {
    // The three [R4-4] members: required set stated per form, keyed inside the
    // member's own tagged block.
    case "read.map":
    case "read.receipt":
    case "search.matches": {
      if (!entry.tagged) return { ok: false, missing: [], violated: ["table/expected-tagged-entry"] };
      const block = body[entry.block];
      if (!isRecord(block)) return { ok: false, missing: [entry.block], violated: [] };
      const form = declaredForm ?? (typeof block[entry.tag] === "string" ? String(block[entry.tag]) : undefined);
      if (form === undefined) {
        return { ok: false, missing: [`${entry.block}.${entry.tag}`], violated: [] };
      }
      const row = entry.rows[form];
      if (row === undefined) {
        // A form outside the closed union. Not silently accepted: see
        // `requiredSetFor`'s note on why this direction fails closed.
        return { ok: false, missing: [], violated: [`${kind}/unknown-form:${form}`], form };
      }
      return { ok: true, row, at: { scope: block, prefix: `${entry.block}.` }, form };
    }

    // The twelve single-form members: the response body IS the scope.
    case "read.task_pack":
    case "read.text":
    case "read.batch":
    case "read.artifact":
    case "read.closure":
    case "search.references":
    case "search.tree":
    case "edit.applied":
    case "edit.reclassified":
    case "edit.rolled_back":
    case "edit.state_unknown":
    case "refusal": {
      if (entry.tagged) return { ok: false, missing: [], violated: ["table/expected-single-entry"] };
      return { ok: true, row: entry.row, at: { scope: body, prefix: "" } };
    }

    default: {
      const exhaustive: never = kind;
      throw new Error(`validateProtocolBody(): no required-set arm for kind ${String(exhaustive)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// The entry point
// ---------------------------------------------------------------------------

/**
 * Does `payload` satisfy the required set of `kind` (and, for a tagged member,
 * of its form)?
 *
 * `form` may be supplied by a caller that has already read the discriminator
 * (`emit.ts` has, for the budget row); when omitted it is read off the body, so
 * a test can call this with two arguments and get the same answer.
 *
 * Total. A malformed payload produces a verdict, never a throw — the one
 * exception is the `never` arm above, which cannot be reached at runtime by a
 * program that compiles.
 */
export function validateProtocolBody(
  payload: WireBody,
  kind: Kind,
  form?: string,
): ValidationVerdict {
  const missing: string[] = [];
  const violated: string[] = [];

  // The universal envelope (§4.3: "Every member requires `v` and `kind`").
  if (!hasKey(payload, "v")) missing.push("v");
  else if (payload["v"] !== 1) violated.push("envelope/version-not-1");
  if (!hasKey(payload, "kind")) missing.push("kind");
  else if (payload["kind"] !== kind) violated.push("envelope/kind-mismatch");

  // A.8.1 E-5, on every member.
  violated.push(...limitCoherence(payload));

  const resolved = resolve(payload, kind, form);
  if (!resolved.ok) {
    missing.push(...resolved.missing);
    violated.push(...resolved.violated);
    return verdict(kind, resolved.form, missing, violated);
  }

  const { row, at } = resolved;
  for (const key of row.keys) {
    if (!hasKey(at.scope, key)) missing.push(`${at.prefix}${key}`);
  }
  for (const predicate of row.predicates) {
    if (!predicate.holds(at.scope)) violated.push(predicate.id);
  }

  return verdict(kind, resolved.form ?? row.form, missing, violated);
}

function verdict(
  kind: Kind,
  form: string | undefined,
  missing: readonly string[],
  violated: readonly string[],
): ValidationVerdict {
  if (missing.length === 0 && violated.length === 0) return { ok: true };
  return { ok: false, kind, ...(form === undefined ? {} : { form }), missing, violated };
}

/**
 * One line naming what failed, for an error message or a log.
 *
 * Written to be actionable on its own: the reader of a thrown strict-mode error
 * should not have to re-run anything to know which member and which fields.
 */
export function describeVerdict(violation: ProtocolViolation): string {
  const shape = violation.form === undefined ? violation.kind : `${violation.kind} (form ${violation.form})`;
  const parts: string[] = [];
  if (violation.missing.length > 0) parts.push(`missing required ${violation.missing.join(", ")}`);
  if (violation.violated.length > 0) parts.push(`violated ${violation.violated.join(", ")}`);
  return `${shape}: ${parts.join("; ")}`;
}
