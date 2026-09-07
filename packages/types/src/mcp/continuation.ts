// ---------------------------------------------------------------------------
// DESIGN-v0.15 §5 (R2) / §6.1 (R3) — THE ONE FETCH-REQUEST STATE MODEL.
//
// NORMATIVE SOURCE: DESIGN-v0.15-exploration-continuation-reliability.md §3.1
// ("三つの状態を分離する"), §5.1 ("取得単位と残件"), §5.2 ("wireと寿命"),
// §6.1 ("検索結果を検索のままページングする"); the Wave-1 integration contract
// §2.1.
//
// -------------------------- WHY THIS FILE EXISTS ----------------------------
//
// §3.1 separates THREE states that this server used to conflate:
//
//   1. the TASK's requirement      -> task-state / obligation graph
//   2. ONE FETCH REQUEST's remainder -> **this file**
//   3. what the caller已 holds     -> the settled served-range ledger
//
// (2) had no representation at all before v0.15. A `read_file` whose body was
// cut by the wire budget shipped a `limit.next` naming only the LAST shed
// pass's window, so a follower that executes `next` verbatim — which AGENTS.md
// requires it to do — silently lost every line the earlier passes had cut. The
// request record below is what remembers the ORIGINAL extent (`requested`, the
// design's Q) so the continuation can always describe everything still owed
// (`remaining`, the design's D).
//
//   D = Q - (C ∪ S)
//   complete <=> D is empty
//   the next page's windows ⊆ D
//
// C is the caller's valid prior coverage (the served-range ledger, keyed by
// workspace+lane+path+sha) and S is what THIS request has already delivered.
// A request opened by a `task.force_serve:true` call starts with C = ∅ (§5.1:
// "原入力にforce_serveを付けた新requestはCを空として開始し").
//
// ------------------------------ NOT THE WIRE --------------------------------
//
// Nothing here is a wire shape. The wire carries exactly ONE additive field —
// `read_file.cursor`, an opaque token — and `packages/types/src/domain/
// state-handle.ts`'s F5 rule still holds: a cursor rides only inside
// `next.arguments`, never as a standalone top-level response field. These
// interfaces describe the SERVER-SIDE record that token addresses, and they
// live in `packages/types` (not in the server) because the design forbids a
// duplicate contract outside this package.
//
// PATHS ARE WORKSPACE-RELATIVE AND POSIX-SEPARATED, and `sha` is the same
// `"sha256:<12-hex>"` short form `Evidence.sha` already uses, so a record can
// be compared against the ledger without a second normalization rule.
// ---------------------------------------------------------------------------

/** A 1-based INCLUSIVE line window. `start <= end`, both >= 1. */
export interface LineWindow {
  start: number;
  end: number;
}

/**
 * The RETURN REPRESENTATION a request asked for (§5.1: "Qはcontent/comments等
 * が定める返却表現を含む").
 *
 * Two requests for the same lines in different representations are DIFFERENT
 * requests: an `outline` of lines 1-113 does not discharge a `full` request for
 * them, and a comments-elided serve does not discharge a `comments:"keep"` one.
 */
export type ContentRepresentation = {
  content: "full" | "auto" | "outline";
  comments: "elide" | "keep";
};

/** One target of a read request, with its own Q and its own recomputed D. */
export interface ReadRequestTargetState {
  /** Workspace-relative, POSIX separators. */
  path: string;
  /** `"sha256:<12-hex>"`, as used by `Evidence.sha` — the SOURCE REVISION. */
  sha: string;
  total_lines: number;
  representation: ContentRepresentation;
  /** Q — normalized, sorted, non-overlapping. */
  requested: LineWindow[];
  /** D — recomputed on every settle. */
  remaining: LineWindow[];
}

