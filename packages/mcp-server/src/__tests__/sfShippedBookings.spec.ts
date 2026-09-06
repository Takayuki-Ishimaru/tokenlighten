/**
 * sfShippedBookings.spec.ts — FX-J (round-14 findings 1, 2 and 4).
 *
 * THE INVARIANT, restated at the producer level. Under `TL_SF_DEMOTE`, EVERY
 * session-state producer that asserts something about what a task pack served
 * must see the SHIPPED pack. A withheld surface contributes no body, no edit
 * authority, no certified-context claim and no served-range coverage; it stays
 * addressable by handle for READS alone.
 *
 * WHAT FX-I-A LEFT OPEN (round-14 finding 1, reproduced here). It moved the
 * demotion seam into `dedupeTrimAndPersist` and split the admissible union
 * into nominate/book — but `recordServedSurfaces`, the cumulative
 * served-surface log, stayed UPSTREAM of the seam and took no body filter at
 * all. `priorEpochActionFrontier` lifts that log's handles into the NEXT
 * same-epoch pack's certificate `action_frontier`, and `guardExecutionEdit`
 * admits any handle in `fence.actionFrontier`. So a file whose bytes never
 * left the process was editable, blind, one call later — by handle. (By PATH
 * it was refused, which is the control that isolates the mechanism: every
 * path-based admission term rejected it.)
 *
 * Measured at `82ef30a5` on the fixture below, with the ten SF flags on:
 *   log        = ["src/engagement.ts", "src/supporting_notes.ts"]   ← demoted row logged
 *   call-2 fence.actionFrontier = [h_engagement, h_supporting]      ← demoted handle
 *   edit by the demoted handle  = edit.applied                      ← BLIND EDIT
 * and after FX-J:
 *   log        = ["src/engagement.ts"]
 *   call-2 fence.actionFrontier = [h_engagement]
 *   edit by the demoted handle  = refusal / execution-typestate
 *
 * WHICH CASES FAIL WITHOUT THE FIX (verified by restoring the four pre-fix
 * modules from `git show HEAD:` and re-running, then restoring):
 *   - "the served-surface log books only what shipped"      (log contains the demoted path)
 *   - "the next same-epoch certificate's action_frontier"   (frontier contains the demoted handle)
 *   - "the demoted handle is not editable one call later"   (edit.applied)
 * The flag-off cases and the zoom case are R1 regression guards: they pass
 * before and after, and their job is to prove FX-J did not move the default
 * path or make a withheld row unreachable.
 *
 * FX-K (round-15 finding 1) made the invariant UNCONDITIONAL: there is one
 * booking pass, it runs post-trim/post-seam in both flag states, and it books
 * `shippedSurfaces(returned)`. The last describe in this file changed sides
 * accordingly — it used to pin `8ea1eb52`'s pre-trim booking of a spliced
 * surface as a deliberately preserved quirk; it now pins its absence.
 */

import { afterEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { callTool } from "../server.js";
import { getSession, tokenizeForEpoch } from "../state/session.js";
import { queryServedSurfaces } from "../util/packServeLog.js";
import { resetAll as resetAllSessions } from "../util/session.js";

// ---------------------------------------------------------------------------
// Fixture and queries — the round-14 `r14_m` reproduction, verbatim in shape.
//
// The profile matters and is the reason FX-I-A's own spec could not see this:
// `finalizePackServeState` records the cumulative log only when
// `profile !== "answer" || profile_binding.source !== "explicit"`. An
// EXPLICIT `task.profile:"answer"` (what sfPreBookingSeam.spec.ts sends) skips
// the log entirely. An ordinary question with NO declared profile infers
// "answer" and DOES record it — the production shape this defect lives in.
// ---------------------------------------------------------------------------

const PRIMARY = "src/engagement.ts";
const SUPPORTING = "src/supporting_notes.ts";
const UNPACKED = "src/plain.ts";

/**
 * Inferred-answer question: demotes SUPPORTING and records the cumulative log.
 *
 * FX-R3 D4 (2026-09-04): anchored on `renderEngagement`, the identifier the
 * production workspace index resolves. Under the v2 marking source a candidate
 * is demotable only when the pack carries at least one GROUNDED structural
 * concern; the const `ENGAGEMENT_WITNESS` grounds none, and the legacy
 * "continuation relation" vocabulary is no longer a marking source.
 */
const QUESTION =
  "What does renderEngagement mean, and how does the continuation relation use the supporting context?";
/** Same-epoch generic change pack over PRIMARY alone — installs the prepared fence. */
const EDIT_QUERY =
  "Update renderEngagement so the ENGAGEMENT_WITNESS continuation relation uses the supporting context.";

const tmpDirs: string[] = [];

function mkWorkspace(tag: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.homedir(), `.tl-sf-shipped-${tag}-`)));
  tmpDirs.push(dir);
  const write = (rel: string, content: string): void => {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, "utf8");
  };
  write(PRIMARY, [
    'export const ENGAGEMENT_WITNESS = "semantic-frontier-engagement-witness";',
    "export function renderEngagement(input: string): string {",
    "  return `${ENGAGEMENT_WITNESS}:${input}`;",
    "}",
  ].join("\n"));
  write(SUPPORTING, [
    "export const SUPPORTING_NOTE = 'supporting lexical context';",
    "export const CONTINUATION_NOTE = 'continuation relation';",
  ].join("\n"));
  write(UNPACKED, Array.from({ length: 12 }, (_, i) => `export const L${i} = ${i};`).join("\n"));
  return dir;
}

afterEach(() => {
  delete process.env["TL_SF_STATEFUL"];
  delete process.env["TL_SF_DEMOTE"];
  delete process.env["TL_SF_STRUCTURAL_CONCERNS"];
  delete process.env["TL_SEMANTIC_FRONTIER_GUARD"];
  // NOTE: the SF state adapter's LRU is deliberately NOT reset here. Its own
  // spec pins a consumer allowlist this file stays off, and no reset is
  // needed: every case builds its OWN temp workspace, so no per-pack SF state
  // is ever shared between them.
  resetAllSessions();
  for (const dir of tmpDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
});

// ---------------------------------------------------------------------------
// Spawned stdio server — the write-gate-open shape, so the execution-typestate
// gate (not `--allow-write`) is what answers an edit.
// ---------------------------------------------------------------------------

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TSX_CLI = path.resolve(HERE, "../../../../node_modules/tsx/dist/cli.mjs");
const BIN_TS = path.resolve(HERE, "../bin.ts");

interface RawResponse { isError: boolean; body: Record<string, unknown>; text: string }
interface WireRow { handle?: string; path?: string; body?: string; prior?: string; remaining?: string[] }
interface ServerHandle {
  initialize(): Promise<void>;
  call(tool: string, args: Record<string, unknown>): Promise<RawResponse>;
  kill(): void;
}

function startServer(cwd: string, env: NodeJS.ProcessEnv): ServerHandle {
  const child: ChildProcess = spawn(
    process.execPath,
    [TSX_CLI, BIN_TS, cwd, "--allow-write"],
    { cwd, stdio: ["pipe", "pipe", "pipe"], env },
  );
  let stdout = "";
  let stderr = "";
  let nextId = 1;
  const waiters = new Map<number, (msg: unknown) => void>();
  child.stdout!.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
    let nl = stdout.indexOf("\n");
    while (nl >= 0) {
      const line = stdout.slice(0, nl);
      stdout = stdout.slice(nl + 1);
      nl = stdout.indexOf("\n");
      if (line.trim() === "") continue;
      let msg: { id?: unknown };
      try {
        msg = JSON.parse(line) as { id?: unknown };
      } catch {
        continue;
      }
      const id = msg?.id;
      if (typeof id === "number" && waiters.has(id)) {
        const waiter = waiters.get(id)!;
        waiters.delete(id);
        waiter(msg);
      }
    }
  });
  child.stderr!.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const rpc = (method: string, params: unknown): Promise<unknown> => {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(id);
        reject(new Error(`rpc '${method}' timed out\n${stderr}`));
      }, 90000);
      waiters.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  };
  return {
    async initialize() {
      await rpc("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "sf-shipped", version: "0" },
      });
      child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    },
    async call(tool, args) {
      const raw = await rpc("tools/call", { name: tool, arguments: args });
      const result = (raw as { result?: { content?: Array<{ text?: unknown }>; isError?: unknown } })?.result;
      const content = result?.content;
      const text = Array.isArray(content) && content[0]?.text !== undefined ? String(content[0]!.text) : "";
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(text) as Record<string, unknown>;
      } catch {
        /* a non-JSON body stays empty; the assertions name the shape */
      }
      return { isError: result?.isError === true, body, text };
    },
    kill() {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    },
  };
}

