import { afterEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const nodeRequire = createRequire(import.meta.url);
const TSX_CLI = nodeRequire.resolve("tsx/cli");
const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN_TS = path.resolve(HERE, "..", "bin.ts");
const TEST_ROOT = process.env["HOME"] ?? process.env["USERPROFILE"] ?? os.homedir();

interface ServerHandle {
  initialize(): Promise<void>;
  rpc(id: number, method: string, params?: unknown, timeoutMs?: number): Promise<any>;
  kill(): void;
}

const tmpDirs: string[] = [];
const servers: ServerHandle[] = [];

function makeWorkspace(tag: string): string {
  const workspace = fs.mkdtempSync(path.join(TEST_ROOT, `.tl-range-${tag}-`));
  tmpDirs.push(workspace);
  const lines = Array.from(
    { length: 420 },
    (_, index) => `export const VALUE_${index} = ${index}; // stable-padding-${String(index).padStart(4, "0")}`,
  );
  fs.mkdirSync(path.join(workspace, "src"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "src", "hub.ts"), `${lines.join("\n")}\n`, "utf8");
  fs.writeFileSync(path.join(workspace, "src", "calls.ts"), [
    "export function target(value: number) {",
    "  return value + 1;",
    "}",
    "",
    "export function caller() {",
    "  return target(1);",
    "}",
    "",
  ].join("\n"), "utf8");
  return workspace;
}

function startServer(
  workspace: string,
  env: Record<string, string> = {},
  allowWrite = false,
): ServerHandle {
  const child: ChildProcess = spawn(
    process.execPath,
    [TSX_CLI, BIN_TS, workspace, ...(allowWrite ? ["--allow-write"] : [])],
    {
      cwd: workspace,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...env },
    },
  );
  let stdout = "";
  let stderr = "";
  const waiters = new Map<number, (message: any) => void>();
  child.stdout!.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
    let newline: number;
    while ((newline = stdout.indexOf("\n")) >= 0) {
      const line = stdout.slice(0, newline);
      stdout = stdout.slice(newline + 1);
      if (!line.trim()) continue;
      let message: any;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (message?.id != null && waiters.has(message.id)) {
        const resolve = waiters.get(message.id)!;
        waiters.delete(message.id);
        resolve(message);
      }
    }
  });
  child.stderr!.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  const send = (value: unknown): void => {
    child.stdin!.write(`${JSON.stringify(value)}\n`);
  };
  const rpc = (
    id: number,
    method: string,
    params?: unknown,
    timeoutMs = 25_000,
  ): Promise<any> => new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      waiters.delete(id);
      reject(new Error(`rpc '${method}' timed out.\n--- stderr ---\n${stderr}`));
    }, timeoutMs);
    waiters.set(id, (message) => {
      clearTimeout(timer);
      resolve(message);
    });
    send({ jsonrpc: "2.0", id, method, params });
  });

  return {
    async initialize(): Promise<void> {
      await rpc(1, "initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "vitest", version: "0" },
      });
      send({ jsonrpc: "2.0", method: "notifications/initialized" });
    },
    rpc,
    kill(): void {
      try {
        child.kill("SIGKILL");
      } catch {
        // Already stopped.
      }
    },
  };
}

function parseResult(result: any): Record<string, any> {
  const text: unknown = result?.result?.content?.[0]?.text;
  expect(typeof text).toBe("string");
  return JSON.parse(String(text));
}

async function readRange(
  server: ServerHandle,
  id: number,
  range: string,
  handle?: string,
): Promise<Record<string, any>> {
  return parseResult(await server.rpc(id, "tools/call", {
    name: "read_file",
    arguments: {
      mode: "slice",
      path: "src/hub.ts",
      range,
      ...(handle !== undefined ? { handle } : {}),
      includeClosure: false,
      comments: "keep",
    },
  }));
}

async function searchReferences(
  server: ServerHandle,
  id: number,
): Promise<Record<string, any>> {
  return parseResult(await server.rpc(id, "tools/call", {
    name: "search_files",
    arguments: { action: "references", query: "target" },
  }));
}

afterEach(() => {
  for (const server of servers.splice(0)) server.kill();
  for (const dir of tmpDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best-effort test cleanup.
    }
  }
});

