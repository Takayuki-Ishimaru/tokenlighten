import { afterAll, afterEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { __testOnlyOperationV2KeyPrefix } from "../server.js";
import { resetStateStoresForTests, stateStoreFor } from "../state/stateStore.js";

type Body = Record<string, unknown>;

const nodeRequire = createRequire(import.meta.url);
const TSX_CLI = nodeRequire.resolve("tsx/cli");
const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN_TS = path.resolve(HERE, "..", "bin.ts");
const HOME = process.env["HOME"] ?? process.env["USERPROFILE"] ?? os.homedir();

const workspaces: string[] = [];

afterEach(() => {
  resetStateStoresForTests();
  for (const workspace of workspaces.splice(0)) {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// B-F1. The base (pre-v0.13) `operation_id` dispatch logic, reproduced
// VERBATIM from `git show 23a023e0:packages/mcp-server/src/server.ts` — the
// exact head this worktree branched from (CODEX-IMPL-WAVE-V013-B-REPORT.md
// "Base"). This is not a paraphrase or a hand-rolled simulation:
// `OLD_OPERATION_OVERSIZE_MARKER` and `oldParseRecordedOperation` are
// character-for-character copies of that commit's `OPERATION_OVERSIZE_MARKER`
// and `parseRecordedOperation`, and `oldDispatchDecision` reproduces that
// commit's `runEditWithOperationId` post-lookup control flow in the EXACT
// order it executes:
//   1. exact-match the oversize marker -> refuse (safe halt, no reapply);
//   2. else parse as v1 JSON;
//   3. a successful parse -> replay (no reapply);
//   4. an unreadable record — which is EXACTLY what a v:2 record produces to
//      this logic, since it has never heard of `v:2` (JSON.parse succeeds,
//      but `record["v"] !== 1`) — hits that commit's own rule, quoted
//      verbatim: "An unreadable record is treated as absent: the
//      alternative is refusing a write forever because one journal line got
//      mangled." That commit falls through, past the whole `if`, into
//      `run()`: a SECOND disk apply. THIS is the P0 downgrade hazard.
// This file's job is to prove the CURRENT server's real write path never
// leaves this old logic able to reach outcome 4.
// ---------------------------------------------------------------------------

const OLD_OPERATION_OVERSIZE_MARKER = "!oversize";

interface OldRecordedOperationOutcome {
  v: 1;
  text: string;
  isError?: true;
}

function oldParseRecordedOperation(raw: string): OldRecordedOperationOutcome | undefined {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const record = parsed as Record<string, unknown>;
    if (record["v"] !== 1 || typeof record["text"] !== "string") return undefined;
    return { v: 1, text: record["text"], ...(record["isError"] === true ? { isError: true as const } : {}) };
  } catch {
    return undefined;
  }
}

type OldDispatchDecision = "refused-oversize" | "replayed" | "would-reapply-absent";

/** Faithful copy of the OLD `runEditWithOperationId`'s post-lookup branch. */
function oldDispatchDecision(recorded: string | undefined): OldDispatchDecision {
  if (recorded !== undefined) {
    if (recorded === OLD_OPERATION_OVERSIZE_MARKER) {
      return "refused-oversize";
    }
    const replay = oldParseRecordedOperation(recorded);
    if (replay !== undefined) {
      return "replayed";
    }
    // "An unreadable record is treated as absent" (quoted verbatim above) —
    // falls through, past this whole `if`, to `run()`.
  }
  return "would-reapply-absent";
}

// ---------------------------------------------------------------------------
// Spawned `bin.ts --allow-write` server harness (fieldEvalFixtures.spec.ts
// FIXTURE F precedent — copied, not imported: that file notes "every other
// edit-capable spec in this repo... uniformly us[es] a SPAWNED bin.ts
// --allow-write child process", because a real disk apply cannot be proven
// any other way, and --allow-write cannot be toggled inside this test file's
// own already-loaded process). Needed here because the downgrade proof below
// must observe what the server's REAL write path puts on disk, not a
// pre-seeded fixture.
// ---------------------------------------------------------------------------

interface ServerHandle {
  initialize(): Promise<void>;
  call(name: string, args: Body): Promise<Body>;
  kill(): void;
}

const spawnedServers: ServerHandle[] = [];

afterAll(() => {
  for (const s of spawnedServers.splice(0)) s.kill();
});

function startWriteServer(cwd: string): ServerHandle {
  const child: ChildProcess = spawn(
    process.execPath,
    [TSX_CLI, BIN_TS, cwd, "--allow-write"],
    { cwd, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env } },
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

  function send(obj: unknown): void { child.stdin!.write(JSON.stringify(obj) + "\n"); }

  function rpc(id: number, method: string, params?: unknown, timeoutMs = 30000): Promise<any> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(id);
        reject(new Error(`rpc '${method}' timed out.\n--- stderr ---\n${stderr}`));
      }, timeoutMs);
      waiters.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
      send({ jsonrpc: "2.0", id, method, params });
    });
  }

  let nextId = 100;
  async function callFn(name: string, args: Body): Promise<Body> {
    const res = await rpc(nextId++, "tools/call", { name, arguments: args });
    const text: string = res?.result?.content?.[0]?.text;
    expect(typeof text, `no text content: ${JSON.stringify(res)}`).toBe("string");
    return JSON.parse(text) as Body;
  }

  async function initialize(): Promise<void> {
    await rpc(1, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "vitest-b2-replay-compat", version: "0" },
    });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
  }

  function kill(): void { try { child.kill("SIGKILL"); } catch { /* ok */ } }

  return { initialize, call: callFn, kill };
}

