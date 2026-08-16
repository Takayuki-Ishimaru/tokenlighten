/**
 * shadowGitHardening.spec.ts — regression tests for the checkpoint shadow-git
 * hardening pass (TL-V0.9-RELEASE-STRATEGY-2026-08-12.md §6.6, CWE-78/CWE-400).
 *
 * Every test here reproduces an attack/failure pattern against the REAL
 * write path (write/shadowGit.ts's createCheckpoint) or the REAL read path
 * (util/closureTracking.ts's computeClosureState), not a mocked stand-in —
 * a hostile shadow .git dir, a hijacked GIT_CONFIG_GLOBAL, and a hostile
 * workspace-repo core.fsmonitor are all planted with plain, unmitigated
 * `git`/`fs` calls (deliberately NOT going through TL's own hardened
 * helpers — that would be circular), then TL's real entry points are
 * invoked and the canary side effects are asserted absent.
 *
 * Hermetic: every fixture lives under a fresh os.tmpdir() mkdtemp, and any
 * process.env mutation (GIT_CONFIG_GLOBAL, PATH) is saved/restored per test
 * — never touches the developer's real global git config.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawnSync } from "child_process";
import {
  createCheckpoint,
  shadowGitDir,
  gitAvailable,
  __resetShadowGitForTests,
} from "../write/shadowGit.js";
import { computeClosureState } from "../util/closureTracking.js";
import { recordPackChecks, resetWorkspace, type PackCheckRecord } from "../util/session.js";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const tmpDirs: string[] = [];

function mkWorkspace(prefix = "tl-sgh-"): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  tmpDirs.push(dir);
  return dir;
}

function writeFile(root: string, rel: string, content: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
}

/** Write an executable POSIX hook/shell script (raw fs — simulates an
 *  attacker or a pre-existing dev-machine tool, never goes through TL). */
function writeExecutable(absPath: string, script: string): void {
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, script, "utf8");
  fs.chmodSync(absPath, 0o755);
}

function canaryExists(root: string, name: string): boolean {
  return fs.existsSync(path.join(root, name));
}

const GIT_AVAILABLE = gitAvailable();
const test = GIT_AVAILABLE ? it : it.skip;

beforeEach(() => {
  __resetShadowGitForTests();
});

afterEach(() => {
  __resetShadowGitForTests();
  for (const dir of tmpDirs.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ok */ }
  }
});

// ---------------------------------------------------------------------------
// (a) Hostile pre-planted shadow repo: hooks/pre-commit + core.fsmonitor
// ---------------------------------------------------------------------------

