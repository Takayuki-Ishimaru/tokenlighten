// ---------------------------------------------------------------------------
// protocol v1 — the `search.tree` shed ladder (P3a S3).
//
// NORMATIVE SOURCE: TL-PROTOCOL-V1-PHASE3A-PLAN-DRAFT.md §5.5 ("`search.tree`
// mirrors this: rung 1, then depth/entry trimming with a `wire` limit naming a
// narrower `tree` call"), §5.7; DESIGN-v0.10-protocol-v1-contract-freeze.md
// A.5.10, A.6.2, A.13 ruling 1 ([R5-9]); erratum E1 (rung 6).
//
// LADDER: 1 (`note`) -> 6 (trim the rendered `tree`, naming a SHALLOWER tree
// call) — and the second rung DECLINES unless a shallower call exists.
//
// ------------------------- THE ONE REAL TENSION -----------------------------
//
// §5.5 says the rung-6 limit names "a narrower `tree` call". `projectTree`'s
// own [R5-9] note says the opposite about the EMITTER's cut: a continuation
// would have to name a SUBTREE, "`depth` cannot be it — a bigger `depth`
// returns MORE of the same over-cap listing and a smaller one returns less,
// never the remainder — and picking one of the listed subdirectories is the
// server making a choice only the caller can make". That is why the emitter's
// truncation takes the `capped` arm unconditionally.
//
// BOTH ARE RIGHT ABOUT DIFFERENT CALLS, and the reconciliation is what this
// module implements:
//
//   A SMALLER `depth` IS NOT A REMAINDER, so it is not offered as one. What it
//   IS, exactly, is a COMPLETE tree of the same root that fits — which is a
//   real recovery from "this listing did not fit", and the only one the server
//   can name without choosing a subdirectory on the caller's behalf. The
//   response says `omitted:["results"]`; the `next` says "here is the whole
//   shape at one level less".
//
//   WHERE NO SHALLOWER CALL EXISTS the step DECLINES (E5) rather than invent
//   one: `depth` absent (the archive-scoped variant has none) or already 1.
//   An archive tree therefore sheds nothing at rung 6 and keeps whatever
//   `capped` limit the emitter gave it — clause 2 of the E3 merge.
//
// `archive.total_entries` IS NEVER TOUCHED. It is the same inventory invariant
// §5.5 states for `search.matches` — the count is computed over the full
// manifest and a shed does not reduce it.
//
// PI-08's `scope_report` (alpha.2) IS NEVER SHED, BY OMISSION FROM EVERY RUNG
// BELOW — deliberate, not an oversight. It is a handful of small integers
// plus a 2-value enum (DESIGN-v0.10-expansion-plan-v1.3.md:1683 "countは常時
// ... short keysをsafe codec対象にする"), negligible next to `tree` itself, so
// there is no meaningful budget to reclaim by peeling it. Both declared rungs
// already target a field they own and nothing more (rung 1: `note` only;
// rung 6: `tree`'s line list only) — neither is widened to also drop
// scope_report, so the generic prose rung does not reach in and take a field
// it was not written for. Shedding scope_report would also be backwards: it
// is the caller's evidence about what the response is NOT showing, and that
// evidence matters MOST exactly when the response is small enough to already
// be under budget pressure. It therefore rides through every rung untouched,
// same as `root`/`tree`/`depth`, unless the whole response converts to a
// refusal (`refusalConvertible: true` below) because even the rung-6 floor
// does not fit.
// ---------------------------------------------------------------------------

import type { ToolCall } from "@tokenlighten/types";

import { emittableToolCall } from "../../refusal.js";
// PI-05 generalization (beta.1+): the search family's shared hint/next
// arbitration — see that module's header for the normative precedence
// table shallowerTree now defers to (thin adapter over
// sanctionSearchContinuation).
import { NO_ABSENT_TERMS, sanctionSearchContinuation } from "../../../features/search/nextActionPolicy.js";
import {
  peelOrdered,
  str,
  withKey,
  type ShedContext,
  type ShedOutcome,
  type ShedPayload,
  type Shedder,
} from "./registry.js";

/** `note` is the only prose this member carries, and E-7 canonical. */
function shedTreeProse(payload: ShedPayload): ShedOutcome | undefined {
  return peelOrdered(payload, ["note"], 1);
}

/**
 * Trim the tail of the rendered `tree`, halving the surviving line count.
 *
 * BUDGET-BLIND AND GEOMETRIC, like `read.text`'s truncation: the runner
 * re-invokes while the payload is over budget, so the cut converges without the
 * step ever measuring. It stops at one line — `tree` is REQUIRED, and `""` is a
 * real value on this member (an empty directory, explained by `note`), so
 * shedding down to it would spell a real state falsely.
 */
function shedTreeLines(payload: ShedPayload, context: ShedContext): ShedOutcome | undefined {
  const tree = payload["tree"];
  if (typeof tree !== "string" || tree === "") return undefined;
  const lines = tree.split("\n");
  if (lines.length < 2) return undefined;

  const continuation = shallowerTree(payload, context);
  if (continuation === undefined) return undefined;

  const keep = Math.ceil(lines.length / 2);
  if (keep >= lines.length) return undefined;
  const root = str(payload["root"]);

  return {
    next: withKey(payload, "tree", lines.slice(0, keep).join("\n")),
    note: { rung: 6, ...(root !== undefined ? { refs: [root] } : {}) },
    continuation,
  };
}

/**
 * The same tree, one level shallower.
 *
 * `depth` is read off the RESPONSE, not the request: the response's `depth` is
 * what the walk actually used (the request may have omitted it and taken a
 * default), so a call built from it is narrower than what happened rather than
 * narrower than what was asked. Built through `emittableToolCall`, so a `depth`
 * this server would refuse never ships.
 */
function shallowerTree(payload: ShedPayload, context: ShedContext): ToolCall | undefined {
  const depth = payload["depth"];
  if (typeof depth !== "number" || !Number.isInteger(depth) || depth <= 1) return undefined;
  const root = str(payload["root"]);
  if (root === undefined) return undefined;

  const args = context.args ?? {};
  const call: Record<string, unknown> = { action: "tree", path: root, depth: depth - 1 };
  const cwd = str(args["cwd"]);
  if (cwd !== undefined) call["cwd"] = cwd;
  // `tree` has no absence concept and never carries `queries[]`; routed
  // through the same shared gate every search-family continuation passes
  // through (nextActionPolicy.ts) so the invariant is enforced by one
  // implementation rather than re-derived per family.
  const sanctioned = sanctionSearchContinuation(call, { absentTerms: NO_ABSENT_TERMS });
  if (sanctioned === undefined) return undefined;
  return emittableToolCall({ tool: "search_files", arguments: sanctioned });
}

export const SEARCH_TREE_SHEDDER: Shedder = {
  kind: "search.tree",
  rungs: [
    { rung: 1, step: shedTreeProse },
    { rung: 6, step: shedTreeLines },
  ],
  refusalConvertible: true,
};
