import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readUsageEvents } from "@tokenlighten/usage";

const originalArgv = [...process.argv];
const originalNodeEnv = process.env["NODE_ENV"];
const originalLogHome = process.env["TOKENLIGHTEN_LOG_HOME"];

afterEach(() => {
  process.argv.splice(0, process.argv.length, ...originalArgv);
  if (originalNodeEnv === undefined) delete process.env["NODE_ENV"];
  else process.env["NODE_ENV"] = originalNodeEnv;
  if (originalLogHome === undefined) delete process.env["TOKENLIGHTEN_LOG_HOME"];
  else process.env["TOKENLIGHTEN_LOG_HOME"] = originalLogHome;
  vi.resetModules();
});

describe("MCP usage logging boundary", () => {
  it("records derived counts for the exact read_file call without recording arguments", async () => {
    const root = join(tmpdir(), `tokenlighten-mcp-usage-${randomUUID()}`);
    const logs = join(root, "logs");
    mkdirSync(logs, { recursive: true });
    writeFileSync(
      join(root, "sample.ts"),
      "export const secretCustomerValue = 42;\n".repeat(100),
    );
    process.argv.push("--workspace", root);
    process.env["NODE_ENV"] = "development";
    process.env["TOKENLIGHTEN_LOG_HOME"] = logs;
    vi.resetModules();

    const { callTool, modelVisibleBytes } = await import("../server.js");
    const result = await callTool("read_file", {
      mode: "full",
      path: "sample.ts",
      cwd: root,
    });

    expect("isError" in result && result.isError === true).toBe(false);
    const escaped = {
      content: [{ type: "text", text: JSON.stringify({ a: "b\"c\\d\ne" }) }],
    };
    expect(modelVisibleBytes(escaped)).toBe(Buffer.byteLength(escaped.content[0]!.text, "utf8"));
    expect(modelVisibleBytes(escaped)).toBeLessThan(Buffer.byteLength(JSON.stringify(escaped), "utf8"));
    const events = readUsageEvents(logs);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      tool: "read_file",
      outcome: "ok",
      baselineMethod: "file-bytes",
      responseBytes: modelVisibleBytes(result),
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
