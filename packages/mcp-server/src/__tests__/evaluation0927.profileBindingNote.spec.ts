/**
 * evaluation0927.profileBindingNote.spec.ts — the continuation note on
 * `profile_binding.reason` ("declared when this task was opened and kept for
 * this continuation — send task.profile to change it") as replays restate it
 * (orchestrator repro, 2026-09-28, round 4):
 *
 *   - a DECLARED answer task's qref replays after `act.answer` repeated the
 *     note twice ("…kept for this continuation — …; declared when … kept for
 *     this continuation — …"): the stored binding already carried it and the
 *     replay door appended it again;
 *   - an UNDECLARED task (`requested:"auto"`, inferred) got the note on its
 *     replays, claiming a declaration that never happened.
 *
 * The note appears at most once, and only on a binding that was declared.
 */
import { afterAll, afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { shortTmpDir } from "./helpers/shortTmpDir.js";
import { rmDirWithRetry } from "./helpers/rmDirWithRetry.js";
import { followNextToEnd, startDevServer, type ServerHandle } from "./helpers/qualityFirstScenarios.js";

const HOME = process.env["HOME"] ?? process.env["USERPROFILE"] ?? os.homedir();
const NOTE = "kept for this continuation";
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

function writeFile(ws: string, rel: string, content: string): void {
  const abs = path.join(ws, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
}

function workspace(callers = 3): string {
  const ws = fs.realpathSync(shortTmpDir(HOME, ".tl-pbnote-"));
  tmpDirs.push(ws);
  writeFile(ws, "src/retry.ts", [
    "export const BASE_DELAY_MS = 250;",
    "",
    "export function shouldRetry(status: number): boolean {",
    "  return status >= 500;",
    "}",
    "",
    "export function backoffDelay(attempt: number): number {",
    "  return BASE_DELAY_MS * 2 ** attempt;",
    "}",
    "",
  ].join("\n"));
  for (let i = 0; i < callers; i++) {
    writeFile(ws, `src/jobs/job${i}.ts`, `import { backoffDelay } from "../retry";\n\nexport function wait${i}(attempt: number): number {\n  return backoffDelay(attempt);\n}\n`);
  }
  return ws;
}

async function server(ws: string): Promise<ServerHandle> {
  const s = startDevServer(ws, "default");
  servers.push(s);
  await s.initialize();
  return s;
}

function noteCount(body: any): number {
  const reason: string = body?.profile_binding?.reason ?? "";
  return reason.split(NOTE).length - 1;
}

describe("profile_binding continuation note on qref replays", () => {
  it("a declared answer task: every replay after a multi-hop chain carries the note at most once", async () => {
    // 30 caller files page over several hops, so a continuation hop (whose
    // binding carries the note) is what the replays restate.
    const ws = workspace(30);
    const s = await server(ws);
    const chain = await followNextToEnd(
      s,
      { tool: "tl_read_file", arguments: { query: "Who calls backoffDelay?", task: { epoch: "new", profile: "answer" }, cwd: ws } },
      { cwd: ws, hopCap: 10 },
    );
    const qref: string = chain.hops[0]!.response?.qref;
    expect(typeof qref).toBe("string");
    expect(chain.hops.length).toBeGreaterThan(2);
    for (let i = 0; i < 3; i++) {
      const replay = (await s.callTool("tl_read_file", { qref, cwd: ws })).body;
      expect(noteCount(replay), JSON.stringify(replay?.profile_binding)).toBeLessThanOrEqual(1);
    }
    for (const hop of chain.hops) expect(noteCount(hop.response)).toBeLessThanOrEqual(1);
  });

  it("an undeclared task: replays never claim the profile was declared", async () => {
    const ws = workspace();
    const s = await server(ws);
    const first = (await s.callTool("tl_read_file", {
      query: "How does backoffDelay compute the delay between attempts?", task: { epoch: "new" }, cwd: ws,
    })).body;
    expect(first?.profile_binding?.requested ?? "auto").toBe("auto");
    const qref: string = first?.qref;
    expect(typeof qref).toBe("string");
    for (let i = 0; i < 2; i++) {
      const replay = (await s.callTool("tl_read_file", { qref, cwd: ws })).body;
      expect(noteCount(replay), JSON.stringify(replay?.profile_binding)).toBe(0);
    }
  });
});
