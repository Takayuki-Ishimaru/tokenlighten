// taskHandleRecovery.spec.ts — Agent I (2026-09-19), TL_TASK_HANDLE_RECOVERY.
//
// THE MEASURED INCIDENT (real GitHub Copilot session log, model gpt-5.6-luna,
// 2026-09-19). A solver held a live task handle A and, on a re-pack under
// that SAME still-valid handle, was handed back a DIFFERENT task.id, B —
// content-addressed task identity (server.ts's `withTaskHandle`, keyed by
// `task-<sha16(profile\0query)>`) mints a distinct store record whenever the
// hashed profile/query text differs, even though the caller experiences it
// as continuing the same task. A and B are both then LIVE, side by side in
// the solver's own context. Two calls later the solver presented a THIRD
// string, X: B with a 12-character run (positions 52-63 of a 115-character
// handle) replaced by A's bytes at that same position — the model had
// spliced two near-identical opaque strings TokenLighten itself had put
// side by side. `resolveTaskHandle` correctly reported the splice `invalid`
// (a corrupted MAC cannot authenticate), and the refusal's only sanctioned
// transition was `retry:"new-task"` — a full re-pack for a task that was, in
// fact, still alive under B.
//
// Byte-level confirmation of the "position 52-63" claim: state/handleCodec.ts
// lays out a task handle as a 12-character ASCII scheme prefix ("tlh_task_v1_")
// followed by base64url(header || mac). `payloadRef` (PAYLOAD_REF_BYTES=9,
// OFF_PAYLOAD_REF=30) is the ONE header field that legitimately differs
// between two mintings of what a caller experiences as "the same task" —
// every field before it (token version, purpose, key id, workspace ref,
// subject ref, issuer id, store epoch) is identical for two mintings from the
// same process/workspace/epoch. Byte offsets 30 and 39 are both multiples of
// 3, so `payloadRef` lands on a clean base64 character boundary: characters
// [12+40, 12+52) = [52, 64) of the token — exactly the 12-character span the
// real incident's own transcript named. Verified directly against the task
// prompt's own B/X strings (not just derived): they share a 52-character
// prefix, a 51-character suffix, and a 12-character middle run.
//
// This spec has three parts:
//   1. Pure unit tests for `isMidSplicedHandle` / `laneTaskHandleMidSpliceMatch`
//      (state/laneTaskHandles.ts) — no server, mirrors
//      laneTaskHandlesEllipsis.spec.ts's own style for the sibling D1/E1
//      near-miss predicates this one extends.
//   2. End-to-end, SPAWNED-SERVER regression (same justification as
//      taskHandleEllipsisNearMiss.spec.ts, E1's own sibling spec: "this is
//      specifically a wire-shape regression: the fix must be visible over the
//      actual MCP transport, in the same call shape production emitted").
//      Reproduces the five-call shape end to end, plus every refusal-
//      preserving boundary TL_TASK_HANDLE_RECOVERY must never cross.
//   3. A SECOND spawned server with TL_TASK_HANDLE_RECOVERY=0 (env is fixed
//      at process spawn time, so the rollback path needs its own process),
//      proving the exact same mid-splice shape still refuses byte-for-byte
//      as it does today.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  isMidSplicedHandle,
  isSplicedHandle,
  laneTaskHandleMidSpliceMatch,
  recordLaneTaskHandle,
  resetLaneTaskHandlesForTest,
} from "../state/laneTaskHandles.js";
import { resolveTaskHandle } from "../state/stateHandles.js";

// ---------------------------------------------------------------------------
// Part 1 — pure predicate / lineage-search unit tests (no server)
// ---------------------------------------------------------------------------

/**
 * The measured incident's own B and X (task prompt, verbatim). Real,
 * captured 115-character handle-shaped strings, not hand-typed — the same
 * discipline laneTaskHandlesEllipsis.spec.ts's own `LIVE` constant follows.
 */
const MEASURED_B =
  "tlh_task_v1_AQGWsSsvY6jnsGesHUDVp2UWipaLDcxJC1NG3-v8MldtXdT-Ah7_AAAAAQyioi8Mo_OvOGt8M6tmp4QAALSfmCHdFjf0_GGvS4u9cwo";
const MEASURED_X =
  "tlh_task_v1_AQGWsSsvY6jnsGesHUDVp2UWipaLDcxJC1NG3-v8dd6Yqvz-2sexAAAAAQyioi8Mo_OvOGt8M6tmp4QAALSfmCHdFjf0_GGvS4u9cwo";

