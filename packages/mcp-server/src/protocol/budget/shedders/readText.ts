// ---------------------------------------------------------------------------
// protocol v1 — the `read.text` shed ladder (P3a S3).
//
// NORMATIVE SOURCE: TL-PROTOCOL-V1-PHASE3A-PLAN-DRAFT.md §5.2, §5.7;
// DESIGN-v0.10-protocol-v1-contract-freeze.md A.5.2, A.8.1 E-7, A.8.2 E-8,
// A.13 ruling 8 (by analogy — see the recovery-index note below).
//
// LADDER: 1 (prose) -> 4 TRUNCATING.
//
// RUNG 4 TRUNCATES RATHER THAN STRIPS, and that is this kind's whole shape:
// "cut `body` on a line boundary, push the cut window into `remaining`, emit
// `limit{cause:"wire", omitted:["evidence"], next: read_file{handle, range}}`"
// (§5.2). Today's `mode=full` `truncated`+`next` chain, `mode=slice`
// `continued`, and the served-range ledger are all this rung's output
// re-expressed.
//
// RUNG 5 IS DELIBERATELY ABSENT. §5.2: dropping the sole entry breaks the
// required non-empty `FreshEvidence` tuple, so a single-entry response under
// budget-below-addressing pressure must FAIL CLOSED to a `refusal`, never shed
// past rung 4. The plan discusses rung 5 only to rule it out, and this module
// registers no rung-5 step rather than inventing a multi-entry variant the plan
// does not describe — a whole dropped window is a bigger loss than a truncated
// one, and `read.text` is the one read member whose evidence IS the response.
// ---------------------------------------------------------------------------

import { emittableToolCall } from "../../refusal.js";
import {
  arrayAt,
  isRecord,
  peelOrdered,
  str,
  withKey,
  type ShedOutcome,
  type ShedPayload,
  type Shedder,
} from "./registry.js";

// ---------------------------------------------------------------------------
// Rung 1 — decorative prose
// ---------------------------------------------------------------------------

/**
 * The prose `KEPT_ON_TEXT` carries, cheapest-loss-first.
 *
 *   `note`          elision markers and serve commentary; the E-7 canonical
 *                   token, and the one whose absence says least.
 *   `focus`         WHY this window was selected for a semantic query. Losing
 *                   it makes a query-driven serve indistinguishable from an
 *                   arbitrary one — a loss about provenance, not about content.
 *   `hint`          the affordance prose ("re-issue with mode=full"). Placed
 *                   after `focus` because a capped serve's `hint` is sometimes
 *                   the only statement of what to do next when `limit` took the
 *                   `capped` arm.
 *   `headings_note` the heading index's own commentary. The index itself and
 *                   its truncation flags are NOT here (see below).
 *   `concern_note`  LAST. It states an UNRELATED fact — the session's query has
 *                   a hit OUTSIDE the window being served — and the guard that
 *                   produces it is one-shot per (session, path), so the caller's
 *                   only warning is consumed by the response that carries it.
 *                   `readFamily.ts`'s `KEPT_ON_RECEIPT` note records that a
 *                   previous deletion of exactly this field was a measured
 *                   capability loss. Sheddable under E-7, but only after
 *                   everything cheaper has gone.
 *
 * DELIBERATELY NOT ON THIS LIST, and not on any list in this module:
 *
 *   `headings`, `headings_truncated`, `headings_total`
 *                   the R1 markdown-navigation RECOVERY INDEX. Ruling 8 splits
 *                   exactly this trio out of the refusal advisory class as
 *                   "consumer-dependent, not removable, never shed while the
 *                   refusal's `next` references them". That ruling is scoped to
 *                   A.5.15 and says nothing about `read.text`'s copy — but the
 *                   copy exists for the identical reason and is reached by the
 *                   identical recovery (`sections:[…]`), and `headings` is the
 *                   only wire source of a valid section name for it. Treated as
 *                   unsheddable here, which is the conservative reading of an
 *                   open question rather than a ruling this module invented.
 *   `sections_hint` the instruction that says `sections:[...]` EXISTS for this
 *                   document. The index names WHERE things are; only this names
 *                   the call that fetches them. (On a REFUSAL, ruling 8 makes
 *                   the same field rung-1 prose — because a refusal's `next`
 *                   already names the call, and a success's does not.)
 *   `style`         whether a markdown section's heading is `setext` or `atx`.
 *                   An edit that REPLACES a section must reproduce its heading,
 *                   and the two styles are not interchangeable text; without it
 *                   the caller re-derives the style from the served body and
 *                   gets it wrong whenever the body starts below the rule.
 */
