import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { advertisedTools, handleRequest, resetCapturedClientIdForTest, buildInitializeInstructionsForClient } from "../server.js";
import { SERVER_INSTRUCTIONS } from "../protocol/serverInstructions.js";

const roots: string[] = [];
// The client-specific advertisement behind the portable default (§20.8);
// portableAdvertisement.spec.ts covers the default itself.
beforeEach(() => { vi.stubEnv("TL_PORTABLE_TOOLS", "0"); });
afterEach(() => { vi.unstubAllEnvs(); resetCapturedClientIdForTest(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function withoutDescriptions(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutDescriptions);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).filter(([key, child]) => key !== "description" || typeof child !== "string").map(([key, child]) => [key, withoutDescriptions(child)]));
}
describe("Copilot CLI eager tool advertisement", () => {
  it("reduces repeated explanation bytes without changing any accepted schema shape", () => {
    const baseline = advertisedTools(undefined), cli = advertisedTools("copilot-cli");
    expect(cli.map(tool => tool.name).sort()).toEqual(["tl_edit_file", "tl_read_file", "tl_search_files"]);
    for (const tool of cli) {
      const before = baseline.find(candidate => candidate.name === tool.name)!;
      expect(withoutDescriptions(tool.inputSchema)).toEqual(withoutDescriptions(before.inputSchema));
      expect(tool.annotations).toEqual(before.annotations);
      expect(tool._meta).toEqual(before._meta);
      expect(JSON.stringify(tool).length).toBeLessThan(JSON.stringify(before).length * 0.85);
    }
    expect(cli.find(tool => tool.name === "tl_read_file")!.description).toContain("grep/view");
    expect(cli.find(tool => tool.name === "tl_read_file")!.description).toContain("entire user request, verbatim");
  });
  it("scopes the diet to the observed CLI name and never mutates default definitions", () => {
    const baseline = advertisedTools(undefined);
    const cli = advertisedTools("copilot-cli");
    for (const name of [undefined, "Codex CLI", "claude-code", "copilot-cli-proxy", "GitHub Copilot"]) expect(advertisedTools(name)).toEqual(baseline);
    expect(advertisedTools("COPILOT-CLI")).toEqual(cli);
    (cli[0]!.inputSchema as { properties: Record<string, unknown> }).properties["query"] = { type: "number" };
    expect(advertisedTools(undefined)).toEqual(baseline);
    expect(advertisedTools("copilot-cli")).not.toEqual(cli);
  });
  it("captures the exact live handshake; keeps initialization rules and the three tools", async () => {
    const initialized = await handleRequest({ jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "copilot-cli", version: "1.0.96" } } });
    expect((initialized as { result: { instructions: string } }).result.instructions).toBe(SERVER_INSTRUCTIONS);
    expect(buildInitializeInstructionsForClient("copilot-cli", ["degraded"])).toBe(SERVER_INSTRUCTIONS + "\nDegraded: degraded");
    const response = await handleRequest({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const tools = (response as { result: { tools: Array<{ name: string; description: string }> } }).result.tools;
    expect(tools).toEqual(advertisedTools("copilot-cli"));
    expect(tools.find(tool => tool.name === "tl_read_file")!.description).toContain("grep/view");
  });
  it("serves the exact observed R1 call and a forced continuation with unchanged source evidence", async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.homedir(), ".tl-copilot-advertisement-"))); roots.push(root);
    fs.mkdirSync(path.join(root, "src"));
    fs.writeFileSync(path.join(root, "src/constants.ts"), "export const RETRY = { attempts: 4, initialDelayMs: 125, factor: 2, maxDelayMs: 800 } as const;\n");
    fs.writeFileSync(path.join(root, "src/backoff.ts"), 'import { RETRY } from "./constants.ts";\nexport function backoff(attempt: number): number {\n  return Math.min(RETRY.initialDelayMs * RETRY.factor ** attempt, RETRY.maxDelayMs);\n}\n');
    fs.writeFileSync(path.join(root, "src/retry.ts"), 'import { RETRY } from "./constants.ts";\nimport { backoff } from "./backoff.ts";\nexport function retrySchedule(): number[] {\n  return Array.from({ length: RETRY.attempts }, (_, attempt) => backoff(attempt));\n}\n');
    await handleRequest({ jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "copilot-cli", version: "1.0.96" } } });
    const query = "What exact delay sequence does retrySchedule() return, and which constants and functions determine it? Use keys delays and sources. Include sources as an array of {path,startLine,endLine}; cite each function and constant needed for the result. Return only a JSON object. Do not modify files or run terminal commands.";
    const call = async (id: number, task: Record<string, unknown>) => {
      const response = await handleRequest({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "tl_read_file", arguments: { cwd: root, lane: "cli-overhead", query, task } } });
      return JSON.parse((response as { result: { content: Array<{ text: string }> } }).result.content[0]!.text) as { kind: string; task: { id: string }; decision: { kind: string }; evidence: Array<{ path: string; body: string; range: string }> };
    };
    const first = await call(3, { epoch: "new", profile: "answer" });
    expect(first.kind).toBe("read.task_pack"); expect(first.decision.kind).toBe("act.answer");
    expect(first.evidence.map(entry => entry.path).sort()).toEqual(["src/backoff.ts", "src/constants.ts", "src/retry.ts"]);
    const continued = await call(4, { handle: first.task.id, force_serve: true });
    expect(continued.decision.kind).toBe("act.answer");
    expect(continued.evidence.map(entry => [entry.path, entry.range, entry.body]).sort()).toEqual(first.evidence.map(entry => [entry.path, entry.range, entry.body]).sort());
  }, 60_000);
});
