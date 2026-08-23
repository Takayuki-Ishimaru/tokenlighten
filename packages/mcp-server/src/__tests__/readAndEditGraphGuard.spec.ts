// readAndEditGraphGuard.spec.ts — F-B7 (v0.11 wave C): attemptGraphImpactProbe
// wired into readAndEdit's symbol-bearing edit path, behind TL_FAST_PATH_V2
// (+TL_GRAPH_EVIDENCE for the probe half, via attemptGraphImpactProbe's own
// internal gate) — mirrors tools/searchReplaceEdit.ts's identical seam.
// Mirrors impactGuard.spec.ts's own "cross-cutting fixture" real tl-graph.json
// pattern, driven end-to-end through readAndEdit() rather than
// attemptGraphImpactProbe() directly.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { readAndEdit } from "../tools/readAndEdit.js";
import { unsafeGuardedWorkspaceRootForTests, type GuardedWorkspaceRoot } from "../write/guardedWorkspace.js";
import { resetMissingLoggedForTest } from "../graph/index.js";
import { getTracePath, setTraceEnabledForTest } from "../util/trace.js";

const tmpDirs: string[] = [];

function mkWorkspace(): GuardedWorkspaceRoot {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tl-rae-graph-guard-"));
  tmpDirs.push(dir);
  return unsafeGuardedWorkspaceRootForTests(dir);
}

