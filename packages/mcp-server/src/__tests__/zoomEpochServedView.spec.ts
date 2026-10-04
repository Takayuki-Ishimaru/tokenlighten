/**
 * zoomEpochServedView.spec.ts — R-A2 item 1 (2026-09-21 fix wave, held item
 * 4): a plain caller-ranged serve made in the context of a declared-answer
 * task must count as served evidence for that task's read-only epoch-served
 * view, exactly as a task-pack build's own shipped surfaces already do.
 *
 * THE DEFECT (confirmed by R-A, not implemented by them; brief-r-a.md item 4
 * / review-findings.md held-4). `recordServedSurfaces` (the write side of the
 * cumulative served-surface log, `util/packServeLog.ts`) and the SAME-TASK
 * read-only view it has a sibling for (`recordReadOnlyServedSurfaces`,
 * readCodeTaskPack.ts, WP-S11) are both reachable ONLY from the task-pack
 * builder's own post-serve booking pass (`bookShippedPackServeState`). A
 * plain `tl_read_file {targets:[{handle,range}]}` / `{path,range}` dispatch in
 * server.ts — the "AA1 direct slice route" — never calls either. So the
 * sequence "query -> discover (evidence handle + `remaining` ranges) -> the
 * caller zooms straight to a `remaining` range BY HANDLE instead of running
 * the pack's own `next` -> a bare `{qref}` re-pack" left the re-pack blind to
 * bytes the caller already holds: it re-proposed the identical `tl_search_files
 * find` for an identifier the zoom's own body already contained.
 *
 * THE FIX (three seats, all additive — no new wire field, no flag):
 *  1. server.ts's AA1 route now resolves which declared-answer epoch a ranged
 *     serve belongs to (`resolveDeclaredAnswerEpochTokens`: an explicit
 *     `task.handle` proven to have been packed under profile "answer" via
 *     the same fingerprint comparison `inheritDeclaredTaskProfile` already
 *     uses, or — when no handle is named — the lane's own currently-open
 *     read-only-view epoch) and records the served span into the SAME
 *     read-only view via `recordReadOnlyServedRangedServe`
 *     (readCodeTaskPack.ts) — never the cumulative log.
 *  2. `recordPredatesAdditionalServedEvidence` (FIX-D's cache-staleness gate,
 *     TL-06) was PATH-granular ("did a brand-new file appear"), so a zoom of
 *     a NEW RANGE of a path the cached record already knew about was
 *     invisible to it and the stale record kept being replayed verbatim.
 *     Extended to compare the servedRangeLedger's current spans for an
 *     already-known path against the union the record's OWN surfaces
 *     declared at capture time.
 *  3. `readOnlyViewCarriedEvidence` (the identifier-obligation reader inside
 *     `buildReadinessObligations`) excluded a read-only-view entry whenever
 *     ITS OWN pack already served ANY surface of that same path — which
 *     threw away exactly the zoomed evidence when the rebuilt pack re-serves
 *     the SAME file narrower than the zoom did. Made range-aware the same
 *     way.
 *
 * All three were confirmed necessary by hand (temporarily reverting any one
 * alone reproduces the stale `next`/`missing-evidence` gap again) before this
 * file existed — this is the fail-first regression spec for the combination.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { shortTmpDir } from "./helpers/shortTmpDir.js";
import { rmDirWithRetry } from "./helpers/rmDirWithRetry.js";
import { CONFIG_NAMES, startDevServer, type ConfigName, type ServerHandle } from "./helpers/qualityFirstScenarios.js";

const HOME = process.env["HOME"] ?? process.env["USERPROFILE"] ?? os.homedir();

const QUERY = "Explain parseConfigHeader and finalizeShutdownSequence in pipelineConfig.ts.";
const ZOOM_RANGE = "77-82";
const ZOOM_IDENTIFIER = "finalizeShutdownSequence";

/**
 * ONE file, two identifiers far apart: `parseConfigHeader` near the top
 * (small enough that a 6,200-byte budget embeds a window around it directly)
 * and `finalizeShutdownSequence` at the very tail, past ~60 filler lines —
 * far enough that hop 0 cannot also embed it under the same budget and must
 * leave it for a follow-up (`next` proposes `tl_search_files find` for it; the
 * evidence row's own `remaining` already names the tail span that contains
 * it, which is exactly what a caller impatient enough to zoom by handle would
 * jump to instead of running `next` verbatim).
 */
