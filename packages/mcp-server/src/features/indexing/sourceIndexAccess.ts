// sourceIndexAccess.ts — the one place this server obtains skeleton-engine's
// whole-workspace source index (`loadOrBuildSourceIndex`), so that a first
// request against a large, cold workspace no longer blocks on building it.
//
// WHY (measured 2026-11-02 on Windows, this repository frozen at HEAD, 4,534
// indexed files / 68 MB; an external linux-x64 evaluation of v0.16.4 saw the
// same shape at ~37 s): the first `tl_read_file` of a fresh server process
// took 114 s, of which the cold index build — enumerate, read, hash, regex
// symbols, chunks and an identifier count for every file — was ~22 s in
// isolation and far more under load; a warm call still took 21-35 s. Two
// causes, both in `tools/searchSymbols.ts`'s call: (1) the build is
// synchronous inside the first symbol lookup, so the reply waits for the whole
// workspace although the lookup needs only the files that match; (2) one
// request looks symbols up dozens of times, and even a memo-hit lookup
// re-enumerates the tree (1.5-3.3 s here) for its stat fingerprint. On this
// repository the manifest also exceeds skeleton-engine's 32 MiB single-file
// cache cap (indexStore.ts `MAX_CACHE_MANIFEST_BYTES`); until 2026-11-03 it
// never persisted and every new process was cold again (it now goes to the
// sharded cache, skeleton-engine shardedManifest.ts).
//
// WHAT.
//   - Every build of a workspace's index runs through `startBuild`: one build
//     per workspace at a time, shared by every caller that arrives while it
//     runs (concurrent first calls never start a second build).
//   - A lookup asks for the index with an access mode. `"wait"` (the default,
//     explicit symbol requests: `tl_search_files action=symbols`, its cursor,
//     the symbol-scoped pathless edit) awaits the build exactly as before.
//     `"background"` (the locator's lookups inside a task pack) applies the
//     policy below and, while the index is not ready, gets `{warming:true}`:
//     the locator then answers from its text layers and targeted parses, and
//     the pack's `task.coverage` is projected as `"partial"` with
//     `coverage_reason:"index-warming"` (protocol/decisionWire.ts
//     `projectTaskRef`), so the caller knows symbols were not consulted.
//   - Policy (TL_BACKGROUND_INDEX, util/flags.ts `backgroundIndexMode`):
//     `off` — the legacy direct call, nothing below applies; `on` — a
//     background lookup never waits; `auto` (default) — a workspace the
//     locator walked as small (fewer than TL_BACKGROUND_INDEX_MIN_FILES files,
//     default 400) waits for the build, which is sub-second there, so small
//     fixtures and specs keep today's complete first pack byte for byte; a
//     workspace measured as large waits at most TL_BACKGROUND_INDEX_WAIT_MS
//     (default 1500 ms) and then takes the warming path. An unmeasured one
//     waits like a small one, so machine load alone never cuts symbols.
//   - Once a build has finished, lookups call `loadOrBuildSourceIndex` as
//     before (its in-process memo revalidates by stat fingerprint). Within one
//     read request, background lookups reuse the first manifest obtained
//     (`requestManifests`, keyed by the request's cancellation signal) — a
//     `tl_read_file` never writes workspace files, so nothing can go stale
//     inside it; `"wait"` lookups (edit paths) never use this memo.
//   - A failed build is recorded, the request proceeds without symbols, and
//     the next background lookup after FAILED_RETRY_MS retries; a `"wait"`
//     lookup retries at once and sees the failure as before.
//   - Persisted caches are untouched in shape: the build writes them exactly
//     as the synchronous call did (atomic rename), only at a different time.
//   - Prewarm (2026-11-03): `prewarmSourceIndex`, called once the MCP
//     handshake completes, starts the build of a repository root (a `.git`
//     entry, never the home directory or a filesystem root) in the idle time
//     before the first request, so that request usually finds the index ready
//     — from the persisted cache, a reload and re-hash rather than a
//     re-extraction. TL_BACKGROUND_INDEX=off or TL_STARTUP_WARMUP=0 turns it off.
//   - Shutdown: the build is skeleton-engine's async loop and cannot be
//     aborted, and its pending I/O would keep the process alive after the
//     client closed the transport. `exitAfterTransportCloseIfBuilding` lets
//     the transports end the process once their queue drained (the manifest
//     rename is atomic, so a build cut off leaves no partial cache).
//
// Test seams: `setSourceIndexBuilderForTest` injects a builder in-process;
// TL_TEST_INDEX_BUILD_DELAY_MS / TL_TEST_INDEX_BUILD_FAIL shape the default
// builder of a spawned server (backgroundSourceIndex.spec.ts);
// `resetSourceIndexAccessForTest` / `sourceIndexBuildsSettledForTest` serve
// testing/sessionReset.ts.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { loadOrBuildSourceIndex, type SourceIndexManifestV1 } from "@tokenlighten/skeleton-engine";

