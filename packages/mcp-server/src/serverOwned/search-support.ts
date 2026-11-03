// search-support — extracted implementation; imports point to the owning modules.
import type { FindFileGroup } from "../features/search/find/findText.js";
import type { McpLang } from "@tokenlighten/types";
import type { SearchScanQuery } from "../state/searchRequestStore.js";
import type { ServedFindOutcome } from "../features/search/find/servedFindEscalation.js";
import { MAX_LINES_PER_FILE } from "../features/search/find/findText.js";
import { applyServedFindProtocol } from "../features/search/find/servedFindEscalation.js";
import { canonicalToolCall } from "../protocol/envelope.js";
import { chooseSearchPage } from "../state/searchRequestStore.js";
import { currentSessionLane } from "../util/laneKey.js";
import { estimateBytesFromTokens } from "../protocol/budget/wireBudget.js";
import { fixSearchPage } from "../protocol/searchRequestContinuation.js";
import { getEditedPaths } from "../state/session.js";
import { getExecutionFence } from "../state/session.js";
import { isDeadTaskHandleOutcome } from "../state/stateHandles.js";
import { laneTaskHandleMidSpliceMatch } from "../state/laneTaskHandles.js";
import { laneTaskHandleNearMiss } from "../state/laneTaskHandles.js";
import { laneTaskHandleTailExtensionMatch } from "../state/laneTaskHandles.js";
import { laneTaskHandles } from "../state/laneTaskHandles.js";
import { openSearchRequest } from "../state/searchRequestStore.js";
import { openSymbolSearchRequest } from "../state/searchRequestStore.js";
import { parseMcpLang } from "./read-admission2.js";
import { persistSymbolSearchRequest } from "../state/searchRequestStore.js";
import { protocolCallContext } from "../protocol/envelope.js";
import { readFileSafe } from "../util/safePath.js";
import { renderPageFiles } from "../state/searchRequestStore.js";
import { resolveSearchCursor } from "../state/searchRequestStore.js";
import { resolveSymbolSearchCursor } from "../state/searchRequestStore.js";
import { resolveTaskHandle } from "../state/stateHandles.js";
import { resolveTaskQueryRefHandle } from "../state/session.js";
import { scanFullSearchSnapshot } from "../state/searchRequestStore.js";
import { searchCursorInputMismatch } from "../state/searchRequestStore.js";
import { searchPageEnvelopeReserve } from "../state/searchRequestStore.js";
import { searchSymbols } from "../tools/searchSymbols.js";
import { sessionLaneOf } from "./task-binding2.js";
import { shaOfText } from "../util/handles.js";
import { sourceFingerprintForSymbolResult } from "../tools/searchSymbols.js";
import { stagedFromResolution as stagedSearchRequestFromResolution } from "../state/searchRequestStore.js";
import { symbolSearchInputMismatch } from "../state/searchRequestStore.js";
import { taskHandleRecoveryEnabled } from "../util/flags.js";
import { toolOk } from "../protocol/result.js";
import { toolStructuredError } from "../protocol/result.js";
import { trace } from "../util/trace.js";
import { withMoreLines } from "../state/searchRequestStore.js";

/**
 * Elision-marker disambiguation (2026-07-25 T03 forensics): a solver read the
 * inline "doc elided L..-.." markers as TRUNCATION and re-fetched the same
 * range twice chasing "missing" content. Say explicitly that markers replace
 * comments only.
 *
 * TL-REVIEW-2 (2026-10-06): the markers no longer reach the wire — the
 * source-fidelity projection (protocol/sourceFidelity.ts) ships the code lines
 * as faithful ranges and lists each collapsed block in evidence `elided` — so
 * the sentence now names where the blocks went instead of a marker the caller
 * never sees. Counted on this producer's own display text, as before.
 */
