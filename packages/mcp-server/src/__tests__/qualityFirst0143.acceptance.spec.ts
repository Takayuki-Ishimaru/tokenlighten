/**
 * qualityFirst0143.acceptance.spec.ts — plan-0143 (v0.14.3 improvement plan)
 * §9.1 stage A ("基準固定" / baseline-fixing) fail-first acceptance spec.
 *
 * Runs every scenario in `./helpers/qualityFirstScenarios.ts` — the ONE
 * shared fixture/scenario/verdict definition also used by
 * `scripts/tl-quality-eval.mjs` — against the DEV server (this working
 * tree's own `bin.ts`, via `tsx`) under BOTH configs (`default`, `vscode`;
 * see brief-common.md "Builds available for A/B").
 *
 * Harness pattern (spawn / stdio JSON-RPC / temp-dir helpers) follows
 * `rangedBatchNextPreservation.spec.ts` and
 * `explorationContinuation.characterization.spec.ts`. The `PENDING_FIXES` +
 * `itFor` fail-first convention is copied verbatim from
 * `explorationContinuation.characterization.spec.ts` (itself citing
 * `replayCorpus.spec.ts`'s rule): NEVER weaken an assertion to make a
 * currently-broken case pass — register it in `PENDING_FIXES` as an
 * `it.fails` instead, and flip the entry OUT once the fix lands. If a
 * registered `it.fails` starts passing unexpectedly, vitest itself fails
 * loudly (an expected failure that stopped failing) — that is the signal to
 * remove the entry, not to leave it in "for safety".
 *
 * SERVER-PER-SCENARIO, NOT SHARED (considered and rejected, brief-w0b §4):
 * each `it()` spawns its OWN server rather than sharing one per config across
 * all 16 scenario ids. S01 specifically tests epoch/lane/task-state
 * isolation and a server RESTART — running it (and every other scenario) on
 * a freshly spawned process is what makes that isolation meaningful to test
 * at all; a shared server would need every scenario to also prove it leaves
 * no residue for the NEXT one, which is extra surface this wave has no
 * evidence is safe. Measured cost of NOT sharing: the whole file (33 cases,
 * 32 real + 1 `it.todo`) runs in ~21s on this machine (`npx vitest run
 * .../qualityFirst0143.acceptance.spec.ts --maxWorkers=2`) — judged
 * reasonable enough that the isolation is worth keeping.
 */
