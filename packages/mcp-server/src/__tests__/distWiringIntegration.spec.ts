import { afterEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { tsImport } from "tsx/esm/api";

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN_JS = resolve(HERE, "..", "..", "dist", "bin.js");
const tmpDirs: string[] = [];
const servers: ChildProcess[] = [];

function writeFixture(root: string, rel: string, content: string): void {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, "utf8");
}

function parseBody(response: any): Record<string, any> {
  const text = response?.result?.content?.[0]?.text;
  expect(typeof text).toBe("string");
  return JSON.parse(text);
}

function startDistServer(cwd: string): {
  initialize(): Promise<void>;
  rpc(id: number, method: string, params?: unknown): Promise<any>;
} {
  const child = spawn(process.execPath, [BIN_JS, cwd, "--allow-write"], {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env },
  });
  servers.push(child);
  let stdout = "";
  let stderr = "";
  const waiters = new Map<number, (value: any) => void>();
  child.stdout!.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
    let newline: number;
    while ((newline = stdout.indexOf("\n")) >= 0) {
      const line = stdout.slice(0, newline);
      stdout = stdout.slice(newline + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      if (message.id != null) {
        const resolveWaiter = waiters.get(message.id);
        waiters.delete(message.id);
        resolveWaiter?.(message);
      }
    }
  });
  child.stderr!.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

  const send = (value: unknown): void => {
    child.stdin!.write(`${JSON.stringify(value)}\n`);
  };
  const rpc = (id: number, method: string, params?: unknown): Promise<any> => new Promise((resolveRpc, reject) => {
    const timer = setTimeout(() => {
      waiters.delete(id);
      reject(new Error(`dist MCP ${method} timed out\n${stderr}`));
    }, 25_000);
    waiters.set(id, (value) => {
      clearTimeout(timer);
      resolveRpc(value);
    });
    send({ jsonrpc: "2.0", id, method, params });
  });

  return {
    rpc,
    async initialize(): Promise<void> {
      await rpc(1, "initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "dist-integration", version: "0" },
      });
      send({ jsonrpc: "2.0", method: "notifications/initialized" });
    },
  };
}

afterEach(() => {
  for (const server of servers.splice(0)) server.kill("SIGKILL");
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("built MCP wiring integration", () => {
  it("prepares the correct consumer, edits its insertion handle, and passes behavior verification", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "tl-dist-wiring-"));
    tmpDirs.push(workspace);
    writeFixture(workspace, "package.json", JSON.stringify({ type: "module" }));
    writeFixture(workspace, "src/signal_source.ts", "export function sampleSignal() { return false; }\n");
    writeFixture(workspace, "src/signal_adapter.ts", [
      "export function encodeSignal(value) {",
      "  return { healthBit: value ? 1 : 0 };",
      "}",
      "",
    ].join("\n"));
    writeFixture(workspace, "src/packet_consumer.ts", [
      "import { sampleSignal } from './signal_source.ts';",
      "import { encodeSignal } from './signal_adapter.ts';",
      "export function transmitPacket() {",
      "  return encodeSignal(true);",
      "}",
      "",
    ].join("\n"));

    const server = startDistServer(workspace);
    await server.initialize();
    const pack = parseBody(await server.rpc(2, "tools/call", {
      name: "read_file",
      arguments: {
        mode: "task_pack",
        paths: ["src"],
        taskProfile: "wiring",
        query: "Using encodeSignal, replace the hard-coded healthy input in transmitPacket with the value from sampleSignal; when the value is false, the output health bit must clear.",
      },
    }));

    // v1 (§3.4 E4): execution_contract's `phase` re-encoding is DELETED;
    // "prepared, act now" is now `decision.kind:"act.edit"` (decisionWire.ts).
    expect(pack.decision).toMatchObject({ kind: "act.edit" });
    // v1: wiring pack content moved under `plan.wiring` (A.5.1's PLAN slot).
    const connection = pack.plan.wiring.connections[0];
    expect(connection.source.path).toBe("src/signal_source.ts");
    expect(connection.destination.path).toBe("src/packet_consumer.ts");
    expect(connection.insertion_handle).toBe(connection.destination.handle);
    expect(pack.plan.wiring.edit_frontier).toEqual([connection.destination.handle]);

    const edit = parseBody(await server.rpc(3, "tools/call", {
      name: "edit_file",
      arguments: {
        handle: connection.insertion_handle,
        search: "encodeSignal(true)",
        replace: "encodeSignal(sampleSignal())",
        allowPathFallback: false,
      },
    }));
    // D6: body `ok` is deleted; `kind` carries the outcome (§2.5).
    expect(edit.kind).not.toBe("refusal");
    expect(readFileSync(join(workspace, "src/packet_consumer.ts"), "utf8"))
      .toContain("encodeSignal(sampleSignal())");

    // Execute the generated TypeScript through tsx rather than Vite's module
    // graph. macOS resolves /var to /private/var, and Vite 6 correctly refuses
    // an external temp-file import after that realpath transition.
    const consumer = await tsImport(
      pathToFileURL(join(workspace, "src/packet_consumer.ts")).href,
      import.meta.url,
    );
    expect(consumer.transmitPacket()).toEqual({ healthBit: 0 });
  }, 60_000);
});
