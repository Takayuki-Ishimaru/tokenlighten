import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readUsageEvents } from "../index.js";
import { symlinkSupported } from "./helpers/symlinkSupported.js";

// Log rotation can unlink usage-YYYY-MM-DD.ndjson between readdirSync and the
// per-file lstat/read. `faults` injects exactly that window per path per stage;
// every other call passes through to the real filesystem.
const faults = vi.hoisted(() => ({
  lstat: new Map<string, NodeJS.ErrnoException>(),
  read: new Map<string, NodeJS.ErrnoException>(),
  lstatCalls: [] as string[],
  readCalls: [] as string[],
}));

vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  const lstat = fs.lstatSync as unknown as (...args: unknown[]) => unknown;
  const read = fs.readFileSync as unknown as (...args: unknown[]) => unknown;
  return {
    ...fs,
    lstatSync: (...args: unknown[]): unknown => {
      const key = String(args[0]);
      faults.lstatCalls.push(key);
      const fault = faults.lstat.get(key);
      if (fault !== undefined) throw fault;
      return lstat(...args);
    },
    readFileSync: (...args: unknown[]): unknown => {
      const key = String(args[0]);
      faults.readCalls.push(key);
      const fault = faults.read.get(key);
      if (fault !== undefined) throw fault;
      return read(...args);
    },
  };
});

const roots: string[] = [];
const DAY_1 = "2026-10-01";
const DAY_2 = "2026-10-02";
const DAY_3 = "2026-10-03";

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  faults.lstat.clear();
  faults.read.clear();
  faults.lstatCalls.length = 0;
  faults.readCalls.length = 0;
});

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: ${code === "ENOENT" ? "no such file or directory" : "i/o or permission error"}`), { code });
}

function logLine(occurredAt: string, workspaceId = "ws-1"): string {
  return `${JSON.stringify({
    schemaVersion: 2,
    eventId: `evt-${occurredAt}-${workspaceId}`,
    occurredAt,
    workspaceId,
    sessionId: "session-1",
    client: "codex",
    tool: "tl_read_file",
    outcome: "ok",
    durationMs: 5,
    responseBytes: 40,
    estimatedResponseTokens: 10,
    baselineTokens: 100,
    estimatedSavedTokens: 90,
    baselineMethod: "file-bytes",
    writeEnabled: false,
    taskRef: null,
  })}\n`;
}

/** Three healthy daily logs; returns the directory and the three file paths. */
function threeDayLogDir(): { dir: string; paths: Record<string, string> } {
  const root = mkdtempSync(join(tmpdir(), "tl-usage-rotation-"));
  roots.push(root);
  const dir = join(root, "log");
  mkdirSync(dir, { recursive: true });
  const paths: Record<string, string> = {};
  for (const day of [DAY_1, DAY_2, DAY_3]) {
    paths[day] = join(dir, `usage-${day}.ndjson`);
    writeFileSync(paths[day]!, logLine(`${day}T00:00:00.000Z`));
  }
  return { dir, paths };
}

describe("readUsageEvents log-rotation resilience", () => {
  it("keeps healthy logs when a rotated file disappears before lstat", () => {
    const { dir, paths } = threeDayLogDir();
    faults.lstat.set(paths[DAY_2]!, errno("ENOENT"));
    const events = readUsageEvents(dir);
    expect(events.map((event) => event.occurredAt)).toEqual([
      `${DAY_1}T00:00:00.000Z`,
      `${DAY_3}T00:00:00.000Z`,
    ]);
    expect(faults.lstatCalls).toContain(paths[DAY_3]);
  });

  it("keeps healthy logs when a rotated file disappears before read", () => {
    const { dir, paths } = threeDayLogDir();
    faults.read.set(paths[DAY_2]!, errno("ENOENT"));
    const events = readUsageEvents(dir);
    expect(events.map((event) => event.occurredAt)).toEqual([
      `${DAY_1}T00:00:00.000Z`,
      `${DAY_3}T00:00:00.000Z`,
    ]);
    expect(faults.readCalls).toContain(paths[DAY_3]);
  });

  it("returns no events when the only log rotates away mid-read", () => {
    const root = mkdtempSync(join(tmpdir(), "tl-usage-rotation-"));
    roots.push(root);
    const dir = join(root, "log");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `usage-${DAY_1}.ndjson`);
    writeFileSync(path, logLine(`${DAY_1}T00:00:00.000Z`));
    faults.read.set(path, errno("ENOENT"));
    expect(readUsageEvents(dir)).toEqual([]);
  });

  it("still applies the since window and workspace filter around a rotated file", () => {
    const { dir, paths } = threeDayLogDir();
    writeFileSync(paths[DAY_3]!, logLine(`${DAY_3}T00:00:00.000Z`, "ws-2"));
    faults.lstat.set(paths[DAY_2]!, errno("ENOENT"));
    expect(readUsageEvents(dir, `${DAY_2}T00:00:00.000Z`).map((e) => e.workspaceId))
      .toEqual(["ws-2"]);
    expect(readUsageEvents(dir, null, "ws-1").map((e) => e.occurredAt))
      .toEqual([`${DAY_1}T00:00:00.000Z`]);
  });

  it("rethrows a non-ENOENT lstat error instead of skipping the file", () => {
    const { dir, paths } = threeDayLogDir();
    faults.lstat.set(paths[DAY_2]!, errno("EACCES"));
    expect(() => readUsageEvents(dir)).toThrow(/EACCES/);
  });

  it("rethrows a non-ENOENT read error instead of skipping the file", () => {
    const { dir, paths } = threeDayLogDir();
    faults.read.set(paths[DAY_2]!, errno("EIO"));
    expect(() => readUsageEvents(dir)).toThrow(/EIO/);
  });

  it("still rejects symlink and directory entries without reading them", () => {
    const { dir, paths } = threeDayLogDir();
    const outside = join(roots[roots.length - 1]!, "outside.ndjson");
    writeFileSync(outside, logLine(`${DAY_2}T12:00:00.000Z`));
    const link = join(dir, `usage-${DAY_2}.ndjson`);
    rmSync(link);
    symlinkSupported() && symlinkSync(outside, link, "file");
    const fakeDir = join(dir, `usage-${DAY_3}.ndjson`);
    rmSync(fakeDir, { recursive: true, force: true });
    mkdirSync(fakeDir);
    const events = readUsageEvents(dir);
    expect(events.map((event) => event.occurredAt)).toEqual([`${DAY_1}T00:00:00.000Z`]);
    expect(faults.readCalls).not.toContain(symlinkSupported() ? link : fakeDir);
    expect(faults.readCalls).not.toContain(fakeDir);
  });

  it("keeps validating since before touching any log file", () => {
    const { dir, paths } = threeDayLogDir();
    faults.lstat.set(paths[DAY_1]!, errno("ENOENT"));
    expect(() => readUsageEvents(dir, "not-a-date")).toThrow(
      /Invalid TokenLighten usage window start/,
    );
    expect(faults.lstatCalls).toEqual([]);
    expect(faults.readCalls).toEqual([]);
  });

  it("returns no events for a missing log directory", () => {
    const root = mkdtempSync(join(tmpdir(), "tl-usage-rotation-"));
    roots.push(root);
    expect(readUsageEvents(join(root, "absent"))).toEqual([]);
  });
});
