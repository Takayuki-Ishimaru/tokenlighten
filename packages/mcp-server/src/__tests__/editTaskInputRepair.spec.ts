import {afterEach, describe, expect, it, vi} from "vitest";
import {mkdtempSync, realpathSync, rmSync} from "node:fs";
import {homedir} from "node:os";
import * as path from "node:path";
import {repairEditTaskIdEcho, isCurrentSingleEditHandle} from "../state/editTaskInputRepair.js";
import {compactTaskHandle, expandTaskHandle} from "../state/taskHandleAliases.js";
import {laneTaskHandles, recordLaneTaskHandle, resetLaneTaskHandlesForTest} from "../state/laneTaskHandles.js";
import {mintTaskHandle, TASK_HANDLE_TTL_MS} from "../state/stateHandles.js";
import {resetStateStoresForTests} from "../state/stateStore.js";
import {attachTaskQueryRefBinding, rememberTaskQuery} from "../state/session.js";
import {runWithSessionLane} from "../util/laneKey.js";
import type {HandleEntry} from "../util/handles.js";
import {prepareCanonicalInput} from "../server.js";

const roots: string[] = [];
const lane = "edit-repair";
const fingerprint = "task-repair-source-binding";
function root(): string {
  const workspace = realpathSync(mkdtempSync(path.join(homedir(), ".tl-edit-task-repair-")));
  roots.push(workspace);
  return workspace;
}
function mintBound(workspace: string, name = "query", taskFingerprint = fingerprint): string {
  return runWithSessionLane(lane, () => {
    const replay = rememberTaskQuery(workspace, name, taskFingerprint);
    const token = mintTaskHandle(workspace, {taskFingerprint, replay, mintedAtMs: Date.now()})!;
    attachTaskQueryRefBinding(workspace, replay, taskFingerprint, token);
    recordLaneTaskHandle(workspace, lane, token);
    return token;
  });
}
function args(alias: string, handle?: string): Record<string, unknown> {
  return {task: {id: alias, ...(handle !== undefined ? {handle} : {}), expected_state_version: 7, profile: "generic"},
    edits: [{...(handle !== undefined ? {handle} : {}), search: "before", replace: "after"}]};
}
afterEach(() => {
  vi.restoreAllMocks(); resetLaneTaskHandlesForTest(); resetStateStoresForTests();
  for (const workspace of roots.splice(0)) rmSync(workspace, {recursive: true, force: true});
});

describe("edit task.id echo repair", () => {
  it("uses only the latest source-bound live alias and preserves CAS, profile, item bytes, and caller input", async () => {
    const workspace = root(), token = mintBound(workspace), alias = compactTaskHandle(workspace, lane, token);
    const sourceItem = {handle: "hfile-live", search: "before", replace: "after"};
    const input = {task: {id: alias, handle: sourceItem.handle, expected_state_version: 7, profile: "generic"}, edits: [sourceItem]};
    const before = structuredClone(input);
    const repaired = await repairEditTaskIdEcho(input, workspace, lane, handle => handle === sourceItem.handle);
    expect(repaired).toEqual({task: {handle: token, expected_state_version: 7, profile: "generic"}, edits: [sourceItem]});
    expect(repaired.edits).toBe(input.edits);
    expect(input).toEqual(before);
    expect(laneTaskHandles(workspace, lane)[0]).toBe(token);
    expect(await repairEditTaskIdEcho(repaired, workspace, lane, () => true)).toBe(repaired);
  });

  it.each(["unknown-key", "epoch", "source-unbound", "old-task", "other-task-handle", "wrong-lane", "wrong-workspace", "restart"])(
    "leaves %s unchanged", async variant => {
      const workspace = root();
      let token: string;
      if (variant === "source-unbound") {
        token = runWithSessionLane(lane, () => {
          const replay = rememberTaskQuery(workspace, "unbound query");
          const unbound = mintTaskHandle(workspace, {taskFingerprint: "unbound-fingerprint", replay, mintedAtMs: Date.now()})!;
          recordLaneTaskHandle(workspace, lane, unbound);
          return unbound;
        });
      } else token = mintBound(workspace, "first");
      const alias = compactTaskHandle(workspace, lane, token);
      let input = args(alias, "hfile-live");
      if (variant === "unknown-key") input = {...input, task: {...(input.task as object), typo: true}};
      if (variant === "epoch") input = {...input, task: {...(input.task as object), epoch: "new"}};
      if (variant === "old-task") {
        mintBound(workspace, "second", "newer-fingerprint");
      }
      if (variant === "other-task-handle") {
        const other = mintBound(workspace, "other", "conflicting-fingerprint");
        input = {...input, task: {...(input.task as object), handle: other}};
      }
      const proofLane = variant === "wrong-lane" ? "other-lane" : lane;
      const proofWorkspace = variant === "wrong-workspace" ? root() : workspace;
      if (variant === "restart") resetLaneTaskHandlesForTest();
      const before = structuredClone(input);
      const repaired = await repairEditTaskIdEcho(input, proofWorkspace, proofLane, () => true);
      expect(repaired).toBe(input);
      expect(repaired).toEqual(before);
    },
  );

  it.each(["alias", "canonical"] as const)("leaves current task B plus conflicting valid task A %s unchanged", async spelling => {
    const workspace = root();
    const tokenA = mintBound(workspace, "task-a", "fingerprint-a");
    const aliasA = compactTaskHandle(workspace, lane, tokenA);
    const tokenB = mintBound(workspace, "task-b", "fingerprint-b");
    const aliasB = compactTaskHandle(workspace, lane, tokenB);
    const input = {task: {id: aliasB, handle: spelling === "alias" ? aliasA : tokenA, profile: "generic"},
      edits: [{handle: "hfile-live", search: "before", replace: "after"}]};
    expect(laneTaskHandles(workspace, lane)[0]).toBe(tokenB);
    expect(expandTaskHandle(workspace, lane, aliasA)).toBe(tokenA);
    expect(expandTaskHandle(workspace, lane, aliasB)).toBe(tokenB);
    expect(await repairEditTaskIdEcho(input, workspace, lane, () => false)).toBe(input);
  });

  it("refuses an expired task alias and never accepts a historical lane token", async () => {
    const workspace = root(), token = mintBound(workspace), alias = compactTaskHandle(workspace, lane, token);
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + TASK_HANDLE_TTL_MS + 1);
    const expired = args(alias, "hfile-live");
    expect(await repairEditTaskIdEcho(expired, workspace, lane, () => true)).toBe(expired);
    vi.restoreAllMocks();
    const current = mintBound(workspace, "newer", "newer-fingerprint");
    expect(laneTaskHandles(workspace, lane)[0]).toBe(current);
    const old = args(alias, "hfile-live");
    expect(await repairEditTaskIdEcho(old, workspace, lane, () => true)).toBe(old);
  });
});

