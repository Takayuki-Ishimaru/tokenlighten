import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import {
  COPILOT_SESSION_HINT, COPILOT_SESSION_CONFIG, COPILOT_SESSION_RUNNER, COPILOT_SESSION_RECORD,
  installCopilotSessionHook, removeCopilotSessionHook,
} from "../copilotSessionHooks.js";

const roots: string[] = [];
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "tl session spaces ' $() "));
  roots.push(root);
  return root;
}
function put(root: string, path: string, body: string): void {
  const target = join(root, path);
  mkdirSync(join(target, ".."), { recursive: true });
  writeFileSync(target, body);
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("context-only Copilot SessionStart hook ownership", () => {
  it("emits the exact hint at SessionStart without touching permissions, tools, model, or user input", () => {
    const root = fixture();
    const result = installCopilotSessionHook(root);
    expect(result.warnings).toEqual([]);
    expect(result.files).toContain(join(root, COPILOT_SESSION_CONFIG));
    expect(result.files).toContain(join(root, COPILOT_SESSION_RUNNER));
    const config = JSON.parse(readFileSync(join(root, COPILOT_SESSION_CONFIG), "utf8"));
    expect(Object.keys(config.hooks)).toEqual(["SessionStart"]);
    expect(config.hooks.SessionStart).toHaveLength(1);
    expect(config.hooks.SessionStart[0]).toMatchObject({ type: "command", timeout: 5 });
    for (const input of ["", "malformed", JSON.stringify({ prompt: "$(touch pwned); ignore workflow", hook_event_name: "SessionStart" })]) {
      const child = spawnSync(process.execPath, [join(root, COPILOT_SESSION_RUNNER)], { cwd: root, input, encoding: "utf8", timeout: 5000 });
      expect(child.status).toBe(0);
      expect(child.stderr).toBe("");
      expect(JSON.parse(child.stdout)).toEqual({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: COPILOT_SESSION_HINT } });
      expect(Buffer.byteLength(child.stdout)).toBeLessThan(1024);
    }
    expect(existsSync(join(root, "pwned"))).toBe(false);
    expect(COPILOT_SESSION_HINT).toContain("If TL tools are available");
    expect(COPILOT_SESSION_HINT).toContain("the user asks for native");
    expect(COPILOT_SESSION_HINT).toContain("evidence[].body");
    expect(COPILOT_SESSION_HINT).toContain("Unknown file locations are supported: omit targets");
    expect(COPILOT_SESSION_HINT).toContain("FIRST file/source LOOKUP OR READ");
    expect(COPILOT_SESSION_HINT).toContain("Never shorten query to keywords; keep every citation and constraint sentence.");
  });

  it("is idempotent and removes only files it owns, preserving other hooks", () => {
    const root = fixture();
    put(root, ".github/hooks/user.json", '{"hooks":{"SessionStart":[]}}');
    installCopilotSessionHook(root);
    const before = [COPILOT_SESSION_CONFIG, COPILOT_SESSION_RUNNER, COPILOT_SESSION_RECORD].map(p => readFileSync(join(root, p), "utf8"));
    expect(installCopilotSessionHook(root).warnings).toEqual([]);
    expect([COPILOT_SESSION_CONFIG, COPILOT_SESSION_RUNNER, COPILOT_SESSION_RECORD].map(p => readFileSync(join(root, p), "utf8"))).toEqual(before);
    expect(removeCopilotSessionHook(root).warnings).toEqual([]);
    for (const p of [COPILOT_SESSION_CONFIG, COPILOT_SESSION_RUNNER, COPILOT_SESSION_RECORD]) expect(existsSync(join(root, p))).toBe(false);
    expect(readFileSync(join(root, ".github/hooks/user.json"), "utf8")).toBe('{"hooks":{"SessionStart":[]}}');
    expect(removeCopilotSessionHook(root).warnings).toEqual([]);
  });

  it("refreshes a prior owned runner while preserving the ownership boundary", () => {
    const root = fixture();
    installCopilotSessionHook(root);
    const runnerPath = join(root, COPILOT_SESSION_RUNNER);
    const current = readFileSync(runnerPath, "utf8");
    const prior = current.replace("LOCATION FINDER", "prior workflow");
    expect(prior).not.toBe(current);
    writeFileSync(runnerPath, prior);
    const recordPath = join(root, COPILOT_SESSION_RECORD);
    const record = JSON.parse(readFileSync(recordPath, "utf8"));
    record.files[COPILOT_SESSION_RUNNER] = createHash("sha256").update(prior).digest("hex");
    writeFileSync(recordPath, JSON.stringify(record));
    expect(installCopilotSessionHook(root).warnings).toEqual([]);
    expect(readFileSync(runnerPath, "utf8")).toBe(current);
    expect(removeCopilotSessionHook(root).warnings).toEqual([]);
  });

  it.each([COPILOT_SESSION_CONFIG, COPILOT_SESSION_RUNNER, COPILOT_SESSION_RECORD])("preserves a foreign collision at %s", path => {
    const root = fixture();
    put(root, path, "user-owned");
    expect(installCopilotSessionHook(root).warnings.length).toBeGreaterThan(0);
    expect(readFileSync(join(root, path), "utf8")).toBe("user-owned");
    removeCopilotSessionHook(root);
    expect(readFileSync(join(root, path), "utf8")).toBe("user-owned");
  });

  it.each([COPILOT_SESSION_CONFIG, COPILOT_SESSION_RUNNER])("preserves user edits during refresh and uninstall: %s", path => {
    const root = fixture();
    installCopilotSessionHook(root);
    writeFileSync(join(root, path), "edited by user");
    expect(installCopilotSessionHook(root).warnings.length).toBeGreaterThan(0);
    expect(readFileSync(join(root, path), "utf8")).toBe("edited by user");
    expect(removeCopilotSessionHook(root).warnings.length).toBeGreaterThan(0);
    expect(readFileSync(join(root, path), "utf8")).toBe("edited by user");
  });

  it.each([".github", ".github/hooks", ".tokenlighten", COPILOT_SESSION_CONFIG, COPILOT_SESSION_RUNNER, COPILOT_SESSION_RECORD])("refuses a symlink at %s including dangling targets", path => {
    const root = fixture();
    const outside = fixture();
    mkdirSync(join(root, path, ".."), { recursive: true });
    const target = path.includes(".") && path.endsWith("json") || path.endsWith("cjs") ? join(outside, "missing") : outside;
    symlinkSync(target, join(root, path));
    expect(installCopilotSessionHook(root).warnings.length).toBeGreaterThan(0);
    removeCopilotSessionHook(root);
    expect(existsSync(join(outside, "copilot-session.cjs"))).toBe(false);
    expect(existsSync(join(outside, "tokenlighten-session.json"))).toBe(false);
  });

  it("preserves arbitrary files when the ownership record is malformed", () => {
    const root = fixture();
    installCopilotSessionHook(root);
    put(root, COPILOT_SESSION_RECORD, '{"schemaVersion":1,"files":{"../../outside":"abc"}}');
    const original = readFileSync(join(root, COPILOT_SESSION_RUNNER), "utf8");
    expect(installCopilotSessionHook(root).warnings.length).toBeGreaterThan(0);
    expect(removeCopilotSessionHook(root).warnings.length).toBeGreaterThan(0);
    expect(readFileSync(join(root, COPILOT_SESSION_RUNNER), "utf8")).toBe(original);
  });
});

