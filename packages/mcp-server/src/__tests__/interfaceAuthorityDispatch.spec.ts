import { describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// T-L1 engagement proof at the REAL dispatch layer. The unit spec exercises
// buildInterfaceAuthoritySurfaces directly and stayed green while Probe-2's
// Phase 1a found live packs unchanged (nested include roots never resolved).
// This spec is the standing gate for that class: a spawned server, a nested
// C/C++ project, and an ON-vs-OFF pack diff over the wire.

const require = createRequire(import.meta.url);
const tsx = require.resolve("tsx/cli");
const here = path.dirname(fileURLToPath(import.meta.url));
const bin = path.resolve(here, "..", "bin.ts");

type RpcServer = {
  rpc(id: number, method: string, params?: unknown): Promise<any>;
  kill(): void;
};

function startServer(root: string, env: Record<string, string>): RpcServer {
  const child: ChildProcess = spawn(process.execPath, [tsx, bin, "--workspace", root, "--allow-write"], {
    cwd: root,
    env: { ...process.env, TOKENLIGHTEN_ALLOWED_PARENTS: os.homedir(), ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let pending = "";
  let stderr = "";
  const waiters = new Map<number, (value: any) => void>();
  child.stdout!.on("data", (chunk: Buffer) => {
    pending += chunk.toString();
    let nl = -1;
    while ((nl = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, nl);
      pending = pending.slice(nl + 1);
      if (!line.trim()) continue;
      try {
        const value = JSON.parse(line);
        const waiter = value?.id === undefined ? undefined : waiters.get(value.id);
        if (waiter !== undefined) {
          waiters.delete(value.id);
          waiter(value);
        }
      } catch { /* startup diagnostics never belong on stdout */ }
    }
  });
  child.stderr!.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  function rpc(id: number, method: string, params?: unknown): Promise<any> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(id);
        reject(new Error("RPC timeout: " + id + " " + method + "\n" + stderr));
      }, 60000);
      waiters.set(id, (value) => { clearTimeout(timer); resolve(value); });
      child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }
  return {
    rpc,
    kill: () => { try { child.kill("SIGKILL"); } catch { /* already stopped */ } },
  };
}

function body(reply: any): Record<string, any> {
  const text = reply?.result?.content?.[0]?.text;
  return JSON.parse(String(text ?? "{}")) as Record<string, any>;
}

async function initialize(server: RpcServer): Promise<void> {
  await server.rpc(1, "initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "t-l1-engagement", version: "1" },
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
}

function writeNestedProject(root: string): void {
  const write = (relPath: string, content: string): void => {
    const target = path.join(root, relPath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, "utf8");
  };
  // The include root (proj/firmware/include/) is neither the owner directory
  // nor a workspace-root child — the exact nesting Probe-2 ran against.
  write("proj/firmware/src/telemetry/telemetry_task.cpp", [
    "#include <telemetry/telemetry_task.hpp>",
    "#include <estimator/state_flags.hpp>",
    "",
    "static estimator_state_flags_t g_flags;",
    "",
    "void telemetry_publish_status() {",
    "  bool healthy = g_flags.healthy_bit != 0;",
    "  publish_sensor_health(healthy);",
    "}",
    "",
    "void telemetry_task_step() {",
    "  telemetry_publish_status();",
    "}",
    "",
  ].join("\n"));
  write("proj/firmware/include/telemetry/telemetry_task.hpp", [
    "#pragma once",
    "void telemetry_publish_status();",
    "void telemetry_task_step();",
    "",
  ].join("\n"));
  write("proj/firmware/include/estimator/state_flags.hpp", [
    "#pragma once",
    "typedef struct {",
    "  unsigned healthy_bit;",
    "  unsigned armed_bit;",
    "} estimator_state_flags_t;",
    "",
  ].join("\n"));
}

async function packOnce(root: string, env: Record<string, string>): Promise<string> {
  const server = startServer(root, env);
  try {
    await initialize(server);
    const pack = body(await server.rpc(20, "tools/call", {
      name: "read_file",
      arguments: {
        mode: "task_pack",
        taskProfile: "change_propagation",
        query: "make the telemetry publisher clear the sensor health bit when the estimator becomes unhealthy",
        paths: [{ path: "proj/firmware/src/telemetry/telemetry_task.cpp", purpose: "edit-target" }],
        cwd: root,
        lane: "t-l1-engagement",
      },
    }));
    expect(pack.kind, JSON.stringify(pack).slice(0, 400)).toBe("read.task_pack");
    return JSON.stringify(pack);
  } finally {
    server.kill();
  }
}

describe("T-L1 interface authority — real dispatch engagement", () => {
  it("ON adds the nested include-root declaration to the pack; OFF does not", async () => {
    const root = fs.mkdtempSync(path.join(os.homedir(), "tokenlighten-tl1-"));
    try {
      writeNestedProject(root);
      const marker = "include/estimator/state_flags.hpp";
      const off = await packOnce(root, { TL_INTERFACE_AUTHORITY: "0" });
      const on = await packOnce(root, { TL_INTERFACE_AUTHORITY: "1" });
      // OFF parity: the authority header must not ride an ordinary pack.
      expect(off).not.toContain(marker);
      // Engagement: the flag must add the declaration surface over the wire.
      expect(on).toContain(marker);
      expect(on).toContain("estimator_state_flags_t");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 120000);
});
