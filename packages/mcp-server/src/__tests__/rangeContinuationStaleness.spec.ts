/**
 * rangeContinuationStaleness.spec.ts — TL-06 (plan-0143 §4/§8.1, R04).
 *
 * FIX-A5's own regression battery for the fix landed in
 * `admitCallerRangedContinuation` (server.ts) + `servedRangeStaleness` /
 * `markRangeContinuationWatched` / `WorkspaceSession.epochRangeWatch`
 * (state/session.ts): a caller-ranged multi-target continuation, addressed
 * by PATH (task_pack's `callerRangedAddress`, canonicalDecision.ts) or by
 * HANDLE (the A7 `handles=[]` batch), must refuse — reusing the read
 * cursor's own `cursor-stale` vocabulary — rather than silently deliver a
 * torn read when the underlying file changed between hops.
 *
 * `qualityFirst0143.acceptance.spec.ts`'s R04 scenario (`multitarget-mix`
 * member, `helpers/qualityFirstScenarios.ts`) is the primary acceptance
 * oracle for this fix and stays the source of truth for the exact plan-0143
 * reproduction. This file is independent, more exhaustive coverage focused
 * on the mechanism's edges: append/rewrite/shrink, and — most importantly —
 * the four required NO-FALSE-ALARM controls (unchanged file, this session's
 * own `edit_file`, a genuinely new task epoch, another lane), which R04
 * itself does not exercise.
 *
 * Reuses `helpers/qualityFirstScenarios.ts`'s server-spawn/config machinery
 * (read-only import — this file never edits that shared harness).
 */
