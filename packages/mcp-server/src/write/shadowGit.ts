/**
 * shadowGit.ts — lazy shadow-git checkpoint store for write tools.
 *
 * A shadow git repo lives at <workspace>/.tokenlighten/checkpoints/.git
 * It is NOT bare (needs a work-tree to support future checkout in v0.3).
 * The work-tree is set to <workspace> so staged files resolve correctly.
 *
 * Initialization is lazy: created on first write. Subsequent writes only
 * add + commit the modified files.
 *
 * GC runs async every N=20 writes: reflog expire --expire=7.days + gc --prune=7.days.ago.
 * The GC never blocks tool response.
 *
 * Design constraints:
 *   - shell: false everywhere (no shell injection risk)
 *   - NEVER 'git add -A' — always explicit file list
 *   - No Date.now / new Date in cacheable text fields
 *   - Absolute paths via path.join (NOT literal '/')
 *
 * Hardening (TL-V0.9-RELEASE-STRATEGY-2026-08-12.md §6.6, CWE-78/CWE-400):
 * every invocation below runs against <workspace>/.tokenlighten/checkpoints/.git,
 * and the WORKSPACE ITSELF is attacker-controlled input (an agent operates on
 * arbitrary repos/directories it did not create). `git init` on an
 * already-existing .git dir PRESERVES whatever hooks/config that dir already
 * had, so a workspace that ARRIVES with a planted shadow repo (hostile
 * hooks/pre-commit, a core.fsmonitor set to a shell command, a stray
 * core.hooksPath) would otherwise get that content executed by the very
 * first `git add`/`git commit` TL issues — verified empirically in
 * __tests__/shadowGitHardening.spec.ts, including a negative control that
 * reproduces the unmitigated execution. Every call — sync and the detached
 * async gc/reflog calls — goes through the SAME argv/env neutralization
 * (gitArgvPrefix/gitEnv); the synchronous calls additionally get an explicit
 * timeout+maxBuffer (see runGitSync), matching the timeout:5000 idiom
 * already used elsewhere in this repo (readCodeTaskPack.ts,
 * skeleton-engine's indexStore.ts).
 */

import { spawnSync, spawn, type SpawnSyncReturns } from "child_process";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** Cache of workspaces that have been successfully initialized. */
const initializedWorkspaces = new Set<string>();

/** Write counter per workspace (for GC threshold). */
const writeCounters = new Map<string, number>();

/** How many writes before GC is triggered. */
const GC_EVERY_N = 20;

// ---------------------------------------------------------------------------
// Hardening — argv/env neutralization shared by EVERY shadow-git invocation
// ---------------------------------------------------------------------------

/** Matches the timeout idiom already used elsewhere in this repo for child
 *  git/tool spawns (readCodeTaskPack.ts, skeleton-engine/indexStore.ts). */
const GIT_TIMEOUT_MS = 5000;

/** Explicit rather than relying on Node's 1 MB spawnSync default — shadow-git
 *  stdout/stderr is always small (a SHA, a short status/error line), so 10 MB
 *  is generous headroom, not a working limit. */
const GIT_MAX_BUFFER = 10 * 1024 * 1024;

/**
 * Process-wide, empty directory used as `-c core.hooksPath=<dir>` on every
 * invocation, so git never finds ANY hook script (pre-commit, commit-msg,
 * prepare-commit-msg, post-commit, post-checkout, fsmonitor-watchman, …) —
 * overriding whatever a pre-existing (possibly hostile) shadow .git dir
 * configured, since a command-line `-c` outranks both repo-local and
 * global/system config.
 *
 * Deliberately created OUTSIDE the (untrusted) workspace: a path INSIDE the
 * workspace could be pre-planted by an attacker as a symlink to a real hooks
 * directory before TL ever runs — `fs.mkdirSync(dir, {recursive:true})`
 * silently ACCEPTS an existing symlink-to-directory rather than rejecting
 * it, so creating the neutral dir under the workspace would not actually be
 * safe. `fs.mkdtempSync` under the OS temp dir gives an unpredictable,
 * exclusively-created path instead, so there is nothing for an attacker to
 * pre-plant. Lazy + memoized: the directory is never written to after
 * creation, so sharing one instance across every workspace this process
 * ever touches is safe.
 */
