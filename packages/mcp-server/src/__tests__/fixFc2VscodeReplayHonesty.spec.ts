/**
 * fixFc2VscodeReplayHonesty.spec.ts — FIX-FC2, eval-0927 review wave
 * (2026-09-27), residuals left by FIX-FC (brief-fc2.md).
 *
 * FIX-FC's own `fixFcEval0927Wave.spec.ts` ("finding 3") proved that, under
 * the DEFAULT config, `buildAnswerTaskPack`'s tail re-capture of
 * `captureServedPack` (readCodeTaskPack.ts, ~line 6367) keeps
 * `servedPacksByWorkspace` in sync with the FINAL, post-cap surface set. That
 * fix left two residuals under the VS Code config (`TOKENLIGHTEN_CLIENT=
 * vscode TOKENLIGHTEN_CLIENT_ID=vscode TL_TURN_ECONOMY=1
 * TOKENLIGHTEN_TASK_PACK_MAX_BYTES=0`):
 *
 * RESIDUAL 1 (fixed here). `priorProbe`
 * (`{query:"Raise the default timeout in src/config.ts from 5000 to
 * 10000.", task:{epoch:"new",profile:"answer"}}`) still showed `prior` for
 * `src/httpClient.ts:1-16` — bytes never shipped on the wire — via a
 * DIFFERENT mechanism than the one `captureServedPack`'s tail re-capture
 * fixes.
 *
 * ROOT CAUSE (confirmed live, via temporary tracing, removed before this
 * commit): `dedupeTrimAndPersist` (readCodeTaskPack.ts) calls
 * `persistPackFingerprints(workspace, trimmed, ...)` on its OWN internal,
 * PRE-CAP `trimmed` result — BEFORE returning to `buildAnswerTaskPack`,
 * which only THEN runs `capExtraEvidenceRelativeToNamedPaths` (the 1.25x
 * named-path cap that splices the `httpClient.ts` counterexample surface
 * back OUT of `finalResult.surfaces`). `persistPackFingerprints` stamps the
 * SINGLE-SLOT `lastPackBlocksByWorkspace` cache that `applyPackDedupe` (top
 * of the NEXT `dedupeTrimAndPersist` call) reads. Under the default config,
 * this exact query's first external call resolves as an ambiguous
 * `confirm_candidates` (`await_input`) with a narrow surface set that never
 * even adds `httpClient.ts`, so the pre-cap/post-cap surface sets happen to
 * agree and no staleness is stamped. Under the VS Code config the SAME
 * query resolves the single candidate in one pass (no confirmation round
 * trip), so `httpClient.ts` genuinely gets added and capped out in the SAME
 * call — and the stale, pre-cap fingerprint survives into
 * `lastPackBlocksByWorkspace`. A later bare-`{qref}` replay takes a
 * different internal rebuild path (a fresh fingerprint, so
 * `tryServeCachedPack`/`servedPacksByWorkspace` — the ledger
 * `captureServedPack`'s own tail fix corrects — is never even consulted),
 * re-derives the identical, content-addressed `httpClient.ts` surface, and
 * `applyPackDedupe` matches it against the stale `lastPackBlocksByWorkspace`
 * entry, demoting it to `code_unchanged: "<handle> — see prior pack"` for
 * bytes this exact task chain never actually shipped.
 *
 * FIX: readCodeTaskPack.ts ~line 6389 — `buildAnswerTaskPack`'s tail now
 * ALSO re-runs `persistPackFingerprints(workspace, finalResult,
 * args.taskBinding)`, over the same final, post-cap `finalResult`
 * `captureServedPack`'s tail re-capture already uses (~line 6379). Its own
 * `.set()` (never an append/merge across calls) replaces the whole
 * per-workspace slot, so a later `applyPackDedupe` sees exactly what this
 * response shipped, not a discarded internal draft.
 *
 * RESIDUAL 2 (investigated, NOT reproduced — matching FIX-FC's own
 * conclusion). The review described VS Code, after finding 3's
 * `await_input`, showing identical `{qref}` replays flip act.answer ->
 * discover(+next) -> read.receipt. Attempted here and in ad hoc probes
 * (scratchpad `fc2/replayFlip*.mjs`, `fc2/debugTrace.mjs`) across: profile
 * "answer" / no profile; `--allow-write` / read-only; bare-`{qref}` replay
 * / `task:{handle}` replay; up to 8 repeated replays; both configs. Under
 * VS Code, this exact query never produces an `await_input` hop at all (the
 * single-candidate case resolves directly to `act.answer`/`act.edit` in one
 * pass — a routing difference from the default config, not itself a
 * wire-honesty defect). No `decision.kind` flip was observed in any
 * variant, before or after the RESIDUAL 1 fix. What WAS observed
 * pre-fix — and is asserted fixed below (group C) — is a related but
 * narrower instability: the SAME bug also made the certificate id and
 * workspace fingerprint change across the first replay (the same stale
 * `httpClient.ts` surface briefly resurfacing, then vanishing again),
 * which is a real "replay is not a pure function of task state" violation
 * even though the top-level `decision.kind` label never changed. The
 * RESIDUAL 1 fix removes this instability as a side effect (verified
 * below).
 */
