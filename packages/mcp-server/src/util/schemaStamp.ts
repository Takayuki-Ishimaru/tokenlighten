// schemaStamp.ts — deterministic content fingerprint of the tools this
// server advertises via tools/list (server.ts's advertisedTools()).
//
// WHY THIS EXISTS (VS Code MCP definition-cache mitigation, v0.13.0):
// VS Code persistently caches the tool list it receives from a registered MCP
// server DEFINITION. Real-machine reproduction showed that a tool schema
// failing VS Code's own client-side validation can wedge that cache so hard
// that a plain window reload or an extension reinstall never recovers it —
// only re-registering under a brand-new server definition identity did.
// This stamp gives every consumer that can signal "the definition changed"
// (packages/vscode-extension's McpStdioServerDefinition.version field, and
// the TOKENLIGHTEN_SCHEMA_STAMP env value the CLI writes into generated
// .vscode/mcp.json / .mcp.json / .codex/config.toml) a concrete,
// content-derived value to change — so a genuine advertised-schema change is
// visible as a genuine definition/config change, without the server itself
// ever reading or reacting to it. See packages/vscode-extension/src/
// mcpProvider.ts and packages/cli/src/commands/workspace.ts.
//
// Deliberately NOT the current time, a git SHA, or a package version: any of
// those change on every build/release even when the advertised tool surface
// (names, descriptions, JSON schemas) is byte-for-byte identical, which would
// tell VS Code to distrust its cache on every single update forever — the
// overwhelming majority of which never touch the tool surface at all — and
// defeat the entire point of a change-triggered signal.
//
// Deliberately free of any import from server.ts (or anything that imports
// it): every other packages/mcp-server/src/util/*.ts module is a leaf
// dependency server.ts imports FROM, never the reverse, and this module
// keeps that shape. Callers compose it with server.ts's advertisedTools()
// themselves (see index.ts's currentSchemaStamp() and bin.ts's
// --print-schema-stamp handler) rather than this module reaching upward.

import { createHash } from "node:crypto";

/**
 * Deterministic JSON serialization: sorts object keys at every nesting level
 * so property-declaration-order churn in source (which plain JSON.stringify
 * would otherwise faithfully preserve) never perturbs the resulting stamp.
 * Array element ORDER is preserved as-is — the advertised tool order is
 * itself part of the surface being fingerprinted.
 */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(",")}}`;
  }
  // JSON.stringify(undefined) returns the JS value `undefined`, not a
  // string — normalize it to the literal "null" the way JSON.stringify
  // already does for `undefined` nested inside an array.
  return JSON.stringify(value) ?? "null";
}

/**
 * SHA-256 over the stable serialization, truncated to 16 lowercase hex
 * characters (64 bits) — enough entropy that an accidental collision between
 * two genuinely different advertised tool surfaces is not a practical
 * concern, while staying short enough to read comfortably inside a `version`
 * field or a single env var value.
 */
export function computeSchemaStamp(tools: readonly unknown[]): string {
  return createHash("sha256")
    .update(stableStringify(tools), "utf8")
    .digest("hex")
    .slice(0, 16);
}
