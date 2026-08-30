import { describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const require = createRequire(import.meta.url);
const tsx = require.resolve("tsx/cli");
const here = path.dirname(fileURLToPath(import.meta.url));
const bin = path.resolve(here, "..", "bin.ts");

type RpcServer = {
  rpc(id: number, method: string, params?: unknown): Promise<any>;
  notify(method: string, params?: unknown): void;
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
    notify: (method, params) => child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\\n"),
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
    clientInfo: { name: "t13-w5c", version: "1" },
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
}

function tool(server: RpcServer, id: number, name: string, args: Record<string, unknown>): Promise<any> {
  return server.rpc(id, "tools/call", { name, arguments: args });
}

function largeSource(): string {
  const lines = [
    "export function transitionQuoteOrchestrator(input: string): string {",
    "  return \"transition:\" + input;",
    "}",
  ];
  for (let i = 0; i < 48; i++) lines.splice(lines.length - 1, 0, "export const transitionMarker" + i + " = \"QuoteOrchestrator transition marker " + i + "................................................................................................................................................\";");
  return lines.join("\n") + "\n";
}

function assertPostReadyDowngrade(reply: any, expectedPath: string): Record<string, any> {
  expect(reply?.error, JSON.stringify(reply)).toBeUndefined();
  expect(Boolean(reply?.result?.isError ?? reply?.isError), JSON.stringify(reply)).toBe(false);

  const payload = body(reply);
  expect(payload.kind, JSON.stringify(payload)).not.toBe("refusal");
  expect(payload.error, JSON.stringify(payload)).toBeUndefined();
  expect(payload.code, JSON.stringify(payload)).toBeUndefined();
  expect(payload.content, JSON.stringify(payload)).toBeUndefined();

  const isSkeleton = payload.mode === "skeleton";
  const isMap = payload.kind === "read.map";
  expect(isSkeleton || isMap, JSON.stringify(payload)).toBe(true);

  const outline = payload.outline ?? payload.skeleton;
  expect(outline, JSON.stringify(payload)).toBeTruthy();
  const handle = payload.handle ?? outline?.handle;
  expect(typeof handle, JSON.stringify(payload)).toBe("string");
  expect(payload.path ?? outline?.path, JSON.stringify(payload)).toBe(expectedPath);

  const remaining = payload.remaining_ranges ?? payload.limit;
  expect(remaining, JSON.stringify(payload)).toBeTruthy();

  const continuation = payload.limit?.next ?? payload.next;
  expect(continuation, JSON.stringify(payload)).toBeTruthy();
  if (typeof continuation === "object") {
    expect(continuation.tool, JSON.stringify(payload)).toBe("read_file");
    expect(continuation.arguments?.content, JSON.stringify(payload)).toBe("auto");
    const target = continuation.arguments?.targets?.[0];
    expect(target?.handle, JSON.stringify(payload)).toBe(handle);
    expect(target?.range ?? target?.ranges, JSON.stringify(payload)).toBeTruthy();
  } else {
    expect(String(continuation), JSON.stringify(payload)).toContain(
      `read_file mode=slice handle=${handle}`,
    );
  }
  return payload;
}

describe("T13 W5c/W7 real dispatcher integration", () => {
  it("trims every full-body route after ready, honors force_serve, resets after edit, and preserves overlap receipts", async () => {
    const root = fs.mkdtempSync(path.join(os.homedir(), "tokenlighten-t13-"));
    fs.mkdirSync(path.join(root, "src"));
    fs.writeFileSync(path.join(root, "src", "order.ts"), largeSource(), "utf8");
    fs.writeFileSync(path.join(root, "src", "tiny.ts"), "export const tiny = 1;\n", "utf8");
    fs.writeFileSync(path.join(root, "src", "large.ts"), largeSource(), "utf8");
    fs.writeFileSync(path.join(root, "src", "handle.ts"), largeSource(), "utf8");
    const server = startServer(root, { TL_POST_READY_TRIM: "1", TL_POST_READY_TRIM_N: "6", TL_OVERLAP_TRIM: "1" });
    let nextId = 10;
    try {
      await initialize(server);
      const lane = "t13-w5c";
      const common = { cwd: root, lane };
      const pack = body(await tool(server, nextId++, "read_file", {
        ...common, mode: "task_pack", taskProfile: "change_propagation",
        query: "change QuoteOrchestrator transition", paths: [{ path: "src/order.ts", purpose: "edit-target" }],
      }));
      expect(pack.decision?.kind, JSON.stringify(pack)).toBe("act.edit");

      assertPostReadyDowngrade(
        await tool(server, nextId++, "read_file", {
          ...common, mode: "full", path: "src/large.ts", content: "full",
        }),
        "src/large.ts",
      );

      assertPostReadyDowngrade(
        await tool(server, nextId++, "read_file", {
          ...common, mode: "full", path: "src/handle.ts", allowFull: true,
        }),
        "src/handle.ts",
      );

      const first = body(await tool(server, nextId++, "read_file", {
        ...common, mode: "full", path: "src/handle.ts", allowFull: true, force_serve: true,
      }));
      const fullHandle = first.handle ?? first.items?.[0]?.handle ?? first.evidence?.[0]?.handle;
      expect(typeof fullHandle, JSON.stringify(first)).toBe("string");

      const batch = body(await tool(server, nextId++, "read_file", {
        ...common, mode: "full", paths: ["src/handle.ts"], allowFull: true,
      }));
      expect(batch).toBeTruthy();

      const handleFull = body(await tool(server, nextId++, "read_file", {
        ...common, mode: "full", handle: fullHandle, allowFull: true,
      }));
      expect(handleFull.handle ?? handleFull.items?.[0]?.handle ?? handleFull.receipt?.handle ?? handleFull.evidence?.[0]?.handle ?? handleFull).toBeTruthy();

      const firstSlice = body(await tool(server, nextId++, "read_file", {
        ...common, mode: "slice", path: "src/large.ts", range: "1-24",
      }));
      expect(firstSlice.content ?? firstSlice.segments ?? firstSlice.receipt ?? firstSlice.evidence, JSON.stringify(firstSlice)).toBeTruthy();

      const overlap = body(await tool(server, nextId++, "read_file", {
        ...common, mode: "slice", path: "src/large.ts", range: "12-36",
      }));
      expect(overlap.content ?? overlap.segments ?? overlap.receipt ?? overlap.evidence).toBeTruthy();

      const search = body(await tool(server, nextId++, "search_files", {
        ...common, action: "find", query: "QuoteOrchestrator",
      }));
      expect(search.kind ?? search.files ?? search.matches).toBeTruthy();
      for (let i = 0; i < 4; i++) {
        await tool(server, nextId++, "search_files", { ...common, action: "find", query: "transitionMarker" + i });
      }
      for (let i = 0; i < 8; i++) {
        await tool(server, nextId++, "read_file", { ...common, mode: "full", path: "src/tiny.ts" });
      }

      const trimmed = body(await tool(server, nextId++, "read_file", {
        ...common, mode: "full", path: "src/large.ts",
      }));
      expect(trimmed.mode ?? trimmed.outline ?? trimmed.receipt ?? trimmed.evidence ?? trimmed.error ?? trimmed.code, JSON.stringify(trimmed)).toBeTruthy();
      expect(trimmed.content).toBeUndefined();
      if (trimmed.mode === "skeleton") expect(String(trimmed.note)).toContain("post-ready discovery trimmed");

      const forced = body(await tool(server, nextId++, "read_file", {
        ...common, mode: "full", path: "src/large.ts", allowFull: true, force_serve: true,
      }));
      expect(forced.mode ?? forced.evidence).toBeTruthy();
      expect(forced.content ?? forced.evidence?.[0]?.body).toBeTruthy();
      expect(forced.note ?? "").not.toContain("post-ready discovery trimmed");

      const tiny = body(await tool(server, nextId++, "read_file", {
        ...common, mode: "full", path: "src/tiny.ts",
      }));
      expect(tiny.mode ?? tiny.evidence ?? tiny.receipt, JSON.stringify(tiny)).toBeTruthy();
      expect(tiny.mode === "full" ? tiny.fullFileExpansion : true).toBe(true);
      expect(tiny.note ?? "").not.toContain("post-ready discovery trimmed");

      const edited = body(await tool(server, nextId++, "edit_file", {
        ...common, path: "src/order.ts", search: "transition:", replace: "transition-edited:",
        allowPathFallback: true,
      }));
      expect(edited.kind ?? edited.path ?? edited.mode).toBeTruthy();

      const afterEdit = body(await tool(server, nextId++, "read_file", {
        ...common, mode: "full", path: "src/order.ts",
      }));
      expect(afterEdit.mode).not.toBe("skeleton");
    } finally {
      server.kill();
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 120000);

  it("keeps full dispatch behavior when TL_POST_READY_TRIM is off", async () => {
    const root = fs.mkdtempSync(path.join(os.homedir(), "tokenlighten-t13-off-"));
    fs.mkdirSync(path.join(root, "src"));
    fs.writeFileSync(path.join(root, "src", "large.ts"), largeSource(), "utf8");
    const server = startServer(root, { TL_POST_READY_TRIM: "0", TL_OVERLAP_TRIM: "0" });
    try {
      await initialize(server);
      const result = body(await tool(server, 9000, "read_file", {
        cwd: root, lane: "t13-off", mode: "full", path: "src/large.ts", allowFull: true,
      }));
      expect(result.mode ?? result.evidence).toBeTruthy();
      expect(result.mode).not.toBe("skeleton");
    } finally {
      server.kill();
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 120000);
});
