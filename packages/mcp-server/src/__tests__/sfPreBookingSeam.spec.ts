/**
 * sfPreBookingSeam.spec.ts — FX-I-A (round-13 findings 1 and 5).
 *
 * THE INVARIANT. The last pass that can shed a body must run before the first
 * producer that books one: the pack that gets BOOKED is the pack that SHIPS.
 *
 * Before FX-I-A that was false. `applySemanticFrontierDemotion` ran from
 * `buildTaskPack` AFTER `buildTaskPackCore` returned, while
 * `finalizePackServeState`'s `recordServedEditAdmissibility` (the edit gate's
 * admissible union) ran inside `dedupeTrimAndPersist`, inside that core, off
 * `hasServedCode(surface)` on the UN-demoted pack. A demoted — never served —
 * file's handle therefore entered `session.admissibleEditHandles`, and the
 * execution-typestate gate admitted a blind edit of it under
 * `workspace.scope:"served-evidence"`. The one producer FX-H had deferred (the
 * served-range ledger) was deferred through an unkeyed module-global queue
 * flushed by whichever `buildTaskPack` exited first (round-13 findings 3/4);
 * that queue is deleted.
 *
 * The seam now sits in `dedupeTrimAndPersist` immediately after
 * `annotateSemanticFrontierContinuation` — the earliest point at which a
 * surface can be KNOWN SF-supporting, since the classifier needs the finalized
 * `execution_contract` — and before all four booking producers: the admissible
 * union (moved to `bookServedEditAdmissibility` at the function's exit for
 * exactly this reason), `rememberCertifiedWorkingSet`, `captureServedPack` and
 * its `recordPackServedRanges`.
 *
 * WHAT IS DRIVEN HERE. Production shapes only: a SPAWNED stdio server with
 * `--allow-write` for the edit/zoom cases (the shape that actually exhibits
 * the ledger and the write gate), and the real in-process `callTool` dispatch
 * plus `getSession` for the session-state cases. The one unit-level block is
 * the demotion FLOOR (round-13 finding 5), which is a pure predicate over a
 * pack's surfaces.
 *
 * WHICH CASES FAIL WITHOUT THE FIX (verified by temporarily restoring each
 * pre-fix ordering, then restoring the fix):
 *   - booking the admissible union inside `finalizePackServeState`, above the
 *     seam: the REFUSAL case returns `edit.applied` under
 *     `scope:"served-evidence"`, and the UNION case finds the demoted
 *     path/handle in `session.admissibleEdit*`.
 *   - moving the seam below `captureServedPack`: both of those fail, and so
 *     does the SERVED-RANGE LEDGER case (`servedRangeCoverage` reports the
 *     withheld window as served).
 *   - restoring `code_unchanged` to the demotion floor's survivor count: the
 *     FLOOR case withholds the pack's only fresh body.
 * The zoom case is a regression guard rather than a fix-proving case — see its
 * own note.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
  applyCanonicalTaskDecision,
  applySemanticFrontierDemotion,
  attachSfDemotionResidency,
} from "../features/task-pack/canonicalDecision.js";
import { annotateSemanticFrontierContinuation } from "../features/task-pack/semanticFrontier.js";
import { attachSfPackContext } from "../features/task-pack/sfSatisfaction.js";
import { callTool } from "../server.js";
import { getSession, servedRangeCoverage } from "../state/session.js";
import { resetSfStateForTests, type SfServedLedgerReader } from "../task-state/sfState.js";
import { resetAll as resetAllSessions } from "../util/session.js";

// ---------------------------------------------------------------------------
// Fixture — verbatim from sfDemote.spec.ts's own real-dispatch block: one
// primary file the query names, and one zero-binding lexically-related file
// that only `annotateSemanticFrontierContinuation` can classify supporting.
// ---------------------------------------------------------------------------

// FX-R3 D4 (2026-09-04): anchored on `renderEngagement`, the identifier the
// production workspace index actually resolves. Under the v2 marking source a
// candidate is demotable only when the pack carries at least one GROUNDED
// structural concern; the const `ENGAGEMENT_WITNESS` grounds none, and the
// legacy "continuation relation" vocabulary is no longer a marking source.
const DEMOTE_QUERY =
  "Trace renderEngagement continuation relation while retaining the supporting context.";
/** A generic, explicitly-targeted edit query — installs a prepared fence over engagement.ts ALONE. */
const EDIT_QUERY =
  "Update renderEngagement in src/engagement.ts for the ENGAGEMENT_WITNESS continuation relation.";
