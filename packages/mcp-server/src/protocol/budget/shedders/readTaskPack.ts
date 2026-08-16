// ---------------------------------------------------------------------------
// protocol v1 — the `read.task_pack` shed ladder (P3a S3).
//
// NORMATIVE SOURCE: TL-PROTOCOL-V1-PHASE3A-PLAN-DRAFT.md §5 (the rung table),
// §5.1 (this kind's ladder and its sub-order), §5.7 (E5);
// DESIGN-v0.10-protocol-v1-contract-freeze.md A.5.1, A.6.1 (`ProfilePlan`),
// A.6.2, A.8.1 E-7, A.8.2 E-8, A.13 rulings 2 and 6.
//
// LADDER: 1 (prose) -> 3 (`plan` contents, then the structured rare extensions
// that ride beside it) -> 4 (strip `Evidence.body`, ALWAYS populating
// `remaining`) -> 5 (drop whole entries, lowest-`role`-priority first, never an
// authority surface).
//
// -------------------- WHAT THIS LADDER MAY NEVER DO -------------------------
//
// RECEIPT CONVERGENCE IS NOT THE SHEDDER'S (§5.1, erratum E4, R5 ruling 2).
// §4.4 defines the terminal state — "when every `Evidence` entry would carry
// `prior` and no `body`, the response is a `read.receipt`" — but a shedder that
// MINTED `prior` would assert the client already holds bytes, which is the
// 2026-08-13 fabrication-push class (`44535d46`: a receipt claiming
// `code_unchanged` when only `decision_unchanged` was honest). So rung 4 yields
// a body-less FRESH entry with `remaining` populated, and never a
// `PriorEvidence`. The emitter decides convergence upstream, where residency is
// known.
//
// `create_target` IS UNSHEDDABLE (ruling 6 / [R5-23]). It is the only wire
// carrier for WHERE a new file goes — `FrontierEntry` requires a handle and a
// file that does not exist yet has none — so an `act.edit` that shed it would
// state the task is ready to write while naming no place to write, and the
// caller's only recovery is the `cwd-required-for-create` round trip the field
// exists to prevent. It appears in no list below, and that absence is the
// mechanism.
//
// THE ENVELOPE-LEVEL DISCLOSURE CLASS (A.8.3 / ruling 4: `cwd_corrected`,
// `root_note`, `workspace`, `workspace_crossing`) is likewise absent from every
// list here. Those four are applied by `carryDisclosures()` OUTSIDE any
// projector and answer "WHICH TREE ANSWERED?" — the question the 2026-08-09
// root-mismatch wave made load-bearing. No plan document assigns them a rung;
// this shedder treats that silence as unsheddable, and says so once here rather
// than leaving thirteen authors to infer it independently.
// ---------------------------------------------------------------------------

import type { ToolCall } from "@tokenlighten/types";

import { emittableToolCall } from "../../refusal.js";
import {
  arrayAt,
  dropInBlock,
  dropTopLevel,
  isRecord,
  peelOrdered,
  recordAt,
  str,
  withKey,
  withoutKeys,
  type ShedOutcome,
  type ShedPayload,
  type Shedder,
} from "./registry.js";

// ---------------------------------------------------------------------------
// Rung 1 — decorative prose
// ---------------------------------------------------------------------------

/**
 * `profile_binding.reason` is the LITERAL §4.3 rung-1 example, and the only one
 * of A.8.1 E-7's eight canonical prose tokens this member carries at all: the
 * pack's own prose lives inside `plan` (rung 3) and inside `decision` (which no
 * rung touches — `decision.kind` is the response's reason to exist).
 */
function shedProfileBindingReason(payload: ShedPayload): ShedOutcome | undefined {
  return dropInBlock(payload, "profile_binding", ["reason"], 1);
}

/**
 * `server_build` — §1.2's build stamp, orthogonal to `v` (D1).
 *
 * Prose-natured in the sense E-7 means: it is a fact ABOUT the responder, not
 * about the task, and no consumer branches on it. Assigned rung 1 per the
 * orchestrator's disposition of the `KEPT_ON_TASK_PACK` members that A.8.1's
 * canonical list does not name (prose-natured -> rung 1, structured-rare ->
 * rung 3, `create_target` excluded).
 */
function shedServerBuild(payload: ShedPayload): ShedOutcome | undefined {
  return dropTopLevel(payload, ["server_build"], 1);
}

// ---------------------------------------------------------------------------
// Rung 3 — rare extensions
// ---------------------------------------------------------------------------

/** `plan.evidence_model` — §5.1's first named sub-step. */
function shedEvidenceModel(payload: ShedPayload): ShedOutcome | undefined {
  return dropInBlock(payload, "plan", ["evidence_model"], 3);
}

