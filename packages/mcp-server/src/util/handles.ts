/**
 * handles.ts — per-process handle table for v0.6 transactional context.
 *
 * A handle is a short reference to a repo/file/symbol/range/text or
 * reference-set. The table is a singleton.
 *
 * No I/O in this module. Hashing only over caller-supplied text.
 *
 * v0.10 PI-09 (alpha.2): the table is no longer *necessarily* process-local.
 * `setHandlePersistence` installs an OPTIONAL durable backing (implemented in
 * `state/stateHandles.ts` over the per-workspace state store) so a restarted
 * server resolves a handle it minted in a previous life instead of dead-ending
 * on `handle-unknown`. This module stays I/O-free: it only calls the hooks it
 * was given, and with no hooks installed its behavior is byte-identical to
 * v0.9. Rehydration is scoped by `runWithCallWorkspace` so a lookup can never
 * reach into a workspace the current call did not resolve.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomBytes } from "node:crypto";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type HandleKind =
  | "repo"
  | "file"
  | "symbol"
  | "range"
  | "text"
  | "reference-set"
  | "scope"
  | "directory";

/**
 * PI-09 purpose discriminator. `kind` says WHAT a handle addresses
 * (file/symbol/range/…); `purpose` says WHY it was minted — a separate
 * namespace, so a content handle can never be redeemed where a `task_handle`
 * or `continuation_token` is required (T-PI09-02, "wrong purpose … acceptance
 * = 0"). Every handle this table mints is `"content"`; the other three
 * purposes live in the `tlh_*` wire namespace (`state/stateHandles.ts`) and
 * never appear in this table.
 */
export type HandlePurpose = "content";

export interface HandleEntry {
  /** Unguessable session-local capability identifier with an `h` prefix. */
  id: string;
  /**
   * Why this handle exists, as opposed to what it points at. Always
   * `"content"` for table-minted handles — see `HandlePurpose`.
   */
  purpose: HandlePurpose;
  kind: HandleKind;
  /** Workspace-relative POSIX path (omit for repo / scope handles). */
  path?: string;
  /** Inclusive 1-based "start-end" line range. */
  range?: string;
  /** Symbol name when the handle targets a symbol. */
  symbol?: string;
  /** Absolute, fully resolved workspace root used for scoping. */
  workspaceRoot: string;
  /**
   * True when some call in this handle's LINEAGE actually named `workspaceRoot`
   * — an explicit `cwd`, or an earlier declared handle this call adopted.
   *
   * A handle otherwise records only WHICH root a call resolved against, never
   * whether the caller chose it: a `cwd`-less mint silently captures the
   * server's pinned launch root, and a later `cwd`-less edit adopts it back
   * with nothing to disagree with. That closed loop is the 2026-08-09
   * root-mismatch incident. This flag is the missing premise — the write guard
   * refuses a workspace nobody ever declared, while a declared chain keeps
   * working `cwd`-lessly for as many hops as it likes.
   *
   * Monotone: once true it is never cleared (an `upsert` onto an existing
   * entry may upgrade it, never downgrade). Absent means "not declared".
   */
  workspaceDeclared?: boolean;
  /** sha256 of the underlying content slice (omit for scope/repo handles). */
  sha?: string;
  /** For reference-set / scope handles: the set of constituent paths. */
  paths?: string[];
  /** Monotonic sequence number (NOT Date.now). */
  createdAt: number;
}

// ---------------------------------------------------------------------------
// Internal constants
// ---------------------------------------------------------------------------

/** Maximum entries before the oldest 1/4 are evicted. */
const DEFAULT_CAP = 1024;

/** Fixed width (chars) of a handle id's random suffix, after the `h` prefix. */
const BASE36_ID_LENGTH = 10;

/**
 * Total width (chars) of a minted handle id: the `h` prefix plus the fixed
 * base36 suffix. Every id this table hands out is EXACTLY this long.
 *
 * Exported for B2 (2026-08-04 review): a caller that must size a response
 * BEFORE the handle exists has to charge itself the real width, or its byte
 * accounting silently lies. evidenceShadow.ts's pending-evidence placeholder
 * derives its length from this so a future id-format change cannot reopen the
 * gap unnoticed.
 */