import { backgroundIndexMinFiles, backgroundIndexMode, backgroundIndexWaitMs, startupWarmupEnabled } from "../../util/flags.js";
import { currentRequestSignal } from "../../util/requestCancellation.js";
import { trace } from "../../util/trace.js";

/** The options `loadOrBuildSourceIndex` takes from this server (see tools/searchSymbols.ts). */
export interface SourceIndexBuildOptions {
  ignoreHash: string;
  graphIndexMode?: "auto" | "on" | "off";
  graphIndexMaxBytes?: number;
  consistencyScanScope?: object;
}

export type SourceIndexBuilder = (
  workspace: string,
  opts: SourceIndexBuildOptions,
) => Promise<{ manifest: SourceIndexManifestV1 }>;

export type SourceIndexState = "idle" | "building" | "ready" | "failed";

/**
 * `"wait"`: the caller needs the index and awaits its build (legacy
 * behaviour). `"background"`: the caller can answer without it; see the policy
 * in the module header.
 */
export type SourceIndexAccess = "wait" | "background";

export type SourceIndexOutcome =
  | { readonly manifest: SourceIndexManifestV1; readonly warming?: undefined }
  | { readonly manifest?: undefined; readonly warming: true; readonly state: SourceIndexState };

interface WorkspaceIndex {
  state: SourceIndexState;
  /** The one in-flight build; present iff `state === "building"`. */
  build?: Promise<SourceIndexManifestV1>;
  startedAt?: number;
  readyAt?: number;
  failedAt?: number;
  failure?: string;
  builds: number;
}

/** A failed background build is retried no sooner than this. */
export const FAILED_RETRY_MS = 30_000;

const workspaces = new Map<string, WorkspaceIndex>();
/** The locator's last walk size per workspace (util for the `auto` policy). */
const walkSizes = new Map<string, number>();
/** Requests whose background lookups found the index warming. */
const warmingRequests = new WeakSet<AbortSignal>();
/** Per read request: the manifest its first background lookup obtained. */
const requestManifests = new WeakMap<AbortSignal, Map<string, SourceIndexManifestV1>>();
const rootKeys = new Map<string, string>();

let builder: SourceIndexBuilder = defaultBuilder;

