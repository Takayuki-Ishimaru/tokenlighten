// ---------------------------------------------------------------------------
// protocol v1 — §2.1.1's ACT FLOOR, and the demotion that keeps it true (P3a S5).
//
// NORMATIVE SOURCE: TL-PROTOCOL-V1-PHASE3A-PLAN-DRAFT.md §6 (the floors, the
// rule, and the four implementation constraints);
// DESIGN-v0.10-protocol-v1-contract-freeze.md §2.1.1 (delivery floors on `act`,
// F4), §2.1.2 (`next` is a set of now-executable calls, F5), A.3 (D-1…D-5,
// FLOOR-ANSWER / FLOOR-EDIT / DEGRADE), A.13 ruling 6 ([R5-23] + [R5-30]).
//
// ------------------------------ WHAT IT DECIDES -----------------------------
//
// One question, asked after every candidate rung and before that rung is
// accepted: DOES THE CANDIDATE STILL CARRY WHAT ITS OWN DECISION TELLS THE
// CLIENT TO ACT ON? A shed that empties the evidence out from under an
// `act.answer` has not made the response smaller — it has made it FALSE, and
// an LLM told to answer from a certificate whose bytes are gone will produce
// something. That is the 2026-08-13 fabrication-push class (`44535d46`), and
// F4 exists to make the state unrepresentable rather than merely rare.
//
// So the breach does not refuse the rung and it does not ship the act: it
// DEMOTES the decision to `discover`, carrying the concrete calls that would
// restore the floor. §2.1.1's own words: "a `discover` with an executable
// `next` is a TRUE statement of the client's situation".
//
// --------------------- WHY THE FLOORS ARE NOT SYMMETRIC ---------------------
//
// FLOOR-ANSWER quantifies over the certificate's obligations AND over what the
// client received EARLIER IN THIS SESSION. The wire's `CertificateRef` carries
// obligations as bare id strings (`decision.ts`'s A.2.4), which are not join
// keys onto `evidence[]`, and residency is the emitter's knowledge, not the
// body's. So the honest check a payload-level predicate can make is the
// NECESSARY condition `decisionWire.ts`'s `answerFloorHolds` already states —
// at least one usable entry — asked again here, against the SHED body rather
// than the produced one. That is not a weaker floor than the projector's; it is
// the same floor re-asked after the bytes moved.
//
// FLOOR-EDIT is different in kind: `frontier` and `create_target` are two keys
// of the body in front of us, so the disjunction [R5-23] ratified is checked
// exactly, by the one function that defines it.
//
// --------------------------- WHAT THIS FILE IS NOT --------------------------
//
// NOT A SHEDDER. It never cuts content; it rewrites one member (`decision`)
// when a cut made that member untrue. It books no `ShedRecord`, because the
// ledger records BYTES RECOVERED and a demotion frequently recovers a negative
// number (constraint 2 below).
//
// NOT A SECOND MEASUREMENT POINT. It returns a payload; the runner measures it.
// ---------------------------------------------------------------------------

import type { CreateTarget, FrontierEntry, Kind, ToolCall } from "@tokenlighten/types";

import { answerFloorHolds, editFloorHolds } from "../decisionWire.js";
import { isRecord, type ShedPayload } from "./shedders/registry.js";

/**
 * How many demotions one emission is allowed. Plan §6 constraint 3.
 *
 * ONE, AND THE BOUND IS STRUCTURAL BEFORE IT IS ASSERTED: after a demotion the
 * decision is `discover`, no floor applies to `discover`, so `actFloorHolds`
 * cannot fail again and a demote → shed → demote loop cannot form. The runner
 * asserts it anyway (P13) because "structurally impossible" is a claim about
 * today's code and an assertion is a claim about every future edit of it.
 */
export const MAX_DEMOTIONS_PER_EMISSION = 1;

// ---------------------------------------------------------------------------
// Reading the decision off an already-projected body
// ---------------------------------------------------------------------------

