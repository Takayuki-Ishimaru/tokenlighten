// receiptCoverageFenceRepeat.spec.ts — candidate 2 (2026-09-05 ruling (ss)).
//
// TL_RECEIPT_COVERAGE's `covered_by` on the execution fence's OWN repeat-read
// brake (`state/session.ts`'s `heldSelfMaterialReceipt`, the "you already
// hold these exact bytes" answer `guardExecutionDiscovery` gives to a
// read/zoom of a PREPARED certificate's own evidence/edit material).
//
// WHY THIS FILE, GIVEN sfV2CombinedPin.spec.ts ALREADY HAS A "TL_RECEIPT_
// COVERAGE: covered_by rides the second, overlapping full read" TEST. That
// existing test's `fullA`/`fullB` calls read `src/plain.ts` — a path that is
// NEVER part of the open `taskPackEdit` certificate's own evidence
// (`brakeTargetPath`'s admissibleEditPaths/editedPaths/fence.evidencePaths
// union only contains sensor.hpp/sensor.cpp/monitor.cpp there) — so those
// calls fall through to the ORDINARY, fence-INDEPENDENT `coverageReceiptFor`
// path (`coverageReceiptWiring.spec.ts`'s own subject, already proven wired)
// instead of ever reaching `heldSelfMaterialReceipt` at all. This file
// exercises the ACTUAL fence brake: a repeat read of a path that IS part of
// the open certificate's own frontier, while that certificate is still
// `phase:"prepared"`.
//
// Verified live (this file's own genesis): the mechanism already carries
// `covered_by` through this path correctly at HEAD — `protocol/envelope.ts`'s
// `priorOnlyTextReceipt` recognizes `windowFor`'s per-window
// `code_unchanged:true` marker, reconstructs the `receipt:"code-unchanged"`
// tag + `handle` this legacy (`path`, no `receipt` tag) body shape lacks, and
// forwards `covered_by` unmodified through its `{...body, ...}` spread;
// `readFamily.ts`'s `receiptOf`/`projectCoveredBy` then project it onto the
// wire exactly like any other `code-unchanged` receipt. This spec is the
// regression pin for that property — see `state/session.ts`'s
// `heldSelfMaterialReceipt` doc comment (corrected 2026-09-05) for the full
// forensics correction.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
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
const HOME = process.env["HOME"] ?? process.env["USERPROFILE"] ?? os.homedir();

// ---------------------------------------------------------------------------
// Fixture — verbatim from sfV2CombinedPin.spec.ts's own sensor.hpp/sensor.cpp/
// monitor.cpp (the proven-working shape that reaches an `act.edit` prepared
// certificate over an explicit `targets:[...]` task_pack call).
// ---------------------------------------------------------------------------

function write(dir: string, rel: string, content: string): void {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
}

function buildFixture(ws: string): void {
  write(ws, "src/sensor.hpp", [
    "#pragma once",
    "namespace acme {",
    "class Sensor {",
    "public:",
    "    bool isHealthy() const;",
    "};",
    "}",
  ].join("\n") + "\n");
  write(ws, "src/sensor.cpp", [
    "#include \"sensor.hpp\"",
    "namespace acme {",
    "bool Sensor::isHealthy() const {",
    "    return true;",
    "}",
    "}",
  ].join("\n") + "\n");
  write(ws, "src/monitor.cpp", [
    "#include \"sensor.hpp\"",
    "namespace acme {",
    "void checkAll(const Sensor& s) {",
    "    if (!s.isHealthy()) {",
    "        // alert",
    "    }",
    "}",
    "}",
  ].join("\n") + "\n");
}

// ---------------------------------------------------------------------------
// Spawned-stdio server harness — same idiom as sfV2CombinedPin.spec.ts's own
// `startServer`/`rpc` (this file owns no import path into it either).
// ---------------------------------------------------------------------------

interface ServerHandle {
  initialize(): Promise<void>;
  rpc(method: string, params: unknown): Promise<unknown>;
  kill(): void;
}

