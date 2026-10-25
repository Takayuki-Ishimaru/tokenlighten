import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { compactTaskHandle, expandTaskHandle, expandTaskAliasArguments, projectTaskAliasBody, taskAliasLaneMismatch } from "../state/taskHandleAliases.js";
import { mintTaskHandle, resolveTaskHandle, TASK_HANDLE_TTL_MS } from "../state/stateHandles.js";
import { runWithSessionLane } from "../util/laneKey.js";
import { resetStateStoresForTests, stateStoreFor } from "../state/stateStore.js";
import { TASK_ALIAS_PATTERN } from "../state/taskHandleAliasFormat.js";
const roots: string[] = [];
function root() { const r = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tl-task-alias-"))); roots.push(r); return r; }
function mint(ws: string, fingerprint = "test-task", replay = "q1", lane = "") {
  return runWithSessionLane(lane, () => mintTaskHandle(ws, { taskFingerprint: fingerprint, replay, mintedAtMs: Date.now() })!);
}
afterEach(() => { vi.restoreAllMocks(); resetStateStoresForTests(); for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true }); });
describe("durable compact task references", () => {
  it("diagnoses only an exact authenticated live alias binding without changing task state", () => {
    const ws = root(), token = mint(ws), alias = compactTaskHandle(ws, "", token);
    const store = stateStoreFor(ws)!, before = resolveTaskHandle(token, ws), put = vi.spyOn(store, "put");
    expect(taskAliasLaneMismatch(ws, "shared", alias)).toBe("");
    expect(taskAliasLaneMismatch(ws, "", alias)).toBeUndefined();
    expect(taskAliasLaneMismatch(ws, "shared", token)).toBeUndefined();
    expect(taskAliasLaneMismatch(root(), "shared", alias)).toBeUndefined();
    expect(taskAliasLaneMismatch(ws, "shared", alias.slice(0, -1) + "!")).toBeUndefined();
    expect(resolveTaskHandle(token, ws)).toEqual(before);
    expect(put).not.toHaveBeenCalled();
  });
  it("keeps the selected binding across multiple lanes, restart and token rotation", () => {
    const ws = root(), start = Date.now(), token = mint(ws, "test-task", "q1", "one");
    const one = compactTaskHandle(ws, "one", token);
    mint(ws, "test-task", "q2", "two");
    const two = compactTaskHandle(ws, "two", token);
    vi.spyOn(Date, "now").mockReturnValue(start + TASK_HANDLE_TTL_MS * 0.8);
    expect(mint(ws, "test-task", "q3", "three")).not.toBe(token);
    resetStateStoresForTests();
    expect(taskAliasLaneMismatch(ws, "two", one)).toBe("one");
    expect(taskAliasLaneMismatch(ws, "one", two)).toBe("two");
  });
  it.each(["duplicate", "expired", "corrupt-token", "wrong-ref", "stale-store"])(
    "does not disclose routing for %s alias state", variant => {
      const ws = root(), token = mint(ws), alias = compactTaskHandle(ws, "", token);
      const store = stateStoreFor(ws)!, key = TASK_ALIAS_PATTERN.exec(alias)![1]!, row = store.get(key)!;
      if (variant === "stale-store") {
        resetStateStoresForTests();
        fs.rmSync(path.join(ws, ".tokenlighten"), {recursive: true, force: true});
        expect(taskAliasLaneMismatch(ws, "shared", alias)).toBeUndefined();
        return;
      }
      const bindings = structuredClone(row.data["compactAliases"]) as any[];
      if (variant === "duplicate") bindings.push({...bindings[0]});
      if (variant === "expired") bindings[0].expiresAtMs = Date.now() - 1;
      if (variant === "corrupt-token") bindings[0].token += "!";
      if (variant === "wrong-ref") {
        const foreign = mint(root());
        bindings[0].token = foreign;
      }
      store.put({key, purpose: "task", data: {...row.data, compactAliases: bindings},
        ttlMs: TASK_HANDLE_TTL_MS, expectedVersion: row.version});
      expect(taskAliasLaneMismatch(ws, "shared", alias)).toBeUndefined();
    });

  it("keeps one original record and never changes CAS while projecting a stable alias", () => {
    const ws = root(), token = mint(ws, "test-task", "q1", "lane"), store = stateStoreFor(ws)!;
    const before = resolveTaskHandle(token, ws);
    const put = vi.spyOn(store, "put");
    const alias = compactTaskHandle(ws, "lane", token);
    expect(resolveTaskHandle(token, ws)).toEqual(before);
    expect(put).not.toHaveBeenCalled();
    expect(alias).toMatch(/^tlh_s1_[A-Za-z0-9_-]{12}_[A-Za-z0-9_-]{22}$/);
    expect(alias.length).toBe(42);
    const version = resolveTaskHandle(token, ws);
    expect(compactTaskHandle(ws, "lane", token)).toBe(alias);
    expect(resolveTaskHandle(token, ws)).toEqual(version);
    expect(store.size).toBe(1);
    expect(expandTaskHandle(ws, "lane", alias)).toBe(token);
  });
  it("survives a store reload and later task updates without dropping the binding", () => {
    const ws = root(), token = mint(ws), alias = compactTaskHandle(ws, "", token);
    resetStateStoresForTests();
    expect(expandTaskHandle(ws, "", alias)).toBe(token);
    expect(mint(ws, "test-task", "q2")).toBe(token);
    resetStateStoresForTests();
    expect(expandTaskHandle(ws, "", alias)).toBe(token);
    const resolved = resolveTaskHandle(token, ws);
    expect(resolved.ok && resolved.state.replay).toBe("q2");
  });
  it("isolates workspaces/lanes and refuses mutations without guessing", () => {
    const ws = root(), other = root(), token = mint(ws, "test-task", "q1", "one"), alias = compactTaskHandle(ws, "one", token);
    expect(expandTaskHandle(ws, "two", alias)).toBeUndefined();
    expect(expandTaskHandle(other, "one", alias)).toBeUndefined();
    expect(expandTaskHandle(ws, "one", alias.slice(0, -1) + (alias.endsWith("a") ? "b" : "a"))).toBeUndefined();
    expect(compactTaskHandle(ws, "one", token.slice(0, -4))).toBe(token.slice(0, -4));
    expect(expandTaskAliasArguments(ws, "two", { task: { handle: alias } }).task).toEqual({ handle: alias });
  });

  it("preserves live lane bindings at capacity and across token rotation", () => {
    const ws = root(), start = Date.now();
    let token = "";
    const aliases: string[] = [];
    for (let i = 0; i < 16; i++) {
      token = mint(ws, "test-task", "q" + i, "lane" + i);
      aliases.push(compactTaskHandle(ws, "lane" + i, token));
    }
    mint(ws, "test-task", "q-extra", "extra");
    expect(compactTaskHandle(ws, "extra", token)).toBe(token);
    for (let i = 0; i < 16; i++) expect(expandTaskHandle(ws, "lane" + i, aliases[i]!)).toBe(token);
    vi.spyOn(Date, "now").mockReturnValue(start + TASK_HANDLE_TTL_MS * 0.8);
    expect(mint(ws)).not.toBe(token);
    resetStateStoresForTests();
    expect(expandTaskHandle(ws, "lane0", aliases[0]!)).toBe(token);
  });

  it.each([false, true])("expands an authenticated misplaced epoch without guessing a swap (encoded=%s)", encoded => {
    const ws = root(), token = mint(ws, "test-task", "q1", "one"), alias = compactTaskHandle(ws, "one", token);
    const task = {epoch: alias, handle: "file-handle", expected_state_version: 7};
    const args = {task: encoded ? JSON.stringify(task) : task, edits: [{handle: "file-handle", search: alias, replace: token}]};
    const expanded = expandTaskAliasArguments(ws, "one", args);
    expect(encoded ? JSON.parse(expanded.task as string) : expanded.task).toEqual({...task, epoch: token});
    expect(expanded.edits).toBe(args.edits);
    expect(args.task).toEqual(encoded ? JSON.stringify(task) : task);
    const noHandle = expandTaskAliasArguments(ws, "one", {task: {epoch: alias}});
    expect(noHandle.task).toEqual({epoch: token});
    const explicit = mint(ws, "other-task", "q2", "one");
    expect(expandTaskAliasArguments(ws, "one", {task: {epoch: alias, handle: explicit}}).task)
      .toEqual({epoch: token, handle: explicit});
  });
  it("leaves invalid epoch references and literal new unchanged without state writes", () => {
    const ws = root(), token = mint(ws, "test-task", "q1", "one"), alias = compactTaskHandle(ws, "one", token);
    const store = stateStoreFor(ws)!, put = vi.spyOn(store, "put");
    for (const [workspace, lane, epoch] of [[root(), "one", alias], [ws, "two", alias],
      [ws, "one", alias + "!"], [ws, "one", "new"]] as const) {
      const args = {task: {epoch, handle: "file-handle"}};
      expect(expandTaskAliasArguments(workspace, lane, args)).toBe(args);
    }
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + TASK_HANDLE_TTL_MS + 1000);
    const expired = {task: {epoch: alias}};
    expect(expandTaskAliasArguments(ws, "one", expired)).toBe(expired);
    expect(put).not.toHaveBeenCalled();
  });

  it("never extends the underlying token lifetime", () => {
    const ws = root(), start = Date.now(), token = mint(ws), alias = compactTaskHandle(ws, "", token);
    vi.spyOn(Date, "now").mockReturnValue(start + TASK_HANDLE_TTL_MS + 1000);
    expect(expandTaskHandle(ws, "", alias)).toBeUndefined();
    expect(compactTaskHandle(ws, "", token)).toBe(token);
  });
  it("does not write while projecting and falls back for an unregistered lane", () => {
    const ws = root(), token = mint(ws), store = stateStoreFor(ws)!;
    vi.spyOn(store, "put").mockReturnValue({ ok: false, outcome: "store-unavailable" });
    expect(compactTaskHandle(ws, "", token)).toMatch(/^tlh_s1_/);
    expect(compactTaskHandle(ws, "unregistered", token)).toBe(token);
    expect(resolveTaskHandle(token, ws).ok).toBe(true);
  });
  it("projects copies of protocol controls and leaves all source and arbitrary payloads exact", () => {
    const ws = root(), token = mint(ws);
    const source = { task: { id: token }, next: { tool: "tl_read_file", arguments: { cwd: ws, task: { handle: token } } } };
    const body = { ...source, evidence: [{ body: JSON.stringify(source), ...source }], entries: [source], data: source };
    const projected = projectTaskAliasBody(ws, "", body);
    const alias = compactTaskHandle(ws, "", token);
    expect((projected.task as any).id).toBe(alias);
    expect((projected.next as any).arguments.task.handle).toBe(alias);
    expect(projected.evidence).toEqual(body.evidence);
    expect(projected.entries).toEqual(body.entries);
    expect(projected.data).toEqual(body.data);
    expect(body.task.id).toBe(token);
    const args = { task: { handle: alias, expected_state_version: 77 }, edits: [{ search: alias, replace: token }] };
    const expanded = expandTaskAliasArguments(ws, "", args);
    expect(expanded.task).toEqual({ handle: token, expected_state_version: 77 });
    expect(expanded.edits).toEqual(args.edits);
    expect(args.task.handle).toBe(alias);
  });
  it("compacts edit closure recovery calls without visiting source or changing lane bindings", () => {
    const ws = root(), token = mint(ws, "test-task", "q1", "one");
    const call = (cwd = ws, lane = "one") => ({tool: "tl_search_files", arguments: {
      cwd, lane, action: "find", queries: ["CRITICAL"], scope: {path: "src/schema.ts"},
      task: {handle: token, expected_state_version: 7},
    }});
    const body = {kind: "edit.applied", closure: {open: ["missing member"], done: 4,
      capability_gaps: [{kind: "missing-evidence", reason: "missing member", next_call: call()},
        {next_call: call(ws, "two")}, {next_call: call(root())}]},
      evidence: [{closure: {capability_gaps: [{next_call: call()}]}, body: token}]};
    const before = structuredClone(body), store = stateStoreFor(ws)!, put = vi.spyOn(store, "put");
    const projected = projectTaskAliasBody(ws, "one", body) as typeof body;
    const gaps = projected.closure.capability_gaps;
    expect(gaps[0]!.next_call.arguments.task).toEqual({handle: compactTaskHandle(ws, "one", token), expected_state_version: 7});
    expect(gaps[0]!.next_call.arguments.queries).toEqual(["CRITICAL"]);
    expect(gaps[1]!.next_call.arguments.task.handle).toBe(token);
    expect(gaps[2]!.next_call.arguments.task.handle).toBe(token);
    expect(projected.evidence).toEqual(before.evidence);
    expect(body).toEqual(before);
    expect(put).not.toHaveBeenCalled();
  });
});
