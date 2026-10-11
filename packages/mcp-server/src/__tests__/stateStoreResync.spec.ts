/**
 * stateStoreResync.spec.ts — the writer-side resync of WorkspaceStateStore
 * (2026-10-10 v0.15.1 runtime review, local processing time).
 *
 * Every put/delete used to re-read meta + snapshot + the WHOLE journal under
 * the writer lock, so a write's cost grew with the journal (0.5 ms at 50
 * lines to 5.4 ms at 500 on the measuring Mac) and a task_pack call makes
 * about a dozen writes. The resync now reloads only when the disk
 * fingerprint differs from the state this instance last synced. These cases
 * pin both halves: no reload while only this instance writes, and every
 * foreign write, compaction or corruption still taken in full.
 */
import { afterAll, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { WorkspaceStateStore } from "../state/stateStore.js";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

function workspace(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tl-resync-")));
  dirs.push(dir);
  return dir;
}

const put = (store: WorkspaceStateStore, key: string, n: number, expectedVersion?: number) =>
  store.put({ key, purpose: "task", data: { n }, ttlMs: 60_000, ...(expectedVersion !== undefined ? { expectedVersion } : {}) });

describe("state store resync — the journal is re-read only when another instance changed the disk", () => {
  it("consecutive writes by one instance never reload the journal", () => {
    const store = WorkspaceStateStore.open(workspace());
    expect(store.available).toBe(true);
    const loads = store.fullLoadsForTests;
    for (let i = 0; i < 60; i += 1) expect(put(store, `k${i % 7}`, i).ok).toBe(true);
    store.delete("k0");
    expect(store.fullLoadsForTests).toBe(loads);
    expect(store.get("k1")?.data).toEqual({ n: 57 });
    expect(store.get("k0")).toBeUndefined();
  });

  it("a write after another instance's write sees it: records and CAS versions", () => {
    const root = workspace();
    const a = WorkspaceStateStore.open(root);
    const b = WorkspaceStateStore.open(root);
    expect(put(a, "shared", 1).ok).toBe(true);
    expect(put(b, "shared", 2, 1).ok).toBe(true);
    const loads = a.fullLoadsForTests;
    expect(put(a, "shared", 3, 1)).toMatchObject({ ok: false, outcome: "state-conflict", currentVersion: 2 });
    expect(a.fullLoadsForTests).toBe(loads + 1);
    expect(a.get("shared")?.data).toEqual({ n: 2 });
    expect(put(a, "shared", 3, 2).ok).toBe(true);
    expect(put(b, "other", 1).ok).toBe(true);
    expect(b.get("shared")?.data).toEqual({ n: 3 });
  });

  it("another instance's compaction is taken in full, nothing lost", () => {
    const root = workspace();
    const a = WorkspaceStateStore.open(root);
    const b = WorkspaceStateStore.open(root);
    for (let i = 0; i < 5; i += 1) expect(put(a, `a${i}`, i).ok).toBe(true);
    expect(put(b, "b", 1).ok).toBe(true);
    b.compact();
    const loads = a.fullLoadsForTests;
    expect(put(a, "after", 1).ok).toBe(true);
    expect(a.fullLoadsForTests).toBe(loads + 1);
    for (const key of ["a0", "a4", "b", "after"]) expect(a.get(key), key).toBeDefined();
    const reopened = WorkspaceStateStore.open(root);
    for (const key of ["a0", "a4", "b", "after"]) expect(reopened.get(key), key).toBeDefined();
  });

  it("a reset that rewrites only meta.json in place (same inode, size and second) is still detected", () => {
    // EVO-X2 review (2026-10-10): on a filesystem with coarse mtimes, a reset
    // of a store with no snapshot or journal rewrites meta.json in place at a
    // fixed size, so every stat field can stay the same. Pin the mtime to a
    // whole second before and after the foreign rewrite to model that.
    const root = workspace();
    const metaPath = path.join(root, ".tokenlighten", "state", "meta.json");
    WorkspaceStateStore.open(root);
    const second = new Date(Math.floor(Date.now() / 1000) * 1000);
    fs.utimesSync(metaPath, second, second);
    const a = WorkspaceStateStore.open(root);
    const before = fs.statSync(metaPath, { bigint: true });
    const meta = JSON.parse(fs.readFileSync(metaPath, "utf8")) as { epoch: string };
    const foreignEpoch = meta.epoch === "abcdef12" ? "12abcdef" : "abcdef12";
    fs.writeFileSync(metaPath, fs.readFileSync(metaPath, "utf8").replace(meta.epoch, foreignEpoch), "utf8");
    fs.utimesSync(metaPath, second, second);
    const after = fs.statSync(metaPath, { bigint: true });
    expect([after.ino, after.size, after.mtimeNs]).toEqual([before.ino, before.size, before.mtimeNs]);
    expect(put(a, "k", 1).ok).toBe(true);
    expect(a.epoch).toBe(foreignEpoch);
  });

  it("a journal corrupted on disk after a skipped resync still fails closed on the next write", () => {
    const root = workspace();
    const store = WorkspaceStateStore.open(root);
    expect(put(store, "k", 1).ok).toBe(true);
    const epoch = store.epoch;
    fs.appendFileSync(path.join(root, ".tokenlighten", "state", "journal.ndjson"), "{not json\n");
    expect(put(store, "k2", 1).ok).toBe(true);
    expect(store.epoch).not.toBe(epoch);
    expect(store.get("k")).toBeUndefined();
  });
});
