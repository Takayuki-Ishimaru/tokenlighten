/**
 * evaluation0929.resumeReplan.spec.ts — WP-E (eval-0929.md §7 bullet 2 / §8
 * row 5): resuming a completed answer task after an external file change.
 *
 * FINDING (confirmed live against the published v0.14.4 baseline,
 * `~/.cache/tokenlighten-ab/final-0929/node_modules/@tokenlighten/mcp-server/dist/bin.js`,
 * via an ad hoc probe before this fix): a value+condition+callers question
 * ("Explain the default HTTP_TIMEOUT_MS value, the shouldRetry conditions,
 * and the callers of fetchWithRetry.") reaches `act.answer`. Resuming the
 * SAME task via `task.handle` (or a bare `qref`, or a lane-scoped handle)
 * after editing the constant's own file on disk reaches `act.answer` again,
 * but now certifies ALL THREE facets
 * "explicit-gap:request-item-undetermined:<facet>:... (the evidence closure
 * for this clause was not computed for this request in this session)" —
 * even on hops where the changed bytes already happen to be on the wire via
 * unrelated machinery.
 *
 * ROOT CAUSE: readCodeTaskPack.ts's two facet-closure hooks
 * (`buildAnswerTaskPack`'s FIX-C1 hook ~5894, `buildSeededTaskPack`'s FIX-G
 * hook ~11411) both skipped UNCONDITIONALLY whenever
 * `args.taskQueryRefReplay === true` (C2: a replay is a call over a working
 * set the caller already holds, so a context-only addition must not
 * re-derive coverage). That C2 rationale holds only while the plan the hook
 * recorded is still valid. Once a file the plan depends on changes,
 * facetGate.ts's own `facetPlanFor` (keyed by fileShas) reports the plan
 * invalidated — or, for a query that never got a plan at all, missing — and
 * the completion gate (`buildFacetReadiness` -> `evaluateFacetRequirement`)
 * then has no plan entry to judge ANY of the query's facets against: its
 * `entry === undefined` branch fires for every one of them, regardless of
 * what unrelated machinery happened to put on the wire.
 *
 * FIX: both hooks now ALSO run — in the SAME serving mode a first pack uses
 * — on a replay whose plan is missing or invalidated by a changed file.
 * A replay whose plan is still valid (no named file changed) takes neither
 * branch and stays byte-identical to before this fix (the recall controls
 * below).
 *
 * Fixture: `evaluation0927Scenarios.ts`'s `buildHttpCorpusWorkspace` +
 * `V01_QUERY_EN` — the SAME corpus/query the eval-0927 acceptance suite
 * already certifies reaches `act.answer` with every V01 fact served, so
 * nothing fixture-specific is invented here (generalizes across the facet
 * kinds value/condition/callers; the mechanism itself is language-agnostic
 * line arithmetic — see facetGate.ts's own header).
 */
import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { shortTmpDir } from "./helpers/shortTmpDir.js";
import { rmDirWithRetry } from "./helpers/rmDirWithRetry.js";
import { startDevServer, type ServerHandle } from "./helpers/qualityFirstScenarios.js";
import { buildHttpCorpusWorkspace, servedBodyItems, V01_QUERY_EN } from "./helpers/evaluation0927Scenarios.js";

const HOME = process.env["HOME"] ?? process.env["USERPROFILE"] ?? os.homedir();
const tmpDirs: string[] = [];
const servers: ServerHandle[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.kill();
  for (const dir of tmpDirs.splice(0)) {
    try {
      await rmDirWithRetry(dir);
    } catch {
      /* best-effort cleanup */
    }
  }
});

function pick(obj: unknown, keyPath: string): any {
  return keyPath.split(".").reduce((acc: any, key) => (acc == null ? undefined : acc[key]), obj);
}

function gapsOf(body: unknown): string[] {
  return pick(body, "decision.certificate.gaps") ?? [];
}

function hasNotComputedGap(body: unknown): boolean {
  return gapsOf(body).some((g) => g.includes("not computed"));
}

/** Real served bytes only (never a bare `path`, an echoed `query`, or a body-less `prior` claim). */
function servedText(body: unknown): string {
  return servedBodyItems(body).map((item) => item.text).join("\n");
}

function makeWorkspace(tag: string): string {
  const ws = fs.realpathSync(shortTmpDir(HOME, `.tl-e0929-resume-${tag}-`));
  tmpDirs.push(ws);
  buildHttpCorpusWorkspace(ws, "compact");
  return ws;
}

