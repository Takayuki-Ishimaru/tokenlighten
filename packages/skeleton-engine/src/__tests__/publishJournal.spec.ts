import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  readPublishJournal,
  writePendingPublishJournal,
  clearPublishJournal,
  getPublishJournalPath,
} from "../publishJournal.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = join(tmpdir(), `publishJournal-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await fs.mkdir(tmpDir, { recursive: true });
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("publishJournal — absent is the clean common case", () => {
  it("no journal file => pending:false, record:null", async () => {
    const status = await readPublishJournal(tmpDir);
    expect(status).toEqual({ pending: false, record: null });
  });

  it("clearPublishJournal on an absent journal is a safe no-op", async () => {
    await expect(clearPublishJournal(tmpDir)).resolves.toBeUndefined();
  });
});

describe("publishJournal — write / read / clear round-trip", () => {
  it("a pending record round-trips through readPublishJournal", async () => {
    await writePendingPublishJournal(tmpDir, 3, "hash-abc");
    const status = await readPublishJournal(tmpDir);
    expect(status.pending).toBe(true);
    expect(status.record).toEqual(
      expect.objectContaining({ v: 1, generation: 3, rootHash: "hash-abc" }),
    );
    expect(typeof status.record!.atMs).toBe("number");
  });

  it("clearPublishJournal removes a pending record", async () => {
    await writePendingPublishJournal(tmpDir, 1, "hash-x");
    await clearPublishJournal(tmpDir);
    const status = await readPublishJournal(tmpDir);
    expect(status).toEqual({ pending: false, record: null });
  });

  it("a second write overwrites the first (no unbounded growth)", async () => {
    await writePendingPublishJournal(tmpDir, 1, "hash-1");
    await writePendingPublishJournal(tmpDir, 2, "hash-2");
    const status = await readPublishJournal(tmpDir);
    expect(status.record!.generation).toBe(2);
    expect(status.record!.rootHash).toBe("hash-2");
  });
});

describe("publishJournal — fail-closed on corruption (mirrors loadManifest's discipline)", () => {
  it("corrupt JSON => pending:true, record:null, and preserves a .corrupt-<ts> sidecar", async () => {
    const journalPath = getPublishJournalPath(tmpDir);
    await fs.mkdir(join(tmpDir, ".tokenlighten", "index"), { recursive: true });
    await fs.writeFile(journalPath, "{ this is not valid json", "utf8");

    const status = await readPublishJournal(tmpDir);
    expect(status).toEqual({ pending: true, record: null });

    const dir = await fs.readdir(join(tmpDir, ".tokenlighten", "index"));
    expect(dir.some((name) => name.startsWith("publish-journal.v1.json.corrupt-"))).toBe(true);
  });

  it("wrong version => pending:true, record:null", async () => {
    const journalPath = getPublishJournalPath(tmpDir);
    await fs.mkdir(join(tmpDir, ".tokenlighten", "index"), { recursive: true });
    await fs.writeFile(journalPath, JSON.stringify({ v: 2, generation: 1, rootHash: "x", atMs: 1 }), "utf8");

    const status = await readPublishJournal(tmpDir);
    expect(status).toEqual({ pending: true, record: null });
  });

  it("wrong shape (missing rootHash) => pending:true, record:null", async () => {
    const journalPath = getPublishJournalPath(tmpDir);
    await fs.mkdir(join(tmpDir, ".tokenlighten", "index"), { recursive: true });
    await fs.writeFile(journalPath, JSON.stringify({ v: 1, generation: 1, atMs: 1 }), "utf8");

    const status = await readPublishJournal(tmpDir);
    expect(status).toEqual({ pending: true, record: null });
  });

  it("a directory in place of the journal file => pending:true, record:null (never throws)", async () => {
    const journalPath = getPublishJournalPath(tmpDir);
    await fs.mkdir(journalPath, { recursive: true });

    await expect(readPublishJournal(tmpDir)).resolves.toEqual({ pending: true, record: null });
  });
});

describe("publishJournal — crash mid-publish (beforeRename hook)", () => {
  it("a throw in beforeRename leaves no journal file behind and propagates the error", async () => {
    await expect(
      writePendingPublishJournal(tmpDir, 5, "hash-crash", {
        beforeRename: () => {
          throw new Error("simulated crash");
        },
      }),
    ).rejects.toThrow(/simulated crash/);

    // Old-consistent-state: no journal existed before this call, and none
    // exists after the simulated crash either — never a torn/partial file.
    const status = await readPublishJournal(tmpDir);
    expect(status).toEqual({ pending: false, record: null });

    // The tmp file was cleaned up too (atomicJson.ts's writeJsonAtomic
    // unlinks it on any post-write failure) — no orphaned litter.
    const dirExists = await fs
      .readdir(join(tmpDir, ".tokenlighten", "index"))
      .catch(() => [] as string[]);
    expect(dirExists.filter((n) => n.includes(".tmp"))).toEqual([]);
  });

  it("a throw in beforeRename on an UPDATE leaves the OLD record intact (old-or-new, never torn)", async () => {
    await writePendingPublishJournal(tmpDir, 1, "hash-old");
    await expect(
      writePendingPublishJournal(tmpDir, 2, "hash-new", {
        beforeRename: () => {
          throw new Error("simulated crash");
        },
      }),
    ).rejects.toThrow(/simulated crash/);

    const status = await readPublishJournal(tmpDir);
    expect(status.record!.generation).toBe(1);
    expect(status.record!.rootHash).toBe("hash-old");
  });
});