export const HANDLE_ID_LENGTH = 1 + BASE36_ID_LENGTH;

/**
 * 36^BASE36_ID_LENGTH — modulus that keeps a reduced random value within
 * exactly BASE36_ID_LENGTH base36 digits (0-9a-z) once zero-padded. Yields
 * ~51.7 bits of effective entropy (10 * log2(36)) from a 64-bit random draw.
 */
const BASE36_ID_SPACE = 36n ** BigInt(BASE36_ID_LENGTH);

// ---------------------------------------------------------------------------
// Declared-workspace scope
// ---------------------------------------------------------------------------

/**
 * The workspace root the CURRENT call declared, if any. Async-scoped (not a
 * plain module variable) so interleaved tool calls can never inherit each
 * other's declaration — the same reason state/session.ts scopes `lane`.
 * The empty string means "this call declared nothing".
 */
const _declaredWorkspace = new AsyncLocalStorage<string>();

/**
 * Run `fn` with `root` recorded as the workspace THIS call declared. Every
 * handle minted inside — at any depth, by any tool module — whose own
 * `workspaceRoot` equals `root` is stamped `workspaceDeclared`. Pass undefined
 * for a call that named no workspace; the scope is still entered, so an outer
 * declaration can never leak into it.
 */
export function runWithDeclaredWorkspace<T>(root: string | undefined, fn: () => T): T {
  return _declaredWorkspace.run(root ?? "", fn);
}

/** The workspace root the current call declared, or undefined. */
export function declaredWorkspace(): string | undefined {
  const root = _declaredWorkspace.getStore();
  return root === undefined || root === "" ? undefined : root;
}

/**
 * The workspace root the current call RESOLVED against, declared or not.
 *
 * Distinct from `_declaredWorkspace` on purpose: declaration is a security
 * premise (who chose the root) and must stay narrow, while rehydration needs
 * to know which store to read — a question every call can answer. Keeping them
 * apart means installing a durable backing cannot widen the write guard.
 */
const _callWorkspace = new AsyncLocalStorage<string>();

/** Run `fn` with `root` recorded as the workspace this call resolved against. */
export function runWithCallWorkspace<T>(root: string | undefined, fn: () => T): T {
  return _callWorkspace.run(root ?? "", fn);
}

/** The workspace root the current call resolved against, or undefined. */
export function callWorkspace(): string | undefined {
  const root = _callWorkspace.getStore();
  return root === undefined || root === "" ? undefined : root;
}

// ---------------------------------------------------------------------------
// Optional durable backing (PI-09)
// ---------------------------------------------------------------------------

/**
 * The seam between this I/O-free module and the state store. `record` is
 * called for every mint (buffered by the implementation, not written per
 * call); `rehydrate` is consulted ONLY on a `get` miss, and only for the
 * workspace the current call resolved against.
 */
export interface HandlePersistenceHooks {
  record(entry: HandleEntry): void;
  rehydrate(id: string, workspaceRoot: string): HandleEntry | undefined;
}

let _persistence: HandlePersistenceHooks | undefined;

/** Install (or, with undefined, remove) the durable backing. */
export function setHandlePersistence(hooks: HandlePersistenceHooks | undefined): void {
  _persistence = hooks;
}

// ---------------------------------------------------------------------------
// Canonical key
// ---------------------------------------------------------------------------

/**
 * Build a deduplication key from the mutable fields of a handle.
 * Two upsert calls with the same key return the same id.
 */
/**
 * Whether a mint inherits the current call's declaration. A caller may also
 * pass `workspaceDeclared` explicitly (e.g. when re-minting from an already
 * declared entry); either source is sufficient, neither is required.
 */
/**
 * What a mint site supplies. `purpose` is OPTIONAL on the way in and TOTAL on
 * the way out: every existing call site keeps compiling, and no minted entry
 * can be missing its discriminator.
 */
export type HandleMintInput =
  & Omit<HandleEntry, "id" | "createdAt" | "purpose">
  & { purpose?: HandlePurpose };

