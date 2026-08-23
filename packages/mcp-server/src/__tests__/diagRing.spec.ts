// Integration test for the "last-call mirror" (diagnostics ring file): the
// VS Code extension has no stdio channel to this server, so kind/tool/mode/
// ms/ok/error_code for the last calls can only reach it through
// ~/.tokenlighten/diag/<key>.json (packages/usage's diagRing.ts). This
// exercises one real tools/call through the actual server — same pattern as
// usageLogging.spec.ts's NDJSON boundary test — with HOME redirected to a
// temp dir and asserts the ring file appears there with no leaked path/query.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { diagRingFilePath } from "@tokenlighten/usage";

const originalArgv = [...process.argv];
const originalNodeEnv = process.env["NODE_ENV"];
const originalLogHome = process.env["TOKENLIGHTEN_LOG_HOME"];
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

describe("MCP diagnostics ring file (last-call mirror)", () => {
  it("appears under HOME/.tokenlighten/diag after a real read_file call, with kind/mode/ok and no query/path leakage", async () => {
    const root = join(tmpdir(), `tokenlighten-mcp-diag-${randomUUID()}`);
    const logs = join(root, "logs");
    const home = join(root, "home");
    mkdirSync(logs, { recursive: true });
    mkdirSync(home, { recursive: true });
    writeFileSync(join(root, "sample.ts"), "export const diagRingMarkerXYZ = 1;\n");
    process.argv.push("--workspace", root);
    process.env["NODE_ENV"] = "development";
    process.env["TOKENLIGHTEN_LOG_HOME"] = logs;
    process.env["HOME"] = home;
    process.env["USERPROFILE"] = home;
    vi.resetModules();

    const { callTool } = await import("../server.js");
    const result = await callTool("read_file", {
      mode: "task_pack",
      query: "does diagRingMarkerXYZ exist in this workspace",
      cwd: root,
    });
    expect("isError" in result && result.isError === true).toBe(false);

    const ringPath = diagRingFilePath(root, join(home, ".tokenlighten", "diag"));
    const raw = readFileSync(ringPath, "utf8");
    const ring = JSON.parse(raw) as {
      v: 1;
      workspace_key: string;
      server_version: string;
      pid: number;
      updated_at: string;
      calls: Array<{
        at: string;
        tool: string;
        mode?: string;
        kind?: string;
        ms: number;
        ok: boolean;
        error_code?: string;
      }>;
    };

    expect(ring.v).toBe(1);
    expect(typeof ring.server_version).toBe("string");
    expect(typeof ring.pid).toBe("number");
    expect(ring.calls.length).toBeGreaterThan(0);
    const last = ring.calls[ring.calls.length - 1]!;
    expect(last.tool).toBe("read_file");
    expect(last.mode).toBe("task_pack");
    expect(last.ok).toBe(true);
    expect(typeof last.ms).toBe("number");
    expect(last.error_code).toBeUndefined();

    // Privacy: the ring file must never carry the query text, the file path,
    // or the workspace root — only the short enum-like fields above.
    expect(raw).not.toContain("diagRingMarkerXYZ");
    expect(raw).not.toContain("sample.ts");
    expect(raw).not.toContain("does diagRingMarkerXYZ exist");
    expect(raw).not.toContain(root);
  });

  it("records a refusal's short code (not message text) when a call is refused", async () => {
    const root = join(tmpdir(), `tokenlighten-mcp-diag-refusal-${randomUUID()}`);
    const logs = join(root, "logs");
    const home = join(root, "home");
    mkdirSync(logs, { recursive: true });
    mkdirSync(home, { recursive: true });
    process.argv.push("--workspace", root);
    process.env["NODE_ENV"] = "development";
    process.env["TOKENLIGHTEN_LOG_HOME"] = logs;
    process.env["HOME"] = home;
    process.env["USERPROFILE"] = home;
    vi.resetModules();

    const { callTool } = await import("../server.js");
    // A path that does not exist under the workspace is refused rather than
    // thrown — this is the JSON-envelope refusal path (kind:"refusal",
    // code:<short RefusalCode>), distinct from the thrown-exception path.
    const result = await callTool("read_file", {
      mode: "full",
      path: "does/not/exist.ts",
      cwd: root,
    });
    expect("isError" in result && result.isError === true).toBe(true);

    const ringPath = diagRingFilePath(root, join(home, ".tokenlighten", "diag"));
    const raw = readFileSync(ringPath, "utf8");
    const ring = JSON.parse(raw) as {
      calls: Array<{ tool: string; kind?: string; ok: boolean; error_code?: string }>;
    };
    const last = ring.calls[ring.calls.length - 1]!;
    expect(last.tool).toBe("read_file");
    expect(last.ok).toBe(false);
    expect(last.kind).toBe("refusal");
    expect(typeof last.error_code).toBe("string");
    expect((last.error_code ?? "").length).toBeLessThan(64);
    expect(raw).not.toContain("does/not/exist.ts");
  });
});
