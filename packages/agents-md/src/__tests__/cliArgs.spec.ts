// tl-agents CLI argument parsing (packages/agents-md/src/cliArgs.ts).
//
// cliArgs.ts was split out of cli.ts in the 2026-08-27 compact/medium
// first-class wave specifically so --profile parsing (including the new
// "compact" value) could be unit-tested: cli.ts's own top-level
// `main().catch(...)` runs unconditionally at import time (it is the
// package's `bin` script), so importing cli.ts from a test would execute
// main() against the test runner's own process.argv and could call
// process.exit mid-suite. This file never imports cli.ts.

import { describe, it, expect } from "vitest";
import { parseArgs, CliArgError, VALID_PROFILES, VALID_TARGETS, VALID_LOCALES } from "../cliArgs.js";

describe("tl-agents CLI argument parsing", () => {
  it("parses --profile compact on the update command", () => {
    const parsed = parseArgs(["node", "cli.js", "update", "--profile", "compact"]);
    expect(parsed.command).toBe("update");
    expect(parsed.profile).toBe("compact");
  });

  it("parses --profile compact together with --locale jp and --targets", () => {
    const parsed = parseArgs([
      "node", "cli.js", "update",
      "--profile", "compact",
      "--locale", "jp",
      "--targets", "claude,cursor",
    ]);
    expect(parsed.profile).toBe("compact");
    expect(parsed.locale).toBe("jp");
    expect(parsed.targets).toEqual(["claude", "cursor"]);
  });

  it("still parses the existing full/medium profiles unchanged", () => {
    expect(parseArgs(["node", "cli.js", "update", "--profile", "full"]).profile).toBe("full");
    expect(parseArgs(["node", "cli.js", "update", "--profile", "medium"]).profile).toBe("medium");
  });

  it("leaves profile undefined when the flag is omitted (injectAll applies the full default)", () => {
    expect(parseArgs(["node", "cli.js", "update"]).profile).toBeUndefined();
  });

  it("throws CliArgError — never process.exit — for an unknown profile, and lists compact as valid", () => {
    let caught: unknown;
    try {
      parseArgs(["node", "cli.js", "update", "--profile", "bogus"]);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CliArgError);
    expect((caught as Error).message).toContain("compact");
  });

  it("advertises exactly full, medium, compact as valid profiles", () => {
    expect(VALID_PROFILES).toEqual(["full", "medium", "compact"]);
  });

  it("bare flags before the command still default to the update command", () => {
    const parsed = parseArgs(["node", "cli.js", "--profile", "compact"]);
    expect(parsed.command).toBe("update");
    expect(parsed.profile).toBe("compact");
  });

  it("still advertises the pre-existing targets and locales unchanged", () => {
    expect(VALID_TARGETS).toEqual(["claude", "copilot", "cursor", "cline", "continue"]);
    expect(VALID_LOCALES).toEqual(["en", "jp"]);
  });
});
