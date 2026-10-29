import {afterEach, describe, expect, it, vi} from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {mintReadCallContinuation, readCallExecutionKey, resolveReadCallContinuation} from "../state/readCallContinuationStore.js";
import {resolveReadCallCursorAlias} from "../state/readCallCursorAliases.js";
import {mintTaskHandle, resolveTaskHandle, resolveFetchRequestHandle, TASK_HANDLE_TTL_MS} from "../state/stateHandles.js";
import {validateHandleToken} from "../state/handleCodec.js";
import {resetStateStoresForTests, stateStoreFor} from "../state/stateStore.js";
import {compactTaskHandle} from "../state/taskHandleAliases.js";
import {runWithSessionLane} from "../util/laneKey.js";
import {shaOfText, type HandleEntry} from "../util/handles.js";
import {hydrateReadCallContinuation as hydrateReadCall, projectReadCallContinuations as projectReadCalls} from "../protocol/readCallContinuation.js";

import {beginReadCallDispatch, resetReadCallDispatchForTests, withReadCallDispatch} from "../state/readCallDispatch.js";
type Obj = Record<string, unknown>;
function projectReadCallContinuations(ws: string, lane: string, body: Obj, read: (file: string) => Promise<string | null>, resolve: (handle: string) => HandleEntry | undefined) {
  return withReadCallDispatch(ws, lane, binding => projectReadCalls(ws, lane, body, read, resolve, binding));
}
function hydrateReadCallContinuation(ws: string, lane: string, args: Obj, read: (file: string) => Promise<string | null>, resolve: (handle: string) => HandleEntry | undefined, validate?: (input: Obj) => Obj | undefined) {
  return withReadCallDispatch(ws, lane, binding => hydrateReadCall(ws, lane, args, read, resolve, validate, binding));
}
const roots: string[] = [];
function setup(lane = "") {
  const workspaceRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tl-read-call-"))); roots.push(workspaceRoot);
  const taskHandle = runWithSessionLane(lane, () => mintTaskHandle(workspaceRoot, {taskFingerprint: "original-task", mintedAtMs: Date.now()})!);
  const source = Array.from({length: 100}, (_, i) => "export const value" + i + " = " + i + ";").join("\n") + "\n";
  const originalInput = {query: "注文の状態遷移と外部サービスの呼び出し順をすべて根拠付きで説明してください。".repeat(8),
    targets: Array.from({length: 50}, (_, i) => ({path: "src/flow.ts", range: String(i + 1) + "-" + String(i + 1)})),
    select: {comments: "keep"}, budget: {bytes: 18432}, task: {handle: taskHandle, profile: "answer"}};
  const sources = [{path: "src/flow.ts", sha: shaOfText(source)}];
  return {workspaceRoot, lane, taskHandle, source, originalInput, sources, dispatchBinding: {nonce: "store-unit", generation: 1}};
}
const mint = (s: ReturnType<typeof setup>) => {
  const scope = beginReadCallDispatch(s.workspaceRoot, s.lane)!;
  try { return mintReadCallContinuation({...s, dispatchBinding: scope.binding})!; }
  finally { scope.finish(); }
};
const resolve = (s: ReturnType<typeof setup>, cursor: string) => {
  const alias = resolveReadCallCursorAlias({workspaceRoot: s.workspaceRoot, lane: s.lane, cursor});
  return resolveReadCallContinuation({...s, cursor: alias.kind === "canonical" ? alias.cursor : cursor});
};
const noHandles = (): HandleEntry | undefined => undefined;
afterEach(() => {
  vi.restoreAllMocks(); resetStateStoresForTests(); resetReadCallDispatchForTests();
  for (const root of roots.splice(0)) fs.rmSync(root, {recursive: true, force: true});
});

