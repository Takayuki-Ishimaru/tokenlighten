/**
 * stateHandles.ts — the PI-09 facade: purpose-bound handles ON TOP of the
 * per-workspace persistent store (v0.10 alpha.2).
 *
 * THREE NAMESPACES, ONE STORE.
 *
 *  - `task` (`tlh_task_v1_…`) — store-backed. Rides `TaskRef.id` (deviation
 *    D-2: no `CommonStateOutput` top-level field), and is accepted back as the
 *    optional `task_handle` REQUEST argument on all three tools. The record
 *    holds the task FINGERPRINT and replay token; it never holds the natural
 *    language query, a file body, or an absolute path.
 *  - `continuation` (`tlh_cont_v1_…`) — SELF-CONTAINED. The page position
 *    rides the token's authenticated `aad`, so paging keeps working across a
 *    restart and across instances with no store round-trip at all. This is
 *    PI-09 item 11's "決定的再構成条件とpage位置" read literally.
 *  - `content` (`h…`, `util/handles.ts`) — NOT a wire state handle and
 *    deliberately NOT re-badged as one. Its wire spelling is unchanged (no
 *    byte growth on every evidence item); what alpha.2 adds is that its ENTRY
 *    is persisted, so a restarted server resolves it instead of dead-ending.
 *    The `purpose` discriminator (`"content"`) exists precisely so a content
 *    handle can never be redeemed where a task handle is required.
 *
 * WHAT IS DELIBERATELY ABSENT: `context` handle issuance. PI-03's attestation
 * tier needs a trusted client-host counterpart (`_meta["io.tokenlighten/
 * context-state"]`), and issuing a context handle without it would be exactly
 * the "server emission history or model echo" issuance PI-09 item 10 forbids.
 * The purpose CODE exists in the codec so a `tlh_ctx_v1_` token presented today
 * fails as an authenticated wrong-purpose handle rather than as an unknown
 * string.
 */

import { shaOfText } from "../util/handles.js";

import type { HandleEntry } from "../util/handles.js";
import { handleKeyRing } from "./handleKeys.js";
import {
  MAX_AAD_BYTES,
  mintHandle,
  validateHandleToken,
  type HandleFailure,
} from "./handleCodec.js";
import { stateStoreFor, type StoredRecord } from "./stateStore.js";

// ---------------------------------------------------------------------------
// Policy constants
// ---------------------------------------------------------------------------

/**
 * Issuer identity. A CONSTANT, not the build stamp or the pid: PI-09 item 6 is
 * explicit that a persistent handle must not be bound to "process restartで
 * 毎回変わる値". Bumping this string is the migration lever that invalidates
 * every outstanding handle in one step.
 */
const ISSUER = "tokenlighten-mcp/state-v1";

/** Task handles outlive a session but not a day (item 15: no unbounded TTL). */
export const TASK_HANDLE_TTL_MS = 24 * 60 * 60 * 1000;

/** A page cursor is short-lived by nature; an hour covers any real paging run. */
export const CONTINUATION_HANDLE_TTL_MS = 60 * 60 * 1000;

/** Persisted content-handle entries share the task horizon. */
const CONTENT_ENTRY_TTL_MS = TASK_HANDLE_TTL_MS;

// ---------------------------------------------------------------------------
// Task handles
// ---------------------------------------------------------------------------

/**
 * The MINIMUM task-scoped state that has to survive a restart.
 *
 * Everything a pack could rebuild from the workspace is deliberately excluded,
 * and so is the natural-language query (PI-09 item 7: "raw source bodyは原則
 * 保存せず … task自然言語も必要最小限"). What remains is identity: which task
 * this is, and how to replay it.
 */
export interface TaskHandleState {
  taskFingerprint: string;
  replay?: string;
  coverage?: string;
  mintedAtMs: number;
}

export type TaskHandleResolution =
  | { ok: true; state: TaskHandleState; stateVersion: number }
  | { ok: false; outcome: HandleFailure; detail?: string };

/**
 * The store key for a task. DETERMINISTIC in (workspace, fingerprint, store
 * generation) so a re-pack of the SAME task addresses the SAME record instead
 * of littering the store with one row per pack.
 */
function taskPayloadRef(workspaceRoot: string, taskFingerprint: string, storeEpoch: string): Buffer {
  const digest = shaOfText(`task:${storeEpoch}:${workspaceRoot}:${taskFingerprint}`);
  return Buffer.from(digest.slice("sha256:".length), "hex").subarray(0, 9);
}

