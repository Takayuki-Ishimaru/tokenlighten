/**
 * copilotRetest1002r4.toolNames.spec.ts — Copilot retest r4 (2026-10-02).
 *
 * Two findings of the retest, read from the request bodies of every round:
 *
 *  1. Copilot gives a model WITHOUT `tool_search` (MAI flash) every tool's full
 *     schema on every round and never shows it the server's `instructions`.
 *     The only text that told TokenLighten's `read_file` apart from Copilot's
 *     own built-in `read_file` lived in those instructions, so the guide's
 *     `read_file {query:...}` named two tools at once for that model, which
 *     never called TokenLighten. The three tools are now `tl_read_file`,
 *     `tl_search_files` and `tl_edit_file` for every client. The old names are
 *     refused like any other unknown tool (D11: the advertised set and the
 *     accepted set stay one set); the refusal names the replacement.
 *  2. Because that model pays the schema per round, the vscode advertisement
 *     sheds the fields a Copilot model never authors itself (`lane`,
 *     `scope.includeScores`, `targets[].profile`, per-item `oneOf`) and those
 *     only a server-issued call carries (`scope.surfaceRoles`,
 *     `scope.includeClosure`, `task.expected_state_version`, `task.pull`), plus
 *     top-level descriptions that only restate a name or an enum. Dispatch
 *     still accepts every one of them; no capability is hidden.
 */