const TEXT_PROSE: readonly string[] = ["note", "focus", "hint", "headings_note", "concern_note"];

function shedTextProse(payload: ShedPayload): ShedOutcome | undefined {
  return peelOrdered(payload, TEXT_PROSE, 1);
}

// ---------------------------------------------------------------------------
// Rung 4 — truncate one body on a line boundary
// ---------------------------------------------------------------------------

/**
 * Cut the largest `Evidence.body` in half on a line boundary, moving the cut
 * window from `range` into `remaining`.
 *
 * THE ADDRESSING MUST MOVE WITH THE BYTES. `range` is what the caller HOLDS,
 * and `servedWindowsOf` books it into the [R5-10] served-range ledger verbatim
 * — so a truncation that left `range` naming the pre-cut window would book
 * lines the caller never received, and the next call's residency reasoning
 * would be wrong about bytes rather than merely stale. `range` therefore
 * narrows to the surviving window and the remainder lands in `remaining`, which
 * is the same pair of facts A.8.2's E-8 requires and the same pair the
 * sanctioned-zoom fence counts.
 *
 * HALF, rather than "exactly the overage". The step is budget-blind by
 * construction (`registry.ts` rule 1: one measurement point), so the runner
 * re-invokes it while the payload is still over budget and each pass halves
 * again — geometric, terminating at one line, and never over-shooting by more
 * than one halving.
 */
function truncateLargestBody(payload: ShedPayload): ShedOutcome | undefined {
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
  const bounds = parseRange(entry["range"]);
  // E5: no parsable addressing means no executable continuation, so no shed.
  if (handle === undefined || bounds === undefined) return undefined;

  const lines = String(entry["body"]).split("\n");
  if (lines.length < 2) return undefined;
  const keep = Math.ceil(lines.length / 2);
  if (keep >= lines.length) return undefined;

  const [start] = bounds;
  const keptRange = `${start}-${start + keep - 1}`;
  const cutRange = `${start + keep}-${start + lines.length - 1}`;
  const continuation = emittableToolCall({
    tool: "read_file",
    arguments: { mode: "slice", handle, range: cutRange },
  });
  if (continuation === undefined) return undefined;

  const remaining = Array.isArray(entry["remaining"])
    ? (entry["remaining"] as unknown[]).filter((value): value is string => typeof value === "string")
    : [];

  const nextEntry: Record<string, unknown> = {
    ...entry,
    range: keptRange,
    body: lines.slice(0, keep).join("\n"),
    remaining: remaining.includes(cutRange) ? remaining : [...remaining, cutRange],
  };
  const nextEvidence = [...evidence];
  nextEvidence[index] = nextEntry;

  return {
    next: withKey(payload, "evidence", nextEvidence),
    note: { rung: 4, refs: [handle] },
    continuation,
  };
}

/** `"12-48"` -> `[12, 48]`. Fail-closed: anything else is not addressing. */
function parseRange(value: unknown): [number, number] | undefined {
  if (typeof value !== "string") return undefined;
  const match = /^(\d+)-(\d+)$/u.exec(value.trim());
  if (match === null) return undefined;
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 1 || end < start) return undefined;
  return [start, end];
}

export const READ_TEXT_SHEDDER: Shedder = {
  kind: "read.text",
  rungs: [
    { rung: 1, step: shedTextProse },
    { rung: 4, step: truncateLargestBody },
  ],
  refusalConvertible: true,
};
