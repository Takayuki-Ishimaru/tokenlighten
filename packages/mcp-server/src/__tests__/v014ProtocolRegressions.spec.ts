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
const tmpDirs: string[] = [];
const servers: ServerHandle[] = [];

interface ServerHandle {
  initialize(): Promise<void>;
  call(name: string, args: Record<string, unknown>, timeoutMs?: number): Promise<{
    body: Record<string, unknown>;
    isError: boolean;
  }>;
  kill(): void;
}

function workspace(tag: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), ".tl-v014-" + tag + "-")));
  tmpDirs.push(dir);
  return dir;
}

function write(root: string, rel: string, content: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
}

function startServer(root: string, allowWrite = false): ServerHandle {
  const args = [TSX_CLI, BIN_TS, root];
  if (allowWrite) args.push("--allow-write");
  const child: ChildProcess = spawn(process.execPath, args, {
    cwd: root,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env },
  });
  let stdout = "";
  let stderr = "";
  let nextId = 2;
  const waiters = new Map<number, (message: any) => void>();

  child.stdout!.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
    let newline = stdout.indexOf("\n");
    while (newline >= 0) {
      const line = stdout.slice(0, newline);
      stdout = stdout.slice(newline + 1);
      newline = stdout.indexOf("\n");
      if (line.trim() === "") continue;
      let message: any;
      try { message = JSON.parse(line); } catch { continue; }
      if (message?.id != null && waiters.has(message.id)) {
        const waiter = waiters.get(message.id)!;
        waiters.delete(message.id);
        waiter(message);
      }
    }
  });
  child.stderr!.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

  function rpc(id: number, method: string, params: unknown, timeoutMs = 90_000): Promise<any> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(id);
        reject(new Error(method + " timed out\n" + stderr));
      }, timeoutMs);
      waiters.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  async function initialize(): Promise<void> {
    await rpc(1, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "vitest-v014", version: "0" },
    });
    child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  }

  async function call(name: string, callArgs: Record<string, unknown>, timeoutMs = 90_000) {
    const response = await rpc(nextId++, "tools/call", { name, arguments: callArgs }, timeoutMs);
    const text = response?.result?.content?.[0]?.text;
    expect(typeof text, JSON.stringify(response).slice(0, 500)).toBe("string");
    return {
      body: JSON.parse(text) as Record<string, unknown>,
      isError: response?.result?.isError === true,
    };
  }

  const handle = {
    initialize,
    call,
    kill: () => { try { child.kill("SIGKILL"); } catch { /* best effort */ } },
  };
  servers.push(handle);
  return handle;
}