function write(workspace: string, rel: string, content: string): void {
  const abs = path.join(workspace, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
}

function readFile(workspace: string, rel: string): string {
  return fs.readFileSync(path.join(workspace, rel), "utf8");
}

function readTraceRecords(workspace: string): Array<Record<string, unknown>> {
  const p = getTracePath(workspace);
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, "utf8")
    .trim()
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

// The edited line ("void name;", inside the method body) is deliberately NOT
// the class's own export/declaration line and contains neither "export" nor
// "public" — evaluateCheapImpactSignals' local signals stay silent, so a
// "not-local" verdict below can only be the GRAPH half this wave wires in,
// never the pre-existing cheap half classifier.ts already had.
const REGISTRY_TEXT = [
  "export class Registry {",
  "  register(name: string): void {",
  "    void name;",
  "  }",
  "}",
  "",
].join("\n");
const PLUGIN_TEXT = 'import { Registry } from "./registry.js";\nexport class Plugin extends Registry {}\n';
const CONSUMER_TEXT = 'import { Registry } from "./registry.js";\nexport function consume(r: Registry): void {}\n';

function writeGraphFixture(workspace: string, referencingFiles: readonly string[]): void {
  write(workspace, "src/registry.ts", REGISTRY_TEXT);
  if (referencingFiles.includes("src/plugin.ts")) write(workspace, "src/plugin.ts", PLUGIN_TEXT);
  if (referencingFiles.includes("src/consumer.ts")) write(workspace, "src/consumer.ts", CONSUMER_TEXT);
  write(
    workspace,
    path.join(".tokenlighten", "index", "tl-graph.json"),
    JSON.stringify({
      version: 1,
      rootHash: `root-readandedit-${referencingFiles.length}`,
      symbols: [
        {
          name: "Registry",
          definition: { path: "src/registry.ts", line: 1, column: 0 },
          references: referencingFiles.map((p) => ({ path: p, line: 1, column: 0 })),
        },
      ],
      files: [],
    }),
  );
}

async function editRegistry(ws: GuardedWorkspaceRoot) {
  return readAndEdit(
    { path: "src/registry.ts", symbol: "Registry", search: "void name;", replace: "void name; // noop" },
    ws,
    true,
  );
}

const FLAG_KEYS = ["TL_FAST_PATH_V2", "TL_GRAPH_EVIDENCE"] as const;
let savedFlags: Record<string, string | undefined>;

beforeEach(() => {
  resetMissingLoggedForTest();
  savedFlags = {};
  for (const key of FLAG_KEYS) {
    savedFlags[key] = process.env[key];
    delete process.env[key];
  }
  setTraceEnabledForTest(true);
});

afterEach(() => {
  resetMissingLoggedForTest();
  for (const [key, value] of Object.entries(savedFlags)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  setTraceEnabledForTest(false);
  for (const dir of tmpDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
});

describe("F-B7: readAndEdit's TL_FAST_PATH_V2 graph guard wiring", () => {
  it("an exported symbol with >1 graph-proven consumers traces guard=not-local", async () => {
    process.env["TL_FAST_PATH_V2"] = "1";
    process.env["TL_GRAPH_EVIDENCE"] = "1";
    const ws = mkWorkspace();
    writeGraphFixture(ws, ["src/plugin.ts", "src/consumer.ts"]);

    const result = await editRegistry(ws);

    expect(result.ok).toBe(true);
    const records = readTraceRecords(ws).filter((r) => r["event"] === "fast_path_v2_guard");
    expect(records.length).toBe(1);
    const guard = records[0]!["guard"] as { verdict: string; reasons: string[] };
    expect(guard.verdict).toBe("not-local");
    expect(guard.reasons).toContain("graph-required-consumers:2");
    // Isolates the GRAPH signal: the edited line trips no cheap signal on
    // its own (see REGISTRY_TEXT's comment above).
    expect(guard.reasons).toEqual(["graph-required-consumers:2"]);
  });

  it("the SAME symbol with only 1 referencing file traces guard=local — proves the threshold is >1, not merely >0", async () => {
    process.env["TL_FAST_PATH_V2"] = "1";
    process.env["TL_GRAPH_EVIDENCE"] = "1";
    const ws = mkWorkspace();
    writeGraphFixture(ws, ["src/plugin.ts"]);

    const result = await editRegistry(ws);

    expect(result.ok).toBe(true);
    const records = readTraceRecords(ws).filter((r) => r["event"] === "fast_path_v2_guard");
    expect(records.length).toBe(1);
    const guard = records[0]!["guard"] as { verdict: string };
    expect(guard.verdict).toBe("local");
  });

  it("a not-local verdict never blocks the edit — it routes to the SAME success shape this path already returns, never a new refusal", async () => {
    process.env["TL_FAST_PATH_V2"] = "1";
    process.env["TL_GRAPH_EVIDENCE"] = "1";
    const ws = mkWorkspace();
    writeGraphFixture(ws, ["src/plugin.ts", "src/consumer.ts"]);

    const result = await editRegistry(ws);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.context).toContain("Registry");
    expect(result.edit.path).toBe("src/registry.ts");
    expect(readFile(ws, "src/registry.ts")).toContain("void name; // noop");

    const records = readTraceRecords(ws).filter((r) => r["event"] === "fast_path_v2_guard");
    expect(records[0]!["fast_path_eligible"]).toBe(false); // not-local => never fast-path eligible
  });

  it("TL_GRAPH_EVIDENCE off (TL_FAST_PATH_V2 alone): the graph half never attempts, guard stays local from cheap signals only", async () => {
    process.env["TL_FAST_PATH_V2"] = "1";
    const ws = mkWorkspace();
    writeGraphFixture(ws, ["src/plugin.ts", "src/consumer.ts"]);

    const result = await editRegistry(ws);

    expect(result.ok).toBe(true);
    const records = readTraceRecords(ws).filter((r) => r["event"] === "fast_path_v2_guard");
    expect(records.length).toBe(1);
    const guard = records[0]!["guard"] as { verdict: string; reasons: string[] };
    expect(guard.verdict).toBe("local");
    expect(guard.reasons).toEqual([]);
  });

  it("flag-off (TL_FAST_PATH_V2 unset): byte-identical to pre-F-B7 — no trace record, same edit outcome as flag-on", async () => {
    const ws = mkWorkspace();
    writeGraphFixture(ws, ["src/plugin.ts", "src/consumer.ts"]);

    const result = await editRegistry(ws);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(readFile(ws, "src/registry.ts")).toContain("void name; // noop");

    const records = readTraceRecords(ws).filter((r) => r["event"] === "fast_path_v2_guard");
    expect(records.length).toBe(0);
  });
});