function startServer(opts: { cwd: string; args: string[]; env: NodeJS.ProcessEnv }): ServerHandle {
  const child: ChildProcess = spawn(
    process.execPath,
    [TSX_CLI, BIN_TS, ...opts.args],
    { cwd: opts.cwd, stdio: ["pipe", "pipe", "pipe"], env: opts.env },
  );
  let stdoutBuf = "";
  let stderr = "";
  let nextId = 1;
  const waiters = new Map<number, (msg: unknown) => void>();

  child.stdout!.on("data", (d: Buffer) => {
    stdoutBuf += d.toString();
    let nl: number;
    while ((nl = stdoutBuf.indexOf("\n")) >= 0) {
      const line = stdoutBuf.slice(0, nl);
      stdoutBuf = stdoutBuf.slice(nl + 1);
      if (!line.trim()) continue;
      let msg: { id?: unknown };
      try {
        msg = JSON.parse(line) as { id?: unknown };
      } catch {
        continue;
      }
      const id = msg?.id;
      if (typeof id === "number" && waiters.has(id)) {
        const w = waiters.get(id)!;
        waiters.delete(id);
        w(msg);
      }
    }
  });
  child.stderr!.on("data", (d: Buffer) => {
    stderr += d.toString();
  });

  function rpc(method: string, params: unknown): Promise<unknown> {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(id);
        reject(new Error(`rpc '${method}' timed out.\n--- stderr ---\n${stderr}`));
      }, 60000);
      waiters.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  return {
    async initialize(): Promise<void> {
      await rpc("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "vitest-receipt-coverage-fence-repeat", version: "0" },
      });
      child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    },
    rpc,
    kill(): void {
      try {
        child.kill("SIGKILL");
      } catch {
        /* best effort */
      }
    },
  };
}

interface RawResponse {
  isError: boolean;
  body: Record<string, unknown>;
  text: string;
}

function toRawResponse(rpcResult: unknown): RawResponse {
  const result = (rpcResult as { result?: { content?: Array<{ text?: unknown }>; isError?: unknown } })?.result;
  const content = result?.content;
  const text: string = Array.isArray(content) && content[0]?.text ? String(content[0].text) : "";
  const isError = result?.isError === true;
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    /* plain-string error text */
  }
  return { isError, body, text };
}

async function call(srv: ServerHandle, tool: string, args: Record<string, unknown>): Promise<RawResponse> {
  return toRawResponse(await srv.rpc("tools/call", { name: tool, arguments: args }));
}

const tmpDirs: string[] = [];
const servers: ServerHandle[] = [];