function spawnEnv(on: boolean): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    TOKENLIGHTEN_ALLOWED_PARENTS: os.homedir(),
    TL_LEGACY_INPUT: "accept",
  };
  delete env["TL_SEMANTIC_FRONTIER_GUARD"];
  delete env["TL_SF_STATEFUL"];
  delete env["TL_SF_DEMOTE"];
  delete env["TL_SF_STRUCTURAL_CONCERNS"];
  if (on) {
    env["TL_SF_STATEFUL"] = "1";
    env["TL_SF_DEMOTE"] = "1";
    env["TL_SF_STRUCTURAL_CONCERNS"] = "1"; // FX-R3 D4: the v2 marking source.
  }
  return env;
}

const rowsOf = (res: RawResponse): WireRow[] =>
  Array.isArray(res.body["evidence"]) ? res.body["evidence"] as WireRow[] : [];

function setFlags(on: boolean): void {
  if (on) {
    process.env["TL_SF_STATEFUL"] = "1";
    process.env["TL_SF_DEMOTE"] = "1";
    process.env["TL_SF_STRUCTURAL_CONCERNS"] = "1"; // FX-R3 D4: the v2 marking source.
  } else {
    delete process.env["TL_SF_STATEFUL"];
    delete process.env["TL_SF_DEMOTE"];
    delete process.env["TL_SF_STRUCTURAL_CONCERNS"];
  }
}

/** The in-process half of the r14_m sequence: the question pack, then the same-epoch change pack. */
async function inProcessSequence(ws: string): Promise<{ supporting: WireRow | undefined; primary: WireRow | undefined }> {
  const first = await callTool("read_file", { query: QUESTION, task: { epoch: "new" }, cwd: ws });
  const body = JSON.parse(first.content[0]?.text ?? "{}") as { evidence?: WireRow[] };
  const rows = Array.isArray(body.evidence) ? body.evidence : [];
  return {
    supporting: rows.find((row) => row.path === SUPPORTING),
    primary: rows.find((row) => row.path === PRIMARY),
  };
}

describe("FX-J: the cumulative served-surface log books only what shipped", () => {
  it("TL_SF_DEMOTE: the demoted path is absent from the log, and so from the next certificate's action_frontier", async () => {
    setFlags(true);
    const ws = mkWorkspace("log-on");

    const { supporting, primary } = await inProcessSequence(ws);
    expect(supporting, "the supporting row must still ship — demote, never remove").toBeDefined();
    expect(supporting!.body, "precondition: its body is withheld").toBeUndefined();
    expect(typeof primary?.body, "precondition: the primary really served").toBe("string");

    // PRODUCER 1 — the cumulative log. Pre-fix this contained BOTH paths.
    const logged = queryServedSurfaces(ws, ws, { epochTokens: tokenizeForEpoch(QUESTION) })
      .map((entry) => entry.path);
    expect(logged).toContain(PRIMARY);
    expect(logged, "a withheld body must not be logged as served").not.toContain(SUPPORTING);

    // PRODUCER 2 — what the log feeds: the NEXT same-epoch certificate's
    // action_frontier, which `guardExecutionEdit` admits handles from.
    await callTool("read_file", {
      query: EDIT_QUERY,
      targets: [{ path: PRIMARY }],
      task: { profile: "generic" },
      cwd: ws,
    });
    const fence = getSession(ws).executionFence;
    expect(fence?.phase, "the change pack must install a prepared fence").toBe("prepared");
    expect(
      fence?.actionFrontier ?? [],
      "the demoted handle must not ride priorEpochActionFrontier into the next certificate",
    ).not.toContain(supporting!.handle);
    // The union stays honest in the other direction too — this is a narrowing
    // to what shipped, never a general suppression.
    expect(getSession(ws).admissibleEditPaths).toContain(PRIMARY);
    expect(getSession(ws).admissibleEditPaths).not.toContain(SUPPORTING);
  }, 90000);

  it("R1 flag-off identity: the same sequence logs BOTH paths and frontiers BOTH handles", async () => {
    setFlags(false);
    const ws = mkWorkspace("log-off");

    const { supporting } = await inProcessSequence(ws);
    expect(typeof supporting?.body, "flag off: the body ships").toBe("string");

    const logged = queryServedSurfaces(ws, ws, { epochTokens: tokenizeForEpoch(QUESTION) })
      .map((entry) => entry.path);
    expect(logged).toContain(PRIMARY);
    expect(logged).toContain(SUPPORTING);

    await callTool("read_file", {
      query: EDIT_QUERY,
      targets: [{ path: PRIMARY }],
      task: { profile: "generic" },
      cwd: ws,
    });
    const fence = getSession(ws).executionFence;
    expect(fence?.phase).toBe("prepared");
    expect(
      fence?.actionFrontier ?? [],
      "flag off the surface really was served, so its handle is legitimately editable",
    ).toContain(supporting!.handle);
    expect(getSession(ws).admissibleEditPaths).toContain(SUPPORTING);
  }, 90000);
});

