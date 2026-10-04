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
  it("value clause widens the focused function's file, then an identifier-free callers clause", async () => {
    const query = "How does the scheduler decide whether to requeue a job: what is the max job attempts constant's configured value, and who calls the requeue decision?";
    const ws = workspace({ "src/scheduler.ts": schedulerSource(), "src/worker.ts": WORKER });
    const server = startDevServer(ws, "default");
    servers.push(server);
    await server.initialize();
    const chain = await followNextToEnd(
      server,
      { tool: "tl_read_file", arguments: { query, cwd: ws, task: { epoch: "new", profile: "answer" } } },
      { cwd: ws, hopCap: 6 },
    );
    const servedText = JSON.stringify(chain.hops.map((s) => s.response));
    expect(finalDecisionKind(chain), servedText).toBe("act.answer");
    // The real caller is served as the callers facet's evidence ...
    expect(servedText, servedText).toMatch(/closure:callers shouldRequeueJob/u);
    expect(servedText, servedText).toContain("shouldRequeueJob(job, attempts) ?");
    // ... and no "0 call sites" is certified for an arbitrary declaration.
    expect(servedText, servedText).not.toMatch(/request-item-empty:callers:formatJobLabel/u);
    expect(servedText, servedText).not.toMatch(/request-item-empty:callers/u);
    // The value clause still binds the constant (WP-C4 unchanged).
    expect(servedText, servedText).toContain("MAX_JOB_ATTEMPTS = 7");
  }, 90_000);
});