const SUPPORTING = "src/supporting_notes.ts";
const PRIMARY = "src/engagement.ts";

const tmpDirs: string[] = [];

function mkWorkspace(tag: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.homedir(), `.tl-sf-prebooking-${tag}-`)));
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
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
});

// ---------------------------------------------------------------------------
// Spawned stdio server — the same bin.ts entry point sfV2CombinedPin.spec.ts
// drives, with `--allow-write` so the execution-typestate gate (not the write
// gate) is what answers an edit.
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
        clientInfo: { name: "sf-prebooking", version: "0" },
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
        /* a non-JSON body stays empty; the assertions below name the shape */
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

/** The ten-flag scenario env, plus the legacy guard always unset (DEMOTE excludes it). */
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
    // FX-R3 D4: the v2 marking source is the structural extractor.
    env["TL_SF_STRUCTURAL_CONCERNS"] = "1";
  }
  return env;
}

const rowsOf = (res: RawResponse): WireRow[] =>
  Array.isArray(res.body["evidence"]) ? res.body["evidence"] as WireRow[] : [];

/**
 * The production sequence both spawned cases run:
 *   (1) the answer-focus pack that classifies `supporting_notes` supporting;
 *   (2) an explicitly-targeted generic pack over `engagement.ts` ALONE, which
 *       installs a prepared certificate whose frontier/evidence therefore
 *       covers `engagement.ts` and nothing else;
 *   (3) an edit through the supporting row's own handle.
 *
 * Step (2) is what makes step (3) meaningful: without a live prepared fence
 * the execution-typestate gate has nothing to refuse against, and the edit
 * would be admitted in BOTH flag states for a reason that has nothing to do
 * with demotion.
 */
async function runSequence(srv: ServerHandle, cwd: string): Promise<{
  supporting: WireRow | undefined;
  edit: RawResponse;
}> {
  const demotePack = await srv.call("read_file", {
    query: DEMOTE_QUERY,
    task: { profile: "answer", epoch: "new" },
    cwd,
  });
  const supporting = rowsOf(demotePack).find((row) => row.path === SUPPORTING);
  await srv.call("read_file", {
    query: EDIT_QUERY,
    targets: [{ path: PRIMARY }],
    task: { profile: "generic" },
    cwd,
  });
  const edit = await srv.call("edit_file", {
    edits: [{
      handle: supporting?.handle ?? "h-missing",
      search: "supporting lexical context",
      replace: "PATCHED-WITHOUT-SERVING",
      precondition: "unique-match",
      allowPathFallback: false,
    }],
    cwd,
  });
  return { supporting, edit };
}

