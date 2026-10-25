import {afterEach, describe, expect, it, vi} from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {mintReadCallContinuation, readCallExecutionKey, resolveReadCallContinuation} from "../state/readCallContinuationStore.js";
import {resolveReadCallCursorAlias} from "../state/readCallCursorAliases.js";
import {FETCH_REQUEST_HANDLE_TTL_MS, TASK_HANDLE_TTL_MS, fetchRequestPayloadRef, mintTaskHandle, resolveFetchRequestHandle, resolveTaskHandle} from "../state/stateHandles.js";
import {resetStateStoresForTests, stateStoreFor} from "../state/stateStore.js";
import {beginReadCallDispatch, resetReadCallDispatchForTests, withReadCallDispatch} from "../state/readCallDispatch.js";
import {attachTaskQueryRefBinding, clearTaskQueryRef, rememberTaskQuery, resetAll as resetAllSessions, tokenizeForEpoch} from "../state/session.js";
import {recordTaskContract, resetTaskContractStoreForTest} from "../features/task-pack/taskContractStore.js";
import {runWithSessionLane} from "../util/laneKey.js";
import {shaOfText, type HandleEntry} from "../util/handles.js";
import {hydrateReadCallContinuation as hydrateReadCall, omitConfiguredRootCwdOnNext, projectReadCallContinuations as projectReadCalls} from "../protocol/readCallContinuation.js";

// A discover whose next re-packs the task by its qref (`{qref, targets, content, cwd, task}`)
// is published as the same authenticated short cursor a query-bearing next gets. This pins the
// pure projection and hydration (protocol/readCallContinuation.ts, state/readCallContinuationStore.ts);
// readCallQrefNextServer.spec.ts runs the published calls through real servers.
type Obj = Record<string, any>;
const roots: string[] = [];
const neverIssued = "q-0123456789abcdef";
const purpose = "edit-context: retained enum-derived review";
const lines = (prefix: string) => Array.from({length: 60}, (_, i) => `export const ${prefix}${i} = ${i};`).join("\n") + "\n";
const original: Record<string, string> = {"src/a.ts": lines("a"), "src/b.ts": lines("b")};
let current: Record<string, string> = {...original};
const read = async (file: string): Promise<string | null> => current[file] ?? null;
const noHandles = (): HandleEntry | undefined => undefined;
const aliasKey = (alias: string) => fetchRequestPayloadRef(`read-call-cursor-alias:${alias}`).toString("base64url");

/**
 * A task the way the server records it (server.ts recordTaskPackExecution): the qref of its request in the
 * session's single active slot (over the request's task contract, which is what a restart reads the slot's query
 * back from), the task handle minted for it with that qref as its replay token, and the wire handle stamped on
 * the qref afterwards. A qref that belongs to a task is one the session says so about.
 */
function issueTask(workspaceRoot: string, lane: string, fingerprint: string, request: string) {
  return runWithSessionLane(lane, () => {
    recordTaskContract(workspaceRoot, tokenizeForEpoch(request), {query: request});
    const qref = rememberTaskQuery(workspaceRoot, request, fingerprint);
    const taskHandle = mintTaskHandle(workspaceRoot, {taskFingerprint: fingerprint, replay: qref, mintedAtMs: Date.now()})!;
    attachTaskQueryRefBinding(workspaceRoot, qref, fingerprint, taskHandle);
    return {qref, taskHandle};
  });
}
function world(lane = "") {
  const workspaceRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tl-qref-next-"))); roots.push(workspaceRoot);
  return {workspaceRoot, lane, ...issueTask(workspaceRoot, lane, "qref-next-task", "Explain the exported constants in src/a.ts and src/b.ts.")};
}
type World = ReturnType<typeof world>;

/** The next a discover pack publishes today: qref + targets (one with a purpose) + content + cwd + the task handle. */
function nextArguments(w: World, extra: Obj = {}): Obj {
  return {qref: w.qref, targets: [{path: "src/a.ts", range: "1-10"}, {path: "src/b.ts", range: "5-12"},
    {path: "src/a.ts", range: "40-45", purpose}], content: "auto",
  cwd: w.workspaceRoot, ...(w.lane ? {lane: w.lane} : {}), task: {handle: w.taskHandle}, ...extra};
}
function discover(w: World, args: Obj = nextArguments(w), extra: Obj = {}): Obj {
  const next = {tool: "tl_read_file", arguments: args};
  return {kind: "read.task_pack", profile: "generic", task: {id: w.taskHandle, replay: w.qref, coverage: "partial"},
    decision: {kind: "discover", next, advisory: "advisory: bundled paths are limited to files already related by served candidates or evidence edges"},
    ...extra};
}
const project = (w: World, body: Obj, readFile = read): Promise<Obj> => runWithSessionLane(w.lane, () =>
  withReadCallDispatch(w.workspaceRoot, w.lane, binding => projectReadCalls(w.workspaceRoot, w.lane, body, readFile, noHandles, binding))) as Promise<Obj>;
const hydrate = (w: World, args: Obj, validate?: (input: Obj) => Obj | undefined, readFile = read) =>
  withReadCallDispatch(w.workspaceRoot, w.lane, binding => hydrateReadCall(w.workspaceRoot, w.lane, args, readFile, noHandles, validate, binding));
const cursorOf = (projected: Obj): string => projected["decision"].next.arguments.cursor;
function plan(w: World, cursor: string) {
  const alias = resolveReadCallCursorAlias({workspaceRoot: w.workspaceRoot, lane: w.lane, cursor});
  const resolved = resolveReadCallContinuation({workspaceRoot: w.workspaceRoot, lane: w.lane, cursor: alias.kind === "canonical" ? alias.cursor : cursor});
  if (resolved.kind !== "read-call") throw new Error("missing read-call plan: " + JSON.stringify(resolved));
  return resolved;
}
const claim = (w: World, cursor: string) => stateStoreFor(w.workspaceRoot)!.get(readCallExecutionKey(plan(w, cursor).state))?.data["status"];

