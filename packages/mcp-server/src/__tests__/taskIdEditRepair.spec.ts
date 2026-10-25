import {afterEach, describe, expect, it} from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {fileURLToPath} from "node:url";
import {pooledSpawn} from "./helpers/serverPool.js";
import {TSX_NODE_ARGS} from "./helpers/tsxNode.js";
import {killServerGroup} from "./helpers/killServerGroup.js";

type Body = Record<string, any>;
const roots: string[] = [];
const stops: Array<() => void> = [];
const bin = fileURLToPath(new URL("../bin.ts", import.meta.url));
function workspace(): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.homedir(), ".tl-task-id-edit-")));
  roots.push(root);
  fs.mkdirSync(path.join(root, "src"), {recursive: true});
  fs.writeFileSync(path.join(root, "src/value.ts"), 'export const value = "before";\n');
  return root;
}
async function server(root: string, allowWrite: boolean) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !key.startsWith("TL_") && !key.startsWith("TOKENLIGHTEN_")));
  const child = pooledSpawn(process.execPath, [...TSX_NODE_ARGS, bin, root, ...(allowWrite ? ["--allow-write"] : [])], {
    cwd: root, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"],
    env: {...env, TOKENLIGHTEN_CLIENT_ID: "copilot-cli", TL_EFF_TOLERANT_INPUT: "1"},
  });
  stops.push(() => killServerGroup(child));
  let buffer = "", stderr = "", sequence = 0;
  const waiters = new Map<number, (body: Body) => void>();
  child.stdout!.on("data", (data: Buffer) => {
    buffer += data.toString();
    for (;;) {
      const end = buffer.indexOf("\n");
      if (end < 0) break;
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      let message: Body;
      try { message = JSON.parse(line); } catch { continue; }
      const done = waiters.get(message.id);
      if (done) { waiters.delete(message.id); done(message); }
    }
  });
  child.stderr!.on("data", (data: Buffer) => {stderr += data.toString();});
  const rpc = (method: string, params: Body): Promise<Body> => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => {waiters.delete(id); reject(new Error(method + " timed out\n" + stderr));}, 20000);
    waiters.set(id, body => {clearTimeout(timer); resolve(body);});
    child.stdin!.write(JSON.stringify({jsonrpc: "2.0", id, method, params}) + "\n");
  });
  await rpc("initialize", {protocolVersion: "2024-11-05", capabilities: {}, clientInfo: {name: "vitest", version: "0"}});
  child.stdin!.write(JSON.stringify({jsonrpc: "2.0", method: "notifications/initialized"}) + "\n");
  const invoke = async (name: string, args: Body): Promise<Body> => {
    const response = await rpc("tools/call", {name, arguments: {cwd: root, ...args}});
    return JSON.parse(response.result.content[0].text);
  };
  return invoke;
}
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  for (const root of roots.splice(0)) fs.rmSync(root, {recursive: true, force: true});
});

