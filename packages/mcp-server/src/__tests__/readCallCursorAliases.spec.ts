import {afterEach, describe, expect, it, vi} from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {mintReadCallContinuation, readCallExecutionKey, resolveReadCallContinuation} from "../state/readCallContinuationStore.js";
import {mintReadCallCursorAlias, resolveReadCallCursorAlias} from "../state/readCallCursorAliases.js";
import {fetchRequestPayloadRef, mintTaskHandle, resolveFetchRequestHandle} from "../state/stateHandles.js";
import {resetStateStoresForTests, stateStoreFor} from "../state/stateStore.js";
import {beginReadCallDispatch, resetReadCallDispatchForTests, withReadCallDispatch} from "../state/readCallDispatch.js";
import {runWithSessionLane} from "../util/laneKey.js";
import {shaOfText, type HandleEntry} from "../util/handles.js";
import {hydrateReadCallContinuation, projectReadCallContinuations} from "../protocol/readCallContinuation.js";

type Obj = Record<string, unknown>;
const roots: string[] = [];
const source = "export const value = 42;\n";
function setup(lane = "") {
  const workspaceRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tl-read-call-alias-"))); roots.push(workspaceRoot);
  const taskHandle = runWithSessionLane(lane, () => mintTaskHandle(workspaceRoot, {taskFingerprint: "alias-task", mintedAtMs: Date.now()})!);
  const originalInput = {query: "Explain this exact source-window plan.", targets: [{path: "src/a.ts", range: "1-1"}],
    content: "full", task: {handle: taskHandle, profile: "answer"}};
  const sources = [{path: "src/a.ts", sha: shaOfText(source)}];
  const mint = () => {
    const scope = beginReadCallDispatch(workspaceRoot, lane)!;
    try { return mintReadCallContinuation({workspaceRoot, lane, taskHandle, dispatchBinding: scope.binding,
      originalInput, sources, responseProfile: "answer"})!; }
    finally { scope.finish(); }
  };
  const read = async (file: string) => file === "src/a.ts" ? source : null;
  const resolveHandle = (_handle: string): HandleEntry | undefined => undefined;
  return {workspaceRoot, lane, taskHandle, originalInput, sources, read, resolveHandle, mint};
}
const aliasKey = (alias: string) => fetchRequestPayloadRef(`read-call-cursor-alias:${alias}`).toString("base64url");

afterEach(() => {
  vi.restoreAllMocks(); resetStateStoresForTests(); resetReadCallDispatchForTests();
  for (const root of roots.splice(0)) fs.rmSync(root, {recursive: true, force: true});
});

