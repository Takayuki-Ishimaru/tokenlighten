/**
 * leanSchema.spec.ts — WP-V1 (2026-09-20).
 *
 * Pure, in-process proof of server.ts's `leanToolDefinitionForClient` (the
 * additional VS-Code-only, `leanCallsEnabled()`-only schema diet layered on
 * top of `filterToolDefinitionForSurface`). No server spawn: `advertisedTools`
 * is a pure function of `clientId` plus the current env, so every property
 * name/keyword/byte-size claim below is asserted directly against its return
 * value — mirrors schemaSize.spec.ts's own `await import("../server.js")`
 * per-test pattern.
 *
 * A live-dispatch proof that a leaned-away property (`budget.bytes`) and
 * `targets[].purpose` are still SERVED exactly as today lives in
 * rc/leanVsCodeCalls.rc.spec.ts (a real server, since that claim is about
 * `dispatchTool`, not about `advertisedTools`'s return value).
 */

import { describe, expect, it } from "vitest";

type SchemaNode = Record<string, unknown>;
type ToolDef = { name: string; description: string; inputSchema: SchemaNode };

const VSCODE = "Visual Studio Code";

async function toolsFor(clientId: string | undefined): Promise<ToolDef[]> {
  const { advertisedTools } = await import("../server.js");
  return advertisedTools(clientId) as unknown as ToolDef[];
}

// NOTE: `fn` is awaited BEFORE env vars are restored — `toolsFor` is async
// (it awaits a dynamic import), so a synchronous try/finally around a bare
// `fn()` call would restore the env before that internal await resumes and
// `advertisedTools()` actually reads `process.env`, silently testing the
// UNPATCHED env instead.
async function withEnv<T>(env: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/** Every property NAME reachable anywhere in `node` (top-level and nested), as dotted paths — for a set-difference comparison that ignores structural keywords (oneOf/anyOf/dependentRequired/description) entirely. */
function propertyNamePaths(node: unknown, prefix = ""): Set<string> {
  const out = new Set<string>();
  if (node === null || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const item of node) for (const p of propertyNamePaths(item, prefix)) out.add(p);
    return out;
  }
  const record = node as Record<string, unknown>;
  const properties = record["properties"];
  if (properties !== null && typeof properties === "object" && !Array.isArray(properties)) {
    for (const [name, child] of Object.entries(properties as Record<string, unknown>)) {
      const path = prefix === "" ? name : `${prefix}.${name}`;
      out.add(path);
      for (const p of propertyNamePaths(child, path)) out.add(p);
    }
  }
  const items = record["items"];
  if (items !== null && typeof items === "object") {
    for (const p of propertyNamePaths(items, prefix)) out.add(p);
  }
  return out;
}

describe("WP-V1: leanSchema — gating", () => {
  it("vscode + TL_LEAN_CALLS=1 changes the schema; every other combination is byte-identical to the true default", async () => {
    const trueDefault = await toolsFor(undefined);
    const vscodeNoFlag = await withEnv({ TL_LEAN_CALLS: undefined, TL_TURN_ECONOMY: undefined }, () => toolsFor(VSCODE));
    const nonVscodeWithFlag = await withEnv({ TL_LEAN_CALLS: "1" }, () => toolsFor("claude-code"));
    // Descriptions differ by client (clientAdvertisement.ts) even without the
    // lean flag, so compare inputSchema only here.
    const schemasOf = (tools: ToolDef[]) => tools.map((t) => t.inputSchema);
    expect(schemasOf(vscodeNoFlag)).toEqual(schemasOf(trueDefault));
    expect(schemasOf(nonVscodeWithFlag)).toEqual(schemasOf(trueDefault));
  });
});