let neutralHooksDir: string | undefined;
function getNeutralHooksDir(): string {
  if (neutralHooksDir !== undefined) return neutralHooksDir;
  try {
    neutralHooksDir = fs.mkdtempSync(path.join(os.tmpdir(), "tl-git-nohooks-"));
  } catch {
    // Extremely unlikely (unwritable OS temp dir) — fall back to a path we
    // did not create rather than throwing out of the write path. git treats
    // a hooksPath whose directory holds no file matching a given hook name
    // — including a hooksPath that does not exist on disk at all — as "no
    // hook for that name", verified empirically against git 2.50 (see the
    // hardening spec), so this fallback stays safe even though we never
    // created it.
    neutralHooksDir = path.join(os.tmpdir(), `tl-git-nohooks-fallback-${process.pid}`);
  }
  return neutralHooksDir;
}

/**
 * `-c` overrides applied to EVERY shadow-git invocation, sync or async.
 * Command-line `-c` has the highest git config precedence (above repo-local
 * AND global/system config), so these hold even against a hostile shadow
 * .git's own committed config for the same keys.
 *
 *  core.hooksPath=<neutral empty dir>  — see getNeutralHooksDir(): no hook
 *    executable is ever found.
 *  core.fsmonitor=false                — refuses to treat a configured
 *    value as a command to run. core.fsmonitor's value can be an arbitrary
 *    shell command (a CWE-78 vector distinct from hooksPath — it is a plain
 *    config value, not a hooksPath-relative file) that git itself invokes
 *    during status-adjacent plumbing inside `add`; confirmed empirically
 *    (hardening spec negative control) that an unmitigated core.fsmonitor
 *    command runs during a plain `git add`/`git status`.
 *  init.templateDir=<empty>            — disables template-directory
 *    copying on `git init`, so a developer/global/system init.templateDir
 *    (a common husky/lefthook-style setup) can never seed hook files into
 *    the freshly created shadow .git/hooks/ in the first place —
 *    belt-and-suspenders with core.hooksPath above.
 *  gc.auto=0                           — never let an implicit auto-gc run
 *    as a side effect of add/commit/init; GC is already handled explicitly
 *    and asynchronously by scheduleGc().
 */
function gitArgvPrefix(): string[] {
  return [
    "-c", `core.hooksPath=${getNeutralHooksDir()}`,
    "-c", "core.fsmonitor=false",
    "-c", "init.templateDir=",
    "-c", "gc.auto=0",
  ];
}

/**
 * Environment passed to EVERY shadow-git invocation: the inherited process
 * env with all `GIT_*` variables stripped, then replaced with an explicit,
 * minimal set. Stripping matters even though gitArgvPrefix() already wins on
 * config precedence: an inherited GIT_CONFIG_GLOBAL/GIT_CONFIG_SYSTEM (set
 * by a hostile parent process, a shell profile, or the MCP host) would
 * still be HONORED for every config key our fixed `-c` list does not itself
 * override, and an ambient env var is a strictly wider attack surface than
 * that fixed list.
 *
 *  GIT_CONFIG_GLOBAL=/dev/null, GIT_CONFIG_SYSTEM=/dev/null — the documented
 *    git idiom (git(1)) to skip reading the respective config file
 *    entirely, so this fully self-contained, always-explicit-file-list
 *    checkpoint repo never consults the developer's real global config
 *    (core.hooksPath, init.templateDir, a husky/lefthook install, …). Git's
 *    own mingw compat layer special-cases the literal string "/dev/null" in
 *    file opens on Windows (mapped to the NUL device), so this is not
 *    POSIX-only — verified against git 2.50 on this platform in the
 *    hardening spec; full Windows CI coverage is out of scope here.
 *  GIT_TERMINAL_PROMPT=0 — never block the tool response on an interactive
 *    credential/host-key prompt.
 *  GIT_OPTIONAL_LOCKS=0  — never take the opportunistic index-refresh lock
 *    some status-adjacent commands use.
 *
 * PATH is passed through unpinned: pinning it to one fixed absolute `git`
 * binary is out of scope for this local dev-machine tool, which already
 * trusts ordinary PATH resolution to find `git` itself (see gitAvailable());
 * a PATH-substitution attack needs the same local code-execution capability
 * that would let an attacker edit this file directly.
 */