afterAll(() => {
  for (const s of servers.splice(0)) s.kill();
  for (const d of tmpDirs.splice(0)) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

async function runFenceRepeatSequence(srv: ServerHandle, cwd: string): Promise<{ taskPackEdit: RawResponse; repeat: RawResponse }> {
  // (1) task_pack, explicit targets — mints an act.edit prepared certificate
  // whose frontier is exactly these three files (verbatim from
  // sfV2CombinedPin.spec.ts's own `taskPackEdit` call).
  const taskPackEdit = await call(srv, "read_file", {
    targets: [{ path: "src/sensor.hpp" }, { path: "src/sensor.cpp" }, { path: "src/monitor.cpp" }],
    query: "Add extra validation logic inside Sensor::isHealthy.",
    task: { epoch: "new" },
    cwd,
  });
  // (2) the repeat: a PLAIN PATH-addressed read of one of the certificate's
  // own evidence files, WITHOUT `taskEpoch:"new"` (the certificate stays
  // prepared) and WITHOUT `content:"full"` (which would force-serve real
  // bytes and bypass the receipt path entirely — see sfV2CombinedPin.spec.ts's
  // own `fullC` case for that contrast). This is the exact call shape that
  // reaches `heldSelfMaterialReceipt` via `guardExecutionDiscovery`'s main
  // prepared-fence branch (`brakeTargetPath` matches on `fence.evidencePaths`
  // directly from the plain `path`, so no handle threading is needed).
  const repeat = await call(srv, "read_file", {
    targets: [{ path: "src/sensor.cpp" }],
    cwd,
  });
  return { taskPackEdit, repeat };
}

describe("candidate 2 — TL_RECEIPT_COVERAGE on the execution fence's OWN repeat-read brake (spawned servers)", () => {
  let wsOn: string;
  let wsOff: string;
  let srvOn: ServerHandle;
  let srvOff: ServerHandle;

  beforeAll(async () => {
    wsOn = fs.realpathSync(fs.mkdtempSync(path.join(HOME, ".tl-rcfence-on-")));
    wsOff = fs.realpathSync(fs.mkdtempSync(path.join(HOME, ".tl-rcfence-off-")));
    tmpDirs.push(wsOn, wsOff);
    buildFixture(wsOn);
    buildFixture(wsOff);

    const envOn: NodeJS.ProcessEnv = { ...process.env, TL_RECEIPT_COVERAGE: "1" };
    const envOff: NodeJS.ProcessEnv = { ...process.env };
    delete envOff["TL_RECEIPT_COVERAGE"];
    srvOn = startServer({ cwd: wsOn, args: [wsOn], env: envOn });
    srvOff = startServer({ cwd: wsOff, args: [wsOff], env: envOff });
    servers.push(srvOn, srvOff);
    await Promise.all([srvOn.initialize(), srvOff.initialize()]);
  }, 90000);

  it("flag ON: the repeat read of the certificate's own evidence carries covered_by, honest to the served window", async () => {
    const { taskPackEdit, repeat } = await runFenceRepeatSequence(srvOn, wsOn);
    expect(taskPackEdit.isError, JSON.stringify(taskPackEdit.body).slice(0, 500)).toBe(false);
    expect((taskPackEdit.body["decision"] as Record<string, unknown> | undefined)?.["kind"]).toBe("act.edit");

    expect(repeat.isError, JSON.stringify(repeat.body).slice(0, 500)).toBe(false);
    expect(repeat.body["kind"], JSON.stringify(repeat.body)).toBe("read.receipt");
    const receipt = repeat.body["receipt"] as Record<string, unknown>;
    expect(receipt["receipt"]).toBe("code-unchanged");
    expect(typeof receipt["handle"]).toBe("string");
    expect(typeof receipt["sha"]).toBe("string");
    expect(Array.isArray(receipt["covered_by"]), JSON.stringify(repeat.body)).toBe(true);
    const coveredBy = receipt["covered_by"] as Array<Record<string, unknown>>;
    expect(coveredBy.length).toBeGreaterThan(0);
    // Honesty: every covered_by entry is a real range this session actually
    // served (task_pack's own evidence read of sensor.cpp, call #1) — never a
    // claim broader than the ledger proves. sensor.cpp is 6 lines.
    for (const span of coveredBy) {
      expect(typeof span["range"]).toBe("string");
      const match = /^(\d+)-(\d+)$/.exec(String(span["range"]));
      expect(match, JSON.stringify(span)).not.toBeNull();
      const [, start, end] = match!;
      expect(Number(start)).toBeGreaterThanOrEqual(1);
      expect(Number(end)).toBeLessThanOrEqual(6);
      if (span["served_by"] !== undefined) expect(typeof span["served_by"]).toBe("string");
    }
    // No fresh bytes ride alongside the residency claim.
    expect(repeat.body["evidence"]).toBeUndefined();
  });

  it("flag OFF: byte-identical to today — the same repeat still answers with a code-unchanged receipt, but carries NO covered_by", async () => {
    const { taskPackEdit, repeat } = await runFenceRepeatSequence(srvOff, wsOff);
    expect(taskPackEdit.isError, JSON.stringify(taskPackEdit.body).slice(0, 500)).toBe(false);
    expect((taskPackEdit.body["decision"] as Record<string, unknown> | undefined)?.["kind"]).toBe("act.edit");

    expect(repeat.isError, JSON.stringify(repeat.body).slice(0, 500)).toBe(false);
    expect(repeat.body["kind"], JSON.stringify(repeat.body)).toBe("read.receipt");
    const receipt = repeat.body["receipt"] as Record<string, unknown>;
    expect(receipt["receipt"]).toBe("code-unchanged");
    expect(typeof receipt["handle"]).toBe("string");
    expect(typeof receipt["sha"]).toBe("string");
    expect(receipt["covered_by"]).toBeUndefined();
    expect(JSON.stringify(repeat.body)).not.toContain("covered_by");
  });
});