/**
 * `plan.wiring.evidence_graph` — §5.1's second. A SUB-FIELD of `wiring`, not
 * all of `wiring`: the wiring profile's endpoints and completion proof are what
 * a wiring pack exists to deliver ("write only `edit_frontier`" binds to them),
 * and the graph is the derivable part.
 */
function shedEvidenceGraph(payload: ShedPayload): ShedOutcome | undefined {
  const plan = recordAt(payload, "plan");
  if (plan === undefined) return undefined;
  const wiring = recordAt(plan, "wiring");
  if (wiring === undefined) return undefined;
  const stripped = withoutKeys(wiring, ["evidence_graph"]);
  if (stripped === undefined) return undefined;
  const nextPlan = withKey(plan, "wiring", stripped.next);
  return {
    next: withKey(payload, "plan", nextPlan),
    note: { rung: 3, refs: ["plan.wiring.evidence_graph"] },
  };
}

/**
 * `plan.change_contract.obligations[].reason` — §5.1's third. Per-entry prose
 * inside a structured list; the obligation's `action`, target and stage are
 * what the guide's "edit only `action:"edit"` obligations by dependency stage"
 * rule reads, and they stay.
 *
 * All entries in one step: the reasons are homogeneous prose and peeling them
 * one obligation at a time would book N records for one class of loss without
 * changing what is lost.
 */
function shedObligationReasons(payload: ShedPayload): ShedOutcome | undefined {
  const plan = recordAt(payload, "plan");
  if (plan === undefined) return undefined;
  const contract = recordAt(plan, "change_contract");
  if (contract === undefined) return undefined;
  const obligations = arrayAt(contract, "obligations");
  if (obligations === undefined) return undefined;

  let cut = 0;
  const next = obligations.map((entry) => {
    if (!isRecord(entry)) return entry;
    const stripped = withoutKeys(entry, ["reason"]);
    if (stripped === undefined) return entry;
    cut += 1;
    return stripped.next;
  });
  if (cut === 0) return undefined;

  const nextPlan = withKey(plan, "change_contract", withKey(contract, "obligations", next));
  return {
    next: withKey(payload, "plan", nextPlan),
    note: { rung: 3, refs: ["plan.change_contract.obligations[].reason"] },
  };
}

/**
 * VERIFICATION-KIT BODIES — §5.1's fourth and last named sub-step.
 *
 * The kit's own economy is already a body-vs-name split (the guide: "`code`=
 * served here, `served-earlier`=already in context, `omitted`=NOT served =>
 * one batched `handles` read via its `next`"), so shedding a body here moves an
 * entry from the first class to the third — a transition the kit's consumer
 * already knows how to make, using the kit's own `next`. That is why this is
 * rung 3 and emits no `limit`: the recovery call is already on the response.
 *
 * Bodies are recognised by the field names the kit actually ships (`code`,
 * `body`, `content`) on entries that also carry a `handle` — an entry with no
 * handle has no way back to its bytes, so its body is not shed.
 */
function shedKitBodies(payload: ShedPayload): ShedOutcome | undefined {
  const plan = recordAt(payload, "plan");
  if (plan === undefined) return undefined;
  const verification = recordAt(plan, "verification");
  if (verification === undefined) return undefined;

  const refs: string[] = [];
  const rewritten = rewriteKitEntries(verification, refs);
  if (rewritten === undefined) return undefined;
  return {
    next: withKey(payload, "plan", withKey(plan, "verification", rewritten)),
    note: { rung: 3, refs },
  };
}

/** The kit's body fields, by the names the verification pack ships them under. */
const KIT_BODY_KEYS: readonly string[] = ["code", "body", "content"];

/**
 * Strip body fields off every handle-bearing entry reachable inside the kit,
 * at any depth (the pack nests entries under `files`, `mocks`, `tests` and
 * `entries` depending on the recipe, and this module does not own that shape).
 */
function rewriteKitEntries(value: unknown, refs: string[]): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  let changed = false;
  const next: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (Array.isArray(child)) {
      let arrayChanged = false;
      const mapped = child.map((entry) => {
        if (!isRecord(entry)) return entry;
        const handle = str(entry["handle"]);
        if (handle === undefined) return entry;
        const stripped = withoutKeys(entry, KIT_BODY_KEYS);
        if (stripped === undefined) return entry;
        arrayChanged = true;
        refs.push(handle);
        return stripped.next;
      });
      next[key] = arrayChanged ? mapped : child;
      changed = changed || arrayChanged;
      continue;
    }
    if (isRecord(child)) {
      const rewritten = rewriteKitEntries(child, refs);
      next[key] = rewritten ?? child;
      changed = changed || rewritten !== undefined;
      continue;
    }
    next[key] = child;
  }
  return changed ? next : undefined;
}