function mintIsDeclared(entry: HandleMintInput): boolean {
  if (entry.workspaceDeclared === true) return true;
  const declared = declaredWorkspace();
  return declared !== undefined && entry.workspaceRoot === declared;
}

function canonicalKey(entry: HandleMintInput): string {
  return JSON.stringify([
    entry.kind,
    entry.path ?? "",
    entry.range ?? "",
    entry.symbol ?? "",
    entry.sha ?? "",
    entry.workspaceRoot,
    // paths are not included in the key because scope/reference-set handles
    // rarely need canonicalization, and the ordering would need normalisation.
    // If this becomes an issue, sort + join can be added here.
  ]);
}

// ---------------------------------------------------------------------------
// HandleTable class
// ---------------------------------------------------------------------------

export class HandleTable {
  private readonly _cap: number;
  private _counter: number;
  private _entries: Map<string, HandleEntry>;       // id -> entry
  private _canonical: Map<string, string>;          // canonical key -> id

  constructor(cap = DEFAULT_CAP) {
    this._cap = cap;
    this._counter = 0;
    this._entries = new Map();
    this._canonical = new Map();
  }

  // -------------------------------------------------------------------------
  // create — always mints a new entry even if an equivalent one exists.
  // -------------------------------------------------------------------------
  create(entry: HandleMintInput): HandleEntry {
    this._maybeEvict();
    this._counter += 1;
    let id: string;
    do {
      // Compact wire shape: `h` + BASE36_ID_LENGTH base36 chars (0-9a-z)
      // derived from 64 random bits reduced mod BASE36_ID_SPACE and
      // zero-padded to a fixed width (~51.7 bits of effective entropy — still
      // unguessable within a session; the while-loop below re-rolls on the
      // astronomically rare duplicate). Replaces the previous 19-digit random
      // decimal suffix (20 chars total after `h`), which cost ~6-7 tokens per
      // echoed handle instead of ~1 and ate into the 32768-byte task-pack
      // transport ceiling on handle-heavy responses.
      const value = randomBytes(8).readBigUInt64BE() % BASE36_ID_SPACE;
      id = `h${value.toString(36).padStart(BASE36_ID_LENGTH, "0")}`;
    } while (this._entries.has(id));
    const full: HandleEntry = {
      ...entry,
      purpose: entry.purpose ?? "content",
      ...(mintIsDeclared(entry) ? { workspaceDeclared: true } : {}),
      id,
      createdAt: this._counter,
    };
    this._entries.set(id, full);
    _persistence?.record(full);
    return full;
  }

  // -------------------------------------------------------------------------
  // get — look up an entry by id.
  //
  // PI-09 (T-PI09-03): a MISS consults the durable backing before it becomes a
  // `handle-unknown` refusal, so a handle minted before a server restart still
  // resolves. Three properties make that safe rather than merely convenient:
  //
  //  - the lookup is scoped to `callWorkspace()`, so it can only ever read the
  //    store of the workspace THIS call already resolved against;
  //  - the rehydrated entry's own `workspaceRoot` is re-checked by the
  //    implementation, so a store carried between workspaces resolves nothing;
  //  - with no backing installed the miss is a miss, exactly as in v0.9.
  //
  // A rehydrated entry is promoted into the in-memory table so the rest of the
  // call — and every later call in this process — takes the fast path.
  // -------------------------------------------------------------------------
  get(id: string): HandleEntry | undefined {
    const live = this._entries.get(id);
    if (live !== undefined) return live;
    if (_persistence === undefined) return undefined;
    const workspace = callWorkspace();
    if (workspace === undefined) return undefined;
    const restored = _persistence.rehydrate(id, workspace);
    if (restored === undefined) return undefined;
    this._maybeEvict();
    this._counter += 1;
    const adopted: HandleEntry = { ...restored, createdAt: this._counter };
    this._entries.set(id, adopted);
    this._canonical.set(canonicalKey(adopted), id);
    return adopted;
  }

