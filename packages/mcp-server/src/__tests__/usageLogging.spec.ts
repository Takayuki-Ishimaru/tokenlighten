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
    // V13: neither call named a task (a bare path/mode=full read, no
    // query/qref) — both events must correlate to no task, not to each
    // other. See the qref-continuation test below for the positive case.
    expect(events[0]!.taskRef).toBeNull();
    expect(events[1]!.taskRef).toBeNull();
    const logText = readFileSync(
      join(logs, `usage-${events[0]!.occurredAt.slice(0, 10)}.ndjson`),
      "utf8",
    );
    expect(logText).not.toContain("sample.ts");
    expect(logText).not.toContain("secretCustomerValue");
    expect(logText).not.toContain(root);
  });

  // -------------------------------------------------------------------------
  // V13 (2026-08-30): task-unit usage aggregation. `summarizeUsage`
  // (packages/usage) now groups a multi-call TASK's events by `taskRef`
  // before computing a reduction ratio, so a query's first call (which
  // often carries no baseline of its own) is not silently dropped once a
  // later qref+targets continuation supplies one. That grouping depends
  // entirely on both calls landing in the NDJSON log with the SAME taskRef
  // — this pins the WIRING half of the fix, at the callToolTraced boundary,
  // independent of the summarizeUsage math covered in packages/usage's own
  // usage.spec.ts.
  // -------------------------------------------------------------------------
  it("stamps the SAME non-null taskRef on a query's task_pack call and its later qref+targets continuation", async () => {
    const root = join(tmpdir(), `tokenlighten-mcp-usage-taskref-${randomUUID()}`);
    const logs = join(root, "logs");
    const home = join(root, "home");
    mkdirSync(logs, { recursive: true });
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(root, "greeting.ts"),
      "export function greet(name: string): string {\n  return `Hello, ${name}!`;\n}\n",
    );
    process.argv.push("--workspace", root);
    process.env["NODE_ENV"] = "development";
    process.env["TOKENLIGHTEN_LOG_HOME"] = logs;
    process.env["HOME"] = home;
    process.env["USERPROFILE"] = home;
    vi.resetModules();

    const { callTool } = await import("../server.js");

    const first = await callTool("read_file", {
      mode: "task_pack",
      query: "Where is the greet function defined and what does it return?",
      cwd: root,
    });
    const firstBody = JSON.parse((first.content[0] as { text: string }).text) as Record<string, unknown>;
    const qref = String(firstBody["qref"]);
    // Same format the protocol pins elsewhere (evidenceShadow.spec.ts,
    // argMatrix.spec.ts): server.ts's taskQueryRef, "q-" + 16 hex chars.
    expect(qref).toMatch(/^q-[a-f0-9]{16}$/);

    await callTool("read_file", {
      qref,
      targets: [{ path: "greeting.ts" }],
      cwd: root,
    });

    const events = readUsageEvents(logs);
    expect(events).toHaveLength(2);
    // The fix: BOTH calls correlate to the same task, whether the ref came
    // from the caller's own `query` (call 1) or a verified `qref` replay of
    // it (call 2) — dispatchTaskRef's whole point (server.ts).
    expect(events[0]!.taskRef).toBe(qref);
    expect(events[1]!.taskRef).toBe(qref);
    expect(events[0]!.taskRef).toEqual(events[1]!.taskRef);
  });
});
