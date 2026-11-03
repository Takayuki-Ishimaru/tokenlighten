// edit-transaction — extracted implementation; imports point to the owning modules.
import * as path from "path";
import type { ToolCall } from "@tokenlighten/types";
import type { ToolCallResult } from "../protocol/result.js";
import { activeRoot } from "../runtime/config.js";
import { canonicalToolCall } from "../protocol/envelope.js";
import { createHash } from "crypto";
import { currentSessionLane } from "../util/laneKey.js";
import { finalizeProtocolResponse } from "../protocol/envelope.js";
import { handleTable } from "../util/handles.js";
import { isRecordLike } from "./search-support.js";
import { laneScopedKey } from "../util/laneKey.js";
import { markReplayed } from "../protocol/editFamily.js";
import { operationsInFlight as _operationsInFlight } from "../runtime/requestState.js";
import { readFileSync } from "node:fs";
import { realpathSync } from "node:fs";
import { recordServedBytes } from "../util/packServeLog.js";
import { resolveTaskHandle } from "../state/stateHandles.js";
import { resolveWorkspaceRoot } from "./read-admission2.js";
import { runWithProtocolCall } from "../protocol/envelope.js";
import { servedTextOrUndefined } from "../util/textDecode.js";
import { stableStringify } from "../util/schemaStamp.js";
import { stateStoreFor } from "../state/stateStore.js";
import { taskPackRecoveryFor } from "./read-admission2.js";
import { toolStructuredError } from "../protocol/result.js";

/**
 * 2026-10-19 (v016 decision 6t-3): the caller's `edits[]` with every
 * mechanically fixable item corrected, the one way the server can stand
 * behind, for the `next` of a refusal that names one such item — or
 * `undefined` when the item at `failedIndex` is not among them, or an item
 * whose handle this server does not hold cannot be corrected (that call keeps
 * the established refusal). Two corrections, applied to every item they fit,
 * so one `next` clears them all:
 *  - an item-level `precondition:"unique-match"` on an item with no non-empty
 *    `search` (a `content` item — measured T05c rep2 #14, a six-item batch
 *    whose second item replaced a handle's lines with `content`) drops the
 *    precondition: what it guards, exactly one match of `search`, does not
 *    exist on that item, so the item means without it what it meant with it.
 *    A top-level precondition applies to every item and is left alone;
 *  - an item whose `handle` this server does not hold (or holds without a
 *    path) and that carries its own `path`, a non-empty `search` and a
 *    `replace` — no `content`/`range`, which need the handle's lines — drops
 *    `handle` and `allowPathFallback`: the path form `allowPathFallback:true`
 *    already takes, where the search must still match exactly once before
 *    anything is written.
 * `items` is the caller's batch as SENT (`snapshotEditArgs`), never the copy
 * dispatch rewrites in place (an elision anchor resolves `search` there).
 */
export function repairedEditItems(items: readonly unknown[], failedIndex: number): unknown[] | undefined {
  let failedFixed = false;
  const repaired: unknown[] = [];
  for (const [index, raw] of items.entries()) {
    if (!isRecordLike(raw)) {
      repaired.push(raw);
      continue;
    }
    const item: Record<string, unknown> = { ...raw };
    let fixed = false;
    if (item["precondition"] === "unique-match" && item["create"] !== true
      && (typeof item["search"] !== "string" || item["search"] === "")) {
      delete item["precondition"];
      fixed = true;
    }
    const handle = item["handle"];
    if (typeof handle === "string" && handle !== "") {
      const entry = handleTable.get(handle);
      if (entry === undefined || entry.path === undefined || entry.path === "") {
        const pathForm = pathFormOfEditItem(item);
        if (pathForm === undefined) return undefined;
        repaired.push(pathForm);
        if (index === failedIndex) failedFixed = true;
        continue;
      }
    }
    if (fixed && index === failedIndex) failedFixed = true;
    repaired.push(fixed ? item : raw);
  }
  return failedFixed ? repaired : undefined;
}

/**
 * An edit item (or a flat single edit) addressed by a handle this server does
 * not hold, re-addressed by its own `path`: `undefined` unless it carries that
 * path, a non-empty `search` and a `replace`, and nothing that needs the
 * handle's own lines (`content`, `range`) or names a new file (`create`).
 */
export function pathFormOfEditItem(item: Record<string, unknown>): Record<string, unknown> | undefined {
  const pathForm = typeof item["path"] === "string" && item["path"] !== ""
    && typeof item["search"] === "string" && item["search"] !== ""
    && typeof item["replace"] === "string"
    && item["content"] === undefined && item["range"] === undefined && item["create"] !== true;
  if (!pathForm) return undefined;
  const { handle: _handle, allowPathFallback: _allowPathFallback, ...rest } = item;
  return rest;
}

/**
 * The `next` of a fixable `edits[]` refusal: THIS call (`args`, legacy
 * projection) with its items replaced by `repairedEditItems`'s, or
 * `undefined` when no correct call can be built.
 */