describe("FX-I-A: a demoted row's handle never becomes an editable target (spawned server)", () => {
  it("REFUSES the edit — the demoted address is outside the certificate frontier", async () => {
    const ws = mkWorkspace("refuse");
    const srv = startServer(ws, spawnEnv(true));
    try {
      await srv.initialize();
      const { supporting, edit } = await runSequence(srv, ws);

      // Precondition: the row really was demoted (bodyless, still reachable).
      expect(supporting, "the supporting row must still ship — demote, never remove").toBeDefined();
      expect(supporting!.body, "§3.5.1 supporting tier: no body").toBeUndefined();
      expect(supporting!.prior, "§3.5.1 supporting tier: no prior").toBeUndefined();
      expect(typeof supporting!.handle).toBe("string");
      expect(Array.isArray(supporting!.remaining) && supporting!.remaining!.length > 0).toBe(true);

      // THE ASSERTION. Pre-fix this was `edit.applied` with
      // `core.workspace.scope:"served-evidence"` — a blind edit of a file
      // whose bytes never left the process.
      expect(edit.body["kind"], `expected a refusal, got: ${edit.text.slice(0, 400)}`).toBe("refusal");
      expect(edit.body["code"]).toBe("execution-typestate");
      expect(String(edit.body["detail"] ?? "")).toContain("outside certificate frontier");
      // And nothing was written.
      expect(fs.readFileSync(path.join(ws, SUPPORTING), "utf8"))
        .toContain("supporting lexical context");
    } finally {
      srv.kill();
    }
  }, 120000);

  it("flag-off control: the identical sequence serves the body and the edit lands", async () => {
    // The counterfactual that makes the refusal above attributable. With the
    // flags off the same supporting row ships WITH its body, so the same
    // address is legitimately served evidence and the same edit is admitted —
    // i.e. the refusal is the demotion's doing, not the fixture's.
    const ws = mkWorkspace("flagoff");
    const srv = startServer(ws, spawnEnv(false));
    try {
      await srv.initialize();
      const { supporting, edit } = await runSequence(srv, ws);
      expect(supporting, "flag off: the supporting row still ships").toBeDefined();
      expect(typeof supporting!.body, "flag off: with its body, exactly as before").toBe("string");
      expect(edit.body["kind"], `expected edit.applied, got: ${edit.text.slice(0, 400)}`)
        .toBe("edit.applied");
    } finally {
      srv.kill();
    }
  }, 120000);

  it("the withheld window stays recoverable: zooming the demoted handle serves the bytes, no `prior`", async () => {
    // "Demote, never remove" is a claim about RECOVERABILITY, and the
    // served-range ledger is what could break it: `captureServedPack` books
    // the shipped pack, and a booking taken before the body came off would
    // answer `prior` here for lines the caller never received.
    //
    // HONESTY NOTE ON WHAT THIS CASE PROVES. It is a REGRESSION GUARD, not one
    // of the fix-proving cases: it passes both before and after FX-I-A, and it
    // also passes with the seam deliberately moved back below
    // `captureServedPack` — this two-file fixture does not exhibit the ledger
    // `prior` split at all. The case that DOES fail on that ordering is
    // sfV2CombinedPin.spec.ts's "the withheld window is REALLY reachable"
    // (verified: it is the single failure when the seam is moved after the
    // capture). This one pins the caller-visible half — the bytes really come
    // back through the demoted row's own handle — on the fixture the refusal
    // case above uses, so the two cannot drift apart.
    const ws = mkWorkspace("zoom");
    const srv = startServer(ws, spawnEnv(true));
    try {
      await srv.initialize();
      const pack = await srv.call("read_file", {
        query: DEMOTE_QUERY,
        task: { profile: "answer", epoch: "new" },
        cwd: ws,
      });
      const row = rowsOf(pack).find((entry) => entry.path === SUPPORTING);
      expect(row?.body).toBeUndefined();

      const zoom = await srv.call("read_file", {
        targets: [{ handle: row!.handle!, range: row!.remaining![0]! }],
        cwd: ws,
      });
      const zoomRows = rowsOf(zoom);
      expect(zoomRows.length, "the zoom must return the withheld window").toBeGreaterThan(0);
      expect(
        zoomRows.every((entry) => entry.prior === undefined),
        "no line of a withheld window may come back as already-served `prior`",
      ).toBe(true);
      expect(zoomRows.map((entry) => entry.body ?? "").join("\n")).toContain("SUPPORTING_NOTE");
    } finally {
      srv.kill();
    }
  }, 120000);
});

// ---------------------------------------------------------------------------
// Session state — the union itself, read straight off the session the real
// dispatch wrote. `edit.applied` above is the CONSEQUENCE; this is the CAUSE.
// ---------------------------------------------------------------------------

