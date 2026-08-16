// ---------------------------------------------------------------------------
// protocol v1 — the `search_files` response family, authored (C2-4).
//
// NORMATIVE SOURCE: DESIGN-v0.10-protocol-v1-contract-freeze.md §10.3 Appendix A
// (Revision 4, user-approved 2026-08-13) A.5.8–A.5.10 and the A.5.3–A.5.10
// preamble (Rules T and K), plus §4.4 (the gaps / limits / evidence trichotomy)
// and §2.6 (the one refusal shape). A.9.2 rows 5, 6, 8, 9, 10, 19 and 20 are
// closed here or in `refusal.ts`.
//
// WHAT THIS MODULE IS. `protocol/envelope.ts` decides WHICH member a response is
// (D4's `kind`); this module decides what a `search.*` member's BODY looks like.
// It is `readFamily.ts`'s sibling and follows the same division of labour: the
// emitters keep the shapes their own in-process readers depend on
// (`findReferences()`'s `next_call`, `getCurrentDiff()`'s `totalFiles`,
// `buildCompactTree()`'s `ok:false`), and the WIRE is reshaped once, at the
// funnel. Reshaping at the producers would change what the module-level callers
// and their specs see, which is a semantics change §0.2 forbids.
//
// THE THREE RULES THIS MODULE APPLIES.
//
//  RULE K (A.5.3–A.5.10 preamble). The top-level `kind` is the sole
//  discrimination contract, so `search.matches` covers `find`/`symbols`/
//  `locate`/`diff` through an INTERNAL tag: `matches: {form, …}`. That wrapper
//  is a new object, not a rename — the four bodies ship flat today.
//
//  RULE T (A.5.3–A.5.10 preamble, §4.4). Response-level truncation is `limit`
//  and appears in no other form; absence of `limit` IS completeness. Every
//  `truncated` / `truncation_reason` / `files_omitted` / `references_omitted` /
//  `next_call` / `cursor_note` dialect on this family folds into one `Limit`.
//
//  [R4-4] (A.5.8, adjudicated 2026-08-13). ADDRESSING IS PER FORM, NOT PER
//  MEMBER. `query` exists only on `find`; `symbols`, `locate` and `diff` carry
//  none, and `diff` takes no query ARGUMENT at all. A field a form does not have
//  is never required of it, and is never fabricated to satisfy an envelope.
//
// DISCLOSED DEVIATIONS are each declared at the `KEPT_ON_*` table that carries
// them, per the C2-3 precedent: keep reversibly, state the capability the
// deletion would lose, raise a Revision-5 row.
// ---------------------------------------------------------------------------

import type { Kind, Limit, OmittedClass, RefusalCode, ToolCall } from "@tokenlighten/types";

import { emittableToolCall } from "./refusal.js";

type Body = Record<string, unknown>;