/**
 * The `decision` member, or `undefined` when this payload carries none.
 *
 * ONLY `read.task_pack` CARRIES A DECISION (A.5.1 requires it there and no
 * other member's required set names it), so on every other kind this returns
 * `undefined` and the floor is vacuously satisfied — which is the correct
 * answer, not an evasion: a member with no decision makes no claim about what
 * the client should do next, so there is nothing for a shed to falsify.
 */
function decisionOf(payload: ShedPayload): Record<string, unknown> | undefined {
  const decision = payload["decision"];
  return isRecord(decision) ? decision : undefined;
}

/** The response's own `evidence[]`, as records. Absent/malformed reads as empty. */
function evidenceOf(payload: ShedPayload): Record<string, unknown>[] {
  const evidence = payload["evidence"];
  return Array.isArray(evidence) ? evidence.filter(isRecord) : [];
}

/**
 * `evidence[]` re-typed for `answerFloorHolds`.
 *
 * A STRUCTURAL READ, NOT A CAST OF CONVENIENCE: the predicate reads exactly
 * `body` and `prior`, and both are declared `string | undefined` on `Evidence`,
 * so `undefined`-ing anything that is not a string is the faithful projection
 * of an untyped record onto the two fields the floor is about. A record whose
 * `body` is a number is not evidence the client can answer from.
 */
function usableEvidenceView(payload: ShedPayload): { body?: string; prior?: string }[] {
  return evidenceOf(payload).map((entry) => ({
    ...(typeof entry["body"] === "string" ? { body: entry["body"] } : {}),
    ...(typeof entry["prior"] === "string" ? { prior: entry["prior"] } : {}),
  }));
}

// ---------------------------------------------------------------------------
// THE FLOOR
// ---------------------------------------------------------------------------

/**
 * §2.1.1, asked of one candidate payload. `true` means "this response may ship
 * the decision it is carrying".
 *
 * TOTAL AND FAIL-SAFE-IN-THE-RIGHT-DIRECTION. An unrecognised decision shape
 * returns `true` (nothing to falsify), a recognised `act` with a broken floor
 * returns `false`. The asymmetry is deliberate: the cost of a false `false` is
 * a demotion the response did not need — a real turn tax, which is why the
 * ladder's S3 stub refused to approximate this — and the cost of a false `true`
 * is a fabricated act. Both directions are therefore decided by reading the
 * exact fields the floor names, never by inference from adjacent ones.
 */
export function actFloorHolds(candidate: ShedPayload, _kind: Kind): boolean {
  const decision = decisionOf(candidate);
  if (decision === undefined) return true;

  if (decision["kind"] === "act.answer") {
    return answerFloorHolds(usableEvidenceView(candidate));
  }

  if (decision["kind"] === "act.edit") {
    const frontier = Array.isArray(decision["frontier"]) ? decision["frontier"] : [];
    const createTarget = isRecord(decision["create_target"]) ? decision["create_target"] : undefined;
    return editFloorHolds(
      frontier as readonly FrontierEntry[],
      createTarget as CreateTarget | undefined,
    );
  }

  // `discover`, `await_input`, `done` — no floor. This is what makes at most
  // one demotion per emission a structural fact rather than a counter.
  return true;
}

// ---------------------------------------------------------------------------
// THE DEMOTION
// ---------------------------------------------------------------------------

/**
 * The window to re-fetch for one handle, preferred in the order that makes the
 * call MINIMAL rather than merely valid.
 *
 *  1. the candidate's own `remaining[0]` — rung 4 populates `remaining` on every
 *     body it strips precisely so the caller can name what it lost, and that is
 *     the smallest window that restores it;
 *  2. the pre-shed entry's `range` — for an entry dropped WHOLE (rung 5), where
 *     the candidate has no record of it at all.
 *
 * Returns `undefined` when neither is a string, and the caller then omits that
 * handle: a `read_file {handle}` with no range is a different call (whole file,
 * or the server's own window choice), and §2.1.2's "executable NOW" is about
 * calls the client can run, not about calls that happen to parse.
 */
