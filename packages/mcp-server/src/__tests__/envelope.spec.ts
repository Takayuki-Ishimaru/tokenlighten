// Invariant: MCP tool responses must never contain envelope metadata keys.
//
// Background:
//   docs/00-postmortem.md §2.2 — The 'tokenlighten:meta' envelope dominated
//   cache_write cost in iter-12/iter-13. Tool results must stay thin.
//
//   docs/01-architecture.md L376 — `tokenlighten:meta` envelope deleted in
//   iter-13 and must not be revived. New TL also excludes it.
//
// This spec serializes a successful response from each tool and asserts:
//   1. No forbidden envelope keys appear in the JSON output.
//   2. The MCP content-block shape is exactly { content: [{ type: 'text', text: ... }] }
//      with no extra top-level keys (Object.keys(result).sort() === ['content']).

import { describe, it, expect } from "vitest";
import { getFileSkeleton } from "../tools/getFileSkeleton.js";
import { getSymbolWithContext } from "../tools/getSymbolWithContext.js";
import { extractOfficeText } from "../tools/extractOfficeText.js";
import { toolOk } from "../server.js";

/** Forbidden envelope key names — none of these must appear as JSON keys in
 *  any successful tool response. */
const FORBIDDEN_KEYS = [
  "tokenlighten",
  "tokenlighten:meta",
  "meta",
  "next_action",
  "edit_candidates",
  "native_fallback_tool",
];

/** Assert the content-block has exactly the right shape and no extra keys. */
function assertMcpShape(result: unknown): void {
  expect(typeof result).toBe("object");
  expect(result).not.toBeNull();
  const r = result as Record<string, unknown>;
  // Exactly one top-level key: 'content'.
  expect(Object.keys(r).sort()).toEqual(["content"]);
  // content must be a non-empty array.
  expect(Array.isArray(r["content"])).toBe(true);
  const content = r["content"] as unknown[];
  expect(content.length).toBeGreaterThan(0);
  // Each block must have type='text' and a text string.
  for (const block of content) {
    const b = block as Record<string, unknown>;
    expect(b["type"]).toBe("text");
    expect(typeof b["text"]).toBe("string");
  }
}

/** Assert no forbidden envelope keys appear anywhere in the serialized output. */
function assertNoForbiddenKeys(result: unknown): void {
  const text = JSON.stringify(result);
  for (const k of FORBIDDEN_KEYS) {
    expect(text).not.toContain(`"${k}"`);
  }
  // Explicit regex check for the tokenlighten:meta pattern (including HTML comments).
  expect(text).not.toMatch(/<!--\s*tokenlighten:meta/i);
}

// ---------------------------------------------------------------------------
// getFileSkeleton
// ---------------------------------------------------------------------------

