// ---------------------------------------------------------------------------
// searchRequestStore.ts — DESIGN-v0.15 §6.1 (R3): ONE `search_files find`
// REQUEST'S ORDERED MATCH SNAPSHOT, DELIVERED PREFIX AND PAGES.
//
// NORMATIVE SOURCE: DESIGN-v0.15-exploration-continuation-reliability.md §6.1
// ("検索結果を検索のままページングする"); validation appendix §1 row
// "検索継続" and the bullet "検索cursor", §2.2 row R3; Wave-1 contract §2.1's
// `SearchRequestState`/`SearchMatchRecord` skeleton (now filled in at
// `packages/types/src/mcp/continuation.ts`); the R2 pattern this file mirrors
// end-to-end, `state/readRequestStore.ts`.
//
// -------------------------------- THE MODEL ---------------------------------
//
// A find's continuation used to escalate into `read_file mode:"full"` once a
// scope was narrowed to one file whose own preview was STILL truncated
// (`protocol/searchFamily.ts`'s old `findNext` — see that module's history for
// the exact branch this replaces). The fix keeps an IMMUTABLE, stable-ordered
// snapshot of every match this request's queries/scope produced, and pages it
// as a plain PREFIX counter:
//
//   Q = the full ordered snapshot (matches[], stable order path/line/column/
//       occurrence/query_index)
//   D = matches.slice(delivered)
//   complete <=> delivered === matches.length (and not `snapshot_capped`)
//
// Unlike the read side (whose Q is multi-target and whose C/S union can be a
// SCATTERED subset of Q — see readRequestStore.ts's header), a search
// request's delivered set is deliberately kept a clean PREFIX: once a request
// is staged, EVERY page — including the first — is built by this module's own
// `chooseSearchPage`, in snapshot order, never by the ordinary (interleaved,
// footholds-first) `buildFindResponseForQueries` renderer. That is a
// deliberate, disclosed behaviour change for exactly the calls that would
// otherwise have escalated: their FIRST page's `files[]` ordering is no longer
// "one line per file, round-robin", it is "every line of the
// alphabetically-first matched file, in line order, then the next file" — see
// this file's own `groupRecordsByLine`. Every other find call (one whose
// result already fits) is completely unaffected: nothing in this module runs
// unless a request is staged, and a request is staged only when a response
// would otherwise need multi-page pagination (`server.ts`'s call site).
//
// ------------------------ WHY NOT A NEW STORE -------------------------------
//
// Exactly `readRequestStore.ts`'s reasoning (design §10 item 3: "新しい独立
// ストアを作らない"). Records live in the existing per-workspace
// `state/stateStore.ts` under the `search-request` purpose (already
// registered generically in `state/handleCodec.ts` / `state/stateHandles.ts`
// for both R2 and R3's fetch-request purposes), addressed by a `handleCodec`
// token with its own prefix (`tlh_sreq_v1_`) and MAC, using the store's own
// `expectedVersion` CAS for page fixing and TTL/capacity/corruption policy.
//
// ------------------------------- I/O BOUNDARY -------------------------------
//
// Like `readRequestStore.ts`, this module does its OWN file reads for the
// snapshot scan (`scanFullSearchSnapshot` — the walk and per-line matching
// necessarily touch the filesystem, exactly like `findText.ts`'s own
// `scanLiteral`), but page SERVING (`chooseSearchPage`) takes a `lineTextOf`
// callback rather than reading files itself, so a caller can supply
// already-validated (sha-checked) content and this module stays testable
// without a real filesystem for the pure page-selection algebra.
// ---------------------------------------------------------------------------

import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";

import type {
  SearchMatchRecord,
  SearchRequestPage,
  SearchRequestState,
} from "@tokenlighten/types";

import {
  buildOmittedExtra,
  createScanCoverage,
  enumerateFindTextUniverse,
  escapeRegExp,
  isSafeRegexQuery,
  MAX_LINES_PER_FILE,
  trimMatchText,
  type FindFileGroup,
} from "../features/search/find/findText.js";
import { anyWalkOmission, type FoundFile, type LangKey } from "../tools/walkRepo.js";
import { decodeTextBuffer } from "../util/textDecode.js";
import { shaOfText } from "../util/handles.js";

import { workspaceRefOf } from "./handleCodec.js";
import {
  FETCH_REQUEST_HANDLE_TTL_MS,
  fetchRequestPayloadRef,
  mintFetchRequestHandle,
  resolveFetchRequestHandle,
} from "./stateHandles.js";
import { stateStoreFor } from "./stateStore.js";

// ---------------------------------------------------------------------------
// Memory bound (design §6.1: "大量一致を無制限にメモリ保持せず、既存状態基盤の
// 期限・容量制限を適用し、回収時は明示的な失効にする")
// ---------------------------------------------------------------------------

/**
 * Cap on the immutable snapshot's stored record count.
 *
 * A `(path,line)` group is never split across the cap (see
 * `scanFullSearchSnapshot`): once adding a whole group would cross this
 * bound, the snapshot stops there and `snapshot_capped` is set. The TTL
 * (`FETCH_REQUEST_HANDLE_TTL_MS`, 1 h, shared with the read-request cursor)
 * is the OTHER half of the bound — this module never keeps a request alive
 * past either limit; see `resolveSearchCursor` for the explicit
 * `cursor-invalid` an expired/evicted request produces.
 *
 * Test-only override: `TOKENLIGHTEN_TEST_MAX_SEARCH_SNAPSHOT_RECORDS`, a
 * positive integer, lowers this cap so a test can exercise the
 * `snapshot_capped`/`snapshot_next_path` recovery path (finding 10) without
 * constructing thousands of matches. Ignored (falls back to 4096) when unset,
 * non-numeric, or non-positive — production never sets it.
 */
export const MAX_SEARCH_SNAPSHOT_RECORDS = ((): number => {
  const raw = process.env["TOKENLIGHTEN_TEST_MAX_SEARCH_SNAPSHOT_RECORDS"];
  const parsed = raw !== undefined ? Number.parseInt(raw, 10) : NaN;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 4096;
})();

// ---------------------------------------------------------------------------
// Stable order — the whole correctness surface for "no dup, no missing"
// ---------------------------------------------------------------------------

