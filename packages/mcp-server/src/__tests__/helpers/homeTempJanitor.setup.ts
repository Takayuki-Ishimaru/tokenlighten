// homeTempJanitor.setup.ts — vitest setupFiles module.
//
// 2026-09-20: about 200 spec files build their fixture workspace as a direct
// child of the developer's HOME (`fs.mkdtempSync(path.join(os.homedir(),
// ".tl-…"))`). That location is deliberate — the server treats OS temp paths
// specially, and the vitest configs grant HOME through
// TOKENLIGHTEN_ALLOWED_PARENTS — but removal was left to each spec, and it
// leaked: a block that forgot to register its directory with the file's own
// cleanup list, a failing `beforeAll`, a killed worker. On the machine that
// found this, 12,831 `~/.tl-*` directories (1.1 GB, the oldest three months
// old) had piled up and a test run died with ENOSPC.
//
// This module makes the cleanup structural instead of per-spec: it wraps the
// three `mkdtemp` entry points of `node:fs` for the lifetime of one spec
// file's worker, remembers every directory THIS process created directly
// under the real home directory, and removes exactly those when the file's
// hooks finish (and once more on process exit, for a run that never reaches
// `afterAll`). It never looks at a directory it did not see being created,
// so a concurrent vitest run — several agents share this machine — cannot
// lose a live fixture to it, and nothing a developer keeps in HOME can match.
//
// A spec's own cleanup keeps working unchanged: removing an already-removed
// path is a no-op on both sides. With vitest's default `sequence.hooks:
// "stack"` this module's `afterAll` runs AFTER the spec file's own hooks
// (setup files register first), i.e. after the spec has stopped whatever
// server it spawned into the directory.
import { createRequire } from "node:module";
import { syncBuiltinESMExports } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll } from "vitest";

type MkdtempSync = (prefix: string, options?: unknown) => string | Buffer;
type MkdtempCallback = (error: NodeJS.ErrnoException | null, directory: string | Buffer) => void;
type MkdtempAsync = (prefix: string, options?: unknown) => Promise<string | Buffer>;

interface MutableFs {
  mkdtempSync: MkdtempSync;
  mkdtemp: (prefix: string, optionsOrCallback: unknown, callback?: MkdtempCallback) => void;
  promises: { mkdtemp: MkdtempAsync };
  realpathSync: (target: string) => string;
  rmSync: (target: string, options: { recursive: boolean; force: boolean }) => void;
  existsSync: (target: string) => boolean;
  readdirSync: (target: string, options: { withFileTypes: true }) => Array<{ name: string; isDirectory(): boolean; isSymbolicLink(): boolean }>;
  chmodSync: (target: string, mode: number) => void;
}

// The CommonJS exports object is the one MUTABLE view of `node:fs`; an ESM
// namespace import is read-only. `syncBuiltinESMExports()` below republishes
// the patched members to every ESM importer (namespace AND named imports).
const fsModule = createRequire(import.meta.url)("node:fs") as MutableFs;

const PATCHED = Symbol.for("tokenlighten.test.homeTempJanitor");

function realpathOrSelf(target: string): string {
  try {
    return fsModule.realpathSync(target);
  } catch {
    return path.resolve(target);
  }
}

// Resolved ONCE, at module load, before any spec-level HOME/USERPROFILE
// override: a spec that points HOME at its own sandbox creates children of
// that sandbox, which is not this module's business.
const HOME_DIR = path.resolve(os.homedir());
const REAL_HOME_DIR = realpathOrSelf(HOME_DIR);

/** Directories this worker created directly under the real home directory. */
export const trackedHomeTempDirs = new Set<string>();

function track(created: unknown): void {
  if (typeof created !== "string" || created.length === 0) return;
  const resolved = path.resolve(created);
  const parent = path.dirname(resolved);
  if (parent === HOME_DIR || parent === REAL_HOME_DIR || realpathOrSelf(parent) === REAL_HOME_DIR) {
    trackedHomeTempDirs.add(resolved);
  }
}

/** Best effort: a fixture that made part of its tree read-only (several specs model a 0555 root) must still be removable. */
function makeTreeWritable(dir: string): void {
  try {
    fsModule.chmodSync(dir, 0o700);
  } catch {
    return;
  }
  let entries: ReturnType<MutableFs["readdirSync"]>;
  try {
    entries = fsModule.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const child = path.join(dir, entry.name);
    if (entry.isDirectory()) makeTreeWritable(child);
    else {
      try {
        fsModule.chmodSync(child, 0o600);
      } catch {
        /* best effort */
      }
    }
  }
}

/**
 * Removes every tracked directory. Returns the ones that could NOT be
 * removed (still tracked, so the exit-time pass retries them). Exported for
 * homeTempJanitor.spec.ts; specs have no reason to call it.
 */
export function sweepHomeTempDirs(): string[] {
  const survivors: string[] = [];
  for (const dir of [...trackedHomeTempDirs]) {
    try {
      fsModule.rmSync(dir, { recursive: true, force: true });
    } catch {
      makeTreeWritable(dir);
      try {
        fsModule.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* reported below */
      }
    }
    if (fsModule.existsSync(dir)) survivors.push(dir);
    else trackedHomeTempDirs.delete(dir);
  }
  return survivors;
}

function install(): void {
  const registry = globalThis as unknown as Record<symbol, boolean | undefined>;
  if (registry[PATCHED] === true) return;
  registry[PATCHED] = true;

  const mkdtempSync = fsModule.mkdtempSync;
  fsModule.mkdtempSync = function mkdtempSyncTracked(this: unknown, prefix: string, options?: unknown) {
    const created = mkdtempSync.call(this, prefix, options);
    track(created);
    return created;
  };

  const mkdtemp = fsModule.mkdtemp;
  fsModule.mkdtemp = function mkdtempTracked(this: unknown, prefix: string, optionsOrCallback: unknown, callback?: MkdtempCallback) {
    const userCallback = typeof optionsOrCallback === "function" ? (optionsOrCallback as MkdtempCallback) : callback;
    const tracking: MkdtempCallback = (error, directory) => {
      if (error === null) track(directory);
      userCallback?.(error, directory);
    };
    if (typeof optionsOrCallback === "function") mkdtemp.call(this, prefix, tracking);
    else mkdtemp.call(this, prefix, optionsOrCallback, tracking);
  };

  const mkdtempAsync = fsModule.promises.mkdtemp;
  fsModule.promises.mkdtemp = async function mkdtempAsyncTracked(this: unknown, prefix: string, options?: unknown) {
    const created = await mkdtempAsync.call(this, prefix, options);
    track(created);
    return created;
  };

  syncBuiltinESMExports();

  // A run that never reaches `afterAll` (a thrown setup, an aborted file)
  // still exits through here. SIGKILL is the one path nothing can cover.
  process.once("exit", () => {
    sweepHomeTempDirs();
  });
}

install();

afterAll(() => {
  const survivors = sweepHomeTempDirs();
  if (survivors.length > 0) {
    console.warn(
      `[homeTempJanitor] could not remove ${survivors.length} fixture director${survivors.length === 1 ? "y" : "ies"} under HOME `
      + `(still in use by a process this spec spawned?): ${survivors.join(", ")}`,
    );
  }
});