async function defaultBuilder(workspace: string, opts: SourceIndexBuildOptions): Promise<{ manifest: SourceIndexManifestV1 }> {
  // Test seams for a spawned server: a slow build, a failing build.
  const delay = Number(process.env["TL_TEST_INDEX_BUILD_DELAY_MS"] ?? "");
  if (Number.isFinite(delay) && delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
  if (process.env["TL_TEST_INDEX_BUILD_FAIL"] === "1") throw new Error("TL_TEST_INDEX_BUILD_FAIL");
  return loadOrBuildSourceIndex(workspace, opts);
}

function rootKeyOf(workspace: string): string {
  const memo = rootKeys.get(workspace);
  if (memo !== undefined) return memo;
  let real: string;
  try {
    real = fs.realpathSync.native(workspace);
  } catch {
    real = path.resolve(workspace);
  }
  const key = process.platform === "win32" ? real.toLowerCase() : real;
  rootKeys.set(workspace, key);
  return key;
}

function entryFor(rootKey: string): WorkspaceIndex {
  let entry = workspaces.get(rootKey);
  if (entry === undefined) {
    entry = { state: "idle", builds: 0 };
    workspaces.set(rootKey, entry);
  }
  return entry;
}

/**
 * The locator reports how many files its workspace walk found, before its
 * first symbol lookup. Only the `auto` policy reads it.
 */
export function noteWorkspaceWalkSize(workspace: string, files: number): void {
  if (Number.isFinite(files) && files >= 0) walkSizes.set(rootKeyOf(workspace), files);
}

/**
 * Start the build of `workspace`'s index unless one is in flight; returns the
 * in-flight build either way. Never rejects synchronously; the returned
 * promise rejects when the build fails.
 */
function startBuild(rootKey: string, workspace: string, opts: SourceIndexBuildOptions): Promise<SourceIndexManifestV1> {
  const entry = entryFor(rootKey);
  if (entry.state === "building" && entry.build !== undefined) return entry.build;
  const startedAt = Date.now();
  entry.state = "building";
  entry.startedAt = startedAt;
  entry.builds += 1;
  trace("source_index_build", { phase: "start", builds: entry.builds }, workspace);
  const { consistencyScanScope: _scope, ...buildOpts } = opts;
  const build = builder(workspace, buildOpts).then(
    (result) => {
      if (entry.build === build) {
        entry.state = "ready";
        entry.readyAt = Date.now();
        entry.build = undefined;
        entry.failure = undefined;
      }
      trace("source_index_build", {
        phase: "ready", duration_ms: Date.now() - startedAt, files: Object.keys(result.manifest.files).length,
      }, workspace);
      return result.manifest;
    },
    (error: unknown) => {
      if (entry.build === build) {
        entry.state = "failed";
        entry.failedAt = Date.now();
        entry.build = undefined;
        entry.failure = error instanceof Error ? error.message : String(error);
      }
      trace("source_index_build", { phase: "failed", duration_ms: Date.now() - startedAt, error: entry.failure }, workspace);
      throw error;
    },
  );
  entry.build = build;
  // A background build nobody awaits must not surface as an unhandled rejection.
  build.catch(() => undefined);
  return build;
}

/** Resolves to the manifest if `build` settles within `ms`, else to undefined. */
function settledWithin(build: Promise<SourceIndexManifestV1>, ms: number): Promise<SourceIndexManifestV1 | undefined> {
  if (ms <= 0) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), ms);
    timer.unref?.();
    build.then(
      (manifest) => { clearTimeout(timer); resolve(manifest); },
      () => { clearTimeout(timer); resolve(undefined); },
    );
  });
}

function markWarming(rootKey: string): SourceIndexOutcome {
  const signal = currentRequestSignal();
  if (signal !== undefined) warmingRequests.add(signal);
  return { warming: true, state: entryFor(rootKey).state };
}

/**
 * The workspace's source index for one lookup. `"wait"` awaits (and shares)
 * the build; `"background"` follows the policy in the module header and may
 * return `{warming:true}` instead of a manifest.
 */
export async function obtainSourceIndex(
  workspace: string,
  opts: SourceIndexBuildOptions,
  access: SourceIndexAccess = "wait",
): Promise<SourceIndexOutcome> {
  const mode = backgroundIndexMode();
  if (mode === "off") return { manifest: (await loadOrBuildSourceIndex(workspace, opts)).manifest };

  const rootKey = rootKeyOf(workspace);
  const entry = entryFor(rootKey);
  const signal = currentRequestSignal();

  if (access === "background" && signal !== undefined) {
    const memo = requestManifests.get(signal)?.get(rootKey);
    if (memo !== undefined) return { manifest: memo };
  }

  const remember = (manifest: SourceIndexManifestV1): SourceIndexOutcome => {
    if (access === "background" && signal !== undefined) {
      let perRequest = requestManifests.get(signal);
      if (perRequest === undefined) {
        perRequest = new Map();
        requestManifests.set(signal, perRequest);
      }
      perRequest.set(rootKey, manifest);
    }
    return { manifest };
  };

  // Built already: the call revalidates against skeleton-engine's in-process
  // memo (stat fingerprint) and refreshes changed files, as it always did.
  if (access === "wait") {
    if (entry.state === "building" && entry.build !== undefined) return remember(await entry.build);
    if (entry.state === "ready") return remember((await builder(workspace, opts)).manifest);
    return remember(await startBuild(rootKey, workspace, opts));
  }

  // access === "background"
  if (entry.state === "ready") return remember((await builder(workspace, opts)).manifest);

  if (entry.state === "failed") {
    const since = Date.now() - (entry.failedAt ?? 0);
    if (since < FAILED_RETRY_MS) return markWarming(rootKey);
  }

  const waitMs = backgroundWaitMs(mode, rootKey);
  const build = entry.state === "building" && entry.build !== undefined ? entry.build : startBuild(rootKey, workspace, opts);
  if (waitMs === Number.POSITIVE_INFINITY) {
    try {
      return remember(await build);
    } catch {
      return markWarming(rootKey);
    }
  }
  const manifest = await settledWithin(build, waitMs);
  return manifest !== undefined ? remember(manifest) : markWarming(rootKey);
}

