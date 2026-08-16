// legacyAliasGating.spec.ts — protocol v1 / D11. This file used to verify that
// the deprecated alias names were uncallable BY DEFAULT and re-enabled by
// TL_ENABLE_DEPRECATED_ALIASES=1. There is nothing left to gate: all 12 names
// are DELETED, so the file now pins the DELETION and the INERTNESS of the four
// env vars that used to gate it. The distinction matters — "gated off" and
// "absent" answer the same way on the happy path, and only the inertness cases
// below tell them apart.
//
// Spawns the real server over stdio (same pattern as readCodePack.spec.ts).

import { describe, it, expect, afterEach } from "vitest";
import { spawn, type ChildProcess } from "child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const nodeRequire = createRequire(import.meta.url);
const TSX_CLI = nodeRequire.resolve("tsx/cli");
const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN_TS = path.resolve(HERE, "..", "bin.ts");

const HOME = process.env["HOME"] ?? process.env["USERPROFILE"] ?? os.homedir();

const tmpDirs: string[] = [];
const servers: ServerHandle[] = [];

interface ServerHandle {
  initialize(): Promise<void>;
  rpc(id: number, method: string, params?: unknown, timeoutMs?: number): Promise<any>;
  kill(): void;
}

function mkDir(tag: string): string {
  const dir = fs.mkdtempSync(path.join(HOME, `.tl-alias-${tag}-`));
  tmpDirs.push(dir);
  return dir;
}

function startServer(opts: { cwd: string; args: string[]; env?: Record<string, string> }): ServerHandle {
  const child: ChildProcess = spawn(
    process.execPath,
    [TSX_CLI, BIN_TS, ...opts.args],
    {
      cwd: opts.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...(opts.env ?? {}) },
    },
  );

  let stdoutBuf = "";
  let stderr = "";
  const waiters = new Map<number, (msg: any) => void>();

  child.stdout!.on("data", (d: Buffer) => {
    stdoutBuf += d.toString();
    let nl: number;
    while ((nl = stdoutBuf.indexOf("\n")) >= 0) {
      const line = stdoutBuf.slice(0, nl);
      stdoutBuf = stdoutBuf.slice(nl + 1);
      if (!line.trim()) continue;
      let msg: any;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg && msg.id != null && waiters.has(msg.id)) {
        const w = waiters.get(msg.id)!;
        waiters.delete(msg.id);
        w(msg);
      }
    }
  });
  child.stderr!.on("data", (d: Buffer) => { stderr += d.toString(); });

  function send(obj: unknown): void {
    child.stdin!.write(JSON.stringify(obj) + "\n");
  }

  function rpc(id: number, method: string, params?: unknown, timeoutMs = 25000): Promise<any> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(id);
        reject(new Error(`rpc '${method}' timed out after ${timeoutMs}ms.\n--- server stderr ---\n${stderr}`));
      }, timeoutMs);
      waiters.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
      send({ jsonrpc: "2.0", id, method, params });
    });
  }

  async function initialize(): Promise<void> {
    await rpc(1, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "vitest", version: "0" },
    });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
  }

  function kill(): void {
    try { child.kill("SIGKILL"); } catch { /* ok */ }
  }

  return { initialize, rpc, kill };
}

afterEach(() => {
  for (const s of servers.splice(0)) s.kill();
  for (const d of tmpDirs.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ok */ }
  }
});

// ---------------------------------------------------------------------------
// Tests — the DELETION, and the inertness of the flags that used to gate it.
// ---------------------------------------------------------------------------

/** The 9 fully-legacy aliases D11 deleted. */
const HIDDEN_ALIASES = [
  "get_file_skeleton",
  "get_symbol_with_context",
  "extract_office_text",
  "search_replace_edit",
  "apply_edits_multi",
  "create_file",
  "read_and_edit",
  "search_symbols",
  "get_current_diff",
] as const;

/**
 * The 3 renamed aliases D11 deleted. These are the HARDER half of the pin:
 * they were exempt from the env gate (`renamedAlias: true`) and dispatched
 * UNCONDITIONALLY through the `CANON` rewrite table, so nothing about the old
 * env-var behaviour would have caught their survival.
 */
const RENAMED_ALIASES = ["read_code", "edit_code", "explore"] as const;

const ALL_DELETED_ALIASES = [...HIDDEN_ALIASES, ...RENAMED_ALIASES];

/** Minimal argument set per name — a well-formed call, so only the NAME can refuse it. */
const ARGS_FOR: Readonly<Record<string, Record<string, unknown>>> = {
  get_file_skeleton: { path: "target.ts" },
  get_symbol_with_context: { path: "target.ts", symbol: "greet" },
  extract_office_text: { path: "target.ts" },
  search_replace_edit: { path: "target.txt", search: "OLD", replace: "NEW" },
  apply_edits_multi: { edits: [{ path: "target.txt", search: "OLD", replace: "NEW" }] },
  create_file: { path: "created.txt", content: "hello" },
  read_and_edit: { path: "target.ts", symbol: "greet", search: "OLD", replace: "NEW" },
  search_symbols: { query: "greet" },
  get_current_diff: {},
  read_code: { path: "target.txt", mode: "auto" },
  edit_code: { path: "target.txt", search: "OLD", replace: "NEW" },
  explore: { action: "tree" },
};

