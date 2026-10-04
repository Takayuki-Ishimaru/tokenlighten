/**
 * copilotRetest1003r6.spec.ts — Copilot retest r6 (2026-10-03).
 *
 * r6's request bodies, read round by round:
 *
 *  - small task (MAI flash, no tool_search): both TokenLighten runs called
 *    grep_search, then read_file on the three hits, then answered — the native
 *    path, three rounds — while every round carried ~1,360 tokens of
 *    TokenLighten (o200k: tool definitions ~900, Copilot guide ~630, explore
 *    agent entry ~55). Across r1-r6, MAI called TokenLighten in 1 of 11 such
 *    runs, and that run searched, then read, then answered with TokenLighten's
 *    tools: the same habit;
 *  - large task (GPT-6 Luna, tool_search): one tl_read_file, nine files,
 *    correct, but `tool_search {query:"tokenlighten"}` returned Copilot's
 *    default top 5 — TokenLighten's three tools plus hover_element and
 *    drag_element — and round 3 re-used only round 1's cached prefix, so
 *    every definition that call loaded was billed uncached twice.
 *
 * So: the instructions ask tool_search for `limit:3` (clientAdvertisement.spec.ts
 * pins it to the advertised tool count); TL_MINIMAL_TOOLS lists only what a
 * model writes on its own (server.ts MINIMAL_SCHEMA_PROPERTY_PATHS says why
 * each dropped argument goes); the minimal descriptions open with the Copilot
 * built-in each tool replaces; and a search that returns a few small files
 * whole drops, for files of at most 20 lines, the snippets that only repeated
 * them.
 */
import { afterAll, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  VSCODE_MINIMAL_SEARCH_DESCRIPTION_WITHOUT_BODIES,
  VSCODE_MINIMAL_TOOL_DESCRIPTIONS,
} from "../protocol/clientAdvertisement.js";
import {
  attachSmallFileContexts,
  SMALL_FIND_BODY_MAX_LINES,
  SMALL_FIND_BODY_SNIPPET_DROP_MAX_LINES,
} from "../features/search/find/findText.js";
import { startDevServer, type ServerHandle } from "./helpers/qualityFirstScenarios.js";
import { COPILOT_RETRY_FILES } from "./helpers/copilotCheckoutFixture.js";
import { shortTmpDir } from "./helpers/shortTmpDir.js";
import { rmDirWithRetry } from "./helpers/rmDirWithRetry.js";

type ToolDef = { name: string; description: string; inputSchema: Record<string, unknown> };
type Env = Readonly<Record<string, string | undefined>>;

const VSCODE = "Visual Studio Code";
const VSCODE_SETUP_ENV: Env = { TL_TURN_ECONOMY: "1", TL_LEAN_CALLS: undefined, TL_MINIMAL_TOOLS: undefined, TL_FIND_SMALL_BODIES: undefined };