function isRecord(value: unknown): value is Body {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** E-1: copy `keys` from `from` onto `onto` iff the value is present and non-empty. */
function keep(onto: Body, from: Body, keys: readonly string[]): void {
  for (const key of keys) {
    const value = from[key];
    if (value === undefined || value === null) continue;
    if (typeof value === "string" && value === "") continue;
    if (Array.isArray(value) && value.length === 0) continue;
    if (isRecord(value) && Object.keys(value).length === 0) continue;
    onto[key] = value;
  }
}

// ---------------------------------------------------------------------------
// A.2.7 `Limit` — Rule T's single carrier, and the fold rule that picks a cause
// ---------------------------------------------------------------------------

/**
 * THE CANONICAL LIMIT FOLD RULE (P3a advisory, BINDING for this family).
 *
 * A.2.7 gives a response AT MOST ONE `Limit` (A.8 rule E-4), but a single
 * response can hit several delivery-side stops at once — `references` is the
 * measured case: `truncation_reason: "match-cap+bytes"` names a record cap AND
 * the byte budget in one value (A.9.2 row 19). The rule, in four clauses:
 *
 *  1. ONE `Limit` PER RESPONSE. Not one per cause, not an array.
 *  2. WHEN DELIVERY CAUSES CO-OCCUR, PRIORITY IS `records` > `wire` > `time`.
 *     `records` wins because it is evaluated FIRST in every pipeline in this
 *     tree (the record cap selects the candidate set; the byte fit then trims
 *     what survived — `findReferences.ts`'s `matchTruncated` at :519 is decided
 *     before `fitReferencesPrefix` at :612 ever runs), and because it is the
 *     cause a caller can ACT on: it is the one that carries a page-advancing
 *     `next` (§4.4, E-5). Reporting `wire` for a response that also overflowed
 *     its record cap would tell the caller to expect the same records in fewer
 *     bytes, which is false.
 *  3. NEITHER `next`-LESS ARM IS A DELIVERY CAUSE, AND THE TWO ARE NOT
 *     INTERCHANGEABLE. `source` = THE UNDERLYING CONTENT RAN OUT. `capped` =
 *     IT EXISTS AND THIS RESPONSE COULD NOT REACH IT. Both forbid `next`
 *     (§4.4), and that is all they share.
 *  4. A `wire`/`records` LIMIT WITH NO NAMEABLE `next` DEGRADES TO `capped`.
 *     E-5 makes `next` REQUIRED on those two arms; emitting one without a call
 *     would send the caller at a wall, which is the failure §4.4 names by name.
 *
 * [R5-9] WHY CLAUSES 3 AND 4 NOW SAY `capped` WHERE THEY SAID `source`
 * (ratified 2026-08-14). Until this change the degradation target was `source`,
 * and the encoding gap C2-3 declared as a Revision-5 candidate was the fact
 * that `diff` and `tree` below took that arm unconditionally. The row was
 * sustained on the CONSUMER half: the shipped guide teaches "`source` never has
 * one", i.e. `source` = terminal, so labelling a cap `source` was not an
 * under-informative hint but an active STOP instruction about content that was
 * still there. `capped` is the fifth arm minted for exactly this
 * (`packages/types/src/mcp/protocol.ts`).
 *
 * `source` IS NOW UNREACHABLE FROM THIS FAMILY, AND THAT IS CORRECT, NOT AN
 * OVERSIGHT. For a search, "the underlying content ran out" is not a
 * withholding at all — a walk that found every match it was going to find is a
 * COMPLETE result (Rule T: absence of `limit` IS completeness; a zero-match
 * `find` carries `absence`, not a `limit`). And it is checkable rather than
 * asserted: all five call sites gate on `withheld: body["truncated"] === true`,
 * and `truncated` is set by a cap in every one of them.
 *
 * The READ family is different and keeps both arms — `readFamily.ts`'s
 * `limitFrom` can be reached by an `omitted[]` entry naming a handle the server
 * never learned a path for, which is a reference that resolves to nothing
 * rather than a cap. The discriminator lives there, as `capFired`.
 */
function foldLimit(input: {
  withheld: boolean;
  records?: boolean;
  wire?: boolean;
  time?: boolean;
  omitted?: readonly OmittedClass[];
  next?: ToolCall | undefined;
}): Limit | undefined {
  if (!input.withheld) return undefined;
  const omitted = [...new Set(input.omitted ?? [])];
  const withOmitted = <T extends { cause: string }>(limit: T): T =>
    (omitted.length > 0 ? { ...limit, omitted } : limit);

  // Clause 2: records > wire > time. Clause 4: no `next` degrades to `capped`.
  if (input.records === true || input.wire === true) {
    if (input.next === undefined) return withOmitted({ cause: "capped" } as Limit);
    const cause = input.records === true ? "records" : "wire";
    return withOmitted({ cause, next: input.next } as Limit);
  }
  if (input.time === true) {
    return withOmitted(
      (input.next !== undefined ? { cause: "time", next: input.next } : { cause: "time" }) as Limit,
    );
  }
  // Clause 3: a cap fired and named no continuation. `capped` never carries a
  // `next` — and it does not claim the content is gone either.
  return withOmitted({ cause: "capped" } as Limit);
}

// ---------------------------------------------------------------------------
// A.5.8 `search.matches` — `find`
// ---------------------------------------------------------------------------

/**
 * A.5.8's declared `find` field list, verbatim.
 *
 * `truncated` is absent from it BY RULE T (it becomes `limit`), and so are the
 * per-file annotations `servedFindEscalation.ts` stamps INSIDE `files[]`
 * (`served_this_session`, `lines_held`, `matched_lines_outside_served`) — those
 * ride inside the copied array as an element-level extension of
 * `FindFileGroup`, disclosed rather than stripped, because they are the
 * residency honesty the 2026-08-09 range-honesty fix added.
 */
const FIND_FIELDS = [
  "query", "files", "total_files", "total_matches", "literal",
  "inventory_complete", "matched_terms", "matched_variant", "did_you_mean",
  // S5 (C2-9, 2026-08-14) — raised with the `repeated-all-served-find` entry in
  // `refusal.ts` and revertible with it. `did_you_mean_basis` is the EVIDENCE
  // for the suggestion beside it: `{content_matched}` says how many of the
  // ranked candidates were chosen because they literally CONTAIN the probe
  // rather than because their filename resembles it. A.5.8 lists the suggestion
  // and not its basis, so the ranking arrives unfalsifiable — a caller cannot
  // tell a content hit from a filename guess, which is the exact distinction
  // the 2026-08-08 did_you_mean ranking fix exists to make.
  "did_you_mean_basis",
  "hint", "note", "inventory", "absence", "member_sweep", "related_lookups",
  "hop1", "hop1_omitted",
  "partially_served", "partial_served_note",
  "all_served", "all_served_occurrence", "served_note",
] as const;

/**
 * DISCLOSED DEVIATIONS on `matches.find` (Revision-5 rows):
 *
 *  - `omitted`  the per-layer WALK-SKIP counts (`{ignored, gitignored,
 *               tokenlighten_ignored, oversize, symlinks, non_text, secrets}`,
 *               `findText.ts:1300-1306`). A.5.8 has no slot for it. It is NOT a
 *               delivery limit and must not become one: those paths were never
 *               candidates, so folding them into `Limit.omitted` would claim the
 *               server withheld results it could have sent. Kept under the same
 *               name; the collision with `Limit.omitted` is structurally
 *               namespaced (`matches.omitted` vs `limit.omitted`) and the two
 *               shapes are disjoint (a count map vs a three-value enum array).
 *  - `archive`  the archive-scoped find's provenance
 *               (`ArchiveFindResult.archive_scope`, `tools/archive.ts:169-190`).
 *               Archive-scoped find has NO appendix home at all: A.5.8 is
 *               transcribed from the filesystem `FindResponse` only. The
 *               accommodation MIRRORS A.5.10's `archive?` block so the two
 *               archive-scoped members read the same way. `archive_scope.path`
 *               is dropped because every `files[]` element already carries the
 *               outer archive path.
 *  - `warnings` the archive reader's own disclosure list (skipped entries,
 *               unsupported members). A.5.10 carries it INSIDE its `archive`
 *               block; A.5.8's accommodation is specified at four fields, so it
 *               rides at the form level here. Dropping it would silently delete
 *               the only statement that part of the container was not scanned.
 */
const KEPT_ON_FIND = ["omitted", "warnings"] as const;

/** A.5.10's `archive` shape, mirrored onto `find` (see KEPT_ON_FIND). */
function findArchiveBlock(body: Body): Body | undefined {
  const scope = body["archive_scope"];
  if (!isRecord(scope)) return undefined;
  const block: Body = {};
  keep(block, scope, ["format", "entries", "scanned_entries", "omitted_entries"]);
  // `entries`/`scanned_entries`/`omitted_entries` are counts: 0 is a real value
  // and `keep` would drop it only for `""`/`[]`/`{}`, not for a number.
  return Object.keys(block).length > 0 ? block : undefined;
}

/**
 * The continuation a truncated `find` can name.
 *
 * A truncated find always ships `inventory` — the EXHAUSTIVE list of matched
 * files (or directories) — so the server can name a file the response did not
 * serve and scope the SAME query at it. That is a real page-advancing call, not
 * a re-issue of what the caller already holds (the dead-end class the
 * 2026-08-08 forensics closed and §2.1.2 forbids), which is why an inventory
 * entry ALREADY present in `files[]` is skipped.
 *
 * `queries[]` is echoed from the REQUEST rather than from the body: the body's
 * `query` renders a multi-token call as `"a OR b"`, and sending that back as a
 * single `query` would run a different search.
 */
function findNext(body: Body, args: Body): ToolCall | undefined {
  const inventory = body["inventory"];
  if (!Array.isArray(inventory) || inventory.length === 0) return undefined;
  const served = new Set(
    (Array.isArray(body["files"]) ? body["files"] : [])
      .filter(isRecord)
      .map((file) => str(file["path"]))
      .filter((path): path is string => path !== undefined),
  );
  let scope: string | undefined;
  for (const entry of inventory) {
    if (!isRecord(entry)) continue;
    const path = str(entry["path"]);
    if (path !== undefined) {
      if (served.has(path)) continue;
      scope = path;
      break;
    }
    const dir = str(entry["dir"]);
    if (dir !== undefined) { scope = dir; break; }
  }
  if (scope === undefined) return undefined;

  const queries = args["queries"];
  const call: Body = { action: "find", path: scope };
  if (Array.isArray(queries) && queries.length > 0) call["queries"] = queries;
  else {
    const query = str(args["query"]) ?? str(body["query"]);
    if (query === undefined) return undefined;
    call["query"] = query;
  }
  if (args["regex"] !== undefined) call["regex"] = args["regex"];
  const cwd = str(args["cwd"]);
  if (cwd !== undefined) call["cwd"] = cwd;
  return emittableToolCall({ tool: "search_files", arguments: call });
}

function projectFind(body: Body, args: Body): Body {
  const matches: Body = { form: "find" };
  keep(matches, body, FIND_FIELDS);
  // A.5.8's required set: `find` is the one form WITH a query, and `literal` is
  // a boolean whose `false` is meaningful, so neither goes through `keep`.
  if (matches["query"] === undefined) matches["query"] = str(body["query"]) ?? "";
  matches["literal"] = body["literal"] === true;
  matches["total_files"] = num(body["total_files"]) ?? 0;
  matches["total_matches"] = num(body["total_matches"]) ?? 0;
  if (!Array.isArray(matches["files"])) matches["files"] = [];
  keep(matches, body, KEPT_ON_FIND);
  const archive = findArchiveBlock(body);
  if (archive !== undefined) matches["archive"] = archive;

  const projected: Body = { matches };
  const limit = foldLimit({
    withheld: body["truncated"] === true,
    wire: true,
    omitted: ["results"],
    next: findNext(body, args),
  });
  if (limit !== undefined) projected["limit"] = limit;
  return projected;
}

// ---------------------------------------------------------------------------
// A.5.8 `search.matches` — `symbols`
// ---------------------------------------------------------------------------

/**
 * The continuation a truncated `symbols` can name (A.9.2 row 19's sibling gap).
 *
 * `SearchSymbolsResult` has NO paging mechanism: `truncated` is a bare boolean
 * and there is no cursor, no `next_call`, and no `after`. But `total` is the
 * true pre-cap count and `limit` IS an advertised argument, so a re-issue with
 * an explicit `limit` equal to the true total is both executable and
 * progressive — the server SYNTHESISES the call the emitter never built.
 * Disclosed: this is a v1 addition, not a transcription.
 *
 * It is emitted ONLY when records actually remain (`total > locations.length`).
 * When every record was served and `truncated` is still set, the cut was the
 * byte fit shedding ROLE ANNOTATIONS (`searchSymbols.ts:220-229` sheds roles
 * before it would drop a location), and a larger `limit` returns exactly the
 * same page — so that case takes the `source` arm instead of promising a
 * recovery that does not exist (fold-rule clause 4).
 */
/**
 * EXPORTED FOR THE BOUNDARY SHEDDER (P3a S3), and for nothing else. The
 * `symbols` rung-6 step drops trailing `locations[]` entries and needs the SAME
 * continuation this function builds for the emitter's own cut — one
 * implementation of "re-issue with an explicit `limit` equal to the true
 * total", not two. Zero wire effect: the export changes no call site here.
 */
export function symbolsNext(body: Body, args: Body): ToolCall | undefined {
  const total = num(body["total"]) ?? 0;
  const served = Array.isArray(body["locations"]) ? body["locations"].length : 0;
  if (total <= served) return undefined;
  const call: Body = { action: "symbols", limit: total };
  const query = str(args["query"]);
  if (query !== undefined) call["query"] = query;
  const path = str(args["path"]);
  if (path !== undefined) call["path"] = path;
  if (query === undefined && path === undefined) return undefined;
  const cwd = str(args["cwd"]);
  if (cwd !== undefined) call["cwd"] = cwd;
  const lang = str(args["lang"]);
  if (lang !== undefined) call["lang"] = lang;
  if (args["includeScores"] !== undefined) call["includeScores"] = args["includeScores"];
  return emittableToolCall({ tool: "search_files", arguments: call });
}

function projectSymbols(body: Body, args: Body): Body {
  const matches: Body = { form: "symbols" };
  matches["locations"] = Array.isArray(body["locations"]) ? body["locations"] : [];
  matches["total"] = num(body["total"]) ?? 0;
  keep(matches, body, ["note"]);

  const projected: Body = { matches };
  const next = symbolsNext(body, args);
  const limit = foldLimit({
    withheld: body["truncated"] === true,
    // Clause 2: a record cap is the actionable cause and outranks the byte fit
    // that ran after it. Clause 3 sends the roles-only cut to `capped`, where
    // `omitted:["metadata"]` says what was shed without promising it back.
    //
    // [R5-9]: the roles-only cut is the one place a "narrower symbols request"
    // sounds constructible, and is not. It is reached precisely when
    // `total <= locations.length` — every RECORD was served and the byte fit
    // shed the role ANNOTATIONS off them (`searchSymbols.ts:220-229`). The only
    // narrowing argument `symbols` has is `limit`, and `symbolsNext` already
    // declined to build one for exactly this reason: re-issuing with any
    // `limit` re-runs the same cut and returns the same roles-less rows. So
    // `capped` — the metadata exists, this response could not carry it, and
    // there is no call that gets it back.
    records: next !== undefined,
    omitted: next !== undefined ? ["results"] : ["metadata"],
    next,
  });
  if (limit !== undefined) projected["limit"] = limit;
  return projected;
}

// ---------------------------------------------------------------------------
// A.5.8 `search.matches` — `locate` and `diff`
// ---------------------------------------------------------------------------

/**
 * A.5.8: `{form:"locate", result}` — `LocateOutput` is already a declared
 * discriminated union on `hit` and is carried over UNCHANGED. A `hit:false`
 * locate is a valid, COMPLETE result (§4.3), never a refusal, and
 * `LocateAbstainData.next` stays the prose string it is today: A.2.7's `next`
 * vocabulary and this one are deliberately different things (the appendix keeps
 * both), so "fixing" it here would delete a documented affordance.
 */
function projectLocate(body: Body): Body {
  return { matches: { form: "locate", result: body } };
}

/**
 * A.5.8 + A.9.2 row 8: `totalFiles` -> `total_files`, one spelling in v1.
 * `GetCurrentDiffResult` keeps `totalFiles` (its module-level callers and their
 * specs read it); the rename happens once, here, on the wire.
 *
 * A.9.2 row 9 (`error?: string` -> `refusal`) is NOT here: a body carrying
 * `error` never reaches this function, because `searchRefusalCodeFor` below
 * classifies it as a `refusal` before the success projection runs.
 *
 * TRUNCATION TAKES THE `capped` ARM (fold-rule clause 3). [R5-9] asked whether
 * a re-scoped `search_files` call could be constructed here instead; it cannot,
 * and the evidence is in `tools/getCurrentDiff.ts:186-198`. The cap drops WHOLE
 * FILES off the end of `allFiles` and the response never names the ones it
 * dropped — `files[]` holds only what fitted, `totalFiles` is a count. So a
 * `{action:"diff", path:X}` continuation would have to invent X, and `path` is
 * the only narrowing argument there is: `depth` does not apply, `maxTokens`
 * (:143) is not consulted by the cap at all, and there is no cursor, offset or
 * per-file re-entry. Naming one of the caller's own paths for it is the §2.1
 * `await_input` case, not a `next`.
 *
 * So: not `wire` (it would promise a recovery that does not exist — §4.4's
 * loop-against-a-wall), and no longer `source` (the withheld files are sitting
 * in the working tree; the guide reads `source` as terminal). `capped` says the
 * true thing: a cap cut this, the rest is still there, and the narrowing choice
 * is yours.
 */
function projectDiff(body: Body): Body {
  const matches: Body = { form: "diff" };
  matches["files"] = Array.isArray(body["files"]) ? body["files"] : [];
  matches["total_files"] = num(body["totalFiles"]) ?? num(body["total_files"]) ?? 0;

  const projected: Body = { matches };
  const limit = foldLimit({
    withheld: body["truncated"] === true,
    omitted: ["results"],
  });
  if (limit !== undefined) projected["limit"] = limit;
  return projected;
}

// ---------------------------------------------------------------------------
// A.5.9 `search.references`
// ---------------------------------------------------------------------------

/**
 * DISCLOSED DEVIATION on `search.references` (Revision-5 row): `cursor_note`.
 *
 * A.5.9 lists it among the fields "deleted into `limit` per Rule T", but it is
 * not a truncation dialect — it is the INVALID-CURSOR disclosure
 * (`findReferences.ts:363`), emitted when a caller's continuation token did not
 * decode and the page was therefore served FROM THE START. It can appear on a
 * response that withheld nothing, where there is no `limit` to carry it, and
 * deleting it there converts a caller error into a silent wrong answer: page 1
 * returned as if it were page N. Kept until A.5.9 names a carrier.
 */
const KEPT_ON_REFERENCES = ["cursor_note"] as const;

const REFERENCES_FIELDS = [
  "symbol", "references", "files", "total",
  "absence", "member_sweep", "hint", "hop1", "hop1_omitted",
] as const;

/**
 * A.9.2 row 19, DECIDED: `truncation_reason: "match-cap+bytes"` maps to
 * `Limit.cause:"records"`.
 *
 * The value names two stops at once and `Limit.cause` is single-valued. The
 * canonical fold rule (see `foldLimit`) picks `records` for two independent
 * reasons that agree here: it is the OUTER constraint — `effectiveMatchLimit`
 * selects the candidate window (`findReferences.ts:519`) before
 * `fitReferencesPrefix` (:612) trims what survived, so the byte fit can only
 * ever cut a set the record cap already bounded — and it is the ACTIONABLE
 * cause under §4.4/E-5, since the page-advancing `next` is the SAME
 * `continuationNextCall` in both branches (:662-664). Reporting `wire` would
 * tell a caller that the missing references fit in a bigger response; they do
 * not, because the cap removed them before the budget was consulted.
 *
 * [R4-7]: the opaque cursor does NOT become a top-level field. It already lives
 * inside `next_call.arguments.cursor`; v1 moves the CALL from `next_call` to
 * `limit.next` and the cursor rides inside it unchanged. §2.1.2's "strictly
 * larger" presumption is deliberately NOT implemented — the measured shape wins.
 */
function projectReferences(body: Body): Body {
  const projected: Body = {};
  keep(projected, body, REFERENCES_FIELDS);
  // A.5.9's required set: `symbol` always, and `references`/`files`/`total`
  // may legitimately be empty (the census's 190 B body is exactly that).
  if (projected["symbol"] === undefined) projected["symbol"] = str(body["symbol"]) ?? "";
  if (!Array.isArray(projected["references"])) projected["references"] = [];
  if (!Array.isArray(projected["files"])) projected["files"] = [];
  projected["total"] = num(body["total"]) ?? 0;
  keep(projected, body, KEPT_ON_REFERENCES);

  const reason = str(body["truncation_reason"]);
  const omitted: OmittedClass[] = [];
  // Whole matched FILES this page did not carry are results.
  if ((num(body["files_omitted"]) ?? 0) > 0) omitted.push("results");
  // `references[]` is a PEEK PREFIX of the same lines `files[]` already carries,
  // so what it does not repeat is a projection of the response about itself.
  if ((num(body["references_omitted"]) ?? 0) > 0) omitted.push("metadata");
  const limit = foldLimit({
    withheld: body["truncated"] === true,
    records: reason === "match-cap" || reason === "match-cap+bytes",
    wire: reason === "bytes",
    omitted,
    next: emittableToolCall(body["next_call"]),
  });
  if (limit !== undefined) projected["limit"] = limit;
  return projected;
}

// ---------------------------------------------------------------------------
// A.5.10 `search.tree`
// ---------------------------------------------------------------------------

/**
 * A.5.10. `mode:"tree"` is gone (D4 — `kind` is the discriminator, deleted at
 * both emit sites in `server.ts`), and the archive-scoped variant's
 * `total_entries`/`format`/`warnings` nest under `archive`, which is also what
 * distinguishes the two variants: the filesystem tree has `depth`, the archive
 * tree has none.
 *
 * TRUNCATION TAKES THE `capped` ARM (fold-rule clause 3). [R5-9] asked the same
 * re-scope question as `diff` above and it fails the same way, for a different
 * reason: `buildCompactTree` cuts the RENDERED LINE LIST at a byte cap
 * (`TREE_CAP_BYTES`, `tools/exploreTree.ts:35`) and the archive manifest cuts at
 * an entry cap, so a continuation would have to name a SUBTREE. `depth` cannot
 * be it — a bigger `depth` returns MORE of the same over-cap listing and a
 * smaller one returns less, never the remainder — and picking one of the listed
 * subdirectories is the server making a choice only the caller can make (§2.1's
 * `await_input` case, not a `next`).
 *
 * `capped` rather than `source` because the unlisted entries plainly exist; the
 * tree text also keeps its own truncation marker, so the caller can see where
 * it stopped and re-request from there.
 */
function projectTree(body: Body): Body {
  const projected: Body = {
    root: str(body["root"]) ?? "",
    // `tree` is REQUIRED and `""` is a real value here (an empty directory,
    // explained by `note`), so E-1's empty-string rule does not apply to it.
    tree: typeof body["tree"] === "string" ? body["tree"] : "",
  };
  const depth = num(body["depth"]);
  if (depth !== undefined) projected["depth"] = depth;

  const format = str(body["format"]);
  if (format !== undefined) {
    projected["archive"] = {
      format,
      total_entries: num(body["total_entries"]) ?? 0,
      warnings: Array.isArray(body["warnings"]) ? body["warnings"] : [],
    };
  }
  keep(projected, body, ["note"]);

  const limit = foldLimit({
    withheld: body["truncated"] === true,
    omitted: ["results"],
  });
  if (limit !== undefined) projected["limit"] = limit;
  return projected;
}

// ---------------------------------------------------------------------------
// A.9.2 rows 9 + 10 — the two success-shaped bodies that are refusals in v1
// ---------------------------------------------------------------------------

/**
 * Two `search_files` branches return a FAILURE through `toolOk` with no
 * `isError` and no `ok:false`, so the generic funnel test
 * (`isRefusalBody`) cannot see them. Both are D6 conversions, and both are done
 * HERE rather than at the producer so the module-level callers and their specs
 * keep the shapes they read:
 *
 *  - ROW 9. `GetCurrentDiffResult.error` (`tools/getCurrentDiff.ts:171-176`) —
 *    the field that produced §4.1's measured 7,576-byte response of which
 *    ~7.4 KB was raw `git diff` usage text. In v1 a failed `git diff` is a
 *    refusal, and `Refusal.detail`'s 400-char cap is what bounds it.
 *    `read-error` is the A.7.1 code: the server could not read the diff. It is
 *    NOT `index-error` (that is `write/pathlessEdit.ts`'s pathless-edit index)
 *    and not `invalid-input` (the caller's arguments were fine).
 *
 *  - ROW 10, THE THIRD SITE — BEYOND THE ROW'S CITED RANGE. The row names
 *    `buildCompactTree`'s `{ok:false}` blocks (`exploreTree.ts:342-351` and
 *    :356-367), which the C2-2 funnel already reclassifies. The SYMLINK-ESCAPE
 *    guard at :373 returns `{refused:true}` and NO `ok:false`, so it is
 *    invisible to that test and ships today as a successful, empty
 *    `search.tree` — a refusal wearing a success's shape, which is precisely
 *    what D6 deletes. Converted explicitly; `path-outside-workspace` is the
 *    A.7.1 code (the guard fires when the requested subPath's realpath leaves
 *    the workspace).
 */
export function searchRefusalCodeFor(action: string, body: Body): RefusalCode | undefined {
  if (action === "diff" && str(body["error"]) !== undefined) return "read-error";
  if (action === "tree" && body["refused"] === true) return "path-outside-workspace";
  return undefined;
}

/**
 * Stamp the A.7.1 code onto a body the two conversions above reclassified, so
 * `buildRefusal` resolves it the same way it resolves an emitter-declared one.
 * Returns the body unchanged when no conversion applies — every OTHER refusal
 * reaching the funnel already carries its own `code`/`reason`/prose.
 */
export function searchRefusalBody(action: string, body: Body): Body {
  const code = searchRefusalCodeFor(action, body);
  if (code === undefined) return body;
  return { ...body, code };
}

// ---------------------------------------------------------------------------
// The dispatcher
// ---------------------------------------------------------------------------

/** True iff `kind` is a member this module authors. */
export function isSearchFamilyKind(kind: Kind): boolean {
  return kind.startsWith("search.");
}

/**
 * Project one search-family success body onto its A.5.x member.
 *
 * `action` is the action the dispatcher RESOLVED, which is what tells the four
 * `search.matches` forms apart — `kind` cannot, by construction (Rule K).
 * `args` is the request, needed to SYNTHESISE a continuation call that echoes
 * what the caller actually asked for rather than a rendering of it.
 *
 * Returns the body UNCHANGED for a shape this module does not recognise, per
 * the C2-3 precedent: a projector that guesses is worse than one that declines,
 * because a wrong `form` is a lie a client branches on. The one reachable case
 * is `action:"office"` — an Office extraction served through `search_files`,
 * whose member is `read.artifact` and which now declares that kind at its emit
 * site rather than defaulting into this family.
 */
export function projectSearchBody(kind: Kind, body: Body, action: string, args: Body): Body {
  if (kind === "search.references") return projectReferences(body);
  if (kind === "search.tree") return projectTree(body);
  if (kind !== "search.matches") return body;
  switch (action) {
    case "find":    return projectFind(body, args);
    case "symbols": return projectSymbols(body, args);
    case "locate":  return projectLocate(body);
    case "diff":    return projectDiff(body);
    default:        return body;
  }
}