/**
 * The `KEPT_ON_TASK_PACK` members that are STRUCTURED RARE EXTENSIONS, in
 * cheapest-loss-first order. One key per invocation (`peelOrdered`), so the cut
 * goes exactly as far down this list as the overage requires.
 *
 * WHY THIS ORDER, member by member:
 *
 *   `qref`               a DUPLICATE. `readFamily.ts`'s own note says it is
 *                        "ALSO on `task.replay`; kept for one release because
 *                        the guide teaches `qref` by name", so shedding the
 *                        top-level copy loses no information at all. Cheapest
 *                        possible loss; therefore first.
 *   `answer_resolution`  names the identifier the caller ASKED about beside the
 *                        one that owns the responsibility. Lost, the answer is
 *                        still correct — it just no longer shows its work.
 *   `frontier_index`     read by the guide's "write only `edit_frontier`" rule
 *                        WHEN the decision is not an `act.edit`; on an
 *                        `act.edit` the frontier itself rides `decision`, which
 *                        no rung touches.
 *   `checks` / `verify`  the closure obligations and the verification commands.
 *                        Recoverable by a later `mode=closure` call, which is
 *                        what they are reported against.
 *   `profile_binding`    the requested-vs-selected readback (its `.reason` went
 *                        at rung 1). `profile` itself is REQUIRED and stays, so
 *                        what is lost is the readback, not the selection.
 *   `roots`             LAST, and deliberately. It is the multi-root pollution
 *                        disclosure (the "09e honesty" field): it says the
 *                        answer may be drawn from more than one tree. It is not
 *                        in A.8.3's envelope-disclosure class, so no ruling
 *                        makes it unsheddable — but it is the same FAMILY of
 *                        fact, and the 2026-08-09 root-mismatch wave is what
 *                        that family exists to prevent. Placed at the end of
 *                        the list so it is shed only when everything cheaper
 *                        has already gone; raised in the S3 report as the one
 *                        assignment here that a reviewer may want to move to
 *                        "never".
 */
const STRUCTURED_RARE_MEMBERS: readonly string[] = [
  "qref",
  "answer_resolution",
  "frontier_index",
  "checks",
  "verify",
  "profile_binding",
  "roots",
];

function shedStructuredRare(payload: ShedPayload): ShedOutcome | undefined {
  return peelOrdered(payload, STRUCTURED_RARE_MEMBERS, 3);
}

// ---------------------------------------------------------------------------
// Rungs 4 and 5 — the evidence axis
// ---------------------------------------------------------------------------

/**
 * RUNG 4 — strip one `Evidence.body`, keeping `handle` + `path` + `range`
 * (+ `role`) and populating `remaining` UNCONDITIONALLY (R6).
 *
 * WHY `remaining` IS SYNTHESISED RATHER THAN COPIED. The existing
 * `remaining_ranges` -> `Evidence.remaining` wiring carries a remainder the
 * EMITTER already declared (a `mode=full` that truncated). Rung 4 fires for a
 * different reason — budget pressure on an otherwise-complete entry — so the
 * window it withholds is the entry's OWN `range`, which becomes the new
 * unserved window. A.8.2's E-8 (`!body` implies `prior` or `remaining`) then
 * holds by construction, because `remaining` is written in the same edit that
 * clears `body`, and E4 forbids the other repair.
 *
 * TWO CONSUMERS READ THE FINAL PAYLOAD AND NEED NOTHING ELSE FROM THIS STEP.
 * `settleServedRanges` (the [R5-10] ledger, called from `emit.ts` AFTER the
 * ladder) books a window as served iff a `body`/`content`/`code` string is
 * present at that node — so clearing `body` retracts the booking automatically,
 * keyed on body presence rather than on `remaining`. And the sanctioned-zoom
 * fence's budget is the count of evidence entries carrying `remaining` in the
 * response the caller receives — so populating it here is what keeps the zoom
 * sanction honest too. One obligation, both consumers.
 *
 * LARGEST BODY FIRST: the step is budget-blind, so the fewest steps to close a
 * given overage is the most minimal cut available to it.
 */