async function toolsFor(env: Env = VSCODE_SETUP_ENV): Promise<ToolDef[]> {
  const saved: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    const { advertisedTools } = await import("../server.js");
    return structuredClone(advertisedTools(VSCODE)) as unknown as ToolDef[];
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function tool(tools: readonly ToolDef[], name: string): ToolDef {
  const found = tools.find((entry) => entry.name === name);
  if (found === undefined) throw new Error(`${name} not advertised`);
  return found;
}

function advertises(schema: Record<string, unknown>, dotted: string): boolean {
  let cursor: unknown = schema;
  for (const segment of dotted.split(".")) {
    if (cursor === null || typeof cursor !== "object") return false;
    const record = cursor as Record<string, unknown>;
    const properties = (record["items"] as Record<string, unknown> | undefined)?.["properties"] ?? record["properties"];
    if (properties === null || typeof properties !== "object") return false;
    cursor = (properties as Record<string, unknown>)[segment];
  }
  return cursor !== undefined;
}

describe("r6 — the minimal descriptions name what each tool replaces, and only what the tier advertises", () => {
  it("tl_read_file opens with first-source routing; tl_search_files with grep_search", async () => {
    const tools = await toolsFor();
    const read = tool(tools, "tl_read_file").description;
    const search = tool(tools, "tl_search_files").description;
    expect(read.startsWith("FIRST workspace source inspection, instead of grep_search/semantic_search/read_file: ")).toBe(true);
    expect(read).toContain("Locates AND serves source with line numbers");
    expect(search.startsWith("For source questions/tasks use tl_read_file {query} first.")).toBe(true);
    expect(tool(tools, "tl_edit_file").description).toBe(VSCODE_MINIMAL_TOOL_DESCRIPTIONS.tl_edit_file);
  });

  it("the search description promises whole small files only while TL_FIND_SMALL_BODIES delivers them", async () => {
    const on = tool(await toolsFor(), "tl_search_files").description;
    const off = tool(await toolsFor({ ...VSCODE_SETUP_ENV, TL_FIND_SMALL_BODIES: "0" }), "tl_search_files").description;
    expect(on).toBe(VSCODE_MINIMAL_TOOL_DESCRIPTIONS.tl_search_files);
    expect(on).toContain("a few small matching files come back whole, so no read follows");
    expect(off).toBe(VSCODE_MINIMAL_SEARCH_DESCRIPTION_WITHOUT_BODIES);
    expect(off).not.toMatch(/whole/u);
    expect(off).toContain("use tl_read_file {query} first.");
  });

  it("every argument a description spells out is one the tier advertises", async () => {
    const tools = await toolsFor();
    const NAMED: Readonly<Record<string, readonly string[]>> = {
      tl_read_file: ["query", "task.epoch", "task.profile", "targets.path"],
      tl_search_files: ["action", "queries", "scope.regex", "scope.path"],
      tl_edit_file: ["edits.path", "edits.handle", "edits.search", "edits.replace", "edits.precondition", "edits.create", "edits.content", "cwd"],
    };
    for (const [name, paths] of Object.entries(NAMED)) {
      const schema = tool(tools, name).inputSchema;
      for (const dotted of paths) expect(advertises(schema, dotted), `${name} ${dotted}`).toBe(true);
    }
  });

  it("what a Copilot model receives for the three tools stays under 2,750 characters (r6 measured ~3,700)", async () => {
    // Copilot's own rendering of an MCP tool for the model: prefixed name,
    // description, parameters, type, strict (r6 request bodies).
    const asSent = (await toolsFor()).map((entry) => ({
      name: `mcp__tokenlighten_${entry.name}`,
      description: entry.description,
      parameters: entry.inputSchema,
      type: "function",
      strict: false,
    }));
    expect(JSON.stringify(asSent).length).toBeLessThanOrEqual(2_750);
  });

  it("keeps a directory target's purpose and the guide's force_serve resend advertised (written by the model itself, named by no reply)", async () => {
    const read = tool(await toolsFor(), "tl_read_file").inputSchema;
    expect(advertises(read, "targets.purpose")).toBe(true);
    expect(advertises(read, "task.force_serve")).toBe(true);
  });
});

const HOME = os.homedir();
const dirs: string[] = [];
const servers: ServerHandle[] = [];

afterAll(async () => {
  for (const server of servers) await server.kill();
  for (const dir of dirs) rmDirWithRetry(dir);
});

function workspace(files: Readonly<Record<string, string>>): string {
  const ws = fs.realpathSync(shortTmpDir(HOME, ".tl-cp1003r6-"));
  dirs.push(ws);
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(ws, rel)), { recursive: true });
    fs.writeFileSync(path.join(ws, rel), content, "utf8");
  }
  return ws;
}

async function start(ws: string, allowWrite = false): Promise<ServerHandle> {
  const server = startDevServer(ws, "vscode", { toolSurface: "full", allowWrite });
  servers.push(server);
  await server.initialize();
  return server;
}

