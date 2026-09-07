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
// PI-05 generalization (beta.1+): the search family's shared hint/next
// arbitration — see that module's header for the normative precedence
// table findScopedNext/symbolsNext now defer to (thin adapters over
// absentTermsOf/sanctionSearchContinuation).
import { absentTermsOf, NO_ABSENT_TERMS, sanctionSearchContinuation } from "../features/search/nextActionPolicy.js";
// W-T-D (DESIGN-v0.15-sf-turn-economy.md §4, default OFF): the search-dedup
// wave's session-state and flag hooks. `state/session.ts` imports only
// `util/laneKey.js`/`util/flags.js` (see its own header), so importing it
// here from `protocol/*` introduces no cycle.
import { searchDedupEnabled } from "../util/flags.js";
import { beginSearchDedupServeCall, recordSearchDedupEntry, searchDedupLookup } from "../state/session.js";
// F3 (2026-09-02 review fix): sha256 of a fresh body's canonical JSON, used
// as `applySearchDedup`'s content-identity check (see its module header).
import { createHash } from "crypto";

type Body = Record<string, unknown>;

/**
 * FX-R1 (2026-09-03, round-18B review finding 10, additive): the CANONICAL
 * `search_files action` values — the six the server actually dispatches
 * (`server.ts`'s `case "search_files"` `if (action === …)` chain plus the
 * `DIAG_SEARCH_FILES_ACTIONS` diagnostics allowlist, kept in sync by hand
 * since neither can import the other without a cycle). This is deliberately
 * NOT the advertised JSON-Schema `action.enum` (`["find","references","diff",
 * "tree"]`, pinned by `exploreOffice.spec.ts`'s own "compat redirect only"
 * assertion) — widening THAT enum is a schema-shape change with its own
 * blast radius (wireBaselines/schemaSize/discoveryBundle pins) and is out of
 * scope for this additive fix. This constant exists so the unknown-`action`
 * refusal can name what IS accepted (`field:"action"`, `keys`) without
 * hand-typing the list a second time at the refusal site, and without
 * touching the advertised schema at all.
 *
 * Separately, seven UNDOCUMENTED aliases normalize onto these six before
 * dispatch ever sees them (`server.ts`'s `canonical === "search_files"`
 * argument-normalization block): `grep`/`search` -> `find`, `list` -> `tree`,
 * `def`/`definitions` -> `symbols`, `usages`/`callers` -> `references`.
 * Aliases stay accepted (this is additive, not a narrowing) but are
 * deliberately absent from `keys` — an alias is a compatibility spelling,
 * not a canonical value, so advertising it here would tell a caller to type
 * `action:"grep"` when the schema's own `enum` still refuses it verbatim.
 */
export const SEARCH_FILES_CANONICAL_ACTIONS = ["find", "symbols", "references", "diff", "locate", "tree"] as const;

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
  "hint", "note", "inventory", "absence",
  // PI-04 (F-A1-2/F-A1-3 register, alpha.2): additive optional, one entry per
  // ORIGINAL query term — see findText.ts's FindTermResult. Advisory
  // evidence, not control (never required-set): a `search.matches.find`
  // body without it means "no per-term detail was owed this call", exactly
  // like `absence`'s own optional-omission contract.
  "term_results",
  "member_sweep", "related_lookups",
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

// `absentTermsOf` (PI-05 absence facts, read from `term_results`) now lives
// in the shared NextActionPolicy arbiter — see
// features/search/nextActionPolicy.ts's module header for the full
// precedence table this module and the tree shed ladder both consume.

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
 * `queries[]` is echoed from the REQUEST rather than from the body — the
 * body's `query` renders a multi-token call as `"a OR b"`, and sending that
 * back as a single `query` would run a different search — but PI-05
 * (F-A1-3) narrows that echo to terms this SAME response has not already
 * proven absent (see `absentTermsOf`): re-issuing a proven-absent term would
 * discard the evidence this exact response just established.
 */
