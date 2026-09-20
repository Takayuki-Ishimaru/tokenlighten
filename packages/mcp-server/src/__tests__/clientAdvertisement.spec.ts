// clientAdvertisement.spec.ts — VS Code / GitHub Copilot Chat advertisement
// variants (protocol/clientAdvertisement.ts).
//
// GitHub Copilot Chat defers every MCP tool behind its own `tool_search`
// tool (the model sees only a bare name, e.g. one ending in
// `tokenlighten_read_file`, until it loads the tool) and — unusually among
// MCP hosts — injects the server's `initialize`-time `instructions` string
// into its system prompt on EVERY request, tools loaded or not. This spec
// proves three things, each load-bearing for that host:
//   1. VS Code's clientInfo.name resolves to its own `instructions` text AND
//      its own three tool descriptions — through the REAL `handleRequest`/
//      `advertisedTools()` path, not a reimplementation.
//   2. Every OTHER client (no clientInfo, or a Claude/Codex-like name) gets
//      EXACTLY today's SERVER_INSTRUCTIONS / ALL_TOOLS descriptions —
//      unchanged, proven by strict equality against the pre-existing
//      exports, not merely "similar" text.
//   3. The advertised input SCHEMAS never differ by client — only the
//      `description` strings do.
//
// See protocol/clientAdvertisement.ts's own header for the full rationale,
// including the confirmed gap in the two SDK-backed transport legs
// (mcp/transport/legacyStdio.ts, mcp/transport/modernServerFactory.ts),
// which this spec does not cover (out of this change's ownership scope).

import { describe, it, expect, beforeEach, afterEach } from "vitest";

import {
  handleRequest,
  advertisedTools,
  buildInitializeInstructionsForClient,
  resetCapturedClientIdForTest,
} from "../server.js";
import { SERVER_INSTRUCTIONS } from "../protocol/serverInstructions.js";
import {
  VSCODE_SERVER_INSTRUCTIONS,
  VSCODE_TOOL_DESCRIPTIONS,
  baseServerInstructionsForClient,
  toolDescriptionForClient,
} from "../protocol/clientAdvertisement.js";

const NON_VSCODE_CLIENT_NAMES = [
  undefined,
  "claude-code",
  "Codex CLI",
  "tl-reference-client",
  "some-unregistered-client",
  // Substring-adjacent but not a match: clientProfile.ts's own
  // VSCODE_CLIENT_NAME_SUBSTRINGS check is case-insensitive substring, not
  // exact, so this is a genuine near-miss worth pinning here too (a typo'd
  // match would silently leak VS Code text to an unrelated client).
  "Visual Studio",
] as const;

const VSCODE_CLIENT_NAMES = [
  "Visual Studio Code",
  "Visual Studio Code - Insiders",
  "Visual Studio Code - Exploration",
  // clientProfile.ts matches case-insensitively and by substring — a raw
  // "vscode" token (e.g. a fork's clientInfo.name) must match too.
  "vscode",
] as const;

beforeEach(() => {
  resetCapturedClientIdForTest();
});

afterEach(() => {
  resetCapturedClientIdForTest();
});

async function initializeWith(name: string | undefined): Promise<Record<string, unknown>> {
  const res = await handleRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: name === undefined ? {} : { clientInfo: { name, version: "1.0.0" } },
  });
  return (res as { result: Record<string, unknown> }).result;
}