function shedEvidenceBody(payload: ShedPayload): ShedOutcome | undefined {
  const evidence = arrayAt(payload, "evidence");
  if (evidence === undefined) return undefined;

  let index = -1;
  let widest = 0;
  for (let i = 0; i < evidence.length; i += 1) {
    const entry = evidence[i];
    if (!isRecord(entry)) continue;
    const body = entry["body"];
    if (typeof body !== "string" || body === "") continue;
    if (body.length <= widest) continue;
    widest = body.length;
    index = i;
  }
  if (index === -1) return undefined;

  const entry = evidence[index] as Record<string, unknown>;
  const handle = str(entry["handle"]);
  const range = str(entry["range"]);
  // E5: no addressing, no executable continuation, no shed. An entry with no
  // handle or no range cannot be re-fetched, so stripping its body would
  // withhold bytes with no call that returns them.
  if (handle === undefined || range === undefined) return undefined;
  const continuation = sliceCall(handle, [range]);
  if (continuation === undefined) return undefined;

  const remaining = mergeRemaining(entry["remaining"], range);
  const stripped = withoutKeys(entry, ["body"]);
  if (stripped === undefined) return undefined;
  const nextEntry: Record<string, unknown> = { ...stripped.next, remaining };

  const nextEvidence = [...evidence];
  nextEvidence[index] = nextEntry;
  return {
    next: withKey(payload, "evidence", nextEvidence),
    note: { rung: 4, refs: [handle] },
    continuation,
  };
}

/** Add `range` to an entry's `remaining`, never replacing what was already there. */
function mergeRemaining(existing: unknown, range: string): string[] {
  const held = Array.isArray(existing)
    ? existing.filter((entry): entry is string => typeof entry === "string")
    : [];
  return held.includes(range) ? held : [...held, range];
}

/**
 * RUNG 5 — drop one whole `Evidence` entry, LOWEST-`role`-PRIORITY FIRST and
 * NEVER AN AUTHORITY SURFACE (§5.1).
 *
 * THE NEVER-LIST IS THE POINT. The C-wave incident deleted the authority
 * document's surface to close a 1,465 B overage; `contract` and `api` are that
 * class in this vocabulary, and an entry the server did NOT classify (`role`
 * absent, or the explicit `"unknown"` value) is treated the same way — dropping
 * what you could not classify is exactly how an authority surface gets deleted
 * by accident. Only the seven roles below are droppable.
 *
 * FLOOR: one entry. A pack whose evidence is empty may be legitimate on a
 * non-`act` decision (A.5.1), but a pack that HAD evidence and shed all of it
 * is a different statement, and §2.1.1's delivery floor quantifies over exactly
 * that. THE FLOOR IS NOW LIVE (`../actFloor.ts`, S5): a cut that empties the
 * evidence out from under an `act.answer` demotes the decision to `discover`
 * rather than being refused, so this one-entry floor is no longer the only
 * thing standing between a rung-5 sweep and a fabricated act. It stays anyway —
 * it is a cheaper stop than a demotion, and the two disagree in the safe
 * direction.
 */
const DROPPABLE_ROLES: readonly string[] = ["style", "doc", "config", "test", "ui", "data", "domain"];

function shedEvidenceEntry(payload: ShedPayload): ShedOutcome | undefined {
  const evidence = arrayAt(payload, "evidence");
  if (evidence === undefined || evidence.length <= 1) return undefined;

  let index = -1;
  let priority = Number.MAX_SAFE_INTEGER;
  for (let i = 0; i < evidence.length; i += 1) {
    const entry = evidence[i];
    if (!isRecord(entry)) continue;
    const role = str(entry["role"]);
    if (role === undefined) continue;
    const rank = DROPPABLE_ROLES.indexOf(role);
    if (rank === -1) continue;
    if (rank >= priority) continue;
    priority = rank;
    index = i;
  }
  if (index === -1) return undefined;

  const entry = evidence[index] as Record<string, unknown>;
  const handle = str(entry["handle"]);
  const range = str(entry["range"]);
  if (handle === undefined || range === undefined) return undefined;
  const continuation = sliceCall(handle, [range]);
  if (continuation === undefined) return undefined;

  const nextEvidence = evidence.filter((_, i) => i !== index);
  return {
    next: withKey(payload, "evidence", nextEvidence),
    note: { rung: 5, refs: [handle] },
    continuation,
  };
}

/**
 * The same-handle re-serve every evidence rung names.
 *
 * Built through `emittableToolCall`, so the server's own inbound request-shape
 * validator is the gate (TC-2): a call this server would refuse is never
 * emitted as a recovery, and the step declines instead.
 */
export function sliceCall(handle: string, ranges: readonly string[]): ToolCall | undefined {
  return emittableToolCall({
    tool: "read_file",
    arguments: { mode: "slice", handle, ranges: [...ranges] },
  });
}

export const READ_TASK_PACK_SHEDDER: Shedder = {
  kind: "read.task_pack",
  rungs: [
    { rung: 1, step: shedProfileBindingReason },
    { rung: 1, step: shedServerBuild },
    { rung: 3, step: shedEvidenceModel },
    { rung: 3, step: shedEvidenceGraph },
    { rung: 3, step: shedObligationReasons },
    { rung: 3, step: shedKitBodies },
    { rung: 3, step: shedStructuredRare },
    { rung: 4, step: shedEvidenceBody },
    { rung: 5, step: shedEvidenceEntry },
  ],
  refusalConvertible: true,
};