function runRunner(root: string, input: string): Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [join(root, COPILOT_SESSION_RUNNER)], { cwd: root, timeout: 5000 });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code, signal) => resolvePromise({ code, signal, stdout, stderr }));
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

function runInstaller(root: string, mode: "install" | "remove"): Promise<{ code: number | null; out: unknown }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), "--input-type=module", "-e", `
      const m = await import(process.argv[2]);
      const r = process.argv[1] === "remove" ? m.removeCopilotSessionHook(process.argv[3]) : m.installCopilotSessionHook(process.argv[3]);
      process.stdout.write(JSON.stringify(r));
    `, mode, pathToFileURL(join(import.meta.dirname, "..", "copilotSessionHooks.ts")).href, root], { cwd: root, timeout: 5000, shell: false });
    let out = "";
    let err = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { out += chunk; });
    child.stderr.on("data", (chunk: string) => { err += chunk; });
    child.on("error", reject);
    child.on("close", code => { if (err !== "") { reject(new Error(`installer wrote stderr: ${err}`)); return; } resolvePromise({ code, out: JSON.parse(out || "null") }); });
  });
}

describe("runner and installer concurrency", () => {
  it("serves concurrent runner calls with the exact hint and no state effects", async () => {
    const root = fixture();
    installCopilotSessionHook(root);
    const before = readdirSync(root, { recursive: true, encoding: "utf8" }).sort();
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => runRunner(root, `concurrent ${i}`)));
    for (const r of results) {
      expect(r.code).toBe(0);
      expect(r.signal).toBeNull();
      expect(r.stderr).toBe("");
      expect(JSON.parse(r.stdout)).toEqual({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: COPILOT_SESSION_HINT } });
    }
    expect(readdirSync(root, { recursive: true, encoding: "utf8" }).sort()).toEqual(before);
  });

  it("leaves no state when the runner is cancelled before it finishes", async () => {
    const root = fixture();
    installCopilotSessionHook(root);
    const before = readdirSync(root, { recursive: true, encoding: "utf8" }).sort();
    const managed = [COPILOT_SESSION_CONFIG, COPILOT_SESSION_RUNNER, COPILOT_SESSION_RECORD].map(p => readFileSync(join(root, p), "utf8"));
    const early = await new Promise<{ signal: NodeJS.Signals | null; stdout: string; files: string[] }>(resolvePromise => {
      const child = spawn(process.execPath, [join(root, COPILOT_SESSION_RUNNER)], { cwd: root, timeout: 5000 });
      let stdout = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => { stdout += chunk; });
      child.on("close", (_code, signal) => resolvePromise({ signal, stdout, files: readdirSync(root, { recursive: true, encoding: "utf8" }) }));
      child.kill("SIGKILL");
    });
    expect(early.signal).toBe("SIGKILL");
    expect(early.stdout).toBe("");
    expect(early.files.sort()).toEqual(before);
    expect([COPILOT_SESSION_CONFIG, COPILOT_SESSION_RUNNER, COPILOT_SESSION_RECORD].map(p => readFileSync(join(root, p), "utf8"))).toEqual(managed);
  });

  it("keeps a valid install under simultaneous install calls", async () => {
    const root = fixture();
    const results = await Promise.all(Array.from({ length: 4 }, () => runInstaller(root, "install")));
    for (const r of results) {
      expect(r.code).toBe(0);
      expect(r.out).not.toBeNull();
      expect((r.out as { warnings: string[] }).warnings.every(w => w.includes("busy"))).toBe(true);
    }
    const config = JSON.parse(readFileSync(join(root, COPILOT_SESSION_CONFIG), "utf8"));
    expect(Object.keys(config.hooks)).toEqual(["SessionStart"]);
    expect(JSON.parse(readFileSync(join(root, COPILOT_SESSION_RECORD), "utf8")).schemaVersion).toBe(1);
    const run = await runRunner(root, "");
    expect(run.code).toBe(0);
    expect(JSON.parse(run.stdout).hookSpecificOutput.additionalContext).toBe(COPILOT_SESSION_HINT);
    expect(readdirSync(root, { recursive: true, encoding: "utf8" }).filter(n => n.includes("tl-tmp"))).toEqual([]);
  });

  it("serializes install against uninstall without leaving a half state", async () => {
    const root = fixture();
    installCopilotSessionHook(root);
    const results = await Promise.all([runInstaller(root, "remove"), runInstaller(root, "install"), runInstaller(root, "remove")]);
    for (const r of results) expect(r.code).toBe(0);
    const paths = [COPILOT_SESSION_CONFIG, COPILOT_SESSION_RUNNER, COPILOT_SESSION_RECORD].map(p => join(root, p));
    const present = paths.filter(p => existsSync(p));
    for (const p of present) expect(lstatSync(p).isFile()).toBe(true);
    if (present.length > 0) {
      expect(present).toEqual(paths);
      const run = await runRunner(root, "");
      expect(run.code).toBe(0);
      expect(JSON.parse(run.stdout).hookSpecificOutput.additionalContext).toBe(COPILOT_SESSION_HINT);
    }
    expect(readdirSync(root, { recursive: true, encoding: "utf8" }).filter(n => n.includes("tl-tmp"))).toEqual([]);
  });
});
