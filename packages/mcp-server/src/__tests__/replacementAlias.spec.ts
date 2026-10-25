import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { TSX_NODE_ARGS } from "./helpers/tsxNode.js";

const roots: string[] = [];
const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, "../..");
const binTs = path.join(packageRoot, "src", "bin.ts");
type Server = typeof import("../server.js");
let server: Server;
const read = (root: string, rel: string) => fs.readFileSync(path.join(root, rel), "utf8");

function workspace(): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.homedir(), ".tl-r14-replacement-alias-")));
  roots.push(root);
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src/a.txt"), "before-a\n");
  fs.writeFileSync(path.join(root, "src/b.txt"), "before-b\n");
  return root;
}

async function call(args: Record<string, unknown>): Promise<Record<string, any>> {
  const response = await server.handleRequest({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "tl_edit_file", arguments: args } });
  return JSON.parse((response as any).result.content[0].text);
}

function startReadOnlyServer(root: string): { call: (args: Record<string, unknown>) => Promise<Record<string, any>>; stop: () => Promise<void> } {
  const child: ChildProcess = spawn(process.execPath, [...TSX_NODE_ARGS, binTs, root], {
    cwd: packageRoot,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env },
  });
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
      try { message = JSON.parse(line); } catch { continue; }
      if (message?.id != null) waiters.get(message.id)?.(message);
    }
  });
  child.stderr!.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  let id = 0;
  const rpc = (method: string, params?: unknown) => new Promise<any>((resolve, reject) => {
    const requestId = ++id;
    const timeout = setTimeout(() => {
      waiters.delete(requestId);
      reject(new Error(`read-only server ${method} timeout; stderr=${stderr}`));
    }, 20_000);
    waiters.set(requestId, (message) => { clearTimeout(timeout); waiters.delete(requestId); resolve(message); });
    child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params })}\n`);
  });
  return {
    call: async (args) => {
      const response = await rpc("tools/call", { name: "tl_edit_file", arguments: args });
      return JSON.parse(response.result.content[0].text);
    },
    stop: () => new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
      child.once("exit", () => resolve());
      child.kill("SIGTERM");
    }),
  };
}

beforeAll(async () => {
  if (!process.argv.includes("--allow-write")) process.argv.push("--allow-write");
  server = await import("../server.js");
  await server.handleRequest({ jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "copilot-cli", version: "1.0.96" } } });
});
afterEach(() => { server.resetCapturedClientIdForTest(); vi.unstubAllEnvs(); });
afterAll(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("tl_edit_file edits[].replacement alias", () => {
  it("keeps the advertised surface canonical and limited to three tools", () => {
    const tools = server.advertisedTools("copilot-cli");
    expect(tools).toHaveLength(3);
    const edit = tools.find((tool) => tool.name === "tl_edit_file") as any;
    expect(edit.inputSchema.properties.edits.items.properties.replace).toBeDefined();
    expect(edit.inputSchema.properties.edits.items.properties.replacement).toBeUndefined();
  });

  it("normalizes only the sole replacement key after padded-key trimming", () => {
    const { prepareCanonicalInput } = server;
    expect(prepareCanonicalInput("tl_edit_file", { edits: [{ path: "a", search: "x", "\treplacement": "y" }] }).edits)
      .toEqual([{ path: "a", search: "x", replace: "y" }]);
    expect(prepareCanonicalInput("tl_edit_file", { edits: [{ path: "a", search: "x", replacement: "y" }] }).edits)
      .toEqual([{ path: "a", search: "x", replace: "y" }]);
    const conflicting = { edits: [{ path: "a", search: "x", replace: "y", replacement: "y" }] };
    expect(prepareCanonicalInput("tl_edit_file", conflicting).edits).toEqual(conflicting.edits);
    const paddedDuplicates = { edits: [{ path: "a", search: "x", "\treplacement": "first", " replacement": "second" }] };
    expect(prepareCanonicalInput("tl_edit_file", paddedDuplicates).edits).toEqual(paddedDuplicates.edits);
    const unicodePadding = { edits: [{ path: "a", search: "x", "\u00a0replacement": "y" }] };
    expect(prepareCanonicalInput("tl_edit_file", unicodePadding).edits).toEqual(unicodePadding.edits);
  });

  it.each(["\treplacement", "replacement\t", " \treplacement \t"])("applies a sole ASCII-padded replacement spelling through JSON-RPC: %j", async (key) => {
    const root = workspace();
    const result = await call({ cwd: root, edits: [{ path: "src/a.txt", search: "before-a", [key]: "after-a", precondition: "unique-match" }] });
    expect(result.kind, JSON.stringify(result)).toBe("edit.applied");
    expect(read(root, "src/a.txt")).toBe("after-a\n");
  });

  it("accepts the plain replacement spelling when replace is absent", async () => {
    const root = workspace();
    const result = await call({ cwd: root, edits: [{ path: "src/a.txt", search: "before-a", replacement: "plain-after", precondition: "unique-match" }] });
    expect(result.kind, JSON.stringify(result)).toBe("edit.applied");
    expect(read(root, "src/a.txt")).toBe("plain-after\n");
  });

  it.each([
    ["different values", "after-a", "other"],
    ["equal values", "after-a", "after-a"],
    ["padded replace collision", "after-a", undefined],
  ])("refuses replace/replacement collisions (%s)", async (label, replaceValue, aliasValue) => {
    const root = workspace();
    const item: Record<string, unknown> = { path: "src/a.txt", search: "before-a", precondition: "unique-match" };
    if (label === "padded replace collision") {
      item["\treplace"] = replaceValue;
      item.replacement = "after-a";
    } else {
      item.replace = replaceValue;
      item.replacement = aliasValue;
    }
    const result = await call({ cwd: root, edits: [item] });
    expect(result.kind, JSON.stringify(result)).toBe("refusal");
    expect(JSON.stringify(result)).toContain("replacement");
    expect(read(root, "src/a.txt")).toBe("before-a\n");
  });

  it.each([
    ["different values", "first", "second"],
    ["equal values", "same", "same"],
  ])("refuses multiple padded replacement spellings (%s)", async (_label, first, second) => {
    const root = workspace();
    const result = await call({ cwd: root, edits: [{
      path: "src/a.txt", search: "before-a", "\treplacement": first, " replacement": second,
    }] });
    expect(result.kind, JSON.stringify(result)).toBe("refusal");
    expect(JSON.stringify(result)).toContain("replacement");
    expect(read(root, "src/a.txt")).toBe("before-a\n");
  });

  it("retains the old unknown-key refusal when tolerant input is explicitly disabled", async () => {
    const root = workspace();
    vi.stubEnv("TL_EFF_TOLERANT_INPUT", "0");
    const result = await call({ cwd: root, edits: [{ path: "src/a.txt", search: "before-a", "\treplacement": "after-a" }] });
    expect(result.kind, JSON.stringify(result)).toBe("refusal");
    expect(JSON.stringify(result)).toContain("replacement");
    expect(read(root, "src/a.txt")).toBe("before-a\n");
  });

  it("retains refusal for unrelated unknown item keys", async () => {
    const root = workspace();
    const result = await call({ cwd: root, edits: [{ path: "src/a.txt", search: "before-a", replacement: "after-a", accidental: true }] });
    expect(result.kind, JSON.stringify(result)).toBe("refusal");
    expect(JSON.stringify(result)).toContain("accidental");
    expect(read(root, "src/a.txt")).toBe("before-a\n");
  });

  it("keeps a multi-item batch atomic when a later item has an unknown key", async () => {
    const root = workspace();
    const result = await call({ cwd: root, edits: [
      { path: "src/a.txt", search: "before-a", "\treplacement": "after-a" },
      { path: "src/b.txt", search: "before-b", replacement: "after-b", accidental: true },
    ] });
    expect(result.kind, JSON.stringify(result)).toBe("refusal");
    expect(read(root, "src/a.txt")).toBe("before-a\n");
    expect(read(root, "src/b.txt")).toBe("before-b\n");
  });

  it("keeps a multi-item batch atomic when a later item has duplicate padded aliases", async () => {
    const root = workspace();
    const result = await call({ cwd: root, edits: [
      { path: "src/a.txt", search: "before-a", "\treplacement": "after-a" },
      { path: "src/b.txt", search: "before-b", "\treplacement": "first", " replacement": "second" },
    ] });
    expect(result.kind, JSON.stringify(result)).toBe("refusal");
    expect(read(root, "src/a.txt")).toBe("before-a\n");
    expect(read(root, "src/b.txt")).toBe("before-b\n");
  });

  it("still refuses the normalized alias when the server starts without --allow-write", async () => {
    const root = workspace();
    const child = startReadOnlyServer(root);
    try {
      const refused = await child.call({ cwd: root, edits: [{ path: "src/a.txt", search: "before-a", "\treplacement": "after-a" }] });
      expect(refused.code, JSON.stringify(refused)).toBe("write-not-enabled");
      expect(read(root, "src/a.txt")).toBe("before-a\n");
    } finally {
      await child.stop();
    }
  });
});