describe("FX-J: a demoted handle is not editable one call later (spawned server)", () => {
  it("TL_SF_DEMOTE: handle, path and a never-packed control all refuse; the served primary still applies", async () => {
    const ws = mkWorkspace("edit-on");
    const srv = startServer(ws, spawnEnv(true));
    try {
      await srv.initialize();
      const first = await srv.call("read_file", { query: QUESTION, task: { epoch: "new" }, cwd: ws });
      const supporting = rowsOf(first).find((row) => row.path === SUPPORTING);
      expect(supporting, "the supporting row must ship").toBeDefined();
      expect(supporting!.body, "precondition: demoted").toBeUndefined();

      const second = await srv.call("read_file", {
        query: EDIT_QUERY,
        targets: [{ path: PRIMARY }],
        task: { profile: "generic" },
        cwd: ws,
      });
      expect((second.body["decision"] as { kind?: string } | undefined)?.kind).toBe("act.edit");

      // THE ASSERTION (round-14 finding 1). Pre-fix: `edit.applied`.
      const byHandle = await srv.call("edit_file", {
        edits: [{
          handle: supporting!.handle,
          search: "supporting lexical context",
          replace: "PATCHED-WITHOUT-SERVING",
          precondition: "unique-match",
          allowPathFallback: false,
        }],
        cwd: ws,
      });
      expect(byHandle.body["kind"], `expected a refusal, got: ${byHandle.text.slice(0, 400)}`).toBe("refusal");
      expect(byHandle.body["code"]).toBe("execution-typestate");

      // The path form was already refused pre-fix — it is the control that
      // isolates the mechanism (only `fence.actionFrontier` could have
      // admitted the handle).
      const byPath = await srv.call("edit_file", {
        edits: [{
          path: SUPPORTING,
          search: "continuation relation",
          replace: "PATCHED",
          precondition: "unique-match",
          allowPathFallback: false,
        }],
        cwd: ws,
      });
      expect(byPath.body["kind"]).toBe("refusal");
      expect(byPath.body["code"]).toBe("execution-typestate");

      // A file that appeared in NO pack — proves the fence is live at all.
      const control = await srv.call("edit_file", {
        edits: [{
          path: UNPACKED,
          search: "export const L1 = 1;",
          replace: "export const L1 = 999;",
          precondition: "unique-match",
          allowPathFallback: false,
        }],
        cwd: ws,
      });
      expect(control.body["kind"]).toBe("refusal");
      expect(control.body["code"]).toBe("execution-typestate");

      // And the discriminating half: the file this server DID serve is still
      // editable, so the fix is a narrowing to what shipped, not a lockout.
      const served = await srv.call("edit_file", {
        edits: [{
          path: PRIMARY,
          search: "semantic-frontier-engagement-witness",
          replace: "semantic-frontier-engagement-witness-v2",
          precondition: "unique-match",
          allowPathFallback: false,
        }],
        cwd: ws,
      });
      expect(served.body["kind"], `expected the served file to be editable: ${served.text.slice(0, 300)}`)
        .toBe("edit.applied");

      // Nothing was written to the withheld file.
      expect(fs.readFileSync(path.join(ws, SUPPORTING), "utf8"))
        .toContain("supporting lexical context");
    } finally {
      srv.kill();
    }
  }, 120000);

  it("R1 flag-off control: the same sequence APPLIES both edits — the delta is caused by the lever", async () => {
    const ws = mkWorkspace("edit-off");
    const srv = startServer(ws, spawnEnv(false));
    try {
      await srv.initialize();
      const first = await srv.call("read_file", { query: QUESTION, task: { epoch: "new" }, cwd: ws });
      const supporting = rowsOf(first).find((row) => row.path === SUPPORTING);
      expect(typeof supporting?.body, "flag off: the body ships").toBe("string");

      await srv.call("read_file", {
        query: EDIT_QUERY,
        targets: [{ path: PRIMARY }],
        task: { profile: "generic" },
        cwd: ws,
      });
      const byHandle = await srv.call("edit_file", {
        edits: [{
          handle: supporting!.handle,
          search: "supporting lexical context",
          replace: "PATCHED-AFTER-SERVING",
          precondition: "unique-match",
          allowPathFallback: false,
        }],
        cwd: ws,
      });
      expect(byHandle.body["kind"], `flag off this is a legitimate edit: ${byHandle.text.slice(0, 300)}`)
        .toBe("edit.applied");
      // The never-packed control still refuses, so the fence is live here too.
      const control = await srv.call("edit_file", {
        edits: [{
          path: UNPACKED,
          search: "export const L1 = 1;",
          replace: "export const L1 = 999;",
          precondition: "unique-match",
          allowPathFallback: false,
        }],
        cwd: ws,
      });
      expect(control.body["kind"]).toBe("refusal");
    } finally {
      srv.kill();
    }
  }, 120000);
});