async function spawnedServer(ws: string): Promise<ServerHandle> {
  const server = startDevServer(ws, "default", { toolSurface: "full" });
  servers.push(server);
  await server.initialize();
  return server;
}

function editConfigTimeout(ws: string): void {
  const p = path.join(ws, "src/config.ts");
  fs.writeFileSync(p, fs.readFileSync(p, "utf8").replace("timeoutMs: 5000", "timeoutMs: 7231"));
}

// ---------------------------------------------------------------------------
// Primary repro (eval-0929 §7 bullet 2): task.handle resume, constant's own
// file changed.
// ---------------------------------------------------------------------------
describe("WP-E: resuming an answer task after its facet plan is invalidated re-plans instead of disclosing not-computed", () => {
  it("task.handle resume: unchanged reuse ships no new bytes; after an edit to the constant's file, the new value is served and no facet is undetermined", async () => {
    const ws = makeWorkspace("primary");
    const server = await spawnedServer(ws);

    const hop0 = await server.callTool("tl_read_file", { query: V01_QUERY_EN, cwd: ws, task: { epoch: "new", profile: "answer" } });
    expect(pick(hop0.body, "decision.kind"), `hop0 did not settle: ${JSON.stringify(hop0.body)}`).toBe("act.answer");
    expect(servedText(hop0.body)).toContain("timeoutMs: 5000");
    const taskId = pick(hop0.body, "task.id");
    expect(typeof taskId, `hop0 carried no task.id: ${JSON.stringify(hop0.body)}`).toBe("string");

    // Recall control (eval-0929 §3): a same-epoch reuse with NOTHING changed
    // ships no new bytes at all -- asserted BEFORE the edit below, so this
    // test also proves the fix does not spuriously re-serve when the plan is
    // still valid.
    const hop1 = await server.callTool("tl_read_file", { task: { handle: taskId }, cwd: ws });
    expect(pick(hop1.body, "decision.kind")).toBe("act.answer");
    expect(servedBodyItems(hop1.body), `unchanged resume shipped new bytes: ${JSON.stringify(hop1.body.evidence)}`).toEqual([]);
    expect(hasNotComputedGap(hop1.body)).toBe(false);

    // External edit: the constant's OWN file changes underneath the task.
    editConfigTimeout(ws);

    const hop2 = await server.callTool("tl_read_file", { task: { handle: taskId }, cwd: ws });
    expect(hasNotComputedGap(hop2.body), `still disclosed not-computed after the file changed: ${JSON.stringify(gapsOf(hop2.body))}`).toBe(false);
    expect(servedText(hop2.body), `stale 5000 certified as current: ${JSON.stringify(hop2.body.evidence)}`).not.toContain("timeoutMs: 5000");

    let finalBody = hop2.body;
    if (pick(hop2.body, "decision.kind") !== "act.answer") {
      const next = pick(hop2.body, "decision.next_call") ?? pick(hop2.body, "decision.next") ?? hop2.body.next;
      expect(next?.tool, `no next to continue an unfinished resume: ${JSON.stringify(hop2.body)}`).toBeDefined();
      finalBody = (await server.callTool(next.tool, next.arguments)).body;
      expect(hasNotComputedGap(finalBody), `follow-up hop still not-computed: ${JSON.stringify(gapsOf(finalBody))}`).toBe(false);
    }
    const allText = servedText(hop0.body) + servedText(hop1.body) + servedText(hop2.body) + servedText(finalBody);
    expect(allText, `7231 never reached the caller: ${JSON.stringify({ hop2: hop2.body, finalBody })}`).toContain("timeoutMs: 7231");
  }, 90_000);

  it("bare {qref} re-pack (no task.handle) after the same edit also re-plans", async () => {
    const ws = makeWorkspace("qref");
    const server = await spawnedServer(ws);

    const hop0 = await server.callTool("tl_read_file", { query: V01_QUERY_EN, cwd: ws, task: { epoch: "new", profile: "answer" } });
    const qref = hop0.body?.qref;
    expect(typeof qref, `hop0 carried no qref: ${JSON.stringify(hop0.body)}`).toBe("string");

    editConfigTimeout(ws);

    const hop1 = await server.callTool("tl_read_file", { qref, cwd: ws });
    expect(hasNotComputedGap(hop1.body), `qref replay still not-computed: ${JSON.stringify(gapsOf(hop1.body))}`).toBe(false);
    expect(JSON.stringify(hop1.body)).toContain("7231");
  }, 60_000);

  it("a lane-scoped resume after the same edit also re-plans, and a different lane cannot resume this task at all", async () => {
    const ws = makeWorkspace("lane");
    const server = await spawnedServer(ws);

    const hop0 = await server.callTool("tl_read_file", {
      query: V01_QUERY_EN,
      cwd: ws,
      lane: "wp-e",
      task: { epoch: "new", profile: "answer" },
    });
    const taskId = pick(hop0.body, "task.id");
    expect(typeof taskId, `hop0 carried no task.id: ${JSON.stringify(hop0.body)}`).toBe("string");

    editConfigTimeout(ws);

    const hop1 = await server.callTool("tl_read_file", { task: { handle: taskId }, cwd: ws, lane: "wp-e" });
    expect(hasNotComputedGap(hop1.body), `lane-scoped resume still not-computed: ${JSON.stringify(gapsOf(hop1.body))}`).toBe(false);
    expect(JSON.stringify(hop1.body)).toContain("7231");

    // Isolation sanity: a DIFFERENT lane never resumes this lane's task.
    const otherLane = await server.callTool("tl_read_file", { task: { handle: taskId }, cwd: ws, lane: "wp-e-other" });
    expect(otherLane.body?.kind).toBe("refusal");
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Recall control (hard rule 10): an UNRELATED file change must never trigger
// re-planning or new bytes — isolates the effect of "a file the plan names
// changed" from ordinary hop-to-hop reshaping by comparing the SAME hop
// transition with and without the unrelated edit.
// ---------------------------------------------------------------------------
describe("WP-E recall control: an unrelated file change never triggers a facet replan", () => {
  it("editing README.md between the first pack and a resume ships no new bytes, same as no edit at all", async () => {
    const wsEdited = makeWorkspace("recall-edited");
    const wsPlain = makeWorkspace("recall-plain");
    const serverEdited = await spawnedServer(wsEdited);
    const serverPlain = await spawnedServer(wsPlain);

    const hop0Edited = await serverEdited.callTool("tl_read_file", { query: V01_QUERY_EN, cwd: wsEdited, task: { epoch: "new", profile: "answer" } });
    const hop0Plain = await serverPlain.callTool("tl_read_file", { query: V01_QUERY_EN, cwd: wsPlain, task: { epoch: "new", profile: "answer" } });
    const taskIdEdited = pick(hop0Edited.body, "task.id");
    const taskIdPlain = pick(hop0Plain.body, "task.id");
    expect(typeof taskIdEdited).toBe("string");
    expect(typeof taskIdPlain).toBe("string");

    fs.appendFileSync(path.join(wsEdited, "README.md"), "\nAn unrelated documentation change.\n");

    const hop1Edited = await serverEdited.callTool("tl_read_file", { task: { handle: taskIdEdited }, cwd: wsEdited });
    const hop1Plain = await serverPlain.callTool("tl_read_file", { task: { handle: taskIdPlain }, cwd: wsPlain });

    expect(pick(hop1Edited.body, "decision.kind")).toBe(pick(hop1Plain.body, "decision.kind"));
    expect(servedBodyItems(hop1Edited.body), `unrelated file change shipped new bytes: ${JSON.stringify(hop1Edited.body.evidence)}`).toEqual([]);
    expect(servedBodyItems(hop1Plain.body)).toEqual([]);
    expect(hasNotComputedGap(hop1Edited.body)).toBe(false);
  }, 90_000);
});

// ---------------------------------------------------------------------------
// Metamorphic variants (eval-0929 §7 bullet 2 / brief requirement 4): the
// same "file the plan depends on changed" behaviour for (b) a callee's file
// and (d) a caller file gaining a new call site. (a) is the primary repro
// above (the constant's own file); (c) is the recall control above.
// ---------------------------------------------------------------------------
describe("WP-E metamorphic: the same replan fires for the callee's file and for a newly added caller", () => {
  it("(b) the callee's file (retry.ts, shouldRetry's own condition constant) changing is served fresh, not disclosed undetermined", async () => {
    const ws = makeWorkspace("callee");
    const server = await spawnedServer(ws);

    const hop0 = await server.callTool("tl_read_file", { query: V01_QUERY_EN, cwd: ws, task: { epoch: "new", profile: "answer" } });
    const taskId = pick(hop0.body, "task.id");
    expect(typeof taskId).toBe("string");

    const retryPath = path.join(ws, "src/retry.ts");
    fs.writeFileSync(retryPath, fs.readFileSync(retryPath, "utf8").replace("new Set([429, 502, 503, 504])", "new Set([429, 502, 503, 504, 508])"));

    const hop1 = await server.callTool("tl_read_file", { task: { handle: taskId }, cwd: ws });
    expect(hasNotComputedGap(hop1.body), `callee-file change still not-computed: ${JSON.stringify(gapsOf(hop1.body))}`).toBe(false);
    expect(servedText(hop1.body)).toContain("429, 502, 503, 504, 508");
  }, 60_000);

  it("(d) a new caller added to an already-tracked caller file (orders.ts) is discovered on resume", async () => {
    const ws = makeWorkspace("newcaller");
    const server = await spawnedServer(ws);

    const hop0 = await server.callTool("tl_read_file", { query: V01_QUERY_EN, cwd: ws, task: { epoch: "new", profile: "answer" } });
    const taskId = pick(hop0.body, "task.id");
    expect(typeof taskId).toBe("string");
    // orders.ts is already one of this task's caller windows (V01_FACTS'
    // FACT_CALLER) -- its sha changing is the exact "missing or invalidated
    // by a file change" trigger, not a brand-new never-scanned file (see
    // this file's own header on why that distinct case is out of scope).
    fs.appendFileSync(
      path.join(ws, "src/api/orders.ts"),
      [
        "",
        "export async function cancelOrder(customerId: string, orderId: string): Promise<void> {",
        '  await fetchWithRetry("/api/customers/" + encodeURIComponent(customerId) + "/orders/" + encodeURIComponent(orderId) + "/cancel", { method: "POST" });',
        "}",
        "",
      ].join("\n"),
    );

    const hop1 = await server.callTool("tl_read_file", { task: { handle: taskId }, cwd: ws });
    expect(hasNotComputedGap(hop1.body), `new-caller change still not-computed: ${JSON.stringify(gapsOf(hop1.body))}`).toBe(false);
    expect(servedText(hop1.body)).toContain("cancelOrder");
  }, 60_000);
});

// ---------------------------------------------------------------------------
// The seeded-pack path (buildSeededTaskPack's FIX-G hook, Gate 2): a faceted
// question asked WITH explicit targets.
// ---------------------------------------------------------------------------
describe("WP-E seeded-pack path: an explicit-targets resume after the same edit also re-plans", () => {
  it("resume via task.handle after editing the constant's file reaches act.answer with the new value, never not-computed", async () => {
    const ws = makeWorkspace("seeded");
    const server = await spawnedServer(ws);

    const hop0 = await server.callTool("tl_read_file", {
      query: V01_QUERY_EN,
      targets: [{ path: "src/config.ts" }, { path: "src/retry.ts" }, { path: "src/httpClient.ts" }],
      cwd: ws,
      task: { epoch: "new", profile: "answer" },
    });
    const taskId = pick(hop0.body, "task.id");
    expect(typeof taskId, `seeded hop0 carried no task.id: ${JSON.stringify(hop0.body)}`).toBe("string");
    expect(hasNotComputedGap(hop0.body)).toBe(false);

    editConfigTimeout(ws);

    const hop1 = await server.callTool("tl_read_file", { task: { handle: taskId }, cwd: ws });
    expect(hasNotComputedGap(hop1.body), `seeded resume still not-computed: ${JSON.stringify(gapsOf(hop1.body))}`).toBe(false);

    let finalBody = hop1.body;
    if (pick(hop1.body, "decision.kind") !== "act.answer") {
      const next = pick(hop1.body, "decision.next_call") ?? pick(hop1.body, "decision.next") ?? hop1.body.next;
      expect(next?.tool, `seeded resume left open with no next: ${JSON.stringify(hop1.body)}`).toBeDefined();
      finalBody = (await server.callTool(next.tool, next.arguments)).body;
      expect(hasNotComputedGap(finalBody)).toBe(false);
    }
    expect(JSON.stringify(hop0.body) + JSON.stringify(hop1.body) + JSON.stringify(finalBody)).toContain("7231");
  }, 90_000);
});
