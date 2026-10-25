import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import Ajv, { type AnySchema } from "ajv";
import { advertisedTools, callTool, handleRequest, resetCapturedClientIdForTest } from "../server.js";
import { COPILOT_RETRY_FILES } from "./helpers/copilotCheckoutFixture.js";

const roots: string[] = [];
// The client-specific advertisements behind the portable default (§20.8).
beforeEach(() => { vi.stubEnv("TL_PORTABLE_TOOLS", "0"); vi.stubEnv("TL_TURN_ECONOMY", "0"); vi.stubEnv("TL_LEAN_CALLS", "1"); vi.stubEnv("TL_MINIMAL_TOOLS", "1"); });
afterEach(() => { vi.unstubAllEnvs(); resetCapturedClientIdForTest(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
function parse(result: { content: Array<{ text: string }> }) { return JSON.parse(result.content[0]!.text); }
describe("Copilot CLI opt-in minimal advertisement", () => {
  it("requires both existing gates, retains three tools and saves fixed bytes", () => {
    const lean = advertisedTools("copilot-cli");
    vi.stubEnv("TL_LEAN_CALLS", "0");
    const current = advertisedTools("copilot-cli");
    expect(lean.map(tool => tool.name)).toEqual(current.map(tool => tool.name));
    expect(lean).toHaveLength(3);
    expect(bytes(lean)).toBeLessThan(bytes(current) * 0.65);
    vi.stubEnv("TL_LEAN_CALLS", "1"); vi.stubEnv("TL_MINIMAL_TOOLS", "0");
    expect(advertisedTools("copilot-cli")).toEqual(current);
  });
  it("keeps other clients and returned schema trees isolated", () => {
    const names = [undefined, "Codex CLI", "claude-code", "copilot-cli-proxy", "GitHub Copilot"];
    const before = names.map(name => advertisedTools(name));
    vi.stubEnv("TL_LEAN_CALLS", "0");
    expect(names.map(name => advertisedTools(name))).toEqual(before);
    vi.stubEnv("TL_LEAN_CALLS", "1");
    const copy = advertisedTools("copilot-cli");
    (copy[0]!.inputSchema as { properties: Record<string, unknown> }).properties["query"] = { type: "number" };
    expect(advertisedTools("copilot-cli")).not.toEqual(copy);
  });
  it("allows complete canonical recovery calls through the compact host schema", () => {
    const ajv = new Ajv({ coerceTypes: true });
    const tools = advertisedTools("copilot-cli");
    const shapes: Array<[string, unknown]> = [
      ["tl_read_file", { cwd: "/work", lane: "a", query: "Explain retrySchedule()", task: { epoch: "new", profile: "answer" } }],
      ["tl_read_file", { cwd: "/work", task: { handle: "task", expected_state_version: 1, force_serve: true, pull: "closure" }, qref: "query", budget: { bytes: 7000 }, targets: [{ handle: "file", range: "1-3", purpose: "definition" }] }],
      ["tl_read_file", { cwd: "/work", cursor: "cursor", scope: { surfaceRoles: ["test"], includeClosure: true } }],
      ["tl_search_files", { cwd: "/work", lane: "a", action: "find", queries: ["retrySchedule"], scope: { path: "src", regex: false, lang: "typescript" }, task: { handle: "task" }, budget: { tokens: 1000 }, cursor: "cursor" }],
      ["tl_edit_file", { cwd: "/work", lane: "a", operation_id: "operation", task: { handle: "task" }, edits: [{ handle: "file", search: "old", replace: "new", precondition: "unique-match", allowPathFallback: false }] }],
    ];
    for (const [name, args] of shapes) {
      const validate = ajv.compile(tools.find(tool => tool.name === name)!.inputSchema as AnySchema);
      expect(validate(args), JSON.stringify(validate.errors)).toBe(true);
    }
  });
  it("serves the observed read-only CLI call and forced continuation; runtime rejects unknown fields", async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.homedir(), ".tl-cli-lean-"))); roots.push(root);
    for (const [rel, content] of Object.entries(COPILOT_RETRY_FILES)) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), content);
    }
    await handleRequest({ jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "copilot-cli", version: "1.0.96" } } });
    const listed = await handleRequest({ jsonrpc: "2.0", id: 2, method: "tools/list" }) as { result: { tools: unknown } };
    expect(listed.result.tools).toEqual(advertisedTools("copilot-cli"));
    const query = "What exact delay sequence does retrySchedule() return, and which constants and functions determine it? Use keys delays and sources. Include sources as an array of {path,startLine,endLine}; cite each function and constant needed for the result. Return only a JSON object. Do not modify files or run terminal commands.";
    const first = parse(await callTool("tl_read_file", { cwd: root, lane: "cli-lean", query, task: { epoch: "new", profile: "answer" } }));
    expect(first.kind).toBe("read.task_pack"); expect(first.decision.kind).toBe("act.answer");
    expect(first.evidence.map((e: { path: string }) => e.path).sort()).toEqual(Object.keys(COPILOT_RETRY_FILES).sort());
    const continued = parse(await callTool("tl_read_file", { cwd: root, lane: "cli-lean", query, task: { handle: first.task.id, force_serve: true } }));
    expect(continued.decision.kind).toBe("act.answer");
    expect(continued.evidence.map((e: { path: string; range: string; body: string }) => [e.path, e.range, e.body]).sort())
      .toEqual(first.evidence.map((e: { path: string; range: string; body: string }) => [e.path, e.range, e.body]).sort());
    const refused = await callTool("tl_read_file", { cwd: root, targets: [{ path: "src/config.ts" }], unknown_field: true });
    expect(refused.isError).toBe(true); expect(parse(refused).code).toBe("unknown-arguments");
  }, 60_000);
});