function seedWorkspace(dir: string): void {
  fs.writeFileSync(path.join(dir, "target.txt"), "OLD\n", "utf8");
  fs.writeFileSync(path.join(dir, "target.ts"), "export function greet(): string { return \"OLD\"; }\n", "utf8");
}

/**
 * One assertion, used by every case: the name is GONE, and its refusal is a
 * JSON-RPC method error — not a result, not a structured refusal body, and
 * carrying no breadcrumb that would put the dead name back into a transcript.
 */
function expectUnknownTool(res: any, name: string): void {
  expect(res.error, `${name} returned a result instead of -32601`).toBeDefined();
  expect(res.result, `${name} returned a result instead of -32601`).toBeUndefined();
  expect(res.error.code, name).toBe(-32601);
  expect(res.error.message, name).toMatch(/^Tool not found/);
  const msg: string = res.error.message;
  expect(msg, name).not.toContain("deprecated");
  expect(msg, name).not.toContain("alias");
  expect(msg, name).not.toContain("use ");
}

describe("D11 — the 12 legacy alias names are DELETED, not gated", () => {
  it("every deleted alias answers -32601 with no env override, and tools/list still names exactly the 3 advertised tools", async () => {
    const wsDir = mkDir("deleted-default");
    seedWorkspace(wsDir);

    const srv = startServer({ cwd: wsDir, args: [wsDir, "--allow-write"] });
    servers.push(srv);
    await srv.initialize();

    const list = await srv.rpc(2, "tools/list", {});
    const names = (list.result.tools as Array<{ name: string }>).map((t) => t.name).sort();
    expect(names).toEqual(["edit_file", "read_file", "search_files"]);

    let id = 3;
    for (const name of ALL_DELETED_ALIASES) {
      const res = await srv.rpc(id++, "tools/call", { name, arguments: ARGS_FOR[name] });
      expectUnknownTool(res, name);
    }

    // Nothing was written by any of the four deleted WRITE aliases.
    expect(fs.existsSync(path.join(wsDir, "created.txt"))).toBe(false);
    expect(fs.readFileSync(path.join(wsDir, "target.txt"), "utf8")).toBe("OLD\n");
  }, 60000);

  it("TL_ENABLE_DEPRECATED_ALIASES=1 is INERT — the same 12 names still answer -32601", async () => {
    // The flag is deleted, not merely defaulted off. This is the D10 inertness
    // shape: an operator who still sets the old env var gets the SAME answer,
    // because there is no branch left for the value to select.
    const wsDir = mkDir("deleted-flagged");
    seedWorkspace(wsDir);

    const srv = startServer({
      cwd: wsDir,
      args: [wsDir, "--allow-write"],
      env: { TL_ENABLE_DEPRECATED_ALIASES: "1" },
    });
    servers.push(srv);
    await srv.initialize();

    let id = 2;
    for (const name of ALL_DELETED_ALIASES) {
      const res = await srv.rpc(id++, "tools/call", { name, arguments: ARGS_FOR[name] });
      expectUnknownTool(res, name);
    }

    expect(fs.existsSync(path.join(wsDir, "created.txt"))).toBe(false);
    expect(fs.readFileSync(path.join(wsDir, "target.txt"), "utf8")).toBe("OLD\n");
  }, 60000);

  it("the 3 per-alias kill switches are INERT — read_file stays advertised and mode=skeleton still serves", async () => {
    // TL_DISABLE_GET_FILE_SKELETON + TL_DISABLE_GET_SYMBOL_WITH_CONTEXT used to
    // disable the ADVERTISED read_file entry itself when both were set
    // (`enabled: !KILL_SWITCH && (!DISABLE_SKELETON || !DISABLE_SYMBOL)`), and
    // TL_DISABLE_EXTRACT_OFFICE_TEXT gated the office alias. All three are
    // deleted; setting them must now change nothing at all.
    const wsDir = mkDir("disable-flags");
    seedWorkspace(wsDir);

    const srv = startServer({
      cwd: wsDir,
      args: [wsDir],
      env: {
        TL_DISABLE_GET_FILE_SKELETON: "1",
        TL_DISABLE_GET_SYMBOL_WITH_CONTEXT: "1",
        TL_DISABLE_EXTRACT_OFFICE_TEXT: "1",
      },
    });
    servers.push(srv);
    await srv.initialize();

    const list = await srv.rpc(2, "tools/list", {});
    const names = (list.result.tools as Array<{ name: string }>).map((t) => t.name).sort();
    expect(names).toEqual(["edit_file", "read_file", "search_files"]);

    const skel = await srv.rpc(3, "tools/call", {
      name: "read_file",
      arguments: { path: "target.ts", mode: "skeleton" },
    });
    expect(skel.error).toBeUndefined();
    const skelText: string = skel.result?.content?.[0]?.text ?? "";
    expect(skelText).toContain("greet");
  }, 60000);
});
