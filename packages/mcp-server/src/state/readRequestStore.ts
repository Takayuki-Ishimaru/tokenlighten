// ---------------------------------------------------------------------------
// readRequestStore.ts — DESIGN-v0.15 §5 (R2): ONE READ REQUEST'S Q, D AND PAGES.
//
// NORMATIVE SOURCE: DESIGN-v0.15-exploration-continuation-reliability.md §3.1
// (the three separated states), §3.3 (the four invariants), §5.1 (Q/D and the
// completion predicate), §5.2 (wire shape, lifetime, page fixing, staleness),
// §5.3 (budget floor without a same-`next` loop); Wave-1 contract §2.2.
//
// -------------------------------- THE MODEL ---------------------------------
//
//   D = Q - (C ∪ S)
//   complete  <=>  D = ∅
//   next page's windows ⊆ D
//
// Q  the ORIGINAL request's windows, per target, in FILE line coordinates.
// C  the caller's valid prior coverage: the settled served-range ledger for
//    this (workspace, lane, path, sha). Read AFTER `settleServedCallBookings`,
//    so it already includes S — which is why one subtraction computes both.
// S  what this request itself delivered.
//
// A request whose ORIGINAL call carried `task.force_serve:true` starts with
// C = ∅ (§5.1). That is implemented by recording the ledger's coverage at
// OPEN time (`ledger_baseline`) and subtracting only the NEW coverage
// (`ledgerNow - baseline`) — i.e. exactly the windows this request delivered —
// rather than by a boolean the settle path would have to interpret.
//
// ------------------------ WHY NOT A NEW STORE -------------------------------
//
// §10 item 3 is explicit: "新しい独立ストアを作らない". Records live in the
// existing per-workspace `state/stateStore.ts` under the new `read-request`
// purpose, are addressed by a `handleCodec` token with its own prefix and MAC,
// use the store's own `expectedVersion` CAS for page fixing and settling, and
// inherit its TTL/capacity/corruption policy. Restart durability therefore
// falls out of the store rather than being re-implemented here.
//
// ---------------------------- ONE PAGE, ONE PATH ----------------------------
//
// `ReadRequestPage.windows` is typed as a multi-path list because the design's
// Q is multi-target. THIS implementation fills a page from ONE target at a
// time (the first with a non-empty D). That never loses a target — the next
// page picks up the next one, D still shrinks strictly, and the union of the
// delivered pages still equals Q — and it keeps the page servable through the
// existing single-file `mode=slice`/`ranges[]` serve path rather than through a
// new multi-file assembler. Recorded as a Wave-1 deviation.
// ---------------------------------------------------------------------------

import { createHash, randomUUID } from "node:crypto";

import type {
  ContentRepresentation,
  LineWindow,
  ReadRequestPage,
  ReadRequestState,
  ReadRequestTargetState,
} from "@tokenlighten/types";

import { workspaceRefOf } from "./handleCodec.js";
import {
  FETCH_REQUEST_HANDLE_TTL_MS,
  fetchRequestPayloadRef,
  mintFetchRequestHandle,
  resolveFetchRequestHandle,
} from "./stateHandles.js";
import { getSession } from "./session.js";
import { stateStoreFor } from "./stateStore.js";

// ---------------------------------------------------------------------------
// Window algebra — the whole correctness surface, kept pure and testable
// ---------------------------------------------------------------------------

/** Sort, clamp to `>= 1`, drop empties, and merge touching/overlapping spans. */
export function normalizeWindows(windows: readonly LineWindow[]): LineWindow[] {
  const clean = windows
    .map((w) => ({ start: Math.max(1, Math.floor(w.start)), end: Math.floor(w.end) }))
    .filter((w) => Number.isFinite(w.start) && Number.isFinite(w.end) && w.end >= w.start)
    .sort((a, b) => (a.start - b.start) || (a.end - b.end));
  const merged: LineWindow[] = [];
  for (const w of clean) {
    const last = merged[merged.length - 1];
    // `last.end + 1 >= w.start` merges ADJACENT windows too: 1-15 and 16-29 are
    // one contiguous 1-29 remainder, and reporting them separately would make
    // `remaining` describe the shed HISTORY rather than the outstanding work.
    if (last !== undefined && last.end + 1 >= w.start) {
      if (w.end > last.end) last.end = w.end;
      continue;
    }
    merged.push({ ...w });
  }
  return merged;
}

/** `a - b`, both normalized on the way in and out. Never returns empty spans. */
export function subtractWindows(a: readonly LineWindow[], b: readonly LineWindow[]): LineWindow[] {
  const minuend = normalizeWindows(a);
  const subtrahend = normalizeWindows(b);
  const out: LineWindow[] = [];
  for (const span of minuend) {
    let cursor = span.start;
    for (const cut of subtrahend) {
      if (cut.end < cursor) continue;
      if (cut.start > span.end) break;
      if (cut.start > cursor) out.push({ start: cursor, end: Math.min(span.end, cut.start - 1) });
      cursor = Math.max(cursor, cut.end + 1);
      if (cursor > span.end) break;
    }
    if (cursor <= span.end) out.push({ start: cursor, end: span.end });
  }
  return normalizeWindows(out);
}

/**
 * Interval intersection — `subtractWindows`'s complement, added for finding-12
 * (S must be taken from what a call actually shipped, never a fixed page's
 * boundary wholesale — see `settledTargets`'s "CURRENT PAGE" branch).
 */
export function intersectWindows(a: readonly LineWindow[], b: readonly LineWindow[]): LineWindow[] {
  const left = normalizeWindows(a);
  const right = normalizeWindows(b);
  const out: LineWindow[] = [];
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    const start = Math.max(left[i]!.start, right[j]!.start);
    const end = Math.min(left[i]!.end, right[j]!.end);
    if (start <= end) out.push({ start, end });
    if (left[i]!.end < right[j]!.end) i += 1;
    else j += 1;
  }
  return normalizeWindows(out);
}

/** Total lines covered by a normalized window list. */
export function windowLineCount(windows: readonly LineWindow[]): number {
  return normalizeWindows(windows).reduce((sum, w) => sum + (w.end - w.start + 1), 0);
}