/**
 * One page of a read request.
 *
 * FIXED ONCE (§5.2: "未確定ページの境界はcursorの初回受理時にbudgetから決め、
 * 既存stateのCASで一度だけ確定する"). A resend of the same cursor names the
 * SAME `windows`, whatever budget the resend declares: a larger budget does not
 * widen the page, and a budget too small to hold it is a
 * `budget-below-minimum` refusal rather than a silently narrowed page.
 */
export interface ReadRequestPage {
  /** 1-based page number. */
  index: number;
  windows: Array<{ path: string; window: LineWindow }>;
  /**
   * What this page's own call(s) ACTUALLY PUT ON THE WIRE, per path — never
   * the planned boundary above.
   *
   * `windows` is a PLAN, fixed before the response exists: the ladder may
   * still shed lines out of the tail of it, and `emit.ts`'s settle is the
   * first moment anyone knows which ones survived. Crediting `windows` to
   * `S` in `D = Q - (C ∪ S)` therefore books lines that never shipped as
   * delivered, and a request whose ladder shed anything ended with those
   * lines silently missing and no `next` at all (defect: "unsent lines
   * counted as delivered"). `settledTargets` credits ONLY this field, for
   * every page — the current one and every earlier one alike.
   *
   * `undefined` means "this page's delivery was never accounted" (fixed but
   * the call ended in a refusal, or a record written before this field
   * existed) and CREDITS NOTHING: the page stays owed and is re-served on the
   * next cursor, which is the honest direction to be wrong in. A receipt —
   * a response that asserts the caller already holds this page's bytes —
   * records the planned windows, because it is a statement about delivery.
   *
   * Always a SUBSET of `windows`: a page is never widened after fixing.
   */
  shipped?: Array<{ path: string; window: LineWindow }>;
  /** Boundary fixed once, by CAS, at first acceptance. */
  fixed_at_ms: number;
  /**
   * The handle `stateVersion` of the cursor that addresses this page.
   *
   * A cursor token carries no page number of its own (the `aad` is bound to
   * the request identity, not to a position), so the page a cursor names is
   * recovered by matching this value against `DecodedStateHandle.stateVersion`.
   * That makes "resend of the same cursor => the same logical page" a lookup
   * rather than a heuristic, and makes a cursor minted for page N unable to
   * advance to page N+1.
   */
  cursor_state_version: number;
}

/** The persisted state ONE `read_file` fetch request owns. */
export interface ReadRequestState {
  v: 1;
  family: "read";
  /** Request id (uuid-ish). NOT the cursor token. */
  id: string;
  /** `sha256(realpath)` prefix — the same derivation `handleCodec` uses. */
  workspace_ref: string;
  lane?: string;
  /** Bound parent task handle when the original call carried one. */
  task_handle?: string;
  /** Parent epoch tokens when known. */
  epoch_tokens?: string[];
  /** sha256 of the canonical original input WITHOUT `budget`/`task.force_serve`. */
  input_fingerprint: string;
  /** Canonical v1 arguments minus `cwd`/`lane` — the restart `next`. */
  original_input: Record<string, unknown>;
  /** Inherited; a continuation call may override it. */
  budget?: { bytes?: number; tokens?: number };
  targets: ReadRequestTargetState[];
  pages: ReadRequestPage[];
  created_at_ms: number;
  /** 1 h, like the existing reference-continuation handles. */
  expires_at_ms: number;
  /**
   * The ledger coverage that existed when this request was OPENED, per target
   * path, as `"start-end"` strings.
   *
   * Only read for a request whose ORIGINAL call carried `task.force_serve`:
   * §5.1 makes C = ∅ for such a request, so its D is reduced by what THIS
   * request delivered and by nothing else. Recording the baseline (rather than
   * a boolean) keeps that computable from the ledger alone: the windows this
   * request delivered are exactly `ledgerNow - baseline`.
   */
  ledger_baseline?: Record<string, string[]>;
  /** True iff the ORIGINAL call carried `task.force_serve:true`. */
  force_serve_origin?: boolean;
}