/**
 * A string the same length as `reference`, guaranteed to differ from it at
 * EVERY position — unlike a fixed filler (e.g. `"X".repeat(n)`), which can
 * coincidentally match `reference`'s own real base64 content at a boundary
 * character (measured: MEASURED_B's own byte 56 is literally 'X') and
 * silently shrink the constructed run.
 */
function distinctRun(reference: string): string {
  return Array.from(reference, (ch) => (ch === "Q" ? "R" : "Q")).join("");
}

describe("isMidSplicedHandle", () => {
  it("matches the measured incident shape (a 12-character run at the payloadRef span)", () => {
    expect(MEASURED_B.length).toBe(115);
    expect(MEASURED_X.length).toBe(115);
    expect(isMidSplicedHandle(MEASURED_X, MEASURED_B)).toBe(true);
  });

  it("the measured shape is NOT proven by isSplicedHandle — same length, so the deletion-shape check never applies", () => {
    expect(isSplicedHandle(MEASURED_X, MEASURED_B)).toBe(false);
  });

  it("is a no-op for an exact match", () => {
    expect(isMidSplicedHandle(MEASURED_B, MEASURED_B)).toBe(false);
  });

  it("is a no-op when the two strings are not the same length", () => {
    expect(isMidSplicedHandle(MEASURED_B.slice(0, -1), MEASURED_B)).toBe(false);
  });

  it("does not match a string with the wrong scheme prefix", () => {
    const foreign = `hbogus_${MEASURED_B.slice(7)}`;
    expect(foreign.length).toBe(MEASURED_B.length);
    expect(isMidSplicedHandle(foreign, MEASURED_B)).toBe(false);
  });

  it("does not match when the differing run exceeds the 16-character bound", () => {
    // `distinctRun` guarantees every injected character differs from B's own
    // character at that exact position — a fixed filler like "X".repeat(n)
    // risks landing on a base64 alphabet character B's real bytes already
    // contain at the boundary (measured: B[56] is itself literally 'X'),
    // which would silently shrink the run this test means to construct.
    const tooWide = `${MEASURED_B.slice(0, 40)}${distinctRun(MEASURED_B.slice(40, 57))}${MEASURED_B.slice(57)}`;
    expect(tooWide.length).toBe(MEASURED_B.length);
    expect(isMidSplicedHandle(tooWide, MEASURED_B)).toBe(false);
  });

  it("matches exactly AT the 16-character bound", () => {
    const atBound = `${MEASURED_B.slice(0, 40)}${distinctRun(MEASURED_B.slice(40, 56))}${MEASURED_B.slice(56)}`;
    expect(atBound.length).toBe(MEASURED_B.length);
    expect(isMidSplicedHandle(atBound, MEASURED_B)).toBe(true);
  });

  it("does not match when the surviving prefix falls below the shared-prefix floor (foreign same-length handle)", () => {
    const foreign = `tlh_task_v1_${"Q".repeat(MEASURED_B.length - 12)}`;
    expect(foreign.length).toBe(MEASURED_B.length);
    expect(isMidSplicedHandle(foreign, MEASURED_B)).toBe(false);
  });
});