function findNext(body: Body, args: Body): ToolCall | undefined {
  const files = (Array.isArray(body["files"]) ? body["files"] : []).filter(isRecord);
  const served = new Set(
    files
      .map((file) => str(file["path"]))
      .filter((path): path is string => path !== undefined),
  );
  const inventory = Array.isArray(body["inventory"]) ? body["inventory"] : [];

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

  // Inventory can be exhaustive while every matched file is represented by only
  // its first eight snippets. Narrow to one such file so the continuation can
  // progress within the SAME search family.
  const partialScope = scope === undefined
    ? files.find((file) => (num(file["more_lines"]) ?? 0) > 0)
    : undefined;
  if (partialScope !== undefined) scope = str(partialScope["path"]);
  if (scope === undefined) return undefined;

  // DESIGN-v0.15 §6.1 (R3): this branch used to fall through, once ALREADY
  // narrowed to exactly this one file (`args["path"] === scope`, i.e. this is
  // not the first pass — a prior call already scoped `find` to this file and
  // it is STILL truncated), into a `read_file mode:"full"` escalation —
  // "検索の続きが全文へ膨張" (the search's continuation expanding into a full
  // read), the exact defect the design names by name. That escalation is
  // DELETED, not merely narrowed: re-scoping `find` to one file whose own
  // per-file preview is STILL truncated cannot make progress either
  // (`MAX_LINES_PER_FILE`/byte caps apply regardless of scope — a second scoped
  // find shows the SAME first lines again), so what is actually needed is a
  // MATCH-RECORD cursor that can page PAST those caps, never a whole-file read.
  // That cursor is `state/searchRequestStore.ts` /
  // `protocol/searchRequestContinuation.ts`'s job: `server.ts`'s find dispatch
  // stages a full, uncapped snapshot whenever a response comes back
  // `truncated:true`, and the emit tail (`applySearchRequestContinuation`)
  // installs the authoritative `search_files find {cursor}` continuation —
  // OVERRIDING whatever this function returns for that call. Declining here
  // (no re-scoped re-search that would just reproduce the same truncated
  // preview, no escalation out of the search family) is therefore always
  // safe: either a search request is staged and this return value is
  // replaced, or none was and the honest answer is "no nameable next" —
  // `foldLimit`'s own clause 4 degrades that to `capped`, never a wrong next.
  if (partialScope !== undefined && str(args["path"]) === scope) {
    return undefined;
  }

  return findScopedNext(scope, body, args);
}

/**
 * The `{action:"find", path, ...}` continuation for ONE resolved scope path —
 * factored out of `findNext` above so it can be shared with the byte-shedder's
 * rung-6 `find` steps (`budget/shedders/searchMatches.ts`'s
 * `cutInLastFile`/`shedFindFile`, whose `scope` is the file entry the step
 * just cut, not one `findNext` derives from `inventory`). ONE function means a
 * shed continuation and the emitter's own continuation are the SAME call for
 * the same `(scope, body, args)`, rather than two hand-rolled echoes that can
 * drift — which is how the shedder's prior inline copy of this tail kept
 * re-running a proven-absent term "as if unknown" under byte pressure even
 * after PI-05 fixed that on the emitter side alone (PI-08 register).
 *
 * `queries[]` is echoed from `args`, never from `body.query` — the body's
 * `query` renders a multi-token call as `"a OR b"`, and sending that back as a
 * single `query` would run a different search (class TC-2, §2.1.2) — narrowed,
 * as `findNext`'s own doc comment explains, to terms this SAME body has not
 * already proven absent.
 */
export function findScopedNext(scope: string, body: Body, args: Body): ToolCall | undefined {
  const queries = args["queries"];
  const call: Body = { action: "find", path: scope };
  if (Array.isArray(queries) && queries.length > 0) {
    call["queries"] = queries;
  } else {
    const query = str(args["query"]) ?? str(body["query"]);
    if (query === undefined) return undefined;
    call["query"] = query;
  }
  for (const key of [
    "regex", "limit", "maxBytes", "maxTokens", "lang", "lane", "taskProfile",
    "taskEpoch", "credentialRef",
  ] as const) {
    if (args[key] !== undefined) call[key] = args[key];
  }
  const cwd = str(args["cwd"]);
  if (cwd !== undefined) call["cwd"] = cwd;
  // PI-05 rule 1 (nextActionPolicy.ts): never echo a term this SAME response
  // already proved absent back into the continuation "as if unknown" —
  // narrows `queries` to the still-open terms, or withholds the
  // continuation entirely when nothing survives narrowing. A no-op for the
  // plain `query` (single-string) branch above, which never sets `queries`.
  const sanctioned = sanctionSearchContinuation(call, { absentTerms: absentTermsOf(body) });
  if (sanctioned === undefined) return undefined;
  return emittableToolCall({ tool: "search_files", arguments: sanctioned });
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
  // `symbols` has no absence concept and never carries `queries[]`, so this
  // is a genuine pass-through — see sanctionSearchContinuation's doc for why
  // that still makes this a thin adapter rather than a special case.
  const sanctioned = sanctionSearchContinuation(call, { absentTerms: NO_ABSENT_TERMS });
  if (sanctioned === undefined) return undefined;
  return emittableToolCall({ tool: "search_files", arguments: sanctioned });
}