describe("B-2/B-F1 structured replay compatibility and downgrade safety", () => {
  it("negative control: a directly-injected v2 record (the pre-B-F1 legacy-key shape) is unreadable to the old dispatcher and would reapply", () => {
    // This is exactly what the server wrote to the LEGACY key BEFORE B-F1:
    // the v2 JSON verbatim, no marker. It is the shape the fix removes.
    const record = {
      v: 2,
      kind: "edit.applied",
      replay_format: "structured-v2",
      outcome_hash: "0123456789abcdef0123456789abcdef",
      counts: { applied: 1, attempted: 1, reverted: 0, unproven: 0 },
      paths: ["src/counter.ts"],
      sha: "sha256:fixture",
      checkpoint: "fixture-checkpoint",
      applied: [{ path: "src/counter.ts", slice_sha: "sha256:fixture" }],
    };
    const serialized = JSON.stringify(record);
    expect(oldParseRecordedOperation(serialized)).toBeUndefined();
    expect(oldDispatchDecision(serialized)).toBe("would-reapply-absent");
  });

  it("an old dispatcher still replays a genuine v1 record unchanged (pre-existing back-compat, unaffected by the dual-write fix)", () => {
    const v1 = JSON.stringify({ v: 1, text: JSON.stringify({ kind: "edit.applied", legacy: true }) });
    expect(oldDispatchDecision(v1)).toBe("replayed");
  });

  it("an old dispatcher still fails closed on a genuine oversize marker (pre-existing behavior, unaffected)", () => {
    expect(oldDispatchDecision(OLD_OPERATION_OVERSIZE_MARKER)).toBe("refused-oversize");
  });

  it("B-F1: the current server's real write path never leaves an old dispatcher able to reach the reapply branch", async () => {
    const workspace = fs.realpathSync(fs.mkdtempSync(path.join(HOME, ".tl-replay-compat-")));
    workspaces.push(workspace);
    const file = path.join(workspace, "src", "counter.ts");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "export const COUNT = 1;\n", "utf8");

    const srv = startWriteServer(workspace);
    spawnedServers.push(srv);
    await srv.initialize();

    const opId = "b2-compat-downgrade";
    const legacyKey = `op:${opId}`;
    const v2Key = `${__testOnlyOperationV2KeyPrefix}${opId}`;

    const first = await srv.call("edit_file", {
      path: "src/counter.ts",
      search: "COUNT = 1",
      replace: "COUNT = 2",
      operation_id: opId,
    });
    expect(first["kind"], JSON.stringify(first)).toBe("edit.applied");
    expect(fs.readFileSync(file, "utf8")).toBe("export const COUNT = 2;\n");

    // Dual-write proof: inspect the SAME on-disk, file-backed store the
    // child process just wrote to, by opening it fresh in THIS process (see
    // state/stateStore.ts's durability contract — synchronous appendFileSync
    // before the child's RPC response is even sent, so this read can never
    // race the write it is observing).
    const store = stateStoreFor(workspace);
    expect(store?.available).toBe(true);

    // Dual-write proof, part 1: the legacy key an OLD dispatcher reads is
    // UNCONDITIONALLY the oversize marker, never the real record.
    const legacyRecorded = store?.lookupOperation(legacyKey);
    expect(legacyRecorded).toBe(OLD_OPERATION_OVERSIZE_MARKER);

    // Dual-write proof, part 2: the real v2 payload lives only at the
    // collision-safe sibling key.
    const v2Recorded = store?.lookupOperation(v2Key);
    expect(v2Recorded).toBeDefined();
    expect(v2Recorded).not.toBe(OLD_OPERATION_OVERSIZE_MARKER);
    const v2Parsed = JSON.parse(v2Recorded!) as Record<string, unknown>;
    expect(v2Parsed["v"]).toBe(2);
    expect(v2Parsed["replay_format"]).toBe("structured-v2");

    // THE ACTUAL DOWNGRADE PROOF. An old dispatcher only ever calls
    // `store.lookupOperation("op:" + operationId)` — it has no notion of a
    // v2 sibling key. Feed exactly what it would see into the faithfully
    // reproduced old decision logic and confirm it fails closed instead of
    // reaching the reapply branch — this is the P0 hazard this wave fixes.
    expect(oldDispatchDecision(legacyRecorded)).toBe("refused-oversize");

    // The current (fixed) server still replays correctly on its own re-read,
    // via the v2 sibling key (existing B-2 behavior, preserved by the fix).
    const second = await srv.call("edit_file", {
      path: "src/counter.ts",
      search: "COUNT = 1",
      replace: "COUNT = 2",
      operation_id: opId,
    });
    expect(second["kind"], JSON.stringify(second)).toBe("edit.applied");
    expect(second["replayed"]).toBe(true);
    // No double apply: the file still reflects exactly one mutation.
    expect(fs.readFileSync(file, "utf8")).toBe("export const COUNT = 2;\n");
  }, 45000);
});