describe("FX-I-A: the edit admissibility union is booked from the SHIPPED pack", () => {
  beforeEach(() => {
    resetSfStateForTests();
    resetAllSessions();
  });

  afterEach(() => {
    delete process.env["TL_SF_STATEFUL"];
    delete process.env["TL_SF_DEMOTE"];
    delete process.env["TL_SF_STRUCTURAL_CONCERNS"];
    delete process.env["TL_SEMANTIC_FRONTIER_GUARD"];
    resetSfStateForTests();
    resetAllSessions();
  });

  async function packThrough(ws: string, args: Record<string, unknown> = {}): Promise<WireRow[]> {
    const res = await callTool("read_file", {
      query: DEMOTE_QUERY,
      task: { profile: "answer", epoch: "new" },
      cwd: ws,
      ...args,
    });
    const body = JSON.parse(res.content[0]?.text ?? "{}") as { evidence?: WireRow[] };
    return Array.isArray(body.evidence) ? body.evidence : [];
  }

  it("excludes the demoted address — neither its path nor its handle enters the union", async () => {
    process.env["TL_SF_STATEFUL"] = "1";
    process.env["TL_SF_DEMOTE"] = "1";
    process.env["TL_SF_STRUCTURAL_CONCERNS"] = "1"; // FX-R3 D4: the v2 marking source.
    const ws = mkWorkspace("union-on");

    const rows = await packThrough(ws);
    const demoted = rows.find((row) => row.path === SUPPORTING);
    expect(demoted, "the supporting row must ship").toBeDefined();
    expect(demoted!.body, "precondition: it must actually be demoted").toBeUndefined();

    const session = getSession(ws);
    // Pre-fix BOTH lists carried the demoted address, because
    // `recordServedEditAdmissibility` ran on the un-demoted pack.
    expect(session.admissibleEditPaths).not.toContain(SUPPORTING);
    expect(session.admissibleEditHandles).not.toContain(demoted!.handle);
    // The pack's real, body-bearing surface is booked exactly as before —
    // this is a narrowing to what shipped, never a general suppression.
    expect(session.admissibleEditPaths).toContain(PRIMARY);
  }, 60000);

  it("flag-off state identity: the same pack books BOTH addresses, bodies and all", async () => {
    const ws = mkWorkspace("union-off");
    const rows = await packThrough(ws);
    const supporting = rows.find((row) => row.path === SUPPORTING);
    expect(typeof supporting?.body, "flag off: the body ships").toBe("string");

    const session = getSession(ws);
    expect(session.admissibleEditPaths).toContain(SUPPORTING);
    expect(session.admissibleEditPaths).toContain(PRIMARY);
    expect(session.admissibleEditHandles).toContain(supporting!.handle);
  }, 60000);

  it("the served-range ledger books no line of the withheld window, and books every line with the flag off", async () => {
    // The other half of the booking contract: `captureServedPack` ->
    // `recordPackServedRanges` is what a later zoom's `prior` is issued
    // against, so a window booked while the surface still carried its body is
    // exactly the "you already hold bytes you never received" claim.
    // `servedRangeCoverage` is the ledger's own reader for it.
    const shaAndLines = (ws: string): { sha: string; total: number } => {
      const text = fs.readFileSync(path.join(ws, SUPPORTING), "utf8");
      return {
        sha: `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`,
        total: Math.max(1, text.split("\n").length),
      };
    };

    process.env["TL_SF_STATEFUL"] = "1";
    process.env["TL_SF_DEMOTE"] = "1";
    process.env["TL_SF_STRUCTURAL_CONCERNS"] = "1"; // FX-R3 D4: the v2 marking source.
    const onWs = mkWorkspace("ledger-on");
    const onRows = await packThrough(onWs);
    expect(onRows.find((row) => row.path === SUPPORTING)?.body).toBeUndefined();
    const onFile = shaAndLines(onWs);
    expect(
      servedRangeCoverage(onWs, SUPPORTING, onFile.sha, onFile.total),
      "a withheld window must never be booked as served",
    ).toBeUndefined();

    delete process.env["TL_SF_STATEFUL"];
    delete process.env["TL_SF_DEMOTE"];
    delete process.env["TL_SF_STRUCTURAL_CONCERNS"];
    resetSfStateForTests();
    resetAllSessions();
    const offWs = mkWorkspace("ledger-off");
    const offRows = await packThrough(offWs);
    expect(typeof offRows.find((row) => row.path === SUPPORTING)?.body).toBe("string");
    const offFile = shaAndLines(offWs);
    expect(
      servedRangeCoverage(offWs, SUPPORTING, offFile.sha, offFile.total),
      "flag off: the body shipped, so the ledger books it exactly as before",
    ).toBeDefined();
  }, 60000);

  it("a CALLER-NAMED target is never demoted, and stays admissible (I-2)", async () => {
    process.env["TL_SF_STATEFUL"] = "1";
    process.env["TL_SF_DEMOTE"] = "1";
    process.env["TL_SF_STRUCTURAL_CONCERNS"] = "1"; // FX-R3 D4: the v2 marking source.
    const ws = mkWorkspace("named");

    const rows = await packThrough(ws, { targets: [{ path: SUPPORTING }] });
    const named = rows.find((row) => row.path === SUPPORTING);
    expect(named, "the caller-named path must be served").toBeDefined();
    expect(typeof named!.body, "a caller-named address is permanently out of reach of demotion").toBe("string");
    expect(getSession(ws).admissibleEditPaths).toContain(SUPPORTING);
  }, 60000);

  it("an address the served ledger already holds is never demoted, and stays admissible (D4)", async () => {
    process.env["TL_SF_STATEFUL"] = "1";
    process.env["TL_SF_DEMOTE"] = "1";
    process.env["TL_SF_STRUCTURAL_CONCERNS"] = "1"; // FX-R3 D4: the v2 marking source.
    const ws = mkWorkspace("held");

    // Serve the supporting file on its own first — the ledger now PROVES the
    // caller holds it, which disqualifies it from demotion for the rest of
    // the epoch.
    await callTool("read_file", { targets: [{ path: SUPPORTING }], content: "full", cwd: ws });
    const rows = await packThrough(ws);
    const held = rows.find((row) => row.path === SUPPORTING);
    expect(held, "the already-held path must still appear").toBeDefined();
    expect(
      typeof held!.body === "string" || typeof (held as Record<string, unknown>)["prior"] === "string",
      "a proven-held address is served or restated, never silently withheld",
    ).toBe(true);
    expect(getSession(ws).admissibleEditPaths).toContain(SUPPORTING);
  }, 60000);
});

