import { describe, expect, it } from "vitest";

import { advertisedTools, callTool } from "../server.js";

function payload(result: Awaited<ReturnType<typeof callTool>>): Record<string, unknown> {
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}

describe("edit_file artifact dispatch", () => {
  it("advertises credential references and the structured artifact envelope", () => {
    const edit = advertisedTools().find((tool) => tool.name === "edit_file") as
      | { inputSchema: { properties: Record<string, unknown> } }
      | undefined;
    const properties = edit?.inputSchema.properties ?? {};
    const credentials = properties["credentials"] as {
      properties?: Record<string, unknown>;
      additionalProperties?: boolean;
    };
    expect(credentials.properties?.["in"]).toBeDefined();
    expect(credentials.properties?.["out"]).toBeDefined();
    expect(credentials.additionalProperties).toBe(false);
    expect(properties["credentialRef"]).toBeUndefined();
    expect(properties["outputCredentialRef"]).toBeUndefined();
    expect(properties["artifact"]).toMatchObject({ additionalProperties: false });
  });

  it("refuses the exact binary search/replace call shape before it can corrupt a document", async () => {
    const result = await callTool("edit_file", {
      path: "protected.pdf",
      search: "before",
      replace: "after",
    });

    expect(payload(result)).toMatchObject({
      code: "artifact-edit-required",
      path: "protected.pdf",
    });
  });

  it("routes a structured XLSX edit through the write gate", async () => {
    const result = await callTool("edit_file", {
      path: "protected.xlsx",
      credentialRef: "project-docs",
      artifact: {
        kind: "xlsx",
        cells: [{ sheet: "Data", cell: "B2", value: "after" }],
      },
    });

    const parsed = payload(result);
    expect(parsed["code"]).toBe("credential-not-found");
    expect(JSON.stringify(parsed)).not.toContain("password");
  });
});
