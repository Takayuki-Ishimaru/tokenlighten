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
import { currentSessionLane } from "../util/laneKey.js";
import { rawContractQueryForScope } from "../features/task-pack/taskContractStore.js";

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
  /** Digest of the monotone obligation ledger for restart-safe proof binding. */
  ledgerDigest?: string;
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
        if (check.ok) {
          // FX-M1/B4: the freshness/validity check above only ever decided
          // whether to keep the SAME token (the re-emit contract this
          // function's own doc comment requires — `TaskRef.id` must survive
          // re-packs of the same task). It never decided whether to keep the
          // OLD DATA, but the code used to return here before any write,
          // discarding the caller's just-computed `replay`/`coverage`/
          // `ledgerDigest` and leaving `resolveTaskHandle` serving whatever
          // the FIRST mint of this fingerprint recorded — for up to 18h
          // (75% of the 24h TTL). Persist the caller's current state under
          // the SAME token every time instead: identity stays stable (the
          // hard guarantee), and the record a later `resolveTaskHandle`
          // returns is never more than one mint stale. A lost CAS race
          // (`put.ok === false`, some other call advanced this record
          // between the `get` above and this `put`) is not an error here —
          // the token itself is still valid and is returned regardless; the
          // next mint call for this fingerprint will persist again.
          store.put({
            key,
            purpose: "task",
            data: { ...state, token },
            ttlMs: TASK_HANDLE_TTL_MS,
            expectedVersion: existing.version,
          });
          return token;
        }
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
    ...(typeof data["ledgerDigest"] === "string" ? { ledgerDigest: data["ledgerDigest"] } : {}),
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
// Fetch-request handles (DESIGN-v0.15 R2 read cursor / R3 search cursor)
// ---------------------------------------------------------------------------

/**
 * A FOURTH namespace on the same store, and the reason it is not the third.
 *
 * `continuation` is SELF-CONTAINED: the page position rides the token's own
 * `aad` and nothing is stored. A fetch request cannot work that way — §5.1
 * requires it to carry the ORIGINAL request Q, the recomputed remainder D, the
 * fixed page list, the source revision of every target and the canonical
 * original input to restart from, which is far past `MAX_AAD_BYTES` and must
 * survive a restart and be CAS-updated. So the token here is an ADDRESS
 * (`payloadRef` -> a store record) exactly like a `task` handle, and the `aad`
 * carries only a short binding digest that the MAC then authenticates.
 *
 * `stateVersion` IS THE PAGE SELECTOR. The token carries no page number; the
 * record's `pages[].cursor_state_version` is matched against the decoded
 * `stateVersion` instead, which makes "the same cursor names the same logical
 * page" a lookup and makes a page-N cursor structurally unable to advance to
 * page N+1 (§5.2: "再送された同じcursorは同じ論理ページを参照し、その再送で別の
 * ページへ進めない").
 */
export type FetchRequestPurpose = "read-request" | "search-request";

/** A page cursor is short-lived by nature; an hour covers any real paging run. */
export const FETCH_REQUEST_HANDLE_TTL_MS = 60 * 60 * 1000;

export type FetchRequestResolution =
  | { ok: true; record: StoredRecord; stateVersion: number; payloadRef: string }
  | { ok: false; outcome: HandleFailure; detail?: string };

/** Nine raw bytes of a sha256, the store-key form `handleCodec` requires. */
export function fetchRequestPayloadRef(seed: string): Buffer {
  return Buffer.from(shaOfText(`fetch-request:${seed}`).slice("sha256:".length), "hex").subarray(0, 9);
}

/**
 * Mint a cursor addressing an ALREADY-PERSISTED fetch-request record.
 *
 * The caller persists first and passes the record's CAS `version` as
 * `stateVersion`, so the token and the record it names can never disagree
 * about which generation of the request this cursor belongs to.
 */
export function mintFetchRequestHandle(input: {
  workspaceRoot: string;
  purpose: FetchRequestPurpose;
  payloadRef: Buffer;
  stateVersion: number;
  bindingDigest: string;
}): string | undefined {
  const store = stateStoreFor(input.workspaceRoot);
  if (store === undefined || !store.available) return undefined;
  const aad = Buffer.from(input.bindingDigest, "utf8");
  if (aad.length > MAX_AAD_BYTES) return undefined;
  try {
    return mintHandle({
      purpose: input.purpose,
      workspaceRoot: input.workspaceRoot,
      storeEpoch: store.epoch,
      stateVersion: input.stateVersion,
      ttlMs: FETCH_REQUEST_HANDLE_TTL_MS,
      issuer: ISSUER,
      payloadRef: input.payloadRef,
      aad,
    }).token;
  } catch {
    return undefined;
  }
}

