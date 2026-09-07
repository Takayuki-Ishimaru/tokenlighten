// ---------------------------------------------------------------------------
// searchRequestContinuation.ts — DESIGN-v0.15 §6.1 (R3): THE EMIT-TAIL HALF.
//
// NORMATIVE SOURCE: DESIGN-v0.15-exploration-continuation-reliability.md §3.2
// (settle-from-the-finalized-payload), §6.1 ("検索結果を検索のままページング
// する"); Wave-1 contract's R2 pattern (`protocol/readRequestContinuation.ts`),
// mirrored here for the search half.
//
// ------------------------------ WHERE THIS RUNS -----------------------------
//
// `emit.ts`'s tail already runs the R2 read-request settle+install
// immediately after the served-range ledger settles. THIS module is a
// SEPARATE, ADDITIVE block that runs immediately AFTER that read-request
// block (never inside it, never editing it — see this task's file-ownership
// rule): it settles a staged `search_files find` request's `delivered` prefix
// from the FINALIZED payload and installs the ONE canonical continuation, or
// clears it once nothing is owed.
//
// BYTE-IDENTICAL WHEN NOTHING IS STAGED. Returns the payload BY IDENTITY
// unless THIS call actually staged a search request AND that request's own
// `matches.truncated` is `true` — every other `search_files` response (every
// `symbols`/`locate`/`diff`/`tree`/`references` response, and every `find`
// whose result already fit) is untouched by construction.
// ---------------------------------------------------------------------------

import type { ToolCall } from "@tokenlighten/types";

import type { ShedPayload } from "./budget/shedders/registry.js";
import { canonicalToolCall } from "./envelope.js";
import {
  fixPage,
  mintSearchCursor,
  rewindSearchRequestDelivered,
  searchRequestCappedExhausted,
  searchRequestComplete,
  settleSearchRequest,
  type StagedSearchRequest,
} from "../state/searchRequestStore.js";

// Re-exported for `emit.ts`'s finding-11 post-rewrite shrink retry ONLY — see
// `rewindSearchRequestDelivered`'s own doc comment in `searchRequestStore.ts`.
export { rewindSearchRequestDelivered };

/**
 * The search request THIS call opened or resumed.
 *
 * Declared here, by ownership, exactly as `readRequestContinuation.ts`
 * declares `readRequest` on the SAME `ProtocolCallContext`: the slot is
 * written by the search dispatcher and read by this emit-tail hook, and
 * nothing else may touch it. Absent on every call that is not a `find`
 * dispatch needing pagination, which is what keeps this tail a no-op
 * elsewhere.
 */
