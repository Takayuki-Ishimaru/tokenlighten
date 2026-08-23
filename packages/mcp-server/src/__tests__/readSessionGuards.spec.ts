// Guard 1 (root-mismatch note) and Guard 2 (out-of-slice concern-hit note) —
// 2026-07-12b, bench 2026-07-12a2 forensics.
//
// Guard 1: a cwd-less, handle-less read_file/search_files call silently
// resolves against the server's DEFAULT root. When another workspace also
// holds an active session, that silent resolution is a live hazard — see
// server.ts callTool and util/session.ts otherActiveRoots.
//
// Guard 2: a PARTIAL read_file mode=slice serve can miss the exact region a
// task's own query is about. When the session has harvested concern-anchor
// tokens from a prior task_pack/locate query (see readCodeTaskPack.ts
// concernAnchorTokens / util/session.ts recordConcernTokens) and the served
// window has zero hits while the unserved remainder has at least one,
// resolveSlice's range path (readCodeModes.ts buildConcernNote) attaches a
// bounded concern_note.
//
// Spawn-server harness mirrors editCodeHandle.spec.ts.

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
  const dir = fs.mkdtempSync(path.join(HOME, `.tl-guards-${tag}-`));
  tmpDirs.push(dir);
  return dir;
}

function writeFile(dir: string, rel: string, content: string): void {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
}