function projectSymbols(body: Body, args: Body): Body {
  const matches: Body = { form: "symbols" };
  matches["locations"] = Array.isArray(body["locations"]) ? body["locations"] : [];
  matches["total"] = num(body["total"]) ?? 0;
  // PI-06 beta.2 (DESIGN-v0.10-expansion-plan-reconciliation.md §5 D-5):
  // `symbol_coverage` is additive-optional, kept via E-1's normal presence
  // gate like `note` beside it — searchSymbols.ts only sets it on the body
  // at all when at least one served location is a fallback candidate, so
  // its absence here already means "fully parser-proven" without a
  // separate check.
  keep(matches, body, ["note", "symbol_coverage"]);

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
  const untrackedOmitted = num(body["untrackedOmitted"]) ?? num(body["untracked_omitted"]);
  if (untrackedOmitted !== undefined && untrackedOmitted > 0) {
    matches["untracked_omitted"] = untrackedOmitted;
  }

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
 * DISCLOSED DEVIATIONS on `search.references` (Revision-5 row): `cursor_note`,
 * `omitted`.
 *
 *  - `cursor_note` — A.5.9 lists it among the fields "deleted into `limit` per
 *    Rule T", but it is not a truncation dialect — it is the INVALID-CURSOR
 *    disclosure (`findReferences.ts:363`), emitted when a caller's
 *    continuation token did not decode and the page was therefore served FROM
 *    THE START. It can appear on a response that withheld nothing, where
 *    there is no `limit` to carry it, and deleting it there converts a caller
 *    error into a silent wrong answer: page 1 returned as if it were page N.
 *    Kept until A.5.9 names a carrier.
 *  - `omitted` (F-W2D-1) — the SAME per-layer walk-skip counts `find` already
 *    discloses under this exact name (see `KEPT_ON_FIND`'s doc comment for
 *    the full A.5.8/`Limit.omitted` disambiguation, which applies here
 *    unchanged: this is a count map of paths that were never candidates, not
 *    a delivery limit, so it is namespaced apart from `limit.omitted`'s
 *    three-value enum array). `references` walks the SAME `walkCodeFiles`
 *    primitive `find` does and can skip files for the same reasons (oversize
 *    above all — see `TEXT_SCAN_MAX_FILE_SIZE_BYTES`, walkRepo.ts) but had no
 *    slot on the wire for it before F-W2D-1 — the internal `FindReferencesResult.omitted`
 *    field existed but every byte of it was silently stripped here, so a
 *    real MCP client never saw the disclosure `findReferences.ts` computed.
 */
const KEPT_ON_REFERENCES = ["cursor_note", "omitted"] as const;

const REFERENCES_FIELDS = [
  "symbol", "references", "files", "total",
  "absence", "member_sweep", "hint",
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
  // PI-08 (F-A1 register, alpha.2): additive optional, present iff the walk
  // actually ran (see `CompactTree.scope_report`'s doc comment) — a compact
  // {completeness, counts, excluded_by_reason} accounting of what the walk
  // saw, same disclosed-not-required treatment `term_results` gets on
  // `search.matches.find`. A body without it means "no scope accounting was
  // owed this call" (the refused / not-found / not-a-directory arms), never
  // "the walk was exhaustive".
  keep(projected, body, ["note", "scope_report"]);

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

// ---------------------------------------------------------------------------
// TL_SEARCH_DEDUP (DESIGN-v0.15-sf-turn-economy.md §4, W-T-D wave, default
// OFF) — the same-request wire dedup this module's `applySearchDedup` adds
// AFTER `projectSearchBody` has already run, additively, on its output.
//
// SCOPE. This is a WIRE optimisation, not a scan-avoidance one: the server
// still runs the full search every time (dispatch already happened by the
// time this module ever sees a body — `protocol/envelope.ts`'s
// `projectSuccessBody` calls `projectSearchBody` after `server.ts`'s
// dispatcher has produced its result). What repeats is the BYTES the wire
// carries for an identical request the caller already holds the answer to.
//
// NO ELISION (2026-09-02 review fix, F3 — REVISES the wave's original
// design). The first cut of this module elided the one bulky per-match field
// each form carries (`find`'s `files[]`, `symbols`'s `locations[]`,
// `references`'s `references[]`/`files[]`, `tree`'s rendered `tree` text)
// while leaving `find`'s `inventory_complete`/`tree`'s `scope_report.
// completeness` untouched — but "untouched" next to an EMPTIED array is
// itself the false-absence claim `AGENTS.md`'s receipt-honesty rule forbids
// (`inventory_complete:true` beside `files:[]` reads as "confirmed zero"),
// and this module does not own the field whose value set would need a new,
// honest "this is an elided view" member to fix that (`inventory_complete`'s
// `true | "by-directory"` union lives in features/search/find/findText.ts,
// outside this wave's file scope). So: NOTHING is elided any more. A repeat
// gets the SAME full body a first call would, plus an additive `receipt`
// telling the caller it already holds this exact result — the byte saving
// this wave originally chased is secondary to that honesty guarantee.
//
// CONTENT IDENTITY, NOT JUST NO-WRITE-SINCE (F3). A recorded entry's
// `writeEventSerial` only proves no write went through THIS server's own
// edit path since it was recorded — it cannot see an external (non-TL) edit
// to the same files. So a `receipt` is now attached ONLY when the freshly
// recomputed body's digest (`searchDedupDigest`, sha256 over the same
// canonical JSON the fingerprint uses) matches the digest recorded with the
// prior entry. Any mismatch — TL-originated or external — means the answer
// actually changed, so the fresh body is passed through with NO receipt, and
// the ledger entry is replaced with the new baseline.
//
// SCOPE OF FORMS. `find`, `symbols`, `search.references` and `search.tree`
// are covered (the four shapes DESIGN-v0.14 §4's forensics measured — e.g.
// `search.references` for the same symbol repeated up to 5x/cell). `locate`
// (a `{hit, ...}` discriminated union) and `diff` (already `A.5.8`'s minimal
// transcription) are left OUT of dedup eligibility entirely — with no
// elision at all, attaching a `receipt` to either would add bytes for zero
// saving, for two forms this wave's evidence never named.
// ---------------------------------------------------------------------------

/**
 * Arguments a request's IDENTITY must never turn on for this purpose —
 * exactly the fields that select WHICH SESSION/TASK/REPLAY the call runs in,
 * never which bytes come back. Mirrors `state/session.ts`'s own
 * `SIGNATURE_IGNORED_ARGS` cwd/lane/task rationale, narrowed to what THIS
 * fingerprint needs excluded (unlike the discovery-loop-brake signature,
 * every byte-selecting argument — `query`/`queries`/`path`/`regex`/... —
 * stays IN this fingerprint; nothing here is "already carried by the tuple"
 * the way it is there).
 *
 * F6 (2026-09-02 review fix): the canonical `task` object (`task.epoch`,
 * `task.handle`, `task.profile`, `task.challenge`, `task.force_serve`,
 * `task.expected_state_version`, `task.pull` — see server.ts's
 * `CANONICAL_TASK`) is excluded WHOLE, not by trying to enumerate its
 * fields under their old flat spellings: two calls differing only in, say,
 * `task.handle` (resuming vs. starting a pack) are still the identical
 * `search_files` request. `qref` joins `cwd`/`lane` as a replay-identity
 * carrier, same reasoning. The legacy (`TL_LEGACY_INPUT=accept`) flat
 * spellings are ALSO excluded, since `ProtocolCallContext.args` is the
 * inbound call as received — a legacy caller's args reach this fingerprint
 * before any canonical normalization; a canonical caller never sets any of
 * these, so excluding them is a no-op for it.
 */
const SEARCH_DEDUP_FINGERPRINT_EXCLUDED_ARGS: ReadonlySet<string> = new Set([
  "cwd", "lane", "qref", "task",
  // Legacy flat spellings of the same carriers (TL_LEGACY_INPUT=accept only).
  "taskEpoch", "task_handle", "taskProfile", "challenge", "force_serve",
  "expected_state_version", "operation_id",
]);

/** Key-sorted at every object level; array ORDER is preserved (see below). */
function canonicalDedupJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalDedupJson).join(",")}]`;
  const record = value as Body;
  return `{${Object.keys(record).sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalDedupJson(record[key])}`)
    .join(",")}}`;
}

