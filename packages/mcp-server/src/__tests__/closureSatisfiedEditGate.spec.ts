// closureSatisfiedEditGate.spec.ts — 2026-07-16a: the unread-sibling
// note (server.ts's finishEdit) is gated on !isClosureSatisfied the same way
// buildConcernNote is (see closureTracking.spec.ts's "closureSatisfied —
// concern_note suppression" describe block for the read-path coverage).
// This spec proves the write-path half: when the session's closure ledger
// was already certified satisfied BEFORE the session's first edit, that
// edit's response must not carry unread_note — even though the exact same
// fixture, absent that pre-satisfaction, DOES fire it (the "control" test
// below, mirroring localizationGuards.spec.ts's proven Feature 1 recipe).
//
// Needs a real spawned server (--allow-write): finishEdit only runs inside
// dispatchTool's real edit_file path, which is gated on ALLOW_WRITE — a
// module-level constant read from argv at server.ts's import time, so it
// cannot be flipped true for an in-process callTool() in this test process
// (every other edit-path spec in this suite spawns for the same reason).

import { describe, it, expect, afterEach } from "vitest";
import { spawn, type ChildProcess } from "child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";

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
  const dir = fs.mkdtempSync(path.join(HOME, `.tl-closuresat-edit-${tag}-`));
  tmpDirs.push(dir);
  return dir;
}

function writeFile(dir: string, rel: string, content: string): void {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
}

function gitInit(dir: string): void {
  execFileSync("git", ["-C", dir, "init"], { stdio: "ignore" });
  execFileSync("git", ["-C", dir, "config", "user.email", "t@t.com"], { stdio: "ignore" });
  execFileSync("git", ["-C", dir, "config", "user.name", "T"], { stdio: "ignore" });
}