/** `"12-48"` / `"L12-L48"` / `"7"` -> a window. Fail-closed on anything else. */
export function parseWindow(raw: unknown): LineWindow | undefined {
  if (typeof raw !== "string") return undefined;
  const one = raw.trim().match(/^L?(\d+)$/iu);
  if (one !== null) {
    const line = Number.parseInt(one[1]!, 10);
    return line >= 1 ? { start: line, end: line } : undefined;
  }
  const span = raw.trim().match(/^L?(\d+)\s*-\s*L?(\d+)$/iu);
  if (span === null) return undefined;
  const start = Number.parseInt(span[1]!, 10);
  const end = Number.parseInt(span[2]!, 10);
  if (start < 1 || end < start) return undefined;
  return { start, end };
}

/** The wire's `"start-end"` dialect. */
export function windowStrings(windows: readonly LineWindow[]): string[] {
  return normalizeWindows(windows).map((w) => `${w.start}-${w.end}`);
}

export function parseWindows(raw: readonly unknown[]): LineWindow[] {
  const out: LineWindow[] = [];
  for (const value of raw) {
    const window = parseWindow(value);
    if (window !== undefined) out.push(window);
  }
  return normalizeWindows(out);
}

// ---------------------------------------------------------------------------
// Ledger view — C, read from the ONE served-range ledger, never re-derived
// ---------------------------------------------------------------------------

/**
 * The (workspace, lane) ledger's coverage of `relPath` AT `fileSha`.
 *
 * A sha mismatch returns `[]` rather than the stale spans: §3.2 forbids
 * counting a window served against a different revision as evidence, and
 * `ServedRangeLedgerState` keeps exactly one revision per path.
 */
export function ledgerCoverage(workspaceRoot: string, relPath: string, fileSha: string): LineWindow[] {
  const state = getSession(workspaceRoot).servedRangeLedger.get(relPath);
  if (state === undefined || state.fileSha !== fileSha) return [];
  return normalizeWindows(state.ranges.map(([start, end]) => ({ start, end })));
}

// ---------------------------------------------------------------------------
// Identity and binding
// ---------------------------------------------------------------------------

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Stable JSON: object keys sorted, array order preserved. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(record[k])}`).join(",")}}`;
}

/**
 * The canonical original input's fingerprint, WITHOUT `budget` and WITHOUT
 * `task.force_serve`.
 *
 * Those two are the exact overrides §5.2 permits a continuation call to change
 * ("継続時に許す上書きは広告されたbudget調整とforce_serve等の再送指定に限り"),
 * so folding them in would make an otherwise identical re-issue a different
 * request. `cwd` and `lane` are excluded because they are call-scoping, not
 * request content, and are bound separately (workspace by the MAC, lane by the
 * binding digest below).
 */