function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("GIT_")) delete env[key];
  }
  env.GIT_CONFIG_GLOBAL = "/dev/null";
  env.GIT_CONFIG_SYSTEM = "/dev/null";
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_OPTIONAL_LOCKS = "0";
  return env;
}

/**
 * Classifies a spawnSync failure that is NOT a plain nonzero git exit (i.e.
 * `result.error` is set) into a short, distinguishable message, so a caller
 * reading `.stderr` can tell "git rejected the operation" (ordinary stderr
 * text, e.g. a real conflict) apart from "the process never got to
 * run/finish" (killed on timeout, killed for exceeding maxBuffer, or never
 * spawned at all). Returns undefined for the ordinary case.
 */
function classifySpawnError(result: SpawnSyncReturns<string>): string | undefined {
  const err = result.error as NodeJS.ErrnoException | undefined;
  if (!err) return undefined;
  if (err.code === "ETIMEDOUT") {
    return `[git timed out after ${GIT_TIMEOUT_MS}ms and was killed]`;
  }
  if (err.code === "ENOBUFS") {
    return `[git output exceeded the ${GIT_MAX_BUFFER}-byte cap and was killed]`;
  }
  return `[git spawn error: ${err.code ?? "unknown"} ${err.message}]`;
}

/**
 * The single low-level runner every shadow-git spawnSync call goes through:
 * argv neutralization (gitArgvPrefix) prepended to the caller's own args,
 * env neutralization (gitEnv), and explicit bounds (timeout/maxBuffer — see
 * the module Hardening note). Callers pass ONLY their command's own
 * arguments (e.g. `--git-dir`/`--work-tree` plus the subcommand) — unchanged
 * from before this hardening pass.
 */
function runGitSync(args: string[]): SpawnSyncReturns<string> {
  return spawnSync("git", [...gitArgvPrefix(), ...args], {
    encoding: "utf8",
    shell: false,
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: GIT_MAX_BUFFER,
    env: gitEnv(),
  });
}

/** Run git with the shadow git-dir and work-tree, synchronously. */
function gitSync(
  workspace: string,
  args: string[]
): { status: number | null; stdout: string; stderr: string } {
  const gitDir = shadowGitDir(workspace);
  const result = runGitSync(["--git-dir", gitDir, "--work-tree", workspace, ...args]);
  const spawnErr = classifySpawnError(result);
  const stderr = result.stderr ?? "";
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: spawnErr ? (stderr ? `${spawnErr} ${stderr}` : spawnErr) : stderr,
  };
}

/**
 * Run git async (fire-and-forget, never block tool response). Same argv/env
 * neutralization as every other call (gitArgvPrefix/gitEnv) — but NO
 * `timeout`: this process is detached and unref'd immediately below so it
 * never keeps the Node event loop (or the parent process) alive, and
 * Node's `spawn()` timeout is enforced by a JS timer on THAT event loop —
 * the two are incompatible by construction here, not an oversight. A hung
 * `git gc`/`git reflog expire` is therefore bounded only by git's own
 * behavior, not by us. This is a real, accepted residual gap (see the
 * hardening spec's disclosure note); the argv/env neutralization still
 * closes the code-execution vectors (hooks, fsmonitor, template dir,
 * config-file injection) for this call same as every other one.
 */
function gitAsync(workspace: string, args: string[]): void {
  const gitDir = shadowGitDir(workspace);
  const child = spawn(
    "git",
    [...gitArgvPrefix(), "--git-dir", gitDir, "--work-tree", workspace, ...args],
    { stdio: "ignore", shell: false, detached: true, env: gitEnv() }
  );
  child.unref();
}

