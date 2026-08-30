/**
 * schemaStamp.spec.ts — drift guard for the GENERATED
 * src/generated/schemaStamp.ts (VS Code MCP definition-cache mitigation,
 * v0.13.0; see packages/mcp-server/src/util/schemaStamp.ts for the full
 * rationale).
 *
 * src/generated/schemaStamp.ts is committed (not gitignored) so a tool-
 * schema change is visible in the same diff as the code that caused it —
 * exactly like packages/agents-md's generated guide blocks and
 * onboarded_block.spec.mjs's drift guard for them. This spec is the
 * equivalent guard for the schema stamp: it fails whenever the committed
 * value no longer matches what @tokenlighten/mcp-server's CURRENT source
 * would produce, i.e. whenever someone forgot to rerun
 * `node scripts/generate-schema-stamp.mjs` (or the build step that runs it)
 * after changing an advertised tool's schema.
 */
import { describe, expect, it } from "vitest";
import { currentSchemaStamp } from "@tokenlighten/mcp-server";
import { TOKENLIGHTEN_SCHEMA_STAMP } from "../generated/schemaStamp.js";

describe("generated schema stamp", () => {
  it("is exactly 16 lowercase hex characters", () => {
    expect(TOKENLIGHTEN_SCHEMA_STAMP).toMatch(/^[0-9a-f]{16}$/);
  });

  it("matches @tokenlighten/mcp-server's current advertised tool surface (regenerate with: node scripts/generate-schema-stamp.mjs)", () => {
    expect(TOKENLIGHTEN_SCHEMA_STAMP).toBe(currentSchemaStamp());
  });
});
