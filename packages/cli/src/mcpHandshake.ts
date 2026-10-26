// Single implementation of the MCP `initialize` + `tools/list` handshake used
// to VERIFY a `tl install`. Ported from `scripts/release-smoke.mjs`'s
// `runMcpHandshake` (~line 597) so `release-smoke.mjs` can import this
// instead of maintaining its own copy — DESIGN-v0.14-mcp-only-install.md §4.2
// step 5, §4.5 ("never the reverse").

import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";

export interface McpHandshakeOptions {
  command: string;
  args: readonly string[];
  env?: Record<string, string>;
  cwd?: string;
  timeoutMs?: number;
}

export interface McpServerInfo {
  name?: string;
  version?: string;
  [key: string]: unknown;
}

export interface McpHandshakeResult {
  ok: boolean;
  stage: string;
  serverInfo?: McpServerInfo;
  tools?: string[];
  instructions?: string;
  error?: string;
}

interface JsonRpcMessage {
  id?: number;
  result?: {
    serverInfo?: McpServerInfo;
    instructions?: string;
    tools?: Array<{ name?: unknown }>;
    protocolVersion?: string;
  };
  error?: { code?: unknown; message?: unknown };
}

/** Parse one stdout line into a JSON-RPC reply object; null for anything else. */
function parseJsonRpcLine(line: string): JsonRpcMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null; // non-JSON stdout noise
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const msg = parsed as Record<string, unknown>;
  if (msg.jsonrpc !== "2.0" || (msg.id !== undefined && typeof msg.id !== "number")) return null;
  return msg as JsonRpcMessage;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** A usable `initialize` reply: a result object carrying protocolVersion, no error. */
function isInitializeResult(msg: JsonRpcMessage): boolean {
  if (msg.error !== undefined) return false;
  return isObject(msg.result) && typeof msg.result.protocolVersion === "string";
}

/** A usable `tools/list` reply: a result object carrying a tools array, no error. */
function isToolsListResult(msg: JsonRpcMessage): boolean {
  if (msg.error !== undefined) return false;
  return isObject(msg.result) && Array.isArray(msg.result.tools)
    && msg.result.tools.every(tool => isObject(tool) && typeof tool.name === "string");
}

function errorReplyText(error: unknown, fallback: string): string {
  return isObject(error) && typeof error.message === "string" ? error.message : fallback;
}

/** Kill a spawned process AND its whole process tree/group, cross-platform.
 * Mirrors release-smoke.mjs's killTree exactly (POSIX: negative-pid signal to
 * the detached process group; Windows: `taskkill /T /F`). */
async function killTree(child: ChildProcess | undefined, graceMs = 300): Promise<void> {
  if (!child || !child.pid) return;
  if (process.platform === "win32") {
    try {
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"]);
    } catch {
      // best effort
    }
    return;
  }
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    try {
      child.kill("SIGTERM");
    } catch {
      // already dead
    }
  }
  await new Promise((r) => setTimeout(r, graceMs));
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // already dead
    }
  }
}