describe("shadowGit hardening — hostile pre-planted shadow repo", () => {
  /** Plants a shadow .git at shadowGitDir(ws) via RAW, unmitigated git calls
   *  (never through TL) with a hostile pre-commit hook and a hostile
   *  core.fsmonitor command, both of which touch a canary file in `ws` when
   *  actually executed. Mirrors the audit: "git init" on an existing shadow
   *  .git preserves hooks/config, so this simulates a workspace that ARRIVES
   *  hostile, before TL's ensureInit ever runs. */
  function plantHostileShadowRepo(ws: string): { precommitCanary: string; fsmonitorCanary: string } {
    const gitDir = shadowGitDir(ws);
    fs.mkdirSync(path.dirname(gitDir), { recursive: true });
    const precommitCanary = path.join(ws, "CANARY_PRECOMMIT");
    const fsmonitorCanary = path.join(ws, "CANARY_FSMONITOR");

    const init = spawnSync("git", ["--git-dir", gitDir, "--work-tree", ws, "init"], { encoding: "utf8" });
    expect(init.status).toBe(0);

    writeExecutable(
      path.join(gitDir, "hooks", "pre-commit"),
      `#!/bin/sh\ntouch '${precommitCanary}'\nexit 0\n`,
    );
    spawnSync("git", ["--git-dir", gitDir, "config", "core.fsmonitor", `touch '${fsmonitorCanary}'`], { encoding: "utf8" });
    spawnSync("git", ["--git-dir", gitDir, "config", "user.email", "attacker@evil.example"], { encoding: "utf8" });
    spawnSync("git", ["--git-dir", gitDir, "config", "user.name", "Attacker"], { encoding: "utf8" });

    return { precommitCanary, fsmonitorCanary };
  }

  test("sanity: the planted fixture DOES run unmitigated (proves the attack is real, not a no-op fixture)", () => {
    const ws = mkWorkspace("tl-sgh-sanity-");
    const { precommitCanary, fsmonitorCanary } = plantHostileShadowRepo(ws);
    const gitDir = shadowGitDir(ws);
    writeFile(ws, "file.txt", "x\n");

    // Raw, unmitigated add+commit — exactly what shadowGit.ts issued before
    // this hardening pass (no -c overrides, no env neutralization).
    spawnSync("git", ["--git-dir", gitDir, "--work-tree", ws, "add", "--", path.join(ws, "file.txt")], { encoding: "utf8" });
    spawnSync("git", ["--git-dir", gitDir, "--work-tree", ws, "commit", "-q", "-m", "unmitigated"], { encoding: "utf8" });

    expect(fs.existsSync(precommitCanary)).toBe(true);
    expect(fs.existsSync(fsmonitorCanary)).toBe(true);
  });

  test("TL's real checkpoint write path neutralizes the hostile hooks/fsmonitor — commit still succeeds", () => {
    const ws = mkWorkspace("tl-sgh-hostile-");
    const { precommitCanary, fsmonitorCanary } = plantHostileShadowRepo(ws);
    writeFile(ws, "src/foo.ts", "const x = 1;\n");

    // The REAL entry point a write tool calls — ensureInit() re-inits over
    // the pre-existing hostile .git (preserving its hooks/config per the
    // audit), then stages + commits.
    const result = createCheckpoint(ws, ["src/foo.ts"], "test: hostile shadow repo");

    expect(result.ok).toBe(true);
    expect(result.checkpointId).toBeTruthy();
    expect(canaryExists(ws, "CANARY_PRECOMMIT")).toBe(false);
    expect(canaryExists(ws, "CANARY_FSMONITOR")).toBe(false);
    expect(fs.existsSync(precommitCanary)).toBe(false);
    expect(fs.existsSync(fsmonitorCanary)).toBe(false);
  });

  test("--no-verify + hooksPath neutralization: verify-gated AND non-verify-gated hooks are all inert, commit is not blocked", () => {
    const ws = mkWorkspace("tl-sgh-hooks-");
    const gitDir = shadowGitDir(ws);
    fs.mkdirSync(path.dirname(gitDir), { recursive: true });
    spawnSync("git", ["--git-dir", gitDir, "--work-tree", ws, "init"], { encoding: "utf8" });

    // post-commit and prepare-commit-msg are NOT skipped by --no-verify (git
    // only bypasses pre-commit/commit-msg) — these two prove core.hooksPath
    // neutralization is doing independent work, not just --no-verify.
    writeExecutable(path.join(gitDir, "hooks", "post-commit"), `#!/bin/sh\ntouch '${path.join(ws, "CANARY_POSTCOMMIT")}'\nexit 0\n`);
    writeExecutable(path.join(gitDir, "hooks", "prepare-commit-msg"), `#!/bin/sh\ntouch '${path.join(ws, "CANARY_PREPARE")}'\nexit 0\n`);
    // commit-msg IS verify-gated and exits 1 — if --no-verify were missing
    // (and hooksPath somehow did not neutralize it either), this would
    // ABORT the commit outright, so result.ok would be false.
    writeExecutable(path.join(gitDir, "hooks", "commit-msg"), `#!/bin/sh\ntouch '${path.join(ws, "CANARY_COMMITMSG")}'\nexit 1\n`);

    writeFile(ws, "src/bar.ts", "const y = 2;\n");
    const result = createCheckpoint(ws, ["src/bar.ts"], "test: hooks inert");

    expect(result.ok).toBe(true);
    expect(canaryExists(ws, "CANARY_POSTCOMMIT")).toBe(false);
    expect(canaryExists(ws, "CANARY_PREPARE")).toBe(false);
    expect(canaryExists(ws, "CANARY_COMMITMSG")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// (b) GIT_CONFIG_GLOBAL hijack — an ambient env var, not a workspace plant
// ---------------------------------------------------------------------------

describe("shadowGit hardening — GIT_CONFIG_GLOBAL hijack", () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    savedEnv.GIT_CONFIG_GLOBAL = process.env.GIT_CONFIG_GLOBAL;
    savedEnv.GIT_CONFIG_SYSTEM = process.env.GIT_CONFIG_SYSTEM;
  });

  afterEach(() => {
    for (const key of Object.keys(savedEnv)) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  test("a hostile GIT_CONFIG_GLOBAL (core.hooksPath) set in the process env is NOT honored by the checkpoint write path", () => {
    const ws = mkWorkspace("tl-sgh-globalcfg-");
    const hostileHooksDir = fs.mkdtempSync(path.join(os.tmpdir(), "tl-sgh-hostilehooks-"));
    tmpDirs.push(hostileHooksDir);
    const canary = path.join(ws, "CANARY_GLOBAL_HOOKSPATH");
    writeExecutable(path.join(hostileHooksDir, "pre-commit"), `#!/bin/sh\ntouch '${canary}'\nexit 0\n`);

    const hostileGlobalConfig = path.join(hostileHooksDir, "hostile-global.gitconfig");
    fs.writeFileSync(hostileGlobalConfig, `[core]\n\thooksPath = ${hostileHooksDir}\n`, "utf8");

    // Simulates a hostile parent process / shell profile / MCP host setting
    // this in the environment TL's node process inherits.
    process.env.GIT_CONFIG_GLOBAL = hostileGlobalConfig;

    writeFile(ws, "src/baz.ts", "const z = 3;\n");
    const result = createCheckpoint(ws, ["src/baz.ts"], "test: global config hijack");

    expect(result.ok).toBe(true);
    expect(fs.existsSync(canary)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// (d) closureTracking — read-only workspace-repo scan against a hostile
//     core.fsmonitor, plus graceful timeout degradation.
// ---------------------------------------------------------------------------

describe("closureTracking hardening — workspace core.fsmonitor is never executed", () => {
  function gitInitWorkspaceRepo(dir: string): void {
    spawnSync("git", ["-C", dir, "init"], { encoding: "utf8" });
    spawnSync("git", ["-C", dir, "config", "user.email", "t@t.com"], { encoding: "utf8" });
    spawnSync("git", ["-C", dir, "config", "user.name", "T"], { encoding: "utf8" });
  }

  test("a workspace repo with a canary-writing core.fsmonitor: the git-detected scan never runs it, and still returns a sane (open, not thrown) result", () => {
    const ws = mkWorkspace("tl-sgh-closure-fsmon-");
    gitInitWorkspaceRepo(ws);
    const canary = path.join(ws, "CANARY_CLOSURE_FSMONITOR");
    // Real, unmitigated config set directly on the WORKSPACE's own repo (not
    // the shadow checkpoint repo) — this is the developer's/attacker's repo
    // config, exactly the scenario the audit flagged for `git status`.
    spawnSync("git", ["-C", ws, "config", "core.fsmonitor", `touch '${canary}'`], { encoding: "utf8" });

    resetWorkspace(ws);
    const checks: PackCheckRecord[] = [{ id: "c1", desc: "canary check", token: "TOKEN_NEVER_PRESENT", glob: "*.ts" }];
    recordPackChecks(ws, "q", checks);
    writeFile(ws, "src/untouched.ts", "export const untouched = 1;\n");

    // No readFile seam → includeGit=true inside computeClosureState, so the
    // git-detected scan (gitModifiedPaths, the hardened :221-252 region)
    // actually runs.
    const state = computeClosureState(ws);

    expect(fs.existsSync(canary)).toBe(false);
    // Sane result: the (unsatisfiable) check is reported open, not thrown.
    expect(state).toBeDefined();
    expect(state?.total).toBe(1);
    expect(state?.done).toBe(0);
    expect(state?.open.map((c) => c.id)).toEqual(["c1"]);
  });

  test("a hung git spawn degrades gracefully within the timeout bound (never throws, never hangs past it)", () => {
    const ws = mkWorkspace("tl-sgh-closure-timeout-");
    resetWorkspace(ws);
    const checks: PackCheckRecord[] = [{ id: "c1", desc: "canary check", token: "TOKEN_NEVER_PRESENT", glob: "*.ts" }];
    recordPackChecks(ws, "q", checks);

    const fakeBinDir = fs.mkdtempSync(path.join(os.tmpdir(), "tl-sgh-fakebin-"));
    tmpDirs.push(fakeBinDir);
    // exec (not a subshell) so Node's kill signal reaches `sleep` directly.
    writeExecutable(path.join(fakeBinDir, "git"), `#!/bin/sh\nexec sleep 8\n`);

    const savedPath = process.env.PATH;
    process.env.PATH = `${fakeBinDir}${path.delimiter}${savedPath ?? ""}`;
    try {
      const started = Date.now();
      const state = computeClosureState(ws);
      const elapsedMs = Date.now() - started;

      // Bounded well under the fake binary's 8s sleep — proves the 5000ms
      // timeout actually killed the hung process rather than waiting it out.
      expect(elapsedMs).toBeLessThan(7000);
      // Graceful "unknown" degradation: the check stays open, same shape as
      // the existing non-git-available fallback — never throws.
      expect(state).toBeDefined();
      expect(state?.total).toBe(1);
      expect(state?.done).toBe(0);
    } finally {
      process.env.PATH = savedPath;
    }
  });
});