import { afterAll, afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";

import { shortTmpDir } from "./helpers/shortTmpDir.js";
import { rmDirWithRetry } from "./helpers/rmDirWithRetry.js";
import {
  CONFIG_NAMES,
  MANUAL_SCENARIOS,
  SCENARIOS,
  startDevServer,
  type ConfigName,
  type ScenarioContext,
  type ServerHandle,
} from "./helpers/qualityFirstScenarios.js";

const HOME = process.env["HOME"] ?? process.env["USERPROFILE"] ?? os.homedir();

/**
 * Scenario ids CONFIRMED failing against this working tree, re-verified by
 * an actual `npx vitest run` of this file immediately before this map was
 * last edited (2026-09-21; this is a SHARED working tree — see
 * brief-common.md "another agent may be editing the same working tree at
 * the same time" — so this map reflects a live snapshot, not a fixed
 * per-version assumption). See the wave report's reproduction ledger for
 * the exact call chains and response fields observed on the real
 * v0.14.2/v0.14.3 builds this dev tree is derived from.
 *
 * R01 (TL-01), C01a (TL-05) and C01b (TL-05) were all confirmed FAILING
 * against the v0.14.2/v0.14.3 builds (plan's exact 98/150 and 78/150 numbers
 * reproduced for R01; the 150-line request expanding to 400 lines reproduced
 * for C01a; the emitted `next` never carrying `budget` reproduced for C01b —
 * see the wave report) but are NO LONGER registered here: re-running this
 * spec against the live dev tree caught their `it.fails(...)` themselves
 * failing ("Expect test to fail") — i.e. all three now PASS on this tree,
 * under BOTH configs — while this wave's other agents were landing
 * TL-01/TL-05 work concurrently (confirmed twice, minutes apart, for R01/
 * C01b during this file's own authoring, and again for C01a once FIX-A2's
 * `mode=full` paths[] batch widening fix and admission-guarantee landed).
 * This is the intended signal (per
 * `explorationContinuation.characterization.spec.ts`'s own convention):
 * when a registered `it.fails` unexpectedly starts passing, remove the
 * entry, do not leave it "for safety". If any of them regresses again,
 * vitest will fail loudly here and the entry should be re-added.
 *
 * `C02a` and `Q04` are NOT here: both were independently confirmed PASSING
 * on this tree under both configs (regression controls per plan §3.3 /
 * brief-w0.md) — they run as plain `it()` and must stay green.
 *
 * FIX-C update (2026-09-21): Q01 (TL-02) and Q03 (TL-03) are NO LONGER
 * registered here — re-running this spec after landing D1/D2 (the
 * concentration-discipline and doc-vs-code candidate-competition fixes in
 * `proveUnbindableRequestItem`) and C1-C3 (the single JA-bridge-aware
 * `concernTermVariants` generator, the consistency veto, and the
 * topic-vs-predicate Tier C anchor) caught their `it.fails(...)` themselves
 * failing ("Expect test to fail") under BOTH configs. Per this file's own
 * convention: do not leave a flipped entry "for safety" — if either
 * regresses, vitest fails loudly here and the entry should be re-added.
 * Q05 (TL-04) is still pending: FIX-C's D2 fix corrects the "authentication"
 * concern's own candidate discovery, but Q05 as a whole is not yet
 * confirmed passing end to end (see the wave report for the live trace).
 *
 * W0b update (2026-09-21): completed the plan §10 acceptance table with R02,
 * R03, R04, Q02, Q06, S01, C02b and a manual H01 placeholder (see
 * `MANUAL_SCENARIOS`, executed as `it.todo` below, never asserted). Any of
 * these that were confirmed failing on this same live re-run are registered
 * below by whichever agent's wave report names the smallest reproducing
 * chain — see that report for exact call shapes and decisive response
 * fields; this file only pins the CURRENT pass/fail snapshot.
 */
/*
 * FIX-C2 update (2026-09-21): Q05 (TL-04) and Q02 (TL-03) are NO LONGER
 * registered here — re-running this spec after landing the single
 * concern-status policy (`readCodeTaskPack.ts`'s
 * `concernCoveredByServedEvidence` / `decideConcernStatus`, which every
 * request-item path now routes its status decision through) caught their
 * `it.fails(...)` themselves failing ("Expect test to fail") under BOTH
 * configs. Q05's four-concern chain now reaches `act.answer` with all four
 * modules served and keeps it across a bare-`{qref}` re-pack; both JP Q02
 * members reach `act.answer` with the genuinely absent migration concern
 * disclosed. Per this file's own convention, a flipped entry is removed, not
 * left "for safety": if either regresses, vitest fails loudly here and the
 * entry should be re-added. The invariants behind both are pinned
 * independently by `concernStatusPolicyMatrix.spec.ts`.
 */
export const PENDING_FIXES: Record<string, string> = {};

function itFor(id: string): typeof it | typeof it.fails {
  return PENDING_FIXES[id] ? it.fails : it;
}

const tmpDirs: string[] = [];
const servers: ServerHandle[] = [];

// Every server is started inside one test (a fresh `startDevServer` per
// scenario, never shared across `it`s); stop it — and S01's restart handle
// alongside it — when that test ends, so the file never holds all 32
// scenarios' servers alive at once. `kill()` on an already-killed handle
// (S01 already killed its own old handle before restarting) is a safe no-op
// (qualityFirstScenarios.ts's `spawnJsonRpcServer` tolerates re-kill).
afterEach(async () => {
  for (const server of servers.splice(0)) {
    await server.kill();
  }
});

afterAll(async () => {
  for (const server of servers.splice(0)) {
    await server.kill();
  }
  for (const dir of tmpDirs.splice(0)) {
    try {
      await rmDirWithRetry(dir);
    } catch {
      /* best-effort cleanup */
    }
  }
});

for (const config of CONFIG_NAMES as readonly ConfigName[]) {
  describe(`quality-first 0143 acceptance (config=${config})`, () => {
    for (const scenario of SCENARIOS) {
      itFor(scenario.id)(
        `${scenario.id} [${scenario.planItem}] — ${scenario.summary}`,
        async () => {
          const ws = fs.realpathSync(shortTmpDir(HOME, `.tl-qf0143-${config}-${scenario.id}-`));
          tmpDirs.push(ws);
          scenario.buildWorkspace(ws);

          const startOpts = { allowWrite: scenario.needsWrite === true };
          let currentServer = startDevServer(ws, config, startOpts);
          servers.push(currentServer);
          await currentServer.initialize();

          const ctx: ScenarioContext = {
            server: currentServer,
            ws,
            // S01 ("a server RESTART mid-chain"): kills the current server and
            // starts a fresh one on the SAME workspace/config, tracked for the
            // same afterAll cleanup. Every other scenario ignores this.
            async restartServer(): Promise<ServerHandle> {
              await currentServer.kill();
              currentServer = startDevServer(ws, config, startOpts);
              servers.push(currentServer);
              await currentServer.initialize();
              return currentServer;
            },
          };

          const verdict = await scenario.run(ctx);
          expect(verdict.pass, `${verdict.reason}\nmetrics=${JSON.stringify(verdict.metrics, null, 2)}`).toBe(true);
        },
        120_000,
      );
    }
  });
}

// Plan §10 rows out of this harness's automation scope (H01: a real host
// install/reconnect needs an actual VS Code/Copilot client). Listed as
// `it.todo` so the acceptance table has a visible, documented placeholder in
// test output — `it.todo` never runs and is never counted pass/fail.
describe("quality-first 0143 acceptance (manual / out of automation scope)", () => {
  for (const manual of MANUAL_SCENARIOS) {
    it.todo(`${manual.id} [${manual.planItem}] — ${manual.summary}`);
  }
});