export function repairedEditBatchCall(
  args: Record<string, unknown>,
  sentItems: readonly unknown[] | undefined,
  failedIndex: number,
): ToolCall | undefined {
  // A call-level precondition (legacy dialect) governs every item; dropping
  // it from the re-issued call would remove a guard the caller set.
  if (sentItems === undefined || args["precondition"] !== undefined) return undefined;
  const repaired = repairedEditItems(sentItems, failedIndex);
  return repaired === undefined ? undefined : canonicalToolCall("tl_edit_file", { ...args, edits: repaired });
}

/**
 * 2026-10-19 (v016 decision 6t-3, T09): an `edits[]` item whose handle this
 * server does not hold. With a correct call to name (`repairedEditItems`: the
 * item's own path form), the refusal is `retry:"call"` with that call as
 * `next`; otherwise the established bare refusal, whose recovery the shared
 * refusal exit supplies.
 */
export function unknownEditItemHandleRefusal(
  args: Record<string, unknown>,
  sentEditArgs: Record<string, unknown>,
  index: number,
): Record<string, unknown> {
  const repaired = repairedEditBatchCall(
    args,
    Array.isArray(sentEditArgs["edits"]) ? sentEditArgs["edits"] as unknown[] : undefined,
    index,
  );
  if (repaired === undefined) return { ok: false, reason: "handle-unknown" };
  return {
    ok: false,
    reason: "handle-unknown",
    field: `edits[${index}].handle`,
    failed_item: { index },
    detail: "this item's handle is not one this server holds (stale, or minted by another session); nothing was written — next re-issues this call with the item addressed by its own path, where its search must still match exactly once",
    retry: "call",
    next: repaired,
  };
}

/**
 * The caller's `tl_edit_file` arguments as SENT, before dispatch rewrites any of
 * them in place (`applyElidedEditAnchor` resolves an elided `search`/`replace`
 * on the item itself). Each `edits[]` item is copied one level deep; the
 * strings are immutable.
 */
export function snapshotEditArgs(args: Record<string, unknown>): Record<string, unknown> {
  const snapshot: Record<string, unknown> = { ...args };
  if (Array.isArray(args["edits"])) {
    snapshot["edits"] = (args["edits"] as unknown[]).map((item) => (isRecordLike(item) ? { ...item } : item));
  }
  return snapshot;
}

/**
 * P1-3(c) fix (report-items.md / DESIGN-v0.15 hands-on-report wave):
 * `tl_read_file {task:{handle:<live handle>}}` ALONE — no query/targets/qref/
 * cursor, and not a `task.pull:"closure"` pull — is the sanctioned "continue
 * a task by its id" recipe AGENTS.md documents verbatim ("task.id outlives a
 * restart—resend as task.handle to continue"). Before this fix, the schema
 * accepted the shape (branch 3 above), `taskHandleRefusal` validated the
 * handle and returned `null` (no refusal — meaning "carry on"), and dispatch
 * then fell through with no path/query/targets/qref left to resolve,
 * eventually reaching the generic "path is required" refusal — a caller
 * holding only a live `task.id` had no way to continue, and the refusal
 * actively mislabeled the cause.
 *
 * Reuses the SAME replay qref `taskHandleRefusal`'s own dead/expired branch
 * already resolves from `resolved.state.replay` (`state/stateHandles.ts`,
 * G2's durable mirror) — deliberately a SAME-EPOCH re-pack of the bound
 * query (no `taskEpoch` is set here), because resending `task.handle` means
 * "continue this task", not "start a different one" (contrast the dead/
 * expired branch's `task:{epoch:"new"}`, which is correct there precisely
 * BECAUSE the old epoch's state is gone). Setting `args["qref"]` is
 * sufficient to complete the redirect: `resolveTaskPackQueryArg` (above)
 * resolves a bare qref under the current epoch, and the pathless-exploratory-
 * query promotion further down this dispatch (`pathlessExploratoryQuery`)
 * already turns a non-empty resolved query with no path/handle/paths into a
 * `read.task_pack` (or, once the served-range ledger already covers it, a
 * `read.receipt`) — no separate `mode:"task_pack"` wiring is needed here.
 *
 * Only fires when the handle is the ONLY addressing present, so an explicit
 * (even empty-evidence) query/targets/qref/cursor is never silently
 * overridden. Re-resolves the handle — a second cheap, side-effect-free
 * store lookup (`resolveTaskHandle` is a pure read) — rather than widening
 * `taskHandleRefusal`'s shared 3-caller return contract, so `tl_edit_file`'s
 * and `tl_search_files`' own dispatch (that function's other two callers, and
 * schema shapes that in any case require `edits`/`artifact`/`action` and so
 * can never present as handle-only) are untouched. Returns a named refusal,
 * never a loop, when the handle is live but no replay was ever recorded for
 * it (`taskPackRecoveryFor` with no `query` on `args`: `retry:"new-task"` +
 * a `remaining` telling the caller to resend the original request text with
 * `task.epoch:"new"`) — never the unrelated "path is required" mislabel.
 */