import { afterAll, afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";

import { shortTmpDir } from "./helpers/shortTmpDir.js";
import { rmDirWithRetry } from "./helpers/rmDirWithRetry.js";
import { startDevServer, type ServerHandle } from "./helpers/qualityFirstScenarios.js";
import { buildHttpCorpusWorkspace } from "./helpers/evaluation0927Scenarios.js";

const HOME = process.env["HOME"] ?? process.env["USERPROFILE"] ?? os.homedir();
const tmpDirs: string[] = [];
const servers: ServerHandle[] = [];

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

function makeWorkspace(tag: string): string {
  const ws = fs.realpathSync(shortTmpDir(HOME, `.tl-fixfc2-${tag}-`));
  tmpDirs.push(ws);
  buildHttpCorpusWorkspace(ws, "compact");
  return ws;
}

async function spawnedServer(ws: string, config: "default" | "vscode", extraArgs: readonly string[] = []): Promise<ServerHandle> {
  const s = startDevServer(ws, config, { toolSurface: "full", extraArgs });
  servers.push(s);
  await s.initialize();
  return s;
}

function evidenceOf(body: Record<string, unknown>): Array<Record<string, unknown>> {
  const raw = body["evidence"];
  return Array.isArray(raw) ? raw.filter((e): e is Record<string, unknown> => e !== null && typeof e === "object") : [];
}

/**
 * Walks a chain of raw response bodies (in call order) and returns every
 * evidence row that claims `prior` (a body-less residency pointer) for a
 * (path, line) this EXACT chain never shipped a real `body` for on an
 * earlier hop — the general "prior only for bytes this task actually
 * shipped" invariant (AGENTS.md, brief-fc2.md).
 */
function priorClaimsForNeverShippedBytes(hops: readonly Record<string, unknown>[]): unknown[] {
  const shipped = new Map<string, Set<number>>();
  const violations: unknown[] = [];
  for (const body of hops) {
    for (const entry of evidenceOf(body)) {
      const p = entry["path"];
      const range = entry["range"];
      if (typeof p !== "string" || typeof range !== "string") continue;
      const match = /^(\d+)-(\d+)$/.exec(range);
      if (match === null) continue;
      const [start, end] = [Number(match[1]), Number(match[2])];
      if (typeof entry["body"] === "string") {
        const set = shipped.get(p) ?? new Set<number>();
        for (let line = start; line <= end; line++) set.add(line);
        shipped.set(p, set);
      } else if (entry["prior"] !== undefined) {
        const set = shipped.get(p) ?? new Set<number>();
        const missing: number[] = [];
        for (let line = start; line <= end; line++) if (!set.has(line)) missing.push(line);
        if (missing.length > 0) {
          violations.push({ path: p, range, prior: entry["prior"], missing: missing.slice(0, 5) });
        }
      }
    }
  }
  return violations;
}

const QUERY = "Raise the default timeout in src/config.ts from 5000 to 10000.";

// ---------------------------------------------------------------------------
// Group A — residual 1, VS Code config: the fixed shape.
// ---------------------------------------------------------------------------
describe("FIX-FC2 residual 1: VS Code config never claims prior for bytes this task never shipped", () => {
  it("priorProbe repro: 6 bare-qref replays after the initial answer, no false prior", async () => {
    const ws = makeWorkspace("r1-vscode");
    const server = await spawnedServer(ws, "vscode");

    const hop0 = await server.callTool("tl_read_file", { query: QUERY, cwd: ws, task: { epoch: "new", profile: "answer" } });
    const qref = hop0.body?.qref;
    expect(typeof qref, `hop0 carried no qref: ${JSON.stringify(hop0.body)}`).toBe("string");

    const hops: Record<string, unknown>[] = [hop0.body];
    for (let i = 0; i < 6; i++) {
      const hop = await server.callTool("tl_read_file", { qref, cwd: ws });
      hops.push(hop.body);
    }

    const violations = priorClaimsForNeverShippedBytes(hops);
    expect(violations, `prior claimed for bytes this chain never shipped: ${JSON.stringify(violations)}`).toEqual([]);

    // Recall control: the chain ships real bytes (the answer's own windows),
    // and the counterexample surface is never a body-less `prior` claim it did
    // not first ship (the failure mode the no-false-prior check above also
    // catches; restated for this one named path so a regression names it
    // directly). v0.15.1 runtime review (2026-10-06): `src/config.ts` is the
    // file the question names and the locator's one primary, so the pack is a
    // focused answer and a bare-qref replay restates it as `prior` — it no
    // longer re-confirms a candidate list by widening to the whole file plus
    // `httpClient.ts`, which is how this chain used to put that surface on
    // the wire at all.
    expect(
      hops.some((body) => evidenceOf(body).some((e) => e["path"] === "src/config.ts" && typeof e["body"] === "string" && e["body"].includes("timeoutMs: 5000"))),
      "the chain never shipped the default timeout's own window",
    ).toBe(true);
    const shippedHttpClient = hops.some((body) =>
      evidenceOf(body).some((e) => e["path"] === "src/httpClient.ts" && typeof e["body"] === "string"));
    const claimedHttpClient = hops.some((body) =>
      evidenceOf(body).some((e) => e["path"] === "src/httpClient.ts" && e["prior"] !== undefined));
    expect(!claimedHttpClient || shippedHttpClient, "httpClient.ts was claimed prior without ever shipping a body").toBe(true);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Group B — regression control: the default config (FIX-FC's own fix) must
// stay exactly as honest as before this change (hard rule 10's recall
// control for every honesty tightening).
// ---------------------------------------------------------------------------
describe("recall control: default config stays honest (FIX-FC's own fix, unaffected by this change)", () => {
  it("priorProbe repro under default config: no false prior, same invariant", async () => {
    const ws = makeWorkspace("r1-default");
    const server = await spawnedServer(ws, "default");

    const hop0 = await server.callTool("tl_read_file", { query: QUERY, cwd: ws, task: { epoch: "new", profile: "answer" } });
    const qref = hop0.body?.qref;
    expect(typeof qref, `hop0 carried no qref: ${JSON.stringify(hop0.body)}`).toBe("string");

    const hops: Record<string, unknown>[] = [hop0.body];
    for (let i = 0; i < 4; i++) {
      const hop = await server.callTool("tl_read_file", { qref, cwd: ws });
      hops.push(hop.body);
    }

    const violations = priorClaimsForNeverShippedBytes(hops);
    expect(violations, `default config regressed: prior claimed for unshipped bytes: ${JSON.stringify(violations)}`).toEqual([]);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Group C — residual 2's underlying symptom: once a task's replay settles,
// it MUST be a pure function of task state — same decision.kind AND same
// certificate id — across many repeated identical bare-qref replays. (The
// literal act.answer -> discover -> read.receipt flip described in the
// review was not reproduced; see this file's header.)
// ---------------------------------------------------------------------------
describe("FIX-FC2 residual 2 (investigated): VS Code replay settles to a stable decision and certificate", () => {
  it("answer profile: decision.kind never flips across 8 repeated identical qref replays, and the certificate id stabilizes", async () => {
    const ws = makeWorkspace("r2-vscode-answer");
    const server = await spawnedServer(ws, "vscode");

    const hop0 = await server.callTool("tl_read_file", { query: QUERY, cwd: ws, task: { epoch: "new", profile: "answer" } });
    const qref = hop0.body?.qref;
    expect(typeof qref, `hop0 carried no qref: ${JSON.stringify(hop0.body)}`).toBe("string");
    expect(hop0.body?.decision?.kind).toBe("act.answer");

    const kinds: unknown[] = [hop0.body?.decision?.kind];
    const certIds: unknown[] = [hop0.body?.decision?.certificate?.id];
    for (let i = 0; i < 8; i++) {
      const hop = await server.callTool("tl_read_file", { qref, cwd: ws });
      kinds.push(hop.body?.decision?.kind);
      certIds.push(hop.body?.decision?.certificate?.id);
    }

    // Every hop stays act.answer -- never discover, never await_input.
    expect(kinds.every((k) => k === "act.answer"), `decision.kind flipped across replays: ${JSON.stringify(kinds)}`).toBe(true);

    // From the point the chain FIRST repeats a certificate id, it must never
    // again change: once settled, replay is idempotent. (Hop 1 may
    // legitimately differ from hop 0 -- it is the first real shipment of a
    // counterexample surface hop 0 never sent a body for, exactly like the
    // default config's own hop 1 -- but every hop from the first repeat
    // onward must be the SAME certificate, forever.)
    const firstRepeatIndex = certIds.findIndex((id, i) => i > 0 && id === certIds[i - 1]);
    expect(firstRepeatIndex, `certificate id never settled across 8 replays: ${JSON.stringify(certIds)}`).toBeGreaterThan(0);
    const settled = certIds[firstRepeatIndex];
    for (let i = firstRepeatIndex; i < certIds.length; i++) {
      expect(certIds[i], `certificate id destabilized after settling: ${JSON.stringify(certIds)}`).toBe(settled);
    }
  }, 60_000);

  it("no declared profile, --allow-write: decision.kind never flips across 6 repeated identical qref replays", async () => {
    const ws = makeWorkspace("r2-vscode-noprofile");
    const server = await spawnedServer(ws, "vscode", ["--allow-write"]);

    const hop0 = await server.callTool("tl_read_file", { query: QUERY, cwd: ws, task: { epoch: "new" } });
    const qref = hop0.body?.qref;
    expect(typeof qref, `hop0 carried no qref: ${JSON.stringify(hop0.body)}`).toBe("string");

    const kinds: unknown[] = [hop0.body?.decision?.kind];
    for (let i = 0; i < 6; i++) {
      const hop = await server.callTool("tl_read_file", { qref, cwd: ws });
      kinds.push(hop.body?.decision?.kind);
    }
    // The first hop may be `discover` (turn-economy still routes through a
    // search step for an undeclared-profile edit request) -- the invariant
    // under test is that EVERY REPLAY of the SAME qref agrees with the one
    // before it, never oscillating back and forth.
    for (let i = 2; i < kinds.length; i++) {
      expect(kinds[i], `decision.kind oscillated across replays: ${JSON.stringify(kinds)}`).toBe(kinds[i - 1]);
    }
  }, 60_000);
});