export async function runMcpHandshake(options: McpHandshakeOptions): Promise<McpHandshakeResult> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const startedAt = Date.now();

  return await new Promise((resolvePromise) => {
    let settled = false;
    let lineBuf = "";
    let stage = "spawn";
    let initializeResult: JsonRpcMessage | null = null;
    let toolsListResult: JsonRpcMessage | null = null;
    let child: ChildProcess | undefined;

    const finish = (outcome: { ok: boolean; stage?: string; error?: string }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void killTree(child).finally(() => {
        const serverInfo = initializeResult?.result?.serverInfo;
        const instructions = initializeResult?.result?.instructions;
        const rawTools = toolsListResult?.result?.tools;
        const tools = Array.isArray(rawTools)
          ? rawTools
            .map((tool) => tool?.name)
            .filter((name): name is string => typeof name === "string")
          : undefined;
        resolvePromise({
          ok: outcome.ok,
          stage: outcome.stage ?? stage,
          ...(serverInfo ? { serverInfo } : {}),
          ...(tools ? { tools } : {}),
          ...(instructions !== undefined ? { instructions } : {}),
          ...(outcome.error ? { error: outcome.error } : {}),
        });
      });
    };

    try {
      child = spawn(options.command, [...options.args], {
        cwd: options.cwd,
        env: { ...process.env, ...options.env },
        stdio: ["pipe", "pipe", "pipe"],
        // POSIX: make this child the leader of a fresh process group so a
        // non-detached grandchild it spawns (the real mcp-server process,
        // when `command` is itself a `tl`/launcher indirection) dies with it
        // on killTree()'s group-signal. Harmless on win32 (taskkill /T instead).
        detached: process.platform !== "win32",
      });
    } catch (err) {
      resolvePromise({
        ok: false,
        stage: "spawn",
        error: `failed to spawn ${options.command}: ${err instanceof Error ? err.message : String(err)}`,
      });
      return;
    }

    const timer = setTimeout(() => {
      finish({
        ok: false,
        stage: `timeout-during-${stage}`,
        error: `handshake exceeded ${timeoutMs}ms while waiting on stage '${stage}'`,
      });
    }, timeoutMs);

    child.on("error", (err) => {
      finish({ ok: false, stage: "process-error", error: String(err) });
    });

    child.stderr?.on("data", () => {
      // Diagnostic only — stdout is reserved for JSON-RPC.
    });

    const handleLine = (line: string): void => {
      if (settled) return;
      const msg = parseJsonRpcLine(line);
      if (!msg) return;
      if (msg.id === 1) {
        if (msg.error !== undefined) {
          finish({
            ok: false,
            stage: "initialize",
            error: `initialize error reply: ${errorReplyText(msg.error, "initialize failed")}`,
          });
          return;
        }
        if (initializeResult || !isInitializeResult(msg)) return; // duplicate / unusable reply
        initializeResult = msg;
        stage = "tools/list";
        try {
          child?.stdin?.write(
            JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) + "\n",
          );
          child?.stdin?.write(
            JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) + "\n",
          );
        } catch (err) {
          finish({ ok: false, stage: "write-tools-list", error: String(err) });
        }
        return;
      }
      if (msg.id === 2) {
        if (msg.error !== undefined) {
          finish({
            ok: false,
            stage: "tools/list",
            error: `tools/list error reply: ${errorReplyText(msg.error, "tools/list failed")}`,
          });
          return;
        }
        // Success requires a valid initialize result first — an id:2 reply that
        // arrives out of order is not a completed handshake.
        if (!initializeResult || toolsListResult || !isToolsListResult(msg)) return;
        toolsListResult = msg;
        finish({ ok: true, stage: "complete" });
      }
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      lineBuf += chunk.toString("utf8");
      let idx: number;
      while ((idx = lineBuf.indexOf("\n")) !== -1) {
        const line = lineBuf.slice(0, idx).trim();
        lineBuf = lineBuf.slice(idx + 1);
        if (!line) continue;
        handleLine(line);
      }
    });

    // A child that dies (or closes stdout) without completing the handshake
    // must resolve a failure now, not after the full timeout. `close` fires
    // after stdout has drained, so flush any newline-less last line first.
    child.on("close", () => {
      const tail = lineBuf.trim();
      lineBuf = "";
      if (tail) handleLine(tail);
      finish({
        ok: false,
        stage: `child-exited-during-${stage}`,
        error: `child process closed during stage '${stage}' before the handshake completed`,
      });
    });

    // stdin failures (EPIPE once the child is gone) arrive as async stream
    // errors: unhandled, they become an uncaught exception in the caller.
    child.stdin?.on("error", (err) => {
      finish({
        ok: false,
        stage: `stdin-error-during-${stage}`,
        error: `child stdin failed: ${String(err)}`,
      });
    });

    stage = "initialize";
    try {
      child.stdin?.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "tokenlighten-mcp-handshake", version: "0.0.0" },
          },
        }) + "\n",
      );
    } catch (err) {
      finish({ ok: false, stage: "write-initialize", error: String(err) });
    }

    void startedAt; // retained for parity with the ported implementation's timing hook
  });
}