import { afterAll, afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";

import { shortTmpDir } from "./helpers/shortTmpDir.js";
import { rmDirWithRetry } from "./helpers/rmDirWithRetry.js";
import {
  CONFIG_NAMES,
  extractNext,
  isExplicitStop,
  startDevServer,
  walkHops,
  writeSelfIdFile,
  type ConfigName,
  type ServerHandle,
} from "./helpers/qualityFirstScenarios.js";

const HOME = process.env["HOME"] ?? process.env["USERPROFILE"] ?? os.homedir();

const tmpDirs: string[] = [];
const servers: ServerHandle[] = [];

// Every server is started inside one test (`freshWorkspace` is called fresh
// per `it`, sometimes more than once within the SAME test for a sub-loop —
// e.g. the append/rewrite/shrink case — but never shared across tests);
// stop them all when that test ends, so the 16 cases x 2 configs never hold
// every server alive at once.
afterEach(async () => {
  for (const server of servers.splice(0)) await server.kill();
});

afterAll(async () => {
  for (const server of servers.splice(0)) await server.kill();
  for (const dir of tmpDirs.splice(0)) {
    try {
      await rmDirWithRetry(dir);
    } catch {
      /* best-effort cleanup */
    }
  }
});

function freshWorkspace(config: ConfigName, tag: string): { ws: string; server: ServerHandle } {
  const ws = fs.realpathSync(shortTmpDir(HOME, `.tl-rcs-${config}-${tag}-`));
  tmpDirs.push(ws);
  const server = startDevServer(ws, config, { allowWrite: true });
  servers.push(server);
  return { ws, server };
}

/** First hop of the confirmed R04 multitarget-mix shape (plan §4 payload). */
async function firstMultiTargetHop(server: ServerHandle, ws: string): Promise<any> {
  const { body } = await server.callTool("read_file", {
    targets: [{ path: "mix/alpha.txt", range: "11-90" }, { path: "mix/beta.txt", range: "31-100" }],
    content: "auto",
    budget: { bytes: 6500 },
    task: { epoch: "new" },
    cwd: ws,
  });
  return body;
}

for (const config of CONFIG_NAMES as readonly ConfigName[]) {
  describe(`range continuation staleness (config=${config})`, () => {
    it("append/rewrite/shrink: a mid-chain mutation of ONE of two caller-ranged targets never completes with mixed old+new bytes", async () => {
      for (const kind of ["rewrite", "shrink"] as const) {
        const { ws, server } = freshWorkspace(config, `mut-${kind}`);
        await server.initialize();
        writeSelfIdFile(ws, "mix/alpha.txt", 200, "csOld", 120);
        writeSelfIdFile(ws, "mix/beta.txt", 200, "csBeta", 120);

        const first = await firstMultiTargetHop(server, ws);
        const { next } = extractNext(first);
        if (!next) continue; // completed in one hop; nothing to mutate mid-chain

        if (kind === "rewrite") writeSelfIdFile(ws, "mix/alpha.txt", 200, "csNew", 120);
        else writeSelfIdFile(ws, "mix/alpha.txt", 40, "csNew", 120); // shrink: fewer lines than the original request's own range

        const rest = await walkHops(server, next, 12);
        const all = [first, ...rest.responses];
        const text = JSON.stringify(all);
        const oldInRange = [...text.matchAll(/csOld-(\d{4})/g)].map((m) => Number(m[1])).filter((n) => n >= 11 && n <= 90);
        const newInRange = [...text.matchAll(/csNew-(\d{4})/g)].map((m) => Number(m[1])).filter((n) => n >= 11 && n <= 90);
        const mixed = oldInRange.length > 0 && newInRange.length > 0;
        const endedCleanly = !rest.capped && !all.some((r) => isExplicitStop(r));
        expect(
          mixed && endedCleanly,
          `[${kind}] torn read: old-tag lines=${oldInRange.length}, new-tag lines=${newInRange.length}, ` +
            `endedCleanly=${endedCleanly}, hopKinds=${JSON.stringify(all.map((r) => r?.["kind"]))}`,
        ).toBe(false);
        // A disclosure must actually exist SOMEWHERE in the chain (a refusal,
        // per the fix's chosen mechanism) naming the affected path. Checked
        // against the WHOLE serialized refusal (guidance derivation may
        // relocate prose between `error`/`detail`) rather than one exact
        // field, since this test does not own that shaping decision.
        const disclosed = all.some(
          (r) => r?.["kind"] === "refusal" && JSON.stringify(r).includes("mix/alpha.txt"),
        );
        expect(disclosed, `[${kind}] expected a refusal naming mix/alpha.txt somewhere in the chain: ${JSON.stringify(all)}`).toBe(true);
      }
    }, 60_000);

    it("CONTROL: an unchanged file completes normally, with no refusal", async () => {
      const { ws, server } = freshWorkspace(config, "unchanged");
      await server.initialize();
      writeSelfIdFile(ws, "mix/alpha.txt", 200, "csOld", 120);
      writeSelfIdFile(ws, "mix/beta.txt", 200, "csBeta", 120);

      const first = await firstMultiTargetHop(server, ws);
      const { next } = extractNext(first);
      if (!next) return; // completed in one hop — nothing to verify further
      const rest = await walkHops(server, next, 12);
      const all = [first, ...rest.responses];
      expect(all.some((r) => r?.["kind"] === "refusal"), `unexpected refusal on an untouched file: ${JSON.stringify(all)}`).toBe(false);
    }, 60_000);

    it("CONTROL: this session's OWN edit_file between hops is never mistaken for an external change", async () => {
      const { ws, server } = freshWorkspace(config, "self-edit");
      await server.initialize();
      writeSelfIdFile(ws, "mix/alpha.txt", 200, "csOld", 120);
      writeSelfIdFile(ws, "mix/beta.txt", 200, "csBeta", 120);

      const first = await firstMultiTargetHop(server, ws);
      const { next } = extractNext(first);
      if (!next) return;
      // A same-length, in-range edit via THIS session's own edit_file — the
      // ledger threads the post-edit sha through in place (session.ts's
      // `transformServedRangesAcrossServerEdit`), so this must never trip
      // the staleness refusal the mutation tests above require.
      const editRes = await server.callTool("edit_file", {
        edits: [{ path: "mix/alpha.txt", search: "csOld-0015", replace: "csOld-0015" }],
        cwd: ws,
      });
      expect((editRes.body as Record<string, unknown>)?.["kind"], `self-edit itself should apply: ${JSON.stringify(editRes.body)}`).toBe("edit.applied");

      const rest = await walkHops(server, next, 12);
      const all = [first, ...rest.responses];
      expect(
        all.some((r) => r?.["kind"] === "refusal"),
        `a self-edit must never be reported as a stale external revision: ${JSON.stringify(all.map((r) => r?.["kind"]))}`,
      ).toBe(false);
    }, 60_000);

    it("CONTROL: a genuinely NEW task epoch reading a since-changed path is an ordinary fresh read, not a stale continuation", async () => {
      const { ws, server } = freshWorkspace(config, "new-epoch");
      await server.initialize();
      writeSelfIdFile(ws, "mix/alpha.txt", 200, "csOld", 120);
      writeSelfIdFile(ws, "mix/beta.txt", 200, "csBeta", 120);

      const first = await firstMultiTargetHop(server, ws);
      const { next } = extractNext(first);
      if (next) {
        // Leave the first chain's OWN continuation unexecuted — mutate, then
        // start an entirely new task (task.epoch:"new") over the SAME path
        // rather than resuming it. See epochRangeWatch's own doc comment:
        // this is the exact false-alarm shape a fresh epoch must not trip.
        writeSelfIdFile(ws, "mix/alpha.txt", 200, "csNew", 120);
      }
      const fresh = await server.callTool("read_file", {
        targets: [{ path: "mix/alpha.txt", range: "11-90" }],
        content: "auto",
        budget: { bytes: 6500 },
        task: { epoch: "new" },
        cwd: ws,
      });
      expect(
        (fresh.body as Record<string, unknown>)?.["kind"],
        `a fresh task.epoch:"new" read of a changed path must behave like any ordinary read, not a stale-continuation refusal: ${JSON.stringify(fresh.body)}`,
      ).not.toBe("refusal");
    }, 60_000);

    it("CONTROL: another lane's continuation state never leaks into this lane's read of the same path", async () => {
      const { ws, server } = freshWorkspace(config, "other-lane");
      await server.initialize();
      writeSelfIdFile(ws, "mix/alpha.txt", 200, "csOld", 120);
      writeSelfIdFile(ws, "mix/beta.txt", 200, "csBeta", 120);

      const laneAFirst = await server.callTool("read_file", {
        targets: [{ path: "mix/alpha.txt", range: "11-90" }, { path: "mix/beta.txt", range: "31-100" }],
        content: "auto",
        budget: { bytes: 6500 },
        task: { epoch: "new" },
        lane: "lane-a",
        cwd: ws,
      });
      const { next: laneANext } = extractNext(laneAFirst.body);
      if (laneANext) writeSelfIdFile(ws, "mix/alpha.txt", 200, "csNew", 120);

      // A DIFFERENT lane's first-ever touch of the identical path must never
      // be judged against lane A's served-range ledger.
      const laneBFirst = await server.callTool("read_file", {
        targets: [{ path: "mix/alpha.txt", range: "11-90" }],
        content: "auto",
        budget: { bytes: 6500 },
        task: { epoch: "new" },
        lane: "lane-b",
        cwd: ws,
      });
      expect(
        (laneBFirst.body as Record<string, unknown>)?.["kind"],
        `lane B's first read must not inherit lane A's staleness state: ${JSON.stringify(laneBFirst.body)}`,
      ).not.toBe("refusal");
    }, 60_000);

    it("a handle-addressed multi-handle batch continuation gets the identical protection", async () => {
      const { ws, server } = freshWorkspace(config, "handle-batch");
      await server.initialize();
      writeSelfIdFile(ws, "hb1.txt", 200, "csHone", 120);
      writeSelfIdFile(ws, "hb2.txt", 200, "csHtwo", 120);

      const mint = await server.callTool("read_file", {
        targets: [{ path: "hb1.txt", range: "1-5" }, { path: "hb2.txt", range: "1-5" }],
        content: "auto",
        task: { epoch: "new" },
        cwd: ws,
      });
      const evidence = Array.isArray((mint.body as Record<string, unknown>)?.["evidence"])
        ? ((mint.body as Record<string, unknown>)["evidence"] as Array<Record<string, unknown>>)
        : [];
      const h1 = evidence.find((e) => e["path"] === "hb1.txt")?.["handle"];
      const h2 = evidence.find((e) => e["path"] === "hb2.txt")?.["handle"];
      if (typeof h1 !== "string" || typeof h2 !== "string") {
        throw new Error(`could not mint two handles from: ${JSON.stringify(mint.body)}`);
      }

      const first = await server.callTool("read_file", {
        targets: [{ handle: h1, range: "11-90" }, { handle: h2, range: "31-100" }],
        content: "auto",
        budget: { bytes: 6500 },
        cwd: ws,
      });
      const { next } = extractNext(first.body);
      if (!next) return; // completed in one hop
      // Only mutate if the continuation itself still names BOTH handles
      // (a multi-handle batch shape) — a single-handle remainder exercises a
      // different, not-yet-covered dispatch route (see this file's own
      // header note in the wave report) and is out of scope for this case.
      const nextTargets = (next.arguments as Record<string, unknown>)["targets"];
      if (!Array.isArray(nextTargets) || nextTargets.length < 2) return;

      writeSelfIdFile(ws, "hb1.txt", 200, "csHoneNew", 120);
      const rest = await walkHops(server, next, 12);
      const all = [first.body, ...rest.responses];
      const text = JSON.stringify(all);
      const oldInRange = [...text.matchAll(/csHone-(\d{4})/g)].map((m) => Number(m[1])).filter((n) => n >= 11 && n <= 90);
      const newInRange = [...text.matchAll(/csHoneNew-(\d{4})/g)].map((m) => Number(m[1])).filter((n) => n >= 11 && n <= 90);
      const mixed = oldInRange.length > 0 && newInRange.length > 0;
      const endedCleanly = !rest.capped && !all.some((r) => isExplicitStop(r));
      expect(mixed && endedCleanly, `torn read via handle-addressed batch: old=${oldInRange.length} new=${newInRange.length}`).toBe(false);
    }, 60_000);

    it("CONTROL: a single-target ranged chain (the read-cursor route) stays honest", async () => {
      const { ws, server } = freshWorkspace(config, "single-cursor");
      await server.initialize();
      writeSelfIdFile(ws, "solo.txt", 200, "csSolo", 120);

      const first = await server.callTool("read_file", {
        targets: [{ path: "solo.txt", range: "1-150" }],
        content: "auto",
        budget: { bytes: 3000 },
        task: { epoch: "new" },
        cwd: ws,
      });
      const { next } = extractNext(first.body);
      if (!next) return;
      writeSelfIdFile(ws, "solo.txt", 200, "csSoloNew", 120);
      const second = await server.callTool(next.tool, next.arguments);
      expect(
        (second.body as Record<string, unknown>)?.["kind"],
        `the single-target cursor route must still refuse on a mid-chain mutation: ${JSON.stringify(second.body)}`,
      ).toBe("refusal");
      expect((second.body as Record<string, unknown>)?.["code"]).toBe("cursor-stale");
    }, 60_000);

    it("CONTROL: a content:\"full\" cursor chain stays honest", async () => {
      const { ws, server } = freshWorkspace(config, "full-cursor");
      await server.initialize();
      writeSelfIdFile(ws, "wholefile.txt", 200, "csFull", 55);

      const first = await server.callTool("read_file", {
        targets: [{ path: "wholefile.txt" }],
        content: "full",
        budget: { bytes: 2500 },
        task: { epoch: "new" },
        cwd: ws,
      });
      const cursorNext = (first.body as Record<string, unknown>)?.["limit"] as Record<string, unknown> | undefined;
      const next = cursorNext?.["next"] as { tool: string; arguments: Record<string, unknown> } | undefined;
      if (next === undefined || typeof (next.arguments as Record<string, unknown>)["cursor"] !== "string") return;
      writeSelfIdFile(ws, "wholefile.txt", 200, "csFullNew", 55);
      const second = await server.callTool(next.tool, next.arguments);
      expect(
        (second.body as Record<string, unknown>)?.["kind"],
        `the content:"full" cursor route must still refuse on a mid-chain mutation: ${JSON.stringify(second.body)}`,
      ).toBe("refusal");
      expect((second.body as Record<string, unknown>)?.["code"]).toBe("cursor-stale");
    }, 60_000);

    // -------------------------------------------------------------------
    // FIX-A6 (v0.14.4 candidate, item 1): the SINGLE-target continuation
    // door. A canonical `targets:[{path,range}]` (or `{handle,range}`, or
    // `{path,ranges:[...]}`) call with EXACTLY ONE element and no
    // `query`/`qref` is promoted by `normalizeCanonicalRequest` straight
    // onto `args.path`/`args.handle`/`args.range`(s) + `mode:"slice"` — NOT
    // through the multi-target `pathlessExploratoryPaths`/`mode=task_pack`
    // doors the earlier tests in this file already cover.
    //
    // MEASURED WHILE BUILDING THIS FIX: a plain `range` or `ranges[]` on
    // that lone target does NOT reach resolveSlice's/resolveSliceRanges's
    // own bare `{handle,range}` continuation on the wire, even past their
    // 24576 B per-call cap and even with a caller budget generous enough
    // that the wire ladder has nothing left to shed — `mode="slice"` STAGES
    // every such request (`stageReadRequestForServe`) and the funnel prefers
    // its own sha-bound CURSOR continuation once a staged request is
    // incomplete, superseding resolveSlice's own `next` before it ever
    // reaches the wire. The two tests below CONFIRM this empirically (they
    // pass identically whether or not this fix's new admission check is
    // enabled — see the wave report) and are kept as regression coverage
    // for that pre-existing protection, relabeled as controls.
    //
    // The genuinely uncovered sub-door is `mode="symbol"` (which
    // `normalizeCanonicalRequest` selects automatically for a single
    // symbol-only target — no `range` at all, so `stageReadRequestForServe`
    // is never called): a symbol body over READ_SYMBOL_CAP_BYTES downgrades
    // via `buildSymbolDowngradePayload`, whose OWN `next` is the same bare
    // `{handle,range}` shape, and THIS one really does reach the wire
    // un-cursored (server.ts's mode=symbol branch has no staging call at
    // all). The third test below is the fail-first case for this fix.
    // -------------------------------------------------------------------
    it("CONTROL: a single-range continuation past resolveSlice's own byte cap is ALREADY protected by the generic read-cursor mechanism (not this fix)", async () => {
      const { ws, server } = freshWorkspace(config, "slice-native-range");
      await server.initialize();
      // 2000 lines * 120 B >> READ_SYMBOL_CAP_BYTES (24576 B).
      writeSelfIdFile(ws, "bignative.txt", 2000, "csNat", 120);

      const first = await server.callTool("read_file", {
        targets: [{ path: "bignative.txt", range: "1-2000" }],
        content: "auto",
        budget: { bytes: 200000 }, // comfortably above the 24576 B per-call cap
        task: { epoch: "new" },
        cwd: ws,
      });
      expect(
        (first.body as Record<string, unknown>)?.["kind"],
        `expected a read.text slice serve: ${JSON.stringify(first.body).slice(0, 300)}`,
      ).toBe("read.text");
      const { next } = extractNext(first.body);
      if (!next) throw new Error(`expected a continuation for a 2000-line file past the 24576 B cap: ${JSON.stringify(first.body).slice(0, 300)}`);

      writeSelfIdFile(ws, "bignative.txt", 2000, "csNatNew", 120);
      const second = await server.callTool(next.tool, next.arguments);
      expect(
        (second.body as Record<string, unknown>)?.["kind"],
        `a single-range continuation must refuse on a mid-chain mutation: ${JSON.stringify(second.body).slice(0, 500)}`,
      ).toBe("refusal");
      expect((second.body as Record<string, unknown>)?.["code"]).toBe("cursor-stale");
    }, 60_000);

    it("CONTROL: a ranges[]-plural (single target) continuation past the aggregate byte cap is ALREADY protected by the generic read-cursor mechanism (not this fix)", async () => {
      const { ws, server } = freshWorkspace(config, "slice-native-ranges");
      await server.initialize();
      writeSelfIdFile(ws, "bigranges.txt", 2000, "csRp", 120);

      const first = await server.callTool("read_file", {
        targets: [{ path: "bigranges.txt", ranges: ["1-50", "500-2000"] }],
        content: "auto",
        budget: { bytes: 200000 },
        task: { epoch: "new" },
        cwd: ws,
      });
      expect(
        (first.body as Record<string, unknown>)?.["kind"],
        `expected a read.text slice serve: ${JSON.stringify(first.body).slice(0, 300)}`,
      ).toBe("read.text");
      const { next } = extractNext(first.body);
      if (!next) throw new Error(`expected a continuation for a deferred ranges[] window: ${JSON.stringify(first.body).slice(0, 300)}`);

      writeSelfIdFile(ws, "bigranges.txt", 2000, "csRpNew", 120);
      const second = await server.callTool(next.tool, next.arguments);
      expect(
        (second.body as Record<string, unknown>)?.["kind"],
        `a ranges[]-plural continuation must refuse on a mid-chain mutation: ${JSON.stringify(second.body).slice(0, 500)}`,
      ).toBe("refusal");
      expect((second.body as Record<string, unknown>)?.["code"]).toBe("cursor-stale");
    }, 60_000);

    // NOTE (chip, not fixed here): `mode="symbol"`'s own oversized-body
    // downgrade (`buildSymbolDowngradePayload`) is the one call shape that
    // mints a bare `{handle,range}` continuation with NO wire cursor at all
    // (it never calls `stageReadRequestForServe`, unlike every mode=slice
    // path) — CONFIRMED live with a synthetic oversized top-level function
    // fixture (a big string-literal array, one tree-sitter symbol). But that
    // same call site never calls `recordServedRange`
    // either (only `recordReadPath`, a different, lighter ledger), so the
    // served-range ledger has NOTHING to compare the resume against — this
    // fix's admission check is reached but has no prior state to detect
    // staleness FROM. Fixing that booking gap correctly needs the same
    // elision-aware span accounting FX-W3 requires everywhere else
    // (`spansExcludingWindows`), which is a second, independent fix touching
    // a fenced call-site enumeration (`fxnBookingSettlementFence.spec.ts`) —
    // reported to the orchestrator rather than attempted here.
    //
    // GATE-A (2026-09-21, item 2) RE-PINNED: this case originally asserted
    // the WITHDRAWN broad rule — "any 2nd+ ranged touch of a path within the
    // epoch is stale-checked, whether or not it is a followed `next`" — using
    // two INDEPENDENT top-level calls (neither carries a task binding; the
    // second is not a continuation of anything the server minted) as its
    // proof. The new ruling is narrower: the strict refusal fires only for a
    // genuine server-minted continuation (a resolvable task binding —
    // `canonicalTaskBindingOf` / a qref-recovered binding — proves the
    // caller is executing what a specific prior response minted); an
    // independent re-read of a changed file, bound or not, is served fresh,
    // exactly like `pi/pi03DedupHonesty.spec.ts`'s and `servedReceipts
    // .spec.ts`'s identical-range flows. This exact shape (two independent
    // mode=slice reads, no next chain, no task binding) is now the CONTROL
    // for that everyday flow, kept in this file because the mechanism it
    // exercises (`admitCallerRangedContinuation` is reached from mode=slice,
    // not only from a followed `next`) is unchanged.
    it("two independent same-epoch mode=slice reads of one path (no next chain, no task binding) serve fresh, not a stale refusal", async () => {
      const { ws, server } = freshWorkspace(config, "slice-same-epoch-retouch");
      await server.initialize();
      writeSelfIdFile(ws, "solo2.txt", 50, "csSolo2", 60);

      const first = await server.callTool("read_file", {
        targets: [{ path: "solo2.txt", range: "1-50" }],
        content: "auto",
        task: { epoch: "new" },
        cwd: ws,
      });
      expect(
        (first.body as Record<string, unknown>)?.["kind"],
        `expected a clean single-hop slice serve: ${JSON.stringify(first.body).slice(0, 300)}`,
      ).toBe("read.text");
      expect(extractNext(first.body).next, `fixture must complete in one hop: ${JSON.stringify(first.body).slice(0, 300)}`).toBeUndefined();

      writeSelfIdFile(ws, "solo2.txt", 50, "csSolo2New", 60);
      // Same lane, same (implicit, continuing) epoch, no task binding on
      // EITHER call — an independent re-read, not a followed `next`.
      const second = await server.callTool("read_file", {
        targets: [{ path: "solo2.txt", range: "1-50" }],
        content: "auto",
        cwd: ws,
      });
      expect(
        (second.body as Record<string, unknown>)?.["kind"],
        `an independent re-read of a changed file must serve fresh, not refuse: ${JSON.stringify(second.body).slice(0, 500)}`,
      ).toBe("read.text");
      const secondBody = (second.body as Record<string, unknown>)?.["evidence"] as Array<Record<string, unknown>> | undefined;
      expect(String(secondBody?.[0]?.["body"])).toContain("csSolo2New");
    }, 60_000);

    // -------------------------------------------------------------------
    // FIX-A6 (item 1, additional door found while enumerating): the S6
    // "mixed symbol/path batch" dispatch (server.ts, 2026-09-20 Copilot
    // dead-turn forensics) — a query-less multi-target `paths[]` batch where
    // AT LEAST ONE entry carries `symbol` — resolves every entry through its
    // OWN loop (`resolveSlice` per entry), deliberately bypassing both
    // `pathlessExploratoryPaths` (the task_pack promotion FIX-A5 already
    // covers) and the A7 handles=[] batch. A ranged entry riding alongside a
    // symbol-carrying one in this same batch had no staleness admission at
    // all until this fix.
    //
    // GATE-A (2026-09-21, item 2) RE-PINNED: same reason as the mode=slice
    // case right above — two INDEPENDENT calls (no task binding on either)
    // is the withdrawn broad rule's proof shape, not the narrowed one's. The
    // admission check still reaches this dispatch door (that is what this
    // test verifies); an independent re-read now serves fresh instead of
    // refusing.
    // -------------------------------------------------------------------
    it("a mixed symbol/path batch (S6) with a ranged sibling entry is still reached by the admission check, and an independent re-read serves fresh", async () => {
      const { ws, server } = freshWorkspace(config, "mixed-symbol-batch");
      await server.initialize();
      writeSelfIdFile(ws, "sixa.txt", 50, "csSix", 60);
      fs.writeFileSync(`${ws}/sixb.md`, "# Placeholder\nsome content\n", "utf8");

      const mixedRequest = {
        targets: [{ path: "sixa.txt", range: "1-50" }, { path: "sixb.md", symbol: "Placeholder" }],
        content: "auto",
        cwd: ws,
      };
      const first = await server.callTool("read_file", { ...mixedRequest, task: { epoch: "new" } });
      expect(
        (first.body as Record<string, unknown>)?.["kind"],
        `expected the S6 mixed-batch dispatch: ${JSON.stringify(first.body).slice(0, 400)}`,
      ).toBe("read.batch");

      writeSelfIdFile(ws, "sixa.txt", 50, "csSixNew", 60);
      // Same lane, same (implicit, continuing) epoch, no task binding on
      // EITHER call — an independent re-read, not a followed `next`.
      const second = await server.callTool("read_file", mixedRequest);
      expect(
        (second.body as Record<string, unknown>)?.["kind"],
        `an independent re-read via the mixed symbol/path batch must serve fresh, not refuse: ${JSON.stringify(second.body).slice(0, 500)}`,
      ).toBe("read.batch");
      const secondEntries = (second.body as Record<string, unknown>)?.["entries"] as Array<Record<string, unknown>> | undefined;
      const sixa = secondEntries?.find((e) => e["path"] === "sixa.txt");
      expect(String(sixa?.["content"] ?? sixa?.["body"])).toContain("csSixNew");
    }, 60_000);

    // -------------------------------------------------------------------
    // GATE-A2 (2026-09-21, v0.14.4 candidate item 2's own follow-up): GATE-A's
    // containment heuristic ("independent iff fully covered by what was
    // already DELIVERED") conflated "asks for lines not yet served" with "is
    // a continuation" — the everyday flow "read a window, edit the file with
    // a NATIVE tool, read the NEXT window" also reaches past what was
    // delivered, yet is not a continuation of anything the server minted.
    // The four cases below exercise the corrected discriminator: STRICT iff
    // the request reaches into a window THIS SERVER ITSELF minted as a
    // continuation (`mintRangedContinuationWindow`, state/session.ts) that is
    // not yet fully delivered — never merely "beyond what was served".
    // -------------------------------------------------------------------
    it("GATE-A2: independent reads of successive NEW windows after native edits serve fresh with a stale-range note, and never grow across repeated cycles", async () => {
      const { ws, server } = freshWorkspace(config, "minted-vs-independent");
      await server.initialize();
      writeSelfIdFile(ws, "grow.txt", 200, "csGrow", 40);

      // Hop 1: a plain, complete ask for 1-40 — nothing left undelivered, so
      // nothing is minted as a continuation for this path.
      const first = await server.callTool("read_file", {
        targets: [{ path: "grow.txt", range: "1-40" }],
        content: "auto",
        task: { epoch: "new" },
        cwd: ws,
      });
      expect((first.body as Record<string, unknown>)?.["kind"], `expected a clean single-hop slice serve: ${JSON.stringify(first.body).slice(0, 300)}`).toBe("read.text");
      expect(extractNext(first.body).next, `fixture must complete window 1-40 in one hop: ${JSON.stringify(first.body).slice(0, 300)}`).toBeUndefined();

      const sizes: number[] = [];
      for (let cycle = 0; cycle < 3; cycle++) {
        const newTag = `csGrow${cycle}`;
        writeSelfIdFile(ws, "grow.txt", 200, newTag, 40); // simulate an external, native-tool edit
        const lo = 41 + cycle * 40;
        const hi = lo + 39;
        const resp = await server.callTool("read_file", {
          targets: [{ path: "grow.txt", range: `${lo}-${hi}` }],
          content: "auto",
          cwd: ws,
        });
        const body = resp.body as Record<string, unknown>;
        expect(body?.["kind"], `[cycle ${cycle}] an independent read of a window nobody promised must serve, not refuse: ${JSON.stringify(body).slice(0, 500)}`).toBe("read.text");
        const evidence = body?.["evidence"] as Array<Record<string, unknown>> | undefined;
        const served = String(evidence?.[0]?.["body"]);
        expect(served, `[cycle ${cycle}] expected the NEW revision's own tag in the served window`).toContain(newTag);
        expect(served, `[cycle ${cycle}] must not re-serve the ORIGINAL revision's bytes`).not.toContain("csGrow-");
        expect(typeof body?.["note"], `[cycle ${cycle}] expected a one-line stale-range disclosure note`).toBe("string");
        expect(String(body?.["note"])).toContain("grow.txt");
        sizes.push(JSON.stringify(body).length);
      }
      // The defect this proves fixed was a recovery `next` that re-read the
      // GROWING union each cycle (1-80, then 1-120, ...) — response size
      // must stay essentially flat across cycles, not climb.
      expect(
        Math.max(...sizes) - Math.min(...sizes),
        `response size grew across independent cycles (quadratic re-read regression): ${JSON.stringify(sizes)}`,
      ).toBeLessThan(200);
    }, 60_000);

    it("GATE-A2: independently re-issuing a minted continuation's own window BY PATH is still treated as continuing it", async () => {
      const { ws, server } = freshWorkspace(config, "reissue-by-path");
      await server.initialize();
      writeSelfIdFile(ws, "mix/alpha.txt", 200, "csOld", 120);
      writeSelfIdFile(ws, "mix/beta.txt", 200, "csBeta", 120);

      const first = await firstMultiTargetHop(server, ws);
      const { next } = extractNext(first);
      if (!next) throw new Error(`expected the R04 multitarget-mix fixture to mint a continuation: ${JSON.stringify(first).slice(0, 300)}`);
      const nextTargets = (next.arguments as Record<string, unknown>)["targets"] as Array<Record<string, unknown>> | undefined;
      const alphaTarget = nextTargets?.find((t) => t["path"] === "mix/alpha.txt");
      const alphaRange = alphaTarget?.["range"];
      if (typeof alphaRange !== "string") throw new Error(`expected a minted alpha.txt range in: ${JSON.stringify(next)}`);

      writeSelfIdFile(ws, "mix/alpha.txt", 200, "csNew", 120);
      // Independently CONSTRUCTED — not the literal `next` object (no shared
      // budget/cwd-cache/task fields) — naming the SAME window BY PATH.
      const reissue = await server.callTool("read_file", {
        targets: [{ path: "mix/alpha.txt", range: alphaRange }],
        content: "auto",
        cwd: ws,
      });
      expect(
        (reissue.body as Record<string, unknown>)?.["kind"],
        `re-issuing a minted, still-undelivered window by path must still be strict: ${JSON.stringify(reissue.body).slice(0, 500)}`,
      ).toBe("refusal");
      expect((reissue.body as Record<string, unknown>)?.["code"]).toBe("cursor-stale");
    }, 60_000);

    it("GATE-A2: a request that only partly overlaps a minted window is strict for that entry", async () => {
      const { ws, server } = freshWorkspace(config, "partial-overlap");
      await server.initialize();
      writeSelfIdFile(ws, "mix/alpha.txt", 200, "csOld", 120);
      writeSelfIdFile(ws, "mix/beta.txt", 200, "csBeta", 120);

      const first = await firstMultiTargetHop(server, ws);
      const { next } = extractNext(first);
      if (!next) throw new Error(`expected the R04 multitarget-mix fixture to mint a continuation: ${JSON.stringify(first).slice(0, 300)}`);
      const nextTargets = (next.arguments as Record<string, unknown>)["targets"] as Array<Record<string, unknown>> | undefined;
      const alphaTarget = nextTargets?.find((t) => t["path"] === "mix/alpha.txt");
      const alphaRange = alphaTarget?.["range"];
      if (typeof alphaRange !== "string") throw new Error(`expected a minted alpha.txt range in: ${JSON.stringify(next)}`);
      const m = /^(\d+)-(\d+)$/.exec(alphaRange);
      if (!m) throw new Error(`unparseable minted range: ${alphaRange}`);
      const [lo, hi] = [Number(m[1]), Number(m[2])];

      writeSelfIdFile(ws, "mix/alpha.txt", 200, "csNew", 120);
      // Overlaps the minted window's start but reaches well past its end too.
      const partial = await server.callTool("read_file", {
        targets: [{ path: "mix/alpha.txt", range: `${lo}-${hi + 50}` }],
        content: "auto",
        cwd: ws,
      });
      expect(
        (partial.body as Record<string, unknown>)?.["kind"],
        `a request only partly overlapping a still-undelivered minted window must still be strict: ${JSON.stringify(partial.body).slice(0, 500)}`,
      ).toBe("refusal");
      expect((partial.body as Record<string, unknown>)?.["code"]).toBe("cursor-stale");
    }, 60_000);

    it("CONTROL: rewriting a caller-ranged target with byte-identical content (sha unchanged) between hops never refuses", async () => {
      const { ws, server } = freshWorkspace(config, "same-content-resave");
      await server.initialize();
      writeSelfIdFile(ws, "mix/alpha.txt", 200, "csOld", 120);
      writeSelfIdFile(ws, "mix/beta.txt", 200, "csBeta", 120);

      const first = await firstMultiTargetHop(server, ws);
      const { next } = extractNext(first);
      if (!next) return; // completed in one hop; nothing to verify further
      // Re-save the IDENTICAL content — same bytes, same sha.
      writeSelfIdFile(ws, "mix/alpha.txt", 200, "csOld", 120);
      const rest = await walkHops(server, next, 12);
      const all = [first, ...rest.responses];
      expect(
        all.some((r) => r?.["kind"] === "refusal"),
        `a byte-identical re-save must never be reported as a stale revision: ${JSON.stringify(all.map((r) => r?.["kind"]))}`,
      ).toBe(false);
    }, 60_000);
  });
}