function windowFor(candidateEntry: Record<string, unknown> | undefined, priorEntry: Record<string, unknown> | undefined): string | undefined {
  const remaining = candidateEntry?.["remaining"];
  if (Array.isArray(remaining) && typeof remaining[0] === "string" && remaining[0] !== "") {
    return remaining[0];
  }
  const range = priorEntry?.["range"];
  return typeof range === "string" && range !== "" ? range : undefined;
}

/**
 * One `read_file {handle, range}` per SHED handle, deduped, in the order the
 * pre-shed response served them.
 *
 * WHAT "SHED" MEANS HERE, precisely: an entry that carried a `body` before the
 * ladder ran and does not carry one now — whether because rung 4 stripped the
 * body or because rung 5 dropped the whole entry. Those are exactly the bytes
 * the client was told it would hold and now does not, so they are exactly the
 * calls that restore the floor.
 *
 * MUTUALLY INDEPENDENT BY CONSTRUCTION (§2.1.2, F5): each call names one handle
 * and one range of that handle, no call's `arguments` mention another call's
 * result, and the dedupe guarantees no two members address the same handle. The
 * client may batch them in any order, which is what the array form MEANS.
 *
 * NEVER A TEMPLATE (§2.6 abolished `next_call_is_template`): every argument is
 * a concrete value read off the response — no placeholder, no `<handle>`, no
 * instruction to substitute.
 */
function restoringCalls(candidate: ShedPayload, original: ShedPayload): ToolCall[] {
  const candidateByHandle = new Map<string, Record<string, unknown>>();
  for (const entry of evidenceOf(candidate)) {
    const handle = entry["handle"];
    if (typeof handle === "string" && handle !== "") candidateByHandle.set(handle, entry);
  }

  const calls: ToolCall[] = [];
  const seen = new Set<string>();
  for (const priorEntry of evidenceOf(original)) {
    const handle = priorEntry["handle"];
    if (typeof handle !== "string" || handle === "") continue;
    if (typeof priorEntry["body"] !== "string") continue;      // nothing was served to lose
    if (seen.has(handle)) continue;
    const now = candidateByHandle.get(handle);
    if (now !== undefined && typeof now["body"] === "string") continue; // still served
    const range = windowFor(now, priorEntry);
    if (range === undefined) continue;
    seen.add(handle);
    calls.push({ tool: "read_file", arguments: { handle, range } });
  }
  return calls;
}

/**
 * The ONE re-pack that would produce a fitting frontier — plan §6 constraint 4's
 * `act.edit` branch, and the fallback for an `act.answer` whose losses cannot be
 * addressed handle-by-handle.
 *
 * WHY A RE-PACK AND NOT A ZOOM, on the edit side: an `act.edit` breach means the
 * response could not carry the bounded effect area itself, and no amount of
 * re-reading one handle produces a frontier — the frontier is the PACK's
 * derivation. `qref` re-packs the same task without re-stating the query, which
 * is the call the guide already teaches ("re-pack with the returned `qref`, no
 * `query`"), so this names a call the client is already able to run.
 *
 * THIS IS ALSO THE ANSWER TO THE GRAPH-BACKED OBLIGATION. An obligation proved
 * through `evidence_ids[]` alone (a relation, not a read window) has no
 * `{handle, range}` to rebuild — relation ids are not read handles. Rather than
 * emit a call that cannot be executed, such a breach falls to this single
 * re-pack, which restores the whole certified working set at once.
 *
 * Returns `undefined` when the body names no replay token: a re-pack call
 * without one would either be a template or a DIFFERENT task, and the caller
 * (`demoteToDiscover`) then declines the demotion outright rather than ship a
 * `discover` whose `next` is a guess.
 */
function repackCall(payload: ShedPayload): ToolCall | undefined {
  const task = payload["task"];
  const replay = isRecord(task) ? task["replay"] : undefined;
  const qref = typeof replay === "string" && replay !== ""
    ? replay
    : typeof payload["qref"] === "string" && payload["qref"] !== ""
      ? payload["qref"] as string
      : undefined;
  if (qref === undefined) return undefined;
  return { tool: "read_file", arguments: { mode: "task_pack", qref } };
}

