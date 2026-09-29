/**
 * evaluation0927.closurePromotionBudget.spec.ts — round 4's whole-file
 * promotion of a closure window (P2-12) must never cost a REQUIRED window its
 * place in the same response (orchestrator review, 2026-09-28).
 *
 * The promotion shipped a small file whole whenever it fit the remaining
 * budget: a 4 KB config module for the one line the question needed, and a
 * module promoted first could leave no room for another file's required
 * window (a second hop the narrow windows never needed). A closure window
 * now ships at its own size; a second window of the same file widens the
 * first to their union, and the focal's own lines are served when the pack
 * did not select them — which is what V01 needed.
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

function writeFile(ws: string, rel: string, content: string): void {
  const abs = path.join(ws, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
}

/** A module of about `bytes` bytes whose line 2 declares `name` (a long line), then unrelated documented settings. */
function moduleWith(name: string, value: string, bytes: number): string {
  const lines = ["// Settings module.", `export const ${name} = ${value}; // the value the operations runbook documents for this setting, reviewed each quarter by the platform team`, ""];
  for (let i = 0; lines.join("\n").length < bytes - 90; i++) {
    lines.push(`export const ${name}_NOTE_${i} = "note ${i}, documented in the operations runbook for this setting";`);
  }
  return [...lines, ""].join("\n");
}

function workspace(configBytes: number, limitsBytes: number): string {
  const ws = fs.realpathSync(shortTmpDir(HOME, ".tl-promo-"));
  tmpDirs.push(ws);
  writeFile(ws, "package.json", "{\"name\":\"promo\",\"private\":true,\"type\":\"module\"}\n");
  writeFile(ws, "src/config.ts", moduleWith("DEFAULT_TIMEOUT_MS", "7250", configBytes));
  writeFile(ws, "src/limits.ts", moduleWith("RETRY_LIMIT", "4", limitsBytes));
  writeFile(ws, "src/options.ts", [
    "import { DEFAULT_TIMEOUT_MS } from \"./config\";",
    "import { RETRY_LIMIT } from \"./limits\";",
    "",
    "export function loadOptions(): { timeoutMs: number; retries: number } {",
    "  return { timeoutMs: DEFAULT_TIMEOUT_MS, retries: RETRY_LIMIT };",
    "}",
    "",
  ].join("\n"));
  return ws;
}

async function firstPack(ws: string): Promise<any> {
  const s = startDevServer(ws, "default");
  servers.push(s);
  await s.initialize();
  return (await s.callTool("read_file", {
    query: "What default values does loadOptions use?",
    cwd: ws,
    task: { epoch: "new", profile: "answer" },
  })).body;
}

function servedRows(body: any): Array<{ path: string; range: string; body: string }> {
  return (body.evidence ?? []).filter((e: any) => typeof e.body === "string");
}

describe("closure windows keep their own size; a promotion never crowds out a required window", () => {
  it("a constant in a large config module ships as its own window, not the whole file", async () => {
    const ws = workspace(3900, 300);
    const rows = servedRows(await firstPack(ws));
    const label = JSON.stringify(rows.map((row) => `${row.path}:${row.range}`));
    const served = rows.map((row) => row.body).join("\n");
    expect(served, label).toContain("DEFAULT_TIMEOUT_MS = 7250");
    expect(served, label).toContain("RETRY_LIMIT = 4");
    const config = rows.find((row) => row.path === "src/config.ts");
    expect(config, label).toBeDefined();
    expect(config!.body.split("\n").length, label).toBeLessThanOrEqual(3);
  });

  it("with two modules that each nearly fill the budget, both constants are served in the first response", async () => {
    const ws = workspace(4030, 4030);
    for (const file of ["src/config.ts", "src/limits.ts"]) {
      const size = fs.statSync(path.join(ws, file)).size;
      expect(size).toBeGreaterThan(3950);
      expect(size).toBeLessThan(4096);
    }
    const rows = servedRows(await firstPack(ws));
    const label = JSON.stringify(rows.map((row) => `${row.path}:${row.range}`));
    const served = rows.map((row) => row.body).join("\n");
    expect(served, label).toContain("DEFAULT_TIMEOUT_MS = 7250");
    expect(served, label).toContain("RETRY_LIMIT = 4");
  });
});
