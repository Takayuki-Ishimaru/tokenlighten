import { defineConfig } from "vitest/config";
import { availableParallelism, cpus, homedir } from "node:os";

// Concurrency + timeout hardening (deflake) — 2026-08-01: hoisted from
// packages/mcp-server/vitest.config.ts (see its longer rationale comment) so
// BOTH invocation forms behave identically: ~34 mcp-server spec files spawn
// real MCP server subprocesses over stdio, and the default pool oversubscribed
// the machine (per-file wall-clock over 100s, blown 5s timeouts, an outright
// threads-pool crash). Keep the two configs' pool/timeout blocks in sync.
const CPUS = typeof availableParallelism === "function" ? availableParallelism() : cpus().length;
const MAX_FORKS = Math.max(1, Math.min(4, Math.floor(CPUS / 2)));

export default defineConfig({
  test: {
    // Find tests in all packages
    include: ["packages/*/src/**/*.test.ts", "packages/*/src/**/*.spec.ts"],
    // ESM-first — no transforms needed for .ts with Node 20+
    environment: "node",
    // Tests intentionally create isolated direct children of HOME. Production
    // has no ambient HOME grant; this is the same explicit authority as the
    // server's repeatable --allowed-parent option.
    // P0a §6.1 (2026-08-13): the dispatcher's canonical-decision fence always
    // REPAIRS a route/contract/continuation contradiction; strict mode makes a
    // violation that survives the repair throw, so a regression fails loudly
    // here instead of shipping a self-contradicting response to an agent.
    // Keep in sync with packages/mcp-server/vitest.config.ts.
    env: { TOKENLIGHTEN_ALLOWED_PARENTS: homedir(), TL_DECISION_INVARIANT_STRICT: "1" },
    pool: "forks",
    isolate: true,
    poolOptions: {
      forks: {
        maxForks: MAX_FORKS,
        minForks: 1,
      },
    },
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