export function applyHandleOnlyResume(
  args: Record<string, unknown>,
  workspace: string,
): Record<string, unknown> | null {
  const token = args["task_handle"];
  if (typeof token !== "string" || token === "") return null;
  // A `task.pull:"closure"` call sets mode="closure" upstream (mapCanonicalTask)
  // — that is its own, already-implemented addressing and must not be
  // redirected here.
  if (args["mode"] === "closure" || args["mode"] === "overview") return null;
  const otherAddressing: readonly string[] = ["query", "qref", "path", "handle", "paths", "handles", "cursor"];
  if (otherAddressing.some((key) => args[key] !== undefined)) return null;
  // taskHandleRefusal (called just above this, at every one of tl_read_file's
  // dispatch sites) already returned a structured refusal for every
  // non-live outcome, so a second resolution here only ever reaches the
  // `ok: true` case in practice.
  const resolved = resolveTaskHandle(token, workspace);
  if (!resolved.ok) return null;
  const replay = resolved.state.replay;
  if (typeof replay !== "string" || replay === "") {
    return {
      ok: false,
      reason: "handle-unknown",
      requested_handle: token,
      hint: "this task handle is live but no working set was recorded to resume it",
      ...taskPackRecoveryFor(args),
    };
  }
  args["qref"] = replay;
  return null;
}

// ---------------------------------------------------------------------------
// PI-09 close-out — `operation_id` idempotency (tl_edit_file only)
// ---------------------------------------------------------------------------

/** Longest `operation_id` accepted. A key, not a payload. */
export const OPERATION_ID_MAX_CHARS = 128;

/**
 * Largest recorded outcome an idempotent replay will store, in bytes.
 *
 * Sized against the store's own durability arithmetic, not against taste:
 * `stateStore.ts` compacts at 512 journal lines and REFUSES to load a journal
 * over 8 MB (a refusal that resets the whole generation and invalidates every
 * outstanding handle). 512 x 16 KiB = 8 MB is exactly that boundary, so this
 * cap is the largest value that cannot turn a busy idempotent workload into a
 * store reset. The measured `edit.applied` wire sizes it must cover
 * (protocol/budget/wireBudget.ts's table) are 420 B at 1 path and 10 KB at 64
 * typical paths, so real edits fit with room; a 256-path adversarial batch
 * does not, and takes the honest non-replaying refusal below.
 */
export const OPERATION_REPLAY_MAX_BYTES = 16 * 1024;

/**
 * Marker recorded when the outcome was real but too large to replay.
 *
 * Unambiguous against a recorded payload by construction: the only other value
 * this table ever holds is `JSON.stringify({v:1,…})`, which always begins `{`.
 */
export const OPERATION_OVERSIZE_MARKER = "!oversize";

// Compatibility marker: legacy v1 parsers must reject this record as an
// unsupported replay, never treat it as absent and re-apply the edit.
export const OPERATION_REPLAY_V2_MARKER = "structured-v2";

/**
 * B-F1 downgrade fix. The legacy `op:${operationId}` key is the ONLY key an
 * old (pre-v:2) server ever reads, and its frozen dispatch order is:
 * exact-match oversize marker -> refuse (safe halt); else parse v1 JSON;
 * unreadable is treated as absent -> run() (a SECOND disk apply). See
 * `git show 23a023e0:packages/mcp-server/src/server.ts`
 * (`parseRecordedOperation`, `runEditWithOperationId`) for the exact frozen
 * logic this must satisfy — that build cannot parse a v:2 record, so it
 * would silently re-apply the edit unless the legacy key it reads is
 * unconditionally the oversize marker. The real structured-v2 record is
 * written to a SIBLING key under this prefix instead, in a namespace that
 * provably never collides with a legacy key for any caller-chosen
 * operation_id: `"op:"` and this prefix diverge at character index 2
 * (':' vs 'v'), so `` `op:${a}` `` cannot equal
 * `` `${OPERATION_V2_KEY_PREFIX}${b}` `` for ANY strings a, b —
 * `operation_id` has no charset restriction, so this must hold
 * structurally, not just empirically. The server always checks the v2 key
 * FIRST and falls back to the legacy key only when no v2 sibling exists (an
 * outcome recorded by an old server, or before this fix).
 */
export const OPERATION_V2_KEY_PREFIX = "opv2:";

/** Test-only: the v2 sibling-key namespace, exposed so specs can assert dual-write placement without duplicating the naming scheme. */
export const __testOnlyOperationV2KeyPrefix = OPERATION_V2_KEY_PREFIX;

/**
 * In-process claim set: `${workspace}\u0000${operationId}` for every operation
 * currently executing. The store's dedup table is INSERT-ONLY and is written
 * after the edit lands, so it cannot by itself stop two overlapping calls with
 * one key from both applying. This closes that window for the case that can
 * actually occur here — two calls interleaved at an `await` inside one server
 * process — and is cleared in a `finally` so a throw cannot strand a key.
 * Cross-PROCESS overlap is out of scope and disclosed in the report.
 */