describe("FX-J: a withheld body stays reachable for READS", () => {
  it("zooming the demoted handle serves the bytes, with no false `prior`", async () => {
    setFlags(true);
    const ws = mkWorkspace("zoom");

    const { supporting } = await inProcessSequence(ws);
    expect(supporting?.body, "precondition: demoted").toBeUndefined();

    // Nothing booked those bytes, so the zoom must SERVE them rather than
    // answer `prior:"task_pack 1-1"` (the FX-H residual this replaces).
    const zoom = await callTool("read_file", {
      targets: [{ handle: supporting!.handle }],
      content: "full",
      cwd: ws,
    });
    const text = zoom.content[0]?.text ?? "{}";
    expect(text, "the withheld bytes must come back on a zoom").toContain("supporting lexical context");
    const zoomed = JSON.parse(text) as { evidence?: WireRow[]; text?: string };
    for (const row of zoomed.evidence ?? []) {
      if (row.path !== SUPPORTING) continue;
      expect(row.prior, "a never-served window must not be claimed as already held").toBeUndefined();
    }
  }, 90000);

  it("a qref replay naming the demoted path gains no certified context", async () => {
    setFlags(true);
    const ws = mkWorkspace("qref");

    const first = await callTool("read_file", { query: QUESTION, task: { epoch: "new" }, cwd: ws });
    const firstBody = JSON.parse(first.content[0]?.text ?? "{}") as {
      evidence?: WireRow[]; task?: { replay?: string };
    };
    const supporting = (firstBody.evidence ?? []).find((row) => row.path === SUPPORTING);
    expect(supporting?.body, "precondition: demoted").toBeUndefined();
    const qref = firstBody.task?.replay;
    expect(typeof qref, "the pack must publish a replay token").toBe("string");

    // The change pack is what leaves a certificate behind; its working set is
    // PRIMARY alone, because the demoted row contributes nothing to it.
    await callTool("read_file", {
      query: EDIT_QUERY,
      targets: [{ path: PRIMARY }],
      task: { profile: "generic" },
      cwd: ws,
    });

    const replay = await callTool("read_file", {
      qref,
      targets: [{ path: SUPPORTING }],
      task: { force_serve: true },
      cwd: ws,
    });
    const replayText = replay.content[0]?.text ?? "{}";
    // `carryForwardCertifiedWorkingSet` clones a whole execution_contract onto
    // the replay when every ADDED path is already certified context. A
    // never-served path must fail that test closed, so the tell-tale route
    // reason must be absent.
    expect(replayText, "a demoted path must not be accepted as already-certified context")
      .not.toContain("certified working set carried forward");
  }, 90000);
});

