import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readUsageEvents } from "@tokenlighten/usage";

const originalArgv = [...process.argv];
const originalNodeEnv = process.env["NODE_ENV"];
const originalLogHome = process.env["TOKENLIGHTEN_LOG_HOME"];
// The diagnostics ring file (packages/usage's diagRing.ts) is keyed off
// os.homedir() only — it has no TOKENLIGHTEN_HOME-style override, by design
// (the extension must resolve the identical path with zero coordination).
// Redirect HOME/USERPROFILE too, or this test's real read_file call writes a
// stray file under the actual developer/CI home directory.
const originalHome = process.env["HOME"];
const originalUserProfile = process.env["USERPROFILE"];

afterEach(() => {
  process.argv.splice(0, process.argv.length, ...originalArgv);
  if (originalNodeEnv === undefined) delete process.env["NODE_ENV"];
  else process.env["NODE_ENV"] = originalNodeEnv;
  if (originalLogHome === undefined) delete process.env["TOKENLIGHTEN_LOG_HOME"];
  else process.env["TOKENLIGHTEN_LOG_HOME"] = originalLogHome;
  if (originalHome === undefined) delete process.env["HOME"];
  else process.env["HOME"] = originalHome;
  if (originalUserProfile === undefined) delete process.env["USERPROFILE"];
  else process.env["USERPROFILE"] = originalUserProfile;
  vi.resetModules();
});

describe("MCP usage logging boundary", () => {
  it("records derived counts for the exact read_file call without recording arguments", async () => {
    const root = join(tmpdir(), `tokenlighten-mcp-usage-${randomUUID()}`);
    const logs = join(root, "logs");
    const home = join(root, "home");
    mkdirSync(logs, { recursive: true });
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(root, "sample.ts"),
      "export const secretCustomerValue = 42;\n".repeat(100),
    );
    process.argv.push("--workspace", root);
    process.env["NODE_ENV"] = "development";
    process.env["TOKENLIGHTEN_LOG_HOME"] = logs;
    process.env["HOME"] = home;
    process.env["USERPROFILE"] = home;
    vi.resetModules();

    const { callTool, modelVisibleBytes } = await import("../server.js");
    const result = await callTool("read_file", {
      mode: "full",
      path: "sample.ts",
      cwd: root,
    });
    const repeatedResult = await callTool("read_file", {
      mode: "full",
      path: "sample.ts",
      cwd: root,
    });

    expect("isError" in result && result.isError === true).toBe(false);
    expect("isError" in repeatedResult && repeatedResult.isError === true).toBe(false);
    const escaped = {
      content: [{ type: "text", text: JSON.stringify({ a: "b\"c\\d\ne" }) }],
    };
    expect(modelVisibleBytes(escaped)).toBe(Buffer.byteLength(escaped.content[0]!.text, "utf8"));
    expect(modelVisibleBytes(escaped)).toBeLessThan(Buffer.byteLength(JSON.stringify(escaped), "utf8"));
    const events = readUsageEvents(logs);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      tool: "read_file",
      outcome: "ok",
      baselineMethod: "file-bytes",
      responseBytes: modelVisibleBytes(result),
    });
    expect(events[0]!.baselineTokens).toBeGreaterThan(0);
    expect(events[1]).toMatchObject({
      tool: "read_file",
      outcome: "ok",
      baselineMethod: "file-bytes",
      baselineTokens: 0,
      estimatedSavedTokens: -events[1]!.estimatedResponseTokens,
      responseBytes: modelVisibleBytes(repeatedResult),
    });
    const logText = readFileSync(
      join(logs, `usage-${events[0]!.occurredAt.slice(0, 10)}.ndjson`),
      "utf8",
    );
    expect(logText).not.toContain("sample.ts");
    expect(logText).not.toContain("secretCustomerValue");
    expect(logText).not.toContain(root);
  });
});