/** Serialized replay payload for a recorded operation. */
export interface RecordedOperationOutcomeV2 {
  v: 2;
  kind: "edit.applied";
  replay_format: typeof OPERATION_REPLAY_V2_MARKER;
  counts?: unknown;
  paths?: unknown;
  sha?: unknown;
  checkpoint?: unknown;
  outcome_hash: string;
  /**
   * FX-M1/B1: sha256 of the CANONICAL REQUEST — `stableStringify({edits,
   * artifact, cwd, lane})` — that produced this outcome, distinct from
   * `outcome_hash` (a hash of the response). Lets a lookup hit tell "the
   * same intended change, replayed" apart from "a different call that
   * happens to share this caller-chosen key" before ever replaying.
   * Optional on the wire type only so a record written before this fix
   * (no field at all) still parses; such a record is treated as
   * unverifiable and replayed as before (no regression), never as a
   * confirmed match.
   */
  request_digest?: string;
  read_back?: unknown;
  applied?: unknown;
  core?: unknown;
  applied_note?: unknown;
  delta?: unknown;
  handle?: unknown;
  lines?: unknown;
  path?: unknown;
  verification?: unknown;
  isError?: true;
}

/**
 * One applied entry as a v2 record keeps it. `path`/`range` are the address
 * every v2 record has carried. 2026-10-06 independent review (P2-2):
 * `post_sha` (32 hex of sha256 over the file's bytes as this apply left them)
 * and `after` (the part of the post-edit window the first reply showed that
 * covers the edited lines, `replayAfterWindow`; its text dropped when the
 * record would otherwise exceed OPERATION_REPLAY_MAX_BYTES) let a replay
 * return that verified result to a client that lost the first reply, and say
 * whether the file still holds it. A record written before that fix
 * has neither and replays address-only, with no `current` claim.
 */
export interface RecordedAppliedEntry {
  path: string;
  range: string;
  post_sha?: string;
  after?: { range: string; body?: string; remaining?: string[] };
}

export type ParsedRecordedOperation = {
  text: string;
  isError?: true;
  requestDigest?: string;
  /** v2 records only: the applied entries, internal fields included (`operationReplayText` projects them). */
  applied?: RecordedAppliedEntry[];
};

export function recordedAfterWindow(raw: unknown): RecordedAppliedEntry["after"] {
  if (!isRecordLike(raw) || typeof raw["range"] !== "string") return undefined;
  const remaining = Array.isArray(raw["remaining"]) && raw["remaining"].length > 0 && raw["remaining"].every((r) => typeof r === "string")
    ? (raw["remaining"] as string[])
    : undefined;
  return {
    range: raw["range"],
    ...(typeof raw["body"] === "string" && raw["body"] !== "" ? { body: raw["body"] } : {}),
    ...(remaining !== undefined ? { remaining } : {}),
  };
}

export function recordedAppliedEntries(raw: unknown): RecordedAppliedEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item): RecordedAppliedEntry[] => {
    if (!isRecordLike(item) || typeof item["path"] !== "string" || typeof item["range"] !== "string") return [];
    const after = recordedAfterWindow(item["after"]);
    return [{
      path: item["path"],
      range: item["range"],
      ...(typeof item["post_sha"] === "string" ? { post_sha: item["post_sha"] } : {}),
      ...(after !== undefined ? { after } : {}),
    }];
  });
}

/** Context lines a replay's `after` keeps on each side of the edited span (P2-2): enough to see the edit, not the first reply's whole verification window. */
export const REPLAY_AFTER_CONTEXT_LINES = 3;

/** Largest `after` text one replay entry carries: past it only the edited span itself, past that no text (its range still rides). */
export const REPLAY_AFTER_MAX_BYTES = 2048;

/** Largest `after` text one replay carries in all: a many-file batch names the rest by path and range only. */
export const REPLAY_AFTER_TOTAL_MAX_BYTES = 8192;

/**
 * The post-edit window a replay keeps for one entry: the part of the first
 * reply's `after` covering `edited` padded by REPLAY_AFTER_CONTEXT_LINES (or
 * the edited span alone when that exceeds REPLAY_AFTER_MAX_BYTES), as `after`
 * showed it — the same text, never re-read — with every line it cuts named
 * in `remaining` beside the first reply's own `remaining`, so no edited line is
 * hidden. Under the default slim edit window this IS the first reply's window.
 * `undefined` when nothing fits or the window does not reach the edited span.
 */