/**
 * Mint (or RE-EMIT) the task handle for `state`, or return undefined when no
 * durable store is available for this workspace.
 *
 * WHY RE-EMIT RATHER THAN RE-MINT. This value lands on `TaskRef.id`, whose
 * frozen contract is "stable identity of the question this pack answers.
 * Survives re-packs of the same task". A fresh random token per pack would
 * satisfy the security model and quietly break that contract, so the record
 * carries the token it issued and the same one is handed back until it enters
 * its last quarter of life. The stored token is a bearer capability, which is
 * why the store is 0600 user-only and workspace-local — it grants exactly what
 * an agent reading that workspace already has.
 *
 * Returning undefined is the honest answer, not a fallback: an unstorable
 * handle would validate cryptographically and then resolve to nothing, which is
 * the "silent wrong-state reuse" the whole feature exists to prevent. Callers
 * fall back to the pre-PI-09 identity (the raw fingerprint).
 */
export function mintTaskHandle(workspaceRoot: string, state: TaskHandleState): string | undefined {
  const store = stateStoreFor(workspaceRoot);
  if (store === undefined || !store.available) return undefined;
  if (state.taskFingerprint === "") return undefined;
  try {
    const payloadRef = taskPayloadRef(workspaceRoot, state.taskFingerprint, store.epoch);
    const key = payloadRef.toString("base64url");

    const existing = store.get(key);
    if (existing !== undefined && existing.purpose === "task") {
      const token = existing.data["token"];
      const freshUntil = existing.updatedAtMs + TASK_HANDLE_TTL_MS * 0.75;
      if (typeof token === "string" && Date.now() < freshUntil) {
        const check = validateHandleToken({ token, expectedPurpose: "task", workspaceRoot });
        if (check.ok) return token;
      }
    }

    const minted = mintHandle({
      purpose: "task",
      workspaceRoot,
      storeEpoch: store.epoch,
      stateVersion: (existing?.version ?? 0) + 1,
      ttlMs: TASK_HANDLE_TTL_MS,
      issuer: ISSUER,
      payloadRef,
    });
    const put = store.put({
      key,
      purpose: "task",
      data: { ...state, token: minted.token },
      ttlMs: TASK_HANDLE_TTL_MS,
      expectedVersion: existing?.version ?? 0,
    });
    if (!put.ok) return undefined;
    return minted.token;
  } catch {
    return undefined;
  }
}

/**
 * Validate a caller-supplied `task_handle` and resolve its state.
 *
 * The outcome ladder is the point: `wrong-purpose` (a continuation or context
 * token in a task slot), `invalid` (tamper/unknown key), `expired`,
 * `wrong-workspace`, `wrong-subject`, `stale` (the store moved to a new
 * generation) and `unknown` (the store lost the record) are all DISTINCT, so
 * the refusal layer can name the recovery instead of guessing.
 */
export function resolveTaskHandle(token: string, workspaceRoot: string): TaskHandleResolution {
  const validation = validateHandleToken({ token, expectedPurpose: "task", workspaceRoot });
  if (!validation.ok) return { ok: false, outcome: validation.outcome, ...(validation.detail !== undefined ? { detail: validation.detail } : {}) };

  const store = stateStoreFor(workspaceRoot);
  if (store === undefined || !store.available) {
    return { ok: false, outcome: "store-unavailable", detail: "no durable state store for this workspace" };
  }
  if (validation.decoded.stateStoreEpoch !== store.epoch) {
    // The store was reset or rebuilt: the handle names a generation that no
    // longer exists. Distinct from `unknown` because the RECOVERY is the same
    // but the CAUSE is operational, and telemetry needs to tell them apart.
    return { ok: false, outcome: "stale", detail: "handle belongs to a previous state-store generation" };
  }
  const record = store.get(validation.decoded.payloadRef);
  if (record === undefined) {
    return { ok: false, outcome: "unknown", detail: "state store no longer holds this task's state" };
  }
  if (record.purpose !== "task") {
    return { ok: false, outcome: "wrong-purpose", detail: "stored record is not task state" };
  }
  const state = asTaskState(record);
  if (state === undefined) {
    return { ok: false, outcome: "unknown", detail: "stored task state is unreadable" };
  }
  return { ok: true, state, stateVersion: record.version };
}

function asTaskState(record: StoredRecord): TaskHandleState | undefined {
  const data = record.data;
  if (typeof data["taskFingerprint"] !== "string" || data["taskFingerprint"] === "") return undefined;
  return {
    taskFingerprint: data["taskFingerprint"],
    ...(typeof data["replay"] === "string" ? { replay: data["replay"] } : {}),
    ...(typeof data["coverage"] === "string" ? { coverage: data["coverage"] } : {}),
    mintedAtMs: typeof data["mintedAtMs"] === "number" ? data["mintedAtMs"] : record.updatedAtMs,
  };
}

// ---------------------------------------------------------------------------
// Continuation handles
// ---------------------------------------------------------------------------

export type ContinuationResolution<T> =
  | { ok: true; payload: T }
  | { ok: false; outcome: HandleFailure; detail?: string };