function compareMatchRecords(a: SearchMatchRecord, b: SearchMatchRecord): number {
  if (a.path !== b.path) return a.path < b.path ? -1 : 1;
  if (a.line !== b.line) return a.line - b.line;
  if (a.column !== b.column) return a.column - b.column;
  if (a.occurrence !== b.occurrence) return a.occurrence - b.occurrence;
  return a.query_index - b.query_index;
}

interface MatchLineGroup {
  path: string;
  line: number;
  records: SearchMatchRecord[];
}

/**
 * Group an ALREADY `compareMatchRecords`-sorted list into consecutive
 * `(path,line)` runs. Safe because the sort puts every record for the same
 * line adjacent to each other; this is the unit a page never splits (the wire
 * has one `snippets[]` entry per line, not per occurrence or per query).
 */
function groupRecordsByLine(sorted: readonly SearchMatchRecord[]): MatchLineGroup[] {
  const groups: MatchLineGroup[] = [];
  for (const record of sorted) {
    const last = groups[groups.length - 1];
    if (last !== undefined && last.path === record.path && last.line === record.line) {
      last.records.push(record);
    } else {
      groups.push({ path: record.path, line: record.line, records: [record] });
    }
  }
  return groups;
}

// ---------------------------------------------------------------------------
// Identity and binding — mirrors readRequestStore.ts's fingerprint/aad shape
// ---------------------------------------------------------------------------

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(record[k])}`).join(",")}}`;
}

/**
 * Hash of a walk's own candidate-file identity — `SearchRequestState.
 * scope_fingerprint`'s exact formula, shared so a `references` request (which
 * walks via `tools/findReferences.ts`'s own `walkCodeFiles`, not this
 * module's `enumerateFindTextUniverse`) can stamp and re-verify a fingerprint
 * that means the same thing as `find`'s. `files` need not be pre-sorted.
 */
export function walkScopeFingerprint(files: readonly string[], omissions: unknown): string {
  return sha256Hex(stableStringify({ files: [...files].sort(), omissions }));
}

/**
 * The canonical original input's fingerprint, WITHOUT `budget` and WITHOUT
 * `task.force_serve` — same exclusion rule as `readRequestFingerprint`, for
 * the same reason (§5.2's sanctioned continuation overrides).
 */
export function searchRequestFingerprint(originalInput: Record<string, unknown>): string {
  const scrubbed: Record<string, unknown> = { ...originalInput };
  delete scrubbed["budget"];
  delete scrubbed["cwd"];
  delete scrubbed["lane"];
  const task = scrubbed["task"];
  if (task !== null && typeof task === "object" && !Array.isArray(task)) {
    const copy = { ...(task as Record<string, unknown>) };
    delete copy["force_serve"];
    if (Object.keys(copy).length === 0) delete scrubbed["task"];
    else scrubbed["task"] = copy;
  }
  return sha256Hex(stableStringify(scrubbed)).slice(0, 32);
}

/** The authenticated `aad`: `sha256(lane | task_handle | input_fingerprint)` — identical shape to read's. */
export function searchRequestBinding(input: { lane?: string; taskHandle?: string; fingerprint: string }): string {
  return sha256Hex(`${input.lane ?? ""}|${input.taskHandle ?? ""}|${input.fingerprint}`);
}

/**
 * Which of the caller's own fields must match the bound record verbatim on a
 * resume — design: "原query、literal/regex/case条件、scope...をcursorに結合
 * する" plus the task's own "A cursor call whose queries/scope/options differ
 * from the bound record ⇒ refusal invalid-input". Returns the FIRST
 * mismatched field name (dotted, e.g. `"scope.path"`), or `undefined` when
 * every checked field agrees.
 */
export function searchCursorInputMismatch(
  originalInput: Record<string, unknown>,
  candidate: { queries: readonly string[]; path?: string; lang?: string; regex?: boolean },
): string | undefined {
  const origQueries = Array.isArray(originalInput["queries"])
    ? (originalInput["queries"] as unknown[]).map((v) => String(v))
    : [];
  if (JSON.stringify(origQueries) !== JSON.stringify([...candidate.queries])) return "queries";
  const scope = originalInput["scope"];
  const scopeRecord = scope !== null && typeof scope === "object" && !Array.isArray(scope)
    ? (scope as Record<string, unknown>)
    : {};
  const origPath = typeof scopeRecord["path"] === "string" ? scopeRecord["path"] : undefined;
  if (origPath !== candidate.path) return "scope.path";
  const origLang = typeof scopeRecord["lang"] === "string" ? scopeRecord["lang"] : undefined;
  if (origLang !== candidate.lang) return "scope.lang";
  const origRegex = scopeRecord["regex"] === true;
  if (origRegex !== (candidate.regex === true)) return "scope.regex";
  return undefined;
}

// ---------------------------------------------------------------------------
// The full, uncapped scan — Q at open time
// ---------------------------------------------------------------------------

export interface SearchScanQuery {
  text: string;
  regex: boolean;
  caseInsensitive: boolean;
}

export interface SearchScanInput {
  workspace: string;
  queries: readonly SearchScanQuery[];
  path?: string;
  lang?: LangKey;
}

export interface SearchScanResult {
  /** Immutable ordered snapshot, capped at `MAX_SEARCH_SNAPSHOT_RECORDS`. */
  records: SearchMatchRecord[];
  snapshotCapped: boolean;
  /** finding 10: mirrors `SearchRequestState.snapshot_next_path` — set iff `snapshotCapped`. */
  nextUnvisitedPath: string | undefined;
  /** TRUE distinct `(path,line)` count, pre-cap. */
  totalMatches: number;
  /** TRUE distinct matched-file count, pre-cap. */
  totalFiles: number;
  /** False when the walk itself was cut short (ignore/size cap/errors) — never claims full-scope completion when false. */
  walkComplete: boolean;
  /** Hash of the walk's own candidate-file identity (see `SearchRequestState.scope_fingerprint`'s doc comment). */
  scopeFingerprint: string;
  /** `buildOmittedExtra`'s disclosure, when non-empty — the SAME wire vocabulary the ordinary find pipeline uses. */
  omitted: Record<string, unknown> | undefined;
  /**
   * Raw (undecoded-newline-normalized) line text for any file this scan
   * actually read, backed by the SAME per-response cache the scan itself
   * populated — so building page 1 from this result needs no second read
   * pass. Returns `undefined` for a path/line this scan never visited.
   */
  readLine: (path: string, line: number) => string | undefined;
}

