/**
 * intents.spec.ts — Phase 5 intent dispatch tests.
 *
 * Covers:
 *   - remove-duplicate-branch: applies and refuses (ambiguous case)
 *   - append-union-member: appends new member and refuses duplicate
 *   - rename-symbol-references: renames with precondition; refuses without
 *   - D10 (2026-08-14): TL_EDIT_INTENTS is permanent-on; `edit-intents-disabled`
 *     is deleted and the flag is pinned inert instead
 *   - Unknown intent → intent-unknown
 *
 * Uses the stdio-spawn pattern from editCodeHandle.spec.ts.
 * Each test creates its own tmpdir fixture via mkdtempSync/rmSync.
 */

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
  const dir = fs.mkdtempSync(path.join(HOME, `.tl-intents-${tag}-`));
  tmpDirs.push(dir);
  return dir;
}

function writeFile(dir: string, rel: string, content: string): void {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
}

function readFile(dir: string, rel: string): string {
  return fs.readFileSync(path.join(dir, rel), "utf8");
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

  function rpc(id: number, method: string, params?: unknown, timeoutMs = 30000): Promise<any> {
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
      clientInfo: { name: "vitest-intents", version: "0" },
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

function parseToolResult(rpcResult: any): Record<string, unknown> {
  const text = rpcResult?.result?.content?.[0]?.text;
  expect(typeof text).toBe("string");
  const body = JSON.parse(text);
  // v1: a read response's own addressable handle now lives at
  // `evidence[0].handle` (read.text) or `outline.handle` (read.map); mirror
  // it onto a synthetic top-level `handle` so this file's many call sites
  // keep working unchanged. Edit-family responses still carry a genuine
  // top-level `handle` (A.5.11, kept) and pass through untouched.
  if (typeof body["handle"] !== "string") {
    const evidence = Array.isArray(body["evidence"]) ? body["evidence"] : undefined;
    const fromEvidence = evidence?.[0]?.["handle"];
    const outline = body["outline"] && typeof body["outline"] === "object" ? body["outline"] : undefined;
    const fromOutline = outline?.["handle"];
    if (typeof fromEvidence === "string") body["handle"] = fromEvidence;
    else if (typeof fromOutline === "string") body["handle"] = fromOutline;
  }
  return body;
}

// ---------------------------------------------------------------------------
// Helper: get a file handle by reading a small file via read_code mode=auto
// ---------------------------------------------------------------------------
async function getFileHandle(srv: ServerHandle, rpcId: number, relPath: string): Promise<string> {
  const res = await srv.rpc(rpcId, "tools/call", {
    name: "read_file",
    arguments: { mode: "auto", path: relPath },
  });
  const data = parseToolResult(res);
  const handle = data["handle"] as string;
  expect(handle).toMatch(/^h[0-9a-z]+$/);
  return handle;
}

// Helper: get a symbol handle via read_code mode=slice
async function getSymbolHandle(srv: ServerHandle, rpcId: number, relPath: string, symbol: string): Promise<string> {
  const res = await srv.rpc(rpcId, "tools/call", {
    name: "read_file",
    arguments: { mode: "slice", path: relPath, symbol },
  });
  const data = parseToolResult(res);
  const handle = data["handle"] as string;
  expect(handle).toMatch(/^h[0-9a-z]+$/);
  return handle;
}

// ===========================================================================
// remove-duplicate-branch
// ===========================================================================

describe("intent: remove-duplicate-branch", () => {
  it("removes the second duplicate if/else-if block and returns ok:true", async () => {
    const wsDir = mkDir("dup-branch-ok");

    // TypeScript file with a clear duplicate adjacent else-if body.
    const fixture = [
      "export function classify(status: string): string {",
      "  if (status === 'A') {",
      "    return 'alpha';",
      "  } else if (status === 'B') {",
      "    return 'beta';",
      "  } else if (status === 'C') {",
      "    return 'beta';",       // same body as 'B' block
      "  } else {",
      "    return 'other';",
      "  }",
      "}",
    ].join("\n") + "\n";

    writeFile(wsDir, "src/classify.ts", fixture);

    const srv = startServer({ cwd: wsDir, args: [wsDir, "--allow-write"] });
    servers.push(srv);
    await srv.initialize();

    const handle = await getFileHandle(srv, 2, "src/classify.ts");

    const res = await srv.rpc(3, "tools/call", {
      name: "edit_file",
      arguments: { handle, intent: "remove-duplicate-branch" },
    });
    const data = parseToolResult(res);

    expect(data["kind"]).not.toBe("refusal");
    expect(data["path"]).toBe("src/classify.ts");
    expect(typeof data["lines"]).toBe("string");
    expect(typeof data["delta"]).toBe("string");

    // The 'C' block body was "return 'beta';" same as 'B'. 'C' block removed.
    const newContent = readFile(wsDir, "src/classify.ts");
    expect(newContent).not.toContain("status === 'C'");
    // 'B' block and 'else' block remain.
    expect(newContent).toContain("status === 'B'");
    expect(newContent).toContain("return 'other'");
  }, 35000);

  it("removes a terminal duplicate else-if without dropping the previous close brace", async () => {
    const wsDir = mkDir("dup-branch-terminal");

    const fixture = [
      "export function classify(status: string): string {",
      "  if (status === 'A') {",
      "    return 'same';",
      "  } else if (status === 'B') {",
      "    return 'same';",
      "  }",
      "  return 'other';",
      "}",
    ].join("\n") + "\n";

    writeFile(wsDir, "src/classify.ts", fixture);

    const srv = startServer({ cwd: wsDir, args: [wsDir, "--allow-write"] });
    servers.push(srv);
    await srv.initialize();

    const handle = await getFileHandle(srv, 2, "src/classify.ts");

    const res = await srv.rpc(3, "tools/call", {
      name: "edit_file",
      arguments: { handle, intent: "remove-duplicate-branch" },
    });
    const data = parseToolResult(res);

    expect(data["kind"]).not.toBe("refusal");
    expect(readFile(wsDir, "src/classify.ts")).toBe([
      "export function classify(status: string): string {",
      "  if (status === 'A') {",
      "    return 'same';",
      "  }",
      "  return 'other';",
      "}",
    ].join("\n") + "\n");
  }, 35000);

  it("returns intent-ambiguous when multiple duplicate pairs exist", async () => {
    const wsDir = mkDir("dup-branch-ambig");

    // Two duplicate pairs in the same chain.
    const fixture = [
      "export function classify(x: string): string {",
      "  if (x === 'A') {",
      "    return 'same';",
      "  } else if (x === 'B') {",
      "    return 'same';",       // dup of 'A'
      "  } else if (x === 'C') {",
      "    return 'same';",       // dup of 'B'
      "  }",
      "  return 'other';",
      "}",
    ].join("\n") + "\n";

    writeFile(wsDir, "src/classify.ts", fixture);

    const srv = startServer({ cwd: wsDir, args: [wsDir, "--allow-write"] });
    servers.push(srv);
    await srv.initialize();

    const handle = await getFileHandle(srv, 2, "src/classify.ts");

    const res = await srv.rpc(3, "tools/call", {
      name: "edit_file",
      arguments: { handle, intent: "remove-duplicate-branch" },
    });
    const data = parseToolResult(res);

    expect(data["kind"]).toBe("refusal");
    expect(data["code"]).toBe("intent-ambiguous");
    // D-4: was `expect(typeof nextText(data)).toBe("string")` — a tautology,
    // since nextText's return type is always `string` regardless of `data`'s
    // content, so it never actually checked anything. Empirically the wire
    // body carries a genuine `next` ToolCall (removeDuplicateBranch.ts emits
    // a legacy `read_file mode=slice handle=...` string with no range, which
    // the D-4 parser resolves to a bare re-read of that same handle); assert
    // on the real structure instead: it points the caller back at the exact
    // handle they submitted.
    const next = data["next"] as { tool?: unknown; arguments?: Record<string, unknown> } | undefined;
    expect(next?.tool, JSON.stringify(data)).toBe("read_file");
    const target = (next?.arguments?.["targets"] as Array<Record<string, unknown>> | undefined)?.[0];
    expect(target?.["handle"], JSON.stringify(data)).toBe(handle);

    // File must be unmodified.
    expect(readFile(wsDir, "src/classify.ts")).toBe(fixture);
  }, 35000);

  it("returns intent-unsupported when no duplicate pair is found", async () => {
    const wsDir = mkDir("dup-branch-none");

    const fixture = [
      "export function fn(x: string): string {",
      "  if (x === 'A') {",
      "    return 'alpha';",
      "  } else if (x === 'B') {",
      "    return 'beta';",
      "  }",
      "  return 'other';",
      "}",
    ].join("\n") + "\n";

    writeFile(wsDir, "src/fn.ts", fixture);

    const srv = startServer({ cwd: wsDir, args: [wsDir, "--allow-write"] });
    servers.push(srv);
    await srv.initialize();

    const handle = await getFileHandle(srv, 2, "src/fn.ts");

    const res = await srv.rpc(3, "tools/call", {
      name: "edit_file",
      arguments: { handle, intent: "remove-duplicate-branch" },
    });
    const data = parseToolResult(res);

    expect(data["kind"]).toBe("refusal");
    expect(data["code"]).toBe("intent-unsupported");
  }, 35000);
});

// ===========================================================================
// remove-duplicate-branch: range/scope scoping (P1 fix)
// ===========================================================================

describe("intent: remove-duplicate-branch — range scope", () => {
  it("edits only the chain within range when two chains exist", async () => {
    const wsDir = mkDir("dup-range-scope");

    // Two separate if-chains: one at lines 1-8, one at lines 10-17.
    const fixture = [
      /* 1 */ "function topChain(x: string): string {",
      /* 2 */ "  if (x === 'A') {",
      /* 3 */ "    return 'top';",
      /* 4 */ "  } else if (x === 'B') {",
      /* 5 */ "    return 'top';",
      /* 6 */ "  }",
      /* 7 */ "  return 'other';",
      /* 8 */ "}",
      /* 9 */ "",
      /* 10 */ "function bottomChain(x: string): string {",
      /* 11 */ "  if (x === 'C') {",
      /* 12 */ "    return 'bottom';",
      /* 13 */ "  } else if (x === 'D') {",
      /* 14 */ "    return 'bottom';",
      /* 15 */ "  }",
      /* 16 */ "  return 'other';",
      /* 17 */ "}",
    ].join("\n") + "\n";

    writeFile(wsDir, "src/dual.ts", fixture);

    const srv = startServer({ cwd: wsDir, args: [wsDir, "--allow-write"] });
    servers.push(srv);
    await srv.initialize();

    // Mint a range handle scoping lines 10-17 (bottom chain only).
    const readRes = await srv.rpc(2, "tools/call", {
      name: "read_file",
      arguments: { mode: "slice", path: "src/dual.ts", range: "10-17" },
    });
    const readData = parseToolResult(readRes);
    const handle = readData["handle"] as string;
    expect(handle).toMatch(/^h[0-9a-z]+$/);

    // Apply intent with the range handle.
    const res = await srv.rpc(3, "tools/call", {
      name: "edit_file",
      arguments: { handle, intent: "remove-duplicate-branch" },
    });
    const data = parseToolResult(res);
    expect(data["kind"]).not.toBe("refusal");

    const newContent = readFile(wsDir, "src/dual.ts");
    // Top chain (lines 1-8) must be untouched.
    expect(newContent).toContain("x === 'A'");
    expect(newContent).toContain("x === 'B'");
    // Bottom chain duplicate should be removed.
    expect(newContent).not.toContain("x === 'D'");
    expect(newContent).toContain("x === 'C'");
    expect(newContent).toBe([
      "function topChain(x: string): string {",
      "  if (x === 'A') {",
      "    return 'top';",
      "  } else if (x === 'B') {",
      "    return 'top';",
      "  }",
      "  return 'other';",
      "}",
      "",
      "function bottomChain(x: string): string {",
      "  if (x === 'C') {",
      "    return 'bottom';",
      "  }",
      "  return 'other';",
      "}",
    ].join("\n") + "\n");
  }, 35000);

  it("refuses with intent-no-duplicate-in-scope when no dup exists in the range", async () => {
    const wsDir = mkDir("dup-range-nodup");

    const fixture = [
      /* 1 */ "const x = 1;",
      /* 2 */ "const y = 2;",
      /* 3 */ "const z = 3;",
      /* 4 */ "",
      /* 5 */ "function withDup(v: string): string {",
      /* 6 */ "  if (v === 'A') {",
      /* 7 */ "    return 'same';",
      /* 8 */ "  } else if (v === 'B') {",
      /* 9 */ "    return 'same';",
      /* 10 */ "  }",
      /* 11 */ "  return 'other';",
      /* 12 */ "}",
    ].join("\n") + "\n";

    writeFile(wsDir, "src/nodup.ts", fixture);

    const srv = startServer({ cwd: wsDir, args: [wsDir, "--allow-write"] });
    servers.push(srv);
    await srv.initialize();

    // Range 1-3: no if-chain at all.
    const readRes = await srv.rpc(2, "tools/call", {
      name: "read_file",
      arguments: { mode: "slice", path: "src/nodup.ts", range: "1-3" },
    });
    const readData = parseToolResult(readRes);
    const handle = readData["handle"] as string;

    const res = await srv.rpc(3, "tools/call", {
      name: "edit_file",
      arguments: { handle, intent: "remove-duplicate-branch" },
    });
    const data = parseToolResult(res);
    expect(data["kind"]).toBe("refusal");
    expect(data["code"]).toBe("intent-no-duplicate-in-scope");

    // File must be unmodified.
    expect(readFile(wsDir, "src/nodup.ts")).toBe(fixture);
  }, 35000);
});

// ===========================================================================
// append-union-member
// ===========================================================================

describe("intent: append-union-member", () => {
  it('appends a new member to a string union type', async () => {
    const wsDir = mkDir("union-append-ok");

    const fixture = `export type Status = "OPEN" | "CLOSED";\n`;
    writeFile(wsDir, "src/status.ts", fixture);

    const srv = startServer({ cwd: wsDir, args: [wsDir, "--allow-write"] });
    servers.push(srv);
    await srv.initialize();

    // Use a file handle (type aliases are not found by mode=slice symbol search).
    // Pass the type name via the explicit symbol field on edit_code.
    const handle = await getFileHandle(srv, 2, "src/status.ts");

    const res = await srv.rpc(3, "tools/call", {
      name: "edit_file",
      arguments: { handle, intent: "append-union-member", symbol: "Status", target: "STALLED" },
    });
    const data = parseToolResult(res);

    expect(data["kind"]).not.toBe("refusal");
    expect(data["path"]).toBe("src/status.ts");

    const newContent = readFile(wsDir, "src/status.ts");
    expect(newContent).toContain('"OPEN"');
    expect(newContent).toContain('"CLOSED"');
    expect(newContent).toContain('"STALLED"');
    // Must be in the union, not just present somewhere.
    expect(newContent).toContain('"OPEN" | "CLOSED" | "STALLED"');
  }, 35000);

  it("refuses when target member is already present", async () => {
    const wsDir = mkDir("union-append-dup");

    const fixture = `export type Status = "OPEN" | "CLOSED";\n`;
    writeFile(wsDir, "src/status.ts", fixture);

    const srv = startServer({ cwd: wsDir, args: [wsDir, "--allow-write"] });
    servers.push(srv);
    await srv.initialize();

    const handle = await getFileHandle(srv, 2, "src/status.ts");

    const res = await srv.rpc(3, "tools/call", {
      name: "edit_file",
      arguments: { handle, intent: "append-union-member", symbol: "Status", target: "CLOSED" },
    });
    const data = parseToolResult(res);

    expect(data["kind"]).toBe("refusal");
    expect(data["code"]).toBe("intent-unsupported");

    // File must be unmodified.
    expect(readFile(wsDir, "src/status.ts")).toBe(fixture);
  }, 35000);

  it("refuses when no symbol name is provided", async () => {
    const wsDir = mkDir("union-append-nosymbol");

    const fixture = `export type Status = "OPEN" | "CLOSED";\n`;
    writeFile(wsDir, "src/status.ts", fixture);

    const srv = startServer({ cwd: wsDir, args: [wsDir, "--allow-write"] });
    servers.push(srv);
    await srv.initialize();

    // File handle only, no symbol field — should refuse.
    const handle = await getFileHandle(srv, 2, "src/status.ts");

    const res = await srv.rpc(3, "tools/call", {
      name: "edit_file",
      arguments: { handle, intent: "append-union-member", target: "STALLED" },
    });
    const data = parseToolResult(res);

    expect(data["kind"]).toBe("refusal");
    expect(data["code"]).toBe("intent-unsupported");
  }, 35000);
});

// ===========================================================================
// append-enum-member
// ===========================================================================

describe("intent: append-enum-member", () => {
  it.each([
    {
      tag: "java",
      path: "src/Status.java",
      lang: "java",
      before: "enum Status {\n  OPEN,\n  CLOSED\n}\n",
      expected: "enum Status {\n  OPEN,\n  CLOSED,\n  STALLED\n}\n",
    },
    {
      tag: "rust",
      path: "src/status.rs",
      lang: "rs",
      before: "enum Status {\n    Open,\n    Closed,\n}\n",
      expected: "enum Status {\n    Open,\n    Closed,\n    STALLED\n}\n",
    },
    {
      tag: "python",
      path: "src/status.py",
      lang: "py",
      before: "from enum import Enum\n\nclass Status(Enum):\n    OPEN = \"OPEN\"\n    CLOSED = \"CLOSED\"\n",
      expected: "from enum import Enum\n\nclass Status(Enum):\n    OPEN = \"OPEN\"\n    CLOSED = \"CLOSED\"\n    STALLED = \"STALLED\"\n",
    },
    {
      tag: "php",
      path: "src/Status.php",
      lang: "php",
      before: "<?php\nenum Status {\n  case OPEN;\n}\n",
      expected: "<?php\nenum Status {\n  case OPEN;\n  case STALLED;\n}\n",
    },
  ])("appends enum member in $tag", async ({ path: relPath, lang, before, expected }) => {
    const wsDir = mkDir(`enum-append-${lang}`);
    writeFile(wsDir, relPath, before);

    const srv = startServer({ cwd: wsDir, args: [wsDir, "--allow-write"] });
    servers.push(srv);
    await srv.initialize();

    const handle = await getFileHandle(srv, 2, relPath);
    const res = await srv.rpc(3, "tools/call", {
      name: "edit_file",
      arguments: { handle, intent: "append-enum-member", symbol: "Status", target: "STALLED", lang },
    });
    const data = parseToolResult(res);

    expect(data["kind"]).not.toBe("refusal");
    expect(readFile(wsDir, relPath)).toBe(expected);
  }, 35000);

  it("refuses duplicate enum members", async () => {
    const wsDir = mkDir("enum-append-dup");
    const fixture = "enum Status {\n  OPEN,\n  CLOSED\n}\n";
    writeFile(wsDir, "src/Status.java", fixture);

    const srv = startServer({ cwd: wsDir, args: [wsDir, "--allow-write"] });
    servers.push(srv);
    await srv.initialize();

    const handle = await getFileHandle(srv, 2, "src/Status.java");
    const res = await srv.rpc(3, "tools/call", {
      name: "edit_file",
      arguments: { handle, intent: "append-enum-member", symbol: "Status", target: "CLOSED", lang: "java" },
    });
    const data = parseToolResult(res);

    expect(data["kind"]).toBe("refusal");
    expect(data["code"]).toBe("intent-unsupported");
    expect(readFile(wsDir, "src/Status.java")).toBe(fixture);
  }, 35000);
});

// ===========================================================================
// rename-symbol-references
// ===========================================================================

describe("intent: rename-symbol-references", () => {
  it("renames symbol across files when precondition=references-reviewed", async () => {
    const wsDir = mkDir("rename-intent-ok");

    const fileA = [
      "export function greetUser(name: string): string {",
      '  return "Hello " + name;',
      "}",
    ].join("\n") + "\n";

    const fileB = [
      "import { greetUser } from './greeting';",
      'console.log(greetUser("Alice"));',
    ].join("\n") + "\n";

    writeFile(wsDir, "src/greeting.ts", fileA);
    writeFile(wsDir, "src/main.ts", fileB);

    const srv = startServer({ cwd: wsDir, args: [wsDir, "--allow-write"] });
    servers.push(srv);
    await srv.initialize();

    // Get a symbol handle for greetUser.
    const handle = await getSymbolHandle(srv, 2, "src/greeting.ts", "greetUser");

    const res = await srv.rpc(3, "tools/call", {
      name: "edit_file",
      arguments: {
        handle,
        intent: "rename-symbol-references",
        target: "greetPerson",
        precondition: "references-reviewed",
      },
    });
    const data = parseToolResult(res);

    expect(data["kind"]).not.toBe("refusal");
    expect(data["from"]).toBe("greetUser");
    expect(data["to"]).toBe("greetPerson");
    expect(typeof data["total_replacements"]).toBe("number");
    expect((data["total_replacements"] as number)).toBeGreaterThan(0);

    // Both files should have the new name.
    expect(readFile(wsDir, "src/greeting.ts")).toContain("greetPerson");
    expect(readFile(wsDir, "src/main.ts")).toContain("greetPerson");
    // Neither should still have the old name.
    expect(readFile(wsDir, "src/greeting.ts")).not.toContain("greetUser");
    expect(readFile(wsDir, "src/main.ts")).not.toContain("greetUser");
  }, 35000);

  it("refuses when precondition=references-reviewed is not supplied", async () => {
    const wsDir = mkDir("rename-intent-nopre");

    const fixture = `export function oldName(): void {}\n`;
    writeFile(wsDir, "src/fn.ts", fixture);

    const srv = startServer({ cwd: wsDir, args: [wsDir, "--allow-write"] });
    servers.push(srv);
    await srv.initialize();

    const handle = await getSymbolHandle(srv, 2, "src/fn.ts", "oldName");

    // No precondition supplied.
    const res = await srv.rpc(3, "tools/call", {
      name: "edit_file",
      arguments: { handle, intent: "rename-symbol-references", target: "newName" },
    });
    const data = parseToolResult(res);

    expect(data["kind"]).toBe("refusal");
    expect(data["code"]).toBe("intent-unsupported");
    // D-4: was `expect(typeof nextText(data)).toBe("string")` — a tautology
    // (see the 296 note above for why). Empirically this refusal carries no
    // `next` at all, only `detail`; assert both facts directly.
    expect(data["next"], JSON.stringify(data)).toBeUndefined();
    expect(data["detail"], JSON.stringify(data)).toContain("set precondition=references-reviewed after running search_files action=references");

    // File must be unmodified.
    expect(readFile(wsDir, "src/fn.ts")).toBe(fixture);
  }, 35000);

  it("refuses when handle is not kind=symbol", async () => {
    const wsDir = mkDir("rename-intent-notsymbol");

    const fixture = `export function myFn(): void {}\n`;
    writeFile(wsDir, "src/fn.ts", fixture);

    const srv = startServer({ cwd: wsDir, args: [wsDir, "--allow-write"] });
    servers.push(srv);
    await srv.initialize();

    // File handle (not symbol handle).
    const handle = await getFileHandle(srv, 2, "src/fn.ts");

    const res = await srv.rpc(3, "tools/call", {
      name: "edit_file",
      arguments: {
        handle,
        intent: "rename-symbol-references",
        target: "myNewFn",
        precondition: "references-reviewed",
      },
    });
    const data = parseToolResult(res);

    expect(data["kind"]).toBe("refusal");
    expect(data["code"]).toBe("intent-unsupported");

    // File must be unmodified.
    expect(readFile(wsDir, "src/fn.ts")).toBe(fixture);
  }, 35000);

  it("refuses when target is not a valid identifier", async () => {
    const wsDir = mkDir("rename-intent-badident");

    const fixture = `export function someFunc(): void {}\n`;
    writeFile(wsDir, "src/fn.ts", fixture);

    const srv = startServer({ cwd: wsDir, args: [wsDir, "--allow-write"] });
    servers.push(srv);
    await srv.initialize();

    const handle = await getSymbolHandle(srv, 2, "src/fn.ts", "someFunc");

    const res = await srv.rpc(3, "tools/call", {
      name: "edit_file",
      arguments: {
        handle,
        intent: "rename-symbol-references",
        target: "123-invalid",
        precondition: "references-reviewed",
      },
    });
    const data = parseToolResult(res);

    expect(data["kind"]).toBe("refusal");
    expect(data["code"]).toBe("intent-unsupported");
  }, 35000);
});

// ===========================================================================
// intent + edits[] is an explicit contract error
// ===========================================================================

describe("intent dispatch: special intents are mutually exclusive with edits[]", () => {
  it("rejects intent plus handle-bearing batch items before asking for a top-level handle", async () => {
    const wsDir = mkDir("intent-batch-conflict");
    const fixture = `export type Status = "OPEN" | "CLOSED";\n`;
    writeFile(wsDir, "src/status.ts", fixture);

    const srv = startServer({ cwd: wsDir, args: [wsDir, "--allow-write"] });
    servers.push(srv);
    await srv.initialize();
    const handle = await getFileHandle(srv, 2, "src/status.ts");

    const res = await srv.rpc(3, "tools/call", {
      name: "edit_file",
      arguments: {
        intent: "append-union-member",
        edits: [{ handle, search: '"OPEN"', replace: '"READY"' }],
      },
    });
    const data = parseToolResult(res);

    expect(data["kind"]).toBe("refusal");
    expect(data["code"]).toBe("intent-incompatible-with-batch");
    // D-4: was `expect(nextText(data)).toContain("remove intent")`. Empirically
    // this refusal carries no `next` at all (§2.6: nothing executable to
    // offer here), only `detail` — nextText's no-next detail-fallback branch
    // is what the old assertion actually exercised, so this is a direct,
    // semantics-preserving port (Archetype B).
    expect(data["next"], JSON.stringify(data)).toBeUndefined();
    expect(data["detail"], JSON.stringify(data)).toContain("remove intent");
    expect(readFile(wsDir, "src/status.ts")).toBe(fixture);
  }, 35000);
});

// ===========================================================================
// D10 (2026-08-14): TL_EDIT_INTENTS is permanent-on and `edit-intents-disabled`
// is deleted. Was "TL_EDIT_INTENTS=0 returns edit-intents-disabled".
// ===========================================================================

describe("intent dispatch: D10 — TL_EDIT_INTENTS is inert", () => {
  it("still applies an intent with TL_EDIT_INTENTS=0", async () => {
    const wsDir = mkDir("intents-disabled");

    const fixture = `export type Status = "OPEN" | "CLOSED";\n`;
    writeFile(wsDir, "src/status.ts", fixture);

    const srv = startServer({
      cwd: wsDir,
      args: [wsDir, "--allow-write"],
      env: { TL_EDIT_INTENTS: "0" },
    });
    servers.push(srv);
    await srv.initialize();

    // Same call shape as the "appends a new member" test above: a file handle
    // plus the explicit type name.
    const handle = await getFileHandle(srv, 2, "src/status.ts");

    const res = await srv.rpc(3, "tools/call", {
      name: "edit_file",
      arguments: { handle, intent: "append-union-member", symbol: "Status", target: "STALLED" },
    });
    const data = parseToolResult(res);

    expect(data["reason"]).not.toBe("edit-intents-disabled");
    expect(data["kind"], JSON.stringify(data)).toBe("edit.applied"); // D6: body `ok` is deleted; `kind` is the outcome (§2.5).

    // The intent actually ran: the union gained its member.
    expect(readFile(wsDir, "src/status.ts")).toContain('"OPEN" | "CLOSED" | "STALLED"');
  }, 35000);
});

// ===========================================================================
// Unknown intent → intent-unknown
// ===========================================================================

describe("intent dispatch: unknown intent name returns intent-unknown", () => {
  it("returns intent-unknown for an unrecognized intent", async () => {
    const wsDir = mkDir("intent-unknown");

    const fixture = `export const X = 1;\n`;
    writeFile(wsDir, "src/x.ts", fixture);

    const srv = startServer({ cwd: wsDir, args: [wsDir, "--allow-write"] });
    servers.push(srv);
    await srv.initialize();

    const handle = await getFileHandle(srv, 2, "src/x.ts");

    const res = await srv.rpc(3, "tools/call", {
      name: "edit_file",
      arguments: { handle, intent: "frobnicate-everything" },
    });
    const data = parseToolResult(res);

    expect(data["kind"]).toBe("refusal");
    expect(data["code"]).toBe("intent-unknown");
    // D-4: was `expect(typeof nextText(data)).toBe("string")` — a tautology
    // (see the 296 note above). Empirically the wire body carries a genuine
    // `next` ToolCall: `intents/index.ts`'s default case hardcodes the legacy
    // string `"edit_file search=... replace=..."`, which the D-4 parser
    // resolves to an `edit_file` call with one `edits[]` entry whose
    // search/replace are literally the filler text "..." (a generic
    // illustrative shape, not a caller-specific fix). Assert on that
    // structure directly.
    const next = data["next"] as { tool?: unknown; arguments?: Record<string, unknown> } | undefined;
    expect(next?.tool, JSON.stringify(data)).toBe("edit_file");
    const edits = next?.arguments?.["edits"] as Array<Record<string, unknown>> | undefined;
    expect(edits?.[0]?.["search"], JSON.stringify(data)).toBe("...");
    expect(edits?.[0]?.["replace"], JSON.stringify(data)).toBe("...");
  }, 35000);
});
