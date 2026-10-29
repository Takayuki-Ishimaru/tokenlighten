import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ensureRuntimeDirectory, loadOrBuildSourceIndex } from "@tokenlighten/skeleton-engine";
import { WorkspaceStateStore } from "../state/stateStore.js";
import { ensureInit } from "../write/shadowGit.js";
import { callTool } from "../server.js";
import { resetAll } from "../state/session.js";

const roots: string[] = [];
function workspace(): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.homedir(), ".tl-eval1028-")));
  roots.push(root);
  return root;
}
afterEach(() => {
  resetAll();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("2026-10-28 evaluation runtime regressions", () => {
  it("keeps state, the source index and the nested checkpoint repository out of git status", async () => {
    const root = workspace();
    execFileSync("git", ["init", "--quiet", root]);
    fs.writeFileSync(path.join(root, "entry.ts"), "export const count = 1;\n");
    expect(WorkspaceStateStore.open(root).available).toBe(true);
    await loadOrBuildSourceIndex(root, { ignoreHash: "evaluation1028" });
    expect(ensureInit(root)).toBe(true);
    const status = execFileSync("git", ["-C", root, "status", "--porcelain", "--untracked-files=all"], { encoding: "utf8" });
    expect(status).toContain("entry.ts");
    expect(status).not.toContain(".tokenlighten");
    expect(fs.readFileSync(path.join(root, ".tokenlighten/.gitignore"), "utf8")).toContain("\n*\n");
  });

  it("preserves an existing runtime ignore file and never creates a missing workspace", () => {
    const root = workspace();
    fs.mkdirSync(path.join(root, ".tokenlighten"));
    const ignore = path.join(root, ".tokenlighten/.gitignore");
    fs.writeFileSync(ignore, "*\n!shared-config.json\n");
    ensureRuntimeDirectory(root);
    expect(fs.readFileSync(ignore, "utf8")).toBe("*\n!shared-config.json\n");
    const missing = path.join(root, "missing");
    expect(() => ensureRuntimeDirectory(missing)).toThrow();
    expect(fs.existsSync(missing)).toBe(false);
  });

  it("marks the small overlap as prior when a narrow read is widened in the same task", async () => {
    const root = workspace();
    fs.writeFileSync(path.join(root, "values.ts"), Array.from({ length: 80 }, (_, i) => `export const v${i + 1} = ${i + 1};`).join("\n") + "\n");
    const read = async (range: string) => {
      const result = await callTool("tl_read_file", { cwd: root, lane: "overlap", targets: [{ path: "values.ts", range }] });
      return JSON.parse(result.content[0]!.text);
    };
    const first = await read("15-20");
    expect(first.kind).toBe("read.text");
    const widened = await read("10-25");
    expect(widened.kind).toBe("read.text");
    expect(widened.evidence).toEqual(expect.arrayContaining([expect.objectContaining({ range: "15-20", prior: expect.any(String) })]));
    const source = widened.evidence.filter((row: { body?: string }) => typeof row.body === "string").map((row: { body: string }) => row.body).join("\n");
    expect(source).toContain("export const v10 = 10;");
    expect(source).toContain("export const v25 = 25;");
    expect(source).not.toContain("export const v15 = 15;");
  });
});