describe("authenticated task.id repair for tl_edit_file", () => {
  it("matches the canonical edit for the recorded task.id + task.handle=file + padded replace + match call", async () => {
    const run = async (legacyShape: boolean, mutateSource = false) => {
      const root = workspace(), call = await server(root, true);
      const request = "Change value in src/value.ts from before to after.";
      const first = await call("tl_read_file", {query: request, task: {epoch: "new", profile: "generic"}});
      const source = first.evidence.find((row: Body) => row.path === "src/value.ts" && typeof row.handle === "string");
      expect(typeof first.task?.id).toBe("string");
      expect(source?.body).toContain('value = "before"');
      if (mutateSource) fs.writeFileSync(path.join(root, "src/value.ts"), 'export const value = "concurrent";\n');
      const item = legacyShape
        ? {handle: source.handle, search: 'value = "before"', "\treplace": 'value = "after"', match: "unique-match"}
        : {handle: source.handle, search: 'value = "before"', replace: 'value = "after"', precondition: "unique-match"};
      const originalItem = structuredClone(item);
      const task = legacyShape
        ? {id: first.task.id, handle: source.handle, profile: "generic"}
        : {handle: first.task.id, profile: "generic"};
      const edit = await call("tl_edit_file", {task, edits: [item]});
      const sourceAfter = fs.readFileSync(path.join(root, "src/value.ts"), "utf8");
      if (mutateSource) {
        expect(edit.kind, JSON.stringify(edit)).not.toBe("edit.applied");
        expect(sourceAfter).toBe('export const value = "concurrent";\n');
      } else {
        expect(edit.kind, JSON.stringify(edit)).toBe("edit.applied");
        expect(sourceAfter).toBe('export const value = "after";\n');
      }
      expect(item).toEqual(originalItem);
      return {
        kind: edit.kind,
        code: edit.code,
        field: edit.field,
        detail: edit.detail,
        applied: Array.isArray(edit.applied) ? edit.applied.map((entry: Body) => ({path: entry.path, range: entry.range, slice_sha: entry.slice_sha})) : undefined,
        sourceAfter,
      };
    };
    expect(await run(true)).toEqual(await run(false));
    expect(await run(true, true)).toEqual(await run(false, true));
  }, 60000);

  it("does not let a different valid task, stale CAS, unserved path, unknown keys, or a read-only server pass through repair", async () => {
    for (const mode of ["different-task", "stale-cas", "unserved", "unknown-task-key", "unknown-item-key", "readonly-capability"] as const) {
      const root = workspace(), call = await server(root, mode !== "readonly-capability");
      const request = "Change value in src/value.ts from before to after.";
      const first = await call("tl_read_file", {query: request, task: {epoch: "new", profile: "generic"}});
      const source = first.evidence.find((row: Body) => row.path === "src/value.ts" && typeof row.handle === "string");
      let task: Body = {id: first.task.id, handle: source.handle, profile: "generic"};
      let item: Body = {handle: source.handle, search: 'value = "before"', replace: 'value = "after"', match: "unique-match"};
      if (mode === "different-task") {
        const other = await call("tl_read_file", {query: "Inspect a second task in src/value.ts.", task: {epoch: "new", profile: "generic"}});
        task = {id: other.task.id, handle: first.task.id, profile: "generic"};
      } else if (mode === "stale-cas") {
        task.expected_state_version = 0;
      } else if (mode === "unserved") {
        fs.writeFileSync(path.join(root, "src/unserved.ts"), 'export const fresh = "before";\n');
        task = {id: first.task.id, profile: "generic"};
        item = {path: "src/unserved.ts", search: 'fresh = "before"', replace: 'fresh = "after"', match: "unique-match"};
      } else if (mode === "unknown-task-key") {
        task.typo = true;
      } else if (mode === "unknown-item-key") {
        item.extra = true;
      }
      const edit = await call("tl_edit_file", {task, edits: [item]});
      expect(edit.kind, mode + ": " + JSON.stringify(edit)).not.toBe("edit.applied");
      if (mode === "unserved") expect(edit.code).toBe("execution-typestate");
      if (mode === "stale-cas") {
        expect(edit.code).toBe("invalid-input");
        expect(edit.field).toBe("expected_state_version");
        expect(edit.detail).toContain("task state is at version");
      }
      if (mode === "unknown-task-key") expect(edit.field).toBe("task.id");
      if (mode === "unknown-item-key") expect(edit.field).toBe("edits[0].extra");
      if (mode === "unserved") expect(fs.readFileSync(path.join(root, "src/unserved.ts"), "utf8")).toBe('export const fresh = "before";\n');
      expect(fs.readFileSync(path.join(root, "src/value.ts"), "utf8")).toBe('export const value = "before";\n');
    }
  }, 60000);

  it("abstains on an unaliased answer-profile id; task.profile stays a discovery hint", async () => {
    const root = workspace(), call = await server(root, true);
    const first = await call("tl_read_file", {query: "Change value in src/value.ts from before to after.", task: {epoch: "new", profile: "answer"}});
    const source = first.evidence.find((row: Body) => row.path === "src/value.ts" && typeof row.handle === "string");
    const edit = await call("tl_edit_file", {task: {id: first.task.id, handle: source.handle, profile: "answer"}, edits: [{
      handle: source.handle, search: 'value = "before"', replace: 'value = "after"', match: "unique-match",
    }]});
    expect(edit.kind).toBe("refusal");
    expect(edit.code).toBe("unknown-arguments");
    expect(edit.field).toBe("task.id");
    expect(fs.readFileSync(path.join(root, "src/value.ts"), "utf8")).toBe('export const value = "before";\n');
  }, 60000);

});