function buildZoomFixtureWorkspace(root: string): void {
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  const filler = Array.from(
    { length: 60 },
    (_, i) => `// filler line ${String(i + 1).padStart(3, "0")} describing unrelated pipeline bookkeeping detail number ${i + 1}`,
  );
  const content = [
    "// pipelineConfig.ts -- parses pipeline configuration and finalizes shutdown.",
    "",
    "export interface PipelineConfigHeader {",
    "  version: number;",
    "  stages: string[];",
    "}",
    "",
    "/** Parses the raw header block of a pipeline configuration file. */",
    "export function parseConfigHeader(raw: string): PipelineConfigHeader {",
    "  const lines = raw.split(\"\\n\");",
    "  const version = Number(lines[0]?.split(\"=\")[1] ?? \"1\");",
    "  const stages = (lines[1]?.split(\"=\")[1] ?? \"\").split(\",\").filter(Boolean);",
    "  return { version, stages };",
    "}",
    "",
    ...filler,
    "",
    "/** Runs the final teardown sequence once every pipeline stage has finished. */",
    "export function finalizeShutdownSequence(stagesCompleted: number, totalStages: number): boolean {",
    "  if (stagesCompleted < totalStages) return false;",
    "  // flush buffered telemetry, release locks, and mark the run complete.",
    "  return true;",
    "}",
    "",
  ].join("\n");
  fs.writeFileSync(path.join(root, "src/pipelineConfig.ts"), content, "utf8");
}

function pick(obj: unknown, keyPath: string): any {
  return keyPath.split(".").reduce((acc: any, key) => (acc == null ? undefined : acc[key]), obj);
}

function nextOf(body: any): { tool: string; arguments: Record<string, unknown> } | undefined {
  return pick(body, "decision.next_call") ?? pick(body, "decision.next") ?? body?.next;
}

/** Canonicalizes a `next` for structural equality, stripping fields that legitimately vary call to call (absolute `cwd`, caller-supplied `lane`, and the per-mint task and evidence handle tokens — a peer lane mints its own handles for the same window). */
function stableNext(body: any): string {
  const next = nextOf(body);
  if (next === undefined) return JSON.stringify(undefined);
  const args = { ...(next.arguments as Record<string, unknown>) };
  delete args["cwd"];
  delete args["lane"];
  if (Array.isArray(args["targets"])) {
    args["targets"] = (args["targets"] as Array<Record<string, unknown>>).map((target) => (
      typeof target["handle"] === "string" ? { ...target, handle: "<handle>" } : target
    ));
  }
  if (args["task"] && typeof args["task"] === "object") {
    const task = { ...(args["task"] as Record<string, unknown>) };
    delete task["handle"];
    args["task"] = task;
  }
  return JSON.stringify({ tool: next.tool, arguments: args });
}