export function replayAfterWindow(
  after: { range: string; body: string; remaining?: string[] },
  edited: { start: number; end: number },
): RecordedAppliedEntry["after"] {
  const bounds = /^(\d+)-(\d+)$/.exec(after.range);
  if (bounds === null) return undefined;
  const windowStart = Number(bounds[1]);
  const windowEnd = Number(bounds[2]);
  const lines = after.body.split("\n");
  for (const pad of [REPLAY_AFTER_CONTEXT_LINES, 0]) {
    const start = Math.max(windowStart, edited.start - pad);
    const end = Math.min(windowEnd, edited.end + pad);
    if (start > end) return undefined;
    // A window reaching `after`'s own last line keeps the final newline `after` carried.
    const tail = end === windowEnd ? lines.slice(end - windowStart + 1) : [];
    const body = [...lines.slice(start - windowStart, end - windowStart + 1), ...tail].join("\n");
    if (body === "" || Buffer.byteLength(body, "utf8") > REPLAY_AFTER_MAX_BYTES) continue;
    const remaining = [
      ...(start > windowStart ? [`${windowStart}-${start - 1}`] : []),
      ...(end < windowEnd ? [`${end + 1}-${windowEnd}`] : []),
      ...(after.remaining ?? []),
    ].sort((a, b) => Number(a.split("-")[0]) - Number(b.split("-")[0]));
    return { range: `${start}-${end}`, body, ...(remaining.length > 0 ? { remaining } : {}) };
  }
  return undefined;
}

/** 32 hex of sha256 over `relPath`'s current bytes, or `undefined` when it is unreadable or resolves outside `workspace`. */
export function operationFileSha(workspace: string, relPath: string): string | undefined {
  try {
    const root = realpathSync(workspace);
    const abs = realpathSync(path.resolve(root, relPath));
    const rel = path.relative(root, abs);
    if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return undefined;
    // served-bytes: not-served (a sha256 of the whole file, compared with the recorded post-edit sha)
    return createHash("sha256").update(readFileSync(abs)).digest("hex").slice(0, 32);
  } catch {
    return undefined;
  }
}

/** Lines `range` of `relPath` as an `after` window carries them (attachAppliedReadback's own slicing: the final newline rides a window that reaches the last line). */
export function operationWindowText(workspace: string, relPath: string, range: string): string | undefined {
  const bounds = /^(\d+)-(\d+)$/.exec(range);
  if (bounds === null) return undefined;
  // served-bytes: readServedText
  const text = servedTextOrUndefined(path.join(workspace, relPath));
  if (text === undefined) return undefined;
  const lines = text.split("\n");
  const hasPhantom = lines.length > 1 && lines[lines.length - 1] === "";
  const lineCount = hasPhantom ? lines.length - 1 : lines.length;
  const start = Number(bounds[1]);
  const end = Number(bounds[2]);
  if (start < 1 || end < start || end > lineCount) return undefined;
  return lines.slice(start - 1, hasPhantom && end >= lineCount ? end + 1 : end).join("\n");
}

/**
 * 2026-10-06 independent review (P2-2): the wire text of an operation replay.
 * A client re-sends an `operation_id` because it lost or doubted the first
 * reply, and an address-only receipt left it no way to see what the edit
 * produced. So the replay carries each recorded post-edit window again, and
 * `current` says whether the files still hold what the edit wrote:
 *   "unchanged" — every path hashes to its recorded post-edit bytes, so each
 *     `after` is the edit's own window AND the file's current text (a window
 *     whose text the record dropped for size is re-read from that same file);
 *   "changed" — some path no longer does: each `after` is still the edit's own
 *     recorded window, never the file's current text, and `next` reads the
 *     changed files' current state.
 * A record without `post_sha` (written before this fix) replays address-only
 * with no `current`, exactly as before.
 */
export function operationReplayText(replay: ParsedRecordedOperation, workspace: string): string {
  const applied = replay.applied ?? [];
  if (!applied.some((entry) => entry.post_sha !== undefined)) return markReplayed(replay.text);
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(replay.text);
    if (!isRecordLike(parsed)) return markReplayed(replay.text);
    body = parsed;
  } catch {
    return markReplayed(replay.text);
  }
  const changed: string[] = [];
  let afterBytes = 0;
  const entries = applied.map((entry) => {
    const unchanged = entry.post_sha !== undefined && operationFileSha(workspace, entry.path) === entry.post_sha;
    if (!unchanged && !changed.includes(entry.path)) changed.push(entry.path);
    const out: Record<string, unknown> = { path: entry.path, range: entry.range };
    const window = afterBytes < REPLAY_AFTER_TOTAL_MAX_BYTES ? entry.after : undefined;
    const text = window === undefined
      ? undefined
      : window.body ?? (unchanged ? operationWindowText(workspace, entry.path, window.range) : undefined);
    const textBytes = text === undefined ? 0 : Buffer.byteLength(text, "utf8");
    if (window !== undefined && text !== undefined && afterBytes + textBytes <= REPLAY_AFTER_TOTAL_MAX_BYTES) {
      afterBytes += textBytes;
      out["after"] = { range: window.range, body: text, ...(window.remaining !== undefined ? { remaining: window.remaining } : {}) };
    }
    return out;
  });
  const replayed: Record<string, unknown> = {
    ...body,
    applied: entries,
    replayed: true,
    current: changed.length === 0 ? "unchanged" : "changed",
  };
  if (changed.length > 0) {
    replayed["next"] = canonicalToolCall("tl_read_file", { targets: changed.map((changedPath) => ({ path: changedPath })), content: "full", cwd: workspace });
  }
  return JSON.stringify(replayed);
}

