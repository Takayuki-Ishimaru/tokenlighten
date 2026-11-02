// ---------------------------------------------------------------------------
// B1 and B2b -- a read's own bytes, and a first look at separate rows. Through the
// real `callTool`, with `TL_LEGACY_INPUT` removed so every call is canonical.
// ---------------------------------------------------------------------------

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { callTool } from "../server.js";
import { handleTable, shaOfBytes } from "../util/handles.js";
import { resetAll as resetAllSessions } from "../util/session.js";
import { resetArtifactSectionPrefetch, resetPackDedupeCache, resetRoleInventoryCache } from "../tools/readCodeTaskPack.js";
import { resetRootResolverCache, setActiveRootWorkspace } from "../tools/locateTaskContext.js";
import { ledgerCoverage } from "../state/readRequestStore.js";
import { resolveSnapshot, SNAPSHOT_MAX_BLOBS, snapshotDirForTest, takeSnapshot } from "../state/snapshotStore.js";

type Json = Record<string, unknown>;

const NEEDLE = "gateway-timeout";
const created: string[] = [];
let workspace = "";
let savedEnv: Record<string, string | undefined>;
const ENV_KEYS = ["TL_ARTIFACT_QUERY_WINDOW", "TL_READ_SNAPSHOT", "TL_SPARSE_SELECT", "TL_LEGACY_INPUT"] as const;

function resetServerState(): void {
  handleTable.reset();
  resetAllSessions();
  resetPackDedupeCache();
  resetRoleInventoryCache();
  resetArtifactSectionPrefetch();
  resetRootResolverCache();
  setActiveRootWorkspace(workspace);
}

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) { savedEnv[key] = process.env[key]; delete process.env[key]; }
  process.env["TL_ARTIFACT_QUERY_WINDOW"] = "1";
  process.env["TL_READ_SNAPSHOT"] = "1";
  workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.homedir(), ".tl-b1-")));
  created.push(workspace);
  resetServerState();
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.restoreAllMocks();
});

afterAll(() => {
  for (const ws of created) { try { fs.rmSync(ws, { recursive: true, force: true }); } catch { /* best effort */ } }
});

async function read(args: Json): Promise<Json> {
  const reply = await callTool("tl_read_file", { cwd: workspace, ...args });
  return JSON.parse((reply as { content: Array<{ text: string }> }).content[0]!.text) as Json;
}

function write(rel: string, text: string): string {
  fs.writeFileSync(path.join(workspace, rel), text, "utf8");
  return rel;
}

function table(rows: number, marks: Record<number, string> = {}, label = "plain"): string {
  const lines = ["id,service,status,detail"];
  for (let i = 0; i < rows; i += 1) lines.push(`${i},svc-${i % 7},${marks[i] ?? "ok"},${label} detail text for row number ${i}`);
  return `${lines.join("\n")}\n`;
}

const windowCall = (rel: string, query: string, extra: Json = {}): Json => ({ targets: [{ path: rel }], select: { kind: "csv" }, query, ...extra });
const content = (reply: Json): Json => reply["content"] as Json;
const rowsOf = (reply: Json): unknown[][] => (content(reply)?.["rows"] ?? []) as unknown[][];
const nextOf = (reply: Json): Json | undefined => ((reply["limit"] as Json | undefined)?.["next"] as Json | undefined)?.["arguments"] as Json | undefined;
const handleOf = (reply: Json): string => (reply["snapshot"] as Json)["handle"] as string;
const expand = (token: string, range?: string, extra: Json = {}): Promise<Json> =>
  read({ targets: [{ handle: token, ...(range !== undefined ? { range } : {}) }], ...extra });

async function follow(first: Json): Promise<{ ids: number[]; replies: Json[] }> {
  const ids = rowsOf(first).map((row) => Number(row[0]));
  const replies = [first];
  let reply = first;
  for (let call = 0; nextOf(reply) !== undefined; call += 1) {
    if (call > 100) throw new Error("no termination");
    reply = await read(nextOf(reply)!);
    expect(reply["kind"], JSON.stringify(reply).slice(0, 300)).toBe("read.artifact");
    replies.push(reply);
    ids.push(...rowsOf(reply).map((row) => Number(row[0])));
  }
  return { ids, replies };
}

const everyRow = (rows: number): number[] => Array.from({ length: rows }, (_, i) => i);
const sorted = (ids: readonly number[]): number[] => [...ids].sort((a, b) => a - b);