/**
 * Validate a caller-supplied cursor and return the record it addresses.
 *
 * Same outcome ladder as `resolveTaskHandle`, for the same reason: the refusal
 * layer names one recovery per cause, and `stale` (the store generation moved)
 * must stay distinguishable from `unknown` (the record itself expired).
 */
export function resolveFetchRequestHandle(
  token: string,
  workspaceRoot: string,
  purpose: FetchRequestPurpose,
): FetchRequestResolution {
  const validation = validateHandleToken({ token, expectedPurpose: purpose, workspaceRoot });
  if (!validation.ok) {
    return { ok: false, outcome: validation.outcome, ...(validation.detail !== undefined ? { detail: validation.detail } : {}) };
  }
  const store = stateStoreFor(workspaceRoot);
  if (store === undefined || !store.available) {
    return { ok: false, outcome: "store-unavailable", detail: "no durable state store for this workspace" };
  }
  if (validation.decoded.stateStoreEpoch !== store.epoch) {
    return { ok: false, outcome: "stale", detail: "cursor belongs to a previous state-store generation" };
  }
  const record = store.get(validation.decoded.payloadRef);
  if (record === undefined) {
    return { ok: false, outcome: "unknown", detail: "state store no longer holds this request" };
  }
  if (record.purpose !== purpose) {
    return { ok: false, outcome: "wrong-purpose", detail: "stored record is not a fetch request of this family" };
  }
  return {
    ok: true,
    record,
    stateVersion: validation.decoded.stateVersion,
    payloadRef: validation.decoded.payloadRef,
  };
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

// ---------------------------------------------------------------------------
// Task-query-ref persistence (G2, 2026-09-04 — DESIGN-v0.15 §0.3(ll))
// ---------------------------------------------------------------------------

/**
 * `state/session.ts`'s `activeTaskQuery` used to live ONLY in the in-process
 * `WorkspaceSession` map: a plain, unpersisted field. Two things made that a
 * live dead end rather than a session-scoped nicety:
 *
 *  - a `qref` (the natural-language query keyed by its own content hash) is
 *    the ONLY way `resolveTaskPackQueryArg` (`server.ts`) can replay a
 *    task_pack without the caller restating the query text; a server restart
 *    or a reconnect against a fresh process left that map empty, so the
 *    caller's own `qref` refused as `unknown-or-stale-qref` with nothing to
 *    do but retype the request from scratch.
 *  - the persisted task handle (`mintTaskHandle`/`resolveTaskHandle` above)
 *    ALREADY carries a `replay` field that is exactly this qref — so the
 *    task ledger surviving a restart while the qref ledger did not meant a
 *    task handle's own prescribed recovery (`{qref: state.replay, task:
 *    {epoch:"new"}}`) was itself an executable-looking call that silently
 *    resolved to nothing post-restart.
 *
 * The fix mirrors the content-handle pattern immediately above rather than
 * the MAC-authenticated task/continuation tokens: a `qref` is not a bearer
 * capability (resolving it only reveals query text the caller already
 * supplied to mint it), so a plain, unsigned store record is the honest
 * shape — same posture as `recordHandleEntry`/`rehydrateHandleEntry`.
 *
 * R27 M1 (2026-09-04): the slot ITSELF holds no query text — this module's
 * own header (PI-09 item 7) is explicit that persisted state keeps natural-
 * language query text to the necessary minimum, and a THIRD verbatim copy
 * sitting in this store's append-only `journal.ndjson` (every superseded
 * value too, since the journal is never rewritten in place) is exactly the
 * opposite of minimum. `persistQueryRef` writes only `ref` and a workspace-
 * salted `queryHash`; `rehydrateQueryRef` recovers the text from the record
 * `features/task-pack/taskContractStore.ts`'s `recordTaskContract` already
 * persists for the same (workspace, lane) — the FIRST pack of a task epoch
 * writes its full source query there as the requirement model's identity
 * anchor, so a plain query/qref pack (no explicit `task_handle`, the default
 * scope) already has exactly this text on disk before this slot is ever
 * consulted. The recovered text is never trusted on the scope match alone:
 * it is re-hashed and compared against `queryHash`, so a stale, evicted, or
 * wrong-scope contract record fails closed exactly like an unresolvable ref
 * — this module never fabricates a match. When no contract record survives
 * (evicted, or the epoch never wrote one), rehydration honestly misses; the
 * caller's own `unknown-or-stale-qref` recovery already echoes back whatever
 * query text the SAME call supplied, so nothing upstream depends on this
 * slot being the last copy standing.
 *
 * SINGLE SLOT, ON PURPOSE. `activeTaskQuery` in `session.ts` has always been
 * one field, not a table: minting a new qref supersedes whatever the
 * workspace's session was holding, and `taskEpoch:"new"` clears it outright
 * (`clearTaskQueryRef`). The persisted record mirrors that exactly — ONE key
 * per (workspace, lane), overwritten on every `rememberTaskQuery` and deleted
 * on every `clearTaskQueryRef` — so a superseded or epoch-cleared qref is
 * exactly as unresolvable after a restart as it is within one live process.
 * Keying by ref instead (one row per minted qref) would let an OLD,
 * already-superseded ref outlive its in-memory supersession purely because
 * the disk write raced ahead of the next mint, silently reopening a task the
 * caller (or the workspace's own epoch boundary) had already moved past.
 *
 * LANE-SCOPED. The physical store file is per-workspace, not per-lane, so the
 * slot KEY folds in `currentSessionLane()` — otherwise two lanes sharing one
 * workspace would hand each other's qref back, the exact cross-lane leak
 * `util/handles.ts`'s `laneOf`/`canonicalKey` partition content handles to
 * prevent.
 */
const QREF_SLOT_PREFIX = "qref-active";

/** Persisted qref entries share the task ledger's restart horizon. */
const QUERY_REF_TTL_MS = TASK_HANDLE_TTL_MS;

function qrefSlotKey(): string {
  const lane = currentSessionLane();
  // Empty lane is the ordinary single-agent session: keep the historical
  // (unsuffixed) key shape so every lane-less workspace's store gains no new
  // key shape at all, matching `util/handles.ts`'s own "absent means no lane"
  // convention.
  return lane === "" ? QREF_SLOT_PREFIX : `${QREF_SLOT_PREFIX}:${lane}`;
}

/**
 * Workspace-salted validation hash for a qref's query text — never used to
 * RECOVER the text, only to confirm a candidate recovered elsewhere is the
 * one this slot actually minted. Salted with `workspaceRoot` so identical
 * query text in two workspaces hashes differently, matching every other
 * cross-workspace boundary this store enforces.
 */
function qrefQueryHash(workspaceRoot: string, query: string): string {
  return shaOfText(`${workspaceRoot}\u0000${query}`);
}

/**
 * Persist (ref, queryHash) as the workspace+lane's single active qref slot,
 * overwriting whatever the slot held before. Best-effort: a write failure (no
 * store, read-only workspace) leaves the in-process session as the sole,
 * pre-G2 authority for this call — never an error the caller sees.
 *
 * R27 M1: no query TEXT is written here — see the section header. `query` is
 * still the parameter shape callers already pass (`rememberTaskQuery`'s own
 * signature is unchanged); only its on-disk representation changed.
 *
 * G3 (2026-09-08, qref-binding fix): an optional 4th field, `taskBinding` —
 * the SAME opaque, server-derived task fingerprint the executed-next ledger
 * partitions on (`util/packServeLog.ts`'s `executedNextLedgerKey`), never
 * natural-language text, so it is exempt from the R27 M1 minimization this
 * function's header argues for. Storing it here is what lets a later,
 * handleless `read_file {qref}` re-pack recover the SAME partition a
 * `task.handle`-carrying execution of this task's own `next` was recorded
 * under — see `state/session.ts`'s `resolveTaskQueryRefBinding`. Omitted
 * (not even an empty string) when the caller has none to give, so an old
 * slot and a new bindingless mint are byte-identical on disk.
 *
 * G4 (2026-09-08, qref-task-scope fix): a 5th field, `taskHandle` — the
 * WIRE `task.id` this epoch's task minted (`server.ts`'s `withTaskHandle`),
 * a DIFFERENT value from `taskBinding` (the pre-mint canonical fingerprint):
 * `taskBinding` partitions the executed-next ledger, `taskHandle` is what a
 * later handleless re-pack must inject as `task_handle` so
 * `taskContractScopeOf` resolves the SAME `{lane, taskHandle}` scope
 * `taskContractStore.ts`'s `bindTaskContractHandle` relocated the
 * requirement/obligation ledger to — otherwise every bare-`{qref}` rebuild
 * reads an empty, just-vacated scope and loses the epoch's proven
 * requirements. Also exempt from R27 M1 (an opaque handle, never query
 * text); also omitted when absent, so a slot with only a `taskBinding` (or
 * neither) is byte-identical to before this field existed.
 */
export function persistQueryRef(
  workspaceRoot: string,
  ref: string,
  query: string,
  taskBinding?: string,
  taskHandle?: string,
): void {
  if (ref === "" || query === "") return;
  const store = stateStoreFor(workspaceRoot);
  if (store === undefined || !store.available) return;
  try {
    store.put({
      key: qrefSlotKey(),
      purpose: "qref",
      data: {
        ref,
        workspaceRoot,
        queryHash: qrefQueryHash(workspaceRoot, query),
        ...(typeof taskBinding === "string" && taskBinding !== "" ? { taskBinding } : {}),
        ...(typeof taskHandle === "string" && taskHandle !== "" ? { taskHandle } : {}),
      },
      ttlMs: QUERY_REF_TTL_MS,
    });
  } catch {
    /* best-effort, as above */
  }
}

/**
 * Shared validation for both `rehydrateQueryRef` and `rehydrateQueryRefBinding`
 * — everything through "this ref is the slot's CURRENT contents", stopping
 * short of picking which field the caller actually wants. See
 * `rehydrateQueryRef`'s own doc comment for the recovery/validation rationale;
 * this is a pure factoring, not a behavior change.
 */
function _rehydrateQueryRecord(
  workspaceRoot: string,
  ref: string,
): { data: Record<string, unknown>; query: string } | undefined {
  if (ref === "") return undefined;
  const store = stateStoreFor(workspaceRoot);
  if (store === undefined || !store.available) return undefined;
  const record = store.get(qrefSlotKey());
  if (record === undefined || record.purpose !== "qref") return undefined;
  const data = record.data;
  if (data["ref"] !== ref) return undefined;
  if (data["workspaceRoot"] !== workspaceRoot) return undefined;
  if (typeof data["queryHash"] !== "string" || data["queryHash"] === "") return undefined;
  const candidate = rawContractQueryForScope(workspaceRoot, { lane: currentSessionLane() });
  if (candidate === undefined || candidate === "") return undefined;
  if (qrefQueryHash(workspaceRoot, candidate) !== data["queryHash"]) return undefined;
  return { data, query: candidate };
}

/**
 * Restart recovery for `resolveTaskQueryRef`: consult the durable slot ONLY
 * when the in-process session has none, and only for the workspace+lane the
 * current call resolved against — re-asserted from the stored `workspaceRoot`
 * field rather than trusted, same discipline as `rehydrateHandleEntry`. A
 * `ref` that does not match the slot's CURRENT contents (superseded by a
 * later `rememberTaskQuery`, or cleared by `taskEpoch:"new"`) is exactly as
 * unresolvable as it would be against a live in-memory session — see the
 * single-slot rationale above.
 *
 * R27 M1: the slot itself carries no text to return, only `queryHash`. The
 * text comes from `taskContractStore.rawContractQueryForScope` — the same
 * (workspace, lane) with no task handle, the default scope a plain
 * query/qref pack writes under — and is accepted ONLY when it re-hashes to
 * this slot's `queryHash`; anything else (no contract record survived, or one
 * survived but hashes to something else) is exactly as unresolvable as a
 * truly unknown ref.
 */
export function rehydrateQueryRef(workspaceRoot: string, ref: string): string | undefined {
  return _rehydrateQueryRecord(workspaceRoot, ref)?.query;
}

/**
 * G3 (2026-09-08): companion to `rehydrateQueryRef` — the task binding
 * `persistQueryRef` stored alongside this qref, or undefined for a slot
 * minted before this field existed (a legacy slot has no `taskBinding` key at
 * all, which reads back exactly like an unset one — never a refusal). Shares
 * every validation `rehydrateQueryRef` applies via `_rehydrateQueryRecord`, so
 * a ref that fails to resolve its query text never reports a stale binding
 * either.
 */
export function rehydrateQueryRefBinding(workspaceRoot: string, ref: string): string | undefined {
  const binding = _rehydrateQueryRecord(workspaceRoot, ref)?.data["taskBinding"];
  return typeof binding === "string" && binding !== "" ? binding : undefined;
}

/**
 * G4 (2026-09-08): companion to `rehydrateQueryRefBinding` — the WIRE task
 * handle `persistQueryRef` stored alongside this qref (see that function's
 * own doc comment for why this is a distinct field from `taskBinding`), or
 * undefined for a slot minted before this field existed. Same validation via
 * `_rehydrateQueryRecord`, so a ref whose query text fails to resolve never
 * reports a stale handle either.
 */
export function rehydrateQueryRefHandle(workspaceRoot: string, ref: string): string | undefined {
  const handle = _rehydrateQueryRecord(workspaceRoot, ref)?.data["taskHandle"];
  return typeof handle === "string" && handle !== "" ? handle : undefined;
}

/** Explicit epoch boundary, mirrored onto the durable slot. */
export function clearPersistedQueryRef(workspaceRoot: string): void {
  const store = stateStoreFor(workspaceRoot);
  if (store === undefined || !store.available) return;
  try {
    store.delete(qrefSlotKey());
  } catch {
    /* best-effort, as above */
  }
}

/** Installation identity is stable across restarts; exposed for diagnostics. */
export function stateHandleInstallationId(): string {
  return handleKeyRing().installationId;
}

/** Test hook: drop anything buffered but not yet written. */
export function resetPendingHandleEntriesForTests(): void {
  _pending.length = 0;
}