export function parseRecordedOperation(raw: string): ParsedRecordedOperation | undefined {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const record = parsed as Record<string, unknown>;
    if (record["v"] === 1 && typeof record["text"] === "string") {
      return { text: record["text"], ...(record["isError"] === true ? { isError: true as const } : {}) };
    }
    if (record["v"] !== 2
      || record["kind"] !== "edit.applied"
      || record["replay_format"] !== OPERATION_REPLAY_V2_MARKER
      || typeof record["outcome_hash"] !== "string") return undefined;
    const body: Record<string, unknown> = { v: 1, kind: "edit.applied" };
    for (const key of ["counts", "paths", "sha", "checkpoint", "read_back", "applied", "core", "applied_note", "delta", "handle", "lines", "path", "verification"]) {
      if (record[key] !== undefined) body[key] = record[key];
    }
    // The address-only projection stays the replay text of a record with no
    // post-edit facts; `applied` carries them for `operationReplayText`.
    const applied = recordedAppliedEntries(record["applied"]);
    if (applied.length > 0) body["applied"] = applied.map((entry) => ({ path: entry.path, range: entry.range }));
    return {
      text: JSON.stringify(body),
      ...(typeof record["request_digest"] === "string" ? { requestDigest: record["request_digest"] } : {}),
      ...(applied.length > 0 ? { applied } : {}),
    };
  } catch {
    return undefined;
  }
}

export function structuredOperationRecord(text: string, requestDigest: string, workspace: string): string {
  let body: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
  } catch {
    // Keep a valid compact record even when an upstream emitter returned opaque text.
  }
  const applied = Array.isArray(body["applied"]) ? body["applied"] : [];
  // 2026-10-06 independent review (P2-2): each entry also keeps the file's
  // post-edit sha (read now, right after the apply) and the part of the
  // post-edit window the reply showed around the edited lines — see
  // `RecordedAppliedEntry` and `replayAfterWindow`.
  const compactApplied = applied.flatMap((entry): RecordedAppliedEntry[] => {
    if (!isRecordLike(entry)) return [];
    const entryPath = entry["path"];
    const entryRange = entry["range"];
    if (typeof entryPath !== "string" || typeof entryRange !== "string") return [];
    const postSha = operationFileSha(workspace, entryPath);
    const shown = recordedAfterWindow(entry["after"]);
    const editedSpan = /^(\d+)(?:-(\d+))?$/.exec(typeof entry["lines"] === "string" ? entry["lines"] : entryRange);
    const after = shown?.body === undefined || editedSpan === null
      ? undefined
      : replayAfterWindow(
        { range: shown.range, body: shown.body, ...(shown.remaining !== undefined ? { remaining: shown.remaining } : {}) },
        { start: Number(editedSpan[1]), end: Number(editedSpan[2] ?? editedSpan[1]) },
      );
    return [{
      path: entryPath,
      range: entryRange,
      ...(postSha !== undefined ? { post_sha: postSha } : {}),
      ...(after !== undefined ? { after } : {}),
    }];
  });
  const recordWith = (entries: readonly RecordedAppliedEntry[]): string => {
    const record: RecordedOperationOutcomeV2 = {
      v: 2,
      kind: "edit.applied",
      replay_format: OPERATION_REPLAY_V2_MARKER,
      outcome_hash: createHash("sha256").update(text, "utf8").digest("hex").slice(0, 32),
      request_digest: requestDigest,
      // The v2 replay projection is the required-set subset plus the
      // post-edit facts a replay needs (`operationReplayText`). `outcome_hash`
      // stays in the journal for record validation but is never sent on
      // replay; the first edit.applied response remains the source for
      // counts, read_back, verification, handles and other explanatory payloads.
      ...(entries.length > 0 ? { applied: [...entries] } : {}),
    };
    return JSON.stringify(record);
  };
  const fits = (record: string): boolean => Buffer.byteLength(record, "utf8") <= OPERATION_REPLAY_MAX_BYTES;
  const full = recordWith(compactApplied);
  if (fits(full)) return full;
  // Too large with the windows' text: keep the windows' ranges and the shas —
  // a replay of an unchanged file re-reads that text — rather than lose the
  // replay to the oversize marker.
  const withoutText = recordWith(compactApplied.map(({ after, ...rest }) => after === undefined
    ? rest
    : { ...rest, after: { range: after.range, ...(after.remaining !== undefined ? { remaining: after.remaining } : {}) } }));
  if (fits(withoutText)) return withoutText;
  // Still too large (a batch of hundreds of files): the address-only record
  // every batch that fits 16 KiB replayed before this change, with no
  // `current` claim, never the oversize refusal.
  return recordWith(compactApplied.map(({ path: entryPath, range }) => ({ path: entryPath, range })));
}