afterEach(() => {
  vi.restoreAllMocks(); resetAllSessions(); resetTaskContractStoreForTest(); resetStateStoresForTests(); resetReadCallDispatchForTests(); current = {...original};
  for (const root of roots.splice(0)) fs.rmSync(root, {recursive: true, force: true});
});

describe("a qref-bearing discover next is published as the short read-call cursor", () => {
  it.each(["", "worker"])("replaces qref + targets (with a purpose) by {cwd, lane?, cursor}, lane %j, and stores the exact call", async lane => {
    const w = world(lane), args = nextArguments(w), body = discover(w, args), before = structuredClone(body);
    const projected = await project(w, body);
    expect(body, "the input body is never edited").toEqual(before);
    expect(projected).not.toBe(body);
    const compact = projected["decision"].next.arguments;
    expect(Object.keys(compact).sort()).toEqual(["cursor", "cwd", ...(lane ? ["lane"] : [])].sort());
    expect(compact.cursor).toMatch(/^tlc_s1_[A-Za-z0-9_-]{12}_[A-Za-z0-9_-]{22}$/);
    expect(compact.cwd).toBe(w.workspaceRoot);
    expect(projected["decision"].advisory).toBe(body["decision"].advisory);
    // The stored plan is the next's own call: qref, every target with its purpose, content, the task; only cwd/lane are not stored.
    const stored = plan(w, compact.cursor);
    const {cwd: _cwd, lane: _lane, ...call} = args;
    expect(stored.input).toEqual(call);
    expect(stored.input["qref"]).toBe(w.qref);
    expect(stored.input["query"]).toBeUndefined();
    expect((stored.input["targets"] as Obj[])[2]!["purpose"]).toBe(purpose);
    expect(stored.state.task_handle).toBe(w.taskHandle);
    expect(stored.state.response_profile).toBe("generic");
    expect(stored.state.source_bindings).toEqual([{path: "src/a.ts", sha: shaOfText(original["src/a.ts"]!)}, {path: "src/b.ts", sha: shaOfText(original["src/b.ts"]!)}]);
    expect(claim(w, compact.cursor)).toBe("pending");
  });

  it("replaces every exact copy of the next in the protocol control containers, never evidence", async () => {
    const w = world(), args = nextArguments(w), body = discover(w, args);
    const copy = () => ({tool: "tl_read_file", arguments: structuredClone(args)});
    Object.assign(body, {plan: {change_contract: {stages: [{next: copy()}]}}, recovery: {next: copy()}, evidence: [{path: "src/a.ts", body: JSON.stringify(copy()), next: copy()}]});
    const projected = await project(w, body);
    const cursor = cursorOf(projected);
    expect(projected["plan"].change_contract.stages[0].next.arguments).toEqual(projected["decision"].next.arguments);
    expect(projected["recovery"].next.arguments.cursor).toBe(cursor);
    expect(projected["evidence"]).toEqual(body["evidence"]);
  });

  it("keeps a CAS rider and only that", async () => {
    const w = world(), version = (resolveTaskHandle(w.taskHandle, w.workspaceRoot) as {stateVersion: number}).stateVersion;
    const projected = await project(w, discover(w, nextArguments(w, {task: {handle: w.taskHandle, expected_state_version: version}})));
    expect(projected["decision"].next.arguments.task).toEqual({expected_state_version: version});
    expect(Object.keys(projected["decision"].next.arguments).sort()).toEqual(["cursor", "cwd", "task"]);
    expect(plan(w, cursorOf(projected)).input["task"]).toEqual({handle: w.taskHandle, expected_state_version: version});
  });

  it("drops cwd under the configured root like any verified alias", async () => {
    const w = world("a"), projected = await project(w, discover(w));
    const bare = omitConfiguredRootCwdOnNext(w.workspaceRoot, w.workspaceRoot, projected) as Obj;
    expect(bare["decision"].next.arguments).toEqual({lane: "a", cursor: cursorOf(projected)});
  });

  it("a purpose is admitted on any read next, not only a qref one: a query next with a purposed window is published too", async () => {
    const w = world(), {qref: _qref, ...rest} = nextArguments(w);
    const args = {...rest, query: "Explain the control flow of both files, with their constraints."};
    const projected = await project(w, discover(w, args));
    const stored = plan(w, cursorOf(projected));
    expect(stored.input["query"]).toBe(args.query);
    expect(stored.input["qref"]).toBeUndefined();
    expect((stored.input["targets"] as Obj[])[2]!["purpose"]).toBe(purpose);
  });

  it("publishes a plan whose stored call lists the targets by handle too", async () => {
    const w = world("worker");
    const entry: HandleEntry = {id: "hsource", purpose: "content", kind: "file", workspaceRoot: w.workspaceRoot, lane: w.lane, path: "src/a.ts", createdAt: 1};
    const args = nextArguments(w, {targets: [{handle: "hsource", range: "1-10", purpose}, {path: "src/b.ts", ranges: ["1-3", "9-12"]}]});
    const projected = await withReadCallDispatch(w.workspaceRoot, w.lane, binding =>
      projectReadCalls(w.workspaceRoot, w.lane, discover(w, args), read, () => entry, binding)) as Obj;
    expect(plan(w, cursorOf(projected)).input["targets"]).toEqual(args["targets"]);
  });
});