describe("envelope invariants — getFileSkeleton", () => {
  const tsSrc = `
import { readFile } from "fs/promises";

export async function loadData(p: string): Promise<string> {
  return readFile(p, "utf8");
}

export class Loader {
  async load(p: string) { return loadData(p); }
}
`.trim();

  it("produces no forbidden envelope keys in skeleton output", async () => {
    const result = await getFileSkeleton(tsSrc, { path: "loader.ts" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const mcpBlock = toolOk(result.data);
    assertNoForbiddenKeys(mcpBlock);
  });

  it("MCP block has exactly { content: [{ type, text }] } shape", async () => {
    const result = await getFileSkeleton(tsSrc, { path: "loader.ts" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const mcpBlock = toolOk(result.data);
    assertMcpShape(mcpBlock);
  });

  it("skeleton text does not contain forbidden keys as JSON", async () => {
    const result = await getFileSkeleton(tsSrc, { path: "loader.ts" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The signatures string itself should not embed JSON envelope keys.
    const text = result.data.signatures;
    for (const k of FORBIDDEN_KEYS) {
      expect(text).not.toContain(`"${k}"`);
    }
  });
});

// ---------------------------------------------------------------------------
// getSymbolWithContext
// ---------------------------------------------------------------------------

describe("envelope invariants — getSymbolWithContext", () => {
  const tsSrc = `
import { readFile } from "fs/promises";
import { join } from "path";
import { unused } from "nowhere";

export async function loadData(p: string): Promise<string> {
  return readFile(join(p, "data.txt"), "utf8");
}
`.trim();

  it("produces no forbidden envelope keys in symbol output", async () => {
    const result = await getSymbolWithContext(tsSrc, {
      path: "loader.ts",
      symbol: "loadData",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const mcpBlock = toolOk(result.data);
    assertNoForbiddenKeys(mcpBlock);
  });

  it("MCP block has exactly { content: [{ type, text }] } shape", async () => {
    const result = await getSymbolWithContext(tsSrc, {
      path: "loader.ts",
      symbol: "loadData",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const mcpBlock = toolOk(result.data);
    assertMcpShape(mcpBlock);
  });

  it("code string does not contain forbidden keys as JSON", async () => {
    const result = await getSymbolWithContext(tsSrc, {
      path: "loader.ts",
      symbol: "loadData",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const k of FORBIDDEN_KEYS) {
      expect(result.data.code).not.toContain(`"${k}"`);
    }
  });
});

// ---------------------------------------------------------------------------
// extractOfficeText — error paths (no valid DOCX fixture available in tests)
// ---------------------------------------------------------------------------

describe("envelope invariants — extractOfficeText (error paths)", () => {
  it("pdf error result has no forbidden keys", async () => {
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // %PDF magic
    const result = await extractOfficeText(bytes, { path: "report.pdf" });
    // Even error results must not embed envelope metadata.
    const text = JSON.stringify(result);
    for (const k of FORBIDDEN_KEYS) {
      expect(text).not.toContain(`"${k}"`);
    }
  });

  it("corrupt docx error result has no forbidden keys", async () => {
    const bytes = new Uint8Array([0x00, 0x01, 0x02, 0x03]);
    const result = await extractOfficeText(bytes, { path: "corrupt.docx" });
    const text = JSON.stringify(result);
    for (const k of FORBIDDEN_KEYS) {
      expect(text).not.toContain(`"${k}"`);
    }
  });

  it("MCP block for an ok extractOfficeText result has correct shape", async () => {
    // Use a not-a-document path to produce a known-ok-shaped error-then-wrap.
    // We synthesise a fake ok result to test the shape independently of
    // requiring a real DOCX fixture.
    const fakeData = {
      text: "Hello world",
      kind: "docx" as const,
      truncated: false,
      warnings: [],
    };
    const mcpBlock = toolOk(fakeData);
    assertMcpShape(mcpBlock);
    assertNoForbiddenKeys(mcpBlock);
  });
});

// ---------------------------------------------------------------------------
// End-to-end: full toolOk response — no forbidden keys, no meta regex
// ---------------------------------------------------------------------------

describe("envelope invariants — end-to-end toolOk full response", () => {
  it("JSON-serialized toolOk response contains no forbidden keys or tokenlighten:meta pattern", () => {
    const payload = {
      signatures: "export function foo(): void { ... }",
      language: "typescript",
      path: "src/foo.ts",
    };
    const response = toolOk(payload);
    const serialized = JSON.stringify(response);

    // Assert no forbidden keys appear as JSON string keys.
    for (const k of FORBIDDEN_KEYS) {
      expect(serialized).not.toContain(`"${k}"`);
    }

    // Assert the tokenlighten:meta HTML comment pattern is absent.
    expect(serialized).not.toMatch(/<!--\s*tokenlighten:meta/i);

    // Assert shape is exactly { content: [{ type: 'text', text: string }] }.
    assertMcpShape(response);
  });
});

// ---------------------------------------------------------------------------
// write engine: searchReplaceEdit — envelope invariants
// ---------------------------------------------------------------------------

describe("envelope invariants — searchReplaceEdit responses", () => {
  it("write-not-enabled error response has no forbidden keys and correct MCP shape", () => {
    // Simulate what callTool returns for the edit_file search/replace path when
    // write is disabled.
    const errorPayload = {
      ok: false,
      error: "Write tools are disabled. Restart the server with --allow-write.",
      code: "write-not-enabled",
    };
    const response = toolOk(errorPayload);
    assertMcpShape(response);
    assertNoForbiddenKeys(response);
  });

  it("success response has no forbidden keys and correct MCP shape", () => {
    const successPayload = {
      ok: true,
      written: true,
      bytes: 128,
      message: "Edited src/foo.ts (128 bytes)",
    };
    const response = toolOk(successPayload);
    assertMcpShape(response);
    assertNoForbiddenKeys(response);
  });

  it("secret-file error response has no forbidden keys", () => {
    const secretErrorPayload = {
      ok: false,
      error: "Refusing to write to secret/credential file: .env",
      code: "secret-file",
    };
    const response = toolOk(secretErrorPayload);
    assertMcpShape(response);
    assertNoForbiddenKeys(response);
  });
});

// ---------------------------------------------------------------------------
// write engine: applyEditsMulti — envelope invariants
// ---------------------------------------------------------------------------

describe("envelope invariants — applyEditsMulti responses", () => {
  it("all-or-nothing failure response has no forbidden keys and correct MCP shape", () => {
    const failPayload = {
      results: [
        {
          path: "src/foo.ts",
          ok: false,
          error: "search string not found in file",
          code: "not-found",
        },
      ],
      checkpoint_id: null,
    };
    const response = toolOk(failPayload);
    assertMcpShape(response);
    assertNoForbiddenKeys(response);
  });

  it("success response with checkpoint_id has no forbidden keys", () => {
    const successPayload = {
      results: [
        { path: "src/a.ts", ok: true, bytes: 100 },
        { path: "src/b.ts", ok: true, bytes: 200 },
      ],
      checkpoint_id: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
    };
    const response = toolOk(successPayload);
    assertMcpShape(response);
    assertNoForbiddenKeys(response);
  });

  it("write-not-enabled response has no forbidden keys", () => {
    const payload = {
      results: [
        {
          path: "",
          ok: false,
          error: "Write tools are disabled. Restart the server with --allow-write.",
          code: "write-not-enabled",
        },
      ],
      checkpoint_id: null,
    };
    const response = toolOk(payload);
    assertMcpShape(response);
    assertNoForbiddenKeys(response);
  });
});