describe("durable short read-call cursor aliases", () => {
  it("projects a 42-character alias while retaining an authenticated canonical cursor", async () => {
    const s = setup("worker");
    const next = {tool: "tl_read_file", arguments: {cwd: s.workspaceRoot, lane: s.lane, query: s.originalInput.query,
      targets: s.originalInput.targets, content: "full", task: s.originalInput.task}};
    const body: Obj = {kind: "read.task_pack", profile: "answer", task: {id: s.taskHandle},
      decision: {kind: "discover", next}, plan: {next}};
    const projected = await withReadCallDispatch(s.workspaceRoot, s.lane,
      dispatch => projectReadCallContinuations(s.workspaceRoot, s.lane, body, s.read, s.resolveHandle, dispatch)) as Obj;
    const cursor = ((projected["decision"] as Obj)["next"] as Obj)["arguments"] as Obj;
    const alias = cursor["cursor"] as string;
    expect(alias).toMatch(/^tlc_s1_[A-Za-z0-9_-]{12}_[A-Za-z0-9_-]{22}$/);
    expect(alias).toHaveLength(42);
    const expanded = resolveReadCallCursorAlias({workspaceRoot: s.workspaceRoot, lane: s.lane, cursor: alias});
    expect(expanded.kind).toBe("canonical");
    if (expanded.kind !== "canonical") throw new Error("missing canonical cursor");
    expect(expanded.cursor).toMatch(/^tlh_rreq_v1_/);
    expect(resolveReadCallContinuation({workspaceRoot: s.workspaceRoot, lane: s.lane, cursor: expanded.cursor}).kind).toBe("read-call");
    const hydrated = await hydrateReadCallContinuation(s.workspaceRoot, s.lane, {cursor: alias}, s.read, s.resolveHandle);
    expect(hydrated.kind).toBe("hydrated");
  });

  it("accepts a canonical cursor and claims once when alias and canonical calls race", async () => {
    const s = setup(), canonical = s.mint();
    const alias = mintReadCallCursorAlias({workspaceRoot: s.workspaceRoot, lane: s.lane, canonicalCursor: canonical});
    expect(alias).toBeDefined();
    expect(resolveFetchRequestHandle(canonical, s.workspaceRoot, "read-request").ok).toBe(true);
    const calls = await withReadCallDispatch(s.workspaceRoot, s.lane, dispatch => Promise.all([canonical, alias!].map(cursor =>
      hydrateReadCallContinuation(s.workspaceRoot, s.lane, {cursor}, s.read, s.resolveHandle, undefined, dispatch))));
    expect(calls.every(result => result.kind === "hydrated")).toBe(true);
    const semanticCalls = calls.filter(result => result.kind === "hydrated" && result.input.query === s.originalInput.query);
    expect(semanticCalls).toHaveLength(1);
    const plan = resolveReadCallContinuation({workspaceRoot: s.workspaceRoot, lane: s.lane, cursor: canonical});
    expect(plan.kind).toBe("read-call");
    if (plan.kind === "read-call") expect(stateStoreFor(s.workspaceRoot)!.get(readCallExecutionKey(plan.state))?.version).toBe(2);
  });

  it("keeps a published alias across store re-open without rebuilding ephemeral batch state", () => {
    const s = setup(), canonical = s.mint(), alias = mintReadCallCursorAlias({workspaceRoot: s.workspaceRoot, lane: s.lane, canonicalCursor: canonical})!;
    resetStateStoresForTests(); resetReadCallDispatchForTests();
    const resolved = resolveReadCallCursorAlias({workspaceRoot: s.workspaceRoot, lane: s.lane, cursor: alias});
    expect(resolved).toEqual({kind: "canonical", cursor: canonical});
  });

  it("retains the canonical stale-source and force-serve rules after alias expansion", async () => {
    const s = setup(), canonical = s.mint(), alias = mintReadCallCursorAlias({workspaceRoot: s.workspaceRoot, lane: s.lane, canonicalCursor: canonical})!;
    const stale = await hydrateReadCallContinuation(s.workspaceRoot, s.lane, {cursor: alias}, async () => "changed source", s.resolveHandle);
    expect(stale.kind === "refusal" && stale.refusal.code).toBe("cursor-stale");
    const forced = await hydrateReadCallContinuation(s.workspaceRoot, s.lane, {cursor: alias, task: {force_serve: true}}, s.read, s.resolveHandle);
    expect(forced.kind).toBe("hydrated");
    if (forced.kind === "hydrated") expect(forced.input.content).toBe("full");
  });

  it("does not restore an alias after its canonical state or execution marker is evicted", async () => {
    const s = setup(), canonical = s.mint(), alias = mintReadCallCursorAlias({workspaceRoot: s.workspaceRoot, lane: s.lane, canonicalCursor: canonical})!;
    const plan = resolveReadCallContinuation({workspaceRoot: s.workspaceRoot, lane: s.lane, cursor: canonical});
    if (plan.kind !== "read-call") throw new Error("missing read-call plan");
    const store = stateStoreFor(s.workspaceRoot)!;
    const canonicalRef = resolveFetchRequestHandle(canonical, s.workspaceRoot, "read-request");
    if (!canonicalRef.ok) throw new Error("missing canonical store record");
    store.delete(canonicalRef.payloadRef);
    expect(resolveReadCallCursorAlias({workspaceRoot: s.workspaceRoot, lane: s.lane, cursor: alias}).kind).toBe("refusal");
    const second = s.mint(), secondAlias = mintReadCallCursorAlias({workspaceRoot: s.workspaceRoot, lane: s.lane, canonicalCursor: second})!;
    const secondPlan = resolveReadCallContinuation({workspaceRoot: s.workspaceRoot, lane: s.lane, cursor: second});
    if (secondPlan.kind !== "read-call") throw new Error("missing second plan");
    store.delete(readCallExecutionKey(secondPlan.state));
    const denied = await hydrateReadCallContinuation(s.workspaceRoot, s.lane, {cursor: secondAlias}, s.read, s.resolveHandle);
    expect(denied.kind).toBe("refusal");
  });

  it.each(["canonical_cursor", "payload_ref", "lane", "expires_at_ms"] as const)("refuses a tampered alias record field: %s", field => {
    const s = setup(), canonical = s.mint(), alias = mintReadCallCursorAlias({workspaceRoot: s.workspaceRoot, lane: s.lane, canonicalCursor: canonical})!;
    const store = stateStoreFor(s.workspaceRoot)!, record = store.get(aliasKey(alias))!;
    if (field === "canonical_cursor") record.data[field] = canonical + "x";
    else if (field === "payload_ref") record.data[field] = "AAAAAAAAAAAA";
    else if (field === "lane") record.data[field] = "other";
    else record.data[field] = Date.now() - 1;
    expect(resolveReadCallCursorAlias({workspaceRoot: s.workspaceRoot, lane: s.lane, cursor: alias}).kind).toBe("refusal");
  });

  it("fails closed on malformed, changed, deleted, wrong-workspace, and wrong-lane aliases", () => {
    const s = setup("lane-a"), canonical = s.mint(), alias = mintReadCallCursorAlias({workspaceRoot: s.workspaceRoot, lane: s.lane, canonicalCursor: canonical})!;
    expect(resolveReadCallCursorAlias({workspaceRoot: s.workspaceRoot, lane: s.lane, cursor: "tlc_s1_unknown"}).kind).toBe("refusal");
    const changed = alias.slice(0, -1) + (alias.endsWith("A") ? "B" : "A");
    expect(resolveReadCallCursorAlias({workspaceRoot: s.workspaceRoot, lane: s.lane, cursor: changed}).kind).toBe("refusal");
    expect(resolveReadCallCursorAlias({workspaceRoot: s.workspaceRoot, lane: "other", cursor: alias}).kind).toBe("refusal");
    const other = setup("lane-a");
    expect(resolveReadCallCursorAlias({workspaceRoot: other.workspaceRoot, lane: s.lane, cursor: alias}).kind).toBe("refusal");
    stateStoreFor(s.workspaceRoot)!.delete(aliasKey(alias));
    expect(resolveReadCallCursorAlias({workspaceRoot: s.workspaceRoot, lane: s.lane, cursor: alias}).kind).toBe("refusal");
  });

  it("does not let an alias override an explicitly supplied parent task", async () => {
    const s = setup(), canonical = s.mint(), alias = mintReadCallCursorAlias({workspaceRoot: s.workspaceRoot, lane: s.lane, canonicalCursor: canonical})!;
    const result = await hydrateReadCallContinuation(s.workspaceRoot, s.lane, {cursor: alias, task: {handle: "wrong-task"}}, s.read, s.resolveHandle);
    expect(result.kind).toBe("refusal");
  });

  it("keeps canonical fallback when alias persistence fails", () => {
    const s = setup(), canonical = s.mint(), store = stateStoreFor(s.workspaceRoot)!;
    vi.spyOn(store, "put").mockReturnValue({ok: false, outcome: "store-unavailable"});
    expect(mintReadCallCursorAlias({workspaceRoot: s.workspaceRoot, lane: s.lane, canonicalCursor: canonical})).toBeUndefined();
    expect(resolveReadCallContinuation({workspaceRoot: s.workspaceRoot, lane: s.lane, cursor: canonical}).kind).toBe("read-call");
  });
});
