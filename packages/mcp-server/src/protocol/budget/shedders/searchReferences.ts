// ---------------------------------------------------------------------------
// protocol v1 — the `search.references` shed ladder (P3a S3).
//
// NORMATIVE SOURCE: TL-PROTOCOL-V1-PHASE3A-PLAN-DRAFT.md §5.6 (the design's
// headline example), §5.7; DESIGN-v0.10-protocol-v1-contract-freeze.md A.5.9,
// A.6.2, A.13 ruling 1 clause 4 ([R5-9]/E3); erratum E1 (rung 6).
//
// LADDER: 1 (`hint`, `cursor_note`) -> 3 (`hop1`, `hop1_omitted`,
// `member_sweep`) -> 6 (`files[].snippets` -> `references[].text` -> whole
// `references[]` entries).
//
// ------------------- `limit.next` IS NEVER SHED, AT ANY RUNG ----------------
//
// This is the design's own headline: "`search.references` sheds snippets before
// it sheds the `limit.next` that carries the paging cursor." The token lives
// ONLY inside `limit.next.arguments.cursor` ([R4-7]; the committed
// `search.references.paged.json` pin confirms it has no second home), so
// dropping the call would recreate the "more pages exist with no call to get
// them" half-mechanism the design deletes.
//
// TWO INDEPENDENT MECHANISMS KEEP IT, and both are needed:
//   - NO STEP HERE TOUCHES `limit`. Every step rewrites `references`, `files`
//     or a named top-level key; `limit` is in no list.
//   - E3 CLAUSE 4 KEEPS THE EMITTER'S `next`. When this ladder does produce a
//     limit-bearing record on a response that already carries a `records`/`wire`
//     limit, `wireLimit.ts` keeps the emitter's cause AND its `next` and merges
//     only `omitted`. The cursor survives the merge by rule, not by luck.
//
// This is also the shape §7.1 flags as having NO COMPENSATING DELETION (zero-hit
// at 190 B, +33 B / +17.4% gross), so the ladder is deliberately conservative:
// it cuts the peek prefix and the snippets, and never the page mechanism.
// ---------------------------------------------------------------------------

import type { ToolCall } from "@tokenlighten/types";

import { emittableToolCall } from "../../refusal.js";
import {
  arrayAt,
  dropTrailingEntry,
  isRecord,
  peelOrdered,
  str,
  withKey,
  withoutKeys,
  type ShedContext,
  type ShedOutcome,
  type ShedPayload,
  type Shedder,
} from "./registry.js";

/**
 * §5.6's rung 1, verbatim: `hint`, then `cursor_note`.
 *
 * `cursor_note` LAST, and with a note against it. `searchFamily.ts` argues it
 * is not truncation prose at all but the INVALID-CURSOR disclosure — "a
 * caller's continuation token did not decode and the page was therefore served
 * FROM THE START" — so shedding it can leave page 1 looking like page N. The
 * plan nevertheless names it at rung 1, and rung 1 is reached only under real
 * budget pressure on a member that is 1,979 B at its paged baseline, so the
 * two positions are reconciled by ORDER rather than by exclusion: it is the
 * last prose to go, and it goes only when the response would otherwise not
 * ship. Raised as an S3 open item.
 */
const REFERENCES_PROSE: readonly string[] = ["hint", "cursor_note"];

function shedReferencesProse(payload: ShedPayload): ShedOutcome | undefined {
  return peelOrdered(payload, REFERENCES_PROSE, 1);
}

/**
 * §5.6's rung 3: the three rare extensions, cheapest-loss-first.
 *
 *   `hop1_omitted`  the count of one-hop callers this page did not expand —
 *                   a disclosure about an expansion that is itself optional.
 *   `hop1`          the one-hop caller expansion.
 *   `member_sweep`  the member-scoped sweep result.
 *
 * All three are optional attachments the emitter copies through
 * `REFERENCES_FIELDS`, and `keep`'s own "present and non-empty" rule already
 * guarantees absence rather than emptiness — so a step here only has to delete
 * what is there and let the runner book the bytes.
 */
const REFERENCES_EXTENSIONS: readonly string[] = ["hop1_omitted", "hop1", "member_sweep"];

function shedReferencesExtensions(payload: ShedPayload): ShedOutcome | undefined {
  return peelOrdered(payload, REFERENCES_EXTENSIONS, 3);
}

/**
 * Rung 6, sub-step 1: drop the `snippets` of the last `files[]` entry that has
 * them. Tail first, one file per invocation, same economy as `find`.
 */