declare module "./envelope.js" {
  interface ProtocolCallContext {
    searchRequest?: StagedSearchRequest;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Every `"${path}:${line}"` this FINALIZED `matches.files[]` actually carries
 * a snippet string for. A line whose snippet was shed away (the wire
 * ladder's rung-1 "drop `files[].snippets`, keep `files[].lines`" step) is
 * deliberately NOT counted: a caller cannot recover the occurrence from a
 * bare line number, so `settleSearchRequest` must not book it as delivered —
 * doing so would permanently withhold a line no client ever actually
 * received the content of.
 */
function shippedLineKeysOf(matches: Record<string, unknown>): Set<string> {
  const files = matches["files"];
  const keys = new Set<string>();
  if (!Array.isArray(files)) return keys;
  for (const raw of files) {
    if (!isRecord(raw)) continue;
    const path = raw["path"];
    const lines = raw["lines"];
    const snippets = raw["snippets"];
    if (typeof path !== "string" || !Array.isArray(lines) || !Array.isArray(snippets)) continue;
    lines.forEach((line, index) => {
      if (typeof line === "number" && typeof snippets[index] === "string") {
        keys.add(`${path}:${line}`);
      }
    });
  }
  return keys;
}

/** The one canonical continuation call for a staged search request. */
function cursorCall(staged: StagedSearchRequest, cursor: string): ToolCall {
  const original = staged.state.original_input;
  const args: Record<string, unknown> = { action: "find" };
  if (Array.isArray(original["queries"])) args["queries"] = original["queries"];
  if (original["scope"] !== undefined) args["scope"] = original["scope"];
  if (staged.state.budget !== undefined) args["budget"] = staged.state.budget;
  args["cursor"] = cursor;
  const echo = staged.echo;
  if (echo.cwd !== undefined && echo.cwd !== "") args["cwd"] = echo.cwd;
  if (echo.lane !== undefined && echo.lane !== "") args["lane"] = echo.lane;
  if (echo.taskHandle !== undefined && echo.taskHandle !== "") args["task"] = { handle: echo.taskHandle };
  return canonicalToolCall("search_files", args) as ToolCall;
}

/**
 * DESIGN-v0.15 §5.3 / finding 10: the 4096-record snapshot cap's recovery — a
 * FRESH (uncursored) `find`, re-scoped to the directory of the first path
 * this scan's walk found past the cap (`snapshot_next_path`, recorded by
 * `scanFullSearchSnapshot` at the moment the cap cut the snapshot short), so
 * a caller that exhausts a capped snapshot is not stranded with
 * `limit:{cause:"capped"}` and nothing else (design §6.1: "0一致はscopeと全
 * 検索条件に結合したabsenceで終了"; §5.3 wants a named recovery for every
 * truncation, not merely an honest disclosure of one).
 *
 * `scope.path` narrows to that path's OWN directory when it has one — a
 * SUBTREE, matching this field's existing prefix semantics; a root-level file
 * narrows to itself. Either way the re-scoped call is provably DIFFERENT from
 * the one that capped (never the same `next` reissued forever — §3.3), and in
 * the common case (the cap lands mid-tree, not mid-directory) it is also
 * genuinely NARROWER than the original scope. A directory-level narrowing may
 * re-walk a few already-delivered matches from earlier in that same
 * directory — disclosed by `limit.cause` staying `"capped"` rather than
 * claiming a clean resume, and strictly better than the dead end it replaces.
 *
 * Returns `undefined` when this request never recorded a next-unvisited path
 * (not capped, or the cap landed exactly on the walk's last group) — the
 * caller then keeps the bare `{cause:"capped"}` disclosure, unchanged from
 * before this fix.
 */
function cappedRecoveryCall(staged: StagedSearchRequest): ToolCall | undefined {
  const nextPath = staged.state.snapshot_next_path;
  if (nextPath === undefined || nextPath === "") return undefined;
  const slash = nextPath.lastIndexOf("/");
  const scopePath = slash > 0 ? nextPath.slice(0, slash) : nextPath;

  const original = staged.state.original_input;
  const args: Record<string, unknown> = { action: "find" };
  if (Array.isArray(original["queries"])) args["queries"] = original["queries"];
  const originalScope = isRecord(original["scope"]) ? original["scope"] : {};
  args["scope"] = { ...originalScope, path: scopePath };
  if (staged.state.budget !== undefined) args["budget"] = staged.state.budget;
  const echo = staged.echo;
  if (echo.cwd !== undefined && echo.cwd !== "") args["cwd"] = echo.cwd;
  if (echo.lane !== undefined && echo.lane !== "") args["lane"] = echo.lane;
  if (echo.taskHandle !== undefined && echo.taskHandle !== "") args["task"] = { handle: echo.taskHandle };
  return canonicalToolCall("search_files", args) as ToolCall;
}

/**
 * DESIGN-v0.15 §5.3 / finding 11: drop the LAST `(path,line)` match group from
 * `matches.files[]` — removing that file's entry entirely once its own last
 * group is gone — the search-side twin of
 * `readRequestContinuation.ts`'s `shrinkLargestEvidenceByOneLine`, at the
 * granularity a match group already is (§6.1: "同じ行の複数一致…を区別する" —
 * a group is never split, so "one whole unit" here means one group, not one
 * line of it).
 *
 * Exported for `emit.ts`'s post-rewrite budget check ONLY. Returns
 * `undefined` when there is nothing left to drop (`matches.files` absent or
 * empty); the caller fails closed in that case.
 */
export function shrinkLastSearchMatchGroup(payload: ShedPayload): ShedPayload | undefined {
  const matches = payload["matches"];
  if (!isRecord(matches)) return undefined;
  const files = matches["files"];
  if (!Array.isArray(files) || files.length === 0) return undefined;
  const lastFile = files[files.length - 1];
  if (!isRecord(lastFile)) return undefined;
  const lines = lastFile["lines"];
  if (!Array.isArray(lines) || lines.length === 0) return undefined;
  const snippets = lastFile["snippets"];
  const shrunkLines = lines.slice(0, -1);
  const shrunkSnippets = Array.isArray(snippets) ? snippets.slice(0, -1) : snippets;
  const shrunkFiles = shrunkLines.length === 0
    ? files.slice(0, -1)
    : [...files.slice(0, -1), { ...lastFile, lines: shrunkLines, snippets: shrunkSnippets }];
  return { ...payload, matches: { ...matches, files: shrunkFiles } };
}

/**
 * Settle the staged search request and install its ONE canonical
 * continuation, or clear the continuation once D is empty.
 *
 * Returns the payload by IDENTITY when no request is staged, when this
 * response's `matches.truncated` is not `true` (nothing for this request to
 * page — the ordinary, non-staged find/symbols/locate/diff/tree/references
 * path), or when settling could not persist (a fabricated cursor would be
 * worse than the dispatcher's own body — see `readRequestContinuation.ts`'s
 * identical rule).
 */
export function applySearchRequestContinuation(
  payload: ShedPayload,
  staged: StagedSearchRequest | undefined,
): ShedPayload {
  if (staged === undefined) return payload;
  const matches = payload["matches"];
  if (!isRecord(matches) || matches["form"] !== "find") return payload;
  // Rule T (A.5.3-A.5.10 preamble): `truncated` never rides the wire body —
  // its INTERNAL meaning is folded into `limit`'s mere PRESENCE ("absence of
  // `limit` IS completeness"). A staged request whose producer body was NOT
  // truncated carries no `limit` here at all, which is the correct no-op.
  if (payload["limit"] === undefined) return payload;

  const fixedPage = staged.page ?? { start: 0, end: staged.state.matches.length };
  const shippedKeys = shippedLineKeysOf(matches);
  const settled = settleSearchRequest(staged, fixedPage, shippedKeys);
  if (settled === undefined) return payload;

  if (searchRequestComplete(settled)) {
    if (payload["limit"] === undefined) return payload;
    const next: ShedPayload = { ...payload };
    delete next["limit"];
    return next;
  }

  if (searchRequestCappedExhausted(settled)) {
    const recovery = cappedRecoveryCall(staged);
    const limit = payload["limit"];
    const alreadyInstalled = isRecord(limit) && limit["cause"] === "capped"
      && (recovery === undefined ? limit["next"] === undefined : isRecord(limit["next"]));
    if (alreadyInstalled) return payload;
    return {
      ...payload,
      limit: recovery === undefined ? { cause: "capped" } : { cause: "capped", next: recovery },
    };
  }

  const cursor = mintSearchCursor(staged);
  if (cursor === undefined) return payload;
  return { ...payload, limit: { cause: "wire", next: cursorCall(staged, cursor) } };
}

/**
 * Server-dispatch helper: fix the page a PRESENTED cursor addresses, exactly
 * once, under CAS — the RESUME-side twin of `fixPage` used directly by
 * `readRequestStore.ts`'s own call site. Exported from here (rather than
 * required at every call site to re-import `fixPage` from the store) purely
 * so the dispatch code and this module agree on one `StagedSearchRequest.page`
 * assignment convention.
 */
export function fixSearchPage(
  staged: StagedSearchRequest,
  cursorVersion: number,
  choice: { start: number; end: number },
): { ok: true; reused: boolean } | { ok: false; reason: "unavailable" | "state-conflict" } {
  const fixed = fixPage(staged, cursorVersion, choice);
  if (!fixed.ok) {
    staged.page = undefined;
    return fixed;
  }
  staged.page = fixed.page;
  return { ok: true, reused: fixed.reused };
}