/**
 * Run every query over the SAME walked universe (mirrors
 * `buildFindResponseForQueries`'s one-walk-per-response contract), enumerate
 * EVERY occurrence per matched line (not just "this line matched", which is
 * all `scanLiteral` itself records), and return the complete, stably-sorted,
 * capped snapshot.
 *
 * File content is read at most once per path regardless of how many queries
 * are checked against it (`lineCache`), and each scanned file's sha is
 * captured at the SAME read (`shaCache`) so every returned record's `sha`
 * pins the exact revision the match was found at — the source-revision
 * pinning `resolveSearchCursor`'s staleness check later re-verifies.
 */
export function scanFullSearchSnapshot(input: SearchScanInput): SearchScanResult {
  const universe = enumerateFindTextUniverse(input.workspace, {
    ...(input.path !== undefined ? { path: input.path } : {}),
    ...(input.lang !== undefined ? { lang: input.lang } : {}),
  });
  const walkComplete = !anyWalkOmission(universe.omissions);
  const coverage = createScanCoverage();

  const lineCache = new Map<string, string[] | null | "undecodable">();
  const shaCache = new Map<string, string>();

  const linesOf = (file: FoundFile): string[] | null | "undecodable" => {
    const cached = lineCache.get(file.relPath);
    if (cached !== undefined) return cached;
    let buf: Buffer;
    try {
      buf = fs.readFileSync(file.absPath);
    } catch {
      lineCache.set(file.relPath, null);
      return null;
    }
    const text = decodeTextBuffer(buf);
    if (text === null) {
      lineCache.set(file.relPath, "undecodable");
      return "undecodable";
    }
    shaCache.set(file.relPath, shaOfText(text));
    const lines = text.split(/\r?\n/);
    lineCache.set(file.relPath, lines);
    return lines;
  };

  const rawRecords: SearchMatchRecord[] = [];
  for (let queryIndex = 0; queryIndex < input.queries.length; queryIndex += 1) {
    const query = input.queries[queryIndex]!;
    if (query.text === "") continue;
    let needle: RegExp;
    if (query.regex) {
      if (!isSafeRegexQuery(query.text)) continue;
      try {
        needle = new RegExp(query.text, `g${query.caseInsensitive ? "i" : ""}`);
      } catch {
        continue;
      }
    } else {
      needle = new RegExp(escapeRegExp(query.text), `g${query.caseInsensitive ? "i" : ""}`);
    }

    for (const file of universe.files) {
      if (file.kind === "artifact") {
        coverage.unscanned.add(file.relPath);
        continue;
      }
      const lines = linesOf(file);
      if (lines === null) {
        coverage.unscanned.add(file.relPath);
        continue;
      }
      if (lines === "undecodable") {
        coverage.undecodable.add(file.relPath);
        continue;
      }
      coverage.scanned.add(file.relPath);
      const sha = shaCache.get(file.relPath) ?? "";
      for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
        const lineText = lines[lineIndex]!;
        needle.lastIndex = 0;
        let occurrence = 0;
        for (;;) {
          const match = needle.exec(lineText);
          if (match === null) break;
          occurrence += 1;
          rawRecords.push({
            path: file.relPath,
            line: lineIndex + 1,
            column: match.index + 1,
            occurrence,
            query_index: queryIndex,
            sha,
          });
          // A zero-length match (a query like a lone `^`/`$` anchor) would
          // otherwise loop forever at the same `lastIndex`.
          if (match[0].length === 0) needle.lastIndex += 1;
        }
      }
    }
  }

  rawRecords.sort(compareMatchRecords);
  const grouped = groupRecordsByLine(rawRecords);
  const totalMatches = grouped.length;
  const totalFiles = new Set(grouped.map((g) => g.path)).size;

  const records: SearchMatchRecord[] = [];
  let snapshotCapped = false;
  // finding 10: the group that TRIGGERED the cap is, by construction, the
  // first one this stable order excludes — exactly "the next unvisited path"
  // a capped continuation's recovery `next` re-scopes to. No second pass over
  // `universe.files` needed.
  let nextUnvisitedPath: string | undefined;
  for (const group of grouped) {
    if (records.length + group.records.length > MAX_SEARCH_SNAPSHOT_RECORDS) {
      snapshotCapped = true;
      nextUnvisitedPath = group.path;
      break;
    }
    records.push(...group.records);
  }

  const scopeFingerprint = walkScopeFingerprint(universe.files.map((f) => f.relPath), universe.omissions);
  const omittedExtra = buildOmittedExtra(universe.omissions, coverage);
  const omitted = omittedExtra["omitted"] as Record<string, unknown> | undefined;

  const readLine = (relPath: string, line: number): string | undefined => {
    const lines = lineCache.get(relPath);
    return typeof lines === "object" && lines !== null ? lines[line - 1] : undefined;
  };

  return {
    records, snapshotCapped, nextUnvisitedPath, totalMatches, totalFiles, walkComplete,
    scopeFingerprint, omitted, readLine,
  };
}

// ---------------------------------------------------------------------------
// The staged request — what one call carries between dispatch and emit
// ---------------------------------------------------------------------------

export interface StagedSearchRequest {
  /** `"open"`: this call is the ORIGINAL find. `"resume"`: a cursor call. */
  mode: "open" | "resume";
  workspaceRoot: string;
  storeKey: string;
  payloadRefSeed: string;
  state: SearchRequestState;
  /** CAS version of the persisted record; 0 while it has never been written. */
  version: number;
  /** On a `"resume"`, the fixed page this call is serving. */
  page?: SearchRequestPage;
  /** Echoed back onto the continuation call. */
  echo: { cwd?: string; lane?: string; taskHandle?: string };
}

export interface OpenSearchRequestInput {
  workspaceRoot: string;
  lane?: string;
  taskHandle?: string;
  epochTokens?: string[];
  /** Canonical v1 arguments minus `cwd`/`lane` — the restart `next`. */
  originalInput: Record<string, unknown>;
  budget?: { bytes?: number; items?: number };
  echo: { cwd?: string; lane?: string; taskHandle?: string };
  scan: SearchScanResult;
}

