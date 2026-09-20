/**
 * noLegacySpellingOnWire.rc.spec.ts — 2026-09-20 legacy-spelling sweep,
 * real-server drill.
 *
 * WHY. The server refuses v0.14 legacy INPUT by default (`TL_LEGACY_INPUT`,
 * RC = refuse): top-level `mode`, `path`/`paths`, `handles`, `maxBytes`,
 * `taskProfile`, `taskEpoch`, `task_handle`, `action=… path=…` call spellings.
 * Recorded GitHub Copilot sessions showed models copying server-authored text
 * into their next call and being refused for it (4 of 34 `edit_file` calls in
 * one session came from a `profile_binding.reason` that said "declare
 * taskProfile"; an `is-a-directory` refusal advised `paths=[…]`). Every such
 * refusal costs a whole model turn.
 *
 * WHAT THIS PINS. The PROPERTY, on the real wire: no caller-facing text of a
 * refusal, hint, note, gap or continuation spells a call in the legacy dialect.
 * It deliberately does NOT pin the internal `key=value` dialect
 * (`accepted_transitions`, `next` prose, anchor-focus outlines): those strings
 * are parsed by `parseProseToolCall` / `nextStringToCall` and leave the server
 * as STRUCTURED canonical calls, so rewriting them in `{…}` spelling breaks the
 * parse and puts a raw string on the wire instead (measured during this sweep:
 * the `refusal.edit_create_target_exists` wire baseline lost its two executable
 * calls). The create-conflict case below asserts that structure explicitly.
 *
 * TWO DISCLOSED EXCLUSIONS.
 *  - Served FILE BODIES are source text, not server prose (a repository may
 *    legitimately contain the words `mode=full`), so `body`/`content`/`code`/
 *    `skeleton` strings are masked before the sweep — except the skeleton of an
 *    unrecognized-extension file, whose truncation note IS server prose and is
 *    checked separately.
 *  - `evidence[].prior` ("read_file mode=task_pack qref=…") is PROVENANCE, not
 *    an instruction ("already in context — skip"), and its spelling is part of
 *    the frozen protocol-v1 snapshot; it is out of this sweep's scope and no
 *    case below produces one.
 *
 * Harness copied from readFileScopePathDirectory.rc.spec.ts (repo convention:
 * each rc drill owns its stdio JSON-RPC harness).
 */

import { afterAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const nodeRequire = createRequire(import.meta.url);
const TSX_CLI = nodeRequire.resolve("tsx/cli");
const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN_TS = path.resolve(HERE, "..", "..", "bin.ts");
const SPAWN_TIMEOUT_MS = 120_000;

/** A call spelled in the legacy dialect, or a bare legacy key name. */
const LEGACY_SPELLING = new RegExp(
  [
    String.raw`\b(?:read_file|search_files|edit_file|read_code|edit_code|explore) (?:mode|path|paths|handle|handles|action|query|range)=`,
    String.raw`\bmode=(?:slice|full|map|symbol|closure|task_pack|digest|artifact|overview)\b`,
    String.raw`\bpaths=\[`,
    String.raw`\bhandles=\[`,
    String.raw`\btaskProfile\b`,
    String.raw`\btaskEpoch\b`,
    String.raw`\btask_handle\b`,
    String.raw`\bmaxBytes\b`,
    String.raw`\bmaxTokens\b`,
  ].join("|"),
);

const SERVICE_SRC = [
  "export class OrderService {",
  "  /**",
  "   * Cancels an order: refunds the payment, releases stock, marks it cancelled.",
  "   */",
  "  cancel(id: number): string {",
  "    return `cancelled ${id}`;",
  "  }",
  "}",
  "",
].join("\n");

function sweepWorkspace(): string {
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tl-rc-nolegacy-")));
  fs.mkdirSync(path.join(ws, "src", "service"), { recursive: true });
  fs.writeFileSync(path.join(ws, "package.json"), '{"name":"rc-no-legacy"}\n');
  fs.writeFileSync(path.join(ws, "README.md"), "# Sweep fixture\n\nOrders can be cancelled.\n");
  fs.writeFileSync(path.join(ws, "src/service/OrderService.ts"), SERVICE_SRC);
  // An extension no parser recognises, large enough to be truncated, so the
  // skeleton's own truncation note (server prose inside `skeleton`) is emitted.
  fs.writeFileSync(path.join(ws, "data.weirdext"), "alpha beta gamma delta\n".repeat(4000));
  // One 32 KB line: the truncated serve carries a `hint` naming the whole-file read.
  fs.writeFileSync(path.join(ws, "notes_single_line.txt"), "word ".repeat(6600));
  return ws;
}

interface ServerHandle {
  initialize(): Promise<void>;
  rpc(id: number, method: string, params?: unknown, timeoutMs?: number): Promise<any>;
  kill(): void;
}

const tmpDirs: string[] = [];
const spawnedServers: ServerHandle[] = [];

function startServer(ws: string): ServerHandle {
  const child: ChildProcess = spawn(process.execPath, [TSX_CLI, BIN_TS, ws, "--allow-write"], {
    cwd: ws,
    stdio: ["pipe", "pipe", "pipe"],
    // The property is about the RELEASE posture: legacy input refused. The
    // vitest setup exports TL_LEGACY_INPUT=accept for older suites, under which
    // an `unknown-arguments` refusal's `keys` list legitimately names the legacy
    // keys it would accept (`advertisedKeysForRefusal` filters them only when
    // they would be refused).
    env: { ...process.env, TL_LEGACY_INPUT: "refuse" },
  });
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

  function rpc(id: number, method: string, params?: unknown, timeoutMs = 60000): Promise<any> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(id);
        reject(new Error(`rpc '${method}' timed out after ${timeoutMs}ms.\n--- stderr ---\n${stderr}`));
      }, timeoutMs);
      waiters.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
      child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  async function initialize(): Promise<void> {
    await rpc(1, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "vitest-rc-nolegacy", version: "0" },
    });
    child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  }

  const handle: ServerHandle = {
    initialize,
    rpc,
    kill: () => { try { child.kill("SIGKILL"); } catch { /* ok */ } },
  };
  spawnedServers.push(handle);
  return handle;
}

function bodyOf(rpcResult: any): Record<string, unknown> {
  const text = rpcResult?.result?.content?.[0]?.text;
  expect(typeof text, `expected text content, got: ${JSON.stringify(rpcResult)}`).toBe("string");
  return JSON.parse(text);
}

/** Served file text is source, not server prose: mask it before sweeping. */
function serverProseOf(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(serverProseOf);
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    out[key] = (key === "body" || key === "content" || key === "code" || key === "skeleton") && typeof child === "string"
      ? "<served text>"
      : serverProseOf(child);
  }
  return out;
}

afterAll(() => {
  for (const s of spawnedServers.splice(0)) s.kill();
  for (const d of tmpDirs.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ok */ }
  }
});