export function readRequestFingerprint(originalInput: Record<string, unknown>): string {
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

/**
 * The authenticated `aad`: `sha256(lane | task_handle | input_fingerprint)`.
 *
 * 64 hex characters, well under `MAX_AAD_BYTES`. It is what makes a cursor
 * minted in lane A, or under task handle T, refuse in lane B or under task T'
 * — a binding the store key alone cannot express, because the record is
 * addressed by a random id and a cross-lane caller would otherwise find it.
 */
export function readRequestBinding(input: {
  lane?: string;
  taskHandle?: string;
  fingerprint: string;
}): string {
  return sha256Hex(`${input.lane ?? ""}|${input.taskHandle ?? ""}|${input.fingerprint}`);
}

// ---------------------------------------------------------------------------
// The staged request — what one call carries between dispatch and emit
// ---------------------------------------------------------------------------

export interface StagedReadRequest {
  /** `"open"`: this call is the ORIGINAL fetch. `"resume"`: a cursor call. */
  mode: "open" | "resume";
  workspaceRoot: string;
  /** Store key = the base64url payloadRef the cursor addresses. */
  storeKey: string;
  payloadRefSeed: string;
  state: ReadRequestState;
  /** CAS version of the persisted record; 0 while it has never been written. */
  version: number;
  /** On a `"resume"`, the fixed page this call is serving. */
  page?: ReadRequestPage;
  /** Echoed back onto the continuation call. */
  echo: { cwd?: string; lane?: string; taskHandle?: string };
}

export interface OpenReadRequestInput {
  workspaceRoot: string;
  lane?: string;
  taskHandle?: string;
  epochTokens?: string[];
  /** Canonical v1 arguments minus `cwd`/`lane` — the restart `next`. */
  originalInput: Record<string, unknown>;
  budget?: { bytes?: number; tokens?: number };
  forceServeOrigin: boolean;
  echo: { cwd?: string; lane?: string; taskHandle?: string };
  targets: Array<{
    path: string;
    sha: string;
    totalLines: number;
    representation: ContentRepresentation;
    requested: LineWindow[];
  }>;
}

/**
 * Build (but do NOT persist) the record for an original fetch.
 *
 * Persistence waits for the emit tail, because until the ladder has run and
 * the ledger has settled, D is unknown — and a request whose D turns out to be
 * empty must leave no record and no `next` at all (§3.3, "既読通知の終端").
 */
export function openReadRequest(input: OpenReadRequestInput): StagedReadRequest | undefined {
  if (input.targets.length === 0) return undefined;
  const fingerprint = readRequestFingerprint(input.originalInput);
  const id = randomUUID();
  const seed = `${input.workspaceRoot}:${id}`;
  const payloadRef = fetchRequestPayloadRef(seed);
  const now = Date.now();
  const baseline: Record<string, string[]> = {};
  for (const target of input.targets) {
    baseline[target.path] = windowStrings(ledgerCoverage(input.workspaceRoot, target.path, target.sha));
  }
  const state: ReadRequestState = {
    v: 1,
    family: "read",
    id,
    workspace_ref: workspaceRefOf(input.workspaceRoot),
    ...(input.lane !== undefined && input.lane !== "" ? { lane: input.lane } : {}),
    ...(input.taskHandle !== undefined ? { task_handle: input.taskHandle } : {}),
    ...(input.epochTokens !== undefined && input.epochTokens.length > 0
      ? { epoch_tokens: [...input.epochTokens] }
      : {}),
    input_fingerprint: fingerprint,
    original_input: input.originalInput,
    ...(input.budget !== undefined ? { budget: input.budget } : {}),
    targets: input.targets.map((target) => ({
      path: target.path,
      sha: target.sha,
      total_lines: target.totalLines,
      representation: target.representation,
      requested: normalizeWindows(target.requested),
      remaining: normalizeWindows(target.requested),
    })),
    pages: [],
    created_at_ms: now,
    expires_at_ms: now + FETCH_REQUEST_HANDLE_TTL_MS,
    ledger_baseline: baseline,
    ...(input.forceServeOrigin ? { force_serve_origin: true } : {}),
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
 * Add a further target to an ALREADY-STAGED, NOT YET PERSISTED request
 * (§5.1: "複数targets ... でも同じ定義を使う").
 *
 * A multi-target `content:"full"` batch discovers its targets one file at a
 * time, as the producer loop (`server.ts`'s `mode=full` `paths[]` batch)
 * visits each path and resolves it. Without this, `stageReadRequestForServe`'s
 * "already staged, no-op" guard meant only the FIRST target the loop reached
 * ever entered Q — every other target the caller asked for was silently
 * absent from `state.targets`, so `readRequestComplete` declared the whole
 * request done once that ONE target's D emptied, abandoning the rest with no
 * `limit.next` at all. This makes every target the loop visits, not just the
 * first, part of the SAME request's Q.
 *
 * Idempotent on `path`: a target already present is left untouched, so a
 * producer that visits the same path twice (a retry, or a caller-supplied
 * `targets[]` naming one path more than once) never creates a duplicate Q
 * entry or resets its `remaining`.
 *
 * A no-op once the request has already been persisted (`staged.version > 0`,
 * i.e. `fixPage`/`settleReadRequest` already wrote it) or once it addresses a
 * RESUMED cursor (`staged.mode !== "open"`): appending to either would move a
 * FIXED page boundary or an already-minted request's identity out from under
 * a caller that already holds a cursor for it — exactly the movement §5.2
 * forbids ("継続中に原要求を狭めたり広げたりしない").
 */
export function appendReadRequestTarget(
  staged: StagedReadRequest,
  target: {
    path: string;
    sha: string;
    totalLines: number;
    representation: ContentRepresentation;
    requested: LineWindow[];
  },
): void {
  if (staged.mode !== "open" || staged.version !== 0) return;
  if (staged.state.targets.some((existing) => existing.path === target.path)) return;
  const windows = normalizeWindows(target.requested);
  const entry: ReadRequestTargetState = {
    path: target.path,
    sha: target.sha,
    total_lines: target.totalLines,
    representation: target.representation,
    requested: windows,
    remaining: windows,
  };
  const nextState: ReadRequestState = {
    ...staged.state,
    targets: [...staged.state.targets, entry],
  };
  if (staged.state.force_serve_origin === true) {
    // Same rule `openReadRequest` applies to its own targets: a force_serve
    // origin starts this target's C at ∅ too, recorded as the ledger's
    // coverage of it AT OPEN time so `settledTargets` can subtract only what
    // THIS request later adds.
    nextState.ledger_baseline = {
      ...(staged.state.ledger_baseline ?? {}),
      [target.path]: windowStrings(ledgerCoverage(staged.workspaceRoot, target.path, target.sha)),
    };
  }
  staged.state = nextState;
}

// ---------------------------------------------------------------------------
// Cursor resolution
// ---------------------------------------------------------------------------

export type ReadCursorFailure =
  | "invalid"
  | "wrong-purpose"
  | "wrong-workspace"
  | "wrong-lane"
  | "wrong-task"
  | "expired"
  | "stale"
  | "unknown";

export type ReadCursorResolution =
  | { ok: true; state: ReadRequestState; version: number; storeKey: string; cursorVersion: number }
  | { ok: false; reason: ReadCursorFailure; detail?: string };

/** Runtime shape guard for a stored record read back after a restart. */
function asReadRequestState(data: Record<string, unknown>): ReadRequestState | undefined {
  if (data["v"] !== 1 || data["family"] !== "read") return undefined;
  if (typeof data["id"] !== "string" || typeof data["input_fingerprint"] !== "string") return undefined;
  if (!Array.isArray(data["targets"]) || !Array.isArray(data["pages"])) return undefined;
  return data as unknown as ReadRequestState;
}

export function resolveReadCursor(
  token: string,
  workspaceRoot: string,
  binding: { lane?: string; taskHandle?: string },
): ReadCursorResolution {
  const resolved = resolveFetchRequestHandle(token, workspaceRoot, "read-request");
  if (!resolved.ok) {
    const reason: ReadCursorFailure = resolved.outcome === "wrong-subject" || resolved.outcome === "state-conflict"
      ? "invalid"
      : resolved.outcome === "store-unavailable"
        ? "unknown"
        : resolved.outcome;
    return { ok: false, reason, ...(resolved.detail !== undefined ? { detail: resolved.detail } : {}) };
  }
  const state = asReadRequestState(resolved.record.data);
  if (state === undefined) return { ok: false, reason: "unknown", detail: "stored request state is unreadable" };
  if (Date.now() >= state.expires_at_ms) return { ok: false, reason: "expired", detail: "request lifetime elapsed" };
  if (state.workspace_ref !== workspaceRefOf(workspaceRoot)) {
    return { ok: false, reason: "wrong-workspace", detail: "cursor belongs to another workspace" };
  }
  // LANE AND TASK, PROVEN BY THE MAC. The binding digest was authenticated as
  // the token's `aad`, so recomputing it from THIS call's lane/task and the
  // STORED fingerprint is a cryptographic comparison, not a trust of either
  // side's say-so. Reported separately so the refusal can name which one moved.
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

// ---------------------------------------------------------------------------
// Page fixing
// ---------------------------------------------------------------------------

/**
 * Bytes a `read.text` page costs BESIDES its body — MEASURED, not guessed.
 *
 * The page that ships is
 * `{"v":1,"kind":"read.text","evidence":[{"handle","path","range","body",
 * "remaining"}],"sha","total_lines","limit":{"cause":"wire","omitted",
 * "next":{"tool":"read_file","arguments":{"cwd","cursor"}}}}`, and the cursor
 * token alone is ~200 characters (a 61-byte handle body plus a 64-hex binding
 * `aad` plus the MAC, base64url'd, behind a 12-char prefix).
 *
 * Measured on the design's own fixture (113 lines, `src/statusBar.ts`, a
 * 52-byte `cwd`): 570 B on the opening response and 587 B on a cursor page.
 * 540 + `path` + `cwd` reproduces that within a few bytes and stays slightly
 * above it, which is the direction that matters: UNDER-reserving makes the
 * ladder shed the page the chooser just fixed — still honest, because D is
 * recomputed from what actually shipped, but it costs a turn — while
 * OVER-reserving only makes a page one line shorter than it could be.
 */
export const PAGE_ENVELOPE_RESERVE_BYTES = 540;

export function pageEnvelopeReserve(path: string, cwd?: string): number {
  return PAGE_ENVELOPE_RESERVE_BYTES
    + Buffer.byteLength(path, "utf8")
    + (cwd === undefined ? 0 : Buffer.byteLength(cwd, "utf8"));
}

/**
 * What ONE line of a served body COSTS ON THE WIRE, in UTF-8 bytes.
 *
 * The body is a JSON STRING, so the wire never carries the line's raw bytes:
 * every `"` becomes `\"`, every `\` becomes `\\`, every control character
 * becomes `\n`/`\t`/`\uXXXX`. Measuring `Buffer.byteLength(text)` — as this
 * chooser did — under-counts a line by one byte per quote and per backslash
 * it contains, so a page of quote-heavy source (a TypeScript file full of
 * string literals with escapes, say) was PLANNED to fit a budget it could not
 * fit. The ladder then shed the tail of the very page `choosePage` had just
 * fixed, and those lines were lost.
 *
 * `JSON.stringify(text)` is the escaped form PLUS its two surrounding quote
 * bytes, and those two bytes are exactly what the line's own `\n` separator
 * costs once IT is escaped inside the same JSON string — so the stringified
 * length, unadjusted, is the true per-line wire cost including its separator.
 * (The first line of a body has no preceding separator and the last has no
 * trailing one; charging every line for one separator is off by at most one
 * separator per page, in the safe direction.)
 */
export function wireLineCostBytes(text: string): number {
  return Buffer.byteLength(JSON.stringify(text), "utf8");
}

/** The wire cost of a whole window of `lines`, using `wireLineCostBytes`. */
export function wireWindowsCostBytes(
  lines: readonly string[],
  windows: readonly LineWindow[],
): number {
  let total = 0;
  for (const window of normalizeWindows(windows)) {
    for (let line = window.start; line <= window.end; line += 1) {
      const text = lines[line - 1];
      if (text !== undefined) total += wireLineCostBytes(text);
    }
  }
  return total;
}

export type PageChoice =
  | { ok: true; path: string; windows: LineWindow[] }
  | { ok: false; reason: "budget-below-minimum"; requiredMinBytes: number }
  | { ok: false; reason: "complete" };

/**
 * Choose the next page GREEDILY, on whole lines, under `budgetBytes`.
 *
 * §5.3: "行を途中で切った場合、行全体を配信済みにしない" — a line is either
 * wholly in the page or wholly out, so a page never books a fragment as
 * delivered. A budget that cannot hold the FIRST line plus the envelope is a
 * `budget-below-minimum` refusal naming the floor (§5.3 again: "同じnextを返す
 * ループを作らず、必要下限を示す既存refusal/retry契約で回復する").
 */
export function choosePage(
  state: ReadRequestState,
  fileLines: (path: string) => string[] | undefined,
  budgetBytes: number,
  cwd?: string,
): PageChoice {
  const target = state.targets.find((entry) => entry.remaining.length > 0);
  if (target === undefined) return { ok: false, reason: "complete" };
  const lines = fileLines(target.path);
  if (lines === undefined) return { ok: false, reason: "complete" };
  const reserve = pageEnvelopeReserve(target.path, cwd);
  const room = budgetBytes - reserve;

  const windows: LineWindow[] = [];
  let used = 0;
  let firstLineBytes: number | undefined;
  for (const window of normalizeWindows(target.remaining)) {
    let spanStart: number | undefined;
    let spanEnd = 0;
    for (let line = window.start; line <= window.end; line += 1) {
      const text = lines[line - 1];
      if (text === undefined) break;
      // MEASURED THE WAY THE WIRE MEASURES IT — see `wireLineCostBytes`.
      const cost = wireLineCostBytes(text);
      if (firstLineBytes === undefined) firstLineBytes = cost;
      if (used + cost > room) {
        if (spanStart !== undefined) windows.push({ start: spanStart, end: spanEnd });
        return windows.length === 0
          ? { ok: false, reason: "budget-below-minimum", requiredMinBytes: reserve + (firstLineBytes ?? cost) }
          : { ok: true, path: target.path, windows: normalizeWindows(windows) };
      }
      used += cost;
      if (spanStart === undefined) spanStart = line;
      spanEnd = line;
    }
    if (spanStart !== undefined) windows.push({ start: spanStart, end: spanEnd });
  }
  if (windows.length === 0) {
    return firstLineBytes === undefined
      ? { ok: false, reason: "complete" }
      : { ok: false, reason: "budget-below-minimum", requiredMinBytes: reserve + firstLineBytes };
  }
  return { ok: true, path: target.path, windows: normalizeWindows(windows) };
}

/**
 * The outcome of trying to fix a page — a page boundary is CERTIFIED state,
 * so "could not prove it" is a distinct answer from "here it is".
 *
 * `reused:true` means this call did NOT choose the boundary it is about to
 * serve: it was already fixed (by an earlier call, or — the CAS-conflict case
 * — by a concurrent one), so this call's own budget must still be checked
 * against it exactly as a plain resend's is.
 */
export type FixPageOutcome =
  | { ok: true; page: ReadRequestPage; reused: boolean }
  | { ok: false; reason: "unavailable" | "state-conflict" };

/**
 * Record a page's boundary ONCE, under CAS (§5.2).
 *
 * A resend whose `cursorVersion` already names a page returns that page
 * unchanged, whatever budget the resend declares — that is the whole point of
 * fixing the boundary rather than recomputing it.
 *
 * ON CONFLICT, NEVER OVERWRITE. The previous implementation re-issued the
 * SAME stale state at the conflicting writer's `currentVersion`, which
 * clobbered whatever that writer had just persisted — including a page it had
 * already fixed for THIS cursor version, so two concurrent calls on one
 * cursor could serve two different windows and the record would remember only
 * the loser's. Now a conflict re-reads the live record: a page already fixed
 * for this cursor version is REUSED verbatim (nothing is written), and
 * otherwise this call's state is rebased onto the live one and retried,
 * bounded. An unresolved conflict is a refusal, never a page whose fixation
 * is unknown.
 */
export function fixPage(
  staged: StagedReadRequest,
  cursorVersion: number,
  choice: { path: string; windows: LineWindow[] },
): FixPageOutcome {
  const existing = staged.state.pages.find((page) => page.cursor_state_version === cursorVersion);
  if (existing !== undefined) return { ok: true, page: existing, reused: true };
  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
    const page: ReadRequestPage = {
      index: staged.state.pages.length + 1,
      windows: choice.windows.map((window) => ({ path: choice.path, window })),
      fixed_at_ms: Date.now(),
      cursor_state_version: cursorVersion,
    };
    const nextState: ReadRequestState = { ...staged.state, pages: [...staged.state.pages, page] };
    const written = persistOnce(staged.workspaceRoot, staged.storeKey, nextState, staged.version);
    if (written.ok) {
      staged.state = nextState;
      staged.version = written.version;
      return { ok: true, page, reused: false };
    }
    if (written.reason === "unavailable" || written.live === undefined) {
      return { ok: false, reason: written.reason === "unavailable" ? "unavailable" : "state-conflict" };
    }
    // THE OTHER WRITER'S RECORD IS NOW THE TRUTH. Adopt it before deciding
    // anything: it may already carry the page this cursor addresses.
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
 * How many times a CAS write may rebase onto a concurrent writer's record
 * before this server refuses rather than guesses. Three is enough for any
 * realistic contention on a single cursor (each attempt observes a strictly
 * newer version) and small enough that a pathological writer cannot make one
 * call spin.
 */
const MAX_CAS_ATTEMPTS = 3;

type PersistAttempt =
  | { ok: true; version: number }
  | { ok: false; reason: "unavailable"; live?: undefined }
  | { ok: false; reason: "conflict"; live?: { state: ReadRequestState; version: number } };

/**
 * ONE CAS write attempt. Never blind-retries at the conflicting version —
 * that is the lost-update the caller's rebase loop exists to avoid.
 *
 * On a conflict the live record is read back and returned with it. `put`
 * decided the conflict INSIDE the store's writer lock, after
 * `_resyncLocked()` pulled in every other process's committed writes, so the
 * in-memory record this reads is the true current one, not a stale cache.
 */
function persistOnce(
  workspaceRoot: string,
  key: string,
  state: ReadRequestState,
  expectedVersion: number,
): PersistAttempt {
  const store = stateStoreFor(workspaceRoot);
  if (store === undefined || !store.available) return { ok: false, reason: "unavailable" };
  const put = store.put({
    key,
    purpose: "read-request",
    data: state as unknown as Record<string, unknown>,
    ttlMs: Math.max(1000, state.expires_at_ms - Date.now()),
    expectedVersion,
  });
  if (put.ok) return { ok: true, version: put.record.version };
  if (put.outcome !== "state-conflict") return { ok: false, reason: "unavailable" };
  const record = store.get(key);
  if (record === undefined || record.purpose !== "read-request") return { ok: false, reason: "conflict" };
  const live = asReadRequestState(record.data);
  return live === undefined
    ? { ok: false, reason: "conflict" }
    : { ok: false, reason: "conflict", live: { state: live, version: record.version } };
}

/**
 * Union `additions` into `page.shipped`, clipped to the page's own PLANNED
 * windows — a page is never widened by what a later call claims to have
 * shipped for it.
 */
function unionShipped(
  page: ReadRequestPage,
  additions: readonly { path: string; window: LineWindow }[],
): Array<{ path: string; window: LineWindow }> {
  const out: Array<{ path: string; window: LineWindow }> = [];
  const paths = new Set(page.windows.map((entry) => entry.path));
  for (const path of paths) {
    const planned = page.windows.filter((e) => e.path === path).map((e) => e.window);
    const have = (page.shipped ?? []).filter((e) => e.path === path).map((e) => e.window);
    const add = additions.filter((e) => e.path === path).map((e) => e.window);
    if (have.length === 0 && add.length === 0) continue;
    for (const window of intersectWindows(normalizeWindows([...have, ...add]), planned)) {
      out.push({ path, window });
    }
  }
  return out;
}

/**
 * Rebase THIS call's in-flight record onto the one another writer committed.
 *
 * The live record wins on everything a concurrent writer could legitimately
 * have advanced (its pages, its settled targets), and this call contributes
 * only what is genuinely its own: pages it fixed that the live record does
 * not have, delivery accounting (`shipped`) for pages both sides know about,
 * and the budget this call may have overridden (§5.2's sanctioned override).
 * Nothing is lost in either direction, which is what makes a retry safe.
 */
function rebaseOnLive(mine: ReadRequestState, live: ReadRequestState): ReadRequestState {
  const pages: ReadRequestPage[] = live.pages.map((page) => ({ ...page }));
  const byCursor = new Map<number, ReadRequestPage>();
  for (const page of pages) byCursor.set(page.cursor_state_version, page);
  for (const page of mine.pages) {
    const existing = byCursor.get(page.cursor_state_version);
    if (existing === undefined) {
      const copy: ReadRequestPage = { ...page, index: pages.length + 1 };
      pages.push(copy);
      byCursor.set(copy.cursor_state_version, copy);
      continue;
    }
    if (page.shipped === undefined) continue;
    const merged = unionShipped(existing, page.shipped);
    if (merged.length > 0) existing.shipped = merged;
  }
  const rebased: ReadRequestState = { ...live, pages };
  if (mine.budget !== undefined) rebased.budget = mine.budget;
  else delete rebased.budget;
  return rebased;
}

/**
 * finding 8 (regression fix): the synthetic "page 0" for an `"open"` mode
 * request's own first response — see `settleReadRequest`'s call site for why
 * this needs to exist at all. Built from `shippedWindowsByPath` (the SAME
 * finalized-payload account finding 12 already threads through), covering
 * every target this call actually shipped something for; targets it shipped
 * nothing for (or that `shippedWindowsByPath` has no entry for at all) are
 * simply absent from it. Multiple targets/paths share the ONE page entry —
 * `isExactPageMatch` already filters `page.windows` by path per lookup, so a
 * mixed-path page is not a new shape it needs to learn.
 */
function buildOpeningPage(
  targets: readonly ReadRequestTargetState[],
  shippedWindowsByPath: ReadonlyMap<string, readonly LineWindow[]>,
): ReadRequestPage[] {
  const windows: Array<{ path: string; window: LineWindow }> = [];
  for (const target of targets) {
    const shipped = shippedWindowsByPath.get(target.path);
    if (shipped === undefined) continue;
    for (const window of normalizeWindows(shipped)) windows.push({ path: target.path, window });
  }
  if (windows.length === 0) return [];
  // `windows` here IS the shipped account (it was built from it), so the page
  // is born already delivery-accounted — an opening page never has a "planned
  // but unshipped" tail to lose.
  return [{
    index: 0,
    windows,
    shipped: windows.map((entry) => ({ ...entry })),
    fixed_at_ms: Date.now(),
    cursor_state_version: 0,
  }];
}

/**
 * Book what THIS call put on the wire onto the page it served (§5.1's `S`).
 *
 * `shippedWindowsByPath` is the emit tail's own account of the FINALIZED
 * payload:
 *
 *   - a map -> credit exactly the intersection of the page's planned windows
 *     with what the wire actually carries for that path. An EMPTY map is a
 *     real answer, not a missing one: a refusal shipped no bodies at all, so
 *     the page stays fully owed;
 *   - `undefined` -> this response carried no `evidence` array whatsoever,
 *     i.e. a receipt. A receipt asserts the caller already holds this page's
 *     bytes, which is a statement ABOUT DELIVERY, so the planned windows are
 *     credited wholesale — the behaviour this store always had for it.
 *
 * Mutates `staged.state` in memory only; the settle that follows persists it.
 */
function recordShippedPage(
  staged: StagedReadRequest,
  shippedWindowsByPath: ReadonlyMap<string, readonly LineWindow[]> | undefined,
): void {
  const current = staged.page;
  if (current === undefined) {
    // finding 8 (regression fix): the FIRST ("open") response's own page is
    // otherwise never recorded in `pages[]` at all — only a CURSOR-consumed
    // resume ever calls `fixPage` — so a later plain (non-cursor) re-ask of
    // EXACTLY that first page's range could never satisfy `isExactPageMatch`
    // and always looked "independent", even though design §6.2 explicitly
    // wants it to carry the parent's `next` forward (this file's own
    // `openParentReadRequest` doc comment, and the `r4-parent`-style test
    // that proves it). `cursor_state_version: 0` is a safe sentinel — a REAL
    // resume cursor is only ever minted once a settle has actually persisted
    // (bumping the version to >= 1), so no live cursor can ever decode to `0`.
    if (staged.mode !== "open" || staged.state.pages.length > 0) return;
    if (shippedWindowsByPath === undefined) return;
    const opening = buildOpeningPage(staged.state.targets, shippedWindowsByPath);
    if (opening.length === 0) return;
    staged.state = { ...staged.state, pages: [...staged.state.pages, ...opening] };
    return;
  }
  const index = staged.state.pages.findIndex(
    (page) => page.cursor_state_version === current.cursor_state_version,
  );
  if (index < 0) return;
  const page = staged.state.pages[index]!;
  const account = shippedWindowsByPath === undefined
    ? page.windows.map((entry) => ({ ...entry }))
    : page.windows.flatMap((entry) => intersectWindows(
      [entry.window],
      shippedWindowsByPath.get(entry.path) ?? [],
    ).map((window) => ({ path: entry.path, window })));
  // REPLACES, never accumulates. `emit.ts`'s post-rewrite budget safety net
  // can settle this SAME call twice — once on the finalized payload and once
  // on a payload one line shorter — and a union would keep the first, wider
  // account forever, skipping the shrunk-away line on every future page.
  // That is the search side's `rewindSearchRequestDelivered` hazard in read
  // form; replacing is the read side's answer to it, and it costs nothing
  // across DIFFERENT calls because a later call re-serving this page ships
  // the same windows (or a receipt, which credits the page whole).
  const shipped = unionShipped({ ...page, shipped: [] }, account);
  const updated: ReadRequestPage = { ...page, shipped };
  const pages = [...staged.state.pages];
  pages[index] = updated;
  staged.state = { ...staged.state, pages };
  staged.page = updated;
}

/**
 * Recompute D from the SETTLED ledger and persist.
 *
 * Called from `emit.ts`'s tail, immediately after `settleServedCallBookings`,
 * so the ledger it reads already reflects exactly what this response carries —
 * §3.2's "確定した応答から一度だけ記帳" applied to the request's own remainder.
 *
 * Returns the persisted state, or `undefined` when nothing could be written
 * (no store, or a lost CAS retry). `undefined` means "emit what the producer
 * built" — never a fabricated cursor.
 */
export function settleReadRequest(
  staged: StagedReadRequest,
  shippedWindowsByPath?: ReadonlyMap<string, readonly LineWindow[]>,
): ReadRequestState | undefined {
  // §5.1's `S`, BOOKED BEFORE IT IS SPENT: what this call shipped is written
  // onto the page it served, so every later settle reads delivery off the
  // page record rather than re-deriving it from a plan.
  recordShippedPage(staged, shippedWindowsByPath);
  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
    const outcome = settleOnce(staged);
    if (outcome.done) return outcome.state;
    if (outcome.live === undefined) return undefined;
    staged.state = rebaseOnLive(staged.state, outcome.live.state);
    staged.version = outcome.live.version;
  }
  return undefined;
}

/** ONE settle attempt — see `settleReadRequest` for the retry contract. */
function settleOnce(
  staged: StagedReadRequest,
): { done: true; state: ReadRequestState | undefined } | {
  done: false;
  live?: { state: ReadRequestState; version: number };
} {
  const targets = settledTargets(staged);
  const next: ReadRequestState = { ...staged.state, targets };
  // NOTHING OWED, NOTHING WRITTEN. The overwhelming majority of reads deliver
  // everything they were asked for, and a request that is complete on its FIRST
  // response has no continuation to address and therefore no reason to occupy a
  // store record (`RECORD_CAP` is 2048, and a per-read row would evict real
  // task state). An already-persisted request still settles, so its D stays
  // truthful for the cursor that is already out.
  if (staged.version === 0 && targets.every((target) => target.remaining.length === 0)) {
    staged.state = next;
    return { done: true, state: next };
  }
  const written = persistOnce(staged.workspaceRoot, staged.storeKey, next, staged.version);
  if (written.ok) {
    staged.state = next;
    staged.version = written.version;
    return { done: true, state: next };
  }
  if (written.reason === "unavailable") return { done: true, state: undefined };
  return written.live === undefined ? { done: false } : { done: false, live: written.live };
}

/**
 * DESIGN-v0.15 §5.1 (R2): recompute D = Q - (C ∪ S) for every target.
 *
 * `S` is read entirely from `ReadRequestPage.shipped`, which `recordShippedPage`
 * books at settle time from the emit tail's own account of the FINALIZED
 * payload. Nothing here re-derives delivery from a page's PLANNED boundary —
 * see the "SHIPPED, NEVER PLANNED" note below for the defect that rule closes.
 */
function settledTargets(staged: StagedReadRequest): ReadRequestState["targets"] {
  return staged.state.targets.map((target) => {
    const ledgerNow = ledgerCoverage(staged.workspaceRoot, target.path, target.sha);
    const baseline = staged.state.force_serve_origin === true
      ? parseWindows(staged.state.ledger_baseline?.[target.path] ?? [])
      : [];
    // FORCE_SERVE ORIGIN: C = ∅, so only what this request itself added to the
    // ledger reduces D (§5.1). Otherwise the whole valid coverage counts.
    const ledgerPart = staged.state.force_serve_origin === true
      ? subtractWindows(ledgerNow, baseline)
      : ledgerNow;
    // S — THE PAGES THIS REQUEST DELIVERED, as WINDOWS rather than as ledger
    // spans. The two are not the same set, and the difference is the reason S
    // exists in `D = Q - (C ∪ S)` at all:
    //
    // the elide representation collapses a doc-comment block to one marker
    // line, and `recordServedRange` deliberately books only the SURVIVING
    // spans ("a receipt about an elided line must always re-serve",
    // `state/session.ts`). So a page covering an elided block ships the
    // representation the request asked for while the ledger records a hole
    // inside it. Reducing D by the ledger alone would leave that hole in the
    // remainder forever and re-offer the same page — the same-`next` loop §3.3
    // forbids.
    //
    // A page enters this union only once its own call has reached the emit
    // tail, i.e. once its bodies (or its receipt, which says the caller holds
    // them) actually shipped: a refusal returns long before this runs.
    //
    // SHIPPED, NEVER PLANNED. `page.windows` is the boundary `choosePage`
    // FIXED before the response existed; `page.shipped` is what the emit tail
    // then proved reached the wire. Only the latter may reduce D, for EVERY
    // page — this call's own and every earlier one alike.
    //
    // The earlier implementation clipped only the CURRENT page and trusted
    // every other page's plan wholesale, which held exactly until a page's
    // own call shed part of it: on the NEXT call that page was no longer
    // "current", its planned tail was credited again, and the shed lines left
    // D forever. A 30-line quote-heavy file at `budget:{bytes:1024}` lost 9
    // lines that way and still ended with no `next`.
    //
    // A page with no `shipped` at all credits NOTHING (see
    // `ReadRequestPage.shipped`): it stays owed and is re-served, which is
    // the safe direction. The elide-hole credit this union exists for is
    // unaffected — `evidence[].range` names the SEMANTIC extent an entry
    // claims and elision only changes the body text inside it, so an elided
    // block is `shipped` in full.
    const delivered: LineWindow[] = [];
    for (const page of staged.state.pages) {
      for (const entry of page.shipped ?? []) {
        if (entry.path !== target.path) continue;
        delivered.push(entry.window);
      }
    }
    const coverage = normalizeWindows([...ledgerPart, ...delivered]);
    return { ...target, remaining: subtractWindows(target.requested, coverage) };
  });
}

/** True iff every target's D is empty — §5.1's completion predicate. */
export function readRequestComplete(state: ReadRequestState): boolean {
  return state.targets.every((target) => target.remaining.length === 0);
}

/**
 * Mint the cursor that fetches the NEXT page of this request.
 *
 * `stateVersion` is the record's current CAS version, which becomes the page
 * selector when this cursor is accepted (see `ReadRequestPage`).
 */
export function mintReadCursor(staged: StagedReadRequest): string | undefined {
  return mintFetchRequestHandle({
    workspaceRoot: staged.workspaceRoot,
    purpose: "read-request",
    payloadRef: fetchRequestPayloadRef(staged.payloadRefSeed),
    stateVersion: staged.version,
    bindingDigest: readRequestBinding({
      ...(staged.state.lane !== undefined ? { lane: staged.state.lane } : {}),
      ...(staged.state.task_handle !== undefined ? { taskHandle: staged.state.task_handle } : {}),
      fingerprint: staged.state.input_fingerprint,
    }),
  });
}

/**
 * Rebuild the staged form of an already-persisted request (a cursor call).
 *
 * The payload-ref SEED is recomputed from `(workspaceRoot, state.id)` — the
 * same expression `openReadRequest` used — so the next cursor this call mints
 * addresses the same store record rather than a fresh one.
 */
export function stagedFromResolution(
  workspaceRoot: string,
  resolution: { state: ReadRequestState; version: number; storeKey: string },
  echo: { cwd?: string; lane?: string; taskHandle?: string },
): StagedReadRequest {
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
// Parent-full-request exception — DESIGN-v0.15 §6.2 (R4).
//
// A plain (non-cursor) read of a window that a session's ledger already
// covers ends the request it belongs to (a receipt with no `next`, §3.3's
// "既読通知の終端") UNLESS that window is also owed by a still-open
// full/range/batch read request for the SAME path — in which case §6.2's
// second paragraph applies: "今回のページだけが既読だった場合は親のDを更新
// し、残件がある限り次ページを運ぶ". `WorkspaceSession.openReadRequests`
// (state/session.ts) is the (workspace, lane)-scoped index that makes this
// findable without a cursor: keyed by STORE KEY, never by value, so the
// lookup below always re-loads and re-settles the LIVE record rather than
// trusting a value that may be stale, foreign, expired, or already complete.
// ---------------------------------------------------------------------------

/**
 * Record that `staged` is (or is no longer) an OPEN request for each of its
 * targets' paths.
 *
 * Called from the emit tail (`protocol/readRequestContinuation.ts`) right
 * after a settle, with `complete` = `readRequestComplete(settled)`: an
 * INCOMPLETE request is indexed so a later plain read can find it; a
 * COMPLETE one is dropped, since there is nothing left to attach.
 * `staged.storeKey` is stable across a request's whole lifetime
 * (`stagedFromResolution` recomputes the same key from `state.id`), so
 * repeated calls for the same request are idempotent.
 */
export function markReadRequestOpenness(staged: StagedReadRequest, complete: boolean): void {
  const session = getSession(staged.workspaceRoot);
  for (const target of staged.state.targets) {
    const existing = session.openReadRequests.get(target.path);
    if (complete) {
      if (existing === undefined) continue;
      existing.delete(staged.storeKey);
      if (existing.size === 0) session.openReadRequests.delete(target.path);
      continue;
    }
    if (existing === undefined) session.openReadRequests.set(target.path, new Set([staged.storeKey]));
    else existing.add(staged.storeKey);
  }
}

/**
 * True iff `confirmed` (already normalized) is EXACTLY the window set one of
 * `pages` recorded for `relPath` — never merely a SUBSET of one.
 *
 * finding 8: this is the mechanical form of §6.2's "独立した関数readと、全文
 * cursorに属する関数範囲のreadを明確に識別する". A window nested INSIDE a page
 * the parent already delivered (e.g. a symbol a few lines into a page-1 span)
 * is still an INDEPENDENT read — it did not ask for that page, so it must not
 * inherit the page's continuation merely because it happens to overlap
 * already-served territory. Only a call that lands on a page's OWN exact
 * boundary (a cursor resend, or a plain range/batch/symbol read that happens
 * to restate one verbatim) counts as "belongs to the cursor".
 */
function isExactPageMatch(
  pages: readonly ReadRequestPage[],
  relPath: string,
  confirmed: readonly LineWindow[],
): boolean {
  return pages.some((page) => {
    const windows = normalizeWindows(
      page.windows.filter((entry) => entry.path === relPath).map((entry) => entry.window),
    );
    return windows.length === confirmed.length
      && windows.every((w, i) => w.start === confirmed[i]!.start && w.end === confirmed[i]!.end);
  });
}

/**
 * Find an OPEN parent read-request for `relPath` at `fileSha`, bound to the
 * SAME (lane, task handle) as `binding`, whose target for this path still has
 * remaining lines once re-settled against the CURRENT served-range ledger —
 * AND whose window(s) THIS call confirmed (`servedWindows`) actually belong to
 * that parent, not merely share its path (finding 8; design §6.2).
 *
 * Two conditions gate the match, both required: (a) `servedWindows` must lie
 * entirely inside the candidate's own requested Q for this path (a cheap
 * sanity bound — the only one a RANGE-scoped parent needs, since an unrelated
 * window elsewhere in the file is not even part of what it ever asked for);
 * (b) `servedWindows`, normalized, must be an EXACT match (`isExactPageMatch`)
 * against one of the parent's own already-fixed pages for this path — never
 * merely a subset of one. (b) subsumes (a) whenever it holds, but (a) is kept
 * as an explicit, independently-testable bound and a cheap early exit.
 *
 * Every candidate this walks is re-settled here — never merely read — so the
 * returned request's D reflects everything served for this path up to and
 * including whatever call is asking (§6.2: "親requestのDは現在の有効な受領
 * 証拠で計算する"). A candidate found expired, workspace/lane/task-foreign,
 * sha-mismatched, or newly-complete is pruned from the index and skipped
 * rather than returned — this is the self-healing half of the index, so no
 * separate sweep is needed. A candidate whose page/Q does not match this
 * call's window is left in the index (untouched) rather than pruned: it may
 * still be the right parent for a LATER call. Returns `undefined` when no
 * open parent claims this exact window (the ordinary, independent-read case).
 */
export function openParentReadRequest(
  workspaceRoot: string,
  relPath: string,
  fileSha: string,
  binding: { lane?: string; taskHandle?: string },
  echo: { cwd?: string; lane?: string; taskHandle?: string },
  servedWindows: readonly LineWindow[],
): StagedReadRequest | undefined {
  const confirmed = normalizeWindows(servedWindows);
  if (confirmed.length === 0) return undefined;
  const session = getSession(workspaceRoot);
  const candidates = session.openReadRequests.get(relPath);
  if (candidates === undefined || candidates.size === 0) return undefined;
  const store = stateStoreFor(workspaceRoot);
  if (store === undefined || !store.available) return undefined;
  const workspaceRef = workspaceRefOf(workspaceRoot);
  const prune = (storeKey: string): void => {
    candidates.delete(storeKey);
    if (candidates.size === 0) session.openReadRequests.delete(relPath);
  };
  for (const storeKey of [...candidates]) {
    const record = store.get(storeKey);
    if (record === undefined || record.purpose !== "read-request") { prune(storeKey); continue; }
    const state = asReadRequestState(record.data);
    if (state === undefined || Date.now() >= state.expires_at_ms) { prune(storeKey); continue; }
    if (state.workspace_ref !== workspaceRef) { prune(storeKey); continue; }
    if ((state.lane ?? "") !== (binding.lane ?? "")) continue;
    if ((state.task_handle ?? "") !== (binding.taskHandle ?? "")) continue;
    const target = state.targets.find((entry) => entry.path === relPath);
    if (target === undefined || target.sha !== fileSha) continue;
    // finding 8: inside Q, AND an exact page match — see this function's own
    // doc comment and `isExactPageMatch`'s for why both are required.
    if (subtractWindows(confirmed, target.requested).length > 0) continue;
    if (!isExactPageMatch(state.pages, relPath, confirmed)) continue;
    const staged = stagedFromResolution(workspaceRoot, { state, version: record.version, storeKey }, echo);
    const settled = settleReadRequest(staged);
    if (settled === undefined) continue;
    const remaining = settled.targets.find((entry) => entry.path === relPath)?.remaining ?? [];
    if (remaining.length === 0) { prune(storeKey); continue; }
    return staged;
  }
  return undefined;
}
