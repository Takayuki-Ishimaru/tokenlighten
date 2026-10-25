import {afterEach, describe, expect, it, vi} from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {mintReadCallContinuation, readCallExecutionKey, resolveReadCallContinuation} from "../state/readCallContinuationStore.js";
import {mintReadCallCursorAlias, resolveReadCallCursorAlias} from "../state/readCallCursorAliases.js";
import {FETCH_REQUEST_HANDLE_TTL_MS, fetchRequestPayloadRef, mintTaskHandle, resolveFetchRequestHandle} from "../state/stateHandles.js";
import {resetStateStoresForTests, stateStoreFor} from "../state/stateStore.js";
import {beginReadCallDispatch, resetReadCallDispatchForTests} from "../state/readCallDispatch.js";
import {runWithSessionLane} from "../util/laneKey.js";
import {shaOfText, type HandleEntry} from "../util/handles.js";
import {hydrateReadCallContinuation, omitConfiguredRootCwdOnNext} from "../protocol/readCallContinuation.js";

// The cwd of a read next is redundant exactly when an omitted cwd resolves to the
// workspace the reply was produced for: ingress takes a call without one to the
// configured root. Until 2026-10-24 only a verified short alias lost its cwd; every
// other read next (a `{qref, targets, cwd, task}` re-pack, a restated request, a
// canonical cursor, a window list, a `limit.next` page) carried the absolute path, and
// the first reply of a Copilot CLI task moved with its length (generality audit
// 2026-10-24 §3.7). These pin the pure projection; readCallCwdlessNext.spec.ts runs
// the emitted calls through a spawned server, firstPackPathLength.spec.ts the replies
// at two root path lengths.
type Obj = Record<string, any>;
const roots: string[] = [];
const source = "export const value = 42;\n";
const read = async (file: string) => file === "src/a.ts" ? source : null;
const noHandles = (): HandleEntry | undefined => undefined;
const aliasKey = (alias: string) => fetchRequestPayloadRef(`read-call-cursor-alias:${alias}`).toString("base64url");
const freshRoot = () => { const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tl-cwd-omit-"))); roots.push(root); return root; };

/** One authentic canonical plan and its short alias, bound to `workspaceRoot` and `lane`. */
function plan(lane = "", workspaceRoot = freshRoot(), fingerprint = "cwd-omission") {
  const taskHandle = runWithSessionLane(lane, () => mintTaskHandle(workspaceRoot, {taskFingerprint: fingerprint, mintedAtMs: Date.now()})!);
  const originalInput = {query: "Explain this exact source-window plan.", targets: [{path: "src/a.ts", range: "1-1"}],
    content: "full", task: {handle: taskHandle, profile: "answer"}};
  const scope = beginReadCallDispatch(workspaceRoot, lane)!;
  let canonical: string;
  try {
    canonical = mintReadCallContinuation({workspaceRoot, lane, taskHandle, dispatchBinding: scope.binding, originalInput,
      sources: [{path: "src/a.ts", sha: shaOfText(source)}], responseProfile: "answer"})!;
  } finally { scope.finish(); }
  const alias = mintReadCallCursorAlias({workspaceRoot, lane, canonicalCursor: canonical})!;
  return {workspaceRoot, lane, taskHandle, canonical, alias};
}
type Plan = ReturnType<typeof plan>;
/** The call as the projection writes it before cwd is considered: root path, lane when any, the alias. */
const nextOf = (p: Plan, extra: Obj = {}): Obj => ({tool: "tl_read_file",
  arguments: {cwd: p.workspaceRoot, ...(p.lane ? {lane: p.lane} : {}), cursor: p.alias, ...extra}});
const bodyOf = (...nexts: Obj[]): Obj => ({kind: "read.task_pack", profile: "answer",
  decision: {kind: "discover", next: nexts.length === 1 ? nexts[0] : nexts}});
const omit = (p: Plan, body: Obj, root = p.workspaceRoot, workspace = p.workspaceRoot): Obj =>
  omitConfiguredRootCwdOnNext(workspace, root, body) as Obj;
/** A read next of any shape: the tool, the members given, the cwd of the workspace unless `cwd` says otherwise. */
const readNext = (p: Plan, members: Obj, cwd: unknown = p.workspaceRoot): Obj => ({tool: "tl_read_file", arguments: {...members, ...(cwd !== undefined ? {cwd} : {})}});

afterEach(() => {
  vi.restoreAllMocks(); resetStateStoresForTests(); resetReadCallDispatchForTests();
  for (const root of roots.splice(0)) fs.rmSync(root, {recursive: true, force: true});
});

describe("omitConfiguredRootCwdOnNext: a cursor alias under the configured root", () => {
  it.each(["", "worker"])("drops only the redundant cwd and keeps lane %j and the CAS rider", lane => {
    const p = plan(lane), original = bodyOf(nextOf(p, {task: {expected_state_version: 3}}));
    const before = structuredClone(original);
    const projected = omit(p, original);
    expect(original, "the input body is never edited").toEqual(before);
    expect(projected).not.toBe(original);
    expect(projected["decision"].next).toEqual({tool: "tl_read_file", arguments: {...(lane ? {lane} : {}),
      cursor: p.alias, task: {expected_state_version: 3}}});
    expect(omit(p, projected), "nothing is left to drop").toBe(projected);
    expect(resolveReadCallCursorAlias({workspaceRoot: p.workspaceRoot, lane, cursor: p.alias}))
      .toEqual({kind: "canonical", cursor: p.canonical});
  });

  it("covers batch next[] and every protocol control copy, never evidence, entries or source strings", () => {
    const first = plan("batch"), second = plan("batch", first.workspaceRoot, "cwd-omission-second");
    const [a, b] = [nextOf(first), nextOf(second)];
    const original: Obj = {kind: "read.task_pack", task: {id: first.taskHandle}, decision: {kind: "discover", next: [a, b]},
      plan: {change_contract: {stages: [{next: a}]}}, limit: {next: b}, recovery: {next: a},
      evidence: [{path: "src/a.ts", range: "1-1", body: JSON.stringify(a), next: a}], entries: [a], data: {next: a}};
    const before = structuredClone(original);
    const projected = omit(first, original);
    const bare = (call: Obj) => ({tool: "tl_read_file", arguments: {lane: "batch", cursor: call["arguments"].cursor}});
    expect(projected["decision"].next).toEqual([bare(a), bare(b)]);
    expect(projected["plan"].change_contract.stages[0].next).toEqual(bare(a));
    expect(projected["limit"].next).toEqual(bare(b));
    expect(projected["recovery"].next).toEqual(bare(a));
    for (const key of ["evidence", "entries", "data"]) expect(projected[key], key).toEqual(before[key]);
    expect(original).toEqual(before);
  });

  it("needs no state: the alias loses its cwd with the store gone, as it does with it", () => {
    const p = plan("w"), body = bodyOf(nextOf(p));
    resetStateStoresForTests(); resetReadCallDispatchForTests(); // a new process: no memory, only the store on disk
    expect((omit(p, body)["decision"] as Obj).next.arguments).toEqual({lane: "w", cursor: p.alias});
    fs.rmSync(path.join(p.workspaceRoot, ".tokenlighten"), {recursive: true, force: true});
    resetStateStoresForTests();
    expect((omit(p, body)["decision"] as Obj).next.arguments).toEqual({lane: "w", cursor: p.alias});
  });

  it("is a pure projection: no write, no claim, the plan stays pending and restorable", () => {
    const p = plan("w"), store = stateStoreFor(p.workspaceRoot)!, resolved = resolveReadCallContinuation({
      workspaceRoot: p.workspaceRoot, lane: p.lane, cursor: p.canonical});
    if (resolved.kind !== "read-call") throw new Error("missing plan");
    const put = vi.spyOn(store, "put");
    omit(p, bodyOf(nextOf(p), nextOf(p)));
    expect(put).not.toHaveBeenCalled();
    expect(store.get(readCallExecutionKey(resolved.state))!.data["status"]).toBe("pending");
  });

  it("leaves the executed call the same: ingress takes its workspace from the root, never from the call", async () => {
    const p = plan("w"), omitted = (omit(p, bodyOf(nextOf(p)))["decision"] as Obj).next.arguments;
    expect(omitted.cwd).toBeUndefined();
    const hydrated = await hydrateReadCallContinuation(p.workspaceRoot, p.lane, omitted, read, noHandles);
    expect(hydrated.kind).toBe("hydrated");
    if (hydrated.kind !== "hydrated") throw new Error("missing input");
    expect(hydrated.input).toMatchObject({cwd: p.workspaceRoot, lane: "w", targets: [{path: "src/a.ts", range: "1-1"}],
      task: {handle: p.taskHandle, profile: "answer"}});
  });
});

describe("omitConfiguredRootCwdOnNext: every read next under the configured root, whatever its shape", () => {
  const T = "tlh_task_v1_example";
  const shapes: Array<[string, Obj]> = [
    // The audit's shape: the pack's discovery bundle, re-packed by qref over whole files (no window to compact to a cursor).
    ["a qref re-pack over bare-path targets (the discovery bundle)", {qref: "q-0123456789abcdef", targets: [{path: "src/a.ts"}, {path: "src/b.ts"}], task: {handle: T}}],
    ["a qref re-pack over windows, with a purpose", {qref: "q-0123456789abcdef", targets: [{path: "src/a.ts", range: "1-9"}, {path: "src/b.ts", ranges: ["3-4", "8-9"], purpose: "edit-context: x"}], content: "auto", task: {handle: T}}],
    ["a restated request over its owed windows", {query: "Explain the flow.", targets: [{handle: "hsource", ranges: ["10-20", "30-40"]}], content: "auto", task: {handle: T}}],
    ["a window list with no request at all", {targets: [{handle: "hsource", range: "1-10"}]}],
    ["a budget rider", {targets: [{path: "src/a.ts"}], budget: {bytes: 4096}}],
    ["a lane", {lane: "worker", targets: [{path: "src/a.ts"}]}],
    ["select and scope", {select: {sections: ["x"]}, scope: {path: "src"}}],
    ["task.force_serve, task.profile and a CAS rider", {qref: "q-0123456789abcdef", task: {force_serve: true, profile: "answer", expected_state_version: 2}}],
    ["a string task", {query: "again", task: "{\"expected_state_version\":1}"}],
    ["a canonical cursor", {cursor: "tlc_s1_AAAAAAAAAAAA_AAAAAAAAAAAAAAAAAAAAAA"}],
    ["a malformed alias", {cursor: "tlc_s1_unknown"}],
    ["a non-string cursor", {cursor: 7}],
    ["no members at all", {}],
  ];
  it.each(shapes)("drops the cwd of %s and changes nothing else, the other members in the order they had", (_name, members) => {
    const p = plan(""), original = bodyOf(readNext(p, {...members, cwd: p.workspaceRoot})), before = structuredClone(original);
    const call = (original["decision"] as Obj).next.arguments as Obj;
    const projected = omit(p, original);
    expect(original, "the input body is never edited").toEqual(before);
    expect(projected).not.toBe(original);
    const {cwd: _cwd, ...rest} = call;
    expect((projected["decision"] as Obj).next).toEqual({tool: "tl_read_file", arguments: rest});
    expect(Object.keys((projected["decision"] as Obj).next.arguments)).toEqual(Object.keys(rest));
    expect(omit(p, projected), "nothing is left to drop").toBe(projected);
  });

  it("is the shape the audit measured: {qref, targets, cwd, task} loses exactly the path", () => {
    const p = plan("w"), bundle = {qref: "q-0123456789abcdef", targets: [{path: "src/a.ts"}, {path: "src/b.ts"}], cwd: p.workspaceRoot, lane: "w", task: {handle: T}};
    const original = bodyOf({tool: "tl_read_file", arguments: bundle}), projected = omit(p, original);
    expect(Buffer.byteLength(JSON.stringify(original)) - Buffer.byteLength(JSON.stringify(projected)), "the path and its member").toBe(Buffer.byteLength(`"cwd":${JSON.stringify(p.workspaceRoot)},`));
    expect(JSON.stringify((projected["decision"] as Obj).next)).not.toContain(p.workspaceRoot);
    expect((projected["decision"] as Obj).next.arguments).toEqual({qref: bundle.qref, targets: bundle.targets, lane: "w", task: {handle: T}});
  });

  it("reaches next[], limit.next, the other control containers, a receipt's own next and their copies, and none of evidence, entries or data", () => {
    const p = plan("w"), a = readNext(p, {qref: "q-0123456789abcdef", targets: [{path: "src/a.ts"}], lane: "w"}), b = readNext(p, {query: "x", targets: [{path: "src/b.ts", range: "1-2"}], lane: "w"});
    // A read.receipt publishes its continuation twice, as `receipt.next` and as `limit.next`: one canonical call on the wire, never two that differ by the path.
    const original: Obj = {kind: "read.receipt", task: {id: p.taskHandle}, decision: {kind: "discover", next: [a, b], next_call: b},
      receipt: {receipt: "code-unchanged", handle: "h0000000001", sha: "sha256:0123456789ab", next: b},
      plan: {change_contract: {stages: [{next: a}]}}, limit: {cause: "capped", next: b}, recovery: {next: a}, verification: {next_call: a},
      evidence: [{path: "src/a.ts", range: "1-1", body: JSON.stringify(a), next: a}], entries: [a], data: {next: a}};
    const before = structuredClone(original), projected = omit(p, original);
    const bare = (call: Obj): Obj => ({tool: "tl_read_file", arguments: Object.fromEntries(Object.entries(call["arguments"]).filter(([key]) => key !== "cwd"))});
    expect(projected["decision"].next).toEqual([bare(a), bare(b)]);
    expect(projected["decision"].next_call).toEqual(bare(b));
    expect(projected["plan"].change_contract.stages[0].next).toEqual(bare(a));
    expect(projected["limit"].next).toEqual(bare(b));
    expect(projected["recovery"].next).toEqual(bare(a));
    expect(projected["verification"].next_call).toEqual(bare(a));
    expect(projected["receipt"], "the receipt keeps everything but the path of its next").toEqual({...before["receipt"], next: bare(b)});
    expect(projected["receipt"].next, "…and it is the call limit.next carries").toEqual(projected["limit"].next);
    for (const key of ["evidence", "entries", "data"]) expect(projected[key], key).toEqual(before[key]);
    expect(original).toEqual(before);
  });

  it("changes only read and search calls that name the root: other workspaces, edits and cwd-less calls stay as they are", () => {
    const p = plan("w"), other = freshRoot();
    const ours = readNext(p, {query: "x", targets: [{path: "src/a.ts", range: "1-2"}]}), elsewhere = readNext(p, {query: "x"}, other);
    const search = {tool: "tl_search_files", arguments: {action: "find", queries: ["a"], cwd: p.workspaceRoot}};
    const edit = {tool: "tl_edit_file", arguments: {edits: [{path: "src/a.ts", search: "a", replace: "b"}], cwd: p.workspaceRoot}};
    const bare = {tool: "tl_read_file", arguments: {query: "x"}};
    const projected = omit(p, bodyOf(ours, elsewhere, search, edit, bare));
    expect(projected["decision"].next[0].arguments.cwd).toBeUndefined();
    expect(projected["decision"].next.slice(1)).toEqual([elsewhere,
      {tool: "tl_search_files", arguments: {action: "find", queries: ["a"]}}, edit, bare]);
  });

  type Fixture = {name: string; arrange: (p: Plan) => Obj | void};
  const unverifiable: Fixture[] = [
    {name: "a canonical cursor", arrange: p => ({cursor: p.canonical})},
    {name: "an alias nobody minted", arrange: () => ({cursor: "tlc_s1_AAAAAAAAAAAA_AAAAAAAAAAAAAAAAAAAAAA"})},
    {name: "a tampered alias", arrange: p => ({cursor: p.alias.slice(0, -1) + (p.alias.endsWith("A") ? "B" : "A")})},
    {name: "an alias whose record was deleted", arrange: p => { stateStoreFor(p.workspaceRoot)!.delete(aliasKey(p.alias)); }},
    {name: "an alias whose canonical plan was evicted", arrange: p => {
      const stored = resolveFetchRequestHandle(p.canonical, p.workspaceRoot, "read-request");
      if (!stored.ok) throw new Error("missing canonical store record");
      stateStoreFor(p.workspaceRoot)!.delete(stored.payloadRef);
    }},
    {name: "an alias after its expiry", arrange: () => { vi.spyOn(Date, "now").mockReturnValue(Date.now() + FETCH_REQUEST_HANDLE_TTL_MS + 60_000); }},
    {name: "an alias bound to another lane", arrange: () => ({lane: "lane-b"})},
    {name: "a lane that is not the reply's", arrange: () => ({lane: "another"})},
  ];
  it.each(unverifiable)("a cursor that is no verified alias is no reason to keep the path: $name", ({arrange}) => {
    const p = plan("w"), args = arrange(p) ?? {}, body = bodyOf(nextOf(p, args));
    const {cwd: _cwd, ...rest} = (body["decision"] as Obj).next.arguments;
    expect((omit(p, body)["decision"] as Obj).next.arguments).toEqual(rest);
  });
});

describe("omitConfiguredRootCwdOnNext: keeps cwd everywhere else", () => {
  it.each([
    ["a subtree of the root", (root: string) => { const sub = path.join(root, "pkg"); fs.mkdirSync(sub); return sub; }],
    ["another root, a registered worktree or an allowed-parent child", () => freshRoot()],
  ])("%s", (_name, makeWorkspace) => {
    const root = freshRoot(), workspace = makeWorkspace(root);
    const p = plan("", workspace), body = bodyOf(nextOf(p), readNext(p, {qref: "q-0123456789abcdef", targets: [{path: "src/a.ts"}]}));
    expect(resolveReadCallCursorAlias({workspaceRoot: workspace, lane: "", cursor: p.alias}).kind, "the alias itself is authentic").toBe("canonical");
    expect(omit(p, body, root, workspace)).toBe(body);
    expect((body["decision"] as Obj).next[0].arguments.cwd).toBe(workspace);
    expect((body["decision"] as Obj).next[1].arguments.cwd).toBe(workspace);
  });

  it("keeps the cwd of a next that names the root while the call ran elsewhere", () => {
    const root = freshRoot(), elsewhere = freshRoot(), p = plan("", root), body = bodyOf(nextOf(p), readNext(p, {query: "x"}));
    expect(omit(p, body, root, elsewhere)).toBe(body);
  });

  const notTheWorkspace: Array<[string, (p: Plan) => unknown]> = [
    ["a cwd with a trailing separator", p => p.workspaceRoot + "/"],
    ["a mistyped cwd", p => p.workspaceRoot.replace("tl-cwd-omit-", "tl-cwd-omit- extra-")],
    ["a relative cwd", () => "."],
    ["a subtree of the workspace", p => p.workspaceRoot + "/pkg"],
    ["a non-string cwd", () => 7],
  ];
  it.each(notTheWorkspace)("%s", (_name, cwd) => {
    const p = plan(""), body = bodyOf(nextOf(p, {cwd: cwd(p)}), readNext(p, {qref: "q-0123456789abcdef", targets: [{path: "src/a.ts"}]}, cwd(p)));
    expect(omit(p, body)).toBe(body);
  });

  it("never touches tl_edit_file calls, whatever their members", () => {
    const p = plan("w"), body = bodyOf({tool: "tl_edit_file", arguments: {cwd: p.workspaceRoot, edits: []}});
    expect(omit(p, body)).toBe(body);
  });

  it("ignores a call without arguments and bodies that carry no continuation", () => {
    const p = plan(), empty = bodyOf({tool: "tl_read_file"}), plain = {kind: "read.text", evidence: [{path: "src/a.ts", body: "x"}]};
    expect(omit(p, empty)).toBe(empty);
    expect(omit(p, plain)).toBe(plain);
    const already = bodyOf({tool: "tl_read_file", arguments: {cursor: p.alias}}, {tool: "tl_read_file", arguments: {qref: "q-0123456789abcdef", targets: [{path: "src/a.ts"}]}});
    expect(omit(p, already)).toBe(already);
  });
});