// ---------------------------------------------------------------------------
// R3 — the search half of the same model, filled in.
//
// NORMATIVE SOURCE: DESIGN-v0.15-exploration-continuation-reliability.md
// §6.1 ("検索結果を検索のままページングする"); validation appendix §1 row
// "検索継続" and the bullet "検索cursor", §2.2 row R3; Wave-1 contract §2.1's
// "declared now, filled in later" skeleton (below), which this fills in.
// ---------------------------------------------------------------------------

/**
 * One stable-ordered match record.
 *
 * §6.1 requires find's continuation to page MATCH RECORDS, not files and not
 * file bodies, so the identity of a match has to survive between pages:
 * `(path, line, column, occurrence, query_index)` distinguishes two hits on one
 * line, the same hit for two queries, and overlapping context windows; `sha`
 * pins the revision the match was found at.
 *
 * STABLE ORDER for the immutable snapshot `SearchRequestState.matches` holds:
 * `path` asc, then `line` asc, then `column` asc, then `occurrence` asc, then
 * `query_index` asc — exactly the tuple order the design names. `occurrence`
 * is 1-based and counts positions of the SAME `query_index` on the SAME
 * `(path,line)`; two different `query_index` values may legitimately name the
 * same `(path,line,column)` (the "same hit for two queries" case), which is
 * why `query_index` — not `occurrence` alone — is needed to disambiguate.
 */
export interface SearchMatchRecord {
  path: string;
  line: number;
  column: number;
  occurrence: number;
  query_index: number;
  sha: string;
}

/**
 * One page of a search request — the search-side twin of `ReadRequestPage`.
 *
 * The snapshot's stable order makes a page a plain contiguous SLICE of
 * `matches`: `[start, end)`. Fixed once, by CAS, at first acceptance — a
 * resend of a cursor that already fixed a page returns the SAME slice,
 * whatever budget it declares (mirrors `ReadRequestPage`; see its own doc
 * comment for why). `cursor_state_version` is matched against the decoded
 * handle's `stateVersion`, the SAME page-selector mechanism `ReadRequestPage`
 * uses, so a page-N cursor is structurally unable to advance to page N+1.
 */
export interface SearchRequestPage {
  /** 1-based page number. */
  index: number;
  /** Inclusive start index into `matches` (snapshot order). */
  start: number;
  /** Exclusive end index into `matches`. */
  end: number;
  /** Boundary fixed once, by CAS, at first acceptance. */
  fixed_at_ms: number;
  cursor_state_version: number;
}

/**
 * The persisted state ONE `search_files` `find` fetch request owns (R3).
 *
 * The model deliberately stays a plain PREFIX counter (`delivered: number`)
 * rather than a scattered delivered-set: every page — including the first,
 * once a request is staged — is served by slicing `matches` starting at
 * `delivered`, so "how much of Q has shipped" is always exactly
 * `matches.slice(0, delivered)` and D is always exactly `matches.slice(delivered)`
 * (plus, when `snapshot_capped`, the further, unrepresented tail beyond the
 * memory bound — see `snapshot_capped`'s own doc comment).
 */