/**
 * Start `workspace`'s build ahead of the first request (see Prewarm in the
 * module header). A no-op unless the workspace is a repository root and both
 * background indexing and startup warm-up are enabled, or when its index is
 * already building, built or failed. Returns whether a build started.
 */
export function prewarmSourceIndex(workspace: string, opts: SourceIndexBuildOptions): boolean {
  if (backgroundIndexMode() === "off" || !startupWarmupEnabled()) return false;
  const rootKey = rootKeyOf(workspace);
  if (entryFor(rootKey).state !== "idle" || !isPrewarmableRoot(rootKey)) return false;
  startBuild(rootKey, workspace, opts);
  return true;
}

function isPrewarmableRoot(rootKey: string): boolean {
  if (path.dirname(rootKey) === rootKey) return false;
  const home = os.homedir();
  if (home !== "" && rootKeyOf(home) === rootKey) return false;
  return fs.existsSync(path.join(rootKey, ".git"));
}

/** How long a background lookup waits for the build under `mode`. */
function backgroundWaitMs(mode: "auto" | "on", rootKey: string): number {
  if (mode === "on") return 0;
  // Only a workspace the locator measured as large takes the bounded wait. An
  // unmeasured one waits like a small one: otherwise a small workspace on a
  // loaded machine would lose its symbols to the clock, not to its size.
  const walked = walkSizes.get(rootKey);
  if (walked === undefined || walked < backgroundIndexMinFiles()) return Number.POSITIVE_INFINITY;
  return backgroundIndexWaitMs();
}

/**
 * Whether a background lookup of the current request found the index
 * warming (read by protocol/decisionWire.ts's `projectTaskRef`). Outside a
 * bound request (a transport without a request signal), whether any
 * workspace's index is building right now.
 */
export function sourceIndexWarmingForCurrentRequest(): boolean {
  const signal = currentRequestSignal();
  if (signal !== undefined) return warmingRequests.has(signal);
  return sourceIndexBuildInFlight();
}

/** Whether any workspace's index build is in flight. */
export function sourceIndexBuildInFlight(): boolean {
  for (const entry of workspaces.values()) if (entry.state === "building") return true;
  return false;
}

/** The recorded state of `workspace`'s index (diagnostics and specs). */
export function sourceIndexStatus(workspace: string): { state: SourceIndexState; builds: number; failure?: string } {
  const entry = entryFor(rootKeyOf(workspace));
  return { state: entry.state, builds: entry.builds, ...(entry.failure !== undefined ? { failure: entry.failure } : {}) };
}

/**
 * Called by a transport once its client closed the connection and its request
 * queue drained. With no build in flight the process ends on its own as
 * before; with one, `flush` is given the exit so pending output reaches the
 * pipe first. Returns whether an exit was scheduled.
 */
export function exitAfterTransportCloseIfBuilding(
  flush: (exit: () => void) => void = (exit) => exit(),
  exitProcess: () => void = () => process.exit(process.exitCode ?? 0),
): boolean {
  if (!sourceIndexBuildInFlight()) return false;
  let exited = false;
  const exit = (): void => {
    if (exited) return;
    exited = true;
    clearTimeout(fallback);
    exitProcess();
  };
  // Should the flush callback never fire, exit anyway.
  const fallback = setTimeout(exit, 2_000);
  fallback.unref?.();
  try {
    flush(exit);
  } catch {
    exit();
  }
  return true;
}

/** Test seam: replace (or with undefined restore) the builder every build calls. */
export function setSourceIndexBuilderForTest(replacement: SourceIndexBuilder | undefined): void {
  builder = replacement ?? defaultBuilder;
}

/** Test seam: resolves once every in-flight build has settled (never rejects). */
export async function sourceIndexBuildsSettledForTest(): Promise<void> {
  const pending = [...workspaces.values()].flatMap((entry) => (entry.build !== undefined ? [entry.build] : []));
  await Promise.allSettled(pending);
}

/** Test seam: forget every workspace's state, walk size and builder. */
export function resetSourceIndexAccessForTest(): void {
  workspaces.clear();
  walkSizes.clear();
  rootKeys.clear();
  builder = defaultBuilder;
}
