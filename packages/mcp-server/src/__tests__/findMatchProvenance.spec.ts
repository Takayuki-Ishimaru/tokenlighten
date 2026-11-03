import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeSmallTaskWorkspace, startSmallTaskServer, type SmallTaskServer } from "./helpers/smallTaskServer.js";
import { rmDirWithRetry } from "./helpers/rmDirWithRetry.js";

describe("find match provenance", () => {
  let server: SmallTaskServer;
  let workspace: string;
  beforeAll(async () => {
    workspace = makeSmallTaskWorkspace("tl-find-match-", {
      "sample.ts": "export function first() {\n  return 'first_marker';\n}\n\nexport function second() {\n  return 'second_marker';\n}\n",
      "fresh.ts": "export function fresh() { return 'second_marker'; }\n",
    });
    server = await startSmallTaskServer(workspace, { env: { TL_BACKGROUND_INDEX: "off" } });
  }, 90000);
  afterAll(async () => { await server?.kill(); if (workspace) await rmDirWithRetry(workspace); });

  function rows(body: Record<string, unknown>): Array<Record<string, unknown>> {
    return (body.matches as Record<string, unknown>).files as Array<Record<string, unknown>>;
  }

  it("marks matched-line coverage even in a mix of previously served and fresh files", async () => {
    await server.call("tl_read_file", { cwd: workspace, targets: [{ path: "sample.ts", range: "1-3" }] });
    const reply = await server.call("tl_search_files", { cwd: workspace, action: "find", query: "second_marker" });
    expect(reply.isError, reply.text).toBe(false);
    const row = rows(reply.body).find((item) => item.path === "sample.ts")!;
    expect(row).toBeDefined();
    expect(row.served_this_session).not.toBe(true);
    expect(row.lines_held).toBe(false);
    expect(row.matched_lines_outside_served).toBe(1);
    expect(row.role === undefined || String(row.role).includes("second")).toBe(true);
    expect(String(row.role ?? "")).not.toContain("first");
    // File-level descriptions are labelled separately from match ownership.
    expect(row.file_role === undefined || String(row.file_role).includes("first")).toBe(true);
    expect((reply.body.matches as Record<string, unknown>).all_served).not.toBe(true);
  });

  it("does not claim a single enclosing function for hits in multiple functions", async () => {
    const reply = await server.call("tl_search_files", { cwd: workspace, action: "find", path: "sample.ts", query: "_marker" });
    expect(reply.isError, reply.text).toBe(false);
    const row = rows(reply.body)[0]!;
    expect(row.role).toBeUndefined();
    expect(row.served_this_session).not.toBe(true);
  });

  it("never escalates an undisclosed-hit set as fully held", async () => {
    const reply = await server.call("tl_search_files", { cwd: workspace, action: "find", scope: { path: "sample.ts" }, query: "return", budget: { items: 1 } });
    expect(reply.isError, reply.text).toBe(false);
    expect((reply.body.matches as Record<string, unknown>).all_served).not.toBe(true);
  });
});