describe("the parent task of a qref next that carries no handle is the reply's own task", () => {
  const withoutHandle = (w: World, task?: Obj): Obj => {
    const {task: _task, ...rest} = nextArguments(w);
    return task === undefined ? rest : {...rest, task};
  };

  it.each([["no task at all", undefined], ["a task with only a profile", {profile: "generic"}], ["an empty task", {}]] as Array<[string, Obj | undefined]>)(
    "binds %s to body.task.id and stores the handle beside the qref", async (_name, task) => {
      const w = world("lane"), args = withoutHandle(w, task);
      const projected = await project(w, discover(w, args));
      const compact = projected["decision"].next.arguments;
      expect(Object.keys(compact).sort()).toEqual(["cursor", "cwd", "lane"]);
      const stored = plan(w, compact.cursor);
      expect(stored.state.task_handle).toBe(w.taskHandle);
      const {cwd: _cwd, lane: _lane, ...call} = args;
      expect(stored.input).toEqual({...call, task: {...task, handle: w.taskHandle}});
      expect(stored.input["qref"]).toBe(w.qref);
      // the cursor authenticates the same parent a handle-carrying next would
      const hydrated = await hydrate(w, {cursor: compact.cursor, lane: w.lane});
      expect(hydrated.kind).toBe("hydrated");
      if (hydrated.kind !== "hydrated") throw new Error("missing input");
      expect(hydrated.input).toEqual({...args, task: {...task, handle: w.taskHandle}});
    });

  it("does not compact when the reply's task id is not this workspace's live task", async () => {
    // The qref's recorded wire handle is set to each bad id in turn, so the check that the qref belongs to the
    // reply's task passes and only the mint's authentication of that id as a live task of this workspace is left to refuse it.
    const w = world(), other = world();
    const put = vi.spyOn(stateStoreFor(w.workspaceRoot)!, "put");
    const tampered = w.taskHandle.slice(0, -2) + (w.taskHandle.endsWith("AA") ? "BB" : "AA");
    const recordAs = (id: string) => runWithSessionLane(w.lane, () => attachTaskQueryRefBinding(w.workspaceRoot, w.qref, "qref-next-task", id));
    const withId = (id: unknown): Obj => discover(w, withoutHandle(w), {task: {id, replay: w.qref}});
    const cases: Array<[string, Obj, string | undefined]> = [
      ["no task on the reply", (() => { const body = discover(w, withoutHandle(w)); delete body["task"]; return body; })(), undefined],
      ["a non-string id", withId(7), undefined],
      ["an empty id", withId(""), undefined],
      ["an unminted fingerprint standing in for the id", withId("generic:0123456789abcdef"), "generic:0123456789abcdef"],
      ["a task of another workspace", withId(other.taskHandle), other.taskHandle],
      ["a tampered handle", withId(tampered), tampered],
    ];
    for (const [name, body, recorded] of cases) {
      if (recorded !== undefined) recordAs(recorded);
      put.mockClear();
      expect(await project(w, body), name).toBe(body);
      expect(put, `${name}: nothing is stored for a plan that cannot be authenticated`).not.toHaveBeenCalled();
    }
    // the same projection with the genuine id compacts, so each refusal above is about the id
    recordAs(w.taskHandle);
    expect(cursorOf(await project(w, withId(w.taskHandle)))).toMatch(/^tlc_s1_/);
  });

  it("binds only to the task whose replay token the next re-packs by: another replay token, or none stated", async () => {
    const w = world(), args = withoutHandle(w);
    const other = discover(w, args, {task: {id: w.taskHandle, replay: "q-ffffffffffffffff", coverage: "partial"}});
    expect(await project(w, other), "the reply's own replay token is another task's qref").toBe(other);
    const silent = discover(w, args, {task: {id: w.taskHandle, coverage: "partial"}});
    expect(cursorOf(await project(w, silent)), "a reply that states no replay token").toMatch(/^tlc_s1_/);
  });

  describe("only when the qref itself belongs to that task (the session's recorded wire handle for it)", () => {
    // The reply states no replay token in these, so the ownership check alone decides.
    const reply = (w: World, args: Obj): Obj => discover(w, args, {task: {id: w.taskHandle, coverage: "partial"}});

    it.each([
      ["a qref that belongs to another task", (w: World) => issueTask(w.workspaceRoot, w.lane, "another-task", "Summarize src/b.ts for a reviewer.").qref],
      ["a legacy slot with no recorded wire handle", (w: World) =>
        runWithSessionLane(w.lane, () => rememberTaskQuery(w.workspaceRoot, "A request recorded before wire handles existed.", "legacy-fingerprint"))],
      ["a qref the session never issued", () => neverIssued],
      ["a qref the session has since superseded", (w: World) => { issueTask(w.workspaceRoot, w.lane, "newer-task", "A newer request."); return w.qref; }],
      ["a qref a new epoch cleared", (w: World) => { runWithSessionLane(w.lane, () => clearTaskQueryRef(w.workspaceRoot)); return w.qref; }],
    ] as Array<[string, (w: World) => string]>)("%s: the next stays expanded, nothing is stored", async (_name, qrefFor) => {
      const w = world(), qref = qrefFor(w);
      const body = reply(w, {...withoutHandle(w), qref});
      const put = vi.spyOn(stateStoreFor(w.workspaceRoot)!, "put");
      expect(await project(w, body)).toBe(body);
      expect(put).not.toHaveBeenCalled();
      expect((body["decision"] as Obj).next.arguments.qref).toBe(qref);
    });

    it("another lane's qref: the lane's own session is asked, and it never issued it", async () => {
      const issued = world("one"), asked: World = {...issued, lane: "two"};
      const body = reply(asked, withoutHandle(asked));
      expect(await project(asked, body)).toBe(body);
      expect(cursorOf(await project(issued, reply(issued, withoutHandle(issued)))), "the lane that issued it binds").toMatch(/^tlc_s1_/);
    });

    it("the pair the session recorded compacts, whichever task it is: a second task binds to itself", async () => {
      const w = world(), second = issueTask(w.workspaceRoot, w.lane, "another-task", "Summarize src/b.ts for a reviewer.");
      const projected = await project(w, discover(w, {...withoutHandle(w), qref: second.qref}, {task: {id: second.taskHandle, replay: second.qref}}));
      const stored = plan(w, cursorOf(projected));
      expect(stored.state.task_handle).toBe(second.taskHandle);
      expect(stored.input["qref"]).toBe(second.qref);
      expect((stored.input["task"] as Obj).handle).toBe(second.taskHandle);
    });

    it("a restart keeps the binding: the recorded wire handle is read back from the durable slot", async () => {
      const w = world();
      resetAllSessions(); // the in-process session is gone; the qref's durable slot is not
      expect(cursorOf(await project(w, reply(w, withoutHandle(w))))).toMatch(/^tlc_s1_/);
    });

    it("a next that carries its handle keeps today's rule: the qref's recorded binding is not asked", async () => {
      const w = world(), args = nextArguments(w, {qref: neverIssued});
      const projected = await project(w, reply(w, args));
      const stored = plan(w, cursorOf(projected));
      expect(stored.input["qref"]).toBe(neverIssued);
      expect(stored.state.task_handle).toBe(w.taskHandle);
    });
  });

  it("does not compact once the reply's task has expired", async () => {
    const w = world(), body = discover(w, withoutHandle(w));
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + TASK_HANDLE_TTL_MS + 60_000);
    expect(await project(w, body)).toBe(body);
  });

  it.each([
    ["task.force_serve", {force_serve: true}],
    ["task.expected_state_version", {expected_state_version: 1}],
    ["an unknown task key", {note: "x"}],
    ["a non-string handle", {handle: 7}],
    ["task as a string", "{\"profile\":\"generic\"}"],
  ] as Array<[string, unknown]>)("does not invent a handle for a qref next whose task is %s", async (_name, task) => {
    const w = world(), body = discover(w, withoutHandle(w, task as Obj));
    expect(await project(w, body)).toBe(body);
  });

  it("never binds a query next to the reply's task: a query next must name its parent itself", async () => {
    const w = world(), {qref: _qref, task: _task, ...rest} = nextArguments(w);
    const body = discover(w, {...rest, query: "Explain the control flow."});
    expect(await project(w, body)).toBe(body);
  });

  it("prefers the handle the next carries, even when the reply names another task", async () => {
    const w = world();
    const second = runWithSessionLane("", () => mintTaskHandle(w.workspaceRoot, {taskFingerprint: "another-task", mintedAtMs: Date.now()})!);
    expect(second).not.toBe(w.taskHandle);
    const projected = await project(w, discover(w, nextArguments(w), {task: {id: second}}));
    expect(plan(w, cursorOf(projected)).state.task_handle).toBe(w.taskHandle);
  });
});

