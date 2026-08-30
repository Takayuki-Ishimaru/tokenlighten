import { afterEach, describe, expect, it, vi } from "vitest";
import Ajv2020 from "ajv/dist/2020.js";
import type { AnySchema } from "ajv";

import {
  SCHEMA_DEFS_FLAG_REGISTRY,
  schemaDefsEnabled,
} from "../util/flags.js";

type ToolName = "read_file" | "edit_file" | "search_files";
type JsonObject = Record<string, unknown>;
type AdvertisedTool = { name: ToolName; inputSchema: JsonObject };

const savedSchemaDefs = process.env["TL_SCHEMA_DEFS"];

afterEach(() => {
  if (savedSchemaDefs === undefined) delete process.env["TL_SCHEMA_DEFS"];
  else process.env["TL_SCHEMA_DEFS"] = savedSchemaDefs;
  vi.resetModules();
});

async function loadTools(enabled: boolean): Promise<Record<ToolName, AdvertisedTool>> {
  if (enabled) process.env["TL_SCHEMA_DEFS"] = "1";
  else delete process.env["TL_SCHEMA_DEFS"];
  vi.resetModules();
  const { advertisedTools } = await import("../server.js");
  return Object.fromEntries(
    (advertisedTools() as AdvertisedTool[]).map((tool) => [tool.name, tool]),
  ) as Record<ToolName, AdvertisedTool>;
}

function collectRefs(node: unknown, path = ""): Array<{ path: string; ref: string }> {
  if (node === null || typeof node !== "object") return [];
  if (Array.isArray(node)) {
    return node.flatMap((value, index) => collectRefs(value, `${path}[${index}]`));
  }
  const record = node as JsonObject;
  const own = typeof record["$ref"] === "string" ? [{ path, ref: record["$ref"] }] : [];
  return own.concat(
    Object.entries(record).flatMap(([key, value]) =>
      key === "$ref" ? [] : collectRefs(value, path === "" ? key : `${path}.${key}`),
    ),
  );
}

function expandLocalRefs(schema: JsonObject): JsonObject {
  const defs = (schema["$defs"] ?? {}) as JsonObject;
  const visit = (node: unknown): unknown => {
    if (node === null || typeof node !== "object") return node;
    if (Array.isArray(node)) return node.map(visit);
    const record = node as JsonObject;
    if (typeof record["$ref"] === "string") {
      const match = /^#\/\$defs\/([^/]+)$/.exec(record["$ref"]);
      if (match === null) throw new Error(`non-local or nested ref: ${record["$ref"]}`);
      const definition = defs[match[1]!];
      if (definition === undefined) throw new Error(`missing definition: ${match[1]}`);
      const siblings = Object.fromEntries(
        Object.entries(record).filter(([key]) => key !== "$ref"),
      );
      return visit({ ...(structuredClone(definition) as JsonObject), ...siblings });
    }
    return Object.fromEntries(
      Object.entries(record)
        .filter(([key]) => key !== "$defs")
        .map(([key, value]) => [key, visit(value)]),
    );
  };
  return visit(schema) as JsonObject;
}

describe("F-1 tool-local $defs/$ref schema gate", () => {
  it("is registered fail-closed and accepts only explicit truthy spellings", () => {
    expect(SCHEMA_DEFS_FLAG_REGISTRY).toEqual({
      flag: "TL_SCHEMA_DEFS",
      default: "off",
      off_compatibility: true,
      wire_effect: "tools/list-inputSchema-$defs/$ref",
    });

    delete process.env["TL_SCHEMA_DEFS"];
    expect(schemaDefsEnabled()).toBe(false);
    for (const value of ["1", "true", "YES", "on"]) {
      process.env["TL_SCHEMA_DEFS"] = value;
      expect(schemaDefsEnabled(), value).toBe(true);
    }
    for (const value of ["0", "false", "NO", "off", "", "unexpected"]) {
      process.env["TL_SCHEMA_DEFS"] = value;
      expect(schemaDefsEnabled(), value).toBe(false);
    }
  });

  it("emits shallow tool-local refs that expand exactly to the OFF schemas", async () => {
    const off = await loadTools(false);
    const on = await loadTools(true);
    const expectedPaths: Record<ToolName, string[]> = {
      read_file: [
        "properties.budget",
        "properties.scope",
        "properties.select",
        "properties.targets.items",
        "properties.task",
      ],
      edit_file: [
        "properties.artifact",
        "properties.credentials",
        "properties.edits.items",
        "properties.task",
      ],
      search_files: [
        "properties.budget",
        "properties.scope",
        "properties.task",
      ],
    };
    const expectedDefs: Record<ToolName, string[]> = {
      read_file: ["readBudget", "readScope", "readSelect", "readTarget", "taskControl"],
      edit_file: ["artifact", "credentials", "editItem", "taskControl"],
      search_files: ["searchBudget", "searchScope", "taskControl"],
    };

    for (const name of ["read_file", "edit_file", "search_files"] as const) {
      expect(off[name].inputSchema["$defs"]).toBeUndefined();
      expect(collectRefs(off[name].inputSchema)).toEqual([]);

      const defs = on[name].inputSchema["$defs"] as JsonObject;
      expect(Object.keys(defs).sort()).toEqual(expectedDefs[name]);
      expect(collectRefs(defs), `${name} definitions must not chain refs`).toEqual([]);

      const refs = collectRefs(on[name].inputSchema)
        .filter(({ path }) => !path.startsWith("$defs"))
        .sort((a, b) => a.path.localeCompare(b.path));
      expect(refs.map(({ path }) => path)).toEqual(expectedPaths[name]);
      expect(refs.every(({ ref }) => /^#\/\$defs\/[^/]+$/.test(ref))).toBe(true);
      expect(expandLocalRefs(on[name].inputSchema)).toEqual(off[name].inputSchema);
    }

    const offBytes = Buffer.byteLength(JSON.stringify(Object.values(off)), "utf8");
    const onBytes = Buffer.byteLength(JSON.stringify(Object.values(on)), "utf8");
    console.log(`[F-1-SCHEMA-LEDGER] off=${offBytes} on=${onBytes} delta=${onBytes - offBytes}`);
    expect({ offBytes, onBytes, delta: onBytes - offBytes }).toEqual({
      // 2026-08-29 VS Code items hotfix: artifact.cells/replacements/members
      // gained items schemas (+928 B on both forms; the shared def re-expands
      // identically, so the ON-minus-OFF delta is unchanged at 637).
      offBytes: 13126,
      onBytes: 13763,
      delta: 637,
    });
  }, 30000);

  it("compiles under draft 2020-12 and accepts canonical smoke calls", async () => {
    const on = await loadTools(true);
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    const smoke: Record<ToolName, JsonObject> = {
      read_file: { query: "inspect probe.txt", task: { epoch: "new" }, cwd: "/tmp" },
      edit_file: {
        edits: [{ path: "probe.txt", search: "alpha", replace: "beta" }],
        cwd: "/tmp",
      },
      search_files: { action: "find", queries: ["alpha"], cwd: "/tmp" },
    };

    for (const name of ["read_file", "edit_file", "search_files"] as const) {
      const validate = ajv.compile(on[name].inputSchema as AnySchema);
      expect(validate(smoke[name]), ajv.errorsText(validate.errors)).toBe(true);
    }
  }, 30000);
});
