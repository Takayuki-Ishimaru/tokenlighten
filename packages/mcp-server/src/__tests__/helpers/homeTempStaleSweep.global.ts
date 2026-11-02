// homeTempStaleSweep.global.ts — vitest globalSetup, once per run.
//
// homeTempJanitor.setup.ts removes what its own worker created, and says what it
// cannot cover: a worker that was killed. Cancelled runs left 210 `~/.tl-*` directories
// (37.5 MB) by 2026-11-01. This sweep covers that: a directory named like a fixture
// (`.tl-<tag>-` plus mkdtemp's six characters) and untouched for a week belongs to no
// live run, so concurrent runs on the machine lose nothing to it.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
const FIXTURE_NAME = /^\.tl-(?:[A-Za-z0-9._]+-)*[A-Za-z0-9_-]{6}$/;

/** Removes stale fixture directories directly under `home`; returns the names it removed. */
export function sweepStaleHomeFixtures(home: string, now: number): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(home, { withFileTypes: true });
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !FIXTURE_NAME.test(entry.name)) continue;
    const dir = path.join(home, entry.name);
    try {
      if (now - fs.lstatSync(dir).mtimeMs < STALE_AFTER_MS) continue;
      fs.rmSync(dir, { recursive: true, force: true });
      removed.push(entry.name);
    } catch {
      // Still in use or read-only: the next run tries again.
    }
  }
  return removed;
}

export default function setup(): void {
  sweepStaleHomeFixtures(os.homedir(), Date.now());
}