/**
 * The canonical fingerprint of one `search_files` request: the resolved
 * `action` plus every argument that can select different bytes, with
 * `SEARCH_DEDUP_FINGERPRINT_EXCLUDED_ARGS` removed first.
 *
 * ORDER-SENSITIVE AND CASE-SENSITIVE ON PURPOSE — the one place
 * DESIGN-v0.15-sf-turn-economy.md §4.2 left open ("正規化・ソート済み" is
 * the design NOTE, not a mandate; the more conservative reading is taken
 * here). `queries:["a","b"]` and `queries:["b","a"]` fingerprint as
 * DIFFERENT requests: an OR-search is very likely order-independent in its
 * result MEMBERSHIP, but this module has no proof it is order-independent in
 * every current and future rendering of that result (a ranked
 * `did_you_mean` tie-break, an ordering-sensitive future feature), and
 * asserting "these are the same call" is a stronger, unverifiable claim this
 * wave declines to make. The cost is a small number of missed dedups for a
 * caller that re-orders its own `queries[]` between calls; the benefit is
 * that every dedup this module DOES fire is provably a byte-for-byte
 * identical request, never an inferred equivalence. Two requests differing
 * only in JS object KEY order (not array order) still fingerprint identically
 * — key order is never semantic in this protocol.
 */