describe("caller-facing wire text never spells a call in the refused legacy dialect", () => {
  it("refusals, hints, gaps and continuations across a dozen recovery paths carry no legacy spelling", async () => {
    const ws = sweepWorkspace();
    tmpDirs.push(ws);
    const server = startServer(ws);
    await server.initialize();

    const pack = bodyOf(await server.rpc(10, "tools/call", {
      name: "read_file",
      arguments: {
        query: "how is an order cancelled",
        targets: [{ path: "src/service/OrderService.ts" }, { path: "src/nope/Missing.ts" }],
        task: { epoch: "new", profile: "answer" },
        cwd: ws,
      },
    }));
    const taskId = (pack["task"] as Record<string, unknown> | undefined)?.["id"];
    const qref = pack["qref"];

    const calls: Array<{ label: string; name: string; arguments: Record<string, unknown> }> = [
      { label: "directory as a file target", name: "read_file", arguments: { targets: [{ path: "src" }] } },
      { label: "unknown symbol", name: "read_file", arguments: { targets: [{ path: "src/service/OrderService.ts", symbol: "noSuchMethod" }] } },
      { label: "unrecognized extension outline", name: "read_file", arguments: { targets: [{ path: "data.weirdext" }], content: "outline" } },
      { label: "missing file", name: "read_file", arguments: { targets: [{ path: "src/NoSuch.ts" }] } },
      { label: "single-line doc (whole-file hint)", name: "read_file", arguments: { targets: [{ path: "notes_single_line.txt" }] } },
      { label: "create over an existing file", name: "edit_file", arguments: { edits: [{ path: "README.md", create: true, content: "x\n" }] } },
      { label: "qref re-pack", name: "read_file", arguments: { qref, task: { handle: taskId } } },
      { label: "inferred profile pack", name: "read_file", arguments: { query: "where is the order cancel logic", task: { epoch: "new" } } },
      { label: "find nothing", name: "search_files", arguments: { action: "find", queries: ["zzzNoSuchThingzzz"] } },
      { label: "references", name: "search_files", arguments: { action: "references", queries: ["cancel"], scope: { path: "src" } } },
      { label: "unknown handle", name: "read_file", arguments: { targets: [{ handle: "hdoesnotexist" }] } },
      { label: "unknown argument on a write tool", name: "edit_file", arguments: { edits: [{ path: "README.md", search: "Sweep", replace: "Swept" }], bogusArgument: true } },
    ];

    const offenders: string[] = [];
    const kinds: string[] = [];
    const sweep = (label: string, body: Record<string, unknown>): void => {
      const prose = JSON.stringify(serverProseOf(body));
      const hit = LEGACY_SPELLING.exec(prose);
      if (hit !== null) {
        offenders.push(`${label}: …${prose.slice(Math.max(0, hit.index - 80), hit.index + 80)}…`);
      }
    };
    sweep("pack with one missing named path", pack);

    let id = 20;
    for (const call of calls) {
      const body = bodyOf(await server.rpc(id++, "tools/call", {
        name: call.name,
        arguments: { ...call.arguments, cwd: ws },
      }));
      sweep(call.label, body);
      kinds.push(`${call.label}=${String(body["kind"])}${body["code"] !== undefined ? ":" + String(body["code"]) : ""}`);
      if (call.label === "single-line doc (whole-file hint)") {
        // Non-vacuity: this path really emits the hint the sweep is about.
        expect(String(body["hint"] ?? ""), JSON.stringify(body).slice(0, 300)).toContain('content:"full"');
      }
      if (call.label === "unrecognized extension outline") {
        // The truncation note lives INSIDE the served skeleton text, which the
        // sweep masks — check that one piece of server prose on its own.
        const raw = JSON.stringify(body);
        const note = /\[truncated:[^\]]*\]/.exec(raw)?.[0] ?? "";
        if (LEGACY_SPELLING.test(note)) offenders.push(`${call.label} (truncation note): ${note}`);
      }
      if (call.label === "create over an existing file") {
        // The internal `key=value` transitions must leave the server as
        // STRUCTURED canonical calls, never as prose in either dialect.
        expect(body["kind"], JSON.stringify(body).slice(0, 400)).toBe("refusal");
        const shapes = [
          ...((body["alternatives"] as unknown[] | undefined) ?? []),
          ...((body["expected_shapes"] as unknown[] | undefined) ?? []),
        ];
        const structured = shapes.filter((entry) =>
          entry !== null && typeof entry === "object" && typeof (entry as Record<string, unknown>)["tool"] === "string");
        expect(structured.length, `expected executable calls, got ${JSON.stringify(shapes)}`).toBeGreaterThan(0);
        for (const entry of structured) {
          const args = (entry as Record<string, unknown>)["arguments"] as Record<string, unknown>;
          expect(Object.keys(args), JSON.stringify(entry)).not.toContain("mode");
          expect(Object.keys(args), JSON.stringify(entry)).not.toContain("handle");
        }
      }
    }

    // Non-vacuity: the drill really walked refusal AND success paths.
    expect(kinds.filter((entry) => entry.includes("=refusal")).length, kinds.join(", ")).toBeGreaterThanOrEqual(5);
    expect(kinds.some((entry) => entry.includes("=read.task_pack")), kinds.join(", ")).toBe(true);
    expect(kinds.some((entry) => entry.includes("=search.")), kinds.join(", ")).toBe(true);
    expect(offenders, offenders.join("\n")).toEqual([]);
  }, SPAWN_TIMEOUT_MS);
});