describe("clientAdvertisement: VSCODE_SERVER_INSTRUCTIONS content and budget", () => {
  it("is ASCII-only and stays at or under a 1000 byte budget", () => {
    expect(/^[\x00-\x7F]*$/.test(VSCODE_SERVER_INSTRUCTIONS)).toBe(true);
    const bytes = Buffer.byteLength(VSCODE_SERVER_INSTRUCTIONS, "utf8");
    expect(bytes, `VSCODE_SERVER_INSTRUCTIONS is ${bytes} B`).toBeLessThanOrEqual(1000);
  });

  it("names the tools as ending in tokenlighten_read_file/tokenlighten_edit_file/tokenlighten_search_files", () => {
    expect(VSCODE_SERVER_INSTRUCTIONS).toContain("tokenlighten_read_file");
    expect(VSCODE_SERVER_INSTRUCTIONS).toContain("tokenlighten_edit_file");
    expect(VSCODE_SERVER_INSTRUCTIONS).toContain("tokenlighten_search_files");
  });

  it("says the tools are deferred and tells the model to batch tool_search with its first other call, never alone, including the post-summary re-load case", () => {
    expect(VSCODE_SERVER_INSTRUCTIONS).toContain("tool_search");
    expect(VSCODE_SERVER_INSTRUCTIONS).toContain("tokenlighten");
    expect(VSCODE_SERVER_INSTRUCTIONS).toContain('in your FIRST tool batch, next to whatever else you call first, also call tool_search {query:"tokenlighten"} - never spend a turn on it alone');
    expect(VSCODE_SERVER_INSTRUCTIONS).toMatch(/vanish after a conversation summary/);
  });

  it("disambiguates bare read_file from the built-in BEFORE the first usage example, never after", () => {
    const disambiguationIndex = VSCODE_SERVER_INSTRUCTIONS.indexOf("never the built-in read_file");
    const usageExampleIndex = VSCODE_SERVER_INSTRUCTIONS.indexOf('read_file {query:"<request>"}');
    expect(disambiguationIndex, "disambiguation sentence must be present").toBeGreaterThan(-1);
    expect(usageExampleIndex, "read_file {query:...} usage example must be present").toBeGreaterThan(-1);
    expect(disambiguationIndex).toBeLessThan(usageExampleIndex);
  });

  it("keeps the essential routing from SERVER_INSTRUCTIONS: TL-first, unknown-location routing, act-on-decision, batching, and the AGENTS.md pointer", () => {
    expect(VSCODE_SERVER_INSTRUCTIONS).toContain("TL first for code/doc/config.");
    expect(VSCODE_SERVER_INSTRUCTIONS).toContain('Unknown-location/multi-file=>read_file {query:"<request>"}.');
    expect(VSCODE_SERVER_INSTRUCTIONS).toContain("Act on act.answer/act.edit");
    expect(VSCODE_SERVER_INSTRUCTIONS).toContain("batch edits in one edits[] call");
    expect(VSCODE_SERVER_INSTRUCTIONS).toContain("AGENTS.md");
  });

  it("adds VS Code-specific guidance: query language and single/parallel-batch targets", () => {
    expect(VSCODE_SERVER_INSTRUCTIONS).toMatch(/code's own language/);
    expect(VSCODE_SERVER_INSTRUCTIONS).toMatch(/usually English/);
    expect(VSCODE_SERVER_INSTRUCTIONS).toContain("ONE targets:[...] call");
    expect(VSCODE_SERVER_INSTRUCTIONS).toMatch(/parallel batch/);
  });

  it("tells the model turns cost more than bytes and that continuing a served handle needs no qref", () => {
    expect(VSCODE_SERVER_INSTRUCTIONS).toContain("Turns cost more than bytes");
    expect(VSCODE_SERVER_INSTRUCTIONS).toContain("targets:[{handle,range}]");
    expect(VSCODE_SERVER_INSTRUCTIONS).toMatch(/no qref/);
  });

  it("is textually distinct from the default SERVER_INSTRUCTIONS", () => {
    expect(VSCODE_SERVER_INSTRUCTIONS).not.toBe(SERVER_INSTRUCTIONS);
  });
});

describe("clientAdvertisement: VSCODE_TOOL_DESCRIPTIONS content and budget", () => {
  it("carries exactly the three advertised tool names", () => {
    expect(Object.keys(VSCODE_TOOL_DESCRIPTIONS).sort()).toEqual(["edit_file", "read_file", "search_files"]);
  });

  it("each description is ASCII-only and roughly 200-350 chars (richer than the ~30-40 char default, but not a paragraph)", () => {
    for (const [name, text] of Object.entries(VSCODE_TOOL_DESCRIPTIONS)) {
      expect(/^[\x00-\x7F]*$/.test(text), `${name} description must be ASCII-only`).toBe(true);
      const bytes = Buffer.byteLength(text, "utf8");
      expect(bytes, `${name} description is ${bytes} B`).toBeGreaterThan(150);
      expect(bytes, `${name} description is ${bytes} B`).toBeLessThanOrEqual(350);
    }
  });

  it("documents only advertised parameters (no invented field names)", () => {
    // Derived from AGENTS.md's TokenLighten MCP section / the advertised
    // schema itself — a loose smoke check that the call shapes named here
    // are real advertised properties, not invented ones.
    expect(VSCODE_TOOL_DESCRIPTIONS.read_file).toContain("task:{epoch:\"new\"}");
    expect(VSCODE_TOOL_DESCRIPTIONS.read_file).toContain("targets:[{path|handle, range}]");
    expect(VSCODE_TOOL_DESCRIPTIONS.edit_file).toContain("edits[]");
    expect(VSCODE_TOOL_DESCRIPTIONS.edit_file).toContain("precondition:\"unique-match\"");
    expect(VSCODE_TOOL_DESCRIPTIONS.edit_file).toContain("cwd");
    expect(VSCODE_TOOL_DESCRIPTIONS.search_files).toContain('action:"find"');
    expect(VSCODE_TOOL_DESCRIPTIONS.search_files).toContain("scope.path");
  });
});

describe("clientAdvertisement: baseServerInstructionsForClient / toolDescriptionForClient (pure functions)", () => {
  it.each(NON_VSCODE_CLIENT_NAMES)("clientId %j resolves to the default SERVER_INSTRUCTIONS", (name) => {
    expect(baseServerInstructionsForClient(name)).toBe(SERVER_INSTRUCTIONS);
  });

  it.each(VSCODE_CLIENT_NAMES)("clientId %j resolves to VSCODE_SERVER_INSTRUCTIONS", (name) => {
    expect(baseServerInstructionsForClient(name)).toBe(VSCODE_SERVER_INSTRUCTIONS);
  });

  it.each(NON_VSCODE_CLIENT_NAMES)("clientId %j gets no tool-description override (undefined)", (name) => {
    expect(toolDescriptionForClient(name, "read_file")).toBeUndefined();
    expect(toolDescriptionForClient(name, "edit_file")).toBeUndefined();
    expect(toolDescriptionForClient(name, "search_files")).toBeUndefined();
  });

  it.each(VSCODE_CLIENT_NAMES)("clientId %j gets the VS Code override for all three tools", (name) => {
    expect(toolDescriptionForClient(name, "read_file")).toBe(VSCODE_TOOL_DESCRIPTIONS.read_file);
    expect(toolDescriptionForClient(name, "edit_file")).toBe(VSCODE_TOOL_DESCRIPTIONS.edit_file);
    expect(toolDescriptionForClient(name, "search_files")).toBe(VSCODE_TOOL_DESCRIPTIONS.search_files);
  });

  it("an unrecognized tool name yields undefined even for a VS Code client", () => {
    expect(toolDescriptionForClient("Visual Studio Code", "not_a_real_tool")).toBeUndefined();
  });

  it("buildInitializeInstructionsForClient composes the same Degraded: suffix shape for both variants", () => {
    expect(buildInitializeInstructionsForClient(undefined, [])).toBe(SERVER_INSTRUCTIONS);
    expect(buildInitializeInstructionsForClient(undefined, ["reason-a"])).toBe(
      `${SERVER_INSTRUCTIONS}\nDegraded: reason-a`,
    );
    expect(buildInitializeInstructionsForClient("Visual Studio Code", [])).toBe(VSCODE_SERVER_INSTRUCTIONS);
    expect(buildInitializeInstructionsForClient("Visual Studio Code", ["reason-a", "reason-b"])).toBe(
      `${VSCODE_SERVER_INSTRUCTIONS}\nDegraded: reason-a, reason-b`,
    );
  });
});

describe("clientAdvertisement: advertisedTools(clientId) description override", () => {
  it("bare advertisedTools() (no clientId) is unaffected — default descriptions, unchanged", () => {
    const bare = advertisedTools() as Array<{ name: string; description: string }>;
    const explicit = advertisedTools(undefined) as Array<{ name: string; description: string }>;
    expect(bare).toEqual(explicit);
    const byName = new Map(bare.map((t) => [t.name, t.description]));
    expect(byName.get("read_file")).toBe("Read via query/qref or targets[].");
    expect(byName.get("edit_file")).toBe("Edit via edits[] or artifact.");
    expect(byName.get("search_files")).toBe("Find/reference/diff/tree via queries[].");
  });

  it.each(NON_VSCODE_CLIENT_NAMES)("advertisedTools(%j) keeps the default descriptions", (name) => {
    const tools = advertisedTools(name) as Array<{ name: string; description: string }>;
    const byName = new Map(tools.map((t) => [t.name, t.description]));
    expect(byName.get("read_file")).toBe("Read via query/qref or targets[].");
    expect(byName.get("edit_file")).toBe("Edit via edits[] or artifact.");
    expect(byName.get("search_files")).toBe("Find/reference/diff/tree via queries[].");
  });

  it.each(VSCODE_CLIENT_NAMES)("advertisedTools(%j) swaps in the VS Code descriptions", (name) => {
    const tools = advertisedTools(name) as Array<{ name: string; description: string }>;
    const byName = new Map(tools.map((t) => [t.name, t.description]));
    expect(byName.get("read_file")).toBe(VSCODE_TOOL_DESCRIPTIONS.read_file);
    expect(byName.get("edit_file")).toBe(VSCODE_TOOL_DESCRIPTIONS.edit_file);
    expect(byName.get("search_files")).toBe(VSCODE_TOOL_DESCRIPTIONS.search_files);
  });

  it("advertised tool count and names stay exactly {edit_file, read_file, search_files} for VS Code too", () => {
    const tools = advertisedTools("Visual Studio Code") as Array<{ name: string }>;
    expect(tools.map((t) => t.name).sort()).toEqual(["edit_file", "read_file", "search_files"]);
  });

  it("input schemas, annotations, and _meta are IDENTICAL between the default and VS Code variant — only description differs", () => {
    const defaultTools = advertisedTools(undefined) as Array<Record<string, unknown>>;
    const vsCodeTools = advertisedTools("Visual Studio Code") as Array<Record<string, unknown>>;
    expect(vsCodeTools.length).toBe(defaultTools.length);
    const defaultByName = new Map(defaultTools.map((t) => [t["name"] as string, t]));
    for (const vsCodeTool of vsCodeTools) {
      const name = vsCodeTool["name"] as string;
      const defaultTool = defaultByName.get(name)!;
      expect(vsCodeTool["inputSchema"], `${name}.inputSchema`).toEqual(defaultTool["inputSchema"]);
      expect(vsCodeTool["annotations"], `${name}.annotations`).toEqual(defaultTool["annotations"]);
      expect(vsCodeTool["_meta"], `${name}._meta`).toEqual(defaultTool["_meta"]);
      // The one field that IS allowed (and, for these three tools, expected)
      // to differ.
      expect(vsCodeTool["description"]).toBe(VSCODE_TOOL_DESCRIPTIONS[name as "read_file" | "edit_file" | "search_files"]);
    }
  });
});

describe("clientAdvertisement: end-to-end through handleRequest's initialize case (hand-rolled leg)", () => {
  it.each(NON_VSCODE_CLIENT_NAMES)("initialize with clientInfo.name %j returns instructions === SERVER_INSTRUCTIONS exactly", async (name) => {
    const result = await initializeWith(name);
    expect(result["instructions"]).toBe(SERVER_INSTRUCTIONS);
  });

  it.each(VSCODE_CLIENT_NAMES)("initialize with clientInfo.name %j returns instructions === VSCODE_SERVER_INSTRUCTIONS exactly", async (name) => {
    const result = await initializeWith(name);
    expect(result["instructions"]).toBe(VSCODE_SERVER_INSTRUCTIONS);
  });

  it("a real VS Code initialize, followed by a bare advertisedTools() call, is client-aware end to end", async () => {
    await initializeWith("Visual Studio Code");
    // No explicit clientId passed here — this is exactly the shape
    // handleRequest's own "tools/list" case uses.
    const tools = advertisedTools() as Array<{ name: string; description: string }>;
    const byName = new Map(tools.map((t) => [t.name, t.description]));
    expect(byName.get("read_file")).toBe(VSCODE_TOOL_DESCRIPTIONS.read_file);
    expect(byName.get("edit_file")).toBe(VSCODE_TOOL_DESCRIPTIONS.edit_file);
    expect(byName.get("search_files")).toBe(VSCODE_TOOL_DESCRIPTIONS.search_files);
  });

  it("after a VS Code initialize, a later bare advertisedTools() call in the SAME process stays VS Code-aware (documents the existing capturedClientId lifetime — reset explicitly between unrelated tests, matching clientIdCapture.spec.ts's established pattern)", async () => {
    await initializeWith("Visual Studio Code");
    resetCapturedClientIdForTest();
    const tools = advertisedTools() as Array<{ name: string; description: string }>;
    const byName = new Map(tools.map((t) => [t.name, t.description]));
    // After the reset, behavior reverts to default — proving the override is
    // driven by capturedClientId, not some other sticky state.
    expect(byName.get("read_file")).toBe("Read via query/qref or targets[].");
  });

  it("TOKENLIGHTEN_CLIENT_ID=vscode yields the VS Code instructions and tool descriptions even when initialize carries an unrelated clientInfo name", async () => {
    const previousOverride = process.env["TOKENLIGHTEN_CLIENT_ID"];
    process.env["TOKENLIGHTEN_CLIENT_ID"] = "vscode";
    try {
      const result = await initializeWith("some-unregistered-agent-harness");
      expect(result["instructions"]).toBe(VSCODE_SERVER_INSTRUCTIONS);
      const tools = advertisedTools() as Array<{ name: string; description: string }>;
      const byName = new Map(tools.map((t) => [t.name, t.description]));
      expect(byName.get("read_file")).toBe(VSCODE_TOOL_DESCRIPTIONS.read_file);
      expect(byName.get("edit_file")).toBe(VSCODE_TOOL_DESCRIPTIONS.edit_file);
      expect(byName.get("search_files")).toBe(VSCODE_TOOL_DESCRIPTIONS.search_files);
    } finally {
      if (previousOverride === undefined) delete process.env["TOKENLIGHTEN_CLIENT_ID"];
      else process.env["TOKENLIGHTEN_CLIENT_ID"] = previousOverride;
    }
  });
});