/**
 * Mint a self-contained continuation token carrying `payload` in the
 * authenticated (NOT encrypted) tail.
 *
 * `payload` must therefore contain nothing an agent may not read — a
 * workspace-RELATIVE path and a line number qualify; an absolute path, a source
 * body or a credential do not. Returns undefined when the payload does not fit
 * the wire ceiling, so the caller keeps its pre-PI-09 token rather than
 * emitting an oversized one.
 */
export function mintContinuationHandle(workspaceRoot: string, payload: unknown): string | undefined {
  const aad = Buffer.from(JSON.stringify(payload), "utf8");
  if (aad.length > MAX_AAD_BYTES) return undefined;
  try {
    const store = stateStoreFor(workspaceRoot);
    return mintHandle({
      purpose: "continuation",
      workspaceRoot,
      // A continuation is store-INDEPENDENT by construction, so it is stamped
      // with the store generation only when one exists; a workspace with no
      // writable store still pages correctly.
      storeEpoch: store?.available === true ? store.epoch : "00000000",
      stateVersion: 0,
      ttlMs: CONTINUATION_HANDLE_TTL_MS,
      aad,
      issuer: ISSUER,
    }).token;
  } catch {
    return undefined;
  }
}

/** Validate + decode a continuation token minted by `mintContinuationHandle`. */
export function resolveContinuationHandle<T = unknown>(
  token: string,
  workspaceRoot?: string,
): ContinuationResolution<T> {
  const validation = validateHandleToken({
    token,
    expectedPurpose: "continuation",
    ...(workspaceRoot !== undefined ? { workspaceRoot } : {}),
  });
  if (!validation.ok) {
    return { ok: false, outcome: validation.outcome, ...(validation.detail !== undefined ? { detail: validation.detail } : {}) };
  }
  try {
    return { ok: true, payload: JSON.parse(validation.aad.toString("utf8")) as T };
  } catch {
    return { ok: false, outcome: "invalid", detail: "continuation payload is not readable" };
  }
}

// ---------------------------------------------------------------------------
// Content-handle persistence (restart recovery for `h…` handles)
// ---------------------------------------------------------------------------

/**
 * Mints buffered for the current call. Flushed ONCE per tool call rather than
 * appended per mint: a single task_pack mints dozens of handles, and one
 * batched append keeps the store off the hot path while still landing on disk
 * BEFORE the response is emitted — which is what makes "kill the server the
 * instant it answers, then replay the handle" a deterministic test rather than
 * a race.
 */
const _pending: HandleEntry[] = [];

export function recordHandleEntry(entry: HandleEntry): void {
  _pending.push(entry);
  // A pathological single call cannot grow this without bound.
  if (_pending.length > 4096) _pending.splice(0, _pending.length - 4096);
}

/** Persist everything buffered. Safe to call when nothing is pending. */
export function flushHandleEntries(): void {
  if (_pending.length === 0) return;
  const batch = _pending.splice(0, _pending.length);
  const byRoot = new Map<string, HandleEntry[]>();
  for (const entry of batch) {
    const list = byRoot.get(entry.workspaceRoot);
    if (list === undefined) byRoot.set(entry.workspaceRoot, [entry]);
    else list.push(entry);
  }
  for (const [root, entries] of byRoot) {
    const store = stateStoreFor(root);
    if (store === undefined || !store.available) continue;
    for (const entry of entries) {
      try {
        store.put({
          key: entry.id,
          purpose: "content",
          data: entry as unknown as Record<string, unknown>,
          ttlMs: CONTENT_ENTRY_TTL_MS,
        });
      } catch {
        // Persistence is best-effort; the in-process table is authoritative
        // for this call either way.
      }
    }
  }
}

/**
 * Restart recovery: look `id` up in `workspaceRoot`'s store.
 *
 * The workspace binding is re-asserted here rather than trusted: a record is
 * only returned when the ENTRY names the same root the caller resolved, so a
 * store copied between workspaces cannot smuggle a handle across.
 */
export function rehydrateHandleEntry(id: string, workspaceRoot: string): HandleEntry | undefined {
  const store = stateStoreFor(workspaceRoot);
  if (store === undefined || !store.available) return undefined;
  const record = store.get(id);
  if (record === undefined || record.purpose !== "content") return undefined;
  const data = record.data as unknown as HandleEntry;
  if (typeof data !== "object" || data === null) return undefined;
  if (data.id !== id || typeof data.workspaceRoot !== "string") return undefined;
  if (data.workspaceRoot !== workspaceRoot) return undefined;
  return data;
}

/** Installation identity is stable across restarts; exposed for diagnostics. */
export function stateHandleInstallationId(): string {
  return handleKeyRing().installationId;
}

/** Test hook: drop anything buffered but not yet written. */
export function resetPendingHandleEntriesForTests(): void {
  _pending.length = 0;
}