describe("immutable read-call continuation store", () => {
  it("restores all 50 ranges and the full Japanese query without task writes", () => {
    const s = setup("lane"), before = resolveTaskHandle(s.taskHandle, s.workspaceRoot), store = stateStoreFor(s.workspaceRoot)!;
    const writes = vi.spyOn(store, "put");
    const cursor = mint(s), result = resolve(s, cursor);
    expect(result.kind).toBe("read-call");
    if (result.kind !== "read-call") throw new Error("missing plan");
    expect(result.input).toEqual(s.originalInput);
    expect(result.state.source_bindings).toEqual(s.sources);
    expect(resolveTaskHandle(s.taskHandle, s.workspaceRoot)).toEqual(before);
    expect(writes).toHaveBeenCalledTimes(2);
    expect(writes.mock.calls.every(([call]) => call.purpose === "read-request" && call.expectedVersion === 0)).toBe(true);
    expect(writes.mock.calls[0]![0]).toMatchObject({purpose: "read-request", expectedVersion: 0});
    expect(writes.mock.calls[0]![0].data).not.toHaveProperty("source");
    expect(writes.mock.calls[0]![0].data).not.toHaveProperty("body");
  });

  it("detaches mutable caller inputs and every resolved copy", () => {
    const s = setup(), expected = structuredClone(s.originalInput), cursor = mint(s);
    s.originalInput.targets.pop(); s.sources[0]!.path = "changed.ts";
    const a = resolve(s, cursor);
    if (a.kind !== "read-call") throw new Error("missing plan");
    expect(a.input).toEqual(expected);
    (a.input.targets as unknown[]).pop(); a.state.source_bindings[0]!.path = "also-changed.ts";
    const b = resolve(s, cursor);
    expect(b.kind === "read-call" && b.input).toEqual(expected);
  });

  it("keeps independent plans immutable across replay, task progress and reload", () => {
    const s = setup(), a = mint(s), expected = structuredClone(s.originalInput);
    s.originalInput.targets = [{path: "src/flow.ts", range: "100-110"}];
    const b = mint(s);
    expect(a).not.toBe(b);
    mintTaskHandle(s.workspaceRoot, {taskFingerprint: "original-task", replay: "later", mintedAtMs: Date.now()});
    resetStateStoresForTests();
    expect(resolve(s, a).kind === "read-call" && (resolve(s, a) as any).input).toEqual(expected);
    expect((resolve(s, b) as any).input.targets).toEqual(s.originalInput.targets);
  });

  it("isolates lane/task/workspace and fails closed on tampered or lost tokens", () => {
    const s = setup("one"), cursor = mint(s), other = setup();
    expect(resolveReadCallContinuation({...s, lane: "two", cursor}).kind).toBe("refusal");
    const task = mintTaskHandle(s.workspaceRoot, {taskFingerprint: "different-task", mintedAtMs: Date.now()})!;
    expect(resolveReadCallContinuation({...s, taskHandle: task, cursor}).kind).toBe("refusal");
    expect(resolveReadCallContinuation({...other, cursor}).kind).not.toBe("read-call");
    expect(resolve(s, cursor.slice(0, -1) + (cursor.endsWith("a") ? "b" : "a")).kind).not.toBe("read-call");
    resetStateStoresForTests(); fs.rmSync(path.join(s.workspaceRoot, ".tokenlighten", "state"), {recursive: true, force: true});
    expect(resolve(s, cursor).kind).not.toBe("read-call");
  });

  it.each(["original_input", "source_bindings", "version"])("rejects a corrupt %s binding", field => {
    const s = setup(), cursor = mint(s), store = stateStoreFor(s.workspaceRoot)!;
    const decoded = validateHandleToken({token: cursor, expectedPurpose: "read-request", workspaceRoot: s.workspaceRoot});
    if (!decoded.ok) throw new Error("missing token");
    const record = store.get(decoded.decoded.payloadRef)!;
    if (field === "original_input") (record.data.original_input as any).query = "another query";
    else if (field === "source_bindings") (record.data.source_bindings as any)[0].sha = shaOfText("other bytes");
    else store.put({key: record.key, purpose: "read-request", data: record.data, expectedVersion: 1, ttlMs: 60000});
    expect(resolve(s, cursor).kind).toBe("refusal");
  });

  it("bounds lifetime by the parent and rejects expiry", () => {
    const start = Date.now();
    const now = vi.spyOn(Date, "now").mockReturnValue(start);
    const s = setup();
    now.mockReturnValue(start + TASK_HANDLE_TTL_MS - 3000);
    const cursor = mint(s), record = resolve(s, cursor);
    expect(record.kind).toBe("read-call");
    if (record.kind !== "read-call") throw new Error("missing plan");
    expect(record.state.expires_at_ms - record.state.created_at_ms).toBeLessThanOrEqual(3000);
    now.mockReturnValue(start + TASK_HANDLE_TTL_MS + 1000);
    expect(resolve(s, cursor).kind).not.toBe("read-call");
  });

  it("bounds record size and source paths, and falls back on persistence failure", () => {
    const s = setup();
    const invalidMint = (overrides: Partial<Parameters<typeof mintReadCallContinuation>[0]>) => {
      const scope = beginReadCallDispatch(s.workspaceRoot, s.lane)!;
      try { return mintReadCallContinuation({...s, ...overrides, dispatchBinding: scope.binding}); }
      finally { scope.finish(); }
    };
    for (const file of ["../outside", "/absolute", "C:/outside", "a\\b", "a/../b"]) {
      expect(invalidMint({sources: [{path: file, sha: s.sources[0]!.sha}]})).toBeUndefined();
    }
    expect(invalidMint({sources: [...s.sources, ...s.sources]})).toBeUndefined();
    expect(invalidMint({originalInput: {...s.originalInput, query: "a".repeat(65536)}})).toBeUndefined();
    expect(invalidMint({originalInput: {...s.originalInput, targets: Array(65).fill({path: "src/flow.ts", range: "1-1"})}})).toBeUndefined();
    const store = stateStoreFor(s.workspaceRoot)!;
    vi.spyOn(store, "put").mockImplementation(() => {throw new Error("disk full")});
    expect(mint(s)).toBeUndefined();
  });

  it("leaves ordinary raw-read cursors to their existing handler", () => {
    const s = setup(), cursor = mint(s), resolved = resolveFetchRequestHandle(cursor, s.workspaceRoot, "read-request");
    if (!resolved.ok) throw new Error("missing record");
    (resolved.record.data as any).family = "read";
    expect(resolve(s, cursor).kind).toBe("other");
  });
});