describe("what is not admitted is published as before", () => {
  type Change = (args: Obj, w: World) => void;
  const shapes: Array<[string, Change]> = [
    ["no targets", args => { delete args["targets"]; }],
    ["empty targets", args => { args["targets"] = []; }],
    ["a target key beyond path, handle, range, ranges and purpose", args => { args["targets"][0].symbol = "x"; }],
    ["a target lang", args => { args["targets"][0].lang = "ts"; }],
    ["a target profile", args => { args["targets"][0].profile = "outline"; }],
    ["a purpose that is not a string", args => { args["targets"][2].purpose = 7; }],
    ["a target without a window", args => { delete args["targets"][0].range; }],
    ["a target with both range and ranges", args => { args["targets"][0].ranges = ["1-2"]; }],
    ["a window that does not parse", args => { args["targets"][0].range = "ten"; }],
    ["a path that escapes the workspace", args => { args["targets"][0].path = "../outside.ts"; }],
    ["a blank qref", args => { args["qref"] = "  "; }],
    ["a qref that is not a string", args => { args["qref"] = 7; }],
    ["query together with qref", args => { args["query"] = "Explain the flow."; }],
    ["neither query nor qref", args => { delete args["qref"]; }],
    ["a cursor beside the qref", args => { args["cursor"] = "tlc_s1_AAAAAAAAAAAA_AAAAAAAAAAAAAAAAAAAAAA"; }],
    ["task.epoch", args => { args["task"].epoch = "new"; }],
    ["task.pull", args => { args["task"].pull = "closure"; }],
    ["task.challenge", args => { args["task"].challenge = {certificate_id: "ready-0"}; }],
    ["a cwd that is not the workspace", args => { args["cwd"] = args["cwd"] + "-elsewhere"; }],
    ["no cwd", args => { delete args["cwd"]; }],
    ["another lane", args => { args["lane"] = "someone-else"; }],
  ];
  it.each(shapes)("%s", async (_name, change) => {
    const w = world(), args = nextArguments(w);
    change(args, w);
    const body = discover(w, args);
    expect(await project(w, body)).toBe(body);
  });

  it("a read that cannot be revalidated: an unreadable source", async () => {
    const w = world(), body = discover(w);
    expect(await project(w, body, async () => null)).toBe(body);
  });

  it("not a discover task pack with one tl_read_file next", async () => {
    const w = world(), args = nextArguments(w);
    for (const [name, body] of [
      ["act.edit", {...discover(w, args), decision: {kind: "act.edit", next: {tool: "tl_read_file", arguments: args}}}],
      ["act.answer", {...discover(w, args), decision: {kind: "act.answer", next: {tool: "tl_read_file", arguments: args}}}],
      ["a refusal", {kind: "refusal", decision: {kind: "discover", next: {tool: "tl_read_file", arguments: args}}}],
      ["a batch next", {...discover(w, args), decision: {kind: "discover", next: [{tool: "tl_read_file", arguments: args}, {tool: "tl_read_file", arguments: args}]}}],
      ["a search next", {...discover(w, args), decision: {kind: "discover", next: {tool: "tl_search_files", arguments: args}}}],
      ["an edit next", {...discover(w, args), decision: {kind: "discover", next: {tool: "tl_edit_file", arguments: args}}}],
      ["a next without arguments", {...discover(w, args), decision: {kind: "discover", next: {tool: "tl_read_file"}}}],
      ["a refusal retry", {kind: "refusal", retry: "call", next: {tool: "tl_read_file", arguments: args}}],
    ] as Array<[string, Obj]>) expect(await project(w, body), name).toBe(body);
  });

  it("not without a sole current dispatch to bind the plan to", async () => {
    const w = world(), body = discover(w);
    expect(await projectReadCalls(w.workspaceRoot, w.lane, body, read, noHandles, undefined)).toBe(body);
    const older = beginReadCallDispatch(w.workspaceRoot, w.lane)!, newer = beginReadCallDispatch(w.workspaceRoot, w.lane)!;
    expect(await projectReadCalls(w.workspaceRoot, w.lane, body, read, noHandles, newer.binding), "an older call is still running").toBe(body);
    older.finish(); newer.finish();
  });

  it("not when the cursor form is no smaller than the call it stands for", async () => {
    const w = world();
    const tiny = {qref: "q", targets: [{path: "a", range: "1-1"}], cwd: w.workspaceRoot};
    const compact = {cwd: w.workspaceRoot, cursor: "tlc_s1_AAAAAAAAAAAA_AAAAAAAAAAAAAAAAAAAAAA"};
    expect(Buffer.byteLength(JSON.stringify(tiny))).toBeLessThan(Buffer.byteLength(JSON.stringify(compact)));
    const body = discover(w, tiny, {task: {id: w.taskHandle}});
    current = {...current, a: "x\n"};
    expect(await project(w, body)).toBe(body);
  });

  it("an act.* decision is never given a cursor, whatever else the reply says", async () => {
    const w = world(), args = nextArguments(w);
    const body = {...discover(w, args), decision: {kind: "act.edit", certificate: {id: "ready-0"}}, limit: {next: {tool: "tl_read_file", arguments: args}}};
    expect(await project(w, body)).toBe(body);
  });
});