/** Build (but do NOT persist) the record for an original find that needs paging. */
export function openSearchRequest(input: OpenSearchRequestInput): StagedSearchRequest {
  const id = randomUUID();
  const seed = `${input.workspaceRoot}:${id}`;
  const payloadRef = fetchRequestPayloadRef(seed);
  const now = Date.now();
  const fingerprint = searchRequestFingerprint(input.originalInput);
  const state: SearchRequestState = {
    v: 1,
    family: "search",
    action: "find",
    id,
    workspace_ref: workspaceRefOf(input.workspaceRoot),
    ...(input.lane !== undefined && input.lane !== "" ? { lane: input.lane } : {}),
    ...(input.taskHandle !== undefined ? { task_handle: input.taskHandle } : {}),
    ...(input.epochTokens !== undefined && input.epochTokens.length > 0
      ? { epoch_tokens: [...input.epochTokens] }
      : {}),
    input_fingerprint: fingerprint,
    original_input: input.originalInput,
    scope_fingerprint: input.scan.scopeFingerprint,
    walk_complete: input.scan.walkComplete,
    matches: input.scan.records,
    delivered: 0,
    total_matches: input.scan.totalMatches,
    total_files: input.scan.totalFiles,
    snapshot_capped: input.scan.snapshotCapped,
    ...(input.scan.nextUnvisitedPath !== undefined ? { snapshot_next_path: input.scan.nextUnvisitedPath } : {}),
    ...(input.budget !== undefined ? { budget: input.budget } : {}),
    pages: [],
    created_at_ms: now,
    expires_at_ms: now + FETCH_REQUEST_HANDLE_TTL_MS,
  };
  return {
    mode: "open",
    workspaceRoot: input.workspaceRoot,
    storeKey: payloadRef.toString("base64url"),
    payloadRefSeed: seed,
    state,
    version: 0,
    echo: input.echo,
  };
}

// ---------------------------------------------------------------------------
// References cursor — the SAME store/handle family, `action:"references"`.
//
// NORMATIVE SOURCE: validation appendix §1's "検索cursor" bullet: "既存
// position handleは再利用候補だが、要求・lane・epoch・source revisionの結合を
// 追加する。payloadの旧版を新しいread cursorとして受理しない".
//
// `tools/findReferences.ts` re-walks the whole scope on every call (open AND
// resume) rather than pinning ONE immutable snapshot the way `find` does —
// full-recall reference lookup has no `MAX_SEARCH_SNAPSHOT_RECORDS`-shaped
// cap to page inside of, and the byte-fit/`member_sweep` gating already lives
// entirely in that file. So a references request commits no `matches`/`pages`
// here (`matches:[]`, `pages:[]` — genuinely unused, never read back for
// paging) and instead carries only what BINDING validation needs: the
// original scoping input and `resume_position` (the one file whose revision
// a resume actually depends on). This is deliberately a LIGHTER record than
// `find`'s, not a partial implementation of it — see this module's header
// for why a second, parallel store was rejected for the same reason a
// snapshot is unneeded here.
// ---------------------------------------------------------------------------

/**
 * finding 14: a SHORTER TTL than `FETCH_REQUEST_HANDLE_TTL_MS` (1 h), because
 * `mintReferencesCursorToken` mints a FRESH record on EVERY page — never
 * reusing or mutating the one a resume resolved (see that function's own doc
 * comment for why: reusing one in place used to break "resend = same page").
 * A long references chain therefore churns through one record per page, and
 * every record but the LAST of a chain is abandoned (superseded) the instant
 * its own next page mints its successor — there is no reason for an already-
 * superseded record to occupy a shared-store row for a full hour. 30 min is
 * ample for the ordinary "read a page, act on it" cadence this exists for,
 * while shrinking how long an abandoned mid-chain record can compete with
 * live `read-request`/`search-request`/task state for `RECORD_CAP` (2048)
 * before its own expiry — rather than only the oldest-`updatedAtMs`-first
 * eviction sweep — reclaims it.
 */
export const REFERENCES_CURSOR_TTL_MS = 30 * 60 * 1000;

export interface OpenReferencesCursorRequestInput {
  workspaceRoot: string;
  lane?: string;
  taskHandle?: string;
  /** `{symbol, path?, lang?}` — the scoping the resume must not silently change. */
  originalInput: Record<string, unknown>;
  budget?: { bytes?: number; items?: number };
  echo: { cwd?: string; lane?: string; taskHandle?: string };
  scopeFingerprint: string;
  walkComplete: boolean;
  totalMatches: number;
  totalFiles: number;
  resumePosition: { path: string; line: number; sha: string };
}

/** Build (but do NOT persist) a fresh references-cursor record. Mirrors `openSearchRequest`'s shape for the parts references shares with find. */
export function openReferencesCursorRequest(input: OpenReferencesCursorRequestInput): StagedSearchRequest {
  const id = randomUUID();
  const seed = `${input.workspaceRoot}:${id}`;
  const payloadRef = fetchRequestPayloadRef(seed);
  const now = Date.now();
  const fingerprint = searchRequestFingerprint(input.originalInput);
  const state: SearchRequestState = {
    v: 1,
    family: "search",
    action: "references",
    id,
    workspace_ref: workspaceRefOf(input.workspaceRoot),
    ...(input.lane !== undefined && input.lane !== "" ? { lane: input.lane } : {}),
    ...(input.taskHandle !== undefined ? { task_handle: input.taskHandle } : {}),
    input_fingerprint: fingerprint,
    original_input: input.originalInput,
    scope_fingerprint: input.scopeFingerprint,
    walk_complete: input.walkComplete,
    matches: [],
    delivered: 0,
    total_matches: input.totalMatches,
    total_files: input.totalFiles,
    snapshot_capped: false,
    ...(input.budget !== undefined ? { budget: input.budget } : {}),
    pages: [],
    created_at_ms: now,
    // finding 14: REFERENCES_CURSOR_TTL_MS, not the shared 1 h — see this
    // constant's own doc comment for the per-page-churn rationale.
    expires_at_ms: now + REFERENCES_CURSOR_TTL_MS,
    resume_position: input.resumePosition,
  };
  return {
    mode: "open",
    workspaceRoot: input.workspaceRoot,
    storeKey: payloadRef.toString("base64url"),
    payloadRefSeed: seed,
    state,
    version: 0,
    echo: input.echo,
  };
}

