/**
 * bogusWorkspaceRoot.spec.ts — external v0.14.3 evaluation, 2026-09-27 §6.2
 * (FIX-FD item 3): "no writer may ever create a workspace root; a cwd that
 * does not exist is refused on every tool and transport."
 *
 * Pre-existing bug, confirmed live before this fix: two stray directories
 * sat at THIS repo's own root holding nothing but `.tokenlighten/state/
 * meta.json` (`pack/`, `no-import/` — left in place; the user decides
 * whether to remove them, see the wave report). Root cause traced to
 * server.ts's module-level `activeRoot` (a `--workspace`/positional CLI arg,
 * or TOKENLIGHTEN_ROOT) never being checked for existence: the first writer
 * that opened a workspace-scoped store against it —
 * `WorkspaceStateStore.open`'s `mkdirSync(dir, {recursive:true})` — silently
 * materialized the entire missing chain, including the workspace root
 * itself, wherever the process's own OS cwd happened to be at launch.
 *
 * A SEPARATE, narrower gap: `checkCwdWithCorrection` (the read_file/
 * search_files-only cwd auto-correction) treated ANY nonexistent DIRECT
 * CHILD of an already-accepted root as a "typo" and silently substituted the
 * whole root for it instead of refusing — confirmed live via
 * `read_file {cwd:"<pinned>/no-such-dir", query}` and
 * `read_file {cwd:"<pinned>/nope2", targets:[...]}`, both answering instead
 * of refusing with `invalid-cwd`. The genuinely useful case this correction
 * exists for (a typo one segment below an otherwise real, SPECIFIC
 * directory) is unaffected and stays pinned by
 * `pi/pi07WorkspaceRetry.spec.ts`'s "one-segment cwd typo" test — this file
 * does not re-test it, only the NEW boundary.
 */
import { afterEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { WorkspaceStateStore, resetStateStoresForTests } from "../state/stateStore.js";
import { startDevServer, type ServerHandle } from "./helpers/qualityFirstScenarios.js";
import { killServerGroup } from "./helpers/killServerGroup.js";

const HOME = process.env["HOME"] ?? process.env["USERPROFILE"] ?? os.homedir();
const nodeRequire = createRequire(import.meta.url);
const TSX_CLI = nodeRequire.resolve("tsx/cli");
const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN_TS = path.resolve(HERE, "..", "bin.ts");

const tmpDirs: string[] = [];
const servers: ServerHandle[] = [];

function mkDir(tag: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(HOME, `.tl-bwr-${tag}-`)));
  tmpDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const s of servers.splice(0)) await s.kill();
  resetStateStoresForTests();
  for (const d of tmpDirs.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

// ---------------------------------------------------------------------------
// (1) state/stateStore.ts — never creates the workspace root itself.
// ---------------------------------------------------------------------------

describe("WorkspaceStateStore.open never creates the workspace root", () => {
  it("fails closed (available:false) for a nonexistent workspace root, and creates nothing on disk", () => {
    const base = mkDir("root-parent");
    const bogusRoot = path.join(base, "does-not-exist");
    expect(fs.existsSync(bogusRoot)).toBe(false);

    const store = WorkspaceStateStore.open(bogusRoot);

    expect(store.available).toBe(false);
    expect(fs.existsSync(bogusRoot), "the missing root itself must never be materialized").toBe(false);
  });

  it("still opens normally (available:true) for a real, pre-existing root (no regression)", () => {
    const root = mkDir("root-real");
    const store = WorkspaceStateStore.open(root);

    expect(store.available).toBe(true);
    expect(fs.existsSync(path.join(root, ".tokenlighten", "state", "meta.json"))).toBe(true);
  });

  it("fails closed when the workspace root exists but is a plain FILE, not a directory", () => {
    const base = mkDir("root-file");
    const filePath = path.join(base, "not-a-dir");
    fs.writeFileSync(filePath, "x");

    const store = WorkspaceStateStore.open(filePath);

    expect(store.available).toBe(false);
    expect(fs.readFileSync(filePath, "utf8")).toBe("x"); // untouched
  });
});

// ---------------------------------------------------------------------------
// (2) server.ts startup — a nonexistent/relative activeRoot fails fast,
// before any writer can ever touch it.
// ---------------------------------------------------------------------------

describe("server startup refuses a nonexistent workspace root", () => {
  it("exits non-zero with a fatal message, and never creates the bogus root on disk", async () => {
    // Launch cwd is a REAL, freshly-created directory (never the repo root) so
    // that if this regressed, the stray directory would land in a throwaway
    // temp dir instead of anywhere real.
    const launchDir = mkDir("launch");
    const bogusRelativeArg = "totally-bogus-workspace-name";
    const bogusAbsPath = path.join(launchDir, bogusRelativeArg);

    const child: ChildProcess = spawn(
      process.execPath,
      [TSX_CLI, "--liftoff-only", BIN_TS, bogusRelativeArg],
      { cwd: launchDir, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32" },
    );
    let stderr = "";
    child.stderr!.on("data", (d: Buffer) => { stderr += d.toString(); });

    const exitCode = await new Promise<number | null>((resolve) => {
      const timer = setTimeout(() => { killServerGroup(child); resolve(null); }, 15000);
      child.on("exit", (code) => { clearTimeout(timer); resolve(code); });
    });

    expect(exitCode, `expected a non-zero exit; stderr:\n${stderr}`).not.toBe(0);
    expect(exitCode).not.toBeNull();
    expect(stderr).toContain("workspace root does not exist");
    expect(stderr).toContain(bogusRelativeArg);
    expect(fs.existsSync(bogusAbsPath), "the bogus root must never be materialized").toBe(false);
  }, 20000);

  it("a REAL workspace root still starts normally (no regression)", async () => {
    const ws = mkDir("real-startup");
    fs.writeFileSync(path.join(ws, "package.json"), '{"name":"bwr","private":true}\n');
    const srv = startDevServer(ws, "default", { toolSurface: "code" });
    servers.push(srv);
    await srv.initialize();
    const result = await srv.callTool("read_file", { cwd: ws, targets: [{ path: "package.json" }] });
    const rec = result.body as Record<string, unknown>;
    expect(rec["kind"]).not.toBe("refusal");
  }, 30000);
});

// ---------------------------------------------------------------------------
// (3) checkCwdWithCorrection — a nonexistent DIRECT CHILD of the pinned root
// refuses instead of silently substituting the whole workspace.
// ---------------------------------------------------------------------------

describe("a nonexistent per-call cwd override is corrected with disclosure (FIX 3 contract) and never materialized", () => {
  // The read tools' cwd auto-correction (handleWorkspaceAdoption.spec.ts,
  // "FIX 3") lands a nonexistent cwd on its nearest existing ancestor — the
  // pinned root itself included — and discloses it as `cwd_corrected`. The
  // bogus-root defect was never this correction: it was a state store
  // materializing a missing root (see the first describe above), so these
  // cases pin the disclosure AND that nothing is created on disk.
  it("read_file with a query and a nonexistent child cwd answers against the pinned root, discloses cwd_corrected, and creates nothing", async () => {
    const ws = mkDir("query-correct");
    fs.mkdirSync(path.join(ws, "src"), { recursive: true });
    fs.writeFileSync(path.join(ws, "src", "a.ts"), "export const A = 1;\n");
    fs.writeFileSync(path.join(ws, "package.json"), '{"name":"bwr","private":true}\n');
    const bogusCwd = path.join(ws, "no-such-dir");

    const srv = startDevServer(ws, "default", { toolSurface: "code" });
    servers.push(srv);
    await srv.initialize();

    const { body } = await srv.callTool("read_file", { cwd: bogusCwd, query: "What does src/a.ts export?" });
    const rec = body as Record<string, unknown>;
    expect(rec["kind"]).not.toBe("refusal");
    const corrected = rec["cwd_corrected"] as { from: string; to: string } | undefined;
    expect(corrected).toBeDefined();
    expect(corrected!.from).toBe(bogusCwd);
    expect(fs.realpathSync(corrected!.to)).toBe(fs.realpathSync(ws));
    expect(fs.existsSync(bogusCwd)).toBe(false);
  }, 30000);

  it("read_file with targets and a nonexistent child cwd is served from the corrected root with the same disclosure, creating nothing", async () => {
    const ws = mkDir("targets-correct");
    fs.mkdirSync(path.join(ws, "src"), { recursive: true });
    fs.writeFileSync(path.join(ws, "src", "a.ts"), "export const A = 1;\n");
    const bogusCwd = path.join(ws, "nope2");

    const srv = startDevServer(ws, "default", { toolSurface: "code" });
    servers.push(srv);
    await srv.initialize();

    const { body } = await srv.callTool("read_file", { cwd: bogusCwd, targets: [{ path: "src/a.ts" }] });
    const rec = body as Record<string, unknown>;
    expect(rec["kind"]).not.toBe("refusal");
    const corrected = rec["cwd_corrected"] as { from: string; to: string } | undefined;
    expect(corrected).toBeDefined();
    expect(corrected!.from).toBe(bogusCwd);
    expect(fs.realpathSync(corrected!.to)).toBe(fs.realpathSync(ws));
    expect(fs.existsSync(bogusCwd)).toBe(false);
  }, 30000);
});