export function elisionMarkerNote(content: string): string | undefined {
  const count = (content.match(/(?:\/\*|#)\s*doc elided L\d+/g) ?? []).length;
  if (count === 0) return undefined;
  return `${count} multi-line comment block(s) elided (listed in evidence \`elided\`) — code lines are complete, nothing is truncated; pass select.comments:"keep" to read them`;
}

/**
 * Served-hit annotation (2026-07-25 T03 forensics): a solver ran four
 * searches for tokens inside a file whose FULL text it had been served two
 * calls earlier. Mark hits in already-served files so the next probe is a
 * context check, not a re-read.
 *
 * L2 (2026-08-08 find-honesty): the annotation alone was measured to be
 * ignored 6/6 in one cell, so the whole decision — annotate, note, or escalate
 * a REPEATED all-served find into the terminal-style protocol — now lives in
 * features/search/find/servedFindEscalation.ts. See that module's doc for the
 * state machine and for why this is not a second discovery brake. This wrapper
 * keeps the historical call shape at the two find dispatch sites.
 */
export function annotateServedFindHits(
  response: object,
  workspace: string,
  args: Record<string, unknown>,
): ServedFindOutcome {
  // PI-09 close-out: `force_serve` is honoured INSIDE applyServedFindProtocol,
  // not here — that module owns the whole annotate/note/escalate decision, and
  // a bypass in this wrapper would be one case of it made where the module's
  // own tests cannot see it.
  return applyServedFindProtocol(
    response,
    workspace,
    args,
    getExecutionFence(workspace)?.certificateId,
  );
}

// ---------------------------------------------------------------------------
// DESIGN-v0.15 §6.1 (R3) — the search-request cursor.
//
// A SEPARATE, clearly-delimited section: not R2's read-request helpers
// (`stageReadRequestForServe` etc., defined near `normalizeCanonicalRequest`)
// and not the mode=pack/readCodePack region elsewhere in this dispatcher —
// this wave's file-ownership rule. Two entry points, both used only from the
// `tl_search_files` `action:"find"` arm below:
//
//   `stageSearchRequestForFind` — called once an ORDINARY (non-cursor) find
//   response comes back `truncated:true`. Computes the full, uncapped match
//   snapshot and REBUILDS this call's own `files[]`/`total_files`/
//   `total_matches` from the snapshot's stable order — never the ordinary
//   footholds-first rendering `buildFindResponse`/`buildFindResponseForQueries`
//   produced, because that rendering can deliver a SCATTERED (non-prefix)
//   subset of the snapshot and `SearchRequestState.delivered` is a plain
//   prefix counter (see `state/searchRequestStore.ts`'s header for why).
//
//   `serveSearchCursorPage` — called instead of the ordinary producers when a
//   `find` call carries `cursor`. Resolves+validates the token, re-verifies
//   every referenced file's source revision and the walk's own candidate-file
//   identity (`cursor-stale` on any drift, never a silent restart), and pages
//   directly from the snapshot — never re-entering `buildFindResponse`/
//   `buildFindResponseForQueries` and never escalating to `tl_read_file`.
// ---------------------------------------------------------------------------

/** Same one-line heuristic `findText.ts`'s (module-private) `isSingleToken` uses — kept local rather than exported across modules for one boolean. */
export function isSingleSearchToken(query: string): boolean {
  return query.trim().split(/\s+/).filter(Boolean).length <= 1;
}

/** Per-query case-insensitivity resolution — MUST match `buildFindResponseForQueries`'s own default exactly, so a staged snapshot's matches agree with what the ordinary pipeline would have found. */
export function searchScanQueriesFor(queries: readonly string[], regex: boolean): SearchScanQuery[] {
  return queries.map((text) => ({ text, regex, caseInsensitive: !regex && isSingleSearchToken(text) }));
}

/** The canonical `original_input` a staged search request restarts from and validates a resume's own `queries`/`scope` against. */
export function canonicalSearchOriginalInput(input: {
  queries: readonly string[];
  path?: string;
  lang?: string;
  regex: boolean;
}): Record<string, unknown> {
  const original: Record<string, unknown> = { queries: [...input.queries] };
  const scope: Record<string, unknown> = {};
  if (input.path !== undefined) scope["path"] = input.path;
  if (input.lang !== undefined) scope["lang"] = input.lang;
  if (input.regex) scope["regex"] = true;
  if (Object.keys(scope).length > 0) original["scope"] = scope;
  return original;
}

/**
 * Matches `protocol/budget/wireBudget.ts`'s calibrated `search.matches`
 * ceiling (arch-map §5) — used only as the byte target for CHOOSING page
 * content; the generic wire ladder still governs what actually ships (see
 * `searchRequestStore.ts`'s reserve doc comment for why an imprecise choice
 * here is never a correctness risk).
 */
export const DEFAULT_SEARCH_FIND_PAGE_BUDGET_BYTES = 131072;

export function isRecordLike(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function findStr(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

export function findNum(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * True iff every entry of the producer's own `inventory` already appears in
 * `files[]` — an ordinary `findScopedNext` re-scope to the next UNSERVED
 * inventory file has nothing new to move to. Mirrors
 * `protocol/searchFamily.ts`'s (former) `findNext` inventory loop. An
 * unserved per-directory rollup entry (`dir`, no `path`) also counts as
 * "something left to visit", matching that loop.
 */
export function findInventoryExhausted(body: Record<string, unknown>): boolean {
  const files = (Array.isArray(body["files"]) ? body["files"] : []).filter(isRecordLike);
  const served = new Set(files.map((f) => findStr(f["path"])).filter((p): p is string => p !== undefined));
  const inventory = Array.isArray(body["inventory"]) ? body["inventory"] : [];
  for (const raw of inventory) {
    if (!isRecordLike(raw)) continue;
    const path = findStr(raw["path"]);
    if (path !== undefined) {
      if (!served.has(path)) return false;
      continue;
    }
    if (findStr(raw["dir"]) !== undefined) return false;
  }
  return true;
}

/**
 * True iff some ALREADY-SERVED file's preview is capped by the HARD,
 * budget-independent `MAX_LINES_PER_FILE` ceiling (`findText.ts`'s
 * `capFileGroup`, applied "before any response-wide byte fitting") rather
 * than merely by this response's own byte budget.
 *
 * THIS is the precise distinguishing signal between the two shapes
 * `truncated:true` + `inventory` exhausted can describe:
 *
 *  - "fic" (many small files sharing one budget): every file's OWN true
 *    count is well under `MAX_LINES_PER_FILE`, so a file left short here got
 *    that way from `fitFilesToCap`'s byte-budget widen pass running out of
 *    room — `findScopedNext` re-scoping to JUST that file genuinely helps
 *    (it stops sharing the budget with 39 siblings and can show the rest).
 *    None of its files ever reach this predicate.
 *  - LITERAL_31/SINGLE_31 (few files, each individually huge): a file whose
 *    OWN true count exceeds `MAX_LINES_PER_FILE` shows EXACTLY
 *    `MAX_LINES_PER_FILE` lines NO MATTER HOW IT IS SCOPED — a fresh
 *    single-file `findScopedNext` re-run reproduces the identical truncated
 *    preview. That is the exact precondition the old `tl_read_file` escalation
 *    fired on, and it is knowable on the VERY FIRST response — unlike a
 *    "did this call already narrow to exactly this file" check, which would
 *    only fire a hop late and, by then, have lost the ORIGINAL multi-file
 *    scope to the intermediate re-scope's own narrower `path`.
 */
export function findHasHardCappedFile(files: readonly Record<string, unknown>[]): boolean {
  return files.some((f) => {
    const lines = Array.isArray(f["lines"]) ? f["lines"] : undefined;
    const moreLines = findNum(f["more_lines"]) ?? 0;
    return lines !== undefined && lines.length >= MAX_LINES_PER_FILE && moreLines > 0;
  });
}

/** Mirrors `protocol/searchFamily.ts`'s (former) `findNext` escalation precondition exactly — see `findHasHardCappedFile`'s doc comment for why this is knowable on the first response. */
export function findWouldHaveEscalated(body: Record<string, unknown>): boolean {
  if (!findInventoryExhausted(body)) return false;
  const files = (Array.isArray(body["files"]) ? body["files"] : []).filter(isRecordLike);
  return findHasHardCappedFile(files);
}

/**
 * DESIGN-v0.15 §5.3 / finding 9: what `stageSearchRequestForFind` returns.
 *
 * `"body"` is the ordinary case — either the untouched producer body (nothing
 * needed staging) or the freshly-paginated snapshot page. `"refusal"` is the
 * budget-floor case `chooseSearchPage`'s own `budget-below-minimum` names:
 * mirrors the read cursor's `budget-below-minimum` refusal exactly (design
 * §5.3: "必要下限を示す既存refusal/retry契約で回復する") instead of falling back
 * to the producer's own oversized body, which the generic wire ladder could
 * then only answer with a `cap-exceeded` dead end (finding 9's repro).
 */
export type StageSearchRequestForFindResult =
  | { kind: "body"; body: Record<string, unknown> }
  | { kind: "refusal"; refusal: Record<string, unknown> };

/**
 * Stage a search request for an ALREADY-BUILT `find` body that came back
 * `truncated:true`, and rebuild that body's own `files[]`/`total_files`/
 * `total_matches`/`omitted` from the freshly-scanned, stably-ordered
 * snapshot.
 *
 * TWO INDEPENDENT TRIGGERS, EITHER ONE ENOUGH (finding 9):
 *
 *  1. `findWouldHaveEscalated` — the ORIGINAL, narrower "inventory exhausted
 *     AND some served file sits at the hard per-file cap" shape. UNCHANGED
 *     from before finding 9: a `truncated:true` many-small-files response
 *     that does NOT hit this shape (no file near `MAX_LINES_PER_FILE`) is
 *     genuinely well served by the producer's own `findScopedNext`
 *     continuation already — re-scoping to the next unserved file actually
 *     helps there, and staging it instead would change a DEFAULT-budget wire
 *     shape that was never broken (measured: `searchFamily.spec.ts`'s
 *     "clause 1" 90-file fixture and `findBatchingHint.spec.ts`'s trimmed-cap
 *     fixture both rely on exactly this continuation at the DEFAULT budget).
 *  2. `wouldOverflowDeclaredBudget` — NEW. `buildFindResponseForQueries` has
 *     no per-call byte-budget awareness of its own: a 12-file/3-match-each
 *     result (none of them near the hard per-file cap) renders EVERY match
 *     unconditionally and reports `truncated:false`, even when the caller
 *     declared a `budget.bytes` far too small to hold it (finding 9's own
 *     reproduction: 36 matches lost to a bare `cap-exceeded`, `truncated`
 *     never `true` at all, `findScopedNext`'s own continuation never in the
 *     running because the PRODUCER never even signaled truncation). Checked
 *     here — BEFORE the generic wire ladder ever runs, which can only shed
 *     peripheral fields, never whole match groups, and so can never turn an
 *     over-budget find into a paginated one — via a cheap, conservative
 *     predictor: does the UNSTAGED body's own measured size already exceed
 *     what the caller declared? A default (undeclared) budget makes this
 *     `false` by construction, so it is a strict no-op at default budgets.
 *
 * Returns `body` UNCHANGED when NEITHER trigger fires, or when the fresh scan
 * found nothing to page (should not happen when a trigger fired, but
 * defensive), or when the first page could not be chosen for a reason OTHER
 * than the budget floor (`chooseSearchPage`'s `"complete"` — D emptied
 * between the producer's own pass and this one). A budget too small to hold
 * even one match group plus its envelope is the ONE case that instead
 * returns a `"refusal"` — see `StageSearchRequestForFindResult`'s own doc.
 */
export function stageSearchRequestForFind(input: {
  workspace: string;
  queries: readonly string[];
  regex: boolean;
  path?: string;
  lang?: string;
  args: Record<string, unknown>;
  body: Record<string, unknown>;
}): StageSearchRequestForFindResult {
  const declaredMaxBytesForGate = typeof input.args["maxBytes"] === "number" && input.args["maxBytes"] > 0
    ? input.args["maxBytes"] as number
    : undefined;
  const wouldOverflowDeclaredBudget = declaredMaxBytesForGate !== undefined
    && Buffer.byteLength(JSON.stringify(input.body), "utf8") > declaredMaxBytesForGate;
  const escalationShape = input.body["truncated"] === true && findWouldHaveEscalated(input.body);
  if (!escalationShape && !wouldOverflowDeclaredBudget) return { kind: "body", body: input.body };
  const scan = scanFullSearchSnapshot({
    workspace: input.workspace,
    queries: searchScanQueriesFor(input.queries, input.regex),
    ...(input.path !== undefined ? { path: input.path } : {}),
    ...(input.lang !== undefined ? { lang: parseMcpLang(input.lang) } : {}),
  });
  if (scan.records.length === 0) return { kind: "body", body: input.body };

  const lane = currentSessionLane();
  const taskHandle = typeof input.args["task_handle"] === "string" ? input.args["task_handle"] : undefined;
  const cwd = typeof input.args["cwd"] === "string" ? input.args["cwd"] : undefined;
  const declaredMaxBytes = typeof input.args["maxBytes"] === "number" ? (input.args["maxBytes"] as number) : undefined;
  const declaredMaxTokens = typeof input.args["maxTokens"] === "number" ? (input.args["maxTokens"] as number) : undefined;
  const budgetBytes = declaredMaxBytes !== undefined && declaredMaxBytes > 0
    ? declaredMaxBytes
    : DEFAULT_SEARCH_FIND_PAGE_BUDGET_BYTES;
  const itemsBudget = typeof input.args["limit"] === "number" && (input.args["limit"] as number) > 0
    ? Math.floor(input.args["limit"] as number)
    : undefined;
  const originalBudget = {
    ...(declaredMaxBytes !== undefined ? { bytes: declaredMaxBytes } : {}),
    ...(itemsBudget !== undefined ? { items: itemsBudget } : {}),
    ...(declaredMaxTokens !== undefined ? { tokens: declaredMaxTokens } : {}),
  };
  // SPB (2026-10-10): what the page built below carries besides `files[]` and
  // the envelope — handed to the store as well, so the page is sized against
  // these exact bytes (`OpenSearchRequestInput.openPageExtras`).
  const openPageExtras: Record<string, unknown> = {
    ...(Array.isArray(input.body["matched_terms"]) ? { matched_terms: input.body["matched_terms"] } : {}),
    ...(Array.isArray(input.body["term_results"]) ? { term_results: input.body["term_results"] } : {}),
    ...(scan.omitted !== undefined ? { omitted: scan.omitted } : {}),
  };

  const staged = openSearchRequest({
    workspaceRoot: input.workspace,
    ...(lane !== "" ? { lane } : {}),
    ...(taskHandle !== undefined ? { taskHandle } : {}),
    originalInput: canonicalSearchOriginalInput(input),
    ...(Object.keys(originalBudget).length > 0 ? { budget: originalBudget } : {}),
    echo: {
      ...(cwd !== undefined ? { cwd } : {}),
      ...(lane !== "" ? { lane } : {}),
      ...(taskHandle !== undefined ? { taskHandle } : {}),
    },
    scan,
    openPageExtras,
  });

  const reserveInput = {
    queries: input.queries,
    path: input.path,
    lang: input.lang,
    cwd,
    lane: lane !== "" ? lane : undefined,
    budgetBytes: declaredMaxBytes,
  };
  const reserve = searchPageEnvelopeReserve(reserveInput);
  // SPB (2026-10-10): the page that ends the request carries no `limit`; a
  // result that fits beside that smaller envelope is one page.
  const completeReserve = searchPageEnvelopeReserve({ ...reserveInput, complete: true });
  const choice = chooseSearchPage(staged.state, scan.readLine, budgetBytes, reserve, itemsBudget, completeReserve);
  if (!choice.ok) {
    // finding 9: name the floor instead of falling back to the producer's
    // own (oversized, for this budget) body — mirrors the read cursor's
    // identical `budget-below-minimum` refusal (server.ts's cursor-resume
    // dispatch, above) so both halves of the same design rule read alike.
    if (choice.reason === "budget-below-minimum") {
      return {
        kind: "refusal",
        refusal: {
          ok: false,
          code: "budget-below-minimum",
          field: "budget",
          error: `budget ${budgetBytes} B cannot hold one whole match group plus its envelope`,
          detail: "raise budget.bytes to at least required_min_bytes and re-issue this find",
          required_min_bytes: choice.requiredMinBytes,
          retry: "call",
        },
      };
    }
    return { kind: "body", body: input.body };
  }

  const context = protocolCallContext();
  if (context !== undefined) context.searchRequest = staged;

  const truncated = choice.page.end < staged.state.matches.length || staged.state.snapshot_capped;
  const files = withMoreLines(staged.state, choice.page.files, choice.page.end);
  const newBody: Record<string, unknown> = {
    query: typeof input.body["query"] === "string" ? input.body["query"] : input.queries.join(" OR "),
    literal: input.body["literal"] === true,
    files,
    total_files: staged.state.total_files ?? 0,
    total_matches: staged.state.total_matches ?? 0,
    truncated,
    ...openPageExtras,
  };
  return { kind: "body", body: newBody };
}

/** The scoping a staged symbols request restarts from and a resume validates against. */
export function canonicalSymbolOriginalInput(args: Record<string, unknown>): Record<string, unknown> {
  const original: Record<string, unknown> = { action: "symbols" };
  if (typeof args["query"] === "string" && args["query"] !== "") original["query"] = args["query"];
  if (typeof args["path"] === "string" && args["path"] !== "") original["path"] = args["path"];
  if (typeof args["lang"] === "string" && args["lang"] !== "") original["lang"] = args["lang"];
  if (typeof args["includeScores"] === "boolean") original["includeScores"] = args["includeScores"];
  return original;
}

/** The caller's declared search budget, read from either spelling. Never widened here. */
export function symbolSearchBudget(args: Record<string, unknown>, inherited?: { bytes?: number; items?: number; tokens?: number }): { bytes?: number; items?: number; tokens?: number } | undefined {
  const declared: Record<string, unknown> | undefined = isRecordLike(args["budget"]) ? args["budget"] : undefined;
  const declaredBytes = typeof declared?.["bytes"] === "number" ? declared["bytes"] as number : undefined;
  const declaredItems = typeof declared?.["items"] === "number" ? declared["items"] as number : undefined;
  const declaredTokens = typeof declared?.["tokens"] === "number" ? declared["tokens"] as number : undefined;
  const legacyBytes = typeof args["maxBytes"] === "number" ? args["maxBytes"] as number : undefined;
  const legacyItems = typeof args["limit"] === "number" ? args["limit"] as number : undefined;
  const legacyTokens = typeof args["maxTokens"] === "number" ? args["maxTokens"] as number : undefined;
  const requestedBytes = declaredBytes !== undefined && declaredBytes > 0 ? declaredBytes
    : legacyBytes !== undefined && legacyBytes > 0 ? legacyBytes : undefined;
  const requestedItems = declaredItems !== undefined && declaredItems > 0 ? declaredItems
    : legacyItems !== undefined && legacyItems > 0 ? legacyItems : undefined;
  // A caller may explicitly choose a larger page on a later cursor hop. Each
  // explicit positive field replaces its inherited value; omitted fields keep
  // inheriting independently. The response and symbol-page hard caps still
  // clamp the effective output at their existing boundaries.
  const bytes = requestedBytes ?? inherited?.bytes;
  const items = requestedItems ?? inherited?.items;
  const requestedTokens = declaredTokens !== undefined && declaredTokens > 0 ? declaredTokens
    : legacyTokens !== undefined && legacyTokens > 0 ? legacyTokens : undefined;
  const tokens = requestedTokens ?? inherited?.tokens;
  if (bytes === undefined && items === undefined && tokens === undefined) return undefined;
  return { ...(bytes !== undefined ? { bytes } : {}), ...(items !== undefined ? { items } : {}), ...(tokens !== undefined ? { tokens } : {}) };
}

/** `tools/searchSymbols.ts`'s own hard record cap per page — a page never exceeds it. */
export const SYMBOL_PAGE_MAX_RECORDS = 50;

export function symbolPageItems(budget: { bytes?: number; items?: number } | undefined): number {
  const items = budget?.items;
  return typeof items === "number" && items > 0 ? Math.min(Math.floor(items), SYMBOL_PAGE_MAX_RECORDS) : 20;
}

/**
 * Stage each nonempty public symbols response before emission. The producer's
 * own 2048-byte cap and truncation flag cannot predict what a caller's smaller
 * wire budget will shed; the emit tail settles only the records that survive.
 */
export function stageSymbolSearchPage(args: Record<string, unknown>, result: import("../tools/searchSymbols.js").SearchSymbolsResult, workspace: string): void {
  if (result.locations.length === 0) return;
  const sourceFingerprint = sourceFingerprintForSymbolResult(result);
  if (sourceFingerprint === undefined) return;
  const context = protocolCallContext();
  if (context === undefined) return;
  const lane = currentSessionLane();
  const taskHandle = typeof args["task_handle"] === "string" ? args["task_handle"] : undefined;
  const cwd = typeof args["cwd"] === "string" ? args["cwd"] : undefined;
  const budget = symbolSearchBudget(args);
  const staged = openSymbolSearchRequest({
    workspaceRoot: workspace,
    ...(lane !== "" ? { lane } : {}),
    ...(taskHandle !== undefined ? { taskHandle } : {}),
    originalInput: canonicalSymbolOriginalInput(args),
    ...(budget !== undefined ? { budget } : {}),
    echo: {
      ...(cwd !== undefined ? { cwd } : {}),
      ...(lane !== "" ? { lane } : {}),
      ...(taskHandle !== undefined ? { taskHandle } : {}),
    },
    delivered: 0,
    totalMatches: result.total,
    sourceFingerprint,
  });
  if (persistSymbolSearchRequest(staged) === undefined) return;
  context.searchRequest = staged;
}

/**
 * Serve a `symbols` call that presented `cursor`: resolve the authenticated
 * position, re-rank the SAME request from it, and stage the resumed chain so
 * the emit tail settles from what actually ships. Never accepts a caller-side
 * offset.
 */
export async function serveSymbolCursorPage(
  token: string,
  args: Record<string, unknown>,
  workspace: string,
): Promise<ReturnType<typeof toolOk>> {
  const lane = currentSessionLane();
  const taskHandle = typeof args["task_handle"] === "string" ? args["task_handle"] : undefined;
  const cwd = typeof args["cwd"] === "string" ? args["cwd"] : undefined;
  const resolved = resolveSymbolSearchCursor(token, workspace, {
    ...(lane !== "" ? { lane } : {}),
    ...(taskHandle !== undefined ? { taskHandle } : {}),
  });
  if (!resolved.ok) {
    return toolStructuredError({
      ok: false,
      code: "cursor-invalid",
      field: "cursor",
      error: "this symbol search cursor is not usable here",
      detail: `${resolved.reason}; restart the original request`,
      retry: "call",
    });
  }
  const state = resolved.state;
  const mismatch = symbolSearchInputMismatch(state, args);
  if (mismatch !== undefined) {
    return toolStructuredError({
      ok: false,
      code: "cursor-input-mismatch",
      field: mismatch,
      error: `symbol cursor continuation cannot change '${mismatch}'`,
      detail: "this cursor call must restate the query and scope of the request it continues",
      retry: "call",
    });
  }
  const original = state.original_input;
  const start = state.delivered;
  const total = state.total_matches ?? 0;
  const budget = symbolSearchBudget(args, state.budget);
  const echo = {
    ...(cwd !== undefined ? { cwd } : {}),
    ...(lane !== "" ? { lane } : {}),
    ...(taskHandle !== undefined ? { taskHandle } : {}),
  };
  const context = protocolCallContext();
  const page = await searchSymbols({
    query: typeof original["query"] === "string" ? original["query"] : "",
    ...(typeof original["path"] === "string" && original["path"] !== "" ? { path: original["path"] as string } : {}),
    ...(typeof original["lang"] === "string" && original["lang"] !== "" ? { lang: original["lang"] as McpLang } : {}),
    ...(typeof original["includeScores"] === "boolean" ? { includeScores: original["includeScores"] } : {}),
    limit: symbolPageItems(budget),
    offset: start,
    cursorPage: true,
  }, workspace);
  const currentFingerprint = sourceFingerprintForSymbolResult(page);
  if (currentFingerprint === undefined || currentFingerprint !== state.source_fingerprint || page.total !== total || start >= page.total) {
    return toolStructuredError({
      ok: false,
      code: "cursor-stale",
      field: "cursor",
      error: "the symbol ranking this cursor continues is no longer there",
      detail: "the indexed sources changed under this request; restart the original request",
      retry: "call",
      next: {
        tool: "tl_search_files",
        arguments: {
          action: "find",
          ...(typeof original["query"] === "string" ? { queries: [original["query"]] } : {}),
          scope: {
            kind: "symbol",
            ...(typeof original["path"] === "string" ? { path: original["path"] } : {}),
            ...(typeof original["lang"] === "string" ? { lang: original["lang"] } : {}),
            ...(typeof original["includeScores"] === "boolean" ? { includeScores: original["includeScores"] } : {}),
          },
          ...(budget !== undefined ? { budget } : {}),
          ...(cwd !== undefined ? { cwd } : {}),
          ...(lane !== "" ? { lane } : {}),
          ...(taskHandle !== undefined ? { task: { handle: taskHandle } } : {}),
        },
      },
    });
  }
  if (context !== undefined && page.locations.length > 0) {
    const fingerprint = currentFingerprint;
    const resumed = openSymbolSearchRequest({
      workspaceRoot: workspace,
      ...(state.lane !== undefined ? { lane: state.lane } : {}),
      ...(state.task_handle !== undefined ? { taskHandle: state.task_handle } : {}),
      originalInput: original,
      ...(budget !== undefined ? { budget } : {}),
      echo,
      delivered: start,
      totalMatches: total,
      sourceFingerprint: fingerprint,
    });
    if (persistSymbolSearchRequest(resumed) !== undefined) context.searchRequest = resumed;
  }
  return toolOk(page);
}

/**
 * Serve a `find` call that presented `cursor` — resolve, validate, re-verify
 * freshness, and page directly from the staged snapshot. Never re-enters the
 * ordinary `buildFindResponse`/`buildFindResponseForQueries` producer and
 * never builds a `tl_read_file` call.
 */
export async function serveSearchCursorPage(
  token: string,
  args: Record<string, unknown>,
  workspace: string,
): Promise<ReturnType<typeof toolOk>> {
  const cursorLane = currentSessionLane();
  const cursorTaskHandle = typeof args["task_handle"] === "string" ? args["task_handle"] : undefined;
  const cursorCwd = typeof args["cwd"] === "string" ? args["cwd"] : undefined;

  const resolvedCursor = resolveSearchCursor(token, workspace, {
    ...(cursorLane !== "" ? { lane: cursorLane } : {}),
    ...(cursorTaskHandle !== undefined ? { taskHandle: cursorTaskHandle } : {}),
  });
  if (!resolvedCursor.ok) {
    return toolStructuredError({
      ok: false,
      code: "cursor-invalid",
      field: "cursor",
      error: "this search cursor is not usable here",
      detail: `${resolvedCursor.reason}; restart the original request`,
      retry: "call",
    });
  }
  // DESIGN-v0.15 §6.1 (R3 extension): a `tlh_sreq_v1_` record opened by
  // `tl_search_files action=references` (this wave's own addition — see
  // `state/searchRequestStore.ts`'s `openReferencesCursorRequest`) resolves
  // fine as a search-request HANDLE but is not a valid `find` cursor: its
  // `original_input` has no `queries`, so falling through to the mismatch
  // check below would misreport this as `code:"invalid-input", field:
  // "queries"` instead of the correct wrong-purpose refusal. `undefined`
  // reads as `"find"` (every record written before this field existed).
  if (resolvedCursor.state.action !== undefined && resolvedCursor.state.action !== "find") {
    return toolStructuredError({
      ok: false,
      code: "cursor-invalid",
      field: "cursor",
      error: "this search cursor is not usable here",
      detail: "wrong-action; restart the original request",
      retry: "call",
    });
  }

  const candidateQueries = Array.isArray(args["queries"])
    ? (args["queries"] as unknown[]).filter((v): v is string => typeof v === "string" && v !== "")
    : typeof args["query"] === "string" && args["query"] !== ""
      ? [args["query"] as string]
      : [];
  const candidatePath = typeof args["path"] === "string" ? args["path"] : undefined;
  const candidateLang = typeof args["lang"] === "string" ? args["lang"] : undefined;
  const candidateRegex = args["regex"] === true;

  const mismatch = searchCursorInputMismatch(resolvedCursor.state.original_input, {
    queries: candidateQueries,
    path: candidatePath,
    lang: candidateLang,
    regex: candidateRegex,
  });
  if (mismatch !== undefined) {
    // 2026-10-19 (v016 6t-3, the tree cursor's sibling): `next` serves what
    // this call asked for. Other queries or scope are a new find with no
    // cursor; a call that names no queries cannot be re-issued as asked, so it
    // gets this cursor's own continuation, with the request's queries and
    // scope. Both keep this call's budget, or the one the request declared
    // when this call declares none. cwd, lane and task.handle are attributed
    // by canonicalToolCall as for every other continuation.
    const requestBudget = resolvedCursor.state.budget;
    const declaredBudget = {
      ...(typeof args["maxBytes"] === "number" ? { bytes: args["maxBytes"] } : {}),
      ...(typeof args["maxTokens"] === "number" ? { tokens: args["maxTokens"] } : {}),
      ...(typeof args["limit"] === "number" ? { items: args["limit"] } : {}),
    };
    const nextBudget = Object.keys(declaredBudget).length > 0
      ? declaredBudget
      : {
          ...(requestBudget?.bytes !== undefined ? { bytes: requestBudget.bytes } : {}),
          ...(requestBudget?.items !== undefined ? { items: requestBudget.items } : {}),
          ...(requestBudget?.tokens !== undefined ? { tokens: requestBudget.tokens } : {}),
        };
    const budgetArgs = Object.keys(nextBudget).length > 0 ? { budget: nextBudget } : {};
    const namesQueries = candidateQueries.length > 0;
    const requestedScope = {
      ...(candidatePath !== undefined ? { path: candidatePath } : {}),
      ...(candidateLang !== undefined ? { lang: candidateLang } : {}),
      ...(candidateRegex ? { regex: true } : {}),
      ...(args["includeScores"] !== undefined ? { includeScores: args["includeScores"] } : {}),
    };
    return toolStructuredError({
      ok: false,
      code: "invalid-input",
      field: mismatch,
      error: `search cursor continuation cannot change '${mismatch}'`,
      detail: namesQueries
        ? "cursor continuation accepts only budget overrides; next runs the queries and scope this call asked for as a new request (resuming the cursor needs the queries and scope of the call that returned it)"
        : "this cursor call names no queries; next resumes the cursor with the queries and scope of the request it continues",
      retry: "call",
      next: namesQueries
        ? canonicalToolCall("tl_search_files", {
            action: "find",
            queries: candidateQueries,
            ...(Object.keys(requestedScope).length > 0 ? { scope: requestedScope } : {}),
            ...budgetArgs,
          })
        : canonicalToolCall("tl_search_files", {
            action: "find",
            ...resolvedCursor.state.original_input,
            ...budgetArgs,
            cursor: token,
          }),
    });
  }

  const cursorEcho = {
    ...(cursorCwd !== undefined ? { cwd: cursorCwd } : {}),
    ...(cursorLane !== "" ? { lane: cursorLane } : {}),
    ...(cursorTaskHandle !== undefined ? { taskHandle: cursorTaskHandle } : {}),
  };
  const staged = stagedSearchRequestFromResolution(workspace, resolvedCursor, cursorEcho);

  // eval-0929 §3/§7: a cursor-stale restart is a FRESH request (no cursor),
  // so nothing inherits this request's budget any more — restate it
  // explicitly from what this cursor's own state carried forward, mirroring
  // the read cursor's identical fix (`ReadRequestState.budget`'s doc comment).
  const inheritedSearchBudget = staged.state.budget;
  const restartBudget = inheritedSearchBudget !== undefined
    && (inheritedSearchBudget.bytes !== undefined
      || inheritedSearchBudget.items !== undefined
      || inheritedSearchBudget.tokens !== undefined)
    ? {
        budget: {
          ...(inheritedSearchBudget.bytes !== undefined ? { bytes: inheritedSearchBudget.bytes } : {}),
          ...(inheritedSearchBudget.items !== undefined ? { items: inheritedSearchBudget.items } : {}),
          ...(inheritedSearchBudget.tokens !== undefined ? { tokens: inheritedSearchBudget.tokens } : {}),
        },
      }
    : {};
  const restartNext = (): unknown => canonicalToolCall("tl_search_files", {
    action: "find",
    ...staged.state.original_input,
    ...restartBudget,
    ...(cursorCwd !== undefined ? { cwd: cursorCwd } : {}),
    ...(cursorLane !== "" ? { lane: cursorLane } : {}),
    ...(cursorTaskHandle !== undefined ? { task: { handle: cursorTaskHandle } } : {}),
  });

  // SOURCE REVISION FIRST, before any page decision (§5.2's rule, shared with
  // the read cursor): every distinct path this snapshot references must
  // still hash the same as when the match was found.
  const distinctPaths = [...new Set(staged.state.matches.map((m) => m.path))];
  const lineCache = new Map<string, string[]>();
  for (const relPath of distinctPaths) {
    // served-bytes: not-served (find-cursor source-revision check: sha comparison, page bytes come from the ledgered matches)
    const text = await readFileSafe(relPath, workspace);
    const expected = staged.state.matches.find((m) => m.path === relPath)?.sha;
    if (text === null || (expected !== undefined && shaOfText(text) !== expected)) {
      return toolStructuredError({
        ok: false,
        code: "cursor-stale",
        field: "cursor",
        error: `the source revision of ${relPath} moved under this cursor`,
        detail: "pages of one search request are never mixed across revisions; restart the original request",
        retry: "call",
        next: restartNext(),
      });
    }
    lineCache.set(relPath, text.replace(/\r\n/gu, "\n").split("\n"));
  }

  // WALK IDENTITY: files added/removed under scope, or an ignore-rule change,
  // both move the candidate-file fingerprint even when every ALREADY-FOUND
  // file's own content is untouched.
  const walkCheck = scanFullSearchSnapshot({
    workspace,
    queries: searchScanQueriesFor(candidateQueries, candidateRegex),
    ...(candidatePath !== undefined ? { path: candidatePath } : {}),
    ...(candidateLang !== undefined ? { lang: parseMcpLang(candidateLang) } : {}),
  });
  if (walkCheck.scopeFingerprint !== staged.state.scope_fingerprint) {
    return toolStructuredError({
      ok: false,
      code: "cursor-stale",
      field: "cursor",
      error: "the set of files under this search's scope changed",
      detail: "pages of one search request are never mixed across a changed walk; restart the original request",
      retry: "call",
      next: restartNext(),
    });
  }

  const lineTextOf = (p: string, l: number): string | undefined => lineCache.get(p)?.[l - 1];
  const declaredMaxBytes = typeof args["maxBytes"] === "number" ? (args["maxBytes"] as number) : undefined;
  const declaredBudgetBytes = declaredMaxBytes !== undefined && declaredMaxBytes > 0
    ? declaredMaxBytes
    : staged.state.budget?.bytes ?? DEFAULT_SEARCH_FIND_PAGE_BUDGET_BYTES;
  // SPB (2026-10-10): this resume's own `budget.tokens` binds the funnel as
  // well (`emit.ts` measures against the tighter of bytes/tokens), so it binds
  // the page it fills; the ORIGINAL request's tokens are applied by
  // `effectiveSearchPageBudgetBytes` from `state.budget`.
  const resumeTokenBytes = estimateBytesFromTokens(args["maxTokens"]);
  const budgetBytes = resumeTokenBytes !== undefined ? Math.min(declaredBudgetBytes, resumeTokenBytes) : declaredBudgetBytes;
  const itemsBudget = typeof args["limit"] === "number" && (args["limit"] as number) > 0
    ? Math.floor(args["limit"] as number)
    : undefined;
  const reserveInput = {
    queries: candidateQueries,
    path: candidatePath,
    lang: candidateLang,
    cwd: cursorCwd,
    lane: cursorLane !== "" ? cursorLane : undefined,
    budgetBytes: declaredMaxBytes,
  };
  const reserve = searchPageEnvelopeReserve(reserveInput);
  const completeReserve = searchPageEnvelopeReserve({ ...reserveInput, complete: true });

  let files: FindFileGroup[];
  const existingPage = staged.state.pages.find((p) => p.cursor_state_version === resolvedCursor.cursorVersion);
  if (existingPage !== undefined) {
    staged.page = existingPage;
    files = withMoreLines(staged.state, renderPageFiles(staged.state, existingPage, lineTextOf), existingPage.end);
  } else {
    const choice = chooseSearchPage(staged.state, lineTextOf, budgetBytes, reserve, itemsBudget, completeReserve);
    if (!choice.ok) {
      if (choice.reason === "budget-below-minimum") {
        return toolStructuredError({
          ok: false,
          code: "budget-below-minimum",
          field: "budget",
          error: `budget ${budgetBytes} B cannot hold one whole line of this page plus its envelope`,
          detail: "raise budget.bytes to at least required_min_bytes and re-send the same cursor",
          required_min_bytes: choice.requiredMinBytes,
          retry: "call",
        });
      }
      // "complete": a resend after this request already fully delivered.
      // Honest empty, non-truncated page — nothing is owed, nothing invented.
      files = [];
    } else {
      const fixed = fixSearchPage(staged, resolvedCursor.cursorVersion, { start: choice.page.start, end: choice.page.end });
      if (!fixed.ok && fixed.reason === "state-conflict") {
        // §5.2's page fixing is a CAS (shared with the read side). A conflict
        // this server could neither adopt nor prove within its bounded retry
        // fails closed rather than serving a slice whose fixation is unknown
        // — re-sending the SAME cursor then simply finds the winner's page.
        return toolStructuredError({
          ok: false,
          code: "state-conflict",
          field: "cursor",
          error: "this search cursor's page could not be fixed under CAS",
          detail: `another call is advancing the request this cursor addresses (cursor state version ${resolvedCursor.cursorVersion}); re-send the same cursor`,
          retry: "call",
        });
      }
      // A page ANOTHER writer fixed first is served as it stands (§5.2 never
      // narrows or widens a fixed page), rendered from the record rather than
      // from this call's own — now superseded — choice.
      const settledPage = staged.page;
      files = settledPage !== undefined && fixed.ok && fixed.reused
        ? withMoreLines(staged.state, renderPageFiles(staged.state, settledPage, lineTextOf), settledPage.end)
        : withMoreLines(staged.state, choice.page.files, choice.page.end);
    }
  }

  const endIndex = staged.page?.end ?? staged.state.delivered;
  const truncated = endIndex < staged.state.matches.length || staged.state.snapshot_capped;
  const context = protocolCallContext();
  if (context !== undefined) context.searchRequest = staged;

  const body: Record<string, unknown> = {
    query: candidateQueries.join(" OR "),
    literal: !candidateRegex,
    files,
    total_files: staged.state.total_files ?? 0,
    total_matches: staged.state.total_matches ?? 0,
    truncated,
  };
  return toolOk(body);
}

/**
 * WS-P3 (DESIGN-v0.9 §6, "zero-content turns") checkless-`mode=closure`
 * content: a compact session-activity summary substituted for the old bare
 * ceremony response whenever there is nothing open to report (no pack ever
 * registered a check, or every registered check is now satisfied — see the
 * `mode === "closure"` dispatch above).
 *
 * Built ONLY from data the session/closure ledger already tracks — no new
 * counter is introduced for this. `getEditedPaths` is the SAME ledger
 * attachClosure/closureTracking.ts's own TL-edited-paths scan reads (a
 * successful edit_code write records its path there regardless of whether a
 * pack/check was ever active), so it is the one existing signal that answers
 * "what did this session actually edit" without touching session.ts.
 *
 * `edits` is the FULL edited-file count (not capped); `files` is the same
 * list capped to 8 entries for display — mirrors the ≤8/≤140ch caps
 * closureTracking.ts's own `open` listing already uses. NOTE (known, bounded
 * gap — see closureMode.spec.ts's "counts native (git-detected) edits"
 * scenario): a check satisfied purely via a NATIVE (non-edit_code) write that
 * `computeClosureState`'s git-detected scan sees is never recorded into this
 * ledger, so `edits`/`files` can under-report relative to `checksClosed` in
 * that case — `checksClosed` itself is unaffected (it comes from the
 * verified check count, not this ledger).
 */
export function closureSessionSummary(workspace: string, checksClosed: number): Record<string, unknown> {
  const editedPaths = getEditedPaths(workspace);
  return {
    edits: editedPaths.length,
    files: editedPaths.slice(0, 8),
    checks_closed: checksClosed,
    checks_open: 0,
  };
}

// ---------------------------------------------------------------------------
// explore action=tree — compact file inventory. The implementation now lives
// in tools/exploreTree.ts (buildCompactTree); the inline copy that used to sit
// here — buildTreeFromFiles/renderTreeLines/buildExploreTree plus its inline
// TREE_CAP_BYTES/TREE_DEFAULT_DEPTH and the O(n^2) pop-and-rejoin cap trim —
// was removed (G3). Dispatch goes straight through buildCompactTree's paged
// sibling, buildTreeResponse (TPB, 2026-10-10).
// ---------------------------------------------------------------------------

// D11: the CANON rewrite table (read_code -> tl_read_file, edit_code ->
// tl_edit_file, explore -> tl_search_files) is DELETED along with the three renamed
// alias entries it served. Nothing is folded before the switch any more, so
// `canonical` is simply the caller's raw name and those three names reach the
// same unknown-tool refusal as any other stranger.

/**
 * G4 (2026-09-08, qref-task-scope fix): recover a bare `tl_read_file {qref}`
 * re-pack's OWN task handle from the qref itself, before `taskHandleRefusal`
 * or any task-contract-scope resolution ever runs — so a handleless re-pack
 * behaves EXACTLY like an explicit `{qref, task:{handle:H}}` call:
 * `taskHandleRefusal` validates the SAME live handle a real caller would have
 * sent (and accepts it — it is a handle THIS server minted for THIS task and
 * nothing else about the call changed), `taskContractScopeOf`/
 * `canonicalTaskBindingOf` resolve the SAME `{lane, taskHandle}` scope
 * `taskContractStore.ts`'s `bindTaskContractHandle` relocated the epoch's
 * requirement/obligation ledger to when the handle was first minted, and the
 * executed-next ledger checks land in the SAME partition. Without this, a
 * bare-qref rebuild's `taskContractScopeOf` computes `{lane, taskHandle:
 * undefined}` — a scope already vacated by that relocation — so `buildTaskPack`
 * sees no memory of the epoch's previously proved required roles/concern
 * tokens (extra discovery turns, readiness under-reporting).
 *
 * A no-op — `args` is left exactly as the caller sent it — whenever:
 *  - `task_handle` is already present: an explicit `task.handle` always wins
 *    and is never overwritten;
 *  - `qref` is absent or empty: nothing to recover from;
 *  - `taskEpoch:"new"` is set: an explicit new-epoch boundary must not
 *    inherit the old task's handle — mirrors `resolveTaskPackQueryArg`'s own
 *    G3 rule for `taskBinding` (`resolveTaskQueryRefHandle` shares the exact
 *    same in-process/durable slot that boundary clears);
 *  - `expected_state_version` is already present with no handle. That shape
 *    is refused outright by `taskHandleRefusal` ("expected_state_version
 *    guards a task_handle's state and is meaningless without one"), and this
 *    function must not silently paper over that refusal by handing the CAS
 *    guard a handle the caller never named. The bare-`{qref}` recipe this fix
 *    targets never sends `expected_state_version` (the caller holds no handle
 *    to version-guard), so this guard costs the intended path nothing;
 *  - the recovered token does not `resolveTaskHandle(...).ok` RIGHT NOW
 *    (review-2 finding 1, BLOCKER — fail OPEN). Three ways this happens, all
 *    observed: (1) the qref was stamped with the raw fingerprint rather than a
 *    real handle because `recordTaskPackExecution` never minted one for that
 *    call (no durable state store for the workspace — e.g. a read-only root —
 *    or `mintTaskHandle` failing for any other reason: see that call site's
 *    own `mintedTaskHandle` guard, which now refuses to stamp a non-handle
 *    string onto the qref in the first place, making this arm a second,
 *    independent line of defense); (2) the handle expired; (3) the store moved
 *    to a new generation (`stale`). In every case, injecting the token would
 *    convert a call that used to succeed (nothing was injected pre-fix, and
 *    the qref alone resolved fine) into a hard `handle-unknown` refusal —
 *    recovering a scope is an optimisation, and an optimisation must never
 *    make a working call fail. Falling through here leaves `args` exactly as
 *    the caller sent it, so the call proceeds as a scope-less bare-qref
 *    re-pack — a smaller guarantee (no requirement-ledger continuity), never a
 *    wrong one, matching `withTaskHandle`'s own degradation contract.
 *
 * The recovered handle is a bearer capability THIS SAME SERVER minted and
 * stamped onto the qref slot the caller's own `qref` addresses
 * (`server.ts`'s `recordTaskPackExecution` -> `attachTaskQueryRefBinding`) —
 * never caller-supplied, so there is no new trust boundary to authenticate;
 * `taskHandleRefusal` still resolves and validates it exactly as it would any
 * other `task_handle`.
 */
export function applyRecoveredTaskHandleFromQref(args: Record<string, unknown>, workspace: string): void {
  if (args["task_handle"] !== undefined) return;
  if (args["expected_state_version"] !== undefined) return;
  if (args["taskEpoch"] === "new") return;
  const ref = typeof args["qref"] === "string" ? args["qref"].trim() : "";
  if (ref === "") return;
  const handle = resolveTaskQueryRefHandle(workspace, ref);
  if (handle === undefined) return;
  // Fail OPEN (review-2 finding 1): recovering a scope is an optimisation: it
  // must never convert a working bare-`{qref}` call into a refusal. Only stamp
  // the recovered handle onto this call when it is actually live right now —
  // no durable state store for this workspace, an expired mint, or a
  // store-epoch-`stale` handle must all fall through to the pre-recovery
  // behaviour (args left untouched) rather than injecting a token that
  // `taskHandleRefusal` will immediately reject as `handle-unknown`.
  if (!resolveTaskHandle(handle, workspace).ok) return;
  args["task_handle"] = handle;
}

/**
 * TL_TASK_HANDLE_RECOVERY (default ON; see util/flags.ts's own doc comment
 * for the full policy). `tl_read_file`/`tl_search_files` dispatch only — never
 * called from the tl_edit_file arm, which keeps strict authentication.
 *
 * Runs only when the presented `task_handle` already FAILED
 * `resolveTaskHandle` (identity/TTL/workspace/MAC are already proven false —
 * this never lowers that bar). Two routes, tried in order, both restricted
 * to THIS process's own (workspace, lane) lineage (`laneTaskHandles` is
 * in-memory and never persisted, so recovery can never reach another
 * process or installation — and a cross-installation token would fail its
 * OWN candidate liveness check regardless, via `resolveTaskHandle`'s
 * `wrong-subject` outcome):
 *
 *   (a) the SAME call's own `qref` is bound to a handle this lane minted
 *       that is still live;
 *   (b) exactly one live lane handle is a same-length, bounded mid-splice of
 *       the presented string (`laneTaskHandleMidSpliceMatch`) — two or more
 *       qualifying candidates is ambiguous and recovers nothing.
 *
 * `wrong-workspace` is never attempted — a cryptographically valid handle
 * for ANOTHER workspace is not a splice to repair, same precedent as the
 * near-miss hint `taskHandleRefusal` builds below (it short-circuits on
 * `wrong-workspace` before ever reaching that hint too).
 *
 * On a match, `args["task_handle"]` is overwritten with the recovered,
 * already-authenticated handle BEFORE `taskHandleRefusal` runs, so the rest
 * of dispatch (contract-scope binding, pack building, `withTaskHandle`'s own
 * mint-reuse fast path) proceeds exactly as if the caller had presented that
 * handle — the response's `task.id` is therefore the recovered handle
 * itself, which is how the caller self-corrects without a wasted turn.
 */
export function recoverAuthFailedTaskHandle(
  args: Record<string, unknown>,
  workspace: string,
  tool: "tl_read_file" | "tl_search_files",
): void {
  if (!taskHandleRecoveryEnabled()) return;
  const token = args["task_handle"];
  if (typeof token !== "string" || token === "") return;
  const resolved = resolveTaskHandle(token, workspace);
  if (resolved.ok || resolved.outcome === "wrong-workspace") return;
  const lane = sessionLaneOf(args);
  const mine = laneTaskHandles(workspace, lane);
  const isLiveInLane = (candidate: string): boolean =>
    candidate !== token && mine.includes(candidate) && resolveTaskHandle(candidate, workspace).ok;

  // Route (0): the presented string is a live handle of this lane plus a few
  // trailing characters — the authentic token is all there, so this is tried
  // first (laneTaskHandles.ts's isTailExtendedHandle).
  const extended = laneTaskHandleTailExtensionMatch(workspace, lane, token, isLiveInLane);
  if (extended !== undefined) {
    args["task_handle"] = extended;
    trace("task_handle_recovered", { tool, route: "tail-extension" }, workspace);
    return;
  }

  const ref = typeof args["qref"] === "string" ? args["qref"].trim() : "";
  const bound = ref === "" ? undefined : resolveTaskQueryRefHandle(workspace, ref);
  if (bound !== undefined && isLiveInLane(bound)) {
    args["task_handle"] = bound;
    trace("task_handle_recovered", { tool, route: "qref" }, workspace);
    return;
  }

  const recovered = laneTaskHandleMidSpliceMatch(workspace, lane, token, isLiveInLane);
  if (recovered !== undefined) {
    args["task_handle"] = recovered;
    trace("task_handle_recovered", { tool, route: "mid-splice" }, workspace);
    return;
  }

  // Long near-misses already have an exact did_you_mean recovery. Execute
  // that read/search recovery here, within this process's unique live lane.
  // Keep short display abbreviations, explicit CAS/new epochs and all edits
  // on their existing refusal paths. The measured CLI call kept 82 chars.
  if (resolved.outcome === "invalid" && args["expected_state_version"] === undefined
    && args["taskEpoch"] !== "new" && token.replace(/\.\.\.|\.\.|\u2026/g, "").length >= 80) {
    const nearMiss = laneTaskHandleNearMiss(workspace, lane, token, isLiveInLane);
    if (nearMiss !== undefined) {
      args["task_handle"] = nearMiss;
      trace("task_handle_recovered", { tool, route: "long-near-miss" }, workspace);
    }
  }
}

/**
 * TL_TASK_HANDLE_RECOVERY, route (c) (Copilot standard-setup evaluation,
 * 2026-10-02). `tl_read_file`/`tl_search_files` dispatch only, run right after
 * `recoverAuthFailedTaskHandle` and before `taskHandleRefusal`.
 *
 * A call that sends `task.epoch:"new"` has already asked for a FRESH task:
 * the one thing a task handle adds — continuing that task's state — is
 * exactly what the caller opted out of. So when the presented handle names
 * no live task here (it failed authentication and the lane recovery above
 * found nothing), there is nothing to honour, and refusing it
 * (`handle-unknown`, "failed authentication") only cost a turn: the
 * refusal's own `next` was this same call minus the handle. Measured:
 * MAI-Code-1.1-Flash invented `task:{handle:"config-read", epoch:"new"}`
 * and, on the refusal, told the user TokenLighten was unavailable. The
 * handle is dropped and the call proceeds as the new task it asked for; the
 * response's `task.id` is the fresh handle, which is how the caller
 * self-corrects.
 *
 * Never for: a LIVE handle (an epoch-new call on it keeps today's
 * semantics); any outcome but the dead ones `isDeadTaskHandleOutcome` lists
 * — a `wrong-workspace` handle (a valid handle minted for another workspace
 * signals a cwd mix-up and keeps its own refusal), a `wrong-purpose` token
 * (a real token of another kind, whose refusal names the mix-up) or a
 * `store-unavailable` one (the task may be live); a call that also sends
 * `expected_state_version` (a CAS guard names that handle's state, so it is
 * refused, never silently dropped — `taskHandleRefusal`'s own rule); a
 * non-string handle (still `invalid-input`); `tl_edit_file`, which keeps strict
 * authentication like `recoverAuthFailedTaskHandle`.
 */
export function dropDeadTaskHandleForNewEpoch(
  args: Record<string, unknown>,
  workspace: string,
  tool: "tl_read_file" | "tl_search_files",
): void {
  if (!taskHandleRecoveryEnabled()) return;
  if (args["taskEpoch"] !== "new") return;
  if (args["expected_state_version"] !== undefined) return;
  const token = args["task_handle"];
  if (typeof token !== "string" || token === "" || token.startsWith("tlh_s1_")) return;
  const resolved = resolveTaskHandle(token, workspace);
  if (resolved.ok || !isDeadTaskHandleOutcome(resolved.outcome)) return;
  delete args["task_handle"];
  trace("task_handle_dropped_for_new_epoch", { tool, outcome: resolved.outcome }, workspace);
}