afterEach(() => {
  for (const server of servers.splice(0)) server.kill();
  for (const dir of tmpDirs.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

describe("v0.14 target:all safety", () => {
  it("confines replacement to the explicit symbol scope", async () => {
    const root = workspace("symbol-all");
    write(root, "src/scope.ts", [
      "export function first(): string {",
      "  const a = \"TARGET_TOKEN\";",
      "  const b = \"TARGET_TOKEN\";",
      "  return a + b;",
      "}",
      "",
      "export function second(): string {",
      "  const a = \"TARGET_TOKEN\";",
      "  return a;",
      "}",
      "",
    ].join("\n"));
    const server = startServer(root, true);
    await server.initialize();

    const result = await server.call("edit_file", {
      path: "src/scope.ts",
      symbol: "first",
      search: "TARGET_TOKEN",
      replace: "REPLACED_TOKEN",
      target: "all",
      cwd: root,
    });
    expect(result.isError, JSON.stringify(result.body)).toBe(false);
    expect(result.body["kind"]).toBe("edit.applied");
    expect(result.body["replacements"]).toBe(2);
    const text = fs.readFileSync(path.join(root, "src/scope.ts"), "utf8");
    expect((text.match(/REPLACED_TOKEN/g) ?? [])).toHaveLength(2);
    expect((text.match(/TARGET_TOKEN/g) ?? [])).toHaveLength(1);
  }, 120_000);

  it("does not let target:all bypass precondition unique-match", async () => {
    const root = workspace("unique-all");
    const original = "const a = \"DUPLICATE\";\nconst b = \"DUPLICATE\";\n";
    write(root, "src/duplicate.ts", original);
    const server = startServer(root, true);
    await server.initialize();

    const result = await server.call("edit_file", {
      path: "src/duplicate.ts",
      search: "DUPLICATE",
      replace: "CHANGED",
      target: "all",
      precondition: "unique-match",
      cwd: root,
    });
    expect(result.isError).toBe(true);
    expect(result.body).toMatchObject({ kind: "refusal", code: "search-not-unique" });
    expect(fs.readFileSync(path.join(root, "src/duplicate.ts"), "utf8")).toBe(original);
  }, 120_000);

  it("rejects files over 5 MiB before replace-all blast analysis", async () => {
    const root = workspace("large-all");
    const large = "x".repeat(5 * 1024 * 1024 + 1);
    write(root, "src/large.txt", large);
    const server = startServer(root, true);
    await server.initialize();

    const result = await server.call("edit_file", {
      path: "src/large.txt",
      search: "x",
      replace: "y",
      target: "all",
      cwd: root,
    }, 120_000);
    expect(result.isError).toBe(true);
    expect(result.body).toMatchObject({ kind: "refusal", code: "file-too-large" });
    expect(fs.statSync(path.join(root, "src/large.txt")).size).toBe(large.length);
  }, 180_000);
});

describe("v0.14 canonical task-pack calls", () => {
  it("classifies a mode-less low-budget admission failure as refusal", async () => {
    const root = workspace("low-budget");
    write(root, "src/thing.ts", "export const thing = 1;\n");
    const server = startServer(root);
    await server.initialize();

    const result = await server.call("read_file", {
      query: "where is thing",
      task: { epoch: "new" },
      budget: { bytes: 100 },
      cwd: root,
      lane: "v014-low-budget",
    });
    expect(result.isError).toBe(true);
    expect(result.body).toMatchObject({
      kind: "refusal",
      code: "budget-below-minimum",
      field: "budget.bytes",
    });
  }, 120_000);

  it("preserves every ranges window on a target inside a multi-target task pack", async () => {
    const root = workspace("ranges");
    const rangeLines = Array.from({ length: 300 }, (_, index) => "outside_" + String(index + 1));
    rangeLines[1] = "RANGE_A_2";
    rangeLines[2] = "RANGE_A_3";
    rangeLines[7] = "RANGE_B_8";
    rangeLines[8] = "RANGE_B_9";
    rangeLines[149] = "OUTSIDE_SENTINEL";
    write(root, "src/ranges.ts", rangeLines.join("\n") + "\n");
    write(root, "src/other.ts", "OTHER_TARGET\n");
    const server = startServer(root);
    await server.initialize();

    const result = await server.call("read_file", {
      query: "serve the selected ranges and other target",
      targets: [
        { path: "src/ranges.ts", ranges: ["2-3", "8-9"] },
        { path: "src/other.ts", range: "1-1" },
      ],
      task: { epoch: "new" },
      cwd: root,
      lane: "v014-ranges",
    });
    expect(result.body["kind"], JSON.stringify(result.body).slice(0, 1000)).toBe("read.task_pack");
    const wire = JSON.stringify(result.body);
    expect(wire).toContain("RANGE_A_2");
    expect(wire).toContain("RANGE_B_8");
    expect(wire).toContain("OTHER_TARGET");
    expect(wire).not.toContain("OUTSIDE_SENTINEL");
  }, 180_000);

  it("NEXT-01 replays a resolved task continuation verbatim with minted task, resolved cwd, and explicit lane", async () => {
    const root = workspace("next01");
    write(root, "src/order.ts", [
      "export function applyOrder(value: string): string {",
      "  return value;",
      "}",
      ...Array.from({ length: 80 }, (_, index) => "// order audit " + index),
    ].join("\n") + "\n");
    const server = startServer(root);
    await server.initialize();

    const query = "applyOrder must trim and upper-case the order string";
    const first = await server.call("read_file", {
      query,
      targets: [{ path: "src/order.ts" }],
      task: { epoch: "new", profile: "generic" },
      lane: "next-01-lane",
    }, 180_000);
    expect(first.body["kind"], JSON.stringify(first.body).slice(0, 1200)).toBe("read.task_pack");
    const firstTask = first.body["task"] as Record<string, unknown>;
    const firstDecision = first.body["decision"] as Record<string, unknown>;
    const certificate = firstDecision["certificate"] as Record<string, unknown>;
    const obligations = certificate["obligations"] as string[];

    await server.call("read_file", {
      query,
      targets: [{ path: "src/order.ts" }],
      task: {
        handle: firstTask["id"],
        challenge: {
          certificate_id: certificate["id"],
          obligation_id: obligations[0],
          expected_action_change: "expand the edit frontier to a sibling module",
        },
      },
      lane: "next-01-lane",
    }, 180_000);

    const revoked = await server.call("read_file", {
      query,
      targets: [{ path: "src/order.ts" }],
      task: { handle: firstTask["id"] },
      lane: "next-01-lane",
    }, 180_000);
    expect(revoked.body["kind"], JSON.stringify(revoked.body).slice(0, 1200)).toBe("read.task_pack");
    const decision = revoked.body["decision"] as Record<string, unknown>;
    expect(decision["kind"], JSON.stringify(revoked.body).slice(0, 1200)).toBe("discover");
    const rawNext = decision["next"];
    expect(Array.isArray(rawNext)).toBe(false);
    const next = rawNext as { tool: string; arguments: Record<string, unknown> };
    expect(next.arguments).toMatchObject({
      cwd: root,
      lane: "next-01-lane",
      task: { epoch: "new" },
    });
    const nextTask = (next.arguments["task"] ?? {}) as Record<string, unknown>;
    // RV-1: a producer-declared epoch:new starts a fresh task and must not be
    // rewritten into a same-task handle continuation by the finalizer.
    expect(nextTask["epoch"]).toBe("new");
    expect(nextTask["handle"]).toBeUndefined();

    const replay = await server.call(next.tool, next.arguments, 180_000);
    expect(replay.body["kind"], JSON.stringify(replay.body).slice(0, 1200)).not.toBe("refusal");
  }, 300_000);
});

describe("ND-1 continuation canonicalization", () => {
  it("canonicalizes the real create-target-exists content_identical continuation before task attribution", async () => {
    const root = workspace("nd1-create-identical");
    const content = "export const EXISTING = true;\\n";
    write(root, "src/existing.ts", content);
    const server = startServer(root, true);
    await server.initialize();

    const seed = await server.call("read_file", {
      query: "inspect the existing target",
      targets: [{ path: "src/existing.ts" }],
      task: { epoch: "new" },
      cwd: root,
      lane: "nd1-lane",
    }, 180_000);
    expect(seed.body["kind"], JSON.stringify(seed.body).slice(0, 1200)).toBe("read.task_pack");
    const seedTask = seed.body["task"] as Record<string, unknown>;
    expect(typeof seedTask["id"]).toBe("string");

    const refusal = await server.call("edit_file", {
      create: true,
      path: "src/existing.ts",
      content,
      task: { handle: seedTask["id"] },
      cwd: root,
      lane: "nd1-lane",
    }, 180_000);
    expect(refusal.isError, JSON.stringify(refusal.body)).toBe(true);
    expect(refusal.body["code"]).toBe("create-target-exists");
    const next = refusal.body["next"] as { tool: string; arguments: Record<string, unknown> };
    expect(next.tool).toBe("read_file");
    expect(next.arguments).toMatchObject({
      cwd: root,
      lane: "nd1-lane",
      task: { handle: seedTask["id"], pull: "closure" },
    });

    const replay = await server.call(next.tool, next.arguments, 180_000);
    expect(replay.isError, JSON.stringify(replay.body)).toBe(false);
    expect(replay.body["kind"], JSON.stringify(replay.body).slice(0, 1200)).toBe("read.closure");
  }, 300_000);
});