describe("laneTaskHandleMidSpliceMatch", () => {
  const WORKSPACE = "/tmp/ws-midsplice-unit";
  const LANE = "unit-midsplice";

  it("resolves the lane's one live mid-splice candidate", () => {
    resetLaneTaskHandlesForTest();
    recordLaneTaskHandle(WORKSPACE, LANE, MEASURED_B);
    const match = laneTaskHandleMidSpliceMatch(WORKSPACE, LANE, MEASURED_X, (c) => c === MEASURED_B);
    expect(match).toBe(MEASURED_B);
  });

  it("does not resolve when two lane lineage handles both qualify (ambiguous)", () => {
    resetLaneTaskHandlesForTest();
    // A second live handle, built the same way (a different 12-char run at
    // the SAME position), is ALSO within the mid-splice bound of MEASURED_X.
    const secondSibling = `${MEASURED_B.slice(0, 52)}${"Z".repeat(12)}${MEASURED_B.slice(64)}`;
    expect(isMidSplicedHandle(MEASURED_X, secondSibling)).toBe(true);
    recordLaneTaskHandle(WORKSPACE, LANE, MEASURED_B);
    recordLaneTaskHandle(WORKSPACE, LANE, secondSibling);
    const match = laneTaskHandleMidSpliceMatch(WORKSPACE, LANE, MEASURED_X, () => true);
    expect(match).toBeUndefined();
  });

  it("does not resolve against a candidate the liveness check rejects", () => {
    resetLaneTaskHandlesForTest();
    recordLaneTaskHandle(WORKSPACE, LANE, MEASURED_B);
    const match = laneTaskHandleMidSpliceMatch(WORKSPACE, LANE, MEASURED_X, () => false);
    expect(match).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Part 2 — end-to-end, spawned-server regression (default ON)
// ---------------------------------------------------------------------------

const nodeRequire = createRequire(import.meta.url);
const TSX_CLI = nodeRequire.resolve("tsx/cli");
const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN_TS = path.resolve(HERE, "..", "bin.ts");
const HOME = process.env["HOME"] ?? process.env["USERPROFILE"] ?? os.homedir();

interface ServerHandle {
  initialize(): Promise<void>;
  rpc(id: number, method: string, params?: unknown, timeoutMs?: number): Promise<any>;
  kill(): void;
}

function startServer(opts: { cwd: string; args: string[]; env?: Record<string, string> }): ServerHandle {
  const child: ChildProcess = spawn(
    process.execPath,
    [TSX_CLI, BIN_TS, ...opts.args],
    { cwd: opts.cwd, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...(opts.env ?? {}) } },
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
        reject(new Error(`rpc '${method}' timed out\n--- stderr ---\n${stderr}`));
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
  function kill(): void { try { child.kill("SIGKILL"); } catch { /* ok */ } }
  return { initialize, rpc, kill };
}

function parseToolResult(rpcResult: any): Record<string, unknown> {
  const text = rpcResult?.result?.content?.[0]?.text;
  expect(typeof text, JSON.stringify(rpcResult)).toBe("string");
  return JSON.parse(String(text)) as Record<string, unknown>;
}

function writeFile(dir: string, rel: string, content: string): void {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
}

/** Longest matching run from the start of both strings. */
function commonPrefixLength(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

/**
 * Splices `b` with a `runLen`-character run of `a`'s bytes at the position
 * where `a` and `b` first diverge — the exact shape the measured incident's
 * own X is built from (a caller merging two near-identical live handles it
 * held side by side), independent of exactly where that position falls.
 */
function midSplice(a: string, b: string, runLen: number): string {
  const start = commonPrefixLength(a, b);
  return b.slice(0, start) + a.slice(start, start + runLen) + b.slice(start + runLen);
}

let cwd: string;
let srv: ServerHandle;
let rpcId = 100;
const nextId = (): number => (rpcId += 1);

async function call(name: string, args: Record<string, unknown>): Promise<any> {
  return srv.rpc(nextId(), "tools/call", { name, arguments: args });
}

async function mintLiveTaskHandle(query: string, lane: string): Promise<{ id: string; body: Record<string, unknown> }> {
  const opened = parseToolResult(await call("read_file", { query, cwd, lane, task: { epoch: "new" } }));
  expect(opened["kind"], JSON.stringify(opened)).not.toBe("refusal");
  const task = opened["task"] as Record<string, unknown> | undefined;
  const id = task?.["id"];
  expect(typeof id, JSON.stringify(opened)).toBe("string");
  return { id: id as string, body: opened };
}

/** Re-packs under `handle` with fresh literal query text — content-addressed
 * identity (`task-<sha16(profile\0query)>`, server.ts's `withTaskHandle`)
 * mints a DIFFERENT id for what the caller still experiences as the same
 * task. This is the measured precondition this whole spec exists to repair,
 * reproduced deterministically rather than replayed from an uncapturable
 * real session's exact args. */
async function repackForcingChurn(handle: string, query: string, lane: string): Promise<{ id: string; body: Record<string, unknown> }> {
  const repacked = parseToolResult(await call("read_file", { query, cwd, lane, task: { handle } }));
  expect(repacked["kind"], JSON.stringify(repacked)).not.toBe("refusal");
  const task = repacked["task"] as Record<string, unknown> | undefined;
  const id = task?.["id"];
  expect(typeof id, JSON.stringify(repacked)).toBe("string");
  return { id: id as string, body: repacked };
}

beforeAll(async () => {
  cwd = fs.mkdtempSync(path.join(HOME, ".tl-thr-"));
  fs.mkdirSync(path.join(cwd, ".git"), { recursive: true });
  writeFile(cwd, "src/shared.ts", "export const Shared = { value: 1 };\n");
  writeFile(cwd, "src/edit_target.ts", "export const X = 1;\n");
  srv = startServer({ cwd, args: [cwd, "--allow-write"] });
  await srv.initialize();
}, 120000);

afterAll(() => {
  srv?.kill();
  if (cwd) { try { fs.rmSync(cwd, { recursive: true, force: true }); } catch { /* ok */ } }
});

describe("TL_TASK_HANDLE_RECOVERY — a mangled task.handle recovers instead of dead-ending", () => {
  it("the exact five-call shape (id churn under a valid handle, then a spliced X) recovers, not refuses", async () => {
    const LANE = "thr-five-call";
    const { id: A } = await mintLiveTaskHandle("Explain src/shared.ts", LANE);
    expect(A).toMatch(/^tlh_task_v1_/);

    // call2: search_files under A — ok, no mint.
    const searched = parseToolResult(await call("search_files", {
      cwd, lane: LANE, task: { handle: A }, action: "find", queries: ["Shared"],
    }));
    expect(searched["kind"], JSON.stringify(searched)).not.toBe("refusal");

    // call3: repack under the SAME valid handle A — mints a DIFFERENT id B
    // (this test's own documented precondition, not its assertion).
    const { id: B } = await repackForcingChurn(A, "Explain src/shared.ts in more detail", LANE);
    expect(B).not.toBe(A);
    expect(B.length).toBe(A.length);

    // call4: same shape again — B again (mint-reuse fast path for B's key).
    const { id: B2, body: fourth } = await repackForcingChurn(A, "Explain src/shared.ts in more detail", LANE);
    expect(B2).toBe(B);
    const qref = fourth["qref"];

    // Build X exactly as observed: B with a 12-character run replaced by A's
    // bytes at the position where A and B first diverge.
    const X = midSplice(A, B, 12);
    expect(X).not.toBe(A);
    expect(X).not.toBe(B);
    expect(X.length).toBe(B.length);

    // call5: qref + the garbled handle X, mirroring the observed shape
    // exactly. Must NOT refuse, and task.id must itself be a handle that
    // resolves — the caller self-corrects from the response alone.
    const fifthArgs: Record<string, unknown> = { cwd, lane: LANE, task: { handle: X } };
    if (typeof qref === "string" && qref !== "") fifthArgs["qref"] = qref;
    const finalPack = parseToolResult(await call("read_file", fifthArgs));
    expect(finalPack["kind"], JSON.stringify(finalPack)).not.toBe("refusal");
    const recoveredId = (finalPack["task"] as Record<string, unknown> | undefined)?.["id"];
    expect(typeof recoveredId, JSON.stringify(finalPack)).toBe("string");
    const reResolved = resolveTaskHandle(recoveredId as string, cwd);
    expect(reResolved.ok, JSON.stringify(reResolved)).toBe(true);
  });

  it("search_files with a spliced handle and NO qref also recovers, via the lane mid-splice lineage route alone", async () => {
    const LANE = "thr-no-qref";
    const { id: A } = await mintLiveTaskHandle("Explain src/shared.ts for search", LANE);
    const { id: B } = await repackForcingChurn(A, "Explain src/shared.ts for search in more detail", LANE);
    expect(B).not.toBe(A);
    const X = midSplice(A, B, 12);

    // Deliberately no `qref` field at all: route (a) cannot fire, so a
    // non-refusal here proves route (b) alone recovered.
    const searched = parseToolResult(await call("search_files", {
      cwd, lane: LANE, task: { handle: X }, action: "find", queries: ["Shared"],
    }));
    expect(searched["kind"], JSON.stringify(searched)).not.toBe("refusal");
  });

  it("a live handle with a few characters repeated after it (second measured shape) recovers on search_files, with no qref", async () => {
    // Live GitHub Copilot session, 2026-09-19: the model sent the whole valid
    // 115-character handle followed by its own last seven characters again.
    const LANE = "thr-tail-extension";
    const { id: A } = await mintLiveTaskHandle("Explain src/shared.ts tail", LANE);
    const stuttered = `${A}${A.slice(-7)}`;
    const searched = parseToolResult(await call("search_files", {
      cwd, lane: LANE, task: { handle: stuttered }, action: "find", queries: ["Shared"],
    }));
    expect(searched["kind"], JSON.stringify(searched)).toBe("search.matches");
    // Bounded: a long tail is not a stutter, and another lane never inherits the proof.
    const longTail = parseToolResult(await call("search_files", {
      cwd, lane: LANE, task: { handle: `${A}${"Q".repeat(17)}` }, action: "find", queries: ["Shared"],
    }));
    expect(longTail["kind"], JSON.stringify(longTail)).toBe("refusal");
    expect(longTail["code"]).toBe("handle-unknown");
    const otherLane = parseToolResult(await call("search_files", {
      cwd, lane: "thr-tail-extension-other", task: { handle: stuttered }, action: "find", queries: ["Shared"],
    }));
    expect(otherLane["kind"], JSON.stringify(otherLane)).toBe("refusal");
  });

  it("a garbage handle with no near lineage still refuses (no false recovery)", async () => {
    const LANE = "thr-garbage";
    const { id: A } = await mintLiveTaskHandle("Explain src/shared.ts for garbage check", LANE);
    const garbage = `tlh_task_v1_${"Z".repeat(A.length - "tlh_task_v1_".length)}`;
    expect(garbage.length).toBe(A.length);

    const refused = parseToolResult(await call("read_file", {
      query: "Explain src/shared.ts for garbage check", cwd, lane: LANE, task: { handle: garbage },
    }));
    expect(refused["kind"], JSON.stringify(refused)).toBe("refusal");
    expect(refused["code"]).toBe("handle-unknown");
  });

  it("a spliced handle presented under a DIFFERENT lane still refuses (never crosses lanes)", async () => {
    const laneOwner = "thr-lane-owner";
    const laneOther = "thr-lane-other";
    const { id: A } = await mintLiveTaskHandle("Explain src/shared.ts for lane check", laneOwner);
    const { id: B } = await repackForcingChurn(A, "Explain src/shared.ts for lane check in more detail", laneOwner);
    expect(B).not.toBe(A);
    const X = midSplice(A, B, 12);

    const refused = parseToolResult(await call("read_file", {
      query: "Explain src/shared.ts for lane check in more detail", cwd, lane: laneOther, task: { handle: X },
    }));
    expect(refused["kind"], JSON.stringify(refused)).toBe("refusal");
    expect(refused["code"]).toBe("handle-unknown");
  });

  it("edit_file never recovers a spliced task handle (strict authentication only)", async () => {
    const LANE = "thr-edit-strict";
    // The task_handle's own identity is unrelated to the file edit_file will
    // touch below — minting uses the proven-churning shared.ts query pair
    // (same pattern as every other test in this spec) purely to obtain two
    // live sibling handles to splice; src/edit_target.ts is the edit target.
    const { id: A } = await mintLiveTaskHandle("Explain src/shared.ts for edit check", LANE);
    const { id: B } = await repackForcingChurn(A, "Explain src/shared.ts for edit check in more detail", LANE);
    expect(B).not.toBe(A);
    const X = midSplice(A, B, 12);

    const editRes = parseToolResult(await call("edit_file", {
      path: "src/edit_target.ts", search: "X = 1", replace: "X = 2",
      task: { handle: X }, cwd, lane: LANE,
    }));
    expect(editRes["kind"], JSON.stringify(editRes)).toBe("refusal");
    expect(editRes["code"]).toBe("handle-unknown");
  });
});

// ---------------------------------------------------------------------------
// Part 2b — the incident's REAL trigger: a declared profile lost on re-packs
// ---------------------------------------------------------------------------
//
// The session log shows WHY the second id existed at all. Call 1 declared
// `task.profile:"answer"` (pack profile "answer", id A); calls 3-4 re-packed
// the same qref under handle A WITHOUT restating the profile, the profile was
// re-inferred, the misfire guardrail served "generic", and — task identity
// hashing the profile together with the query — that minted B. server.ts's
// `inheritDeclaredTaskProfile` keeps the declared profile for a continuation
// of the same task, so the re-pack stays an answer pack under the SAME id and
// the caller never holds two near-identical handles to splice. Part 2's
// recovery remains the safety net for every other way a handle gets mangled.

interface PackView { kind: unknown; profile: unknown; id: string; qref: string; reason: string }

function packView(body: Record<string, unknown>): PackView {
  const task = body["task"] as Record<string, unknown> | undefined;
  const binding = body["profile_binding"] as Record<string, unknown> | undefined;
  return {
    kind: body["kind"],
    profile: body["profile"],
    id: String(task?.["id"] ?? ""),
    qref: String(body["qref"] ?? ""),
    reason: String(binding?.["reason"] ?? ""),
  };
}

describe("a declared task.profile persists across re-packs of the same task", () => {
  // Every re-pack below sends `force_serve:true`: this two-file workspace
  // certifies its first pack, and a plain re-pack of a certified decision is
  // answered by a `decision-unchanged` receipt, which carries no profile or
  // task id to assert on. The incident's own re-packs were uncertified
  // (`discover`) and came back as packs; `force_serve` reproduces that
  // response family without depending on how much the first pack closes.
  // No interrogative marker, no no-edit wording: undeclared, this infers
  // "generic" — the premise that made the incident possible.
  const STATEMENT_QUERY = "Shared value handling in src/shared.ts and the X constant";
  // Interrogative and symptom-free: undeclared, this infers "answer".
  const QUESTION_QUERY = "what does the Shared constant do?";

  it("premise: the same queries, undeclared, infer the OTHER profile", async () => {
    const statement = packView(parseToolResult(await call("read_file", {
      query: STATEMENT_QUERY, cwd, lane: "thr-profile-premise-a", targets: [{ path: "src/shared.ts" }], task: { epoch: "new" },
    })));
    expect(statement.kind).toBe("read.task_pack");
    expect(statement.profile).toBe("generic");
    const question = packView(parseToolResult(await call("read_file", {
      query: QUESTION_QUERY, cwd, lane: "thr-profile-premise-b", targets: [{ path: "src/shared.ts" }], task: { epoch: "new" },
    })));
    expect(question.kind).toBe("read.task_pack");
    expect(question.profile).toBe("answer");
  });

  it("answer declared on call 1, omitted on the qref+targets re-pack under its handle: still answer, SAME task.id", async () => {
    const LANE = "thr-profile-answer";
    const opened = packView(parseToolResult(await call("read_file", {
      query: STATEMENT_QUERY, cwd, lane: LANE, targets: [{ path: "src/shared.ts" }], task: { epoch: "new", profile: "answer" },
    })));
    expect(opened.kind).toBe("read.task_pack");
    expect(opened.profile).toBe("answer");
    expect(opened.qref).not.toBe("");

    const repackedBody = parseToolResult(await call("read_file", {
      qref: opened.qref, cwd, lane: LANE, targets: [{ path: "src/edit_target.ts" }], task: { handle: opened.id, force_serve: true },
    }));
    const repacked = packView(repackedBody);
    expect(repacked.kind, JSON.stringify(repackedBody)).toBe("read.task_pack");
    expect(repacked.profile).toBe("answer");
    expect(repacked.id, "one task, one handle — nothing to splice").toBe(opened.id);
    expect(repacked.reason).toContain("kept for this continuation");
    expect(opened.reason).not.toContain("kept for this continuation");
  });

  it("a bare qref re-pack with no handle inherits through the qref's own task binding", async () => {
    const LANE = "thr-profile-bare-qref";
    const opened = packView(parseToolResult(await call("read_file", {
      query: STATEMENT_QUERY, cwd, lane: LANE, targets: [{ path: "src/shared.ts" }], task: { epoch: "new", profile: "answer" },
    })));
    const repacked = packView(parseToolResult(await call("read_file", {
      qref: opened.qref, cwd, lane: LANE, targets: [{ path: "src/edit_target.ts" }], task: { force_serve: true },
    })));
    expect(repacked.profile).toBe("answer");
    expect(repacked.id).toBe(opened.id);
  });

  it("one direction only: generic declared on call 1 is NOT carried over — a question-shaped re-pack still narrows to answer, as before", async () => {
    const LANE = "thr-profile-generic";
    const opened = packView(parseToolResult(await call("read_file", {
      query: QUESTION_QUERY, cwd, lane: LANE, targets: [{ path: "src/shared.ts" }], task: { epoch: "new", profile: "generic" },
    })));
    expect(opened.profile).toBe("generic");
    const repacked = packView(parseToolResult(await call("read_file", {
      qref: opened.qref, cwd, lane: LANE, targets: [{ path: "src/edit_target.ts" }], task: { handle: opened.id, force_serve: true },
    })));
    expect(repacked.profile).toBe("answer");
    expect(repacked.reason).not.toContain("kept for this continuation");
  });

  it("a restated profile always wins over the inherited one", async () => {
    const LANE = "thr-profile-restated";
    const opened = packView(parseToolResult(await call("read_file", {
      query: STATEMENT_QUERY, cwd, lane: LANE, targets: [{ path: "src/shared.ts" }], task: { epoch: "new", profile: "answer" },
    })));
    const repacked = packView(parseToolResult(await call("read_file", {
      qref: opened.qref, cwd, lane: LANE, targets: [{ path: "src/edit_target.ts" }], task: { handle: opened.id, profile: "generic", force_serve: true },
    })));
    expect(repacked.profile).toBe("generic");
    expect(repacked.reason).not.toContain("kept for this continuation");
  });

  it("a new epoch never inherits, and neither does a different query under the same handle", async () => {
    const LANE = "thr-profile-boundaries";
    const opened = packView(parseToolResult(await call("read_file", {
      query: STATEMENT_QUERY, cwd, lane: LANE, targets: [{ path: "src/shared.ts" }], task: { epoch: "new", profile: "answer" },
    })));
    const otherQuery = packView(parseToolResult(await call("read_file", {
      query: `${STATEMENT_QUERY} again`, cwd, lane: LANE, targets: [{ path: "src/shared.ts" }], task: { handle: opened.id, force_serve: true },
    })));
    expect(otherQuery.profile, "a different query is a different task identity").toBe("generic");
    const newEpoch = packView(parseToolResult(await call("read_file", {
      query: STATEMENT_QUERY, cwd, lane: LANE, targets: [{ path: "src/shared.ts" }], task: { epoch: "new" },
    })));
    expect(newEpoch.profile, "task.epoch:new severs the task, declaration included").toBe("generic");
  });
});

// ---------------------------------------------------------------------------
// Part 3 — TL_TASK_HANDLE_RECOVERY=0: byte-identical refusal, the rollback path
// ---------------------------------------------------------------------------
//
// Env is fixed at process spawn time, so the rollback path needs its own
// server instance — mutating process.env from the test process cannot reach
// an already-running child.

describe("TL_TASK_HANDLE_RECOVERY=0 — the exact mid-splice shape that recovers by default still refuses, byte-for-byte", () => {
  let srvOff: ServerHandle;
  let cwdOff: string;

  beforeAll(async () => {
    cwdOff = fs.mkdtempSync(path.join(HOME, ".tl-thr-off-"));
    fs.mkdirSync(path.join(cwdOff, ".git"), { recursive: true });
    writeFile(cwdOff, "src/off.ts", "export const Off = 1;\n");
    srvOff = startServer({ cwd: cwdOff, args: [cwdOff], env: { TL_TASK_HANDLE_RECOVERY: "0" } });
    await srvOff.initialize();
  }, 120000);

  afterAll(() => {
    srvOff?.kill();
    if (cwdOff) { try { fs.rmSync(cwdOff, { recursive: true, force: true }); } catch { /* ok */ } }
  });

  it("refuses handle-unknown with today's exact hint, no did_you_mean, retry new-task", async () => {
    async function callOff(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
      return parseToolResult(await srvOff.rpc(nextId(), "tools/call", { name, arguments: args }));
    }
    const LANE = "thr-off";
    const opened = await callOff("read_file", { query: "Explain src/off.ts", cwd: cwdOff, lane: LANE, task: { epoch: "new" } });
    expect(opened["kind"], JSON.stringify(opened)).not.toBe("refusal");
    const A = String((opened["task"] as Record<string, unknown>)["id"]);

    const query2 = "Explain src/off.ts, in more detail";
    const repacked = await callOff("read_file", { query: query2, cwd: cwdOff, lane: LANE, task: { handle: A } });
    expect(repacked["kind"], JSON.stringify(repacked)).not.toBe("refusal");
    const B = String((repacked["task"] as Record<string, unknown>)["id"]);
    expect(B, "id churn is this test's own precondition too — the flag governs RECOVERY, not minting").not.toBe(A);
    const X = midSplice(A, B, 12);

    const refused = await callOff("read_file", { query: query2, cwd: cwdOff, lane: LANE, task: { handle: X } });
    expect(refused["kind"], JSON.stringify(refused)).toBe("refusal");
    expect(refused["code"]).toBe("handle-unknown");
    expect(refused["did_you_mean"]).toBeUndefined();
    expect(String(refused["hint"] ?? "")).toContain("failed authentication");
    expect(refused["retry"]).toBe("new-task");
  });
});
