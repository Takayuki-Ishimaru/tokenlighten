import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { pooledSpawn } from "./helpers/serverPool.js";
import { TSX_NODE_ARGS } from "./helpers/tsxNode.js";
import { killServerGroup } from "./helpers/killServerGroup.js";

type Body = Record<string, any>;
const roots: string[] = [];
const stops: Array<() => void> = [];
const bin = fileURLToPath(new URL("../bin.ts", import.meta.url));

function workspace(files: Record<string, string>): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.homedir(), ".tl-roundtrip-")));
  roots.push(root);
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), text);
  }
  return root;
}

async function server(root: string, overrides: Record<string, string> = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !key.startsWith("TL_") && !key.startsWith("TOKENLIGHTEN_")));
  const child = pooledSpawn(process.execPath, [...TSX_NODE_ARGS, bin, root, "--allow-write"], {
    cwd: root, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"],
    env: { ...env, ...overrides },
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
  child.stderr!.on("data", (data: Buffer) => { stderr += data.toString(); });
  const rpc = (method: string, params: Body): Promise<Body> => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => {
      waiters.delete(id); reject(new Error(method + " timed out\n" + stderr));
    }, 15000);
    waiters.set(id, body => { clearTimeout(timer); resolve(body); });
    child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "vitest", version: "0" } });
  child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  return async (name: string, args: Body): Promise<Body> => {
    const response = await rpc("tools/call", { name, arguments: { cwd: root, ...args } });
    return JSON.parse(response.result.content[0].text);
  };
}

function bodies(reply: Body): string {
  return (reply.evidence ?? []).map((entry: Body) => entry.body ?? "").join("\n");
}
const lines = Array.from({ length: 120 }, (_, i) =>
  "export const VALUE_" + String(i).padStart(3, "0") + ' = "' + "x".repeat(32) + '";').join("\n") + "\n";

afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("common read/continuation/edit recovery round trips", () => {
  it("fits only the unseen overlap in one budgeted reply and retains the explicit resend escape", async () => {
    const root = workspace({ "src/values.ts": lines });
    const call = await server(root);
    const read = (range: string, extra: Body = {}) =>
      call("tl_read_file", { targets: [{ path: "src/values.ts", range }], ...extra });
    await read("1-60");
    const remainder = await read("1-120", { budget: { bytes: 6500 } });
    expect(remainder.kind).toBe("read.text");
    expect(bodies(remainder)).toContain("VALUE_060");
    expect(bodies(remainder)).toContain("VALUE_119");
    expect(bodies(remainder)).not.toContain("VALUE_000");
    expect(remainder.evidence.some((entry: Body) => typeof entry.prior === "string")).toBe(true);
    expect(remainder.limit).toBeUndefined();
    expect(Buffer.byteLength(JSON.stringify(remainder))).toBeLessThanOrEqual(6500);
    const resend = await read("1-120", { task: { force_serve: true }, budget: { bytes: 6500 } });
    expect(bodies(resend)).toContain("VALUE_000");
    expect(resend.limit?.next).toBeDefined();
  }, 30000);


  it("preserves every unseen line when an overlapping request still needs cursor pages", async () => {
    const source = Array.from({ length: 300 }, (_, i) =>
      "export const ITEM_" + String(i).padStart(3, "0") + ' = "' + "x".repeat(32) + '";').join("\n") + "\n";
    const root = workspace({ "src/values.ts": source });
    const call = await server(root);
    await call("tl_read_file", { targets: [{ path: "src/values.ts", range: "1-60" }] });
    let reply = await call("tl_read_file", { targets: [{ path: "src/values.ts", range: "1-300" }], budget: { bytes: 6500 } });
    const seen = new Set<number>();
    for (let page = 0; ; page++) {
      expect(page).toBeLessThan(10);
      expect(reply.kind).not.toBe("refusal");
      expect(Buffer.byteLength(JSON.stringify(reply))).toBeLessThanOrEqual(6500);
      for (const hit of bodies(reply).matchAll(/ITEM_(\d+)/g)) seen.add(Number(hit[1]));
      const next = reply.limit?.next;
      if (next === undefined) break;
      reply = await call(next.tool, next.arguments);
    }
    for (let line = 60; line < 300; line++) expect(seen.has(line), "missing ITEM_" + line).toBe(true);
  }, 30000);

  it("never uses coverage from another lane or from an older file hash", async () => {
    const root = workspace({ "src/values.ts": lines });
    const call = await server(root);
    await call("tl_read_file", { lane: "a", targets: [{ path: "src/values.ts", range: "1-60" }] });
    const other = await call("tl_read_file", { lane: "b", targets: [{ path: "src/values.ts", range: "1-120" }] });
    expect(bodies(other)).toContain("VALUE_000");
    fs.writeFileSync(path.join(root, "src/values.ts"), lines.replace("VALUE_000", "CHANGED_000"));
    const changed = await call("tl_read_file", { lane: "a", targets: [{ path: "src/values.ts", range: "1-120" }] });
    expect(bodies(changed)).toContain("CHANGED_000");
    expect(changed.evidence.every((entry: Body) => entry.prior === undefined)).toBe(true);
  }, 30000);

  it("serves previously elided comments when the overlap request keeps comments", async () => {
    const source = lines.split("\n");
    source.splice(60, 0, "/**", " * UNSEEN_DOCUMENTATION_CONTENT", " */");
    const root = workspace({ "src/values.ts": source.join("\n") });
    const call = await server(root);
    const first = await call("tl_read_file", { targets: [{ path: "src/values.ts", range: "1-90" }] });
    expect(bodies(first)).not.toContain("UNSEEN_DOCUMENTATION_CONTENT");
    const kept = await call("tl_read_file", {
      targets: [{ path: "src/values.ts", range: "1-123" }], select: { comments: "keep" },
    });
    expect(bodies(kept)).toContain("UNSEEN_DOCUMENTATION_CONTENT");
    expect(bodies(kept)).toContain("VALUE_119");
  }, 30000);

  it("recovers the observed 82-character-prefix ellipsis on reads/searches without a refusal turn", async () => {
    const root = workspace({ "src/shared.ts": "export const Shared = { value: 1 };\n" });
    const call = await server(root);
    const first = await call("tl_read_file", { lane: "same", query: "Explain src/shared.ts", task: { epoch: "new" } });
    const handle = first.task.id as string;
    const abbreviated = handle.slice(0, 82) + "...";
    const found = await call("tl_search_files", {
      lane: "same", action: "find", queries: ["Shared"], task: { handle: abbreviated },
    });
    expect(found.kind).not.toBe("refusal");
    const read = await call("tl_read_file", {
      lane: "same", targets: [{ path: "src/shared.ts" }], task: { handle: abbreviated, force_serve: true },
    });
    expect(read.kind).not.toBe("refusal");
    expect(bodies(read)).toContain("Shared");
  }, 30000);

  it("preserves strict edit authentication, CAS, lane boundaries and short-abbreviation refusals", async () => {
    const original = "export const Shared = { value: 1 };\n";
    const root = workspace({ "src/shared.ts": original });
    const call = await server(root);
    const first = await call("tl_read_file", { lane: "same", query: "Explain src/shared.ts", task: { epoch: "new" } });
    const handle = first.task.id as string, abbreviated = handle.slice(0, 82) + "...";
    for (const args of [
      { lane: "other", task: { handle: abbreviated } },
      { lane: "same", task: { handle: handle.slice(0, 24) + "..." + handle.slice(-5) } },
      { lane: "same", task: { handle: abbreviated, expected_state_version: 999 } },
    ]) {
      const refused = await call("tl_read_file", { targets: [{ path: "src/shared.ts" }], ...args });
      expect(refused.kind).toBe("refusal");
    }
    const refusedEdit = await call("tl_edit_file", {
      lane: "same", task: { handle: abbreviated },
      edits: [{ path: "src/shared.ts", search: "value: 1", replace: "value: 2" }],
    });
    expect(refusedEdit.kind).toBe("refusal");
    expect(fs.readFileSync(path.join(root, "src/shared.ts"), "utf8")).toBe(original);
  }, 30000);

  it("retains the explicit read-recovery rollback switch", async () => {
    const root = workspace({ "src/shared.ts": "export const Shared = { value: 1 };\n" });
    const call = await server(root, { TL_TASK_HANDLE_RECOVERY: "0" });
    const first = await call("tl_read_file", { query: "Explain src/shared.ts", task: { epoch: "new" } });
    const handle = first.task.id as string;
    const refused = await call("tl_search_files", {
      action: "find", queries: ["Shared"], task: { handle: handle.slice(0, 82) + "..." },
    });
    expect(refused.kind).toBe("refusal");
    expect(refused.did_you_mean).toBe(handle);
  }, 30000);


  it("preserves an unseen trailing blank line in an overlapping window", async () => {
    const source = lines.split("\n");
    source.splice(60, 0, "");
    const root = workspace({ "src/values.ts": source.join("\n") });
    const call = await server(root);
    await call("tl_read_file", { targets: [{ path: "src/values.ts", range: "1-60" }] });
    const reply = await call("tl_read_file", { targets: [{ path: "src/values.ts", range: "1-61" }] });
    expect(reply.kind).toBe("read.text");
    expect(reply.evidence.some((entry: Body) => entry.range === "61-61"
      && Object.hasOwn(entry, "body") && entry.body === "")).toBe(true);
    expect(bodies(reply)).not.toContain("VALUE_000");
  }, 30000);

  it("retains a read recovery when the edit diagnostic was truncated", async () => {
    const original = "export function value() {\n" + '  const text = "' + "x".repeat(1400) + '";\n  return 1;\n}\n';
    const root = workspace({ "src/b.ts": original });
    const call = await server(root);
    await call("tl_read_file", { targets: [{ path: "src/b.ts", range: "1-4" }] });
    const failed = await call("tl_edit_file", { edits: [{
      path: "src/b.ts", search: original.replace("return 1;", "return 99;"),
      replace: original.replace("return 1;", "return 3;"), precondition: "unique-match", allowPathFallback: false,
    }] });
    expect(failed.kind).toBe("refusal");
    expect(failed.failed_item.index).toBe(0);
    expect(failed.next?.tool).toBe("tl_read_file");
    expect(fs.readFileSync(path.join(root, "src/b.ts"), "utf8")).toBe(original);
  }, 30000);

  it("keeps current edit evidence and the failed index so one corrected batch retry needs no read", async () => {
    const a = "export const A = 1;\n";
    const b = "export function value() {\n  return 1;\n}\n";
    const root = workspace({ "src/a.ts": a, "src/b.ts": b });
    const call = await server(root);
    await call("tl_read_file", { targets: [{ path: "src/a.ts", range: "1-1" }, { path: "src/b.ts", range: "1-3" }] });
    const editA = { path: "src/a.ts", search: "A = 1", replace: "A = 2", precondition: "unique-match", allowPathFallback: false };
    const failed = await call("tl_edit_file", { edits: [
      editA, { path: "src/b.ts", search: "export function value() {\n  return 99;\n}", replace: "export function value() {\n  return 3;\n}", precondition: "unique-match", allowPathFallback: false },
    ] });
    expect(failed.kind).toBe("refusal");
    expect(failed.code).toBe("search-not-unique");
    expect(failed.failed_item.index).toBe(1);
    expect(failed.nearest_match.code).toContain("return 1;");
    expect(failed.next).toBeUndefined();
    expect(fs.readFileSync(path.join(root, "src/a.ts"), "utf8")).toBe(a);
    expect(fs.readFileSync(path.join(root, "src/b.ts"), "utf8")).toBe(b);
    const current = failed.nearest_match.code as string;
    const retried = await call("tl_edit_file", { edits: [
      editA, { path: "src/b.ts", search: current, replace: current.replace("return 1;", "return 3;"), precondition: "unique-match", allowPathFallback: false },
    ] });
    expect(retried.kind).toBe("edit.applied");
    expect(fs.readFileSync(path.join(root, "src/a.ts"), "utf8")).toContain("A = 2");
    expect(fs.readFileSync(path.join(root, "src/b.ts"), "utf8")).toContain("return 3;");
  }, 30000);
});
