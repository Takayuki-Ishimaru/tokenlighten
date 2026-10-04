/**
 * evaluation0927.qualifiedConstant.spec.ts — a constant read through another
 * type's name (`Config.API_BASE`) is served or disclosed, never ignored
 * (orchestrator, round 6; the reviewer's csInterpolatedConst was certified
 * `act.answer` with `src/Config.cs` never served and no gap — policy P3).
 * An unresolved constant's disclosure never asserts absence (policy P1).
 */
import { afterAll, afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { shortTmpDir } from "./helpers/shortTmpDir.js";
import { rmDirWithRetry } from "./helpers/rmDirWithRetry.js";
import { startDevServer, type ServerHandle } from "./helpers/qualityFirstScenarios.js";

const HOME = process.env["HOME"] ?? process.env["USERPROFILE"] ?? os.homedir();
const tmpDirs: string[] = [];
const servers: ServerHandle[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.kill();
});
afterAll(async () => {
  for (const server of servers.splice(0)) await server.kill();
  for (const dir of tmpDirs.splice(0)) {
    try {
      await rmDirWithRetry(dir);
    } catch {
      /* best-effort cleanup */
    }
  }
});

function workspace(files: Record<string, string>): string {
  const ws = fs.realpathSync(shortTmpDir(HOME, ".tl-qualconst-"));
  tmpDirs.push(ws);
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(ws, rel)), { recursive: true });
    fs.writeFileSync(path.join(ws, rel), content, "utf8");
  }
  return ws;
}

async function ask(ws: string, query: string): Promise<any> {
  const s = startDevServer(ws, "default");
  servers.push(s);
  await s.initialize();
  return (await s.callTool("tl_read_file", { query, cwd: ws, task: { epoch: "new", profile: "answer" } })).body;
}

function served(body: any): string {
  return (body.evidence ?? []).filter((e: any) => typeof e.body === "string").map((e: any) => e.body as string).join("\n");
}

describe("qualified constants (`Owner.CONSTANT`)", () => {
  it("C#: `Config.API_BASE` inside an interpolated string is served from Config.cs", async () => {
    const ws = workspace({
      "src/Config.cs": "namespace App;\n\npublic static class Config\n{\n    public const string API_BASE = \"https://api.example.test/v3\";\n}\n",
      "src/Users.cs": "namespace App;\n\npublic static class Users\n{\n    public static string ProfileUrl(string id)\n    {\n        var attempt = 0;\n        return $\"{Config.API_BASE}/users/{id}?attempt={attempt}\";\n    }\n}\n",
    });
    const body = await ask(ws, "What base URL does ProfileUrl use by default?");
    expect(served(body), JSON.stringify(body.decision)).toContain("https://api.example.test/v3");
  });

  it("an owner the workspace does not declare: disclosed as unresolved, never as absent", async () => {
    const ws = workspace({
      "src/users.ts": "export function profileUrl(id: string): string {\n  const attempt = 0;\n  return `${Vendor.API_BASE}/users/${id}?attempt=${attempt}`;\n}\n",
    });
    const body = await ask(ws, "What base URL does profileUrl use by default?");
    const text = JSON.stringify(body.decision);
    expect(body.decision?.kind === "act.answer" ? text : "undetermined-or-open", text).not.toMatch(/"covered"/);
    if (body.decision?.kind === "act.answer") {
      expect(text).toContain("request-item-undetermined");
      expect(text).toContain("Vendor.API_BASE");
      expect(text).not.toContain("no declaration was found");
    }
  });

  it("a language constant (`Math.PI`) is not treated as an unresolved workspace value", async () => {
    const ws = workspace({
      "src/circle.ts": "export const DEFAULT_RADIUS = 2;\n\nexport function defaultArea(): number {\n  return Math.PI * DEFAULT_RADIUS * DEFAULT_RADIUS;\n}\n",
    });
    const body = await ask(ws, "What is the default area defaultArea computes?");
    expect(JSON.stringify(body.decision)).not.toContain("Math.PI");
  });
});