export interface SearchRequestState {
  v: 1;
  family: "search";
  /**
   * Which `search_files` action opened this request.
   *
   * DESIGN-v0.15 validation appendix §1's "検索cursor" bullet: "既存position
   * handleは再利用候補だが、要求・lane・epoch・source revisionの結合を追加する"
   * — `references`' own stateless `(path,line)` position cursor gets that same
   * request/lane/task/revision binding by riding this store under its own
   * `action`, rather than a second parallel ledger. Absent reads as `"find"`
   * (every record written before this field existed IS a find request; the
   * only other member, `"references"`, is always written explicitly).
   */
  action?: "find" | "references";
  id: string;
  workspace_ref: string;
  lane?: string;
  task_handle?: string;
  /** Parent epoch tokens when known (mirrors `ReadRequestState`). */
  epoch_tokens?: string[];
  /** sha256 of the canonical original input WITHOUT `budget`/`task.force_serve`. */
  input_fingerprint: string;
  /** Canonical v1 arguments minus `cwd`/`lane` — the restart `next`. */
  original_input: Record<string, unknown>;
  /**
   * Hash of the WALK's own identity: the sorted candidate file list
   * `enumerateFindTextUniverse` visited under this scope, plus the walk's
   * omission counts. Recomputed on every resume; a mismatch means a file was
   * added or removed under scope, or an ignore rule changed what the walk
   * would visit — either way the immutable snapshot no longer describes the
   * current workspace, so the resume refuses `cursor-stale` rather than
   * mixing an old snapshot with a new walk.
   */
  scope_fingerprint: string;
  /** False when the walk was cut short by exclusions, size caps or errors. */
  walk_complete: boolean;
  /** Immutable ordered snapshot, capped at `MAX_SEARCH_SNAPSHOT_RECORDS`. */
  matches: SearchMatchRecord[];
  /** Prefix count of `matches` already shipped by a finalized response. */
  delivered: number;
  /**
   * The TRUE total distinct `(path,line)` count this request found, computed
   * once at open time over the full (pre-cap) result. `null` only if a future
   * caller opens a request before a count is available; this implementation
   * always knows it before persisting.
   */
  total_matches: number | null;
  /** The TRUE total distinct matched-file count, same completeness contract as `total_matches`. */
  total_files: number | null;
  /**
   * True iff the true match count exceeded `MAX_SEARCH_SNAPSHOT_RECORDS` and
   * `matches` therefore holds only a PREFIX of the full result (whole
   * `(path,line)` groups only — a group is never split across the cap). The
   * last reachable page (once `delivered === matches.length`) degrades to
   * `limit:{cause:"capped"}` (no `next`) rather than claiming completion or
   * silently restarting past the memory bound.
   */
  snapshot_capped: boolean;
  /**
   * finding 10: the first `(path,line)` group's path that did NOT make it
   * into `matches` because it would have crossed `MAX_SEARCH_SNAPSHOT_RECORDS`
   * — i.e. the walk's own next candidate past the cap, in the SAME stable
   * order `matches` itself uses. `undefined` when `snapshot_capped` is false,
   * or (defensively) when the cap landed exactly on the last group the walk
   * ever visits. Lets a capped-and-exhausted request's continuation name a
   * canonical narrowing `next` (a fresh `find` re-scoped to this path's own
   * directory) instead of a bare `limit:{cause:"capped"}` dead end.
   */
  snapshot_next_path?: string;
  /** Inherited from the ORIGINAL call and echoed verbatim on every continuation. `items` caps records/page; `bytes`/`tokens` are the wire byte/token ceilings. */
  budget?: { bytes?: number; items?: number; tokens?: number };
  pages: SearchRequestPage[];
  created_at_ms: number;
  /** 1 h, like the read-request cursor and the legacy reference-continuation handles. */
  expires_at_ms: number;
  /**
   * `action:"references"` ONLY. The `(path,line)` this request's chain has
   * served through, plus that path's source revision (`sha`) at the moment
   * this record was written — what a `references` resume validates BEFORE
   * trusting the position (mirrors §6.1's per-target revision pin, sized down
   * to the single boundary file a stateless re-walk actually needs re-checked
   * — see `state/searchRequestStore.ts`'s `openReferencesCursorRequest` doc
   * comment for why `references` does not also snapshot `matches`/`pages`
   * the way `find` does). `find` pages by slicing the immutable `matches`
   * snapshot instead and leaves this undefined.
   */
  resume_position?: { path: string; line: number; sha: string };
}

/** The discriminated union every request-purpose state handle addresses. */
export type FetchRequestState = ReadRequestState | SearchRequestState;
