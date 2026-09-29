// pathsSymbolBatchRangeFullElision.spec.ts — FIX-A4 (2026-09-21), TL-05
// follow-up, contract-hole class (same pattern FIX-A3 fixed for the A7
// `handles=[]` batch loop, item 3).
//
// THE CONTRACT (plan §7.1, FIX-A2's ruling, unchanged by this file):
//   range/ranges/symbol + content:"full" => serve the selected lines/symbol
//   body UNELIDED (no doc-comment collapsing) — across every batch dispatch
//   branch, not only the single-target ones.
//
// THE DEFECT, CONFIRMED. The S6 branch (server.ts ~L13015, "2026-09-20,
// Copilot dead-turn forensics": a query-less multi-target `paths[]`/mixed
// handle-path batch where at least one target carries `symbol` — documented,
// advertised shape `targets:[{path,symbol},{path,symbol},{path}]`) computes
// its per-item `itemDisplay` (the elision decision) from `keepComments`
// alone — the caller's explicit `comments:"keep"` — never consulting
// `rangeContentFullMarker`, the same fact the sibling single-handle
// `mode=slice` branch (FIX-A2's `effectiveKeepComments`) and the A7
// `handles=[]` batch loop (FIX-A3, item 3) already honor. A caller resolving
// a symbol in a commented file, in a >=2-target batch, with `content:"full"`,
// got the doc comment collapsed to an elision marker anyway.
//
// MEASURED, FAIL-FIRST (reverted locally and confirmed before writing this
// file): `targets:[{path:"src/commented.ts",symbol:"myFunc"},{path:"src/plain.ts"}]`
// with `content:"full"` returned `"/* doc elided L1-14 */\nexport function
// myFunc() {\n  return 42;\n}"` for the commented entry — the 12 lines of doc
// comment text were replaced by the marker despite the explicit `content:"full"`.
//
// THE FIX: `itemDisplay` now reads `keepComments || rangeContentFullMarker`,
// identical in shape to the two sibling branches. The served-range booking
// just below (`spansExcludingWindows` over `itemDisplay.elided`) needed no
// separate change — an unelided item reports `elided: []`, which that
// existing bookkeeping already treats correctly.

import { afterAll, afterEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { shortTmpDir } from "./helpers/shortTmpDir.js";
import { rmDirWithRetry, waitForExit } from "./helpers/rmDirWithRetry.js";

// ---------------------------------------------------------------------------
// Spawned-stdio-server harness (trimmed from rangedDeliveryCompleteness.spec.ts).
// ---------------------------------------------------------------------------

const nodeRequire = createRequire(import.meta.url);
const TSX_CLI = nodeRequire.resolve("tsx/cli");
const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN_TS = path.resolve(HERE, "..", "bin.ts");
const HOME = process.env["HOME"] ?? process.env["USERPROFILE"] ?? os.homedir();

const VSCODE_ENV: Readonly<Record<string, string>> = {
  TOKENLIGHTEN_CLIENT: "vscode",
  TOKENLIGHTEN_CLIENT_ID: "vscode",
  TL_TURN_ECONOMY: "1",
  TOKENLIGHTEN_TASK_PACK_MAX_BYTES: "0",
};

function serverEnv(overrides: Readonly<Record<string, string>> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("TL_") || key.startsWith("TOKENLIGHTEN_")) delete env[key];
  }
  return { ...env, ...overrides };
}

interface ServerHandle {
  initialize(): Promise<void>;
  call(args: Record<string, unknown>): Promise<Record<string, unknown>>;
  kill(): Promise<void>;
}

const tmpDirs: string[] = [];
const spawnedServers: ServerHandle[] = [];
let toolCallId = 8000;

function mkDir(tag: string): string {
  const dir = fs.realpathSync(shortTmpDir(HOME, `.tl-psbrfe-${tag}-`));
  tmpDirs.push(dir);
  return dir;
}

function writeFile(dir: string, rel: string, content: string): void {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
}

function startServer(cwd: string, env: NodeJS.ProcessEnv): ServerHandle {
  // Own process group (POSIX), so one group SIGKILL reaches the tsx wrapper
  // AND the server it runs; killing the wrapper alone orphans it.
  const child: ChildProcess = spawn(process.execPath, [TSX_CLI, "--liftoff-only", BIN_TS, cwd], {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env,
    detached: process.platform !== "win32",
  });
  const killGroup = (): void => {
    try {
      if (process.platform !== "win32" && child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      else child.kill("SIGKILL");
    } catch { /* ok */ }
  };

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
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg && msg.id != null && waiters.has(msg.id)) {
        const w = waiters.get(msg.id)!;
        waiters.delete(msg.id);
        w(msg);
      }
    }
  });
  child.stderr!.on("data", (d: Buffer) => {
    stderr += d.toString();
  });

  function rpc(id: number, method: string, params?: unknown, timeoutMs = 45000): Promise<any> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(id);
        reject(new Error(`rpc '${method}' timed out after ${timeoutMs}ms.\n--- server stderr ---\n${stderr}`));
      }, timeoutMs);
      waiters.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  return {
    initialize: async () => {
      await rpc(1, "initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "fixa4-item2", version: "0" } });
      child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    },
    call: async (args: Record<string, unknown>) => {
      const res = await rpc(toolCallId++, "tools/call", { name: "read_file", arguments: args });
      const text: string = res?.result?.content?.[0]?.text;
      expect(typeof text, `read_file returned no text content: ${JSON.stringify(res)}`).toBe("string");
      return JSON.parse(text) as Record<string, unknown>;
    },
    kill: async () => {
      killGroup();
      await waitForExit(child);
    },
  };
}