describe("FX-K: a CAP-OVERFLOWING pack books only what it shipped, flag off", () => {
  /**
   * FX-K (round-15 finding 1) REPLACES the expectation this case used to pin.
   * `8ea1eb52` — and FX-J after it — booked the admissible union and the
   * cumulative log from the PRE-TRIM surface list with every flag off, so a
   * surface `trimToCap` spliced out (Phase F) or stripped of its body (Phase
   * E) was still booked as served. Gap (o) deferred the repair partly on
   * "Phase-E-on-survivor is unreachable from the production entrance";
   * round-15 falsified that with a one-call `budget:{bytes:6144}` read whose
   * follow-up `edit_file` landed `edit.applied` against a file the response
   * sent no bytes for, with a never-packed control refusing at the same fence.
   *
   * The ruling: the default path books only what it shipped. This case pins
   * the Phase-F endpoint; `sfCapOverflowBookings.spec.ts` sweeps the rest of
   * the cap range and the Phase-E-on-survivor endpoint end to end.
   */
  it("does NOT book the surface the byte budget dropped", async () => {
    setFlags(false);
    const ws = mkWorkspace("cap-off");
    const body = (prefix: string, n: number): string => Array.from({ length: n }, (_, i) =>
      `export function ${prefix}${i}(value: number): number {\n  // ${prefix} payment checkout handler ${i}\n  return value + ${i};\n}`).join("\n");
    fs.writeFileSync(path.join(ws, "src/payment.ts"), body("payment", 12), "utf8");
    fs.writeFileSync(path.join(ws, "src/checkout.ts"), body("checkout", 18), "utf8");
    fs.writeFileSync(path.join(ws, "src/paymentApi.ts"), body("paymentApi", 26), "utf8");

    const query = "Update the payment checkout handler across the payment and checkout modules.";
    const res = await callTool("read_file", {
      query,
      targets: [{ path: "src/payment.ts" }, { path: "src/checkout.ts" }, { path: "src/paymentApi.ts" }],
      task: { profile: "generic", epoch: "new" },
      budget: { bytes: 6144 },
      cwd: ws,
    });
    const pack = JSON.parse(res.content[0]?.text ?? "{}") as { kind?: string; evidence?: WireRow[] };
    expect(pack.kind).toBe("read.task_pack");
    const shipped = (pack.evidence ?? []).map((row) => row.path);
    expect(shipped, "precondition: the byte budget really shed a whole surface")
      .not.toContain("src/paymentApi.ts");
    expect(shipped).toContain("src/payment.ts");
    expect(shipped).toContain("src/checkout.ts");

    const session = getSession(ws);
    const logged = queryServedSurfaces(ws, ws, { epochTokens: tokenizeForEpoch(query) })
      .map((entry) => entry.path);
    // The T09/T10 direction: a surface that SHIPPED WITH A BODY stays
    // admissible. Narrowing this half is the regression FX-K must not cause.
    for (const p of shipped) {
      expect(session.admissibleEditPaths, `${p} shipped a body and must stay editable`).toContain(p);
      expect(logged, `${p} shipped a body and must stay in the cumulative log`).toContain(p);
    }
    // The FX-K direction: the spliced surface sent no bytes, so it carries no
    // write authority and makes no cumulative-coverage claim.
    expect(session.admissibleEditPaths, "a Phase-F spliced surface must not be editable")
      .not.toContain("src/paymentApi.ts");
    expect(logged, "a Phase-F spliced surface must not be logged as served")
      .not.toContain("src/paymentApi.ts");
  }, 90000);
});
