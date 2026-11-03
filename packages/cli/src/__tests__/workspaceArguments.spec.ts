import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, symlinkSync, lstatSync, readlinkSync } from "node:fs";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runWorkspace } from "../commands/workspace.js";

function snapshot(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const entry of readdirSync(root, { withFileTypes: true, recursive: true })) {
    const file = join(entry.parentPath, entry.name);
    result[relative(root, file)] = entry.isDirectory() ? "<directory>" : readFileSync(file).toString("base64");
  }
  return result;
}

describe("workspace CLI argument contract", () => {
  let root: string;
  let output: string;
  let errors: string;
  let previousExit: typeof process.exitCode;
  let previousCwd: string;
  const versionCheck = vi.fn(() => "test");
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "tl-workspace-args-"));
    output = ""; errors = "";
    previousExit = process.exitCode;
    previousCwd = process.cwd();
    process.chdir(root);
    process.exitCode = 0;
    versionCheck.mockClear();
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => { output += String(chunk); return true; });
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => { errors += String(chunk); return true; });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = previousExit;
    process.chdir(previousCwd);
    rmSync(root, { recursive: true, force: true });
  });
  function run(args: string[]) {
    return runWorkspace(args, {
      registryPath: join(root, "registry.toml"), installHome: join(root, "install"),
      launcher: { command: "tl", argsPrefix: [], env: {} }, versionCheck,
    });
  }

  it.each([
    ["setup", "--wat"], ["setup", "/some/path"],
    ["setup", "--root"], ["setup", "--root", "--json"],
    ["setup", "--clients"], ["setup", "--guide-profile"],
    ["setup", "--tool-surface"], ["setup", "--copilot-guide"],
    ["setup", "--copilot-inline-results"], ["setup", "--copilot-session-context"],
    ["status", "--wat"], ["status", "/some/path"], ["status", "--root"],
    ["list", "--root", "/some/path"], ["list", "--wat"],
  ])("rejects malformed arguments before side effects: %j", async (...args) => {
    const before = snapshot(root);
    await run(args);
    expect(process.exitCode).toBe(1);
    expect(errors).not.toBe("");
    expect(versionCheck).not.toHaveBeenCalled();
    expect(snapshot(root)).toEqual(before);
  });

  it.each([[], ["--rules-only"], ["--no-hooks"], ["--remove-hooks"]])("dry-run preserves all files and registries: %j", async (...flags) => {
    const workspace = join(root, "workspace");
    mkdirSync(workspace);
    writeFileSync(join(workspace, "AGENTS.md"), "User instructions\n");
    const before = snapshot(root);
    await run(["setup", "--root", workspace, "--clients", "codex", "--dry-run", "--json", ...flags]);
    expect(process.exitCode).toBe(0);
    const plan = JSON.parse(output);
    expect(plan.dryRun).toBe(true);
    expect(plan.workspaceRoot).toBe(workspace);
    expect(versionCheck).not.toHaveBeenCalled();
    expect(snapshot(root)).toEqual(before);
  });

  it("validates values before dry-run", async () => {
    const workspace = join(root, "workspace"); mkdirSync(workspace);
    await run(["setup", "--root", workspace, "--dry-run", "--clients", "unknown"]);
    expect(process.exitCode).toBe(1);
    expect(snapshot(root)).toEqual({ workspace: "<directory>" });
  });

  it("prints a readable dry-run plan", async () => {
    await run(["setup", "--root", root, "--dry-run", "--clients", "codex"]);
    expect(output).toMatch(/dry.run/i);
    expect(output).toContain(root);
    expect(output).toContain("codex");
    expect(versionCheck).not.toHaveBeenCalled();
    expect(snapshot(root)).toEqual({});
  });

  it("reports unknown posture for a dangling linked config and preserves it", async (context) => {
    mkdirSync(join(root, ".codex"));
    const config = join(root, ".codex", "config.toml");
    try { symlinkSync("missing.toml", config, "file"); }
    catch (error: unknown) {
      if (["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) { context.skip(); return; }
      throw error;
    }
    await run(["setup", "--root", root, "--clients", "codex", "--dry-run", "--json"]);
    expect(JSON.parse(output).writeEnabled).toBeNull();
    expect(lstatSync(config).isSymbolicLink()).toBe(true);
    expect(readlinkSync(config)).toBe("missing.toml");
    expect(versionCheck).not.toHaveBeenCalled();
  });
});
