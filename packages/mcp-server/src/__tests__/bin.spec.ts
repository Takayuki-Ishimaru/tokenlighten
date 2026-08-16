// Unit coverage for bin.ts's CLI flag parsing that does NOT spawn a
// subprocess. bin.ts has top-level side effects when it is the entry script
// (starts the MCP server, or prints a digest and calls process.exit) guarded
// behind an IS_MAIN check, so importing it here — as a module, never as the
// entry — exercises only the pure argv-parsing helper.
//
// Run with:
//   cd packages/mcp-server
//   npx vitest run src/__tests__/bin.spec.ts

import { describe, expect, it } from "vitest";

import { printConfigDigestRequested } from "../bin.js";

describe("printConfigDigestRequested", () => {
  it("recognizes --print-config-digest anywhere in argv", () => {
    expect(printConfigDigestRequested(["--print-config-digest"])).toBe(true);
    expect(printConfigDigestRequested(["--allow-write", "--print-config-digest"])).toBe(true);
    expect(printConfigDigestRequested(["--print-config-digest", "--allow-write"])).toBe(true);
  });

  it("is false for ordinary server argv, including no args", () => {
    expect(printConfigDigestRequested([])).toBe(false);
    expect(printConfigDigestRequested(["--allow-write"])).toBe(false);
    expect(printConfigDigestRequested(["--allowed-parent", "/tmp"])).toBe(false);
    expect(printConfigDigestRequested(["/some/workspace/root"])).toBe(false);
  });
});
