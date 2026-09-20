/**
 * homeTempJanitor.spec.ts — the HOME-child fixture cleanup wired into both
 * vitest configs (helpers/homeTempJanitor.setup.ts).
 *
 * Regression shape (2026-09-20): specs create their workspace as a direct
 * child of HOME and nothing structural removed it, so 12,831 `~/.tl-*`
 * directories accumulated and a run died with ENOSPC. These cases pin the two
 * properties the fix rests on: every `mkdtemp` form is seen, and ONLY
 * directories this worker created directly under the real home are touched.
 */
import * as fs from "node:fs";
import { mkdtempSync as namedMkdtempSync } from "node:fs";
import { mkdtemp as promisesMkdtemp } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { sweepHomeTempDirs, trackedHomeTempDirs } from "./helpers/homeTempJanitor.setup.js";

const HOME = os.homedir();
const outsideHome: string[] = [];

afterAll(() => {
  for (const dir of outsideHome) fs.rmSync(dir, { recursive: true, force: true });
});

function isTracked(dir: string): boolean {
  return trackedHomeTempDirs.has(path.resolve(dir));
}

describe("homeTempJanitor: what gets tracked", () => {
  it("tracks a HOME child created through the namespace import, the named import and fs.promises", async () => {
    const viaNamespace = fs.mkdtempSync(path.join(HOME, ".tl-janitor-ns-"));
    const viaNamed = namedMkdtempSync(path.join(HOME, ".tl-janitor-named-"));
    const viaPromises = await promisesMkdtemp(path.join(HOME, ".tl-janitor-promises-"));
    const viaFsPromises = await fs.promises.mkdtemp(path.join(HOME, ".tl-janitor-fsp-"));
    const viaCallback = await new Promise<string>((resolve, reject) => {
      fs.mkdtemp(path.join(HOME, ".tl-janitor-cb-"), (error, directory) => (error ? reject(error) : resolve(directory)));
    });
    for (const dir of [viaNamespace, viaNamed, viaPromises, viaFsPromises, viaCallback]) {
      expect(fs.existsSync(dir), dir).toBe(true);
      expect(isTracked(dir), dir).toBe(true);
    }
  });

  it("tracks a prefix that does not start with .tl- too (the rule is the parent directory, not the name)", () => {
    const dir = fs.mkdtempSync(path.join(HOME, "tl-janitor-plain-"));
    expect(isTracked(dir)).toBe(true);
  });

  it("does not track a directory created anywhere else", () => {
    const inTmp = fs.mkdtempSync(path.join(os.tmpdir(), "tl-janitor-tmp-"));
    outsideHome.push(inTmp);
    expect(isTracked(inTmp)).toBe(false);

    const homeChild = fs.mkdtempSync(path.join(HOME, ".tl-janitor-parent-"));
    const grandChild = fs.mkdtempSync(path.join(homeChild, "nested-"));
    expect(isTracked(homeChild)).toBe(true);
    // Removed WITH its tracked parent; never an entry of its own.
    expect(isTracked(grandChild)).toBe(false);
  });
});

describe("homeTempJanitor: sweep", () => {
  it("removes every tracked directory, including a tree a fixture made read-only, and leaves everything else alone", () => {
    const plain = fs.mkdtempSync(path.join(HOME, ".tl-janitor-sweep-"));
    fs.writeFileSync(path.join(plain, "a.txt"), "x");
    const locked = fs.mkdtempSync(path.join(HOME, ".tl-janitor-locked-"));
    fs.mkdirSync(path.join(locked, "sub"));
    fs.writeFileSync(path.join(locked, "sub", "b.txt"), "y");
    if (process.platform !== "win32") {
      fs.chmodSync(path.join(locked, "sub"), 0o555);
      fs.chmodSync(locked, 0o555);
    }
    const untouched = fs.mkdtempSync(path.join(os.tmpdir(), "tl-janitor-keep-"));
    outsideHome.push(untouched);

    const survivors = sweepHomeTempDirs();

    expect(survivors).toEqual([]);
    expect(fs.existsSync(plain)).toBe(false);
    expect(fs.existsSync(locked)).toBe(false);
    expect(fs.existsSync(untouched)).toBe(true);
    expect(trackedHomeTempDirs.size).toBe(0);
  });

  it("is a no-op for a directory the spec already removed itself", () => {
    const dir = fs.mkdtempSync(path.join(HOME, ".tl-janitor-selfclean-"));
    fs.rmSync(dir, { recursive: true, force: true });
    expect(sweepHomeTempDirs()).toEqual([]);
    expect(trackedHomeTempDirs.size).toBe(0);
  });
});