function startServer(opts: { cwd: string; args: string[] }): ServerHandle {
  const child: ChildProcess = spawn(
    process.execPath,
    [TSX_CLI, BIN_TS, ...opts.args],
    { cwd: opts.cwd, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env } },
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

function parseToolResult(rpcResult: any): Record<string, unknown> {
  const text = rpcResult?.result?.content?.[0]?.text;
  expect(typeof text).toBe("string");
  return JSON.parse(text);
}

// ---------------------------------------------------------------------------
// Guard 1 — root-mismatch note on cwd-less path-based calls
// ---------------------------------------------------------------------------

describe("Guard 1 — root_note on cwd-less, handle-less read_file/search_files calls", () => {
  it("only the default root active -> no root_note", async () => {
    const defaultDir = mkDir("g1-solo-default");
    writeFile(defaultDir, "src/a.ts", "export const A = 1;\nexport const B = 2;\nexport const C = 3;\n");

    const srv = startServer({ cwd: defaultDir, args: [defaultDir] });
    servers.push(srv);
    await srv.initialize();

    const res = await srv.rpc(2, "tools/call", {
      name: "read_file",
      arguments: { mode: "full", path: "src/a.ts" },
    });
    const data = parseToolResult(res);
    expect(res.result.isError).toBeFalsy();
    expect(data["root_note"]).toBeUndefined();
  });

  it("another workspace becomes active -> cwd-less call to default root carries root_note", async () => {
    const defaultDir = mkDir("g1-default");
    const worktreeDir = mkDir("g1-worktree");
    writeFile(defaultDir, "src/a.ts", "export const A = 1;\nexport const B = 2;\nexport const C = 3;\n");
    writeFile(worktreeDir, "src/w.ts", "export const W = 1;\n");

    const srv = startServer({ cwd: defaultDir, args: [defaultDir] });
    servers.push(srv);
    await srv.initialize();

    // Prime a session for worktreeDir via an explicit-cwd call (recordReadMode
    // fires unconditionally at the top of mode=task_pack, before any
    // locate branching — see server.ts).
    const primeRes = await srv.rpc(2, "tools/call", {
      name: "read_file",
      arguments: { mode: "task_pack", query: "warm session", cwd: worktreeDir },
    });
    expect(primeRes.result.isError).toBeFalsy();

    // Now a cwd-less call resolves against defaultDir (the server's own
    // positional root) while worktreeDir also holds a session.
    const res = await srv.rpc(3, "tools/call", {
      name: "read_file",
      arguments: { mode: "full", path: "src/a.ts" },
    });
    const data = parseToolResult(res);
    expect(res.result.isError).toBeFalsy();
    const note = data["root_note"];
    expect(typeof note).toBe("string");
    const noteStr = note as string;
    expect(noteStr.length).toBeLessThanOrEqual(160);
    expect(noteStr).toContain(path.basename(defaultDir));
    expect(noteStr).toContain(path.basename(worktreeDir));
    expect(noteStr).toContain("cwd");
  });

  it("handle-based cwd-less call -> no root_note even with another root active", async () => {
    const defaultDir = mkDir("g1-handle-default");
    const worktreeDir = mkDir("g1-handle-worktree");
    writeFile(defaultDir, "src/a.ts", "export const A = 1;\nexport const B = 2;\nexport const C = 3;\n");
    writeFile(worktreeDir, "src/w.ts", "export const W = 1;\n");

    const srv = startServer({ cwd: defaultDir, args: [defaultDir] });
    servers.push(srv);
    await srv.initialize();

    // Prime worktreeDir's session.
    await srv.rpc(2, "tools/call", {
      name: "read_file",
      arguments: { mode: "task_pack", query: "warm session", cwd: worktreeDir },
    });

    // Mint a handle for defaultDir via a cwd-less slice — expect a root_note
    // HERE (confirms the hazard condition is genuinely live for this call
    // shape) but capture the handle for step 3.
    const mintRes = await srv.rpc(3, "tools/call", {
      name: "read_file",
      arguments: { mode: "slice", path: "src/a.ts", range: "1-1" },
    });
    const mintData = parseToolResult(mintRes);
    expect(typeof mintData["root_note"]).toBe("string");
    // C2-3: mode="slice" now serves kind="read.text" with a FreshEvidence
    // tuple (A.5.2) — `handle` moved off the top level into `evidence[0].handle`.
    const handle = (mintData["evidence"] as Array<Record<string, unknown>>)[0]!["handle"] as string;
    expect(handle).toMatch(/^h[0-9a-z]+$/);

    // Re-slice via the handle, still cwd-less: no root_note, since a handle
    // carries its own mint root.
    const res = await srv.rpc(4, "tools/call", {
      name: "read_file",
      arguments: { handle, mode: "slice", range: "1-1" },
    });
    const data = parseToolResult(res);
    expect(res.result.isError).toBeFalsy();
    expect(data["root_note"]).toBeUndefined();
  });

  it("explicit cwd -> no root_note even with another root active", async () => {
    const defaultDir = mkDir("g1-explicit-default");
    const worktreeDir = mkDir("g1-explicit-worktree");
    writeFile(defaultDir, "src/a.ts", "export const A = 1;\nexport const B = 2;\nexport const C = 3;\n");
    writeFile(worktreeDir, "src/w.ts", "export const W = 1;\n");

    const srv = startServer({ cwd: defaultDir, args: [defaultDir] });
    servers.push(srv);
    await srv.initialize();

    await srv.rpc(2, "tools/call", {
      name: "read_file",
      arguments: { mode: "task_pack", query: "warm session", cwd: worktreeDir },
    });

    // Explicit cwd, even though it names the SAME default root — presence of
    // the field is what matters, not its value.
    const res = await srv.rpc(3, "tools/call", {
      name: "read_file",
      arguments: { mode: "full", path: "src/a.ts", cwd: defaultDir },
    });
    const data = parseToolResult(res);
    expect(res.result.isError).toBeFalsy();
    expect(data["root_note"]).toBeUndefined();
  });

  it("search_files find: cwd-less call carries root_note when another root is active", async () => {
    const defaultDir = mkDir("g1-search-default");
    const worktreeDir = mkDir("g1-search-worktree");
    writeFile(defaultDir, "src/a.ts", "export const A = 1;\nexport const B = 2;\nexport const C = 3;\n");
    writeFile(worktreeDir, "src/w.ts", "export const W = 1;\n");

    const srv = startServer({ cwd: defaultDir, args: [defaultDir] });
    servers.push(srv);
    await srv.initialize();

    await srv.rpc(2, "tools/call", {
      name: "read_file",
      arguments: { mode: "task_pack", query: "warm session", cwd: worktreeDir },
    });

    const res = await srv.rpc(3, "tools/call", {
      name: "search_files",
      arguments: { action: "find", query: "export" },
    });
    const data = parseToolResult(res);
    expect(res.result.isError).toBeFalsy();
    const note = data["root_note"];
    expect(typeof note).toBe("string");
    expect((note as string).length).toBeLessThanOrEqual(160);
  });
});

// ---------------------------------------------------------------------------
// Guard 2 — out-of-slice concern-hit note on partial reads
// ---------------------------------------------------------------------------

/**
 * A 183-line file whose "integral"/"clamp" bearing lines sit at L145-148
 * (the planted-bug region), everything else is inert filler that never
 * contains either token.
 */
function buildConcernFixture(): string {
  const lines: string[] = [];
  for (let i = 1; i <= 144; i++) {
    lines.push(`  const filler_${i} = ${i}; // unrelated line`);
  }
  lines.push("  // Integral term");                            // L145
  lines.push("  integral += error * dt;");                     // L146
  lines.push("  // TODO: clamp the integral to avoid windup");  // L147
  lines.push("  output = integral;");                           // L148
  for (let i = 149; i <= 183; i++) {
    lines.push(`  const tail_${i} = ${i}; // unrelated line`);
  }
  return lines.join("\n") + "\n";
}

describe("Guard 2 — concern_note on out-of-slice hits for a partial read_file mode=slice", () => {
  it("partial slice missing the query's concern tokens -> concern_note names the hit range", async () => {
    const wsDir = mkDir("g2-miss");
    writeFile(wsDir, "src/gain_controller.ts", buildConcernFixture());

    const srv = startServer({ cwd: wsDir, args: [wsDir] });
    servers.push(srv);
    await srv.initialize();

    // Harvest concern tokens via search_files find (recordConcernTokens also
    // fires from find's concernAnchorTokens harvest — see
    // localizationGuards.spec.ts Feature 2). NOT task_pack: this fixture is
    // small enough that a task_pack priming call now serves it in full
    // (protocol v1's Receipt-5 discharge, C2-3), so the mode=slice call below
    // would be a strict subset of already-served content and short-circuit
    // to a kind="read.receipt" code-unchanged reply — never reaching the
    // concern_note code path at all. `find` matches without serving the
    // file's body, so there is no prior full-file serve for the slice to
    // collide with.
    const findRes = await srv.rpc(2, "tools/call", {
      name: "search_files",
      arguments: { action: "find", query: "integral clamp" },
    });
    expect(findRes.result.isError).toBeFalsy();

    // Slice 1-70: the planted-bug region (L145-148) is entirely outside.
    const res = await srv.rpc(3, "tools/call", {
      name: "read_file",
      arguments: { mode: "slice", path: "src/gain_controller.ts", range: "1-70" },
    });
    const data = parseToolResult(res);
    expect(res.result.isError).toBeFalsy();
    const note = data["concern_note"];
    expect(typeof note).toBe("string");
    const noteStr = note as string;
    expect(noteStr.length).toBeLessThanOrEqual(180);
    expect(noteStr).toMatch(/145-148/);
    expect(noteStr).toMatch(/integral|clamp/);
  });

  it("slice covering the concern tokens -> no concern_note", async () => {
    const wsDir = mkDir("g2-cover");
    writeFile(wsDir, "src/gain_controller.ts", buildConcernFixture());

    const srv = startServer({ cwd: wsDir, args: [wsDir] });
    servers.push(srv);
    await srv.initialize();

    await srv.rpc(2, "tools/call", {
      name: "read_file",
      arguments: { mode: "task_pack", query: "integral clamp", path: "src/gain_controller.ts" },
    });

    const res = await srv.rpc(3, "tools/call", {
      name: "read_file",
      arguments: { mode: "slice", path: "src/gain_controller.ts", range: "140-170" },
    });
    const data = parseToolResult(res);
    expect(res.result.isError).toBeFalsy();
    expect(data["concern_note"]).toBeUndefined();
  });

  it("fires at most once per (session, path): a second missing partial slice gets no note", async () => {
    const wsDir = mkDir("g2-once");
    writeFile(wsDir, "src/gain_controller.ts", buildConcernFixture());

    const srv = startServer({ cwd: wsDir, args: [wsDir] });
    servers.push(srv);
    await srv.initialize();

    // See the sibling "partial slice missing..." test above: find-based
    // priming (not task_pack) so the mode=slice calls below stay real slice
    // serves rather than short-circuiting to a code-unchanged receipt.
    const findRes = await srv.rpc(2, "tools/call", {
      name: "search_files",
      arguments: { action: "find", query: "integral clamp" },
    });
    expect(findRes.result.isError).toBeFalsy();

    const first = await srv.rpc(3, "tools/call", {
      name: "read_file",
      arguments: { mode: "slice", path: "src/gain_controller.ts", range: "1-70" },
    });
    const firstData = parseToolResult(first);
    expect(typeof firstData["concern_note"]).toBe("string");

    // A DIFFERENT out-of-range window on the SAME file — would otherwise
    // qualify (0 served hits, unserved still has hits), but the note has
    // already fired once for this (session, path).
    const second = await srv.rpc(4, "tools/call", {
      name: "read_file",
      arguments: { mode: "slice", path: "src/gain_controller.ts", range: "71-100" },
    });
    const secondData = parseToolResult(second);
    expect(secondData["concern_note"]).toBeUndefined();
  });

  it("full-file range serve -> no concern_note even with harvested concern tokens", async () => {
    const wsDir = mkDir("g2-fullrange");
    writeFile(wsDir, "src/gain_controller.ts", buildConcernFixture());

    const srv = startServer({ cwd: wsDir, args: [wsDir] });
    servers.push(srv);
    await srv.initialize();

    await srv.rpc(2, "tools/call", {
      name: "read_file",
      arguments: { mode: "task_pack", query: "integral clamp", path: "src/gain_controller.ts" },
    });

    const res = await srv.rpc(3, "tools/call", {
      name: "read_file",
      arguments: { mode: "slice", path: "src/gain_controller.ts", range: "1-183" },
    });
    const data = parseToolResult(res);
    expect(res.result.isError).toBeFalsy();
    expect(data["concern_note"]).toBeUndefined();
  });

  it("session without any pack query -> no concern_note", async () => {
    const wsDir = mkDir("g2-noquery");
    writeFile(wsDir, "src/gain_controller.ts", buildConcernFixture());

    const srv = startServer({ cwd: wsDir, args: [wsDir] });
    servers.push(srv);
    await srv.initialize();

    // No task_pack/locate call at all this session — concernTokens stays empty.
    const res = await srv.rpc(2, "tools/call", {
      name: "read_file",
      arguments: { mode: "slice", path: "src/gain_controller.ts", range: "1-70" },
    });
    const data = parseToolResult(res);
    expect(res.result.isError).toBeFalsy();
    expect(data["concern_note"]).toBeUndefined();
  });

  // ---------------------------------------------------------------------
  // W9 (2026-08-22 root-leak forensics): the workspace DIRECTORY NAME must
  // never leak into concern-anchor tokens. A folder named "m365-drive-mount"
  // reads as three ordinary words when hyphen-split, so a query or path that
  // merely NAMES the project used to harvest "m365"/"drive"/"mount" as
  // concern tokens, which then collided with unrelated identifiers on a
  // later slice of a completely unrelated file. See concernHarvestText's
  // module doc in readCodeTaskPack.ts.
  // ---------------------------------------------------------------------
  function buildNativeMethodsFixture(): string {
    const lines: string[] = [];
    lines.push("using System;");
    lines.push("using System.Runtime.InteropServices;");
    lines.push("");
    lines.push("namespace Native {");
    lines.push("  internal static class NativeMethods {");
    for (let i = 1; i <= 150; i++) {
      lines.push(`    private const int Filler${i} = ${i}; // unrelated P/Invoke plumbing`);
    }
    lines.push("    // Mount-point registry plumbing");
    lines.push("    [DllImport(\"mpr.dll\")]");
    lines.push("    internal static extern int NetResourceMountPoint(IntPtr netResource);");
    lines.push("    internal const string M365DriveMountRegistryKey = @\"SOFTWARE\\Contoso\\M365DriveMount\";");
    lines.push("    internal static string BuildM365MountPointName(string label) => label;");
    for (let i = 151; i <= 170; i++) {
      lines.push(`    private const int Tail${i} = ${i}; // unrelated line`);
    }
    lines.push("  }");
    lines.push("}");
    return lines.join("\n") + "\n";
  }

  function mkNamedDir(tag: string, leafName: string): string {
    const parent = fs.mkdtempSync(path.join(HOME, `.tl-guards-${tag}-`));
    tmpDirs.push(parent);
    const dir = path.join(parent, leafName);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  it("W9: a query naming the workspace folder never taints an unrelated NativeMethods.cs read", async () => {
    const wsDir = mkNamedDir("rootleak", "m365-drive-mount");
    writeFile(wsDir, "NativeMethods.cs", buildNativeMethodsFixture());

    const srv = startServer({ cwd: wsDir, args: [wsDir] });
    servers.push(srv);
    await srv.initialize();

    // Prime via search_files find (not task_pack — see the "g2-miss" test
    // above: a task_pack priming call can serve a small fixture in full,
    // short-circuiting the follow-up slice to a code-unchanged receipt
    // before it ever reaches buildConcernNote). This free-text query names
    // the workspace's own folder — exactly the reported repro.
    const findRes = await srv.rpc(2, "tools/call", {
      name: "search_files",
      arguments: {
        action: "find",
        query: "Fix the m365-drive-mount project TransferBuffer.Allocate bounds check",
      },
    });
    expect(findRes.result.isError).toBeFalsy();

    // Range 1-70 excludes the mount-point identifiers (lines 156-160).
    const res = await srv.rpc(3, "tools/call", {
      name: "read_file",
      arguments: { mode: "slice", path: "NativeMethods.cs", range: "1-70" },
    });
    const data = parseToolResult(res);
    expect(res.result.isError).toBeFalsy();
    expect(data["concern_note"]).toBeUndefined();
  });

  it("F-R20: bare prose naming a root name-word (not the joined root phrase, not a real identifier) never taints an unrelated read", async () => {
    const wsDir = mkNamedDir("rootword", "m365-drive-mount");
    writeFile(wsDir, "NativeMethods.cs", buildNativeMethodsFixture());

    const srv = startServer({ cwd: wsDir, args: [wsDir] });
    servers.push(srv);
    await srv.initialize();

    const findRes2 = await srv.rpc(2, "tools/call", {
      name: "search_files",
      arguments: { action: "find", query: "Investigate why the mount keeps failing under load" },
    });
    expect(findRes2.result.isError).toBeFalsy();

    const res2 = await srv.rpc(3, "tools/call", {
      name: "read_file",
      arguments: { mode: "slice", path: "NativeMethods.cs", range: "1-70" },
    });
    const data2 = parseToolResult(res2);
    expect(res2.result.isError).toBeFalsy();
    expect(data2["concern_note"]).toBeUndefined();
  });

  it("W9 positive control: a query naming a real identifier still fires the note when it sits outside the served range", async () => {
    const wsDir = mkNamedDir("rootleak-pos", "m365-drive-mount");
    writeFile(wsDir, "NativeMethods.cs", buildNativeMethodsFixture());

    const srv = startServer({ cwd: wsDir, args: [wsDir] });
    servers.push(srv);
    await srv.initialize();

    const findRes = await srv.rpc(2, "tools/call", {
      name: "search_files",
      arguments: { action: "find", query: "Check NetResourceMountPoint release semantics" },
    });
    expect(findRes.result.isError).toBeFalsy();

    const res = await srv.rpc(3, "tools/call", {
      name: "read_file",
      arguments: { mode: "slice", path: "NativeMethods.cs", range: "1-70" },
    });
    const data = parseToolResult(res);
    expect(res.result.isError).toBeFalsy();
    const note = data["concern_note"];
    expect(typeof note).toBe("string");
    expect((note as string).toLowerCase()).toContain("netresourcemountpoint");
  });
});