  // -------------------------------------------------------------------------
  // upsert — canonical: if an equivalent entry exists (same kind, path, range,
  // symbol, sha, workspaceRoot) reuse its id; otherwise create a new one.
  // -------------------------------------------------------------------------
  upsert(entry: HandleMintInput): HandleEntry {
    const key = canonicalKey(entry);
    const existingId = this._canonical.get(key);
    if (existingId !== undefined) {
      const existing = this._entries.get(existingId);
      if (existing !== undefined) {
        // workspaceDeclared is deliberately OUTSIDE canonicalKey (it describes
        // how the caller named the root, not which bytes the handle points at,
        // so it must never fork the dedup identity). Upgrade in place when a
        // declaring call reuses an entry a silent one minted; never downgrade.
        if (existing.workspaceDeclared !== true && mintIsDeclared(entry)) {
          const upgraded: HandleEntry = { ...existing, workspaceDeclared: true };
          this._entries.set(existingId, upgraded);
          _persistence?.record(upgraded);
          return upgraded;
        }
        return existing;
      }
      // The entry was evicted; fall through to create a new one.
      this._canonical.delete(key);
    }

    const created = this.create(entry);
    this._canonical.set(key, created.id);
    return created;
  }

  // -------------------------------------------------------------------------
  // refreshSha — DESIGN-v0.8 B3.3: re-key an existing entry to a post-edit
  // sha (and optionally a post-edit range) IN PLACE, i.e. the id the caller
  // already has stays valid and now reflects the new content.
  //
  // Why this can't be `entry.sha = newSha`: canonicalKey (above) folds sha
  // INTO the dedup key, so a plain field mutation would leave the OLD
  // canonical-key -> id mapping in `_canonical` pointing at an entry whose
  // stored sha no longer matches that key — a future upsert() with the
  // PRE-edit sha would incorrectly resolve to this now-stale-keyed id
  // (upsert looks up `_canonical.get(canonicalKey(newEntryArgs))`, using the
  // CALLER-supplied sha, not the stored one, so the stale mapping is a real,
  // reachable bug, not a latent one). This method deletes the OLD canonical
  // mapping first, then registers the NEW one, so:
  //   - upsert(...) with the OLD (pre-edit) sha no longer resolves here —
  //     it falls through to minting a genuinely new entry, as it should
  //     (that combination of kind/path/range/sha/workspaceRoot no longer
  //     describes anything live).
  //   - upsert(...) with the NEW (post-edit) sha resolves to this SAME id.
  //   - get(id) — the id the caller already has in hand — returns the
  //     entry with the refreshed sha/range immediately, no upsert needed.
  // -------------------------------------------------------------------------
  refreshSha(id: string, newSha: string, newRange?: string): HandleEntry | undefined {
    // `get`, not `_entries.get`: a post-edit re-key must reach a handle the
    // caller legitimately holds from before a restart, or the edit path would
    // keep the pre-PI-09 dead end that reads no longer have.
    const existing = this.get(id);
    if (existing === undefined) return undefined;

    const oldKey = canonicalKey(existing);
    if (this._canonical.get(oldKey) === id) {
      this._canonical.delete(oldKey);
    }

    const refreshed: HandleEntry = {
      ...existing,
      sha: newSha,
      ...(newRange !== undefined ? { range: newRange } : {}),
    };
    this._entries.set(id, refreshed);

    const newKey = canonicalKey(refreshed);
    this._canonical.set(newKey, id);
    _persistence?.record(refreshed);

    return refreshed;
  }

  // -------------------------------------------------------------------------
  // size — number of live entries.
  // -------------------------------------------------------------------------
  size(): number {
    return this._entries.size;
  }

  // -------------------------------------------------------------------------
  // reset — clear all state (test hook).
  // -------------------------------------------------------------------------
  reset(): void {
    this._counter = 0;
    this._entries.clear();
    this._canonical.clear();
  }

