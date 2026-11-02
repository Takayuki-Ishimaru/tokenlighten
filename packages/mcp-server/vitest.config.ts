import { defineConfig } from "vitest/config";
import * as os from "node:os";

// Concurrency + timeout hardening (deflake).
//
// 34 of the ~74 spec files spawn real MCP server subprocesses over stdio. Under
// Vitest's default fork count (~cpus-1) the full suite ran that many heavy
// files at once, each launching child servers, and the machine oversubscribed:
// observed wall-clock ballooned to readCodePack.spec 106s / locateTaskContext
// 133s per FILE, which (a) blew the default 5000ms per-test timeout on the
// in-process unit tests those files also contain, and (b) starved tree-sitter
// parses enough to perturb a locate classification (sliding-window
// exhaustive-initializer -> related-member-hit). Every one of those specs is
// rock-solid in isolation; the flakes were purely contention. The default pool
// (threads) additionally crashed the runner outright (exit 144) under the same
// pressure.
//
// So: pin the forks pool (no threads crash), keep module isolation explicit
// (fresh singletons per file — several specs reset handleTable/session/
// dedupe-cache defensively and rely on not inheriting a sibling's state), cap
// concurrent files (MAX_FORKS) so the subprocess storm can't oversubscribe,
// raise the per-test/hook timeouts as a cross-run safety belt (several
// machines run this suite concurrently, which no single config can cap).
const CPUS = typeof os.availableParallelism === "function" ? os.availableParallelism() : os.cpus().length;
const TOTAL_MEM_GB = os.totalmem() / 1024 ** 3;
// 2026-11-01: two files at once took 109 minutes on 12 CPUs. That cap predates
// `--liftoff-only`, which took a server from about 750 MB to about 220 MB, so it scales
// with the machine now: half the CPUs, 4 GB per file, at most six files.
const MAX_FORKS = Math.max(1, Math.min(6, Math.floor(CPUS / 2), Math.floor(TOTAL_MEM_GB / 4)));

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "src/**/*.spec.ts"],
    environment: "node",
    // 2026-09-20: same HOME-child fixture cleanup as the ROOT vitest.config.ts
    // (see helpers/homeTempJanitor.setup.ts). Keep the two in sync.
    globalSetup: ["./src/__tests__/helpers/homeTempStaleSweep.global.ts"],
    setupFiles: ["./src/__tests__/helpers/homeTempJanitor.setup.ts"],
    // 2026-08-01: same explicit HOME authority as the ROOT vitest.config.ts
    // (tests create isolated direct children of HOME; production has no
    // ambient HOME grant — this mirrors the server's --allowed-parent
    // option). Without it, `cd packages/mcp-server && npm test` — the verify
    // entry the server's own verification kit advertises — deterministically
    // failed ~130 spawned-server tests with invalid-cwd refusals while the
    // same specs passed from the repo root. Keep in sync with the root config.
    // P0a §6.1: canonical-decision invariant strictness — see the ROOT
    // vitest.config.ts comment. Keep the two env blocks in sync.
    env: {
      TOKENLIGHTEN_ALLOWED_PARENTS: os.homedir(),
      TL_DECISION_INVARIANT_STRICT: "1",
      // The test suite intentionally exercises legacy fixtures; production
      // remains refuse-by-default and tests opt in explicitly/cross-platform.
      TL_LEGACY_INPUT: "accept",
    },
    // Memory (2026-09-27, measured): V8's optimizing compiler (TurboFan)
    // re-compiling tree-sitter's WebAssembly grammars takes ~0.5-1 GB of
    // transient native memory per process on the first query-bearing
    // task_pack — retained by malloc afterwards, so every in-process worker and
    // every spawned test server sat at ~1.4 GB (peaks of 5.6 GB of servers on
    // one full-suite run). `--liftoff-only` keeps WebAssembly on the baseline
    // compiler: the same pack stays at ~0.17 GB. Test semantics are unchanged
    // (only code generation differs). Spawned test servers pass the same flag
    // after the tsx CLI path (`testServerMemoryFence.spec.ts` checks both).
    execArgv: ["--liftoff-only"],
    pool: "forks",
    isolate: true,
    // vitest 4 (2026-09-18, advisory GHSA-82fw-gwwq-j7x9 fix): poolOptions.forks
    // {maxForks, minForks} became the top-level maxWorkers; minWorkers was removed.
    maxWorkers: MAX_FORKS,
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
