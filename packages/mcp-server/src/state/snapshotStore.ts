// ---------------------------------------------------------------------------
// snapshotStore.ts -- B1: the bytes of a read, as they were when it was read.
//
// A continuation normally refuses once its source moves, because it can only reach
// the current file. A snapshot keeps the fetched revision, so a later range of THAT
// revision is still exact. It answers "what did this read see", never "what does
// the file say now": a response built from one states whether the source has moved,
// and a re-read of the current file is never reported as a restoration.
//
// WHERE THINGS LIVE. The state store's journal is bounded for small records, so it
// holds only the metadata and the record is what a signed `tlh_snap_v1_` handle
// addresses, with the store's usual workspace, epoch and TTL rules. The bytes live
// beside it in `<workspace>/.tokenlighten/state/snapshots/<sha256>`, which is local
// runtime state already excluded from version control. Nothing here is traced.
//
// LIMITS, design values: one snapshot at most 4 MiB, 64 MiB and 256 blobs in total,
// and the same one hour as a read cursor, so a chain cannot outlive its snapshot. A
// blob is evicted least recently used, and its handle then says it is gone. Nothing
// here ever substitutes the current file or another snapshot.
// ---------------------------------------------------------------------------

import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { FETCH_REQUEST_HANDLE_TTL_MS, fetchRequestPayloadRef, mintFetchRequestHandle, resolveFetchRequestHandle } from "./stateHandles.js";
import { stateStoreFor } from "./stateStore.js";

export const SNAPSHOT_MAX_ITEM_BYTES = 4 * 1024 * 1024;
export const SNAPSHOT_MAX_TOTAL_BYTES = 64 * 1024 * 1024;
export const SNAPSHOT_MAX_BLOBS = 256;

export type SnapshotFormat = "csv" | "tsv";

export interface SnapshotRecordData {
  v: 1;
  path: string;
  /** The hash the rest of the server compares (`shaOfBytes`), not the blob's name. */
  source_sha: string;
  format: SnapshotFormat;
  bytes: number;
  lane: string;
  taken_at_ms: number;
  blob: string;
}

export type SnapshotFailure = "invalid" | "wrong-lane" | "expired" | "evicted" | "corrupt" | "unavailable";

export type SnapshotResolution =
  | { ok: true; data: SnapshotRecordData; bytes: Uint8Array }
  | { ok: false; reason: SnapshotFailure };

function snapshotDir(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".tokenlighten", "state", "snapshots");
}

/** Drops what is past its lifetime, then the least recently used until within limits. `keep` was just written. */
function sweep(dir: string, keep: string, nowMs: number): void {
  const blobs: Array<{ name: string; size: number; mtimeMs: number }> = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const file = path.join(dir, entry.name);
    try {
      const stat = fs.statSync(file);
      if (nowMs - stat.mtimeMs > FETCH_REQUEST_HANDLE_TTL_MS || !/^[0-9a-f]{64}$/.test(entry.name)) {
        if (entry.name !== keep) fs.rmSync(file, { force: true });
        continue;
      }
      blobs.push({ name: entry.name, size: stat.size, mtimeMs: stat.mtimeMs });
    } catch { /* another process may have removed it */ }
  }
  blobs.sort((a, b) => a.mtimeMs - b.mtimeMs || a.name.localeCompare(b.name));
  let total = blobs.reduce((sum, blob) => sum + blob.size, 0);
  let count = blobs.length;
  for (const blob of blobs) {
    if (total <= SNAPSHOT_MAX_TOTAL_BYTES && count <= SNAPSHOT_MAX_BLOBS) break;
    if (blob.name === keep) continue;
    try {
      fs.rmSync(path.join(dir, blob.name), { force: true });
      total -= blob.size;
      count -= 1;
    } catch { /* it is then still over, and the next take tries again */ }
  }
}

export interface TakeSnapshotInput {
  workspaceRoot: string;
  lane: string;
  path: string;
  sourceSha: string;
  format: SnapshotFormat;
  bytes: Uint8Array;
}