describe("current item-handle proof", () => {
  const makeEntry = (patch: Partial<HandleEntry> = {}): HandleEntry => ({id: "hfile", purpose: "content", kind: "file",
    path: "src/file.ts", workspaceRoot: "/workspace", lane, createdAt: 1, ...patch});
  it("accepts only the sole exact live content handle in the same workspace and lane", () => {
    const file = makeEntry();
    expect(isCurrentSingleEditHandle({edits: [{handle: file.id}]}, file.id, "/workspace", lane, () => file)).toBe(true);
    const range = makeEntry({kind: "range", range: "2-2"});
    expect(isCurrentSingleEditHandle({edits: [{handle: range.id}]}, range.id, "/workspace", lane, () => range)).toBe(true);
    const wrongPurpose = {...file, purpose: "other"} as unknown as HandleEntry;
    for (const entry of [
      wrongPurpose, makeEntry({workspaceRoot: "/other"}), makeEntry({lane: "other"}),
      makeEntry({kind: "symbol"}), makeEntry({kind: "range", range: "bad"}),
      makeEntry({kind: "file", range: "1-1"}),
    ]) {
      expect(isCurrentSingleEditHandle({edits: [{handle: entry.id}]}, entry.id, "/workspace", lane, () => entry)).toBe(false);
    }
    expect(isCurrentSingleEditHandle({edits: [{handle: file.id}, {handle: file.id}]}, file.id, "/workspace", lane, () => file)).toBe(false);
    expect(isCurrentSingleEditHandle({edits: [{handle: "different"}]}, file.id, "/workspace", lane, () => file)).toBe(false);
    expect(isCurrentSingleEditHandle({edits: [{handle: file.id}]}, file.id, "/workspace", lane, () => undefined)).toBe(false);
  });
});

describe("unique-match input repair", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("repairs only an unambiguous item.match and preserves edit bytes idempotently", () => {
    vi.stubEnv("TL_EFF_TOLERANT_INPUT", "1");
    const input = {edits: [{path: "src/a.ts", search: "before", replace: "after", match: "unique-match"}]};
    const first = prepareCanonicalInput("tl_edit_file", input);
    expect(first.edits).toEqual([{path: "src/a.ts", search: "before", replace: "after", precondition: "unique-match"}]);
    expect((first.edits as Array<Record<string, unknown>>)[0]).toMatchObject({search: "before", replace: "after"});
    expect(prepareCanonicalInput("tl_edit_file", first)).toEqual(first);
  });

  it.each([
    {match: "wrong"}, {match: 1}, {match: "unique-match", precondition: "expected-hash"},
    {match: "unique-match", precondition: "unique-match"},
  ])("leaves invalid, conflicting, or otherwise unknown item keys for schema refusal: %j", item => {
    vi.stubEnv("TL_EFF_TOLERANT_INPUT", "1");
    const input = {edits: [{path: "src/a.ts", search: "before", replace: "after", ...item}]};
    expect(prepareCanonicalInput("tl_edit_file", input).edits).toEqual(input.edits);
  });

  it("retains the existing padded-replace conflict and only repairs a sole padded match", () => {
    vi.stubEnv("TL_EFF_TOLERANT_INPUT", "1");
    const sole = prepareCanonicalInput("tl_edit_file", {edits: [{path: "a", search: "s", replace: "r", "\tmatch": "unique-match"}]});
    expect(sole.edits).toEqual([{path: "a", search: "s", replace: "r", precondition: "unique-match"}]);
    const conflicting = prepareCanonicalInput("tl_edit_file", {edits: [{path: "a", search: "s", replace: "canonical", "\treplace": "padded", match: "unique-match"}]});
    expect(conflicting.edits).toEqual([{path: "a", search: "s", replace: "canonical", "\treplace": "padded", precondition: "unique-match"}]);
    const duplicateMatch = prepareCanonicalInput("tl_edit_file", {edits: [{path: "a", search: "s", replace: "r", match: "unique-match", "\tmatch": "other"}]});
    expect(duplicateMatch.edits).toEqual([{path: "a", search: "s", replace: "r", match: "unique-match", "\tmatch": "other"}]);
    const unknown = prepareCanonicalInput("tl_edit_file", {edits: [{path: "a", search: "s", replace: "r", match: "unique-match", extra: true}]});
    expect(unknown.edits).toEqual([{path: "a", search: "s", replace: "r", precondition: "unique-match", extra: true}]);
  });
});
