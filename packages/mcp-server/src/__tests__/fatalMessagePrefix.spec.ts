/**
 * fatalMessagePrefix.spec.ts — regression for round-2 evaluation finding P2-17(b): a startup failure
 * printed a DOUBLED prefix, "[tl-mcp] fatal: [tl-mcp] workspace root does not exist or is not a
 * directory: <path>", because `assertActiveRootExists` (server.ts) baked its own "[tl-mcp] " tag into the
 * thrown Error's message on top of the "[tl-mcp] fatal: " that bin.ts's catch-all already writes.
 *
 * Spawns the real stdio entry point (same technique as bogusWorkspaceRoot.spec.ts) rather than importing
 * server.ts's internals, since the bug is in how two separately-written strings compose on the wire.
 */
import { afterEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { killServerGroup } from "./helpers/killServerGroup.js";
import { TSX_NODE_ARGS } from "./helpers/tsxNode.js";

const HOME = process.env["HOME"] ?? process.env["USERPROFILE"] ?? os.homedir();
const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN_TS = path.resolve(HERE, "..", "bin.ts");

const tmpDirs: string[] = [];

function mkDir(tag: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(HOME, `.tl-fmp-${tag}-`)));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

describe("startup fatal message — no doubled [tl-mcp] prefix", () => {
  it("a nonexistent workspace root prints the tag exactly once", async () => {
    const launchDir = mkDir("launch");
    const bogusRelativeArg = "totally-bogus-workspace-name";

    const child: ChildProcess = spawn(
      process.execPath,
      [...TSX_NODE_ARGS, BIN_TS, bogusRelativeArg],
      { cwd: launchDir, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32" },
    );
    let stderr = "";
    child.stderr!.on("data", (d: Buffer) => { stderr += d.toString(); });

    const exitCode = await new Promise<number | null>((resolve) => {
      const timer = setTimeout(() => { killServerGroup(child); resolve(null); }, 15000);
      child.on("exit", (code) => { clearTimeout(timer); resolve(code); });
    });

    expect(exitCode, `expected a non-zero exit; stderr:\n${stderr}`).not.toBe(0);
    expect(stderr).not.toContain("fatal: [tl-mcp]");
    expect(stderr).toContain("[tl-mcp] fatal: workspace root does not exist");
    // Exactly one occurrence of the "[tl-mcp]" tag on the whole fatal line — the doubled-prefix bug
    // produced two.
    const fatalLine = stderr.split("\n").find((line) => line.includes("fatal:"));
    expect(fatalLine, `no fatal line found in stderr:\n${stderr}`).toBeDefined();
    expect(fatalLine!.split("[tl-mcp]").length - 1).toBe(1);
  }, 20000);
});
