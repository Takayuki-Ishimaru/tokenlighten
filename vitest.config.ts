import { defineConfig } from "vitest/config";
import { availableParallelism, cpus, homedir, totalmem } from "node:os";

// Concurrency + timeout hardening (deflake) — 2026-08-01: hoisted from
// packages/mcp-server/vitest.config.ts (see its longer rationale comment) so
// BOTH invocation forms behave identically: ~34 mcp-server spec files spawn
// real MCP server subprocesses over stdio, and the default pool oversubscribed
// the machine (per-file wall-clock over 100s, blown 5s timeouts, an outright
// threads-pool crash). Keep the two configs' pool/timeout blocks in sync.
const CPUS = typeof availableParallelism === "function" ? availableParallelism() : cpus().length;
const TOTAL_MEM_GB = totalmem() / 1024 ** 3;
// Keep the root invocation at the same cap as the package config: each file can
// spawn multiple real MCP stdio servers, so a bare CPU count would still create a
// multiplicative process load.
// 2026-11-01: two files at once took 109 minutes on 12 CPUs. That cap predates
// `--liftoff-only`, which took a server from about 750 MB to about 220 MB, so it scales
// with the machine now: half the CPUs, 4 GB per file, at most six files.
const MAX_FORKS = Math.max(1, Math.min(6, Math.floor(CPUS / 2), Math.floor(TOTAL_MEM_GB / 4)));

export default defineConfig({
  test: {
    // Find tests in all packages
    include: ["packages/*/src/**/*.test.ts", "packages/*/src/**/*.spec.ts", "scripts/*.spec.mjs"],
    // ESM-first — no transforms needed for .ts with Node 20+
    environment: "node",
    // Fixture directories a killed worker left under HOME; see the module itself.
    // Keep in sync with packages/mcp-server/vitest.config.ts.
    globalSetup: ["./packages/mcp-server/src/__tests__/helpers/homeTempStaleSweep.global.ts"],
    // S3 (v0.14.3 pre-release fix wave, test isolation leak): `npm run
    // test`/`npm run test:packages` runs every package's specs through
    // THIS root config (there is no vitest.workspace.ts tying per-package
    // configs together), so the guard that protects packages/cli's specs
    // from rewriting the developer's REAL managed/legacy launcher shim
    // must be wired here too, not only in packages/cli/vitest.config.ts.
    // Read-only guard; see the module itself.
    setupFiles: [
      "./packages/cli/src/__tests__/realLauncherGuard.setup.ts",
      // 2026-09-20: removes the HOME-child fixture directories a spec file
      // created (about 200 files build their workspace under HOME on
      // purpose) once that file's hooks finish — see the module itself.
      // Keep in sync with packages/mcp-server/vitest.config.ts.
      "./packages/mcp-server/src/__tests__/helpers/homeTempJanitor.setup.ts",
    ],
    // Tests intentionally create isolated direct children of HOME. Production
    // has no ambient HOME grant; this is the same explicit authority as the
    // server's repeatable --allowed-parent option.
    // P0a §6.1 (2026-08-13): the dispatcher's canonical-decision fence always
    // REPAIRS a route/contract/continuation contradiction; strict mode makes a
    // violation that survives the repair throw, so a regression fails loudly
    // here instead of shipping a self-contradicting response to an agent.
    // Keep in sync with packages/mcp-server/vitest.config.ts.
    env: {
      TOKENLIGHTEN_ALLOWED_PARENTS: homedir(),
      TL_DECISION_INVARIANT_STRICT: "1",
      // Legacy fixtures use the v0.13 compatibility escape hatch explicitly.
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