describe("the first claim runs the stored call whenever it comes, riders applied; a replay recovers the same windows as before", () => {
  const cursorFor = async (w: World, args = nextArguments(w), extra: Obj = {}) => {
    const projected = await project(w, discover(w, args, extra));
    return {projected, cursor: cursorOf(projected), args};
  };
  /** The stored call with the riders applied as they apply to the call itself: budget replaces, task.* adds to the stored task. */
  const withRiders = (args: Obj, riders: {budget?: Obj; task?: Obj}): Obj =>
    ({...args, ...(riders.budget ? {budget: riders.budget} : {}), task: {...args["task"], ...riders.task}});

  it.each(["", "worker"])("immediate first use, lane %j: the original next, key for key", async lane => {
    const w = world(lane), {cursor, args} = await cursorFor(w);
    const validate = vi.fn((_input: Obj) => undefined);
    const hydrated = await hydrate(w, {cursor, ...(lane ? {lane} : {})}, validate);
    expect(hydrated.kind).toBe("hydrated");
    if (hydrated.kind !== "hydrated") throw new Error("missing input");
    expect(hydrated.input).toEqual(args);
    expect(hydrated.input["qref"]).toBe(w.qref);
    expect((hydrated.input["targets"] as Obj[])[2]!["purpose"]).toBe(purpose);
    expect(hydrated.replayAuthorization).toBeUndefined();
    expect(validate).toHaveBeenCalledTimes(2); // the stored call and the recovery a replay would run are both validated before the claim
    expect(validate.mock.calls[0]![0]).toEqual(args);
    expect(claim(w, cursor)).toBe("claimed");
  });

  it("an alias and the canonical cursor it stands for restore the same call", async () => {
    const w = world(), {cursor, args} = await cursorFor(w);
    const canonical = resolveReadCallCursorAlias({workspaceRoot: w.workspaceRoot, lane: w.lane, cursor});
    if (canonical.kind !== "canonical") throw new Error("missing canonical cursor");
    const hydrated = await hydrate(w, {cursor: canonical.cursor});
    expect(hydrated.kind === "hydrated" && hydrated.input).toEqual(args);
  });

  type Case = [string, (w: World) => Promise<void> | void, Obj, {budget?: Obj; task?: Obj}];
  const cases: Case[] = [
    ["an intervening call", w => withReadCallDispatch(w.workspaceRoot, w.lane, async () => undefined), {}, {}],
    ["a restart with the plan still in the store", () => { resetStateStoresForTests(); resetReadCallDispatchForTests(); }, {}, {}],
    ["a budget rider", () => undefined, {budget: {bytes: 4096}}, {budget: {bytes: 4096}}],
    ["task.force_serve", () => undefined, {task: {force_serve: true}}, {task: {force_serve: true}}],
    ["the matching task handle and profile", () => undefined, {task: {handle: "$handle", profile: "generic"}}, {}],
    ["an intervening call, a restart, a budget rider and force_serve together", async w => {
      await withReadCallDispatch(w.workspaceRoot, w.lane, async () => undefined);
      resetStateStoresForTests(); resetReadCallDispatchForTests();
    }, {budget: {bytes: 4096}, task: {force_serve: true}}, {budget: {bytes: 4096}, task: {force_serve: true}}],
  ];
  it.each(cases)("%s: the first claim is still the stored call, qref and purposes included, riders applied as to the call itself", async (_name, before, sent, applied) => {
    const w = world(), {cursor, args} = await cursorFor(w);
    await before(w);
    const rider = JSON.parse(JSON.stringify(sent).replace("$handle", w.taskHandle)) as Obj;
    const validate = vi.fn((_input: Obj) => undefined);
    const hydrated = await hydrate(w, {cursor, ...rider}, validate);
    expect(hydrated.kind).toBe("hydrated");
    if (hydrated.kind !== "hydrated") throw new Error("missing input");
    expect(hydrated.input).toEqual(withRiders(args, applied));
    expect(hydrated.input["qref"]).toBe(w.qref);
    expect(hydrated.input["content"]).toBe("auto");
    expect((hydrated.input["targets"] as Obj[])[2]!["purpose"]).toBe(purpose);
    expect(hydrated.replayAuthorization, "a first claim is not a replay").toBeUndefined();
    expect(validate.mock.calls[0]![0], "the validated call is the one that runs").toEqual(hydrated.input);
    expect(claim(w, cursor)).toBe("claimed");
  });

  it("a budget rider replaces the stored budget; none keeps it", async () => {
    const stored = {budget: {bytes: 9000}};
    const w = world(), {cursor, args} = await cursorFor(w, nextArguments(w, stored));
    const kept = await hydrate(w, {cursor});
    expect(kept.kind === "hydrated" && kept.input).toEqual(args);
    const w2 = world(), second = await cursorFor(w2, nextArguments(w2, stored));
    const replaced = await hydrate(w2, {cursor: second.cursor, budget: {bytes: 4096}});
    expect(replaced.kind === "hydrated" && replaced.input).toEqual({...second.args, budget: {bytes: 4096}});
  });

  it.each([
    ["none", {}],
    ["task.force_serve", {task: {force_serve: true}}],
    ["a budget rider", {budget: {bytes: 4096}}],
  ] as Array<[string, Obj]>)("a replay (rider: %s) recovers exact windows only: no qref, no purpose, full content", async (name, rider) => {
    const w = world(), {cursor, args} = await cursorFor(w);
    expect((await hydrate(w, {cursor})).kind, "the first claim").toBe("hydrated");
    const recovered = await hydrate(w, {cursor, ...rider});
    expect(recovered.kind).toBe("hydrated");
    if (recovered.kind !== "hydrated") throw new Error("missing recovery");
    expect(recovered.input["qref"]).toBeUndefined();
    expect(recovered.input["query"]).toBeUndefined();
    expect(recovered.input["content"]).toBe("full");
    expect(recovered.input["targets"]).toEqual([{path: "src/a.ts", range: "1-10"}, {path: "src/b.ts", range: "5-12"}, {path: "src/a.ts", range: "40-45"}]);
    expect((recovered.input["task"] as Obj).handle).toBe(w.taskHandle);
    expect((recovered.input["task"] as Obj).force_serve).toBe(name === "task.force_serve" ? true : undefined);
    expect(recovered.input["budget"]).toEqual(rider["budget"]);
    expect(recovered.input["cwd"]).toBe(args["cwd"]);
    expect(JSON.stringify(recovered.input)).not.toContain(purpose);
    if (name === "none") {
      expect(recovered.replayAuthorization?.taskHandle).toBe(w.taskHandle);
      expect(recovered.replayAuthorization?.targets.map(t => `${t.path}:${t.ranges.join(",")}`)).toEqual(["src/a.ts:1-10", "src/b.ts:5-12", "src/a.ts:40-45"]);
    } else expect(recovered.replayAuthorization).toBeUndefined();
  });

  it("a replay after a restart still recovers: the claim is in the store, not in the process", async () => {
    const w = world(), {cursor} = await cursorFor(w);
    expect((await hydrate(w, {cursor})).kind).toBe("hydrated");
    resetStateStoresForTests(); resetReadCallDispatchForTests();
    const recovered = await hydrate(w, {cursor});
    expect(recovered.kind === "hydrated" && recovered.input["qref"]).toBeUndefined();
    expect(recovered.kind === "hydrated" && recovered.input["content"]).toBe("full");
  });

  it("is claimed once: of two uses at once only one runs the stored call", async () => {
    const w = world(), {cursor} = await cursorFor(w);
    const both = await withReadCallDispatch(w.workspaceRoot, w.lane, dispatch => Promise.all([cursor, cursor].map(c =>
      hydrateReadCall(w.workspaceRoot, w.lane, {cursor: c}, read, noHandles, undefined, dispatch))));
    expect(both.every(result => result.kind === "hydrated")).toBe(true);
    const semantic = both.filter(result => result.kind === "hydrated" && result.input["qref"] === w.qref);
    expect(semantic).toHaveLength(1);
  });

  it("takes no lane lease: another dispatch of the lane is not held up by a qref first use", async () => {
    const w = world(), {cursor} = await cursorFor(w);
    const raced = await withReadCallDispatch(w.workspaceRoot, w.lane, async dispatch => {
      const hydrated = await hydrateReadCall(w.workspaceRoot, w.lane, {cursor}, read, noHandles, undefined, dispatch);
      expect(hydrated.kind === "hydrated" && hydrated.input["qref"]).toBe(w.qref);
      // A query plan's semantic use holds the lane exclusively (readCallContinuation.spec.ts) until its dispatch ends;
      // a qref plan's first use is an ordinary call, like the expanded call it stands for.
      const other = withReadCallDispatch(w.workspaceRoot, w.lane, async () => "ran");
      return Promise.race([other, new Promise<string>(resolve => setTimeout(() => resolve("held up"), 300))]);
    });
    expect(raced).toBe("ran");
  });

  it("a changed source revision is cursor-stale before anything is claimed or written", async () => {
    const w = world(), {cursor} = await cursorFor(w);
    current = {...current, "src/b.ts": current["src/b.ts"] + "// changed\n"};
    const writes = vi.spyOn(stateStoreFor(w.workspaceRoot)!, "put");
    const stale = await hydrate(w, {cursor});
    expect(stale.kind === "refusal" && stale.refusal["code"]).toBe("cursor-stale");
    expect(writes).not.toHaveBeenCalled();
    expect(claim(w, cursor)).toBe("pending");
  });

  it("CAS: the right expected_state_version runs the stored call, a wrong one is a state-conflict that claims nothing", async () => {
    const w = world(), version = (resolveTaskHandle(w.taskHandle, w.workspaceRoot) as {stateVersion: number}).stateVersion;
    const {cursor, args} = await cursorFor(w);
    const ok = await hydrate(w, {cursor, task: {expected_state_version: version}});
    expect(ok.kind === "hydrated" && ok.input).toEqual({...args, task: {...args["task"], expected_state_version: version}});
    const stranger = world(), second = await cursorFor(stranger);
    const conflict = await hydrate(stranger, {cursor: second.cursor, task: {expected_state_version: version + 7}});
    expect(conflict.kind === "refusal" && conflict.refusal["code"]).toBe("state-conflict");
    expect(claim(stranger, second.cursor)).toBe("pending");
    // The refusal claimed nothing, so the plan's first claim is still to come: it runs the stored call, whatever happened in between.
    const later = await hydrate(stranger, {cursor: second.cursor, task: {expected_state_version: version}});
    expect(later.kind === "hydrated" && later.input).toEqual({...second.args, task: {...second.args["task"], expected_state_version: version}});
  });

  it("a rider that changes the request is refused before the claim: handle of another task, another profile, unknown task keys", async () => {
    const w = world(), {cursor} = await cursorFor(w);
    const other = runWithSessionLane("", () => mintTaskHandle(w.workspaceRoot, {taskFingerprint: "someone-elses-task", mintedAtMs: Date.now()})!);
    for (const task of [{handle: other}, {profile: "answer"}, {profile: 7}, {epoch: "new"}, {challenge: {}}]) {
      const refused = await hydrate(w, {cursor, task});
      expect(refused.kind, JSON.stringify(task)).toBe("refusal");
      expect(claim(w, cursor)).toBe("pending");
    }
  });

  it("an invalid restored call is refused before the claim", async () => {
    const w = world(), {cursor} = await cursorFor(w);
    const refused = await hydrate(w, {cursor}, () => ({ok: false, code: "invalid-input", field: "targets"}));
    expect(refused.kind === "refusal" && refused.refusal["code"]).toBe("invalid-input");
    expect(claim(w, cursor)).toBe("pending");
  });
});

