/**
 * evaluation0927.acceptance.spec.ts — fail-first acceptance spec for the
 * external v0.14.3 evaluation dated 2026-09-27
 * (`~/.cache/tokenlighten-wave-0927/eval-0927.md`; brief-w0.md).
 *
 * Runs every scenario in `./helpers/evaluation0927Scenarios.ts` — the ONE
 * shared fixture/scenario/verdict definition also used by
 * `scripts/tl-quality-eval.mjs --suite 0927` — against the DEV server (this
 * working tree's own `bin.ts`, via `tsx`) under BOTH configs (`default`,
 * `vscode`; brief-common.md "Builds available for A/B").
 *
 * Harness pattern, `PENDING_FIXES`/`itFor` fail-first convention, and the
 * SERVER-PER-SCENARIO (not shared) choice are copied verbatim from
 * `qualityFirst0143.acceptance.spec.ts` (which itself cites
 * `explorationContinuation.characterization.spec.ts`'s rule): NEVER weaken
 * an assertion to make a currently-broken case pass — register it in
 * `PENDING_FIXES` as an `it.fails` instead, and flip the entry OUT once the
 * fix lands. If a registered `it.fails` starts passing unexpectedly, vitest
 * itself fails loudly (an expected failure that stopped failing) — that is
 * the signal to remove the entry, not to leave it in "for safety".
 */
import { afterAll, afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";

import { shortTmpDir } from "./helpers/shortTmpDir.js";
import { rmDirWithRetry } from "./helpers/rmDirWithRetry.js";
import {
  CONFIG_NAMES,
  startDevServer,
  type ConfigName,
  type ScenarioContext,
  type ServerHandle,
} from "./helpers/qualityFirstScenarios.js";
import { SCENARIOS_0927 } from "./helpers/evaluation0927Scenarios.js";

const HOME = process.env["HOME"] ?? process.env["USERPROFILE"] ?? os.homedir();

/**
 * Scenario ids CONFIRMED failing against this working tree, re-verified by
 * an actual `npx vitest run` of this file immediately before this map was
 * last edited (2026-09-27). This is a SHARED working tree (brief-common.md:
 * "another agent may be editing the same working tree at the same time"),
 * and W0's OWN brief is acceptance-harness-only (no product code) — every
 * entry below is a REPORTED, not fixed, defect. See the wave report's
 * fail-first ledger for the exact call chains and response fields observed.
 *
 * Per this file's own convention (and `qualityFirst0143.acceptance.spec.ts`'s
 * precedent): when a registered `it.fails` unexpectedly starts passing
 * (i.e. a later wave lands the fix), vitest fails loudly here ("Expect test
 * to fail") — that is the signal to remove the entry, not to leave it "for
 * safety".
 *
 * V08 (eval §6.2, the "verify by diff review" / `deps_installed:false`
 * finding) is NOT registered here: an actual `npx vitest run` of this file
 * against this dev tree (2026-09-27) found it PASSING, both configs — the
 * built-in `node --test` run is not reported unrunnable and the control
 * member still discloses its declared-but-uninstalled devDependency. This
 * dev tree already carries the uncommitted 09-21/22 wave (brief-common.md);
 * whether that wave (or an earlier fix) is why was not traced further, since
 * W0's own brief is acceptance-harness-only. If this regresses, vitest fails
 * loudly here and the entry should be re-added.
 *
 * V06 (eval §5, multi-target `content:"full"` + explicit range) is ALSO NOT
 * registered: an actual `npx vitest run` found it PASSING, both configs
 * (0 missing, 0 out-of-range, matching single-target semantics) — this
 * confirms brief-common.md's "FIXED in c0922" for this dev tree too. An
 * EARLIER run of this same file registered V06 as failing; that was this
 * harness's OWN bug (`runSingleTargetEquivalenceMember` re-read, without
 * `task.force_serve`, files the SAME scenario's other members had already
 * read in full moments before, so the server correctly receipted them small
 * and this file's own line-extraction misread the receipt as "420 lines
 * missing") — fixed in `evaluation0927Scenarios.ts`, not a product defect.
 */
export const PENDING_FIXES: Record<string, string> = {
  // V01–V05 removed by FIX-G (2026-09-27): the facet completion gate (readCodeTaskPack.ts
  // `buildFacetReadiness`, facetGate.ts) on FIX-C1's closure serving — all five PASS in both
  // configs and both corpus variants (no false completion, every required fact served).
  // V07 removed (2026-09-27 integration): FIX-ORIG fixed the N+1 producers, the hybrid anchor body
  // (materializeExplicitAnswerAnchorEvidence) and the masked counterexample body (narrowed to the
  // unserved sub-span nearest the matched line, blank edge lines trimmed) — PASS in both configs.
};

function itFor(id: string): typeof it | typeof it.fails {
  return PENDING_FIXES[id] ? it.fails : it;
}

const tmpDirs: string[] = [];
const servers: ServerHandle[] = [];

// Every server is started inside one test (a fresh `startDevServer` per
// scenario, never shared across `it`s); stop it — and any restart/extra
// write-server the scenario pushed alongside it — when that test ends, so
// the file never holds all scenarios' servers alive at once. `kill()` on an
// already-killed handle (a `restartServer`/`startServerWithWrite` case that
// killed its own old handle) is a safe no-op (qualityFirstScenarios.ts's
// `spawnJsonRpcServer` tolerates re-kill).
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
  describe(`evaluation-0927 acceptance (config=${config})`, () => {
    for (const scenario of SCENARIOS_0927) {
      itFor(scenario.id)(
        `${scenario.id} [${scenario.planItem}] — ${scenario.summary}`,
        async () => {
          const ws = fs.realpathSync(shortTmpDir(HOME, `.tl-ev0927-${config}-${scenario.id}-`));
          tmpDirs.push(ws);
          scenario.buildWorkspace(ws);

          const startOpts = { allowWrite: scenario.needsWrite === true };
          let currentServer = startDevServer(ws, config, startOpts);
          servers.push(currentServer);
          await currentServer.initialize();

          const ctx: ScenarioContext = {
            server: currentServer,
            ws,
            async restartServer(): Promise<ServerHandle> {
              await currentServer.kill();
              currentServer = startDevServer(ws, config, startOpts);
              servers.push(currentServer);
              await currentServer.initialize();
              return currentServer;
            },
            // V10's "write-not-enabled-readonly-server" member: an ADDITIONAL
            // server against the SAME workspace/config but its own
            // --allow-write setting (see qualityFirstScenarios.ts's
            // `ScenarioContext.startServerWithWrite` header). Tracked in the
            // same `servers` array for the shared afterAll cleanup; the
            // scenario itself kills it right after use.
            async startServerWithWrite(allowWrite: boolean, toolSurface?: "code" | "full"): Promise<ServerHandle> {
              const extra = startDevServer(ws, config, { allowWrite, ...(toolSurface !== undefined ? { toolSurface } : {}) });
              servers.push(extra);
              await extra.initialize();
              return extra;
            },
          };

          const verdict = await scenario.run(ctx);
          expect(verdict.pass, `${verdict.reason}\nmetrics=${JSON.stringify(verdict.metrics, null, 2)}`).toBe(true);
        },
        180_000,
      );
    }
  });
}