/**
 * Persist a references-cursor request's CURRENT `state` at its CURRENT
 * `storeKey`/`version` (CAS), updating `staged` in place on success — the
 * single-step twin of `find`'s `fixPage`/`settleSearchRequest` pair. A fresh
 * `openReferencesCursorRequest` result commits its FIRST version this way;
 * resuming an existing record (`stagedFromResolution`, `state.resume_position`
 * overwritten with the new position) commits its NEXT version the same way —
 * one function either way, because references has no page list to fix.
 */
export function persistReferencesCursorRequest(staged: StagedSearchRequest): StagedSearchRequest | undefined {
  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
    const written = persistOnce(staged.workspaceRoot, staged.storeKey, staged.state, staged.version);
    if (written.ok) {
      staged.version = written.version;
      return staged;
    }
    if (written.reason === "unavailable" || written.live === undefined) return undefined;
    // A references record's OWN payload is its `resume_position`, which THIS
    // call is authoritative for; everything else is rebased onto the live
    // record so a concurrent writer's page/delivered progress is not lost.
    const position = staged.state.resume_position;
    staged.state = {
      ...rebaseOnLive(staged.state, written.live.state),
      ...(position !== undefined ? { resume_position: position } : {}),
    };
    staged.version = written.live.version;
  }
  return undefined;
}

/**
 * `resolveSearchCursor` plus the ONE extra check references needs: the
 * resolved record must actually have been opened BY `references`, and must
 * carry the `resume_position` this action depends on (a `find` record — or,
 * in principle, a malformed store record missing it — resolves fine as a
 * SEARCH-REQUEST handle but is not a valid REFERENCES cursor). Both failure
 * shapes fold into the same generic `"wrong-action"`/`"unknown"` reasons
 * rather than a bespoke references-only error union, so the caller's
 * existing `SearchCursorFailure` switch stays exhaustive.
 */