// Every server is started inside one test; stop it when that test ends so a
// long file never holds all of them at once.
afterEach(async () => {
  for (const s of spawnedServers.splice(0)) await s.kill();
});

afterAll(async () => {
  for (const s of spawnedServers.splice(0)) await s.kill();
  for (const d of tmpDirs.splice(0)) {
    try {
      await rmDirWithRetry(d);
    } catch {
      /* ok */
    }
  }
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** `codeLines` real lines, one doc-comment block of `commentLines`, then `myFunc`. */
function commentedSymbolFile(codeLines: number, commentLines: number): string {
  const lines: string[] = [];
  for (let i = 0; i < codeLines; i += 1) lines.push(`export const A${i} = ${i};`);
  lines.push("/**");
  for (let i = 0; i < commentLines; i += 1) lines.push(` * doc comment content line ${i} with enough padding text to matter here`);
  lines.push(" */");
  lines.push("export function myFunc() {");
  lines.push("  return 42;");
  lines.push("}");
  return lines.join("\n") + "\n";
}

const ELISION_MARKER_RE = /\/\* doc elided L\d+-\d+ \*\/|#\s?doc elided L\d+-\d+/;

function commentedEntry(body: Record<string, unknown>): Record<string, unknown> | undefined {
  const entries = body["entries"];
  if (!Array.isArray(entries)) return undefined;
  return (entries as Array<Record<string, unknown>>).find((e) => e["path"] === "src/commented.ts");
}

describe.each([
  ["default", serverEnv()],
  ["vscode", serverEnv(VSCODE_ENV)],
] as const)("S6 paths[]/symbol batch (%s config): content:\"full\" must survive the symbol resolution", (label, env) => {
  it("a >=2-target batch where one target names a symbol in a commented file serves that symbol UNELIDED under content:\"full\"", async () => {
    const ws = mkDir(label);
    writeFile(ws, "src/commented.ts", commentedSymbolFile(4, 12));
    writeFile(ws, "src/plain.ts", "export const P = 1;\n");

    const server = startServer(ws, env);
    spawnedServers.push(server);
    await server.initialize();

    const res = await server.call({
      targets: [{ path: "src/commented.ts", symbol: "myFunc" }, { path: "src/plain.ts" }],
      content: "full",
    });
    expect(res["kind"], JSON.stringify(res).slice(0, 400)).toBe("read.batch");

    const entry = commentedEntry(res);
    expect(entry, JSON.stringify(res)).toBeDefined();
    const content = entry!["content"] as string;
    expect(ELISION_MARKER_RE.test(content), `must not elide: ${content}`).toBe(false);
    for (let i = 0; i < 12; i += 1) {
      expect(content, `line ${i} of the doc comment must be present verbatim`).toContain(`doc comment content line ${i} with enough padding`);
    }
  });

  it("CONTROL — the SAME batch WITHOUT content:\"full\" still elides (the fixture and marker regex are meaningful)", async () => {
    const ws = mkDir(`${label}-control`);
    writeFile(ws, "src/commented.ts", commentedSymbolFile(4, 12));
    writeFile(ws, "src/plain.ts", "export const P = 1;\n");

    const server = startServer(ws, env);
    spawnedServers.push(server);
    await server.initialize();

    const res = await server.call({
      targets: [{ path: "src/commented.ts", symbol: "myFunc" }, { path: "src/plain.ts" }],
    });
    expect(res["kind"], JSON.stringify(res).slice(0, 400)).toBe("read.batch");
    const entry = commentedEntry(res);
    expect(entry, JSON.stringify(res)).toBeDefined();
    const content = entry!["content"] as string;
    expect(ELISION_MARKER_RE.test(content), `precondition: this fixture really does elide by default: ${content}`).toBe(true);
  });

  it("CONTROL — comments:\"keep\" alone (no content:\"full\") already worked and must keep working", async () => {
    const ws = mkDir(`${label}-keep`);
    writeFile(ws, "src/commented.ts", commentedSymbolFile(4, 12));
    writeFile(ws, "src/plain.ts", "export const P = 1;\n");

    const server = startServer(ws, env);
    spawnedServers.push(server);
    await server.initialize();

    const res = await server.call({
      targets: [{ path: "src/commented.ts", symbol: "myFunc" }, { path: "src/plain.ts" }],
      comments: "keep",
    });
    expect(res["kind"]).toBe("read.batch");
    const entry = commentedEntry(res);
    const content = entry!["content"] as string;
    expect(ELISION_MARKER_RE.test(content)).toBe(false);
  });
});