function shedReferenceSnippets(payload: ShedPayload, context: ShedContext): ShedOutcome | undefined {
  const files = arrayAt(payload, "files");
  if (files === undefined) return undefined;

  for (let i = files.length - 1; i >= 0; i -= 1) {
    const entry = files[i];
    if (!isRecord(entry)) continue;
    const stripped = withoutKeys(entry, ["snippets"]);
    if (stripped === undefined) continue;
    const path = str(entry["path"]);
    if (path === undefined) return undefined;
    const continuation = referencesScopedTo(path, payload, context);
    if (continuation === undefined) return undefined;

    const nextFiles = [...files];
    nextFiles[i] = stripped.next;
    return {
      next: withKey(payload, "files", nextFiles),
      note: { rung: 6, refs: [path] },
      continuation,
    };
  }
  return undefined;
}

/**
 * Rung 6, sub-step 2: drop the `text` of the last `references[]` entry.
 *
 * `references[]` is a PEEK PREFIX of the same lines `files[]` already carries,
 * so its `text` is the most duplicated content on the response — which is why
 * `projectReferences` books a `references_omitted` cut as `metadata` rather
 * than `results`. The addressing (`path`, `line`) stays.
 */
function shedReferenceText(payload: ShedPayload, context: ShedContext): ShedOutcome | undefined {
  const references = arrayAt(payload, "references");
  if (references === undefined) return undefined;

  for (let i = references.length - 1; i >= 0; i -= 1) {
    const entry = references[i];
    if (!isRecord(entry)) continue;
    const stripped = withoutKeys(entry, ["text"]);
    if (stripped === undefined) continue;
    const path = str(entry["path"]);
    if (path === undefined) return undefined;
    const continuation = referencesScopedTo(path, payload, context);
    if (continuation === undefined) return undefined;

    const nextReferences = [...references];
    nextReferences[i] = stripped.next;
    return {
      next: withKey(payload, "references", nextReferences),
      note: { rung: 6, refs: [path] },
      continuation,
    };
  }
  return undefined;
}

/**
 * Rung 6, sub-steps 3 and 4: drop one trailing `references[]` entry.
 *
 * §5.6 lists "whole `references[]` entries" and "page-size reduction" as two
 * steps. They are the SAME operation from the wire's side — a page is the
 * prefix of `references[]` that this response carries — so they are one step
 * here, re-invoked by the runner, rather than two spellings of one cut booked
 * as two classes.
 *
 * FLOOR ZERO, uniquely on this member. A.5.9 and the required-set row both say
 * `references[]` may legitimately be EMPTY (the census's 190 B zero-hit body is
 * exactly that), `total` keeps reporting the true count, and `files[]` carries
 * the same lines in full — so an empty peek prefix beside a populated
 * `files[]` is not a degraded shape, it is the shape the emitter itself
 * produces when the prefix does not fit.
 */
function shedReferenceEntry(payload: ShedPayload, context: ShedContext): ShedOutcome | undefined {
  const references = arrayAt(payload, "references");
  if (references === undefined) return undefined;
  const trimmed = dropTrailingEntry(references, 0);
  if (trimmed === undefined) return undefined;

  const path = isRecord(trimmed.dropped) ? str(trimmed.dropped["path"]) : undefined;
  if (path === undefined) return undefined;
  const continuation = referencesScopedTo(path, payload, context);
  if (continuation === undefined) return undefined;

  return {
    next: withKey(payload, "references", trimmed.next),
    note: { rung: 6, refs: [path] },
    continuation,
  };
}

/**
 * The same references lookup, scoped to one file.
 *
 * `symbol` is REQUIRED on this member, so it is always available and always the
 * caller's own token (not a rendered composite the way `find`'s `query` is).
 * Scoping by `path` is a real narrowing that returns the references this step
 * withheld.
 *
 * THIS IS ONLY EVER THE BOUNDARY'S OWN `next` (E3 clause 3 / clause 5). Where
 * the emitter already published a paging cursor, clause 4 discards this call
 * and keeps the cursor — which is the whole point of the clause.
 */
function referencesScopedTo(
  path: string,
  payload: ShedPayload,
  context: ShedContext,
): ToolCall | undefined {
  const symbol = str(payload["symbol"]);
  if (symbol === undefined) return undefined;
  const args = context.args ?? {};
  const call: Record<string, unknown> = { action: "references", symbol, path };
  const cwd = str(args["cwd"]);
  if (cwd !== undefined) call["cwd"] = cwd;
  const lang = str(args["lang"]);
  if (lang !== undefined) call["lang"] = lang;
  return emittableToolCall({ tool: "search_files", arguments: call });
}

export const SEARCH_REFERENCES_SHEDDER: Shedder = {
  kind: "search.references",
  rungs: [
    { rung: 1, step: shedReferencesProse },
    { rung: 3, step: shedReferencesExtensions },
    { rung: 6, step: shedReferenceSnippets },
    { rung: 6, step: shedReferenceText },
    { rung: 6, step: shedReferenceEntry },
  ],
  refusalConvertible: true,
};
