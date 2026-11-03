import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeSmallTaskWorkspace, startSmallTaskServer, type SmallTaskServer } from "./helpers/smallTaskServer.js";
import { rmDirWithRetry } from "./helpers/rmDirWithRetry.js";

describe("outline representation after task-bound source reads", () => {
  let server: SmallTaskServer;
  let workspace: string;
  beforeAll(async () => {
    workspace = makeSmallTaskWorkspace("tl-outline-partial-", {
      "sample.ts": Array.from({ length: 1000 }, (_, i) => `export function fn${i + 1}() { return ${i}; }`).join("\n") + "\n",
    });
    server = await startSmallTaskServer(workspace, { env: { TL_BACKGROUND_INDEX: "off", TL_LEGACY_INPUT: "accept" } });
  }, 90000);
  afterAll(async () => { await server?.kill(); if (workspace) await rmDirWithRetry(workspace); });

  it("returns signatures after a partial read, with no source-body continuation", async () => {
    const first = await server.call("tl_read_file", {
      cwd: workspace, lane: "outline", query: "Explain how function fn1 works in sample.ts",
      targets: [{ path: "sample.ts", range: "1-100" }], task: { epoch: "new" },
    });
    expect(first.isError).toBe(false);
    const task = (first.body.task as { id?: string })?.id;
    expect(task).toBeTruthy();
    await server.call("tl_read_file", { cwd: workspace, lane: "outline", targets: [{ path: "sample.ts", range: "1-100" }], task: { handle: task } });
    for (const request of [
      { targets: [{ path: "sample.ts" }], content: "outline" },
      { path: "sample.ts", mode: "skeleton" },
      { targets: [{ path: "sample.ts" }], content: "outline", task: { handle: task, force_serve: true } },
    ]) {
      const reply = await server.call("tl_read_file", { cwd: workspace, lane: "outline", task: { handle: task }, ...request });
      expect(reply.isError, reply.text).toBe(false);
      expect(reply.body.kind, reply.text).toBe("read.map");
      expect(reply.text).toContain("fn1");
      expect(reply.text).not.toContain('"code-unchanged"');
      expect(reply.text).not.toContain('"content":"auto"');
    }
  }, 90000);
});