describe("a query plan keeps the immediate-use rule, side by side with a qref plan", () => {
  const queryNext = (w: World): Obj => {
    const {qref: _qref, ...rest} = nextArguments(w);
    return {...rest, query: "Explain the control flow of both files, with their constraints."};
  };
  const publish = async (w: World, args: Obj): Promise<string> => cursorOf(await project(w, discover(w, args)));

  it.each([
    ["nothing in between", {}, () => undefined, true],
    ["an intervening call", {}, (w: World) => withReadCallDispatch(w.workspaceRoot, w.lane, async () => undefined), false],
    ["a restart", {}, () => { resetStateStoresForTests(); resetReadCallDispatchForTests(); }, false],
    ["a budget rider", {budget: {bytes: 4096}}, () => undefined, false],
    ["task.force_serve", {task: {force_serve: true}}, () => undefined, false],
  ] as Array<[string, Obj, (w: World) => Promise<void> | void, boolean]>)(
    "%s: a query plan runs its stored query only at an immediate, unridden first use; a qref plan always runs its stored call", async (_name, rider, before, queryRuns) => {
      // One plan per world: each is the first claim of its lane.
      const [a, b] = [world(), world()];
      const queryCursor = await publish(a, queryNext(a)), qrefCursor = await publish(b, nextArguments(b));
      await before(a); await before(b);
      const query = await hydrate(a, {cursor: queryCursor, ...rider});
      const repack = await hydrate(b, {cursor: qrefCursor, ...rider});
      expect(query.kind).toBe("hydrated");
      expect(repack.kind).toBe("hydrated");
      if (query.kind !== "hydrated" || repack.kind !== "hydrated") throw new Error("missing input");
      expect(query.input["query"] !== undefined, "a query plan rebuilds its semantic pack only at its immediate, unridden first use").toBe(queryRuns);
      if (!queryRuns) expect(query.input["content"]).toBe("full");
      expect(repack.input["qref"]).toBe(b.qref);
      expect(repack.input["content"]).toBe("auto");
    });
});

