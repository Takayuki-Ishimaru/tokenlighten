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
// forks to half the cores so the subprocess storm can't oversubscribe, and
// raise the per-test/hook timeouts as a cross-run safety belt (several
// machines run this suite concurrently, which no single config can cap).
const CPUS = typeof os.availableParallelism === "function" ? os.availableParallelism() : os.cpus().length;
const MAX_FORKS = Math.max(1, Math.min(4, Math.floor(CPUS / 2)));

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "src/**/*.spec.ts"],
    environment: "node",
    // 2026-08-01: same explicit HOME authority as the ROOT vitest.config.ts
    // (tests create isolated direct children of HOME; production has no
    // ambient HOME grant — this mirrors the server's --allowed-parent
    // option). Without it, `cd packages/mcp-server && npm test` — the verify
    // entry the server's own verification kit advertises — deterministically
    // failed ~130 spawned-server tests with invalid-cwd refusals while the
    // same specs passed from the repo root. Keep in sync with the root config.
    // P0a §6.1: canonical-decision invariant strictness — see the ROOT
    // vitest.config.ts comment. Keep the two env blocks in sync.
    env: { TOKENLIGHTEN_ALLOWED_PARENTS: os.homedir(), TL_DECISION_INVARIANT_STRICT: "1" },
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