/** The handle of a snapshot of these bytes, or `undefined` when none could be kept: the read still works, without this guarantee. */
export function takeSnapshot(input: TakeSnapshotInput): { handle: string; takenAtMs: number } | undefined {
  if (input.bytes.byteLength > SNAPSHOT_MAX_ITEM_BYTES) return undefined;
  const store = stateStoreFor(input.workspaceRoot);
  if (store === undefined || !store.available) return undefined;
  try {
    const dir = snapshotDir(input.workspaceRoot);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const blob = createHash("sha256").update(input.bytes).digest("hex");
    const file = path.join(dir, blob);
    const nowMs = Date.now();
    if (fs.existsSync(file)) {
      fs.utimesSync(file, new Date(nowMs), new Date(nowMs));
    } else {
      const temporary = `${file}.${randomBytes(6).toString("hex")}.tmp`;
      fs.writeFileSync(temporary, input.bytes, { mode: 0o600, flag: "wx" });
      fs.renameSync(temporary, file);
    }
    sweep(dir, blob, nowMs);

    const seed = `snapshot:${input.workspaceRoot}:${input.lane}:${input.path}:${blob}`;
    const payloadRef = fetchRequestPayloadRef(seed);
    const key = payloadRef.toString("base64url");
    const data: SnapshotRecordData = {
      v: 1,
      path: input.path,
      source_sha: input.sourceSha,
      format: input.format,
      bytes: input.bytes.byteLength,
      lane: input.lane,
      taken_at_ms: nowMs,
      blob,
    };
    const put = store.put({
      key,
      purpose: "snapshot",
      data: data as unknown as Record<string, unknown>,
      ttlMs: FETCH_REQUEST_HANDLE_TTL_MS,
      expectedVersion: store.get(key)?.version ?? 0,
    });
    if (!put.ok) return undefined;
    const handle = mintFetchRequestHandle({
      workspaceRoot: input.workspaceRoot,
      purpose: "snapshot",
      payloadRef,
      stateVersion: put.record.version,
      bindingDigest: createHash("sha256").update(`${input.lane}|${input.path}|${blob}`, "utf8").digest("hex"),
    });
    return handle === undefined ? undefined : { handle, takenAtMs: nowMs };
  } catch {
    return undefined;
  }
}

function asData(value: Record<string, unknown>): SnapshotRecordData | undefined {
  return value["v"] === 1 && typeof value["path"] === "string" && typeof value["blob"] === "string" && /^[0-9a-f]{64}$/.test(value["blob"])
    && typeof value["source_sha"] === "string" && typeof value["lane"] === "string" && (value["format"] === "csv" || value["format"] === "tsv")
    ? value as unknown as SnapshotRecordData
    : undefined;
}

/** The bytes this handle names, or why not. There is no fallback path through here. */
export function resolveSnapshot(token: string, workspaceRoot: string, lane: string): SnapshotResolution {
  const resolved = resolveFetchRequestHandle(token, workspaceRoot, "snapshot");
  if (!resolved.ok) {
    if (resolved.outcome === "store-unavailable") return { ok: false, reason: "unavailable" };
    return { ok: false, reason: resolved.outcome === "expired" || resolved.outcome === "stale" || resolved.outcome === "unknown" ? "expired" : "invalid" };
  }
  const data = asData(resolved.record.data);
  if (data === undefined) return { ok: false, reason: "corrupt" };
  if (data.lane !== lane) return { ok: false, reason: "wrong-lane" };
  const file = path.join(snapshotDir(workspaceRoot), data.blob);
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(file);
  } catch {
    return { ok: false, reason: "evicted" };
  }
  if (createHash("sha256").update(bytes).digest("hex") !== data.blob) {
    // Kept aside rather than served, and out of the way of a later good write.
    try { fs.renameSync(file, `${file}.corrupt-${Date.now()}`); } catch { /* still not served */ }
    return { ok: false, reason: "corrupt" };
  }
  try {
    const now = new Date();
    fs.utimesSync(file, now, now);
  } catch { /* only its eviction order is affected */ }
  return { ok: true, data, bytes };
}

/** Test-only: where a workspace's blobs are. */
export function snapshotDirForTest(workspaceRoot: string): string {
  return snapshotDir(workspaceRoot);
}