/** Check whether git is available on this system. */
export function gitAvailable(): boolean {
  const r = runGitSync(["--version"]);
  return r.status === 0;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Resolve the .git dir path for the shadow repo. */
export function shadowGitDir(workspace: string): string {
  return path.join(workspace, ".tokenlighten", "checkpoints", ".git");
}

// ---------------------------------------------------------------------------
// Lazy init
// ---------------------------------------------------------------------------

/**
 * Ensure the shadow git repo exists and is initialized.
 * Idempotent: after the first successful init the workspace is cached.
 * Returns false if git is not available or init failed.
 */
export function ensureInit(workspace: string): boolean {
  if (initializedWorkspaces.has(workspace)) return true;

  if (!gitAvailable()) return false;

  const gitDir = shadowGitDir(workspace);
  const gitDirParent = path.dirname(gitDir);

  // Ensure the checkpoints directory exists.
  try {
    fs.mkdirSync(gitDirParent, { recursive: true });
  } catch {
    return false;
  }

  // 'git init' in the shadow git-dir (not bare — needs work-tree for v0.3 restore).
  // Re-init of an existing git dir preserves its hooks/config (see the module
  // Hardening note) — the argv/env neutralization inside runGitSync is what
  // actually keeps that safe, not this call being "first time" or not.
  const initResult = runGitSync(["--git-dir", gitDir, "--work-tree", workspace, "init"]);

  if (initResult.status !== 0) return false;

  // Configure user identity for commits (shadow repo — use fixed placeholder
  // so commits are deterministic across machines; no Date.now in text fields).
  runGitSync(["--git-dir", gitDir, "config", "user.email", "tl-checkpoint@tokenlighten"]);
  runGitSync(["--git-dir", gitDir, "config", "user.name", "TokenLighten Checkpoint"]);

  initializedWorkspaces.add(workspace);
  return true;
}

// ---------------------------------------------------------------------------
// Checkpoint
// ---------------------------------------------------------------------------

export interface CheckpointResult {
  ok: boolean;
  checkpointId: string | null;
  error?: string;
}

/**
 * Create a shadow-git checkpoint for the given files.
 *
 * @param workspace - Absolute workspace root.
 * @param files     - Workspace-relative paths of files to stage (NEVER add -A).
 * @param message   - Commit message.
 */
export function createCheckpoint(
  workspace: string,
  files: string[],
  message: string
): CheckpointResult {
  if (files.length === 0) {
    return { ok: false, checkpointId: null, error: "no files to checkpoint" };
  }

  if (!ensureInit(workspace)) {
    return { ok: false, checkpointId: null, error: "git not available or init failed" };
  }

  // Stage only the specified files — NEVER 'git add -A'.
  // Use absolute paths to avoid ambiguity.
  const absFiles = files.map((f) => path.join(workspace, f));
  const addResult = gitSync(workspace, ["add", "--", ...absFiles]);
  if (addResult.status !== 0) {
    return {
      ok: false,
      checkpointId: null,
      error: `git add failed: ${addResult.stderr.trim()}`,
    };
  }

  // Commit. --no-verify skips pre-commit/commit-msg (defense in depth — the
  // hooksPath neutralization above already keeps ALL hook types, including
  // the ones --no-verify alone does not cover such as post-commit, from
  // finding an executable at all; see the module Hardening note).
  const commitResult = gitSync(workspace, ["commit", "--allow-empty", "--no-verify", "-m", message]);
  if (commitResult.status !== 0) {
    return {
      ok: false,
      checkpointId: null,
      error: `git commit failed: ${commitResult.stderr.trim()}`,
    };
  }

  // Get the commit SHA to use as checkpoint_id.
  const revResult = gitSync(workspace, ["rev-parse", "HEAD"]);
  const sha = revResult.stdout.trim();

  // Increment write counter and maybe trigger GC.
  const prev = writeCounters.get(workspace) ?? 0;
  const next = prev + 1;
  writeCounters.set(workspace, next);
  if (next % GC_EVERY_N === 0) {
    scheduleGc(workspace);
  }

  return { ok: true, checkpointId: sha || null };
}

// ---------------------------------------------------------------------------
// GC (async, never blocks tool response)
// ---------------------------------------------------------------------------

function scheduleGc(workspace: string): void {
  // Run reflog expire first (async, detached).
  gitAsync(workspace, [
    "reflog",
    "expire",
    "--expire=7.days",
    "--all",
  ]);
  // Then gc (also async — git will queue them internally).
  gitAsync(workspace, ["gc", "--prune=7.days.ago"]);
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Reset in-memory state for tests. */
export function __resetShadowGitForTests(): void {
  initializedWorkspaces.clear();
  writeCounters.clear();
}
