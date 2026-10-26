import { afterAll, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { startDevServer, type ServerHandle } from "./helpers/qualityFirstScenarios.js";
import { rmDirWithRetry } from "./helpers/rmDirWithRetry.js";

const dirs: string[] = [];
const servers: ServerHandle[] = [];
afterAll(async () => {
  for (const server of servers) await server.kill();
  for (const dir of dirs) await rmDirWithRetry(dir);
});
async function setup(eol = "\n", text?: string) {
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tl-path-range-")));
  dirs.push(ws);
  const original = text ?? ["const a = 1;", "const b = 2;", "const c = 3;", ""].join(eol);
  fs.writeFileSync(path.join(ws, "lines.ts"), original);
  fs.writeFileSync(path.join(ws, "other.ts"), "export const other = 1;\n");
  const server = startDevServer(ws, "default", { allowWrite: true, extraEnv: { TL_LEGACY_INPUT: "accept" } });
  servers.push(server);
  await server.initialize();
  const read = (await server.callTool("tl_read_file", { cwd: ws, targets: [{ path: "lines.ts" }], content: "full" })).body as any;
  const handle = read.evidence?.[0]?.handle ?? read.entries?.[0]?.handle ?? read.handle;
  expect(handle, JSON.stringify(read)).toBeTypeOf("string");
  await server.callTool("tl_read_file", { cwd: ws, targets: [{ path: "other.ts" }], content: "full" });
  return { ws, server, original, handle: handle as string, disk: () => fs.readFileSync(path.join(ws, "lines.ts"), "utf8") };
}
function envelope(form: string, item: Record<string, unknown>) {
  return form === "top-level" ? item : { edits: form === "single" ? [item] : [
    { path: "other.ts", search: "other = 1", replace: "other = 2", precondition: "unique-match" }, item,
  ] };
}
const cases = ["path", "handle"].flatMap((address) =>
  ["top-level", "single", "multi"].flatMap((form) =>
    ["content", "search"].flatMap((operation) =>
      ["\n", "\r\n", "\r"].map((eol) => ({ address, form, operation, eol, label: JSON.stringify(eol) })))));
describe("TL-REVIEW-01 explicit path ranges", () => {
  it.each(cases)("$address $form $operation $label keeps every byte outside line 2", async ({ address, form, operation, eol }) => {
    const f = await setup(eol);
    const target = address === "path" ? { path: "lines.ts" } : { handle: f.handle };
    const item = { ...target, range: "2-2", ...(operation === "content"
      ? { content: "const b = 20;" }
      : { search: "const b = 2;", replace: "const b = 20;", precondition: "unique-match" }) };
    const result = (await f.server.callTool("tl_edit_file", { cwd: f.ws, ...envelope(form, item) })).body as any;
    if (form === "top-level") {
      // range is deliberately not an advertised top-level field.
      expect(result.kind, JSON.stringify(result)).toBe("refusal");
      expect(f.disk()).toBe(f.original);
      return;
    }
    expect(result.kind, JSON.stringify(result)).toBe("edit.applied");
    expect(f.disk()).toBe(["const a = 1;", "const b = 20;", "const c = 3;", ""].join(eol));
  }, 15_000);

  it("preserves the report's exact one-item edits[] call shape with a final newline", async () => {
    const f = await setup();
    const result = (await f.server.callTool("tl_edit_file", { cwd: f.ws, edits: [{ path: "lines.ts", range: "2-2", content: "const b = 20;\n" }] })).body as any;
    expect(result.kind, JSON.stringify(result)).toBe("edit.applied");
    expect(f.disk()).toBe("const a = 1;\nconst b = 20;\nconst c = 3;\n");
  });

  it.each(["path", "handle"].flatMap((address) => ["single", "multi"].map((form) => ({ address, form }))))("refuses an off-range search with $address $form and leaves the entire batch unchanged", async ({ address, form }) => {
    const f = await setup();
    const target = address === "path" ? { path: "lines.ts" } : { handle: f.handle };
    const result = (await f.server.callTool("tl_edit_file", { cwd: f.ws, ...envelope(form, {
      ...target, range: "2-2", search: "const a = 1;", replace: "const a = 99;", precondition: "unique-match",
    }) })).body as any;
    expect(result.kind, JSON.stringify(result)).toBe("refusal");
    expect(f.disk()).toBe(f.original);
    expect(fs.readFileSync(path.join(f.ws, "other.ts"), "utf8")).toBe("export const other = 1;\n");
  });

  it.each(["path", "handle"].flatMap((address) => ["", "nonsense", "0-2", "3-2", "4-4", "1-99"].map((range) => ({ address, range }))))("refuses an unsafe explicit $address range $range without whole-file fallback", async ({ address, range }) => {
    const f = await setup();
    const target = address === "path" ? { path: "lines.ts" } : { handle: f.handle };
    const result = (await f.server.callTool("tl_edit_file", { cwd: f.ws, ...envelope("multi", { ...target, range, content: "bad\n" }) })).body as any;
    expect(result.kind, JSON.stringify(result)).toBe("refusal");
    expect(f.disk()).toBe(f.original);
    expect(fs.readFileSync(path.join(f.ws, "other.ts"), "utf8")).toBe("export const other = 1;\n");
  });

  it("checks expected-hash before a path/range content batch item", async () => {
    const f = await setup();
    const result = (await f.server.callTool("tl_edit_file", { cwd: f.ws, ...envelope("multi", {
      path: "lines.ts", range: "2-2", content: "const b = 20;\n", precondition: "expected-hash", expectedSha: "sha256:000000000000",
    }) })).body as any;
    expect(result.kind, JSON.stringify(result)).toBe("refusal");
    expect(f.disk()).toBe(f.original);
    expect(fs.readFileSync(path.join(f.ws, "other.ts"), "utf8")).toBe("export const other = 1;\n");
  });

  it("still replaces the entire file when the caller omits range", async () => {
    const f = await setup();
    const result = (await f.server.callTool("tl_edit_file", { cwd: f.ws, edits: [{ path: "lines.ts", content: "export const whole = true;\n" }] })).body as any;
    expect(result.kind, JSON.stringify(result)).toBe("edit.applied");
    expect(f.disk()).toBe("export const whole = true;\n");
  });
});