describe("WP-V1: leanSchema — read_file", () => {
  it("drops top-level oneOf, task.dependentRequired and budget.bytes/budget.tokens, and KEEPS targets[].purpose (steered onto directory targets)", async () => {
    const [lean] = await withEnv({ TL_LEAN_CALLS: "1" }, () => toolsFor(VSCODE));
    const readFile = lean!;
    expect(readFile.name).toBe("read_file");
    expect(readFile.inputSchema["oneOf"]).toBeUndefined();
    const properties = readFile.inputSchema["properties"] as Record<string, SchemaNode>;
    const targetProps = (properties["targets"]!["items"] as SchemaNode)["properties"] as Record<string, unknown>;
    // Orchestrator ruling (2026-09-20): `purpose` is what tells the server what
    // a caller-named DIRECTORY is for, so it stays advertised -- with the one
    // nested description this diet keeps.
    expect(targetProps["purpose"]).toEqual({
      type: "string",
      description: "For a directory target: what to find in it.",
    });
    expect(targetProps["path"]).toBeDefined();
    expect(targetProps["handle"]).toBeDefined();
    expect(targetProps["range"]).toBeDefined();
    const task = properties["task"] as SchemaNode;
    expect(task["dependentRequired"]).toBeUndefined();
    const budget = properties["budget"] as SchemaNode;
    const budgetProps = budget["properties"] as Record<string, unknown>;
    expect(budgetProps["bytes"]).toBeUndefined();
    expect(budgetProps["tokens"]).toBeUndefined();
    // budget is NOT dropped entirely: items/rows/cells/allowFull survive.
    expect(budgetProps["items"]).toBeDefined();
    expect(Object.keys(budgetProps).length).toBeGreaterThan(0);
  });

  it("keeps every property NAME the default schema advertises except budget.bytes/budget.tokens", async () => {
    const [defaultReadFile] = await toolsFor(VSCODE);
    const [leanReadFile] = await withEnv({ TL_LEAN_CALLS: "1" }, () => toolsFor(VSCODE));
    const before = propertyNamePaths(defaultReadFile!.inputSchema);
    const after = propertyNamePaths(leanReadFile!.inputSchema);
    const removed = [...before].filter((p) => !after.has(p));
    const added = [...after].filter((p) => !before.has(p));
    expect(added).toEqual([]);
    expect(removed.sort()).toEqual(["budget.bytes", "budget.tokens"].sort());
  });

  it("describes cwd as edit_file-only / omit on read-search", async () => {
    const [lean] = await withEnv({ TL_LEAN_CALLS: "1" }, () => toolsFor(VSCODE));
    const properties = lean!.inputSchema["properties"] as Record<string, SchemaNode>;
    expect(properties["cwd"]!["description"]).toBe("edit_file only; omit on read/search in a single-root workspace.");
  });

  it("shrinks the advertised bytes by at least 40% versus the vscode default (same rich tool description both sides)", async () => {
    const [defaultReadFile] = await toolsFor(VSCODE);
    const [leanReadFile] = await withEnv({ TL_LEAN_CALLS: "1" }, () => toolsFor(VSCODE));
    const before = Buffer.byteLength(JSON.stringify(defaultReadFile), "utf8");
    const after = Buffer.byteLength(JSON.stringify(leanReadFile), "utf8");
    expect(after, `read_file: ${before} B -> ${after} B`).toBeLessThanOrEqual(before * 0.6);
  });
});

