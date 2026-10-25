/**
 * schemaStamp.spec.ts — deterministic content fingerprint of the advertised
 * tools/list surface (VS Code MCP definition-cache mitigation, v0.13.0; see
 * util/schemaStamp.ts's file header for the full incident/rationale).
 *
 * Contract pinned here, against the REAL advertisedTools() output (never a
 * mock of advertisedTools itself — D-W5 discipline):
 *   1. Same schema -> same stamp, call after call (pure function of content).
 *   2. A genuine change to the advertised surface -> a different stamp.
 *   3. stableStringify is insensitive to object-key declaration order but
 *      sensitive to array element order.
 *   4. The stamp is exactly 16 lowercase hex characters.
 *   5. Integration sanity: once built, dist/bin.js's --print-schema-stamp
 *      flag prints the identical value this source-level call computes.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { advertisedTools, stampedToolSurfaces } from "../server.js";
import { computeSchemaStamp, stableStringify } from "../util/schemaStamp.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STAMP_RE = /^[0-9a-f]{16}$/;

describe("computeSchemaStamp", () => {
  it("is a pure, deterministic function of the real advertised tool surface", () => {
    const tools = advertisedTools();
    expect(tools.length).toBeGreaterThan(0);
    const first = computeSchemaStamp(tools);
    const second = computeSchemaStamp(advertisedTools());
    expect(first).toBe(second);
    expect(first).toMatch(STAMP_RE);
  });

  it("changes when the real advertised surface is genuinely mutated", () => {
    const tools = advertisedTools();
    const baseline = computeSchemaStamp(tools);

    // Mutate a deep clone of the REAL served tools (not a synthetic mock) so
    // this exercises computeSchemaStamp against actual tool-schema shapes —
    // a changed description text is exactly the kind of edit that must be
    // visible as a changed stamp.
    const mutated = structuredClone(tools) as Array<{ description?: string }>;
    expect(mutated[0]).toBeDefined();
    mutated[0]!.description = `${mutated[0]!.description ?? ""} (mutated for test)`;
    const mutatedStamp = computeSchemaStamp(mutated);

    expect(mutatedStamp).not.toBe(baseline);
    expect(mutatedStamp).toMatch(STAMP_RE);
  });

  it("is unaffected by reordering an unrelated later tool while the first tool is untouched", () => {
    const tools = advertisedTools();
    if (tools.length < 2) return; // needs at least 2 advertised tools to reorder
    const reordered = [...tools].reverse();
    // Reordering the TOP-LEVEL array is itself a real (if narrow) surface
    // change from the client's perspective (tools/list order), so the stamp
    // is expected to move — this asserts array order is NOT silently
    // canonicalized away, matching stableStringify's documented contract.
    expect(computeSchemaStamp(reordered)).not.toBe(computeSchemaStamp(tools));
  });
});

describe("stableStringify", () => {
  it("is insensitive to object key declaration order", () => {
    const a = { zebra: 1, apple: { nested: true, alpha: [1, 2] } };
    const b = { apple: { alpha: [1, 2], nested: true }, zebra: 1 };
    expect(stableStringify(a)).toBe(stableStringify(b));
  });

  it("is sensitive to array element order", () => {
    expect(stableStringify([1, 2, 3])).not.toBe(stableStringify([3, 2, 1]));
  });

  it("normalizes undefined the same way JSON.stringify does inside an array", () => {
    expect(stableStringify([undefined])).toBe(JSON.stringify([undefined]));
  });
});

describe("--print-schema-stamp (bin.ts) integration sanity", () => {
  it("the built dist/bin.js prints the identical stamp this source-level call computes", () => {
    const binPath = path.resolve(HERE, "..", "..", "dist", "bin.js");
    if (!fs.existsSync(binPath)) return; // dist not built in this checkout
    const proc = spawnSync(process.execPath, [binPath, "--print-schema-stamp"], {
      encoding: "utf8",
    });
    expect(proc.status, proc.stderr).toBe(0);
    const printed = proc.stdout.trim();
    expect(printed).toMatch(STAMP_RE);
    // Best-effort: only a valid comparison if the built dist reflects this
    // same checkout's source (true for a normal `npm run build` workflow).
    expect(printed).toBe(computeSchemaStamp(stampedToolSurfaces()));
  });

  // 2026-10-22 (v0.16.0 release verification): the portable read cwd hint
  // names the process's root, so the stamp moved with the directory it was
  // computed from — the VS Code build (its package directory) and CI (the
  // repository root) always disagreed. The stamp now uses one fixed root.
  it("prints the same stamp from another working directory", () => {
    const binPath = path.resolve(HERE, "..", "..", "dist", "bin.js");
    if (!fs.existsSync(binPath)) return; // dist not built in this checkout
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "tl-stamp-cwd-"));
    try {
      const proc = spawnSync(process.execPath, [binPath, "--print-schema-stamp"], { encoding: "utf8", cwd: elsewhere });
      expect(proc.status, proc.stderr).toBe(0);
      expect(proc.stdout.trim()).toBe(computeSchemaStamp(stampedToolSurfaces()));
    } finally {
      fs.rmSync(elsewhere, { recursive: true, force: true });
    }
    const hints = (stampedToolSurfaces() as Array<Array<{ name: string; inputSchema: { properties: Record<string, { description?: string }> } }>>)
      .flatMap((tools) => tools.filter((tool) => tool.name === "tl_read_file"))
      .map((tool) => tool.inputSchema.properties["cwd"]?.description)
      .filter((description) => description?.startsWith("Workspace cwd:"));
    expect(hints.length).toBeGreaterThan(0);
    expect(new Set(hints)).toEqual(new Set(['Workspace cwd: "/workspace"; no pwd.']));
  });
});

// Copilot retest r5 (2026-10-03): TL_MINIMAL_TOOLS changed only what a VS Code
// client receives under the VS Code setup's TL_TURN_ECONOMY=1, and a stamp
// over the default advertisement alone stayed byte-identical (500a3167… both
// before and after), so VS Code could keep its cached tool definitions.
describe("the stamp covers the VS Code setup's own advertisement", () => {
  function withEnv<T>(env: Readonly<Record<string, string | undefined>>, fn: () => T): T {
    const saved: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(env)) {
      saved[key] = process.env[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    try {
      return fn();
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }

  it("changes when only the vscode advertisement changes, and leaves the ambient TL_TURN_ECONOMY as it found it", () => {
    const minimal = withEnv({ TL_TURN_ECONOMY: undefined, TL_MINIMAL_TOOLS: undefined }, () => computeSchemaStamp(stampedToolSurfaces()));
    const r4Tier = withEnv({ TL_TURN_ECONOMY: undefined, TL_MINIMAL_TOOLS: "0" }, () => computeSchemaStamp(stampedToolSurfaces()));
    expect(withEnv({ TL_TURN_ECONOMY: undefined, TL_MINIMAL_TOOLS: undefined }, () => computeSchemaStamp(advertisedTools())))
      .toBe(withEnv({ TL_TURN_ECONOMY: undefined, TL_MINIMAL_TOOLS: "0" }, () => computeSchemaStamp(advertisedTools())));
    expect(minimal).not.toBe(r4Tier);
    withEnv({ TL_TURN_ECONOMY: undefined }, () => {
      stampedToolSurfaces();
      expect(process.env["TL_TURN_ECONOMY"]).toBeUndefined();
    });
    withEnv({ TL_TURN_ECONOMY: "0" }, () => {
      stampedToolSurfaces();
      expect(process.env["TL_TURN_ECONOMY"]).toBe("0");
    });
  });
});
