import { afterAll, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { explicitEditConstraintPaths } from "../state/explicitEditConstraints.js";
import { clearTaskQueryRef, guardExecutionEdit, rememberTaskQuery, resetWorkspace } from "../state/session.js";
import { startDevServer, type ServerHandle } from "./helpers/qualityFirstScenarios.js";
import { rmDirWithRetry } from "./helpers/rmDirWithRetry.js";

const protectedPaths = ["src/a.ts", "src/b.ts", "src/c.ts"];
const lists = [
  "Do not modify src/a.ts, src/b.ts.",
  "src/a.ts、src/b.tsは変更しないでください。",
  "Do not modify src/a.ts, src/b.ts, and src/c.ts.",
  "Do not modify src/a.ts or src/b.ts or src/c.ts.",
  "src/a.ts、src/b.tsとsrc/c.tsは変更しないでください。",
  "Do not modify src/a.ts、src/b.ts and src/c.ts.",
];
const WS = "/virtual/prohibition-lists";

describe("enumerated explicit edit constraints", () => {
  beforeEach(() => resetWorkspace(WS));
  it.each(lists)("protects every list member in %s", (query) => {
    const expected = query.includes("src/c.ts") ? protectedPaths : protectedPaths.slice(0, 2);
    expect(explicitEditConstraintPaths(query)).toEqual(expected);
    rememberTaskQuery(WS, query);
    rememberTaskQuery(WS, "Read src/a.ts and src/b.ts only for context.");
    clearTaskQueryRef(WS);
    rememberTaskQuery(WS, query);
    for (const file of expected) {
      expect(guardExecutionEdit(WS, { path: file, content: "bad" }).allowed).toBe(false);
      expect(guardExecutionEdit(WS, { edits: [{ handle: "protected", content: "bad" }] }, () => file).allowed).toBe(false);
    }
    expect(guardExecutionEdit(WS, { path: "src/worker.ts", content: "ready" }).allowed).toBe(true);
    clearTaskQueryRef(WS);
    rememberTaskQuery(WS, "Change src/a.ts to return 99.");
    expect(guardExecutionEdit(WS, { path: "src/a.ts", content: "99" }).allowed).toBe(true);
  });

  it.each([
    ["Do not modify src/a.ts, src/b.ts, edit src/worker.ts.", ["src/a.ts", "src/b.ts"]],
    ["Do not modify src/a.ts, src/b.ts, and then read src/context.ts.", ["src/a.ts", "src/b.ts"]],
    ["Do not modify src/a.ts and src/b.ts but delete src/worker.ts.", ["src/a.ts", "src/b.ts"]],
    ["Edit src/worker.ts, do not modify src/a.ts, src/b.ts.", ["src/a.ts", "src/b.ts"]],
    ["src/worker.tsを更新し、src/a.ts、src/b.tsは変更しないでください。", ["src/a.ts", "src/b.ts"]],
    ["src/a.tsは変更しないでください、src/b.tsは変更しないでください。", ["src/a.ts", "src/b.ts"]],
    ["Do not modify src/a.ts, src/b.ts, never touch src/c.ts.", protectedPaths],
    ["Do not modify `src/a.ts`, `src/b.ts`, or `src/c.ts`.", protectedPaths],
    ["a.tsとb.tsおよびc.tsは変更しないでください。", ["a.ts", "b.ts", "c.ts"]],
    ["`src/a.tsとdir/b.ts`は変更しないでください。", ["src/a.tsとdir/b.ts"]],
    ["Do not modify src/config/, src/generated/; read src/worker.ts.", ["src/config/", "src/generated/"]],
    ['Explain "Do not modify src/a.ts, src/b.ts" in src/message.ts.', []],
    ["Write this example: ```src/a.ts、src/b.tsは変更しないでください。```", []],
    ["Read src/a.ts, src/b.ts for context, and edit src/worker.ts.", []],
  ])("separates independent instructions without splitting path lists: %s", (query, expected) => {
    expect(explicitEditConstraintPaths(query as string)).toEqual(expected);
  });
});

const dirs: string[] = [];
const servers: ServerHandle[] = [];
afterAll(async () => {
  for (const server of servers) await server.kill();
  for (const dir of dirs) await rmDirWithRetry(dir);
});

describe("enumerated prohibition MCP recovery", () => {
  it.each(lists.flatMap((query) => ["0", "1"].map((strict) => ({ query, strict }))))(
    "retains all prohibitions after context, qref and verbatim recovery, strict=$strict: $query",
    async ({ query, strict }) => {
      const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tl-prohibition-list-")));
      dirs.push(ws);
      const files: Record<string, string> = {
        "src/worker.ts": 'export function processOrder() { return "pending"; }\n',
        "src/a.ts": "export const A = 1;\n",
        "src/b.ts": "export const B = 2;\n",
        "src/c.ts": "export const C = 3;\n",
      };
      for (const [name, text] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(ws, name)), { recursive: true });
        fs.writeFileSync(path.join(ws, name), text);
      }
      const server = startDevServer(ws, "default", { allowWrite: true, extraEnv: { TL_FRONTIER_STRICT_WRITES: strict } });
      servers.push(server);
      await server.initialize();
      const original = 'Change processOrder in src/worker.ts to return "ready" instead of "pending". ' + query;
      const first = (await server.callTool("tl_read_file", { cwd: ws, query: original, task: { epoch: "new", profile: "generic" } })).body as any;
      const expected = query.includes("src/c.ts") ? protectedPaths : protectedPaths.slice(0, 2);
      const contexts = (await server.callTool("tl_read_file", {
        cwd: ws, targets: expected.map((file) => ({ path: file })), content: "full", task: { handle: first.task.id },
      })).body as any;
      const entries = contexts.entries ?? contexts.evidence ?? [];
      const unchanged = () => {
        for (const [name, text] of Object.entries(files)) expect(fs.readFileSync(path.join(ws, name), "utf8")).toBe(text);
      };
      const args = {
        cwd: ws, edits: [
          { path: "src/worker.ts", search: '"pending"', replace: '"ready"', precondition: "unique-match" },
          ...expected.map((file) => ({ path: file, search: files[file]!.trim(), replace: "bad", precondition: "unique-match" })),
        ],
      };
      const refusal = (await server.callTool("tl_edit_file", args)).body as any;
      expect(refusal.kind, JSON.stringify(refusal)).toBe("refusal");
      expect(refusal.code).toBe("frontier-read-only");
      unchanged();
      expect(refusal.next.arguments.query).toContain(original);
      await server.callTool(refusal.next.tool, refusal.next.arguments);
      for (const file of expected) {
        const row = entries.find((entry: any) => entry.path === file);
        expect(row?.handle, JSON.stringify(contexts)).toBeTypeOf("string");
        for (const target of [{ path: file }, { handle: row.handle }]) {
          const denied = (await server.callTool("tl_edit_file", {
            cwd: ws, edits: [{ ...target, search: files[file]!.trim(), replace: "bad", precondition: "unique-match" }],
          })).body as any;
          expect(denied.kind, JSON.stringify(denied)).toBe("refusal");
          expect(denied.code).toBe("frontier-read-only");
          unchanged();
        }
      }
      expect(first.qref).toBeTypeOf("string");
      await server.callTool("tl_read_file", { cwd: ws, qref: first.qref });
      const again = (await server.callTool("tl_edit_file", args)).body as any;
      expect(again.kind, JSON.stringify(again)).toBe("refusal");
      expect(again.code).toBe("frontier-read-only");
      unchanged();
      // A genuinely new explicit request is allowed to replace the old prohibition.
      await server.callTool("tl_read_file", {
        cwd: ws, query: "Change A in src/a.ts from 1 to 99.", task: { epoch: "new", profile: "generic" },
      });
      const allowed = (await server.callTool("tl_edit_file", {
        cwd: ws, edits: [{ path: "src/a.ts", search: "A = 1", replace: "A = 99", precondition: "unique-match" }],
      })).body as any;
      expect(allowed.kind, JSON.stringify(allowed)).toBe("edit.applied");
      expect(fs.readFileSync(path.join(ws, "src/a.ts"), "utf8")).toBe("export const A = 99;\n");
    }, 30_000,
  );
});
