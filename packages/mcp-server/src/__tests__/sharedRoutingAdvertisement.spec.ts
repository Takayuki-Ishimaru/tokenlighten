import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleRequest, resetCapturedClientIdForTest } from "../server.js";
import { SERVER_INSTRUCTIONS } from "../protocol/serverInstructions.js";

beforeEach(() => {
  resetCapturedClientIdForTest();
  vi.stubEnv("TOKENLIGHTEN_CLIENT_ID", undefined);
});
afterEach(() => {
  resetCapturedClientIdForTest();
  vi.unstubAllEnvs();
});

describe("r12: shared metadata survives the initialize -> tools/list client route", () => {
  for (const name of ["codex", "codex_cli_rs", "claude-code", "Claude Code"]) {
    it(`${name}: advertises full-query discovery with three tools and read-only hints`, async () => {
      const init = await handleRequest({
        jsonrpc: "2.0", id: 1, method: "initialize",
        params: { clientInfo: { name, version: "1.0.0" } },
      });
      expect(init).toMatchObject({ result: { instructions: SERVER_INSTRUCTIONS } });
      const list = await handleRequest({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
      const tools = (list as { result: { tools: Array<{ name: string; description: string; annotations?: { readOnlyHint?: boolean } }> } }).result.tools;
      expect(tools.map(tool => tool.name).sort()).toEqual(["tl_edit_file", "tl_read_file", "tl_search_files"]);
      const read = tools.find(tool => tool.name === "tl_read_file")!;
      expect(read.description).toContain("FIRST source lookup/read");
      expect(read.description).toContain("entire request verbatim");
      expect(read.description).toContain("unknown paths: omit targets");
      expect(read.description.length).toBeLessThanOrEqual(120);
      expect(read.annotations?.readOnlyHint).toBe(true);
      expect(SERVER_INSTRUCTIONS).toContain("evidence[].body with its paths/lines; no re-read");
      expect(SERVER_INSTRUCTIONS).toContain("task.force_serve:true");
      expect(SERVER_INSTRUCTIONS).not.toContain("mcp__tokenlighten_");
    });
  }
});
