import { defineConfig } from "vitest/config";
import { availableParallelism, cpus, homedir } from "node:os";

// Concurrency + timeout hardening (deflake) — 2026-08-01: hoisted from
// packages/mcp-server/vitest.config.ts (see its longer rationale comment) so
// BOTH invocation forms behave identically: ~34 mcp-server spec files spawn
// real MCP server subprocesses over stdio, and the default pool oversubscribed
// the machine (per-file wall-clock over 100s, blown 5s timeouts, an outright
// threads-pool crash). Keep the two configs' pool/timeout blocks in sync.
const CPUS = typeof availableParallelism === "function" ? availableParallelism() : cpus().length;
// Keep the root invocation at the same two-file cap as the package config:
// each file can spawn multiple real MCP stdio servers, so CPU-count-based
// parallelism still creates a multiplicative process load.
const MAX_FORKS = Math.min(2, Math.max(1, Math.floor(CPUS / 2)));

export default defineConfig({
  test: {
    // Find tests in all packages
    include: ["packages/*/src/**/*.test.ts", "packages/*/src/**/*.spec.ts", "scripts/*.spec.mjs"],
    // ESM-first — no transforms needed for .ts with Node 20+
    environment: "node",
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
    pool: "forks",
    isolate: true,
    // vitest 4 (2026-09-18, advisory GHSA-82fw-gwwq-j7x9 fix): poolOptions.forks
    // {maxForks, minForks} became the top-level maxWorkers; minWorkers was removed.
    maxWorkers: MAX_FORKS,
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