describe("the authenticated binding is the same one a query plan has", () => {
  const publish = async (lane = "") => {
    const w = world(lane), projected = await project(w, discover(w));
    return {w, cursor: cursorOf(projected)};
  };

  it("another lane, another workspace, a tampered alias, a tampered stored call and an expired plan are refused", async () => {
    const {w, cursor} = await publish("lane-a");
    const wrongLane = await hydrate({...w, lane: "lane-b"}, {cursor});
    expect(wrongLane.kind === "refusal" && wrongLane.refusal["code"]).toBe("cursor-invalid");
    const none = await hydrate({...w, lane: ""}, {cursor});
    expect(none.kind === "refusal" && none.refusal["code"]).toBe("cursor-invalid");
    const stranger = world("lane-a");
    const elsewhere = await hydrate({...stranger, lane: "lane-a"}, {cursor});
    expect(elsewhere.kind === "refusal" && elsewhere.refusal["code"]).toBe("cursor-invalid");
    const changed = cursor.slice(0, -1) + (cursor.endsWith("A") ? "B" : "A");
    const tampered = await hydrate(w, {cursor: changed});
    expect(tampered.kind === "refusal" && tampered.refusal["code"]).toBe("cursor-invalid");
    expect(claim(w, cursor), "none of these claimed the plan").toBe("pending");
    // The stored call itself is authenticated: another qref in the record breaks its binding.
    const marker = readCallExecutionKey(plan(w, cursor).state);
    const canonical = resolveReadCallCursorAlias({workspaceRoot: w.workspaceRoot, lane: w.lane, cursor});
    if (canonical.kind !== "canonical") throw new Error("missing canonical cursor");
    const stored = resolveFetchRequestHandle(canonical.cursor, w.workspaceRoot, "read-request");
    if (!stored.ok) throw new Error("missing stored plan");
    (stored.record.data["original_input"] as Obj)["qref"] = "q-ffffffffffffffff";
    const rewritten = await hydrate(w, {cursor});
    expect(rewritten.kind === "refusal" && rewritten.refusal["code"]).toBe("cursor-invalid");
    expect(stateStoreFor(w.workspaceRoot)!.get(marker)?.data["status"], "a rewritten plan claims nothing").toBe("pending");
  });

  it("a plan is unusable once its alias record is gone, and once it has expired", async () => {
    const first = await publish("w");
    stateStoreFor(first.w.workspaceRoot)!.delete(aliasKey(first.cursor));
    const lost = await hydrate(first.w, {cursor: first.cursor});
    expect(lost.kind === "refusal" && lost.refusal["code"]).toBe("cursor-invalid");
    const second = await publish("w");
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + FETCH_REQUEST_HANDLE_TTL_MS + 60_000);
    const expired = await hydrate(second.w, {cursor: second.cursor});
    expect(expired.kind === "refusal" && expired.refusal["code"]).toBe("cursor-invalid");
  });

  it("a plan whose lifetime would outlast its parent task is not extended", async () => {
    const start = Date.now(), w = world();
    vi.spyOn(Date, "now").mockReturnValue(start + TASK_HANDLE_TTL_MS - 3000);
    const stored = plan(w, cursorOf(await project(w, discover(w))));
    expect(stored.state.expires_at_ms - stored.state.created_at_ms).toBeLessThanOrEqual(3000);
  });

  it("an evicted execution marker never grants a second semantic use", async () => {
    const {w, cursor} = await publish();
    expect((await hydrate(w, {cursor})).kind).toBe("hydrated");
    stateStoreFor(w.workspaceRoot)!.delete(readCallExecutionKey(plan(w, cursor).state));
    resetStateStoresForTests();
    expect((await hydrate(w, {cursor})).kind).toBe("refusal");
  });

});