/**
 * PI-09 close-out: run one `tl_edit_file` call under its `operation_id`.
 *
 * POSITION MATTERS, and it is OUTSIDE the protocol funnel
 * (`runWithProtocolCall` -> `finalizeProtocolResponse`), for two reasons the
 * inner position got wrong when it was tried first:
 *   - `isError` is stamped by the funnel (§2.5: every refusal carries it), so
 *     inside the funnel a refusal is indistinguishable from an apply and a
 *     failed attempt would claim the key forever;
 *   - the recorded outcome is then projected from the FINAL wire text, never
 *     from a second projection of the same body through a workspace marker
 *     that has moved since (the edit itself moves it).
 *
 * The contract, in order:
 *  1. a repeat whose operation ALREADY APPLIED replays the recorded outcome
 *     and performs no second disk apply;
 *  2. an overlapping call with the same key is refused, not raced;
 *  3. a first (or previously refused) call runs normally, and its outcome is
 *     recorded only when something actually landed.
 *
 * WHAT IS DELIBERATELY NOT RECORDED. A refusal — including `edit.rolled_back`
 * and `edit.state_unknown`, which are `isError` — leaves the key unclaimed, so
 * the caller may retry after acting on the refusal's own recovery. Recording a
 * refusal would turn "nothing was applied" into a permanent answer for that
 * key, which is the opposite of what an idempotency key is for.
 *
 * KNOWN WINDOW, disclosed rather than hidden: the record is written AFTER the
 * apply, so a crash between the two leaves the operation unrecorded and a
 * retry re-applies. Closing it needs a two-phase write the append-journal
 * store does not offer (D-4), and a pre-claim would instead risk recording an
 * apply that never happened — the strictly worse failure.
 */
/**
 * FX-M1/B1: the canonical fingerprint of the CALL, not the outcome — sha256
 * of `stableStringify({edits, artifact, cwd, lane})` (key order-independent,
 * array order preserved). Bound to the recorded outcome at write time and
 * compared on every lookup hit, so a reused `operation_id` whose current
 * call carries a materially different `edits`/`artifact` payload, `cwd`, or
 * `lane` is detected BEFORE anything is replayed — see the mismatch refusal
 * in `runEditWithOperationId` below. `intent` is deliberately not included:
 * it is advisory routing metadata, not part of the requested change.
 */
export function operationRequestDigest(args: Record<string, unknown>, workspace: string, lane: string): string {
  const canonical = {
    edits: args["edits"] ?? null,
    artifact: args["artifact"] ?? null,
    cwd: workspace,
    lane,
  };
  return createHash("sha256").update(stableStringify(canonical), "utf8").digest("hex");
}