for (const config of CONFIG_NAMES as readonly ConfigName[]) {
  describe(`zoom counts as served evidence for its declared-answer task, spawned (config=${config})`, () => {
    let ws: string;
    let server: ServerHandle;

    beforeAll(async () => {
      ws = fs.realpathSync(shortTmpDir(HOME, `.tl-zoomview-${config}-`));
      buildZoomFixtureWorkspace(ws);
      server = startDevServer(ws, config);
      await server.initialize();
    }, 60_000);

    afterAll(async () => {
      await server.kill();
      try {
        await rmDirWithRetry(ws);
      } catch {
        /* best-effort cleanup */
      }
    });

    it("hop0 discovers with a next targeting the uncovered identifier", async () => {
      const hop0 = await server.callTool("tl_read_file", {
        query: QUERY,
        task: { epoch: "new", profile: "answer" },
        budget: { bytes: 6200 },
        cwd: ws,
        lane: "hop0-shape",
      });
      expect(hop0.body?.decision?.kind, `expected hop0 to discover: ${JSON.stringify(hop0.body)}`).toBe("discover");
      expect(Array.isArray(hop0.body?.evidence) && hop0.body.evidence.length > 0).toBe(true);
      const first = hop0.body.evidence[0];
      expect(typeof first.handle).toBe("string");
      expect(Array.isArray(first.remaining)).toBe(true);
    }, 45_000);

    it("a bare-qref re-pack sees the identifier a plain handle+range zoom already served (no task field on the zoom)", async () => {
      const lane = "zoom-no-task-field";
      const hop0 = await server.callTool("tl_read_file", {
        query: QUERY,
        task: { epoch: "new", profile: "answer" },
        budget: { bytes: 6200 },
        cwd: ws,
        lane,
      });
      const handle: string = hop0.body.evidence[0].handle;
      const qref: string = hop0.body.qref;
      expect(typeof qref).toBe("string");

      // THE ZOOM: a plain ranged read by handle, no `next` executed, no
      // `task` field at all — exactly the shape held item 4 describes.
      const hop1 = await server.callTool("tl_read_file", { targets: [{ handle, range: ZOOM_RANGE }], cwd: ws, lane });
      expect(hop1.body?.kind).toBe("read.text");
      expect(
        JSON.stringify(hop1.body).includes(ZOOM_IDENTIFIER),
        `the zoom itself must serve the identifier's body: ${JSON.stringify(hop1.body)}`,
      ).toBe(true);

      const hop2 = await server.callTool("tl_read_file", { qref, cwd: ws, lane });
      // THE CORE ASSERTION: the re-pack must not re-open the concern the zoom
      // already served — its OWN `next` must not re-propose the identical
      // search/zoom for the identifier the caller already holds.
      expect(
        JSON.stringify(nextOf(hop2.body) ?? null).includes(ZOOM_IDENTIFIER),
        `hop2's next re-proposed a call for an identifier the zoom already served: ${JSON.stringify(hop2.body)}`,
      ).toBe(false);
      // The re-pack must reflect the zoomed evidence somewhere in its own
      // response — either by certifying (the observed, and best, outcome) or
      // at minimum by no longer treating the identifier as missing evidence.
      const gapsText = JSON.stringify(hop2.body?.decision?.gaps ?? []);
      expect(
        gapsText.includes(`identifier:${ZOOM_IDENTIFIER}`),
        `hop2 still lists the zoomed identifier as a missing-evidence gap: ${JSON.stringify(hop2.body)}`,
      ).toBe(false);
    }, 45_000);

    it("a bare-qref re-pack sees the identifier when the zoom DOES carry an explicit task.handle", async () => {
      const lane = "zoom-with-task-handle";
      const hop0 = await server.callTool("tl_read_file", {
        query: QUERY,
        task: { epoch: "new", profile: "answer" },
        budget: { bytes: 6200 },
        cwd: ws,
        lane,
      });
      const handle: string = hop0.body.evidence[0].handle;
      const taskHandle: string = hop0.body.task.id;
      const qref: string = hop0.body.qref;

      const hop1 = await server.callTool("tl_read_file", {
        targets: [{ handle, range: ZOOM_RANGE }],
        task: { handle: taskHandle },
        cwd: ws,
        lane,
      });
      expect(hop1.body?.kind).toBe("read.text");

      const hop2 = await server.callTool("tl_read_file", { qref, cwd: ws, lane });
      expect(
        JSON.stringify(nextOf(hop2.body) ?? null).includes(ZOOM_IDENTIFIER),
      ).toBe(false);
      const gapsText = JSON.stringify(hop2.body?.decision?.gaps ?? []);
      expect(gapsText.includes(`identifier:${ZOOM_IDENTIFIER}`)).toBe(false);
    }, 45_000);

    it("control: a file edited between the zoom and the re-pack re-opens the touched concern", async () => {
      const lane = "control-file-edited";
      const hop0 = await server.callTool("tl_read_file", {
        query: QUERY,
        task: { epoch: "new", profile: "answer" },
        budget: { bytes: 6200 },
        cwd: ws,
        lane,
      });
      const handle: string = hop0.body.evidence[0].handle;
      const qref: string = hop0.body.qref;
      await server.callTool("tl_read_file", { targets: [{ handle, range: ZOOM_RANGE }], cwd: ws, lane });

      const abs = path.join(ws, "src/pipelineConfig.ts");
      const original = fs.readFileSync(abs, "utf8");
      fs.writeFileSync(abs, `${original}\n// touched by the file-edited control\n`, "utf8");
      try {
        const hop2 = await server.callTool("tl_read_file", { qref, cwd: ws, lane });
        const text = JSON.stringify(hop2.body);
        expect(text.includes("pipelineConfig.ts"), `the touched file must not silently vanish: ${text}`).toBe(true);
      } finally {
        fs.writeFileSync(abs, original, "utf8");
      }
    }, 45_000);

    it("control: task.epoch:\"new\" on the re-pack inherits nothing from the zoom", async () => {
      const lane = "control-new-epoch";
      const hop0 = await server.callTool("tl_read_file", {
        query: QUERY,
        task: { epoch: "new", profile: "answer" },
        budget: { bytes: 6200 },
        cwd: ws,
        lane,
      });
      const handle: string = hop0.body.evidence[0].handle;
      await server.callTool("tl_read_file", { targets: [{ handle, range: ZOOM_RANGE }], cwd: ws, lane });

      const fresh = await server.callTool("tl_read_file", {
        query: QUERY,
        task: { epoch: "new", profile: "answer" },
        budget: { bytes: 6200 },
        cwd: ws,
        lane,
      });
      expect(
        stableNext(fresh.body),
        `a declared new epoch must reproduce the pristine pre-zoom discover exactly: fresh=${JSON.stringify(fresh.body)}\nhop0=${JSON.stringify(hop0.body)}`,
      ).toBe(stableNext(hop0.body));
    }, 45_000);

    it("control: a different lane's identical query inherits nothing from the zoom", async () => {
      const hop0 = await server.callTool("tl_read_file", {
        query: QUERY,
        task: { epoch: "new", profile: "answer" },
        budget: { bytes: 6200 },
        cwd: ws,
        lane: "control-owner-lane",
      });
      const handle: string = hop0.body.evidence[0].handle;
      await server.callTool("tl_read_file", { targets: [{ handle, range: ZOOM_RANGE }], cwd: ws, lane: "control-owner-lane" });

      const peer = await server.callTool("tl_read_file", {
        query: QUERY,
        task: { epoch: "new", profile: "answer" },
        budget: { bytes: 6200 },
        cwd: ws,
        lane: "control-peer-lane",
      });
      expect(
        stableNext(peer.body),
        `a peer lane must reproduce the pristine pre-zoom discover exactly: peer=${JSON.stringify(peer.body)}\nhop0=${JSON.stringify(hop0.body)}`,
      ).toBe(stableNext(hop0.body));
    }, 45_000);

    it("control: a generic (edit) profile task-pack chain is unaffected by this fix's answer-only gate", async () => {
      const lane = "control-generic-profile";
      const hop0 = await server.callTool("tl_read_file", {
        query: QUERY,
        task: { epoch: "new", profile: "generic" },
        budget: { bytes: 6200 },
        cwd: ws,
        lane,
      });
      expect(typeof hop0.body?.kind, `malformed response: ${JSON.stringify(hop0.body)}`).toBe("string");
      const next0 = nextOf(hop0.body);
      if (next0 !== undefined) {
        const hop1 = await server.callTool(next0.tool, { ...next0.arguments, lane });
        expect(typeof hop1.body?.kind).toBe("string");
      }
    }, 45_000);
  });
}