describe("B1: the revision a read saw", () => {
  it("announces a handle, and a range of it is exact", async () => {
    const rel = write("events.csv", table(1500, { 1480: NEEDLE }));
    const first = await read(windowCall(rel, NEEDLE));
    expect(handleOf(first)).toMatch(/^tlh_snap_v1_/);
    expect(first["source"]).toEqual({ status: "current" });

    const part = await expand(handleOf(first), "12-14");
    expect(part["kind"]).toBe("read.artifact");
    expect(rowsOf(part).map((row) => row[0])).toEqual(["10", "11", "12"]);
    expect(content(part)["range"]).toBe("12-14");
    expect(part["source"]).toEqual({ status: "current" });
  });

  it("after the file changes, the old rows come back, labelled, and the ledger learns nothing", async () => {
    const rel = write("events.csv", table(1500, { 1480: NEEDLE }, "old"));
    const first = await read(windowCall(rel, NEEDLE));
    const changed = table(1500, { 3: NEEDLE }, "new");
    write(rel, changed);
    const currentSha = shaOfBytes(Buffer.from(changed, "utf8"));

    const part = await expand(handleOf(first), "12-14");
    expect(String(rowsOf(part)[0]![3])).toContain("old detail");
    expect(part["source"]).toEqual({ status: "moved", current_sha: expect.any(String) });
    // Not the current text, so not held against the current revision.
    expect(ledgerCoverage(workspace, rel, currentSha)).toEqual([]);

    // A fresh read sees the new content and a new snapshot, and the old handle still sees the old.
    const fresh = await read(windowCall(rel, NEEDLE));
    expect(rowsOf(fresh).some((row) => row[0] === "3" && row[2] === NEEDLE)).toBe(true);
    expect(handleOf(fresh)).not.toBe(handleOf(first));
    const again = await expand(handleOf(first), "1482-1482");
    expect(rowsOf(again)[0]![2]).toBe(NEEDLE);
  });

  it("expanding part of a snapshot holds only that part", async () => {
    const rel = write("events.csv", table(1500, { 1480: NEEDLE }));
    const bytes = fs.readFileSync(path.join(workspace, rel));
    const first = await read(windowCall(rel, NEEDLE));
    const heldAfterWindow = ledgerCoverage(workspace, rel, shaOfBytes(bytes));
    await expand(handleOf(first), "12-14");
    const held = ledgerCoverage(workspace, rel, shaOfBytes(bytes));
    expect(held.length).toBe(heldAfterWindow.length + 1);
    expect(held.some((window) => window.start === 2 && window.end > 1000)).toBe(false);
  });

  it("a cursor chain survives a source change: every page is the old revision, and says so", async () => {
    const rel = write("events.csv", table(800, { 790: NEEDLE }, "old"));
    const first = await read(windowCall(rel, NEEDLE));
    write(rel, table(50, {}, "new"));
    const run = await follow(first);
    expect(sorted(run.ids)).toEqual(everyRow(800));
    for (const reply of run.replies.slice(1)) {
      expect(reply["source"]).toEqual({ status: "moved", current_sha: expect.any(String) });
      for (const row of rowsOf(reply)) expect(String(row[3])).toContain("old detail");
    }
  });

  it("a moved page keeps to its budget, as an unmoved one does", async () => {
    for (const bytes of [2_000, 2_400, 3_000, 4_000]) {
      resetServerState();
      const rel = write("events.csv", table(1500, { 1480: NEEDLE }, "old"));
      const first = await read(windowCall(rel, NEEDLE));
      write(rel, table(1500, {}, "new"));
      const page = await read({ ...nextOf(first)!, budget: { bytes } });
      expect(page["kind"], `budget ${bytes}: ${JSON.stringify(page).slice(0, 200)}`).toBe("read.artifact");
      expect(Buffer.byteLength(JSON.stringify(page), "utf8"), `budget ${bytes}`).toBeLessThanOrEqual(bytes);
      expect(page["source"]).toEqual({ status: "moved", current_sha: expect.any(String) });
      fs.rmSync(path.join(workspace, rel));
    }
  });

  it("an inherited budget holds on a moved page too", async () => {
    const rel = write("events.csv", table(1500, { 1480: NEEDLE }, "old"));
    const first = await read(windowCall(rel, NEEDLE, { budget: { bytes: 4_000 } }));
    write(rel, table(1500, {}, "new"));
    const page = await read(nextOf(first)!);
    expect(page["kind"]).toBe("read.artifact");
    expect(Buffer.byteLength(JSON.stringify(page), "utf8")).toBeLessThanOrEqual(4_000);
  });

  it("an expansion wider than one read says how to get the rest, and a handle will not be paired with another path", async () => {
    const rel = write("events.csv", table(800, { 790: NEEDLE }));
    const token = handleOf(await read(windowCall(rel, NEEDLE)));
    const wide = await expand(token, "2-801");
    expect(rowsOf(wide)).toHaveLength(200);
    expect(String(content(wide)["note"])).toMatch(/fetch more with range=202-/);
    const mismatched = await read({ targets: [{ handle: token, path: "other.csv", range: "2-3" }] });
    expect(mismatched["code"]).toBe("snapshot-unavailable");
  });

  it("a deleted source still serves its snapshot, and says it is gone", async () => {
    const rel = write("events.csv", table(800, { 790: NEEDLE }));
    const first = await read(windowCall(rel, NEEDLE));
    fs.rmSync(path.join(workspace, rel));
    const part = await expand(handleOf(first), "2-3");
    expect(rowsOf(part)).toHaveLength(2);
    expect(part["source"]).toEqual({ status: "missing" });
  });

  it("without the flag a source change refuses as it always has, and the handle is no snapshot", async () => {
    const rel = write("events.csv", table(800, { 790: NEEDLE }));
    const taken = await read(windowCall(rel, NEEDLE));
    const token = handleOf(taken);
    delete process.env["TL_READ_SNAPSHOT"];
    resetServerState();
    const first = await read(windowCall(rel, NEEDLE));
    expect(first["snapshot"]).toBeUndefined();
    write(rel, table(800, {}, "new"));
    expect((await read(nextOf(first)!))["code"]).toBe("cursor-stale");
    expect((await expand(token, "2-3"))["kind"]).toBe("refusal");
  });

  describe("explicit failure, never the latest file", () => {
    async function taken(): Promise<{ rel: string; token: string }> {
      const rel = write("events.csv", table(800, { 790: NEEDLE }));
      return { rel, token: handleOf(await read(windowCall(rel, NEEDLE))) };
    }

    function expectUnavailable(reply: Json, reason: RegExp): void {
      expect(reply["kind"]).toBe("refusal");
      expect(reply["code"]).toBe("snapshot-unavailable");
      expect(String(reply["detail"])).toMatch(reason);
      expect(rowsOf(reply)).toEqual([]);
      expect(reply["next"]).toBeUndefined();
    }

    it("expired", async () => {
      const { token } = await taken();
      const now = Date.now();
      vi.spyOn(Date, "now").mockReturnValue(now + 2 * 60 * 60 * 1000);
      expectUnavailable(await expand(token, "2-3"), /expired/);
    });

    it("evicted", async () => {
      const { token } = await taken();
      for (const blob of fs.readdirSync(snapshotDirForTest(workspace))) fs.rmSync(path.join(snapshotDirForTest(workspace), blob));
      expectUnavailable(await expand(token, "2-3"), /evicted/);
    });

    it("corrupt, and the damaged bytes are set aside", async () => {
      const { token } = await taken();
      const dir = snapshotDirForTest(workspace);
      const blob = fs.readdirSync(dir)[0]!;
      fs.writeFileSync(path.join(dir, blob), "id,x\n1,tampered\n");
      expectUnavailable(await expand(token, "2-3"), /corrupt/);
      expect(fs.existsSync(path.join(dir, blob))).toBe(false);
    });

    it("another lane", async () => {
      const rel = write("events.csv", table(800, { 790: NEEDLE }));
      const token = handleOf(await read(windowCall(rel, NEEDLE, { lane: "alpha" })));
      expectUnavailable(await expand(token, "2-3", { lane: "beta" }), /wrong-lane/);
      expect((await expand(token, "2-3", { lane: "alpha" }))["kind"]).toBe("read.artifact");
    });

    it("a forged token", async () => {
      await taken();
      expectUnavailable(await expand("tlh_snap_v1_notarealtokenatall", "2-3"), /invalid/);
    });
  });

  it("session memory loss does not lose it: the store and the blob are durable", async () => {
    const rel = write("events.csv", table(800, { 790: NEEDLE }));
    const token = handleOf(await read(windowCall(rel, NEEDLE)));
    resetServerState();
    expect(rowsOf(await expand(token, "2-3"))).toHaveLength(2);
  });

  it("a file over the item limit reads as ever, without a snapshot and without a false promise", async () => {
    const big = table(90_000, { 89_990: NEEDLE });
    expect(Buffer.byteLength(big)).toBeGreaterThan(4 * 1024 * 1024);
    const rel = write("big.csv", big);
    const first = await read(windowCall(rel, NEEDLE));
    expect(first["kind"]).toBe("read.artifact");
    expect(first["snapshot"]).toBeUndefined();
    expect(rowsOf(first).some((row) => row[2] === NEEDLE)).toBe(true);
  });

  it("bounds its storage: the least recently used goes first, and its handle says so", () => {
    const take = (i: number) => takeSnapshot({ workspaceRoot: workspace, lane: "", path: `f${i}.csv`, sourceSha: `s${i}`, format: "csv", bytes: Buffer.from(`a,b\n${i},x\n`) })!;
    const first = take(0);
    let clock = Date.now();
    const blobFile = (name: string) => path.join(snapshotDirForTest(workspace), name);
    const age = (name: string) => { clock -= 1_000; fs.utimesSync(blobFile(name), new Date(clock), new Date(clock)); };
    age(fs.readdirSync(snapshotDirForTest(workspace))[0]!);
    for (let i = 1; i <= SNAPSHOT_MAX_BLOBS; i += 1) take(i);
    expect(fs.readdirSync(snapshotDirForTest(workspace)).length).toBeLessThanOrEqual(SNAPSHOT_MAX_BLOBS);
    expect(resolveSnapshot(first.handle, workspace, "")).toEqual({ ok: false, reason: "evicted" });
  }, 60_000);

  it("the same content in the same lane is one blob", () => {
    const bytes = Buffer.from("a,b\n1,x\n");
    const input = { workspaceRoot: workspace, lane: "", path: "same.csv", sourceSha: "s", format: "csv" as const, bytes };
    takeSnapshot(input);
    takeSnapshot(input);
    expect(fs.readdirSync(snapshotDirForTest(workspace))).toHaveLength(1);
  });
});