describe("r6 — a live vscode server still serves every argument the tier stopped advertising", () => {
  it("read: a qref re-pack, content/cwd/ranges/purpose, and task.force_serve", async () => {
    const ws = workspace(COPILOT_RETRY_FILES);
    const server = await start(ws);
    const pack = await server.callTool("tl_read_file", { query: "What does retrySchedule() return?", task: { epoch: "new", profile: "answer" } });
    expect(pack.body.kind, JSON.stringify(pack.body).slice(0, 400)).toBe("read.task_pack");
    const qref = pack.body["qref"];
    expect(typeof qref).toBe("string");
    const repack = await server.callTool("tl_read_file", { qref, targets: [{ path: "src/backoff.ts" }] });
    expect(repack.body.kind, JSON.stringify(repack.body).slice(0, 400)).not.toBe("refusal");
    const extras = await server.callTool("tl_read_file", {
      targets: [{ path: "src/config.ts", ranges: ["1-2"] }, { path: "src", purpose: "retry constants" }],
      content: "full",
      cwd: ws,
      task: { epoch: "new" },
    });
    expect(extras.body.kind, JSON.stringify(extras.body).slice(0, 400)).not.toBe("refusal");
    await server.callTool("tl_read_file", { targets: [{ path: "src/worker.ts" }] });
    const forced = await server.callTool("tl_read_file", { targets: [{ path: "src/worker.ts" }], task: { force_serve: true } });
    expect(forced.body.kind, JSON.stringify(forced.body).slice(0, 400)).not.toBe("refusal");
    expect(JSON.stringify(forced.body)).toContain("retrySchedule");
  }, 120_000);

  it("search: task, cwd, scope.kind/depth and budget.items", async () => {
    const ws = workspace(COPILOT_RETRY_FILES);
    const server = await start(ws);
    const found = await server.callTool("tl_search_files", {
      action: "find",
      queries: ["RETRY_LIMIT"],
      scope: { path: "src", kind: "text", depth: 3 },
      budget: { items: 5 },
      task: { epoch: "new" },
      cwd: ws,
    });
    expect(found.body.kind, JSON.stringify(found.body).slice(0, 400)).toBe("search.matches");
  }, 120_000);

  it("edit: allowPathFallback on an item", async () => {
    const ws = workspace(COPILOT_RETRY_FILES);
    const server = await start(ws, true);
    await server.callTool("tl_read_file", { targets: [{ path: "src/config.ts" }] });
    const edit = await server.callTool("tl_edit_file", {
      edits: [{ path: "src/config.ts", search: "RETRY_LIMIT = 3", replace: "RETRY_LIMIT = 4", precondition: "unique-match", allowPathFallback: false }],
      cwd: ws,
    });
    expect(edit.body.kind, JSON.stringify(edit.body).slice(0, 400)).toBe("edit.applied");
    expect(fs.readFileSync(path.join(ws, "src/config.ts"), "utf8")).toContain("RETRY_LIMIT = 4");
  }, 120_000);
});

type FileEntry = { path: string; lines: number[]; snippets?: string[]; more_lines?: number; context?: string; range?: string };

function filesOf(body: Record<string, any>): FileEntry[] {
  expect(body["kind"], JSON.stringify(body).slice(0, 400)).toBe("search.matches");
  return body["matches"]["files"] as FileEntry[];
}

describe("r6 — a whole small file replaces the snippets that only repeated it", () => {
  it("drops snippets where a short whole text rides along, keeps lines, and keeps snippets where it does not", async () => {
    const long = ["export const RETRY_NOTE = 1;", ...Array.from({ length: SMALL_FIND_BODY_MAX_LINES }, (_, i) => `// filler ${i}`)].join("\n") + "\n";
    // Whole text attached (under 80 lines), but past the snippet-drop length:
    // its snippets pair each matched line number with its text.
    const medium = ["export const RETRY_MEDIUM = 2;", ...Array.from({ length: SMALL_FIND_BODY_SNIPPET_DROP_MAX_LINES + 5 }, (_, i) => `// m${i}`)].join("\n") + "\n";
    const server = await start(workspace({ ...COPILOT_RETRY_FILES, "src/long.ts": long, "src/medium.ts": medium }));
    const byPath = new Map(filesOf((await server.callTool("tl_search_files", { action: "find", queries: ["RETRY_"] })).body).map((file) => [file.path, file]));
    for (const rel of ["src/config.ts", "src/backoff.ts", "src/worker.ts"]) {
      const file = byPath.get(rel)!;
      expect(file.context, rel).toBe(COPILOT_RETRY_FILES[rel]!.replace(/\n$/u, ""));
      expect(file.snippets, rel).toBeUndefined();
      expect(file.lines.length, rel).toBeGreaterThan(0);
    }
    const mediumEntry = byPath.get("src/medium.ts")!;
    expect(mediumEntry.context).toBe(medium.replace(/\n$/u, ""));
    expect(mediumEntry.snippets?.[0]).toContain("RETRY_MEDIUM");
    const longEntry = byPath.get("src/long.ts")!;
    expect(longEntry.context).toBeUndefined();
    expect(longEntry.snippets?.[0]).toContain("RETRY_NOTE");
  }, 120_000);

  it("keeps more_lines, so lines.length + more_lines stays the true match count", () => {
    const ws = workspace({ "src/many.ts": Array.from({ length: 12 }, (_, i) => `export const HIT_${i} = ${i};`).join("\n") + "\n" });
    const body: Record<string, unknown> = {
      files: [{ path: "src/many.ts", lines: [1, 2, 3, 4, 5, 6, 7, 8], snippets: ["a", "b", "c", "d", "e", "f", "g", "h"], more_lines: 4 }],
      total_files: 1,
    };
    attachSmallFileContexts(body, ws, false);
    const [entry] = body["files"] as FileEntry[];
    expect(entry!.context).toContain("HIT_11");
    expect(entry!.snippets).toBeUndefined();
    expect(entry!.more_lines).toBe(4);
  });
});
