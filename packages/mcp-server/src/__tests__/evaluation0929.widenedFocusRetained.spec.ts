/**
 * evaluation0929.widenedFocusRetained.spec.ts — integration fix of the
 * eval-0929 wave (orchestrator; found through the replayCorpus "focus
 * retained" case).
 *
 * FIX-C1's `tryAddWindow` widens an already-selected candidate in place when
 * a facet's required window falls in the same file (a value clause's
 * constant beside the function the pack focused on) and clears its
 * `.symbol`, so serving does not snap back to the symbol's narrower span. A
 * LATER requirement of the same closure pass whose clause names no
 * identifier (a callers clause "who calls the requeue decision") then saw no
 * focus at all, and `bestConceptAnchoredInFile` fell back to the file's
 * FIRST callable: v0.14.4 certified `request-item-empty:callers:
 * formatJobLabel0 (0 call sites)` while the function the question is about
 * has a real caller. The pass now remembers the focus a widened candidate
 * had (readCodeTaskPack.ts `widenedCandidateFocus`).
 */
import { afterAll, afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { shortTmpDir } from "./helpers/shortTmpDir.js";
import { rmDirWithRetry } from "./helpers/rmDirWithRetry.js";
import { startDevServer, followNextToEnd, finalDecisionKind, type ServerHandle } from "./helpers/qualityFirstScenarios.js";

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

function workspace(files: Record<string, string>): string {
  const ws = fs.realpathSync(shortTmpDir(HOME, ".tl-e0929-widen-"));
  tmpDirs.push(ws);
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(ws, rel)), { recursive: true });
    fs.writeFileSync(path.join(ws, rel), content, "utf8");
  }
  return ws;
}

/** 60 unrelated callables first, then the constant and the function the question is about. */
function schedulerSource(): string {
  const padding = Array.from({ length: 60 }, (_, i) => [
    `export function formatJobLabel${i}(job: Job): string {`,
    `  return "job-${i}:" + job.id;`,
    "}",
    "",
  ]).flat();
  return [
    "export interface Job { id: string; retryable: boolean }",
    "",
    ...padding,
    "export const MAX_JOB_ATTEMPTS = 7;",
    "export function shouldRequeueJob(job: Job, attempts: number): boolean {",
    "  if (!job.retryable) return false;",
    "  return attempts < MAX_JOB_ATTEMPTS;",
    "}",
    "",
  ].join("\n");
}

const WORKER = [
  "import { shouldRequeueJob, type Job } from \"./scheduler.js\";",
  "export function finishAttempt(job: Job, attempts: number): string {",
  "  return shouldRequeueJob(job, attempts) ? \"requeued\" : \"dropped\";",
  "}",
  "",
].join("\n");