describe("WP-V1: leanSchema — edit_file", () => {
  it("drops top-level anyOf and task.dependentRequired; keeps every edits[]/artifact property name", async () => {
    const [defaultEditFile] = await toolsFor(VSCODE).then((t) => [t.find((x) => x.name === "edit_file")]);
    const [leanEditFile] = await withEnv({ TL_LEAN_CALLS: "1" }, () => toolsFor(VSCODE)).then((t) => [t.find((x) => x.name === "edit_file")]);
    expect(leanEditFile!.inputSchema["anyOf"]).toBeUndefined();
    const properties = leanEditFile!.inputSchema["properties"] as Record<string, SchemaNode>;
    const task = properties["task"] as SchemaNode;
    expect(task["dependentRequired"]).toBeUndefined();
    const before = propertyNamePaths(defaultEditFile!.inputSchema);
    const after = propertyNamePaths(leanEditFile!.inputSchema);
    const removed = [...before].filter((p) => !after.has(p));
    expect(removed).toEqual([]);
  });

  it("shrinks the advertised bytes by at least 40% versus the vscode default", async () => {
    const [defaultEditFile] = await toolsFor(VSCODE).then((t) => [t.find((x) => x.name === "edit_file")]);
    const [leanEditFile] = await withEnv({ TL_LEAN_CALLS: "1" }, () => toolsFor(VSCODE)).then((t) => [t.find((x) => x.name === "edit_file")]);
    const before = Buffer.byteLength(JSON.stringify(defaultEditFile), "utf8");
    const after = Buffer.byteLength(JSON.stringify(leanEditFile), "utf8");
    expect(after, `edit_file: ${before} B -> ${after} B`).toBeLessThanOrEqual(before * 0.6);
  });
});

describe("WP-V1: leanSchema — search_files", () => {
  it("drops top-level oneOf and task.dependentRequired; leaves budget (bytes/tokens/items) untouched", async () => {
    const [defaultSearch] = await toolsFor(VSCODE).then((t) => [t.find((x) => x.name === "search_files")]);
    const [leanSearch] = await withEnv({ TL_LEAN_CALLS: "1" }, () => toolsFor(VSCODE)).then((t) => [t.find((x) => x.name === "search_files")]);
    expect(leanSearch!.inputSchema["oneOf"]).toBeUndefined();
    const properties = leanSearch!.inputSchema["properties"] as Record<string, SchemaNode>;
    const task = properties["task"] as SchemaNode;
    expect(task["dependentRequired"]).toBeUndefined();
    const budgetProps = (properties["budget"] as SchemaNode)["properties"] as Record<string, unknown>;
    expect(budgetProps["bytes"]).toBeDefined();
    expect(budgetProps["tokens"]).toBeDefined();
    expect(budgetProps["items"]).toBeDefined();
    const before = propertyNamePaths(defaultSearch!.inputSchema);
    const after = propertyNamePaths(leanSearch!.inputSchema);
    expect([...before].filter((p) => !after.has(p))).toEqual([]);
  });

  it("shrinks the advertised bytes measurably (search_files starts smallest and keeps its whole budget object, so its OWN ratio is lower than read_file/edit_file -- the brief's >=40% target is over the three schemas TOGETHER, pinned in the combined report below)", async () => {
    const [defaultSearch] = await toolsFor(VSCODE).then((t) => [t.find((x) => x.name === "search_files")]);
    const [leanSearch] = await withEnv({ TL_LEAN_CALLS: "1" }, () => toolsFor(VSCODE)).then((t) => [t.find((x) => x.name === "search_files")]);
    const before = Buffer.byteLength(JSON.stringify(defaultSearch), "utf8");
    const after = Buffer.byteLength(JSON.stringify(leanSearch), "utf8");
    expect(after, `search_files: ${before} B -> ${after} B`).toBeLessThanOrEqual(before * 0.65);
  });
});

describe("WP-V1: leanSchema — combined byte report", () => {
  it("prints the measured before/after per tool (informational; the >=40% claims are pinned per-tool above)", async () => {
    const before = await toolsFor(VSCODE);
    const after = await withEnv({ TL_LEAN_CALLS: "1" }, () => toolsFor(VSCODE));
    let totalBefore = 0;
    let totalAfter = 0;
    for (const tool of before) {
      const a = after.find((t) => t.name === tool.name)!;
      const b = Buffer.byteLength(JSON.stringify(tool), "utf8");
      const c = Buffer.byteLength(JSON.stringify(a), "utf8");
      totalBefore += b;
      totalAfter += c;
      // eslint-disable-next-line no-console
      console.log(`[WP-V1 lean schema] ${tool.name}: ${b} B -> ${c} B (${Math.round((1 - c / b) * 100)}% smaller)`);
    }
    expect(totalAfter).toBeLessThanOrEqual(totalBefore * 0.6);
  });
});