import { afterAll, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { LEGACY_TOOL_NAMES, TOOL_NAMES, renamedToolName } from "@tokenlighten/types";
import { VSCODE_SERVER_INSTRUCTIONS, VSCODE_TOOL_DESCRIPTIONS } from "../protocol/clientAdvertisement.js";
import { startDevServer, type ServerHandle } from "./helpers/qualityFirstScenarios.js";
import { shortTmpDir } from "./helpers/shortTmpDir.js";
import { rmDirWithRetry } from "./helpers/rmDirWithRetry.js";

type ToolDef = { name: string; description: string; inputSchema: Record<string, unknown> };

const VSCODE = "Visual Studio Code";

/** `tl workspace setup`'s VS Code env (TL_TURN_ECONOMY=1 turns TL_LEAN_CALLS on). */
const VSCODE_SETUP_ENV: Readonly<Record<string, string | undefined>> = { TL_TURN_ECONOMY: "1", TL_LEAN_CALLS: undefined, TL_MINIMAL_TOOLS: undefined };

/**
 * The r4 tier on its own: the same env with r5's TL_MINIMAL_TOOLS (a further
 * cut, copilotRetest1003r5.spec.ts) switched off, so this file keeps pinning
 * exactly what the r4 cut does and keeps.
 */
const R4_TIER_ENV: Readonly<Record<string, string | undefined>> = { ...VSCODE_SETUP_ENV, TL_MINIMAL_TOOLS: "0" };

async function toolsFor(clientId: string | undefined, env: Readonly<Record<string, string | undefined>> = VSCODE_SETUP_ENV): Promise<ToolDef[]> {
  const saved: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    const { advertisedTools } = await import("../server.js");
    return structuredClone(advertisedTools(clientId)) as unknown as ToolDef[];
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function at(node: unknown, dotted: string): unknown {
  let cursor: unknown = node;
  for (const segment of dotted.split(".")) {
    if (cursor === null || typeof cursor !== "object") return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

function tool(tools: readonly ToolDef[], name: string): ToolDef {
  const found = tools.find((entry) => entry.name === name);
  if (found === undefined) throw new Error(`${name} not advertised`);
  return found;
}

describe("the tl_ tool names", () => {
  it("are the only advertised names, for every client", async () => {
    for (const client of [undefined, VSCODE, "claude-code", "codex"]) {
      expect((await toolsFor(client)).map((entry) => entry.name).sort(), String(client)).toEqual(
        ["tl_edit_file", "tl_read_file", "tl_search_files"],
      );
    }
    expect([...TOOL_NAMES].sort()).toEqual(["tl_edit_file", "tl_read_file", "tl_search_files"]);
  });

  it("an in-process call by a pre-rename name is refused with the replacement, not a TypeError (r5 review)", async () => {
    const { callTool } = await import("../server.js");
    await expect(callTool("read_file", { targets: [{ path: "x.ts" }] })).rejects.toThrow(
      "Tool not found: read_file (renamed tl_read_file; refresh the tool list)",
    );
    await expect(callTool("no_such_tool", {})).rejects.toThrow("Tool not found: no_such_tool");
  });

  it("map each pre-rename name to its replacement, and nothing else", () => {
    expect(LEGACY_TOOL_NAMES).toEqual({ read_file: "tl_read_file", edit_file: "tl_edit_file", search_files: "tl_search_files" });
    expect(renamedToolName("read_file")).toBe("tl_read_file");
    expect(renamedToolName("tl_read_file")).toBeUndefined();
    expect(renamedToolName("read_code")).toBeUndefined();
    expect(renamedToolName("toString")).toBeUndefined();
    expect(renamedToolName("__proto__")).toBeUndefined();
  });

  it("leave nothing in the VS Code instructions or descriptions that only the built-in read_file could match", () => {
    expect(VSCODE_SERVER_INSTRUCTIONS).toContain("ending in tl_read_file/tl_edit_file/tl_search_files");
    expect(VSCODE_SERVER_INSTRUCTIONS).toContain('tl_read_file {query:"<request>"}');
    expect(VSCODE_SERVER_INSTRUCTIONS).not.toMatch(/(?<![\w])(?:read_file|edit_file|search_files)(?![\w])/);
    for (const description of Object.values(VSCODE_TOOL_DESCRIPTIONS)) {
      expect(description).not.toMatch(/(?<![\w])(?:read_file|edit_file|search_files)(?![\w])/);
    }
  });
});

describe("the vscode advertisement sheds what a Copilot model never authors", () => {
  const SHED: Readonly<Record<string, readonly string[]>> = {
    tl_read_file: [
      "lane",
      "scope.properties.includeScores",
      "scope.properties.surfaceRoles",
      "scope.properties.includeClosure",
      "targets.items.properties.profile",
      "targets.items.oneOf",
      "task.properties.expected_state_version",
      "task.properties.pull",
    ],
    tl_edit_file: ["lane", "edits.items.oneOf", "task.properties.expected_state_version", "task.properties.pull"],
    tl_search_files: [
      "lane",
      "scope.properties.includeScores",
      "scope.properties.surfaceRoles",
      "scope.properties.includeClosure",
      "task.properties.expected_state_version",
      "task.properties.pull",
    ],
  };

  it("drops each listed field for vscode and keeps it for every other client", async () => {
    const vscode = await toolsFor(VSCODE, R4_TIER_ENV);
    const other = await toolsFor("claude-code");
    for (const [name, paths] of Object.entries(SHED)) {
      for (const dotted of paths) {
        expect(at(tool(vscode, name).inputSchema, `properties.${dotted}`), `${name} vscode ${dotted}`).toBeUndefined();
        expect(at(tool(other, name).inputSchema, `properties.${dotted}`), `${name} claude-code ${dotted}`).toBeDefined();
      }
    }
  });

  it("keeps every capability and every rule-carrying description", async () => {
    const vscode = await toolsFor(VSCODE, R4_TIER_ENV);
    const read = tool(vscode, "tl_read_file").inputSchema;
    const edit = tool(vscode, "tl_edit_file").inputSchema;
    const search = tool(vscode, "tl_search_files").inputSchema;
    for (const dotted of ["select", "scope.properties.archive", "targets.items.properties.archive", "targets.items.properties.credentialRef", "targets.items.properties.purpose", "task.properties.force_serve", "task.properties.challenge", "task.properties.handle", "task.properties.profile", "cursor", "qref"]) {
      expect(at(read, `properties.${dotted}`), `tl_read_file ${dotted}`).toBeDefined();
    }
    for (const dotted of ["artifact", "credentials", "operation_id", "edits.items.properties.intent", "edits.items.properties.from", "edits.items.properties.expectedSha", "edits.items.properties.allowPathFallback", "task.properties.challenge"]) {
      expect(at(edit, `properties.${dotted}`), `tl_edit_file ${dotted}`).toBeDefined();
    }
    for (const dotted of ["queries", "scope.properties.path", "scope.properties.archive", "budget.properties.items", "cursor"]) {
      expect(at(search, `properties.${dotted}`), `tl_search_files ${dotted}`).toBeDefined();
    }
    expect(at(read, "properties.query.description")).toBe("Task-pack intent, verbatim.");
    expect(at(read, "properties.cursor.description")).toEqual(expect.stringContaining("limit.next"));
    expect(at(read, "properties.cwd.description")).toEqual(expect.stringContaining("tl_edit_file only"));
    expect(at(edit, "properties.artifact.description")).toBeDefined();
    expect(at(search, "properties.queries.description")).toBeDefined();
    expect(at(read, "properties.task.description")).toBeUndefined();
    expect(at(read, "properties.content.description")).toBeUndefined();
    expect(at(search, "properties.action.description")).toBeUndefined();
  });

  it("is smaller than the pre-r4 vscode advertisement by more than a kilobyte, and only under the VS Code setup's env", async () => {
    const bytes = Buffer.byteLength(JSON.stringify(await toolsFor(VSCODE, R4_TIER_ENV)), "utf8");
    // 8,379 B with the tl_ names before this cut (8,361 B before the rename).
    expect(bytes).toBeLessThan(8_379 - 1_000);
    const withoutTurnEconomy = await toolsFor(VSCODE, { TL_TURN_ECONOMY: undefined, TL_LEAN_CALLS: undefined });
    expect(at(tool(withoutTurnEconomy, "tl_read_file").inputSchema, "properties.lane")).toBeDefined();
  });
});

describe("a live server (vscode env)", () => {
  const HOME = os.homedir();
  const dirs: string[] = [];
  const servers: ServerHandle[] = [];
  afterAll(async () => {
    for (const server of servers) await server.kill();
    for (const dir of dirs) rmDirWithRetry(dir);
  });

  function workspace(): string {
    const ws = fs.realpathSync(shortTmpDir(HOME, ".tl-cp1002r4-"));
    dirs.push(ws);
    fs.mkdirSync(path.join(ws, "src"), { recursive: true });
    fs.writeFileSync(path.join(ws, "src/backoff.ts"), "export const RETRY_BASE_MS = 125;\nexport function retrySchedule(): number[] {\n  return [0, 1, 2].map((attempt) => RETRY_BASE_MS * 2 ** attempt);\n}\n");
    return ws;
  }

  it("lists the tl_ names, refuses a pre-rename name with its replacement, and still accepts an unadvertised dispatch field", async () => {
    const ws = workspace();
    const server = startDevServer(ws, "vscode", { toolSurface: "full" });
    servers.push(server);
    await server.initialize();
    const listed = await server.listTools();
    expect((listed.tools as Array<{ name: string }>).map((entry) => entry.name).sort()).toEqual(["tl_edit_file", "tl_read_file", "tl_search_files"]);

    await expect(server.callTool("read_file", { targets: [{ path: "src/backoff.ts" }] })).rejects.toThrow(/Tool not found: read_file \(renamed tl_read_file; refresh the tool list\)/);

    // `lane` is no longer advertised to vscode, yet dispatch accepts it.
    const read = await server.callTool("tl_read_file", { targets: [{ path: "src/backoff.ts" }], lane: "copilot" });
    expect(read.body.kind).not.toBe("refusal");
  }, 90_000);

  it("emits every continuation under a tl_ name", async () => {
    const ws = workspace();
    const server = startDevServer(ws, "vscode", { toolSurface: "full" });
    servers.push(server);
    await server.initialize();
    const pack = await server.callTool("tl_read_file", { query: "What delays does retrySchedule() return?", task: { epoch: "new", profile: "answer" } });
    const tools: string[] = [];
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) { node.forEach(walk); return; }
      if (node === null || typeof node !== "object") return;
      const record = node as Record<string, unknown>;
      if (typeof record["tool"] === "string" && record["arguments"] !== undefined) tools.push(record["tool"] as string);
      for (const [key, child] of Object.entries(record)) if (key !== "arguments") walk(child);
    };
    walk(pack.body);
    const miss = await server.callTool("tl_read_file", { targets: [{ path: "src/nope.ts" }] });
    walk(miss.body);
    for (const name of tools) expect(name).toMatch(/^tl_(read_file|search_files|edit_file)$/);
  }, 90_000);
});