function startServer(opts: { cwd: string; args: string[] }): ServerHandle {
  const child: ChildProcess = spawn(
    process.execPath,
    [TSX_CLI, BIN_TS, ...opts.args],
    {
      cwd: opts.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      // D10 (2026-08-14): this used to pass TL_RECURSIVE_READ_CLOSURE=0 to keep
      // a sibling unread. That flag is permanent-on and deleted, so the
      // isolation is gone and the tests below assert the unconditional
      // behaviour instead.
      env: { ...process.env },
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

function parseToolResult(rpcResult: any): Record<string, unknown> {
  const text: string = rpcResult?.result?.content?.[0]?.text;
  expect(typeof text).toBe("string");
  return JSON.parse(text) as Record<string, unknown>;
}

/**
 * Proven check-generating query (readCodeTaskPack.spec.ts "(f) recordPackChecks
 * persists structured records"): against this exact 3-file shape, a
 * "STALLED status" query reliably registers a style check — token:"-stalled",
 * glob:"*.css" — plus a token-less advisory contract check. The css file
 * deliberately does NOT carry "-stalled" yet, matching the proven fixture
 * exactly, so check REGISTRATION itself is unaffected by what this spec does
 * afterward. `statusHistory.ts` is an unread sibling (never read or edited)
 * in the SAME directory as the file every test below edits, carrying the
 * >=2 concern-anchor token hits ("status", "stalled") the query harvests —
 * mirrors localizationGuards.spec.ts's Feature 1 decoy/sibling shape.
 */
function writeBaseFixture(ws: string): void {
  writeFile(ws, "apps/web/styles/tokens.css", ":root { --status-open: #0f0; }\n");
  writeFile(ws, "src/shared/status.ts", "export const Status = { OPEN: 'open', CLOSED: 'closed' } as const;\n");
  writeFile(ws, "apps/api/src/routes/tickets.ts", "export function route() {}\n");
  writeFile(
    ws,
    "src/shared/statusHistory.ts",
    "// Historical note: once a ticket's status becomes stalled it stays stalled until triage.\n" +
      "export const historyNote = \"status stalled\";\n",
  );
}

function writePreparedWiringFixture(ws: string): void {
  writeFile(ws, "package.json", '{"name":"prepared-unread-note","type":"module"}\n');
  writeFile(ws, "src/source.ts", "export function getHealth(): boolean { return true; }\n");
  writeFile(
    ws,
    "src/adapter.ts",
    "export function encodeStatus(input: { healthy: boolean }): number { return input.healthy ? 1 : 0; }\n",
  );
  writeFile(
    ws,
    "src/consumer.ts",
    [
      'import { encodeStatus } from "./adapter.js";',
      "export function sendStatus(sourceHealth: boolean): number {",
      "  return encodeStatus({ healthy: true });",
      "}",
      "",
    ].join("\n"),
  );
  writeFile(
    ws,
    "src/commentNote.ts",
    "// Historical getHealth/sendStatus/encodeStatus health wiring note only; it is not executable.\nexport const archived = true;\n",
  );
}

const TASK_PACK_QUERY = "add STALLED status to the status enum";

describe("closureSatisfied gates the unread-sibling note too (2026-07-16a)", () => {
  it("prepared edit frontier suppresses a comment-only unread sibling hint", async () => {
    const ws = mkDir("prepared");
    writePreparedWiringFixture(ws);

    const srv = startServer({ cwd: ws, args: [ws, "--allow-write"] });
    servers.push(srv);
    await srv.initialize();

    const packRes = await srv.rpc(2, "tools/call", {
      name: "read_file",
      arguments: {
        mode: "task_pack",
        query: "Wire getHealth health into sendStatus using the existing encodeStatus adapter; replace the hard-coded healthy value so false clears the output health bit.",
        paths: ["src/source.ts", "src/adapter.ts", "src/consumer.ts"],
        taskProfile: "wiring",
        cwd: ws,
      },
    });
    const pack = parseToolResult(packRes) as any;
    // execution_contract is deleted from the read.task_pack wire (A.5.1); the
    // "ready to act" fact it carried via `phase:"prepared"` is now
    // `decision.kind === "act.edit"` (A.3) — a bounded, certified edit
    // frontier (this is a wiring insertion).
    expect(pack.decision?.kind).toBe("act.edit");

    const editRes = await srv.rpc(3, "tools/call", {
      name: "edit_file",
      arguments: {
        path: "src/consumer.ts",
        cwd: ws,
        search: "return encodeStatus({ healthy: true });",
        replace: "return encodeStatus({ healthy: sourceHealth });",
      },
    });
    const data = parseToolResult(editRes);
    expect(editRes.result.isError).toBeFalsy();
    expect(data["kind"]).not.toBe("refusal");
    expect(data["unread_note"]).toBeUndefined();
  }, 30000);

  it("D10: the recursive closure internalizes the comment-only sibling, so no unread_note is owed", async () => {
    // Was the "control: without pre-satisfaction, the first edit still carries
    // unread_note" case, whose premise was an UNREAD sibling. It held only
    // because this file spawned its server with TL_RECURSIVE_READ_CLOSURE=0.
    // D10 (2026-08-14) deleted that flag, so the closure now reads
    // `statusHistory.ts` during the pack and the note has nothing to report.
    //
    // The assertion is kept non-vacuous by pinning the MECHANISM: the note is
    // absent because the sibling was internalized, not for unknown reasons.
    const ws = mkDir("control");
    writeBaseFixture(ws);

    const srv = startServer({ cwd: ws, args: [ws, "--allow-write"] });
    servers.push(srv);
    await srv.initialize();

    const packRes = await srv.rpc(2, "tools/call", {
      name: "read_file",
      arguments: { mode: "task_pack", query: TASK_PACK_QUERY, cwd: ws },
    });
    const pack = parseToolResult(packRes) as any;
    // The mechanism: the closure's `find` op pulls the comment-only sibling in
    // as a SERVED surface, so it is no longer an unread sibling to report.
    const surfacePaths = ((pack as Record<string, unknown>)["evidence"] as Array<Record<string, unknown>> ?? []).map((surface: any) => surface.path);
    expect(surfacePaths, `sibling not served: ${JSON.stringify(pack).slice(0, 600)}`)
      .toContain("src/shared/statusHistory.ts");
    // A.6.1's membership rule: `internalized` is a rare extension, so its v1
    // address is `plan.internalized`, not a seventh top-level field.
    expect(JSON.stringify(pack.plan?.internalized ?? [])).toContain('"op":"find"');

    const editRes = await srv.rpc(3, "tools/call", {
      name: "edit_file",
      arguments: {
        path: "src/shared/status.ts",
        cwd: ws,
        search: "CLOSED: 'closed'",
        replace: "CLOSED: 'closed', STALLED: 'stalled'",
      },
    });
    const data = parseToolResult(editRes);
    expect(editRes.result.isError).toBeFalsy();
    expect(data["kind"]).not.toBe("refusal");
    expect(data["unread_note"]).toBeUndefined();
  }, 30000);

  it("closure already certified complete before the first edit -> unread_note is suppressed", async () => {
    const ws = mkDir("suppressed");
    gitInit(ws);
    writeBaseFixture(ws);

    const srv = startServer({ cwd: ws, args: [ws, "--allow-write"] });
    servers.push(srv);
    await srv.initialize();

    // Register the style check while the css token is still absent.
    await srv.rpc(2, "tools/call", {
      name: "read_file",
      arguments: { mode: "task_pack", query: TASK_PACK_QUERY, cwd: ws },
    });

    // NATIVE (non-edit_file) changes satisfy every registered check — git
    // detects them as modified/untracked files, same mechanism as
    // closureMode.spec.ts's "counts native (git-detected) edits" test. No
    // edit_file call has happened yet this session. The query registers MORE
    // than the single style check (a live run showed 4 verifiable checks:
    // style + per-surface "STALLED present in <file>" contract/api checks) —
    // satisfy all of them rather than assuming the exact set, so this test
    // does not silently start asserting on a stale check count.
    writeFile(ws, "apps/web/styles/tokens.css", ":root { --status-open: #0f0; --status-stalled: #f00; }\n");
    writeFile(
      ws,
      "src/shared/status.ts",
      "export const Status = { OPEN: 'open', CLOSED: 'closed' } as const;\n// STALLED\n",
    );
    writeFile(ws, "apps/api/src/routes/tickets.ts", "export function route() {}\n// STALLED\n");

    const closureRes = await srv.rpc(3, "tools/call", {
      name: "read_file",
      arguments: { mode: "closure", cwd: ws },
    });
    const closureBody = parseToolResult(closureRes);
    // D10 (2026-08-14): with the recursive read closure unconditional, this
    // session's pack reaches `prepared` on its own, so a ceremonial
    // mode=closure call is answered by the prepared-discovery-closed receipt
    // instead of a `complete:true` tally. BOTH certify the same thing — that
    // closure is settled before the first edit — which is all this test needs.
    // v1 collapses both prior signals into the read.receipt family (A.4): a
    // pack that is already fully closed and counted ships the
    // "closure-complete" receipt; a session already at the prepared-discovery
    // fence ships "decision-unchanged" (D3(a)'s rename of
    // prepared-discovery-closed). Either one certifies "closure is settled
    // before the first edit".
    const receiptTag = (closureBody["receipt"] as { receipt?: string } | undefined)?.receipt;
    const certified = closureBody["kind"] === "read.receipt"
      && (receiptTag === "closure-complete" || receiptTag === "decision-unchanged");
    expect(certified, `closure not certified: ${JSON.stringify(closureBody)}`).toBe(true);

    // Session's FIRST successful edit_file call — closure was ALREADY
    // certified complete before this call landed.
    const editRes = await srv.rpc(4, "tools/call", {
      name: "edit_file",
      arguments: {
        path: "src/shared/status.ts",
        cwd: ws,
        search: "CLOSED: 'closed'",
        replace: "CLOSED: 'closed', STALLED: 'stalled'",
      },
    });
    const data = parseToolResult(editRes);
    expect(editRes.result.isError).toBeFalsy();
    expect(data["kind"]).not.toBe("refusal");
    expect(data["unread_note"]).toBeUndefined();
  }, 30000);
});