export function searchDedupFingerprint(action: string, args: Body): string {
  const filtered: Body = {};
  for (const key of Object.keys(args)) {
    if (SEARCH_DEDUP_FINGERPRINT_EXCLUDED_ARGS.has(key)) continue;
    filtered[key] = args[key];
  }
  return canonicalDedupJson({ action, args: filtered });
}

/** Forms whose wire body carries a per-match array/string worth eliding. */
function searchDedupEligible(kind: Kind, action: string): boolean {
  if (kind === "search.references" || kind === "search.tree") return true;
  return kind === "search.matches" && (action === "find" || action === "symbols");
}

/** The result's own count field — never modified, only read for the receipt. */
function searchDedupFilesCount(kind: Kind, action: string, body: Body): number {
  if (kind === "search.references") return num(body["total"]) ?? 0;
  if (kind === "search.tree") return 0;
  const matches = isRecord(body["matches"]) ? body["matches"] : undefined;
  if (matches === undefined) return 0;
  if (action === "find") return num(matches["total_files"]) ?? 0;
  if (action === "symbols") return num(matches["total"]) ?? 0;
  return 0;
}

/**
 * Recursively removes any `handle` property. Every form this module covers
 * mints a FRESH, randomized per-match handle on every serving call
 * (`util/handles.ts`'s `HandleTable`/`state/handleCodec.ts`'s `mintHandle`
 * embed replay-distinguishing randomness by design — see their own doc
 * comments), so two calls over byte-identical content NEVER carry the same
 * handle string. A digest that included it would treat every repeat as
 * content drift and never dedup at all.
 */
function omitHandles(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(omitHandles);
  if (value !== null && typeof value === "object") {
    const record = value as Body;
    const out: Body = {};
    for (const key of Object.keys(record)) {
      if (key === "handle") continue;
      out[key] = omitHandles(record[key]);
    }
    return out;
  }
  return value;
}

/**
 * F3: the digest BASIS for one search form — a deliberate WHITELIST of
 * exactly the fields the task's own instruction names (files/locations/tree
 * text, every count, `term_results`, `absence`), never the raw body.
 * Hashing the raw body would also fold in advisory fields that legitimately
 * differ call-to-call with no change to the SEARCH RESULT itself — e.g. the
 * one-shot "batch related tokens" `hint` that fires on a 2nd single-token
 * find, or `related_lookups`' embedded `cwd` — which would make every
 * repeat register as drift and defeat dedup entirely. `omitHandles` then
 * strips the one remaining always-different field (see its own doc
 * comment).
 */