describe("served-range delivery and adaptive whole-file escalation", () => {
  it("suppresses an unchanged repeated range while preserving its receipt", async () => {
    const workspace = makeWorkspace("dedupe");
    const server = startServer(workspace, {
      TL_SERVED_RANGE_LEDGER: "1",
      TL_ADAPTIVE_WHOLE_FILE: "0",
    });
    servers.push(server);
    await server.initialize();

    const first = await readRange(server, 2, "21-40");
    const firstHandle = first.evidence?.[0]?.handle;
    const repeated = await readRange(server, 3, "21-40", String(firstHandle));

    expect(first.evidence?.[0]?.body).toContain("VALUE_21");
    // Tracking is internal on a first serve: zero response tax until a receipt
    // actually replaces duplicated content.
    expect(first.served_range_ledger).toBeUndefined();
    // v1 deletes `served_range_ledger`/`summary`/prose `note` outright —
    // A.5.2's own preamble: "has no v1 representation: `remaining` is the
    // single carrier" — and a whole-body content-equivalent repeat collapses
    // into the minimal code-unchanged RECEIPT (A.4) instead of a slice body
    // carrying a ledger alongside it.
    expect(repeated).toMatchObject({
      kind: "read.receipt",
      receipt: { receipt: "code-unchanged", handle: firstHandle, sha: first.sha },
    });
    expect(repeated.evidence).toBeUndefined();
    const firstResponseBytes = Buffer.byteLength(JSON.stringify(first), "utf8");
    const repeatedResponseBytes = Buffer.byteLength(JSON.stringify(repeated), "utf8");
    expect(repeatedResponseBytes).toBeLessThan(firstResponseBytes);
    if (process.env["TL_REPORT_EFFECTS"] === "1") {
      const savedPercent = ((firstResponseBytes - repeatedResponseBytes) / firstResponseBytes) * 100;
      console.info(
        `[effect:range-receipt] response_bytes=${firstResponseBytes}->${repeatedResponseBytes} saved=${firstResponseBytes - repeatedResponseBytes} (${savedPercent.toFixed(1)}%)`,
      );
    }
  }, 30_000);

  it("escalates the third non-contiguous demand through the ordinary full governor", async () => {
    const workspace = makeWorkspace("adaptive");
    const server = startServer(workspace, {
      TL_SERVED_RANGE_LEDGER: "1",
      TL_ADAPTIVE_WHOLE_FILE: "1",
    });
    servers.push(server);
    await server.initialize();

    const first = await readRange(server, 2, "1-20");
    const second = await readRange(server, 3, "101-120");
    const third = await readRange(server, 4, "201-220");

    expect(first.served_range_ledger).toBeUndefined();
    expect(second.served_range_ledger).toBeUndefined();
    // v1 deletes `mode`/`fullFileExpansion`/`expanded_from`/`served_range_ledger`
    // outright (Rule K + A.5.2's "has no v1 representation" preamble) — the
    // structural fact an escalation-to-whole-file leaves on the wire is a
    // `read.text` evidence entry whose range spans the entire file, with no
    // `limit` (nothing withheld).
    expect(third.kind).toBe("read.text");
    expect(third.evidence?.[0]?.range).toBe("1-420");
    expect(third.limit).toBeUndefined();
    expect(third.evidence?.[0]?.body).toContain("VALUE_419");
  }, 30_000);

  it("keeps six demands as six slices when ledger and escalation are ablated", async () => {
    const workspace = makeWorkspace("off");
    const server = startServer(workspace, {
      TL_SERVED_RANGE_LEDGER: "0",
      TL_ADAPTIVE_WHOLE_FILE: "0",
    });
    servers.push(server);
    await server.initialize();

    const ranges = ["1-20", "81-100", "161-180", "241-260", "321-340", "401-420"];
    const responses: Array<Record<string, any>> = [];
    for (let index = 0; index < ranges.length; index++) {
      responses.push(await readRange(server, index + 2, ranges[index]!));
    }

    expect(responses).toHaveLength(6);
    expect(responses.every((response) => response.kind === "read.text")).toBe(true);
    expect(responses.every((response) => response.served_range_ledger === undefined)).toBe(true);
    expect(responses.at(-1)?.evidence?.[0]?.body).toContain("VALUE_419");
  }, 30_000);
});

describe("search hop-1 integration", () => {
  it("closes one reference hop with exact code and an edit handle", async () => {
    const workspace = makeWorkspace("hop1-on");
    const server = startServer(workspace, { TL_HOP1_CLOSURE: "1" });
    servers.push(server);
    await server.initialize();

    const response = await searchReferences(server, 2);

    expect(response.hop1).toEqual([
      expect.objectContaining({
        path: "src/calls.ts",
        line: 1,
        relation: "definition",
        handle: expect.stringMatching(/^h[0-9a-z]+$/),
        code: expect.stringContaining("export function target"),
      }),
    ]);
  }, 30_000);

  it("returns the legacy search envelope when hop-1 is ablated", async () => {
    const workspace = makeWorkspace("hop1-off");
    const server = startServer(workspace, { TL_HOP1_CLOSURE: "0" });
    servers.push(server);
    await server.initialize();

    const response = await searchReferences(server, 2);

    expect(response.files).toEqual(expect.any(Array));
    expect(response.hop1).toBeUndefined();
  }, 30_000);
});

describe("batch edit failure diagnostics", () => {
  it("returns the exact later failing item and keeps the batch atomic", async () => {
    const workspace = makeWorkspace("edit-failure");
    const before = fs.readFileSync(path.join(workspace, "src", "calls.ts"), "utf8");
    const server = startServer(workspace, {}, true);
    servers.push(server);
    await server.initialize();

    const response = parseResult(await server.rpc(2, "tools/call", {
      name: "edit_file",
      arguments: {
        cwd: workspace,
        edits: [
          {
            path: "src/calls.ts",
            search: "return value + 1;",
            replace: "return value + 2;",
          },
          {
            path: "src/calls.ts",
            search: "// target implementation",
            replace: "// updated target implementation",
          },
        ],
      },
    }));

    expect(response).toMatchObject({
      code: "not-found",
      failed_item: {
        index: 1,
        path: "src/calls.ts",
        search_preview: "// target implementation",
      },
    });
    expect(response.nearest_match ?? response.actual).toEqual(expect.objectContaining({
      code: expect.stringContaining("target"),
    }));
    expect(fs.readFileSync(path.join(workspace, "src", "calls.ts"), "utf8")).toBe(before);
  }, 30_000);
});