/**
 * §2.1.1's DEGRADE, applied. Returns the candidate with its `decision` rewritten
 * to `discover`, or `undefined` when no honest demotion exists.
 *
 * `undefined` IS A REAL OUTCOME AND THE RUNNER MUST HONOUR IT. `discover`
 * without a `next` is unrepresentable (§2.1), so a breach we cannot name a
 * restoring call for leaves exactly two options: ship the floor-violating act
 * (forbidden, F4) or refuse the rung and ship the last payload that was true.
 * The runner takes the second. That is the same "no under-shoot into falsity"
 * rule the S2 validator gate already enforces one line below it, reached by a
 * different road.
 *
 * WHAT IS DROPPED, and why each is not a loss:
 *  - `certificate` — D-2 makes it unrepresentable off `act.*`, and it certifies
 *    an action this response is no longer sanctioning.
 *  - `frontier` — D-3, same.
 *  - `apply` — the constructed edit call, which is an `act.edit` affordance.
 *  - `create_target` — D-3 as amended by [R5-23]. NOT DELETED, MOVED: the
 *    dual-carry rule is stated as a function of the decision kind, so a
 *    demotion that changes the kind moves the field back to the response root
 *    where `KEPT_ON_TASK_PACK` carries it for every non-`act.edit` decision.
 *    Deleting it would lose the one wire fact naming where a new file goes, on
 *    a response whose whole purpose is to tell the caller how to recover.
 *
 * `gaps` is not carried across, and its absence is not an omission: D-4 makes
 * `gaps` representable only on `discover`, so an `act` decision never had any.
 * Plan §6's "gaps unchanged" is the statement that shedding never PRODUCES one
 * — gaps are semantic, and no number of bytes closes one.
 */
export function demoteToDiscover(candidate: ShedPayload, original: ShedPayload): ShedPayload | undefined {
  const decision = decisionOf(candidate);
  if (decision === undefined) return undefined;

  // Constraint 4: an `act.edit` demotes when the FRONTIER does not fit, and
  // then `next` is the re-pack that would produce a fitting one — a per-handle
  // zoom cannot produce a frontier, because the frontier is the PACK's
  // derivation. An `act.answer` demotes per shed handle, and falls back to the
  // re-pack only when no handle-level window can be named.
  const perHandle = decision["kind"] === "act.edit" ? [] : restoringCalls(candidate, original);
  const repack = perHandle.length > 0 ? undefined : repackCall(candidate);
  const next: ToolCall[] = perHandle.length > 0 ? perHandle : repack === undefined ? [] : [repack];

  if (next.length === 0) return undefined;

  const createTarget = decision["create_target"];

  const demoted: ShedPayload = {};
  for (const [key, value] of Object.entries(candidate)) {
    if (key === "decision") {
      // KEY ORDER IS THE WIRE: the decision is rewritten IN PLACE, so the
      // demoted response has the same member order as the one it replaces.
      demoted["decision"] = {
        kind: "discover",
        // A single call ships as a single `ToolCall`, matching what
        // `projectTaskDecision` emits for an undegraded `discover` — the union
        // is `ToolCall | ToolCall[]`, and wrapping one call in an array would
        // make a demoted response distinguishable from an ordinary one by
        // shape rather than by content.
        next: next.length === 1 ? next[0]! : next,
      };
      continue;
    }
    demoted[key] = value;
  }

  // The moved carrier, appended: `create_target` is unsheddable (ruling 6), so
  // it must survive the demotion, and the root is where every non-`act.edit`
  // decision's response carries it. Appended rather than inserted at
  // `KEPT_ON_TASK_PACK`'s position because this path is reached only under
  // budget pressure, where no §6.1(b) pin holds, and a positional rebuild would
  // be a second key-order authority for one field.
  if (isRecord(createTarget) && demoted["create_target"] === undefined) {
    demoted["create_target"] = createTarget;
  }

  return demoted;
}