describe("a callers clause after a same-file widening keeps the pack's focus (never the file's first callable)", () => {
  it("keeps the caller-selected range's callable after value widening", async () => {
    const query = "How does the scheduler decide whether to requeue a job: what is the max job attempts constant's configured value, and who calls the requeue decision?";
    const ws = workspace({ "src/scheduler.ts": schedulerSource(), "src/worker.ts": WORKER });
    const server = startDevServer(ws, "default");
    servers.push(server);
    await server.initialize();
    const first = await server.callTool("tl_read_file", { query, cwd: ws, task: { epoch: "new", profile: "answer" } });
    expect(first.body.kind).toBe("read.task_pack");
    expect(first.body.evidence).toEqual([]);
    expect(first.body.decision.kind).toBe("await_input");
    expect(first.body.decision.next).toBeUndefined();
    const task = first.body.task.id;
    expect(typeof task).toBe("string");
    const chain = await followNextToEnd(server, {
      tool: "tl_read_file", arguments: { query, cwd: ws, task: { handle: task }, targets: [{ path: "src/scheduler.ts", range: "243-248" }] },
    }, { cwd: ws, hopCap: 6 });
    const servedText = JSON.stringify(chain.hops.map((s) => s.response));
    expect(finalDecisionKind(chain), servedText).toBe("act.answer");
    expect(servedText).toContain("shouldRequeueJob(job, attempts) ?");
    expect(servedText).toContain("request-item:facet-2:callers");
    expect(servedText).toContain("MAX_JOB_ATTEMPTS = 7");
    expect(servedText).not.toMatch(/request-item-empty:callers/u);
  }, 90_000);

  it.each([
    ["a constant with no callable", "243-243"],
    ["two unrelated callables", "3-9"],
  ])("never chooses an arbitrary function from %s", async (_label, range) => {
    const query = "How does the scheduler decide whether to requeue a job: what is the max job attempts constant's configured value, and who calls the requeue decision?";
    const ws = workspace({ "src/scheduler.ts": schedulerSource(), "src/worker.ts": WORKER });
    const server = startDevServer(ws, "default");
    servers.push(server);
    await server.initialize();
    const first = await server.callTool("tl_read_file", { query, cwd: ws, task: { epoch: "new", profile: "answer" } });
    expect(first.body.kind).toBe("read.task_pack");
    expect(first.body.evidence).toEqual([]);
    expect(first.body.decision.kind).toBe("await_input");
    expect(first.body.decision.next).toBeUndefined();
    expect(typeof first.body.task.id).toBe("string");
    const chain = await followNextToEnd(server, {
      tool: "tl_read_file", arguments: { query, cwd: ws, task: { handle: first.body.task.id }, targets: [{ path: "src/scheduler.ts", range }] },
    }, { cwd: ws, hopCap: 6 });
    const text = JSON.stringify(chain.hops.map((s) => s.response));
    // Neither decoy is a supported answer to the request, regardless of
    // whether the planner finds a real focus or leaves the callers gap open.
    expect(text).not.toMatch(/request-item-empty:callers:formatJobLabel/u);
    expect(text).not.toMatch(/closure:callers formatJobLabel/u);
  }, 90_000);

  it("value clause widens the focused function's file, then an identifier-free callers clause", async () => {
    const query = "How does the scheduler decide whether to requeue a job: what is the max job attempts constant's configured value, and who calls the requeue decision?";
    const ws = workspace({ "src/scheduler.ts": schedulerSource(), "src/worker.ts": WORKER });
    const server = startDevServer(ws, "default");
    servers.push(server);
    await server.initialize();
    const first = await server.callTool("tl_read_file", { query, cwd: ws, task: { epoch: "new", profile: "answer" } });
    expect(first.body.evidence).toEqual([]);
    expect(first.body.decision.kind).toBe("await_input");
    const chain = await followNextToEnd(
      server,
      { tool: "tl_read_file", arguments: { query, cwd: ws, task: { handle: first.body.task.id }, targets: [{ path: "src/scheduler.ts", range: "244-247" }] } },
      { cwd: ws, hopCap: 6 },
    );
    const servedText = JSON.stringify(chain.hops.map((s) => s.response));
    expect(finalDecisionKind(chain), servedText).toBe("act.answer");
    // The real caller's executable body and the callers obligation are held;
    // optional wire `why` labels are not needed to establish that identity.
    expect(servedText).toContain("request-item:facet-2:callers");
    expect(servedText, servedText).toContain("shouldRequeueJob(job, attempts) ?");
    // ... and no "0 call sites" is certified for an arbitrary declaration.
    expect(servedText, servedText).not.toMatch(/request-item-empty:callers:formatJobLabel/u);
    expect(servedText, servedText).not.toMatch(/request-item-empty:callers/u);
    // The value clause still binds the constant (WP-C4 unchanged).
    expect(servedText, servedText).toContain("MAX_JOB_ATTEMPTS = 7");
  }, 90_000);

  it("keeps the selected method when another class declares the same name", async () => {
    const query = "How does the scheduler decide whether to retry: what is the retry limit constant's configured value, and who calls the retry decision?";
    const ws = workspace({
      "src/scheduler.ts": [
        "export const RETRY_LIMIT = 7;",
        "export class Alpha {",
        "  retry(attempts: number): boolean { return false; }",
        "}",
        "export class Beta {",
        "  retry(attempts: number): boolean {",
        "    return attempts < RETRY_LIMIT;",
        "  }",
        "}", "",
      ].join("\n"),
      "src/worker.ts": [
        'import { Beta } from "./scheduler.js";',
        "export function finishAttempt(attempts: number): boolean {",
        "  const scheduler = new Beta();",
        "  return scheduler.retry(attempts);",
        "}", "",
      ].join("\n"),
    });
    const server = startDevServer(ws, "default");
    servers.push(server);
    await server.initialize();
    const first = await server.callTool("tl_read_file", { query, cwd: ws, task: { epoch: "new", profile: "answer" } });
    expect(first.body.decision.kind).toBe("await_input");
    expect(first.body.evidence).toEqual([]);
    const chain = await followNextToEnd(server, {
      tool: "tl_read_file", arguments: {
        query, cwd: ws, task: { handle: first.body.task.id },
        targets: [{ path: "src/scheduler.ts", range: "6-8" }],
      },
    }, { cwd: ws, hopCap: 6 });
    const text = JSON.stringify(chain.hops.map(hop => hop.response));
    expect(finalDecisionKind(chain), text).toBe("act.answer");
    // Alpha.retry has no caller. The selected Beta.retry has this executable
    // call: retaining only the bare name would falsely certify zero callers.
    expect(text).toContain("return scheduler.retry(attempts)");
    expect(text).not.toMatch(/request-item-empty:callers/u);
    expect(text).toContain("RETRY_LIMIT = 7");
  }, 90_000);

});