// ---------------------------------------------------------------------------
// The demotion FLOOR (round-13 finding 5) — `code_unchanged` is not a survivor.
// ---------------------------------------------------------------------------

describe("FX-I-A: the demotion floor counts FRESH bodies only", () => {
  function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
    const previous: Record<string, string | undefined> = {};
    for (const key of Object.keys(vars)) previous[key] = process.env[key];
    try {
      for (const [key, value] of Object.entries(vars)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      fn();
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }

  const ledgerOver = (served: Iterable<string>): SfServedLedgerReader => {
    const paths = new Set(served);
    return {
      hasServedPath: (candidate) => paths.has(candidate),
      wasFullyServed: () => false,
      servedRangeCoverage: () => undefined,
    };
  };

  function mkSurface(
    relPath: string,
    opts: { code?: string; code_unchanged?: string } = {},
  ): Record<string, unknown> {
    return {
      path: relPath,
      handle: `h-${relPath}`,
      role: "domain",
      range: "1-50",
      remaining_ranges: [],
      ...(opts.code !== undefined ? { code: opts.code } : {}),
      ...(opts.code_unchanged !== undefined ? { code_unchanged: opts.code_unchanged } : {}),
    };
  }

  /**
   * The same marking pattern sfDemote.spec.ts uses: every surface EXCEPT
   * `optionalPath` binds directly to the "flag" concern through a sigil in its
   * body, leaving exactly one zero-binding candidate for the real
   * `annotateSemanticFrontierContinuation` to classify supporting.
   */
  function prepare(
    surfaces: Record<string, unknown>[],
    optionalPath: string,
    bodyAfterMarking: Record<string, string>,
  ): { surfaces: Record<string, unknown>[] } {
    const result = { surfaces };
    for (const surface of surfaces) {
      if (surface["path"] !== optionalPath) surface["code"] = "--semantic-frontier";
    }
    annotateSemanticFrontierContinuation(result as never, "--semantic-frontier flag", true);
    // Marking is a one-time WeakSet add; restoring the real bodies afterward
    // is what makes the FLOOR (not the classifier) the thing under test.
    for (const surface of surfaces) {
      const relPath = surface["path"] as string;
      if (bodyAfterMarking[relPath] !== undefined) {
        delete surface["code"];
        delete surface["code_unchanged"];
        Object.assign(surface, JSON.parse(bodyAfterMarking[relPath]!) as Record<string, unknown>);
      }
    }
    attachSfPackContext(result as never, {
      snapshot: {
        active: true,
        taskRef: "t-floor",
        lane: "default",
        key: "k-floor",
        stateVersion: 1,
        stateHash: "sha256:floor",
        concerns: [],
        satisfied: [],
        evidenceCount: 0,
        requiredAddresses: [],
        forceServe: false,
        epochFresh: true,
        openNonAdvisory: [],
        allNonAdvisoryClosed: true,
        ledgerWired: true,
      } as never,
      concerns: [],
      satisfaction: { satisfied: [], proofs: {}, untouched: [], alreadySatisfied: [], openVerify: [] } as never,
      observationOnly: false,
    });
    attachSfDemotionResidency(result, { workspaceRoot: "/ws-floor", ledger: ledgerOver([]) } as never);
    applyCanonicalTaskDecision(result as never);
    return result;
  }

  it("never withholds the last FRESH body, however many `code_unchanged` restatements ride along", () => {
    withEnv({ TL_SF_STATEFUL: "1", TL_SF_DEMOTE: "1", TL_SF_STRUCTURAL_CONCERNS: "1" }, () => {
      // Index 0 is force-primary by `semanticPrimary`, so the surface under
      // test sits at index 1. Its neighbours are RESTATEMENTS: the response
      // sends no new bytes for them, so they cannot stand in as survivors.
      const result = prepare(
        [
          mkSurface("src/restated-a.ts"),
          mkSurface("src/only-fresh.ts"),
          mkSurface("src/restated-b.ts"),
        ],
        "src/only-fresh.ts",
        {
          "src/restated-a.ts": JSON.stringify({ code_unchanged: "already held A" }),
          "src/only-fresh.ts": JSON.stringify({ code: "THE ONLY FRESH BODY" }),
          "src/restated-b.ts": JSON.stringify({ code_unchanged: "already held B" }),
        },
      );

      // Pre-fix `bodied` counted `code_unchanged` too, so `survivors` read 3
      // and the ONE body this response would actually have sent was withheld
      // — a response serving no new bytes at all.
      const demoted = applySemanticFrontierDemotion(result as never);
      expect(demoted, "the last fresh body must survive the floor").toBe(0);
      expect(result.surfaces[1]!["code"]).toBe("THE ONLY FRESH BODY");
    });
  });

  it("counter-example: with a SECOND fresh body present, the supporting one is withheld", () => {
    withEnv({ TL_SF_STATEFUL: "1", TL_SF_DEMOTE: "1", TL_SF_STRUCTURAL_CONCERNS: "1" }, () => {
      const result = prepare(
        [
          mkSurface("src/primary.ts"),
          mkSurface("src/supporting.ts"),
          mkSurface("src/restated.ts"),
        ],
        "src/supporting.ts",
        {
          "src/primary.ts": JSON.stringify({ code: "PRIMARY FRESH BODY" }),
          "src/supporting.ts": JSON.stringify({ code: "SUPPORTING FRESH BODY" }),
          "src/restated.ts": JSON.stringify({ code_unchanged: "already held" }),
        },
      );

      const demoted = applySemanticFrontierDemotion(result as never);
      expect(demoted, "a second fresh body means the floor is not binding").toBe(1);
      expect(result.surfaces[1]!["code"]).toBeUndefined();
      expect(result.surfaces[1]!["content_completeness"]).toBe("partial");
      expect(result.surfaces[1]!["remaining_ranges"]).toEqual(["1-50"]);
      expect(result.surfaces[0]!["code"]).toBe("PRIMARY FRESH BODY");
    });
  });
});
