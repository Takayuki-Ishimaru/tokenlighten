/**
 * canonicalDialectRescue.spec.ts — the FX-2 string-to-structure rescue and its
 * `legacyMembers` (v016 decision 6t-4, 2026-10-19).
 *
 * A stringified carrier is parsed only when the parsed value passes the
 * advertised schema. `legacyMembers` names members the server resolves itself
 * once the value is an object (server.ts: `task.taskProfile`, renamed where a
 * policy accepts it and refused by name otherwise), so a string whose only
 * unknown members are those is parsed too, unnormalized. Anything else stays a
 * string, as before. rc/legacyTaskProfileString.rc.spec.ts holds the wire
 * shapes.
 */

import { describe, expect, it } from "vitest";

import { rescueStringifiedCanonicalFields, type CanonicalDialectRescueDependencies } from "../mcp/transport/canonicalDialectRescue.js";
import { findUnknownProperties, type SchemaNode } from "../validation/requestShape.js";

const SCHEMA: Record<string, SchemaNode> = {
  task: { type: "object", properties: { epoch: { type: "string" }, handle: { type: "string" }, profile: { type: "string" } } },
  scope: { type: "object", properties: { path: { type: "string" } } },
  targets: { type: "array", items: { type: "object", properties: { path: { type: "string" } } } },
};

function deps(legacyMembers?: Readonly<Record<string, readonly string[]>>): CanonicalDialectRescueDependencies {
  return {
    objectFields: ["task", "scope"],
    arrayFields: ["targets"],
    advertisedPropertiesFor: () => SCHEMA,
    findUnknownProperties,
    asObject: (value) => (value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined),
    ...(legacyMembers !== undefined ? { legacyMembers } : {}),
  };
}

const LEGACY = { task: ["taskProfile"] } as const;

describe("rescueStringifiedCanonicalFields legacyMembers", () => {
  it("parses a stringified task whose only unknown member is a legacy one, leaving the member for the caller to resolve", () => {
    const out = rescueStringifiedCanonicalFields("tl_read_file", { task: "{\"epoch\":\"new\",\"taskProfile\":\"generic\"}" }, deps(LEGACY));
    expect(out["task"]).toEqual({ epoch: "new", taskProfile: "generic" });
  });

  it("keeps the string when another unknown member rides beside the legacy one", () => {
    const raw = "{\"epoch\":\"new\",\"taskProfile\":\"generic\",\"profil\":\"answer\"}";
    expect(rescueStringifiedCanonicalFields("tl_read_file", { task: raw }, deps(LEGACY))["task"]).toBe(raw);
  });

  it("keeps the string without legacyMembers (the schema alone decides)", () => {
    const raw = "{\"epoch\":\"new\",\"taskProfile\":\"generic\"}";
    expect(rescueStringifiedCanonicalFields("tl_read_file", { task: raw }, deps())["task"]).toBe(raw);
  });

  it("scopes a legacy member to its own field", () => {
    const raw = "{\"path\":\"src\",\"taskProfile\":\"generic\"}";
    expect(rescueStringifiedCanonicalFields("tl_read_file", { scope: raw }, deps(LEGACY))["scope"]).toBe(raw);
  });

  it("still parses a fully advertised string and leaves arrays to the schema", () => {
    const out = rescueStringifiedCanonicalFields(
      "tl_read_file",
      { task: "{\"handle\":\"tlh_task_v1_x\",\"profile\":\"generic\"}", targets: "[{\"path\":\"a.ts\",\"taskProfile\":\"generic\"}]" },
      deps(LEGACY),
    );
    expect(out["task"]).toEqual({ handle: "tlh_task_v1_x", profile: "generic" });
    expect(out["targets"]).toBe("[{\"path\":\"a.ts\",\"taskProfile\":\"generic\"}]");
  });
});