describe("read-call projection and hydration", () => {
  function body(s: ReturnType<typeof setup>) {
    const next = {tool: "tl_read_file", arguments: {cwd: s.workspaceRoot, ...(s.lane ? {lane: s.lane} : {}), ...s.originalInput}};
    return {kind: "read.task_pack", task: {id: s.taskHandle}, decision: {kind: "discover", next},
      plan: {change_contract: {stages: [{next}]}}, evidence: [{body: JSON.stringify(next), next}], entries: [next], data: {next}};
  }


  it("compacts an ordinary sub-1024-byte plan and restores its exact parent without a copied handle", async () => {
    const s = setup("worker"), original = body(s);
    original.decision.next.arguments.query = "Explain the branch conditions and invocation order in this source; retain every requested constraint.";
    original.decision.next.arguments.targets = [{path: "src/flow.ts", range: "10-20"}, {path: "src/flow.ts", range: "30-40"}];
    expect(Buffer.byteLength(JSON.stringify(original.decision.next.arguments))).toBeLessThan(1024);
    const projected = await projectReadCallContinuations(s.workspaceRoot, s.lane, original, async () => s.source, noHandles) as any;
    const compact = projected.decision.next.arguments;
    expect(compact.cursor).toMatch(/^tlc_s1_[A-Za-z0-9_-]{12}_[A-Za-z0-9_-]{22}$/);
    expect(compact.cursor).toHaveLength(42);
    expect(compact.task).toBeUndefined();
    expect(compact.query).toBeUndefined();
    expect(compact.targets).toBeUndefined();
    expect(Buffer.byteLength(JSON.stringify(compact))).toBeLessThan(Buffer.byteLength(JSON.stringify(original.decision.next.arguments)));
    expect(await projectReadCallContinuations(s.workspaceRoot, s.lane, projected, async () => s.source, noHandles)).toBe(projected);
    // Re-projection above is another dispatch; only the exact stored windows may recover.
    const restored = await hydrateReadCallContinuation(s.workspaceRoot, s.lane, compact, async () => s.source, noHandles);
    expect(restored.kind).toBe("hydrated");
    if (restored.kind !== "hydrated") throw new Error("missing parent restoration");
    expect(restored.input.targets).toEqual(original.decision.next.arguments.targets);
    expect(restored.input.task).toEqual(s.originalInput.task);
    expect(restored.input.query).toBeUndefined();
    expect(restored.input.content).toBe("full");
  });

  it("binds a response profile echo without rewriting the original executable call", async () => {
    const s = setup();
    delete (s.originalInput.task as any).profile;
    const original = {...body(s), profile: "answer"};
    const projected = await projectReadCallContinuations(s.workspaceRoot, s.lane, original, async () => s.source, noHandles) as any;
    const cursor = projected.decision.next.arguments.cursor;
    const state = resolve(s, cursor);
    expect(state.kind).toBe("read-call");
    if (state.kind !== "read-call") throw new Error("missing plan");
    expect(state.state.response_profile).toBe("answer");
    expect(state.input).toEqual(s.originalInput);
    const result = await hydrateReadCallContinuation(s.workspaceRoot, s.lane, {cursor, task: {profile: "answer"}}, async () => s.source, noHandles);
    expect(result.kind === "hydrated" && result.input.query).toBe(s.originalInput.query);
    expect(result.kind === "hydrated" && result.input.task).toEqual(s.originalInput.task);
  });

  it("rejects a profile change against response metadata before source reads or claims", async () => {
    const s = setup();
    delete (s.originalInput.task as any).profile;
    const projected = await projectReadCallContinuations(s.workspaceRoot, s.lane, {...body(s), profile: "answer"},
      async () => s.source, noHandles) as any;
    const cursor = projected.decision.next.arguments.cursor, state = resolve(s, cursor);
    if (state.kind !== "read-call") throw new Error("missing plan");
    const read = vi.fn(async () => s.source), store = stateStoreFor(s.workspaceRoot)!, writes = vi.spyOn(store, "put");
    const result = await hydrateReadCallContinuation(s.workspaceRoot, s.lane, {cursor, task: {profile: "generic"}}, read, noHandles);
    expect(result.kind === "refusal" && result.refusal.field).toBe("task.profile");
    expect(read).not.toHaveBeenCalled(); expect(writes).not.toHaveBeenCalled();
    expect(store.get(readCallExecutionKey(state.state))!.data.status).toBe("pending");
  });

  it("authenticates the response profile metadata", () => {
    const s = setup(), cursor = mint(s), store = stateStoreFor(s.workspaceRoot)!;
    const decoded = validateHandleToken({token: cursor, expectedPurpose: "read-request", workspaceRoot: s.workspaceRoot});
    if (!decoded.ok) throw new Error("missing token");
    store.get(decoded.decoded.payloadRef)!.data.response_profile = "answer";
    expect(resolve(s, cursor).kind).toBe("refusal");
  });

  it("does not rescue an explicitly malformed or wrong parent or consume its claim", async () => {
    const s = setup(), cursor = mint(s), plan = resolve(s, cursor);
    if (plan.kind !== "read-call") throw new Error("missing plan");
    const different = mintTaskHandle(s.workspaceRoot, {taskFingerprint: "another-parent", mintedAtMs: Date.now()})!;
    const alias = compactTaskHandle(s.workspaceRoot, s.lane, s.taskHandle);
    const badTasks: unknown[] = [null, [], "", "{}", {handle: undefined}, {handle: null},
      {handle: ""}, {handle: 7}, {handle: different}, {handle: alias + "x"}, {profile: "generic"}];
    const store = stateStoreFor(s.workspaceRoot)!, writes = vi.spyOn(store, "put");
    for (const task of badTasks) {
      const result = await hydrateReadCallContinuation(s.workspaceRoot, s.lane, {cursor, task}, async () => s.source, noHandles);
      expect(result.kind, JSON.stringify(task)).toBe("refusal");
      expect(store.get(readCallExecutionKey(plan.state))!.data.status).toBe("pending");
    }
    expect(writes).not.toHaveBeenCalled();
    const restored = await hydrateReadCallContinuation(s.workspaceRoot, s.lane, {cursor}, async () => s.source, noHandles);
    expect(restored.kind === "hydrated" && restored.input.task).toEqual(s.originalInput.task);
    expect(restored.kind === "hydrated" && restored.input.targets).toEqual(s.originalInput.targets);
  });

  it.each(["restart", "concurrent", "force", "budget"])("keeps cursor-only %s recovery inside the immutable windows", async reason => {
    const s = setup(), cursor = mint(s), expected = structuredClone(s.originalInput.targets);
    if (reason === "restart") {resetStateStoresForTests(); resetReadCallDispatchForTests();}
    const args = {cursor, ...(reason === "force" ? {task: {force_serve: true}} : {}),
      ...(reason === "budget" ? {budget: {bytes: 4096}} : {})};
    const results = reason === "concurrent"
      ? await Promise.all([args, args].map(input => hydrateReadCallContinuation(s.workspaceRoot, s.lane, input, async () => s.source, noHandles)))
      : [await hydrateReadCallContinuation(s.workspaceRoot, s.lane, args, async () => s.source, noHandles)];
    for (const result of results) {
      expect(result.kind).toBe("hydrated");
      if (result.kind !== "hydrated") throw new Error("missing fixed recovery");
      expect(result.input.targets).toEqual(expected);
      expect(result.input.query).toBeUndefined();
      expect(result.input.content).toBe("full");
      expect((result.input.task as Obj).handle).toBe(s.taskHandle);
    }
  });

  it("shortens only authoritative controls, keeping source and arbitrary objects exact", async () => {
    const s = setup(), original = body(s);
    const projected = await projectReadCallContinuations(s.workspaceRoot, s.lane, original, async () => s.source, noHandles) as any;
    const compact = projected.decision.next.arguments;
    expect(compact.cursor).toMatch(/^tlc_s1_[A-Za-z0-9_-]{12}_[A-Za-z0-9_-]{22}$/);
    expect(compact.cursor).toHaveLength(42);
    expect(Object.keys(compact).sort()).toEqual(["cursor", "cwd"]);
    expect(Buffer.byteLength(JSON.stringify(compact))).toBeLessThan(Buffer.byteLength(JSON.stringify(original.decision.next.arguments)) * 0.3);
    expect(projected.plan.change_contract.stages[0].next.arguments).toEqual(compact);
    expect(projected.evidence).toEqual(original.evidence);
    expect(projected.entries).toEqual(original.entries);
    expect(projected.data).toEqual(original.data);
    expect(original.decision.next.arguments).not.toHaveProperty("cursor");
    const hydrated = await hydrateReadCallContinuation(s.workspaceRoot, s.lane, compact, async () => s.source, noHandles);
    expect(hydrated.kind === "hydrated" && hydrated.input).toEqual({cwd: s.workspaceRoot, ...s.originalInput});
  });

  it("leaves expanded next intact when source resolution or persistence fails", async () => {
    const s = setup(), original = body(s);
    expect(await projectReadCallContinuations(s.workspaceRoot, s.lane, original, async () => null, noHandles)).toBe(original);
    vi.spyOn(stateStoreFor(s.workspaceRoot)!, "put").mockReturnValue({ok: false, outcome: "store-unavailable"});
    expect(await projectReadCallContinuations(s.workspaceRoot, s.lane, original, async () => s.source, noHandles)).toBe(original);
  });

  it("authenticates source handles in the same workspace and lane", async () => {
    const s = setup("worker"), original = body(s), targets = original.decision.next.arguments.targets as any[];
    targets.forEach(t => {delete t.path; t.handle = "hsource"});
    const entry: HandleEntry = {id: "hsource", purpose: "content", kind: "file", workspaceRoot: s.workspaceRoot, lane: s.lane, path: "src/flow.ts", createdAt: 1};
    expect(await projectReadCallContinuations(s.workspaceRoot, "other", original, async () => s.source, () => entry)).toBe(original);
    const projected = await projectReadCallContinuations(s.workspaceRoot, s.lane, original, async () => s.source, () => entry) as any;
    const cursor = projected.decision.next.arguments.cursor;
    expect(cursor).toBeDefined();
    const mismatched = await hydrateReadCallContinuation(s.workspaceRoot, s.lane, projected.decision.next.arguments, async () => s.source,
      () => ({...entry, path: "src/other.ts"}));
    expect(mismatched.kind === "refusal" && mismatched.refusal.code).toBe("cursor-invalid");
  });

  it("checks source revisions before any execution claim or task write", async () => {
    const s = setup(), cursor = mint(s), store = stateStoreFor(s.workspaceRoot)!, writes = vi.spyOn(store, "put");
    const result = await hydrateReadCallContinuation(s.workspaceRoot, s.lane, {cursor, task: {handle: s.taskHandle}}, async () => "new revision", noHandles);
    expect(result.kind === "refusal" && result.refusal.code).toBe("cursor-stale");
    expect(writes).not.toHaveBeenCalled();
  });

  it.each([false, true])("accepts only an identical profile echo, force=%s", async force => {
    const s = setup(), cursor = mint(s);
    const result = await hydrateReadCallContinuation(s.workspaceRoot, s.lane,
      {cursor, task: {handle: s.taskHandle, profile: "answer", ...(force ? {force_serve: true} : {})}},
      async () => s.source, noHandles);
    expect(result.kind).toBe("hydrated");
    if (result.kind !== "hydrated") throw new Error("missing input");
    expect((result.input.task as any).profile).toBe("answer");
    if (force) expect(result.input).not.toHaveProperty("query");
    else expect(result.input.query).toBe(s.originalInput.query);
    expect(result.input.targets).toEqual(s.originalInput.targets);
  });

  it.each(["generic", "", null, 1])("rejects a changed or malformed profile before claiming execution: %j", async profile => {
    const s = setup(), cursor = mint(s), writes = vi.spyOn(stateStoreFor(s.workspaceRoot)!, "put");
    const result = await hydrateReadCallContinuation(s.workspaceRoot, s.lane,
      {cursor, task: {handle: s.taskHandle, profile}}, async () => s.source, noHandles);
    expect(result.kind === "refusal" && result.refusal.field).toBe("task.profile");
    expect(writes).not.toHaveBeenCalled();
    const original = await hydrateReadCallContinuation(s.workspaceRoot, s.lane, {cursor}, async () => s.source, noHandles);
    expect(original.kind).toBe("hydrated");
  });

  it("does not add a profile to a stored plan without one", async () => {
    const s = setup();
    delete (s.originalInput.task as any).profile;
    const cursor = mint(s), writes = vi.spyOn(stateStoreFor(s.workspaceRoot)!, "put");
    const result = await hydrateReadCallContinuation(s.workspaceRoot, s.lane,
      {cursor, task: {profile: "answer"}}, async () => s.source, noHandles);
    expect(result.kind === "refusal" && result.refusal.field).toBe("task.profile");
    expect(writes).not.toHaveBeenCalled();
  });

  it("resolves aliases and retains explicit CAS, budgets and representation", async () => {
    const s = setup("lane"), cursor = mint(s), alias = compactTaskHandle(s.workspaceRoot, s.lane, s.taskHandle);
    const before = resolveTaskHandle(s.taskHandle, s.workspaceRoot);
    const failed = await hydrateReadCallContinuation(s.workspaceRoot, s.lane, {cursor, task: {handle: alias, expected_state_version: 0}}, async () => s.source, noHandles);
    expect(failed.kind === "refusal" && failed.refusal.code).toBe("state-conflict");
    if (!before.ok) throw new Error("missing task");
    const result = await hydrateReadCallContinuation(s.workspaceRoot, s.lane, {cursor, budget: {bytes: 4096}, task: {handle: alias, force_serve: true, expected_state_version: before.stateVersion}}, async () => s.source, noHandles);
    expect(result.kind).toBe("hydrated");
    if (result.kind !== "hydrated") throw new Error("missing input");
    expect(result.input.query).toBeUndefined(); // override/CAS retry restores only fixed windows
    expect(result.input.budget).toEqual({bytes: 4096});
    expect(result.input.select).toEqual({comments: "keep"});
    expect(result.input.task).toEqual({...s.originalInput.task, force_serve: true, expected_state_version: before.stateVersion});
    expect(resolveTaskHandle(s.taskHandle, s.workspaceRoot)).toEqual(before);
  });

  it("recovers only original ranges after a successor, response loss and restart", async () => {
    const s = setup(), a = mint(s), args = {cursor: a, task: {handle: s.taskHandle}};
    const first = await hydrateReadCallContinuation(s.workspaceRoot, s.lane, args, async () => s.source, noHandles);
    expect(first.kind === "hydrated" && first.input.query).toBe(s.originalInput.query);
    const expected = structuredClone(s.originalInput.targets);
    s.originalInput.targets = [{path: "src/flow.ts", range: "80-90"}];
    const b = mint(s);
    await hydrateReadCallContinuation(s.workspaceRoot, s.lane, {cursor: b, task: args.task}, async () => s.source, noHandles);
    resetStateStoresForTests();
    for (const force of [false, true]) {
      const replay = await hydrateReadCallContinuation(s.workspaceRoot, s.lane, {...args, task: {...args.task, force_serve: force}}, async () => s.source, noHandles);
      expect(replay.kind).toBe("hydrated");
      if (replay.kind !== "hydrated") throw new Error("missing replay");
      expect(replay.input.targets).toEqual(expected);
      expect(replay.input.content).toBe("full");
      expect(replay.input).not.toHaveProperty("query");
      expect(replay.input).not.toHaveProperty("qref");
      expect((replay.input.task as any).force_serve).toBe(force);
    }
  });

  it("authorizes replay projection only after authenticated unchanged-source recovery", async () => {
    const s = setup(), cursor = mint(s), args = {cursor, task: {handle: s.taskHandle}};
    const first = await hydrateReadCallContinuation(s.workspaceRoot, s.lane, args, async () => s.source, noHandles);
    expect(first.kind === "hydrated" && first.replayAuthorization).toBeUndefined();
    const replay = await hydrateReadCallContinuation(s.workspaceRoot, s.lane, args, async () => s.source, noHandles);
    expect(replay.kind).toBe("hydrated");
    if (replay.kind !== "hydrated") throw new Error("missing authenticated recovery");
    expect(replay.replayAuthorization?.taskHandle).toBe(s.taskHandle);
    expect(replay.replayAuthorization?.sourceBindings).toEqual(s.sources);
    expect(replay.replayAuthorization?.targets).toHaveLength(50);
    expect(replay.replayAuthorization?.targets[0]).toEqual({path: "src/flow.ts", ranges: ["1-1"]});
    const forced = await hydrateReadCallContinuation(s.workspaceRoot, s.lane,
      {...args, task: {...args.task, force_serve: true}}, async () => s.source, noHandles);
    expect(forced.kind === "hydrated" && forced.replayAuthorization).toBeUndefined();
    const overridden = await hydrateReadCallContinuation(s.workspaceRoot, s.lane,
      {...args, budget: {bytes: 4096}}, async () => s.source, noHandles);
    expect(overridden.kind === "hydrated" && overridden.replayAuthorization).toBeUndefined();
  });

  it("recovers fixed independent plans under concurrent same-lane activity", async () => {
    const s = setup(), a = mint(s), b = mint(s), before = resolveTaskHandle(s.taskHandle, s.workspaceRoot);
    const results = await Promise.all([a, a, b].map(cursor => hydrateReadCallContinuation(s.workspaceRoot, s.lane, {cursor, task: {handle: s.taskHandle}}, async () => s.source, noHandles)));
    const inputs = results.map(r => r.kind === "hydrated" ? r.input : undefined);
    expect(inputs.filter(r => r?.query !== undefined)).toHaveLength(0);
    expect(inputs.filter(r => r?.content === "full")).toHaveLength(3);
    expect(inputs.every(r => JSON.stringify(r?.targets) === JSON.stringify(s.originalInput.targets))).toBe(true);
    expect(resolveTaskHandle(s.taskHandle, s.workspaceRoot)).toEqual(before);
  });

  it.each(["intervening call", "restart", "force", "budget"])("uses fixed recovery on first use after %s", async reason => {
    const s = setup(), cursor = mint(s);
    if (reason === "intervening call") await withReadCallDispatch(s.workspaceRoot, s.lane, async () => undefined); // search-only progress, no range/task write
    if (reason === "restart") {resetStateStoresForTests(); resetReadCallDispatchForTests();}
    const args = {cursor, task: {handle: s.taskHandle, ...(reason === "force" ? {force_serve: true} : {})},
      ...(reason === "budget" ? {budget: {bytes: 4096}} : {})};
    const result = await hydrateReadCallContinuation(s.workspaceRoot, s.lane, args, async () => s.source, noHandles);
    expect(result.kind).toBe("hydrated");
    if (result.kind !== "hydrated") throw new Error("missing recovery");
    expect(result.input).not.toHaveProperty("query");
    expect(result.input.content).toBe("full");
    expect(result.input.targets).toEqual(s.originalInput.targets);
  });

  it("holds the semantic lane lease through dispatch and releases it on cancellation", async () => {
    const s = setup(), cursor = mint(s);
    let ready!: () => void, release!: () => void, otherRan = false;
    const entered = new Promise<void>(resolve => {ready = resolve;});
    const blocked = new Promise<void>(resolve => {release = resolve;});
    const first = withReadCallDispatch(s.workspaceRoot, s.lane, async binding => {
      const result = await hydrateReadCall(s.workspaceRoot, s.lane, {cursor, task: {handle: s.taskHandle}}, async () => s.source, noHandles, undefined, binding);
      expect(result.kind === "hydrated" && result.input.query).toBe(s.originalInput.query);
      ready();
      await blocked;
      throw new Error("cancelled after claim");
    });
    const failure = first.catch(error => error.message);
    await entered;
    const other = withReadCallDispatch(s.workspaceRoot, s.lane, async () => {otherRan = true;});
    await Promise.resolve();
    expect(otherRan).toBe(false);
    release();
    expect(await failure).toBe("cancelled after claim");
    await other;
    expect(otherRan).toBe(true);
    resetStateStoresForTests(); resetReadCallDispatchForTests();
    const replay = await hydrateReadCallContinuation(s.workspaceRoot, s.lane, {cursor, task: {handle: s.taskHandle, force_serve: true}}, async () => s.source, noHandles);
    expect(replay.kind === "hydrated" && replay.input.content).toBe("full");
    expect(replay.kind === "hydrated" && replay.input.query).toBeUndefined();
  });

  it("does not publish from a newer dispatch while an older call can still change state", () => {
    const s = setup(), older = beginReadCallDispatch(s.workspaceRoot, s.lane)!;
    const newer = beginReadCallDispatch(s.workspaceRoot, s.lane)!;
    const writes = vi.spyOn(stateStoreFor(s.workspaceRoot)!, "put");
    expect(mintReadCallContinuation({...s, dispatchBinding: newer.binding})).toBeUndefined();
    expect(writes).not.toHaveBeenCalled();
    newer.finish(); // The older call could still progress after the attempted publication.
    expect(mintReadCallContinuation({...s, dispatchBinding: older.binding})).toBeUndefined();
    older.finish();
    expect(resolve(s, mint(s)).kind).toBe("read-call");
  });

  it("keeps a stored force_serve request on fixed recovery when no override is sent", async () => {
    const s = setup();
    (s.originalInput.task as Obj).force_serve = true;
    const cursor = mint(s);
    const result = await hydrateReadCallContinuation(s.workspaceRoot, s.lane,
      {cursor, task: {handle: s.taskHandle}}, async () => s.source, noHandles);
    expect(result.kind).toBe("hydrated");
    if (result.kind !== "hydrated") throw new Error("missing forced recovery");
    expect(result.input.query).toBeUndefined();
    expect(result.input.content).toBe("full");
    expect(result.input.targets).toEqual(s.originalInput.targets);
    expect((result.input.task as Obj).force_serve).toBe(true);
  });

  it("refuses a selectively lost execution marker instead of granting another first use", async () => {
    const s = setup(), cursor = mint(s), resolved = resolve(s, cursor);
    if (resolved.kind !== "read-call") throw new Error("missing plan");
    const args = {cursor, task: {handle: s.taskHandle}};
    await hydrateReadCallContinuation(s.workspaceRoot, s.lane, args, async () => s.source, noHandles);
    stateStoreFor(s.workspaceRoot)!.delete(readCallExecutionKey(resolved.state));
    resetStateStoresForTests();
    const replay = await hydrateReadCallContinuation(s.workspaceRoot, s.lane, args, async () => s.source, noHandles);
    expect(replay.kind).toBe("refusal");
    expect(resolve(s, cursor).kind).toBe("read-call"); // immutable plan survived
  });

  it("does not consume a claim for invalid restored input", async () => {
    const s = setup(), cursor = mint(s), args = {cursor, task: {handle: s.taskHandle}};
    const refused = await hydrateReadCallContinuation(s.workspaceRoot, s.lane, args, async () => s.source, noHandles,
      () => ({ok: false, code: "invalid-input", field: "budget"}));
    expect(refused.kind === "refusal" && refused.refusal.code).toBe("invalid-input");
    const plan = resolve(s, cursor);
    if (plan.kind !== "read-call") throw new Error("missing plan");
    expect(stateStoreFor(s.workspaceRoot)!.get(readCallExecutionKey(plan.state))!.data.status).toBe("pending");
    const valid = await hydrateReadCallContinuation(s.workspaceRoot, s.lane, args, async () => s.source, noHandles);
    expect(valid.kind === "hydrated" && valid.input.content).toBe("full");
  });

  it("refuses when the durable execution claim cannot be established", async () => {
    const s = setup(), cursor = mint(s);
    vi.spyOn(stateStoreFor(s.workspaceRoot)!, "put").mockReturnValue({ok: false, outcome: "store-unavailable"});
    const result = await hydrateReadCallContinuation(s.workspaceRoot, s.lane, {cursor, task: {handle: s.taskHandle}}, async () => s.source, noHandles);
    expect(result.kind).toBe("refusal");
  });

  it("rejects unsupported task overrides before consuming the plan", async () => {
    const s = setup(), cursor = mint(s), writes = vi.spyOn(stateStoreFor(s.workspaceRoot)!, "put");
    const result = await hydrateReadCallContinuation(s.workspaceRoot, s.lane, {cursor, task: {handle: s.taskHandle, profile: "generic"}}, async () => s.source, noHandles);
    expect(result.kind === "refusal" && result.refusal.code).toBe("invalid-input");
    expect(writes).not.toHaveBeenCalled();
  });
});
