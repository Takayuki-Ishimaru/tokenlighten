// closureFunctionalObligation.spec.ts — W5 wiring (2026-07-25 iteration 2):
// an artifact-backed executable create/edit records a functional-validation
// obligation in packServeLog; mode=closure DISCLOSES it as an open item (never
// a refusal) and a diff review (search_files action=diff) discharges it.
//
// Bench forensics behind this: T10 rep1-A closed a compute-producing edit
// after environment probes only — never validating against the served rate
// values — and was the run's only verifier FAIL. The obligation + closure
// disclosure + diff discharge form the honest incentive loop.

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";
import { callTool } from "../server.js";
import {
  recordFunctionalValidationObligation,
  getFunctionalValidationObligation,
  resetPackServeLogForTest,
} from "../util/packServeLog.js";
import { resetAll } from "../util/session.js";

const HOME = process.env["HOME"] ?? process.env["USERPROFILE"] ?? os.homedir();
const dirs: string[] = [];

function mkWs(tag: string): string {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(HOME, `.tl-w5closure-${tag}-`)));
  dirs.push(d);
  return d;
}
function write(dir: string, rel: string, content: string): void {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
}
function gitInit(dir: string): void {
  execFileSync("git", ["-C", dir, "init"], { stdio: "ignore" });
  execFileSync("git", ["-C", dir, "config", "user.email", "t@t.com"], { stdio: "ignore" });
  execFileSync("git", ["-C", dir, "config", "user.name", "T"], { stdio: "ignore" });
  execFileSync("git", ["-C", dir, "add", "-A"], { stdio: "ignore" });
  execFileSync("git", ["-C", dir, "commit", "-m", "init", "--no-gpg-sign"], { stdio: "ignore" });
}
function parse(res: { content: Array<{ text: string }> }): Record<string, unknown> {
  return JSON.parse(res.content[0]!.text) as Record<string, unknown>;
}

beforeEach(() => {
  resetAll();
  resetPackServeLogForTest();
});
afterAll(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

describe("W5 — functional-validation obligation in mode=closure", () => {
  it("lists the obligation as an open item (zero registered checks path) and stays complete:false", async () => {
    const ws = mkWs("zero");
    write(ws, "pricing/rating_engine.py", "def compute():\n    return 0\n");
    recordFunctionalValidationObligation(ws, {
      note: "functionally validate the produced module against the served artifact values before closing",
      targetPath: "pricing/rating_engine.py",
    });

    const res = await callTool("read_file", { mode: "closure", cwd: ws });
    const body = parse(res as { content: Array<{ text: string }> });
    // v1 deletes `complete:false` (A.5.7): a still-open closure just stays
    // kind:"read.closure" — a fully-closed one degrades to the
    // "closure-complete" receipt instead (D3(a)/A.4), so the kind IS the
    // incompleteness carrier now.
    expect(body["kind"]).toBe("read.closure");
    const open = body["open"] as string[];
    expect(open.length).toBe(1);
    expect(open[0]).toContain("pricing/rating_engine.py");
    expect(open[0]).toContain("functionally validate");
  });

  it("a diff review discharges the obligation and closure no longer lists it", async () => {
    const ws = mkWs("diff");
    write(ws, "pricing/rating_engine.py", "def compute():\n    return 0\n");
    gitInit(ws);
    write(ws, "pricing/rating_engine.py", "def compute():\n    return 1\n");
    recordFunctionalValidationObligation(ws, {
      note: "functionally validate the produced module against the served artifact values before closing",
      targetPath: "pricing/rating_engine.py",
    });

    const diffRes = await callTool("search_files", { action: "diff", cwd: ws });
    expect((diffRes as { isError?: boolean }).isError).not.toBe(true);
    expect(getFunctionalValidationObligation(ws, [])).toBeUndefined();

    const res = await callTool("read_file", { mode: "closure", cwd: ws });
    const body = parse(res as { content: Array<{ text: string }> });
    expect((body["open"] as string[]).length).toBe(0);
  });

  it("without an obligation the closure shape carries no W5 fields", async () => {
    const ws = mkWs("plain");
    write(ws, "a.ts", "export const a = 1;\n");
    const res = await callTool("read_file", { mode: "closure", cwd: ws });
    const body = parse(res as { content: Array<{ text: string }> });
    expect(body["open"]).toEqual([]);
    // v1 deletes `complete:false` (A.5.7) — the zero-total path stays
    // kind:"read.closure" (never the "closure-complete" receipt), which is
    // now the honest carrier of "not verified complete".
    expect(body["kind"]).toBe("read.closure");
    // 2026-08-01: `applicability` is a deliberate base-shape addition (see
    // closureMode.spec) — what this pin protects is that NO W5-obligation
    // field leaks into the obligation-less shape.
    // D1/D4/D6: `v` + `kind` ride every payload and body `ok` is deleted.
    // v1 Rule K also deletes the `mode` echo (kind discriminates instead),
    // and `complete` is deleted per A.5.7 — neither rides the wire anymore.
    expect(Object.keys(body).sort()).toEqual(["applicability", "done", "kind", "note", "open", "summary", "total", "v"]);
  });
});