export async function runEditWithOperationId(
  args: Record<string, unknown>,
  run: () => Promise<ToolCallResult>,
): Promise<ToolCallResult> {
  // This wrapper short-circuits BEFORE the dispatch funnel, so every refusal it
  // mints needs its own envelope — the same reason and the same shape as the
  // lane refusal in `callTool`. D1 admits no exceptions: a refusal a client
  // cannot version-identify is the class §1.2 exists to remove.
  const refuse = (body: Record<string, unknown>): ToolCallResult =>
    runWithProtocolCall({ tool: "tl_edit_file", kind: "refusal" }, () =>
      finalizeProtocolResponse("tl_edit_file", toolStructuredError(body)));

  const raw = args["operation_id"];
  if (raw === undefined) return run();
  if (typeof raw !== "string" || raw === "" || raw.length > OPERATION_ID_MAX_CHARS) {
    return refuse({
      ok: false,
      reason: "invalid-input",
      field: "operation_id",
      detail: `operation_id must be a non-empty string of at most ${OPERATION_ID_MAX_CHARS} characters — one caller-chosen key per intended change`,
      recovery_detail: "re-issue this exact call with a valid operation_id, or omit it",
    });
  }

  let workspace: string;
  try {
    workspace = resolveWorkspaceRoot(args["cwd"] as string | undefined, activeRoot);
  } catch {
    // An unresolvable cwd is refused by the guard inside `run()` with a far
    // better message than anything this wrapper could invent.
    return run();
  }
  const store = stateStoreFor(workspace);
  if (store === undefined || !store.available) {
    // No durable store: honest degradation to today's behavior. Refusing the
    // edit instead would make `operation_id` a way to LOSE a write, and the
    // caller can still verify what landed.
    return run();
  }

  // FX-M1/B2: fold the lane into BOTH keys so two concurrent lanes reusing
  // the same caller-chosen `operation_id` cannot address the same dedup
  // row (AGENTS.md: "lanes never leak"). `laneScopedKey` returns its input
  // UNCHANGED for the default/lane-less session (`currentSessionLane() ===
  // ""`), so every lane-less call — including operationReplayCompatibility
  // .spec.ts's downgrade proof, which asserts the LITERAL legacy key
  // `op:${opId}` — keys byte-for-byte as before this fix.
  const lane = currentSessionLane();
  const key = laneScopedKey(`op:${raw}`);
  const claim = `${workspace}\u0000${key}`;

  // FX-M1/B1: the fingerprint of THIS call, computed before any lookup so it
  // is available both to compare against a replay hit and to record on a
  // fresh apply below.
  const requestDigest = operationRequestDigest(args, workspace, lane);

  // Dual-read (B-F1): a v:2 sibling record — written only by a server that
  // has this fix — always wins when present, so THIS server's own writes
  // always round-trip through the compact v2 projection below. Its absence
  // means either an old server wrote the legacy key (a real v1 record or a
  // real oversize marker), or nothing was recorded yet; the legacy-key read
  // below covers both.
  const v2Key = laneScopedKey(`${OPERATION_V2_KEY_PREFIX}${raw}`);
  const recordedV2 = store.lookupOperation(v2Key);
  const recorded = recordedV2 !== undefined ? recordedV2 : store.lookupOperation(key);
  if (recorded !== undefined) {
    if (recorded === OPERATION_OVERSIZE_MARKER) {
      return refuse({
        ok: false,
        reason: "invalid-input",
        field: "operation_id",
        detail: "this operation_id already applied; its recorded outcome was too large to replay, so it cannot be re-served — the change is already on disk; verify it instead of re-sending the edit",
        operation_id: raw,
        retry: "none",
        next: canonicalToolCall("tl_search_files", { action: "diff" }),
      });
    }
    const replay = parseRecordedOperation(recorded);
    if (replay !== undefined) {
      // FX-M1/B1: a request_digest recorded by a server with this fix that
      // does not match THIS call's payload means the caller reused the key
      // for a materially different edit — refuse instead of silently
      // replaying the earlier, unrelated outcome. A record with no
      // request_digest at all (written before this fix) is unverifiable,
      // not mismatched — it replays exactly as it always has (no
      // regression for an outcome recorded by a pre-fix server).
      if (replay.requestDigest !== undefined && replay.requestDigest !== requestDigest) {
        return refuse({
          ok: false,
          reason: "invalid-input",
          field: "operation_id",
          detail: "this operation_id is already bound to a different edit from an earlier call in this workspace/lane — its recorded outcome was left untouched and nothing from THIS call was applied; re-issue the ORIGINAL call verbatim to replay it, or choose a new operation_id for this distinct change",
          operation_id: raw,
        });
      }
      // THE IDEMPOTENT REPLAY. No dispatch, so no second disk apply.
      // v2 records carry only the side-effect identity and required replay
      // fields; the original response body is never re-read from the journal.
      const replayText = operationReplayText(replay, workspace);
      recordServedBytes({
        workspaceRoot: workspace,
        epoch: typeof args["taskEpoch"] === "string" ? args["taskEpoch"] : undefined,
        lane: typeof args["lane"] === "string" ? args["lane"] : undefined,
        bytes: Buffer.byteLength(replayText, "utf8"),
        digest: createHash("sha256").update(replayText, "utf8").digest("hex"),
        source: "replay",
        forceServe: args["force_serve"] === true,
      });
      return { content: [{ type: "text", text: replayText }], ...(replay.isError === true ? { isError: true as const } : {}) };
    }
    // A recorded but unreadable v2 line must fail closed: treating it as
    // absent would let an older/newer parser apply the edit a second time.
    return refuse({
      ok: false,
      reason: "invalid-input",
      field: "operation_id",
      detail: "this operation_id already has a recorded outcome that cannot be replayed safely; nothing was applied a second time — verify the existing change instead of re-sending the edit",
      operation_id: raw,
      retry: "none",
      next: canonicalToolCall("tl_search_files", { action: "diff" }),
    });
  }

  if (_operationsInFlight.has(claim)) {
    return refuse({
      ok: false,
      reason: "invalid-input",
      field: "operation_id",
      detail: "another call with this operation_id is still running in this server — nothing was applied, so this request cannot be told whether the first one landed",
      operation_id: raw,
      recovery_detail: "wait for the first call to answer, then re-issue this exact call — the recorded outcome will be replayed",
    });
  }
  _operationsInFlight.add(claim);
  let result: ToolCallResult;
  try {
    result = await run();
  } finally {
    _operationsInFlight.delete(claim);
  }

  const isError = "isError" in result && result.isError === true;
  if (!isError) {
    const text = result.content.map((item) => item.text).join("");
    const payload = structuredOperationRecord(text, requestDigest, workspace);
    const v2Value = Buffer.byteLength(payload, "utf8") <= OPERATION_REPLAY_MAX_BYTES ? payload : OPERATION_OVERSIZE_MARKER;
    // Dual-write (B-F1). The legacy key is UNCONDITIONALLY the oversize
    // marker — never the real record — so an old server's exact-match
    // oversize check always catches it and fails closed instead of falling
    // through to "unreadable = absent -> run()" (a second disk apply). The
    // real structured-v2 record (or its own oversize marker) lives at the
    // collision-safe v2Key instead; see OPERATION_V2_KEY_PREFIX. Order
    // matters only for the crash window between the two appends: writing
    // the legacy marker first means a crash before the second write still
    // leaves an old OR new reader fail-closed (never a reapply), matching
    // this wrapper's existing disclosed "known window" contract.
    // The compact structured-v2 journal is intentionally only exposed when
    // this operation is replayed, so callers can verify that replay reduced
    // wire bytes.
    store.rememberOperation(key, OPERATION_OVERSIZE_MARKER);
    store.rememberOperation(v2Key, v2Value);
  }
  return result;
}