function searchDedupDigestBasis(kind: Kind, action: string, body: Body): unknown {
  if (kind === "search.matches" && action === "find") {
    const matches = isRecord(body["matches"]) ? body["matches"] : {};
    return omitHandles({
      files: matches["files"],
      total_files: matches["total_files"],
      total_matches: matches["total_matches"],
      term_results: matches["term_results"],
      absence: matches["absence"],
      inventory: matches["inventory"],
      inventory_complete: matches["inventory_complete"],
    });
  }
  if (kind === "search.matches" && action === "symbols") {
    const matches = isRecord(body["matches"]) ? body["matches"] : {};
    return omitHandles({ locations: matches["locations"], total: matches["total"] });
  }
  if (kind === "search.references") {
    return omitHandles({ references: body["references"], files: body["files"], total: body["total"] });
  }
  if (kind === "search.tree") {
    return omitHandles({ tree: body["tree"], scope_report: body["scope_report"] });
  }
  return omitHandles(body);
}

/**
 * sha256 over the SAME canonical JSON `searchDedupFingerprint` uses, taken
 * of `searchDedupDigestBasis`. Two fresh scans over the same fingerprint
 * that produce the identical digest are provably the same result by
 * CONTENT, not merely by an in-process write counter that cannot see an
 * external (non-TL) edit.
 */
function searchDedupDigest(kind: Kind, action: string, body: Body): string {
  return createHash("sha256").update(canonicalDedupJson(searchDedupDigestBasis(kind, action, body))).digest("hex");
}

/**
 * F6: true iff this call carries `task.force_serve:true` (canonical) or the
 * legacy flat `force_serve:true`. "Bodies come back, dedup bypassed; it
 * never returns less" (AGENTS.md) — the search-side mirror of the read
 * family's `force_serve` contract: skip the lookup entirely rather than risk
 * attaching even an additive `receipt` to a call whose whole point is a
 * guaranteed-full re-serve.
 */
function isSearchDedupForceServe(args: Body): boolean {
  const task = isRecord(args["task"]) ? args["task"] : undefined;
  if (task !== undefined && task["force_serve"] === true) return true;
  return args["force_serve"] === true;
}

/**
 * The TL_SEARCH_DEDUP entry point — called from `protocol/envelope.ts` on the
 * OUTPUT of `projectSearchBody`, for one already-resolved workspace root.
 *
 * With the flag off, for a form outside `searchDedupEligible`, or when the
 * call carries `force_serve` (F6), this is the identity function and touches
 * no session state at all — flag-off byte identity holds by construction
 * (`searchDedupLookup`/`recordSearchDedupEntry` are simply never called),
 * not by a check inside them.
 *
 * On the FIRST occurrence of a fingerprint this task, OR whenever the fresh
 * digest no longer matches the previously recorded one (F3 — a write of any
 * kind, TL-originated or external), this records the new baseline and
 * returns `body` completely UNTOUCHED — the caller gets the real, full
 * result. Only when the fresh digest matches a live prior entry does this
 * attach an additive `receipt`; the body itself is NEVER elided (see the
 * module header's "NO ELISION" note) — every field, including a genuine
 * `limit` from real truncation, is passed through unchanged either way.
 */
export function applySearchDedup(
  kind: Kind,
  body: Body,
  action: string,
  args: Body,
  workspaceRoot: string,
): Body {
  if (!searchDedupEnabled()) return body;
  if (!searchDedupEligible(kind, action)) return body;
  if (isSearchDedupForceServe(args)) return body;

  const fingerprint = searchDedupFingerprint(action, args);
  const digest = searchDedupDigest(kind, action, body);
  const files = searchDedupFilesCount(kind, action, body);
  const prior = searchDedupLookup(workspaceRoot, fingerprint);

  if (prior !== undefined && prior.digest === digest) {
    return { ...body, receipt: { tag: "query-unchanged", served_by: prior.servedBy, files } };
  }

  // Either a genuine first occurrence, or the prior entry's content no
  // longer matches the fresh scan (F3) — record this call as the new
  // baseline and pass the fresh body through untouched.
  const ordinal = beginSearchDedupServeCall(workspaceRoot);
  recordSearchDedupEntry(workspaceRoot, fingerprint, {
    kind,
    action,
    servedBy: `search ${action} (call #${ordinal})`,
    files,
    digest,
  });
  return body;
}