describe("the store admits exactly one semantic request per plan", () => {
  const mint = (w: World, input: Obj) => {
    const scope = beginReadCallDispatch(w.workspaceRoot, w.lane)!;
    try {
      return mintReadCallContinuation({workspaceRoot: w.workspaceRoot, lane: w.lane, taskHandle: w.taskHandle, dispatchBinding: scope.binding,
        originalInput: input, sources: [{path: "src/a.ts", sha: shaOfText(original["src/a.ts"]!)}]});
    } finally { scope.finish(); }
  };
  const call = (w: World, extra: Obj): Obj => ({targets: [{path: "src/a.ts", range: "1-10"}], task: {handle: w.taskHandle}, ...extra});

  it("accepts a query or a qref, never both and never neither", () => {
    const w = world();
    expect(mint(w, call(w, {query: "Explain the flow."}))).toBeDefined();
    expect(mint(w, call(w, {qref: w.qref}))).toBeDefined();
    expect(mint(w, call(w, {query: "Explain the flow.", qref: w.qref}))).toBeUndefined();
    expect(mint(w, call(w, {}))).toBeUndefined();
    expect(mint(w, call(w, {qref: "   "}))).toBeUndefined();
    expect(mint(w, call(w, {qref: 7}))).toBeUndefined();
    expect(mint(w, call(w, {query: "   ", qref: w.qref}))).toBeUndefined();
  });

  it("still binds the stored call to the plan's parent task and keeps cwd, lane and cursor out of it", () => {
    const w = world(), other = runWithSessionLane("", () => mintTaskHandle(w.workspaceRoot, {taskFingerprint: "another", mintedAtMs: Date.now()})!);
    expect(mint(w, {...call(w, {qref: w.qref}), task: {handle: other}})).toBeUndefined();
    expect(mint(w, {...call(w, {qref: w.qref}), task: {}})).toBeUndefined();
    expect(mint(w, call(w, {qref: w.qref, task: {handle: w.taskHandle, epoch: "new"}}))).toBeUndefined();
    for (const key of ["cwd", "lane", "cursor"]) expect(mint(w, call(w, {qref: w.qref, [key]: "x"})), key).toBeUndefined();
    expect(mint(w, call(w, {qref: w.qref, extra: "x".repeat(70_000)}))).toBeUndefined();
  });
});