export function resolveReferencesCursor(
  token: string,
  workspaceRoot: string,
  binding: { lane?: string; taskHandle?: string },
): SearchCursorResolution {
  const resolved = resolveSearchCursor(token, workspaceRoot, binding);
  if (!resolved.ok) return resolved;
  if (resolved.state.action !== "references") {
    return { ok: false, reason: "wrong-action", detail: "cursor was not opened for search_files action=references" };
  }
  if (resolved.state.resume_position === undefined) {
    return { ok: false, reason: "unknown", detail: "stored request has no resume position" };
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// Cursor resolution
// ---------------------------------------------------------------------------

export type SearchCursorFailure =
  | "invalid"
  | "wrong-purpose"
  | "wrong-workspace"
  | "wrong-lane"
  | "wrong-task"
  | "wrong-action"
  | "expired"
  | "stale"
  | "unknown";

export type SearchCursorResolution =
  | { ok: true; state: SearchRequestState; version: number; storeKey: string; cursorVersion: number }
  | { ok: false; reason: SearchCursorFailure; detail?: string };

function asSearchRequestState(data: Record<string, unknown>): SearchRequestState | undefined {
  if (data["v"] !== 1 || data["family"] !== "search") return undefined;
  if (typeof data["id"] !== "string" || typeof data["input_fingerprint"] !== "string") return undefined;
  if (!Array.isArray(data["matches"]) || !Array.isArray(data["pages"])) return undefined;
  return data as unknown as SearchRequestState;
}

export function resolveSearchCursor(
  token: string,
  workspaceRoot: string,
  binding: { lane?: string; taskHandle?: string },
): SearchCursorResolution {
  const resolved = resolveFetchRequestHandle(token, workspaceRoot, "search-request");
  if (!resolved.ok) {
    const reason: SearchCursorFailure = resolved.outcome === "wrong-subject" || resolved.outcome === "state-conflict"
      ? "invalid"
      : resolved.outcome === "store-unavailable"
        ? "unknown"
        : resolved.outcome;
    return { ok: false, reason, ...(resolved.detail !== undefined ? { detail: resolved.detail } : {}) };
  }
  const state = asSearchRequestState(resolved.record.data);
  if (state === undefined) return { ok: false, reason: "unknown", detail: "stored request state is unreadable" };
  if (Date.now() >= state.expires_at_ms) return { ok: false, reason: "expired", detail: "request lifetime elapsed" };
  if (state.workspace_ref !== workspaceRefOf(workspaceRoot)) {
    return { ok: false, reason: "wrong-workspace", detail: "cursor belongs to another workspace" };
  }
  const laneNow = binding.lane ?? "";
  const laneThen = state.lane ?? "";
  if (laneNow !== laneThen) return { ok: false, reason: "wrong-lane", detail: "cursor belongs to another lane" };
  if ((binding.taskHandle ?? "") !== (state.task_handle ?? "")) {
    return { ok: false, reason: "wrong-task", detail: "cursor belongs to another task handle" };
  }
  return {
    ok: true,
    state,
    version: resolved.record.version,
    storeKey: resolved.payloadRef,
    cursorVersion: resolved.stateVersion,
  };
}

export function stagedFromResolution(
  workspaceRoot: string,
  resolution: { state: SearchRequestState; version: number; storeKey: string },
  echo: { cwd?: string; lane?: string; taskHandle?: string },
): StagedSearchRequest {
  return {
    mode: "resume",
    workspaceRoot,
    storeKey: resolution.storeKey,
    payloadRefSeed: `${workspaceRoot}:${resolution.state.id}`,
    state: resolution.state,
    version: resolution.version,
    echo,
  };
}

// ---------------------------------------------------------------------------
// Page selection — pure algebra over the immutable snapshot
// ---------------------------------------------------------------------------

/**
 * Estimated wire length of one `tlh_sreq_v1_` cursor token: a 61-byte header
 * + 16-byte MAC + a 64-hex-char lane/task/fingerprint binding `aad`,
 * base64url'd (`ceil(141*4/3)` = 188 chars), behind the 12-char prefix — see
 * `state/handleCodec.ts`'s own size accounting. Used only to build a
 * REALISTIC placeholder for the trial measurement below; the real token
 * (minted only once the page is chosen) is the same length to the byte.
 */
export const SEARCH_CURSOR_TOKEN_BYTES_ESTIMATE = 200;

/**
 * Small safety margin added on top of the exact trial measurement below —
 * covers `total_files`/`total_matches` growing an extra decimal digit and an
 * occasional `omitted`/`more_lines` riding along on the SAME response this
 * reserve is computed for. Deliberately small: the trial measurement below is
 * already exact for every other field, unlike a hand-additive estimate.
 */
const SEARCH_PAGE_ENVELOPE_SAFETY_MARGIN_BYTES = 96;

/**
 * Bytes reserved for everything a `search.matches` `find` page carries BESIDES
 * its `files[]`: the `{v,kind,matches:{form,query,total_files,total_matches,
 * literal},limit:{cause,next:{tool:"search_files",arguments:{…}}}}` envelope,
 * measured EXACTLY (mirroring `findText.ts`'s own `fitFilesToCap`'s
 * trial-JSON approach) rather than estimated additively — an additive
 * estimate double-counts the fixed and per-field costs and can alone exceed a
 * caller's declared budget before a single match line is considered (see the
 * design's own worked example, `budget:{bytes:900}`, which fits several lines
 * once this reserve is measured against the REAL structure).
 *
 * The cursor call re-sends the FULL original `queries`/`scope` (design
 * §5.2/§6.1: "search_files は既存cursorを使い、query等の既存必要入力を含む完全
 * なnextをサーバーが作る"), which is why this is larger than read's ~256 B
 * bare-cursor reserve — but it is measured, not guessed, using a
 * `SEARCH_CURSOR_TOKEN_BYTES_ESTIMATE`-length placeholder cursor (the real
 * token is the same length to the byte, so this is exact, not approximate).
 *
 * UNDER-reserving costs a turn (the generic wire ladder sheds the page this
 * module already fit, and `settleSearchRequest` recomputes `delivered` from
 * whatever survives — never a correctness loss, see this file's header).
 * OVER-reserving only makes a page one line shorter than it could be; the
 * small safety margin above stays on that side.
 */
export function searchPageEnvelopeReserve(input: {
  queries: readonly string[];
  path?: string;
  lang?: string;
  cwd?: string;
  lane?: string;
  budgetBytes?: number;
}): number {
  const args: Record<string, unknown> = { action: "find", queries: [...input.queries] };
  const scope: Record<string, unknown> = {};
  if (input.path !== undefined) scope["path"] = input.path;
  if (input.lang !== undefined) scope["lang"] = input.lang;
  if (Object.keys(scope).length > 0) args["scope"] = scope;
  if (input.budgetBytes !== undefined) args["budget"] = { bytes: input.budgetBytes };
  args["cursor"] = "x".repeat(SEARCH_CURSOR_TOKEN_BYTES_ESTIMATE);
  if (input.cwd !== undefined) args["cwd"] = input.cwd;
  if (input.lane !== undefined) args["lane"] = input.lane;

  const envelope = {
    v: 1,
    kind: "search.matches",
    matches: {
      form: "find",
      query: input.queries.join(" OR "),
      files: [] as unknown[],
      total_files: 0,
      total_matches: 0,
      literal: true,
    },
    limit: { cause: "wire", next: { tool: "search_files", arguments: args } },
  };
  return Buffer.byteLength(JSON.stringify(envelope), "utf8") + SEARCH_PAGE_ENVELOPE_SAFETY_MARGIN_BYTES;
}

export interface ChosenSearchPage {
  /** Inclusive start index into `state.matches` (== `state.delivered` at choice time). */
  start: number;
  /** Exclusive end index into `state.matches`. */
  end: number;
  files: FindFileGroup[];
}

export type SearchPageChoice =
  | { ok: true; page: ChosenSearchPage }
  | { ok: false; reason: "budget-below-minimum"; requiredMinBytes: number }
  | { ok: false; reason: "complete" };

/**
 * Choose the next page GREEDILY, on whole `(path,line)` groups, under
 * `budgetBytes - reserve`. Never splits a group (§6.1: "同じ行の複数一致…を
 * 区別する" — the wire's one `snippets[]` entry per line cannot represent half
 * a group anyway). `lineTextOf` returns the CURRENT raw line text for a
 * `(path,line)`; by the time this runs the caller has already verified every
 * referenced file's sha is unchanged (a mismatch is `cursor-stale`, decided
 * BEFORE paging — see the server dispatch call site), so `undefined` here is
 * an exceptional condition and stops the page rather than silently skipping
 * (skipping would break the prefix invariant `delivered` depends on).
 *
 * PER-FILE CAP, EVEN UNDER A GENEROUS BYTE BUDGET. `findText.ts`'s
 * `capFileGroup` bounds any ONE file's preview to `MAX_LINES_PER_FILE`
 * unconditionally — "applied before any response-wide byte fitting" — and
 * this module only ever runs for a request that ALREADY needed that cap
 * exceeded (`server.ts`'s `findWouldHaveEscalated`), so a page here mirrors
 * the same bound: once the file CURRENTLY being accumulated would exceed
 * `MAX_LINES_PER_FILE`, the page stops — never silently expanding to show a
 * whole 500-line file in one response merely because the caller declared a
 * large budget. Snapshot order is path-major, so every one file's groups are
 * contiguous; stopping (rather than skipping ahead to the next file) is what
 * keeps `end` a clean prefix boundary — the next page picks up this same
 * file's remaining lines first, then moves on, exactly as the design
 * describes for a multi-file request.
 */
export function chooseSearchPage(
  state: SearchRequestState,
  lineTextOf: (path: string, line: number) => string | undefined,
  budgetBytes: number,
  reserve: number,
  itemsBudget?: number,
): SearchPageChoice {
  if (state.delivered >= state.matches.length) return { ok: false, reason: "complete" };
  const groups = groupRecordsByLine(state.matches.slice(state.delivered));
  const room = budgetBytes - reserve;

  const files: FindFileGroup[] = [];
  const byPath = new Map<string, FindFileGroup>();
  let used = 0;
  let consumedRecords = 0;
  let firstGroupBytes: number | undefined;

  for (const group of groups) {
    if (itemsBudget !== undefined && consumedRecords + group.records.length > itemsBudget) break;
    const existing = byPath.get(group.path);
    if (existing !== undefined && existing.lines.length >= MAX_LINES_PER_FILE) break;
    const text = lineTextOf(group.path, group.line);
    if (text === undefined) break;
    let anchor: number | undefined;
    for (const record of group.records) {
      if (anchor === undefined || record.column - 1 < anchor) anchor = record.column - 1;
    }
    const snippet = trimMatchText(text, anchor);
    const lineCost = Buffer.byteLength(JSON.stringify(group.line), "utf8")
      + Buffer.byteLength(JSON.stringify(snippet), "utf8")
      + 4;
    const fileCost = existing === undefined ? Buffer.byteLength(JSON.stringify(group.path), "utf8") + 40 : 0;
    const cost = lineCost + fileCost;
    if (firstGroupBytes === undefined) firstGroupBytes = cost;
    if (used + cost > room) break;
    used += cost;
    if (existing === undefined) {
      const created: FindFileGroup = { path: group.path, lines: [group.line], snippets: [snippet] };
      byPath.set(group.path, created);
      files.push(created);
    } else {
      existing.lines.push(group.line);
      (existing.snippets ??= []).push(snippet);
    }
    consumedRecords += group.records.length;
  }

  if (files.length === 0) {
    return { ok: false, reason: "budget-below-minimum", requiredMinBytes: reserve + (firstGroupBytes ?? 0) };
  }
  return { ok: true, page: { start: state.delivered, end: state.delivered + consumedRecords, files } };
}

/**
 * Rebuild a page's `files[]` from an ALREADY-FIXED `{start,end}` boundary —
 * the resend path. §5.2: a fixed page's boundary never moves regardless of a
 * resend's declared budget, so this ignores budget entirely and simply
 * re-renders the SAME slice of `state.matches` against CURRENT (sha-verified
 * by the caller before this runs) line text.
 */
export function renderPageFiles(
  state: SearchRequestState,
  page: { start: number; end: number },
  lineTextOf: (path: string, line: number) => string | undefined,
): FindFileGroup[] {
  const groups = groupRecordsByLine(state.matches.slice(page.start, page.end));
  const files: FindFileGroup[] = [];
  const byPath = new Map<string, FindFileGroup>();
  for (const group of groups) {
    const text = lineTextOf(group.path, group.line);
    if (text === undefined) continue;
    let anchor: number | undefined;
    for (const record of group.records) {
      if (anchor === undefined || record.column - 1 < anchor) anchor = record.column - 1;
    }
    const snippet = trimMatchText(text, anchor);
    const existing = byPath.get(group.path);
    if (existing === undefined) {
      const created: FindFileGroup = { path: group.path, lines: [group.line], snippets: [snippet] };
      byPath.set(group.path, created);
      files.push(created);
    } else {
      existing.lines.push(group.line);
      (existing.snippets ??= []).push(snippet);
    }
  }
  return files;
}

/**
 * Honest per-file `more_lines` disclosure (`FindFileGroup.more_lines`'s
 * existing wire contract — "count of this file's TRUE matched lines beyond
 * what lines/snippets show"), computed against the FULL snapshot rather than
 * just this page: a file's records are contiguous in `state.matches` (the
 * stable sort is path-major), so "how many more of this file's lines remain"
 * is exactly the distinct-line count of that path at or after `endIndex`.
 */
export function withMoreLines(state: SearchRequestState, files: readonly FindFileGroup[], endIndex: number): FindFileGroup[] {
  if (endIndex >= state.matches.length) return [...files];
  const remainingByPath = new Map<string, Set<number>>();
  for (let i = endIndex; i < state.matches.length; i += 1) {
    const record = state.matches[i]!;
    let lines = remainingByPath.get(record.path);
    if (lines === undefined) {
      lines = new Set();
      remainingByPath.set(record.path, lines);
    }
    lines.add(record.line);
  }
  return files.map((file) => {
    const remaining = remainingByPath.get(file.path)?.size ?? 0;
    return remaining > 0 ? { ...file, more_lines: remaining } : file;
  });
}

/**
 * Record a page's boundary ONCE, under CAS (§5.2's page-fixing rule, shared
 * with read). A resend whose `cursorVersion` already names a page returns
 * that page unchanged, whatever budget the resend declares.
 */
export type FixSearchPageOutcome =
  | { ok: true; page: SearchRequestPage; reused: boolean }
  | { ok: false; reason: "unavailable" | "state-conflict" };

export function fixPage(
  staged: StagedSearchRequest,
  cursorVersion: number,
  choice: { start: number; end: number },
): FixSearchPageOutcome {
  const existing = staged.state.pages.find((page) => page.cursor_state_version === cursorVersion);
  if (existing !== undefined) return { ok: true, page: existing, reused: true };
  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
    const page: SearchRequestPage = {
      index: staged.state.pages.length + 1,
      start: choice.start,
      end: choice.end,
      fixed_at_ms: Date.now(),
      cursor_state_version: cursorVersion,
    };
    const nextState: SearchRequestState = { ...staged.state, pages: [...staged.state.pages, page] };
    const written = persistOnce(staged.workspaceRoot, staged.storeKey, nextState, staged.version);
    if (written.ok) {
      staged.state = nextState;
      staged.version = written.version;
      return { ok: true, page, reused: false };
    }
    if (written.reason === "unavailable" || written.live === undefined) {
      return { ok: false, reason: written.reason === "unavailable" ? "unavailable" : "state-conflict" };
    }
    // THE OTHER WRITER'S RECORD IS NOW THE TRUTH — adopt it, then look for the
    // page it may already have fixed for this very cursor version. Re-issuing
    // this call's own slice at the conflicting version (what this used to do)
    // overwrote that page and let two concurrent calls page differently.
    staged.state = rebaseOnLive(staged.state, written.live.state);
    staged.version = written.live.version;
    const fixedByOther = staged.state.pages.find((p) => p.cursor_state_version === cursorVersion);
    if (fixedByOther !== undefined) return { ok: true, page: fixedByOther, reused: true };
  }
  return { ok: false, reason: "state-conflict" };
}

// ---------------------------------------------------------------------------
// Settle + mint
// ---------------------------------------------------------------------------

/**
 * The read side's `MAX_CAS_ATTEMPTS` contract, mirrored (see
 * `state/readRequestStore.ts` for the rationale in full).
 */
const MAX_CAS_ATTEMPTS = 3;

type PersistAttempt =
  | { ok: true; version: number }
  | { ok: false; reason: "unavailable"; live?: undefined }
  | { ok: false; reason: "conflict"; live?: { state: SearchRequestState; version: number } };

/**
 * ONE CAS write attempt, returning the LIVE record on a conflict.
 *
 * Never blind-retries at the conflicting version: that re-issued this call's
 * own stale state over whatever the other writer had just committed — a fixed
 * page included — which is exactly the lost update the caller's rebase loop
 * exists to avoid. `put` decided the conflict inside the store's writer lock,
 * after its resync pulled in every other process's committed writes, so the
 * record read back here is the true current one.
 */
function persistOnce(
  workspaceRoot: string,
  key: string,
  state: SearchRequestState,
  expectedVersion: number,
): PersistAttempt {
  const store = stateStoreFor(workspaceRoot);
  if (store === undefined || !store.available) return { ok: false, reason: "unavailable" };
  const put = store.put({
    key,
    purpose: "search-request",
    data: state as unknown as Record<string, unknown>,
    ttlMs: Math.max(1000, state.expires_at_ms - Date.now()),
    expectedVersion,
  });
  if (put.ok) return { ok: true, version: put.record.version };
  if (put.outcome !== "state-conflict") return { ok: false, reason: "unavailable" };
  const record = store.get(key);
  if (record === undefined || record.purpose !== "search-request") return { ok: false, reason: "conflict" };
  const live = asSearchRequestState(record.data);
  return live === undefined
    ? { ok: false, reason: "conflict" }
    : { ok: false, reason: "conflict", live: { state: live, version: record.version } };
}

/**
 * Rebase THIS call's in-flight record onto the one another writer committed:
 * the live record wins on `delivered` (a monotonic prefix — never rewound by
 * a rebase) and on its own pages; this call contributes only pages the live
 * record does not have, and the budget it may have overridden (§5.2).
 */
function rebaseOnLive(mine: SearchRequestState, live: SearchRequestState): SearchRequestState {
  const pages: SearchRequestPage[] = live.pages.map((page) => ({ ...page }));
  const byCursor = new Set(pages.map((page) => page.cursor_state_version));
  for (const page of mine.pages) {
    if (byCursor.has(page.cursor_state_version)) continue;
    pages.push({ ...page, index: pages.length + 1 });
    byCursor.add(page.cursor_state_version);
  }
  const rebased: SearchRequestState = {
    ...live,
    pages,
    delivered: Math.max(live.delivered, mine.delivered),
  };
  if (mine.budget !== undefined) rebased.budget = mine.budget;
  else delete rebased.budget;
  return rebased;
}

/**
 * Settle `delivered` from the FINALIZED payload (design §3.2: "確定した応答
 * から一度だけ記帳"; task instruction: "`delivered` advances only when a page
 * actually ships (settle from the finalized payload, like R2's emit-tail
 * settle)"). `shippedLineKeys` is the set of `"${path}:${line}"` strings the
 * FINAL wire body's `matches.files[]` actually carries a snippet for (built
 * by `protocol/searchRequestContinuation.ts` from the post-shed payload).
 *
 * `delivered` only ever advances as a PREFIX: starting at the fixed page's own
 * `start`, count how many of `state.matches[start..)` were shipped, in order,
 * stopping at the first gap. This is what keeps a wire-ladder cut (which can
 * only drop from the END of an already-budgeted page — see this module's
 * header) from ever producing a delivered set that is not a clean prefix.
 */
/**
 * finding 11: `settleSearchRequest`'s `delivered` is a monotonic
 * (`Math.max`) prefix counter by design (§6.1's own "the model deliberately
 * stays a plain PREFIX counter" — a resend must never see D re-widen). That
 * is exactly right across DIFFERENT calls, but wrong within the SAME call's
 * own post-rewrite budget-safety retry (`emit.ts`): a first settle can
 * advance `delivered` past a group that a SUBSEQUENT shrink (still within
 * this same response) then removes from the wire, and `Math.max` would keep
 * the now-stale, too-large value forever — silently skipping that group on
 * every future page, the exact class of defect this whole design exists to
 * close. Rewinds the IN-MEMORY `staged.state` only; the retry's own
 * `settleSearchRequest` call re-persists the corrected value under the SAME
 * CAS version right after. Never used outside that one retry path.
 */
export function rewindSearchRequestDelivered(staged: StagedSearchRequest, value: number): void {
  if (value < staged.state.delivered) staged.state = { ...staged.state, delivered: value };
}

export function settleSearchRequest(
  staged: StagedSearchRequest,
  fixedPage: { start: number; end: number },
  shippedLineKeys: ReadonlySet<string>,
): SearchRequestState | undefined {
  let shipped = fixedPage.start;
  while (shipped < fixedPage.end) {
    const record = staged.state.matches[shipped];
    if (record === undefined) break;
    if (!shippedLineKeys.has(`${record.path}:${record.line}`)) break;
    // Advance past every record of THIS (path,line) — a group ships whole.
    let end = shipped + 1;
    while (
      end < fixedPage.end
      && staged.state.matches[end] !== undefined
      && staged.state.matches[end]!.path === record.path
      && staged.state.matches[end]!.line === record.line
    ) {
      end += 1;
    }
    shipped = end;
  }
  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
    const delivered = Math.max(staged.state.delivered, shipped);
    if (delivered === staged.state.delivered) return staged.state;
    const nextState: SearchRequestState = { ...staged.state, delivered };
    const written = persistOnce(staged.workspaceRoot, staged.storeKey, nextState, staged.version);
    if (written.ok) {
      staged.state = nextState;
      staged.version = written.version;
      return nextState;
    }
    if (written.reason === "unavailable" || written.live === undefined) return undefined;
    staged.state = rebaseOnLive(staged.state, written.live.state);
    staged.version = written.live.version;
  }
  return undefined;
}

/** True iff every stored match has shipped and the snapshot was not capped short of the true total. */
export function searchRequestComplete(state: SearchRequestState): boolean {
  return state.delivered >= state.matches.length && !state.snapshot_capped;
}

/** True iff the snapshot's own cap was hit AND every stored (capped) match has shipped — the honest dead end. */
export function searchRequestCappedExhausted(state: SearchRequestState): boolean {
  return state.delivered >= state.matches.length && state.snapshot_capped;
}

export function mintSearchCursor(staged: StagedSearchRequest): string | undefined {
  return mintFetchRequestHandle({
    workspaceRoot: staged.workspaceRoot,
    purpose: "search-request",
    payloadRef: fetchRequestPayloadRef(staged.payloadRefSeed),
    stateVersion: staged.version,
    bindingDigest: searchRequestBinding({
      ...(staged.state.lane !== undefined ? { lane: staged.state.lane } : {}),
      ...(staged.state.task_handle !== undefined ? { taskHandle: staged.state.task_handle } : {}),
      fingerprint: staged.state.input_fingerprint,
    }),
  });
}
