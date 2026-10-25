/**
 * batchCreateAdmissible.rc.spec.ts — a file an edits[] batch creates can be
 * edited next under the same task (v016 decision 6t-4, 2026-10-19).
 *
 * Recorded (arm A, T05c rep1): under the act.edit task of the first pack, #34
 * created three verification harnesses in one edits[] batch
 * (`{path, create:true, content}` items, explicit cwd) and #36 edited two of
 * them by path under the same task. #36 was refused `execution-typestate`,
 * "edit target is outside certificate frontier paths=<the two files>", and its
 * `next` was a `tl_read_file` with `task:{epoch:"new"}`: a 9.4 KB pack and a
 * new task, under which the same edit then applied.
 *
 * W1 (2026-08-07) enrolls a created file in the epoch's admissible union, but
 * only on the single-create arm (a one-item batch unwraps to it); a batch's
 * create items went through applyEditsMulti and were never enrolled. They now
 * are, once the batch landed, so #36 applies under the task it was sent with.
 * A batch that is refused (a create on an existing file) writes nothing and
 * enrolls nothing.
 *
 * The replay corpus group `v016ts` holds the recorded calls.
 */

import { afterAll, afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { shortTmpDir } from "../helpers/shortTmpDir.js";
import { rmDirWithRetry } from "../helpers/rmDirWithRetry.js";
import { startDevServer, type ServerHandle } from "../helpers/qualityFirstScenarios.js";

const HOME = process.env["HOME"] ?? process.env["USERPROFILE"] ?? os.homedir();

type Body = Record<string, unknown>;

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

const ENGINE = "src/rating_engine.py";
/** An existing file the change request never names, so no pack serves it. */
const OTHER = "src/timeouts.py";
const QUERY = "change RATE_FACTOR from 0.10 to 0.15 in src/rating_engine.py and add regression harnesses for it";

function workspace(tag: string): string {
  const ws = fs.realpathSync(shortTmpDir(HOME, `.tl-bca-${tag}-`));
  tmpDirs.push(ws);
  const write = (rel: string, content: string): void => {
    fs.mkdirSync(path.dirname(path.join(ws, rel)), { recursive: true });
    fs.writeFileSync(path.join(ws, rel), content);
  };
  write(ENGINE, "RATE_FACTOR = 0.10\n\n\ndef rate(amount: float) -> float:\n    return amount * RATE_FACTOR\n");
  write(OTHER, "TIMEOUT_SECONDS = 30\n");
  return ws;
}

const harness = (name: string): string => `# Scratch verification harness (not part of the deliverable).\nimport sys\nsys.path.insert(0, "src")\nfrom rating_engine import rate\n\nassert rate(100) > 0, "${name}"\nprint("pass")\n`;

const CREATED = [".tl-bench-scratch/test_rate.py", ".tl-bench-scratch/test_rate_zero.py", ".tl-bench-scratch/test_rate_large.py"];

/** One server with the act.edit task of the change request, and that task's handle in the JSON-string form #34 and #36 sent. */
async function armed(tag: string): Promise<{ ws: string; server: ServerHandle; task: string; taskId: string }> {
  const ws = workspace(tag);
  const server = startDevServer(ws, "default", { allowWrite: true });
  servers.push(server);
  await server.initialize();
  const pack = (await server.callTool("tl_read_file", { query: QUERY, targets: [{ path: ENGINE }], task: { epoch: "new", profile: "generic" }, cwd: ws })).body as Body;
  expect((pack["decision"] as Body | undefined)?.["kind"], JSON.stringify(pack).slice(0, 600)).toBe("act.edit");
  const taskId = (pack["task"] as Body | undefined)?.["id"];
  expect(typeof taskId).toBe("string");
  return { ws, server, task: JSON.stringify({ handle: taskId, profile: "generic" }), taskId: taskId as string };
}

async function call(server: ServerHandle, tool: string, args: Body): Promise<Body> {
  return (await server.callTool(tool, args)).body as Body;
}

const read = (ws: string, rel: string): string => fs.readFileSync(path.join(ws, rel), "utf8");

describe("files an edits[] batch created are editable under the same task", () => {
  it("the recorded shape: a three-file create batch, then a two-file edit of what it created, applies with no new task", async () => {
    const { ws, server, task } = await armed("recorded");
    fs.mkdirSync(path.join(ws, ".tl-bench-scratch"), { recursive: true });
    const created = await call(server, "tl_edit_file", {
      cwd: ws,
      task,
      edits: CREATED.map((rel) => ({ path: rel, create: true, content: harness(rel) })),
    });
    expect(created["kind"], JSON.stringify(created).slice(0, 600)).toBe("edit.applied");
    const edits = CREATED.slice(0, 2).map((rel) => ({
      path: rel,
      search: "import sys\nsys.path.insert(0, \"src\")\n",
      replace: "import os\nimport sys\nsys.path.insert(0, os.path.join(os.path.dirname(__file__), \"..\", \"src\"))\n",
    }));
    const edited = await call(server, "tl_edit_file", { cwd: ws, task, edits });
    expect(edited["kind"], JSON.stringify(edited).slice(0, 900)).toBe("edit.applied");
    expect((edited["core"] as Body | undefined)?.["paths"]).toEqual(CREATED.slice(0, 2));
    expect(edited["task"], "an edit mints no task").toBeUndefined();
    for (const rel of CREATED.slice(0, 2)) expect(read(ws, rel)).toContain("os.path.dirname(__file__)");
    expect(read(ws, CREATED[2]!)).toBe(harness(CREATED[2]!));
  }, 120_000);

  it("an edit by the handle a created file's applied row carries applies too", async () => {
    const { ws, server, task } = await armed("handle");
    const created = await call(server, "tl_edit_file", {
      cwd: ws,
      task,
      edits: CREATED.slice(0, 2).map((rel) => ({ path: rel, create: true, content: harness(rel) })),
    });
    expect(created["kind"], JSON.stringify(created).slice(0, 600)).toBe("edit.applied");
    const row = (created["applied"] as Body[]).find((entry) => entry["path"] === CREATED[1]);
    expect(typeof row?.["handle"], JSON.stringify(created).slice(0, 600)).toBe("string");
    const edited = await call(server, "tl_edit_file", {
      cwd: ws,
      task,
      edits: [{ handle: row!["handle"], search: "print(\"pass\")\n", replace: "print(\"ok\")\n", precondition: "unique-match", allowPathFallback: false }],
    });
    expect(edited["kind"], JSON.stringify(edited).slice(0, 900)).toBe("edit.applied");
    expect(read(ws, CREATED[1]!)).toContain("print(\"ok\")");
  }, 120_000);

  it("control: a batch whose create names an existing file writes nothing and leaves that file fenced", async () => {
    const { ws, server, task } = await armed("exists");
    const refused = await call(server, "tl_edit_file", {
      cwd: ws,
      task,
      edits: [{ path: CREATED[0], create: true, content: harness(CREATED[0]!) }, { path: OTHER, create: true, content: "TIMEOUT_SECONDS = 60\n" }],
    });
    expect(refused["kind"], JSON.stringify(refused).slice(0, 600)).toBe("refusal");
    expect(fs.existsSync(path.join(ws, CREATED[0]!)), "all-or-nothing: the new file is not written").toBe(false);
    expect(read(ws, OTHER)).toBe("TIMEOUT_SECONDS = 30\n");
    const edit = await call(server, "tl_edit_file", { cwd: ws, task, edits: [{ path: OTHER, search: "TIMEOUT_SECONDS = 30", replace: "TIMEOUT_SECONDS = 60" }] });
    expect(edit["kind"], JSON.stringify(edit).slice(0, 600)).toBe("refusal");
    expect(edit["code"]).toBe("execution-typestate");
    expect(String(edit["detail"] ?? "")).toContain(`paths=${OTHER}`);
    expect(read(ws, OTHER)).toBe("TIMEOUT_SECONDS = 30\n");
  }, 120_000);

  it("control: the one-item create (the single-create arm, W1) already admitted the follow-up edit", async () => {
    const { ws, server, task } = await armed("single");
    const created = await call(server, "tl_edit_file", { cwd: ws, task, edits: [{ path: CREATED[0], create: true, content: harness(CREATED[0]!) }] });
    expect(created["kind"], JSON.stringify(created).slice(0, 600)).toBe("edit.applied");
    const edited = await call(server, "tl_edit_file", { cwd: ws, task, edits: [{ path: CREATED[0], search: "print(\"pass\")\n", replace: "print(\"ok\")\n" }] });
    expect(edited["kind"], JSON.stringify(edited).slice(0, 900)).toBe("edit.applied");
  }, 120_000);
});