  // -------------------------------------------------------------------------
  // Private: evict oldest 1/4 when the cap is exceeded.
  // -------------------------------------------------------------------------
  private _maybeEvict(): void {
    if (this._entries.size < this._cap) return;

    // Collect entries sorted by createdAt ascending (oldest first).
    const sorted = Array.from(this._entries.values()).sort(
      (a, b) => a.createdAt - b.createdAt,
    );
    const evictCount = Math.ceil(this._cap / 4);
    for (let i = 0; i < evictCount && i < sorted.length; i++) {
      const e = sorted[i]!;
      this._entries.delete(e.id);
      // Remove canonical key mapping if it still points at this entry.
      const key = canonicalKey(e);
      if (this._canonical.get(key) === e.id) {
        this._canonical.delete(key);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Module-level singleton
// ---------------------------------------------------------------------------

export const handleTable: HandleTable = new HandleTable();

// ---------------------------------------------------------------------------
// shaOfText — deterministic sha256 over caller-supplied text.
// ---------------------------------------------------------------------------

export function shaOfText(text: string): string {
  const hex = createHash("sha256").update(text, "utf8").digest("hex");
  return `sha256:${hex}`;
}

// ---------------------------------------------------------------------------
// shaOfBytes — deterministic sha256 over the FULL byte content of a binary
// artifact (DESIGN-v0.8 B5.2).
// ---------------------------------------------------------------------------

/**
 * B5.2: mode=artifact (and the office-doc mode=full downgrade / xlsx roster
 * paths in server.ts) used to hash `Buffer.from(bytes).toString("base64").
 * slice(0, 64)` — 64 base64 CHARACTERS encode only the first 48 RAW BYTES
 * (base64 is 3 bytes -> 4 chars), so two different workbooks that share the
 * same first 48 bytes (e.g. the same xlsx ZIP/OOXML header) reported
 * IDENTICAL shas despite having different content. Hash the full byte
 * content instead — no truncation.
 *
 * Hashes the raw Buffer directly (createHash accepts a Buffer without a
 * text-encoding argument). A prior version routed through
 * `Buffer.from(bytes).toString("base64")` before hashing — encoding to
 * base64 first is a lossless bijection of the input bytes so it was not
 * WRONG, but it is wasteful: it allocates a ~1.33x-larger base64 string (and
 * the UTF-8 re-encode of that string inside `update(..., "utf8")`) purely to
 * throw the encoding away again inside the hash, ~2.7x the transient
 * allocations of hashing the bytes directly. This changes the digest VALUE
 * from prior versions (hashing different input bytes necessarily does) —
 * safe here because every shaOfBytes consumer is a session-scoped in-memory
 * handle pin (HandleTable entries, compared only within the same process/
 * request), not a value persisted to disk or compared against a
 * previously-stored/hardcoded digest across process runs.
 */
export function shaOfBytes(bytes: Uint8Array): string {
  const hex = createHash("sha256").update(Buffer.from(bytes)).digest("hex");
  return `sha256:${hex}`;
}

// ---------------------------------------------------------------------------
// shortSha — response-formatting helper only (DESIGN-v0.8 C10.1).
// ---------------------------------------------------------------------------

/** Minimum hex-digit prefix length accepted as "short enough to be usable
 * but long enough to avoid collisions" — matches checkPreconditions'
 * prefix-tolerance floor in write/preconditions.ts. */
export const SHORT_SHA_MIN_HEX = 12;

/**
 * Truncate a full `sha256:<64-hex>` digest to a short display prefix for
 * RESPONSE bodies only (default 12 hex chars, e.g. `sha256:ab12cd34ef56`,
 * 19 chars vs the full 71). Callers can round-trip a copied short sha back
 * as `expectedSha` — write/preconditions.ts accepts any >=12-hex prefix of
 * the current file's full sha.
 *
 * NOT used for the `sha` field stored on a HandleEntry (handles.ts
 * `canonicalKey`) or passed into `handleTable.create/upsert` — those MUST
 * stay on the full sha, or handle dedupe/canonicalization would collapse
 * distinct content into one canonical key. Apply this ONLY at the point a
 * sha value is placed into a JSON response, never before minting/looking up
 * a handle.
 */
export function shortSha(fullSha: string, n: number = SHORT_SHA_MIN_HEX): string {
  const m = /^sha256:([0-9a-f]+)$/.exec(fullSha);
  if (!m) return fullSha; // not our format (e.g. already-short or malformed) — pass through unchanged.
  const hex = m[1]!;
  return `sha256:${hex.slice(0, Math.max(n, 0))}`;
}