describe("B2b: a sparse first view", () => {
  beforeEach(() => {
    process.env["TL_SPARSE_SELECT"] = "1";
  });

  const FAR = { 200: NEEDLE, 1100: NEEDLE };

  it("shows separate runs, labels them partial, and every position maps to the source", async () => {
    const rel = write("events.csv", table(1500, FAR));
    const first = await read(windowCall(rel, NEEDLE));
    const c = content(first);
    expect(c["selected_by"]).toBe("sparse");
    expect(String(c["note"])).toMatch(/a partial view/);
    expect(String(c["note"])).toMatch(/neither that a value is absent nor that the table is complete/);
    expect(JSON.stringify(first)).not.toMatch(/lossless/);
    const spans = c["row_spans"] as Array<{ range: string; file_range: string; rows: number }>;
    expect(spans.length).toBeGreaterThanOrEqual(2);
    expect(c["counts"]).toEqual({ total: 1500, scanned: 1500, shown: rowsOf(first).length });
    expect(c["file_range"]).toBeUndefined();

    // Walking rows through row_spans lands every row on its own logical number.
    const rows = rowsOf(first);
    let cursor = 0;
    for (const span of spans) {
      const start = Number(span.range.split("-")[0]);
      for (let i = 0; i < span.rows; i += 1) expect(Number(rows[cursor + i]![0]) + 2).toBe(start + i);
      cursor += span.rows;
    }
    expect(cursor).toBe(rows.length);
    expect(rows.filter((row) => row[2] === NEEDLE)).toHaveLength(2);
    expect(rows.length).toBeLessThan(100);
  });

  it("the rest of the table still arrives through the cursor, exactly", async () => {
    const rel = write("events.csv", table(1200, { 100: NEEDLE, 1100: NEEDLE }));
    const first = await read(windowCall(rel, NEEDLE));
    expect(content(first)["selected_by"]).toBe("sparse");
    const run = await follow(first);
    expect(sorted(run.ids)).toEqual(everyRow(1200));
    expect(new Set(run.ids).size).toBe(run.ids.length);
    expect(nextOf(run.replies.at(-1)!)).toBeUndefined();
  });

  it("after a task pack holds one match, its next still reaches the others, and repeats only their neighbours", async () => {
    const rel = write("events.csv", table(1500, { 100: NEEDLE, 500: NEEDLE, 900: NEEDLE, 1400: NEEDLE }));
    const pack = await read({ targets: [{ path: rel }], query: `which rows in ${rel} report ${NEEDLE}?`, task: { epoch: "new" } });
    const entry = (((pack["plan"] as Json | undefined)?.["artifact_sections"] ?? pack["artifact_sections"]) as Json[])[0]!;
    const held = ((entry["section"] as Json)["rows"] as string[][]).map((row) => Number(row[0]));
    const first = await read((entry["next"] as Json)["arguments"] as Json);
    expect(content(first)["selected_by"]).toBe("sparse");
    expect(rowsOf(first).filter((row) => row[2] === NEEDLE).map((row) => Number(row[0]))).toEqual([100, 500, 900, 1400]);
    const run = await follow(first);
    expect(sorted([...new Set([...held, ...run.ids])])).toEqual(everyRow(1500));
    expect(run.ids.length + held.length - 1500).toBeLessThanOrEqual(6);
  });

  it("after a task pack holds the only match, its next moves on rather than repeating it", async () => {
    const rel = write("events.csv", table(1500, { 1400: NEEDLE }));
    const pack = await read({ targets: [{ path: rel }], query: `which rows in ${rel} report ${NEEDLE}?`, task: { epoch: "new" } });
    const entry = (((pack["plan"] as Json | undefined)?.["artifact_sections"] ?? pack["artifact_sections"]) as Json[])[0]!;
    const held = ((entry["section"] as Json)["rows"] as string[][]).map((row) => Number(row[0]));
    expect(held).toContain(1400);
    const first = await read((entry["next"] as Json)["arguments"] as Json);
    expect(content(first)["selected_by"]).toBeUndefined();
    const run = await follow(first);
    expect(sorted([...held, ...run.ids])).toEqual(everyRow(1500));
  });

  it("any hidden range is reachable exactly through the snapshot", async () => {
    const rel = write("events.csv", table(1500, FAR));
    const first = await read(windowCall(rel, NEEDLE));
    const hidden = await expand(handleOf(first), "702-704");
    expect(rowsOf(hidden).map((row) => row[0])).toEqual(["700", "701", "702"]);
  });

  it("holds only the runs it showed, so an edit or a later read of the rest is not grounded on it", async () => {
    const text = table(1500, FAR);
    const rel = write("events.csv", text);
    const first = await read(windowCall(rel, NEEDLE));
    const held = ledgerCoverage(workspace, rel, shaOfBytes(Buffer.from(text, "utf8")));
    const shown = rowsOf(first).length;
    expect(held.reduce((sum, window) => sum + (window.end - window.start + 1), 0)).toBe(shown);
  });

  it("stays within a declared budget", async () => {
    const rel = write("events.csv", table(1500, FAR));
    const first = await read(windowCall(rel, NEEDLE, { budget: { bytes: 3_000 } }));
    expect(first["kind"]).toBe("read.artifact");
    expect(Buffer.byteLength(JSON.stringify(first), "utf8")).toBeLessThanOrEqual(3_000);
  });

  it("one run has nothing to gain: it stays the plain window", async () => {
    const rel = write("events.csv", table(1500, { 1480: NEEDLE }));
    const first = await read(windowCall(rel, NEEDLE));
    expect(content(first)["selected_by"]).toBe("query");
    expect(content(first)["row_spans"]).toBeUndefined();
  });

  it("is inert without the snapshot flag", async () => {
    delete process.env["TL_READ_SNAPSHOT"];
    const rel = write("events.csv", table(1500, FAR));
    const first = await read(windowCall(rel, NEEDLE));
    expect(content(first)["selected_by"]).toBe("query");
  });

  it("a repeat of the question moves forward rather than resending the same runs", async () => {
    const rel = write("events.csv", table(1500, FAR));
    const first = await read(windowCall(rel, NEEDLE));
    const second = await read(windowCall(rel, NEEDLE));
    const firstIds = new Set(rowsOf(first).map((row) => row[0]));
    expect(rowsOf(second).length).toBeGreaterThan(0);
    expect(rowsOf(second).every((row) => !firstIds.has(row[0]))).toBe(true);
  });
});
