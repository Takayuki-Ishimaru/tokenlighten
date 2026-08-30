// fullModeBudget.spec.ts — T2 (v0.13 review-fix wave): read_file mode=full x
// maxBytes.
//
// CONTEXT: a C-4 rehearsal run's own notes suspected "mode=full completely
// ignores maxBytes". Empirical in-process callTool measurement at this HEAD
// (post B-wave emit-funnel work: emit.ts's emitFinalizedPayload declaredMaxBytes
// re-entry, protocol/budget/shedders/readText.ts's rung-4 truncateLargestBody)
// shows the suspicion does NOT reproduce here: mode=full/auto/small_file, and
// a handle-addressed re-read, ALL already ship within a live maxBytes (via
// real shedding, not just because the fixture happened to be small), and a
// maxBytes too tight to shed into converts to a disclosed
// refusal{code:"cap-exceeded"} rather than silently shipping an oversized
// response. This suite PINS that already-correct behavior — no production
// fix was needed for T2; see this wave's B-REPORT addendum for the measured
// before/after byte counts that established this.

import { describe, it, expect, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { callTool } from "../server.js";
import { resetAll as resetAllSessions } from "../util/session.js";

const HOME = process.env["HOME"] ?? process.env["USERPROFILE"] ?? os.homedir();
const tmpDirs: string[] = [];

function mkWorkspace(tag: string): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(HOME, `.tl-fullbudget-${tag}-`)));
  tmpDirs.push(root);
  return root;
}

function writeFile(root: string, rel: string, content: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
}

afterAll(() => {
  resetAllSessions();
  for (const dir of tmpDirs.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

type Body = Record<string, unknown>;

async function call(tool: string, args: Record<string, unknown>): Promise<{ body: Body; bytes: number }> {
  const result = await callTool(tool, args);
  const text = (result.content[0] as { text?: string } | undefined)?.text ?? "{}";
  return { body: JSON.parse(text) as Body, bytes: Buffer.byteLength(text, "utf8") };
}

/** ~8KB of tiny-eligible fixture content — well over any of this suite's tight maxBytes values, well under TINY_BYTES (8192) so it is small-file-eligible. */
function tinyFixture(): string {
  return Array.from({ length: 120 }, (_, i) => `export const value${i} = "${"x".repeat(40)}";`).join("\n") + "\n";
}

/** ~80KB of NOT-tiny fixture content. */
function largeFixture(): string {
  return Array.from({ length: 1200 }, (_, i) => `export const value${i} = "${"x".repeat(40)}";`).join("\n") + "\n";
}

describe("read_file mode=full respects a live maxBytes (sheds real bytes, never ships oversized)", () => {
  it("baseline: no maxBytes ships the whole tiny-eligible file (establishes the fixture needs real shedding below, not a vacuous pass)", async () => {
    const ws = mkWorkspace("baseline");
    const fixture = tinyFixture();
    writeFile(ws, "src/tiny.ts", fixture);
    const { body, bytes } = await call("read_file", { cwd: ws, mode: "full", path: "src/tiny.ts" });
    expect(body["kind"]).toBe("read.text");
    expect(bytes).toBeGreaterThan(1000); // proves maxBytes:1000 below forces REAL shedding, not a no-op
  });

  it("mode=full: a 1000-byte live cap sheds real bytes and ships within budget", async () => {
    const ws = mkWorkspace("full-1000");
    writeFile(ws, "src/tiny.ts", tinyFixture());
    const { body, bytes } = await call("read_file", { cwd: ws, mode: "full", path: "src/tiny.ts", maxBytes: 1000 });
    expect(bytes, JSON.stringify(body).slice(0, 300)).toBeLessThanOrEqual(1000);
    expect(body["kind"]).toBe("read.text");
    const limit = body["limit"] as Body | undefined;
    expect(limit, JSON.stringify(body).slice(0, 300)).toBeDefined();
    expect(limit!["cause"]).toBe("wire");
    // A machine-readable, executable continuation for the rest of the file.
    expect(limit!["next"]).toBeDefined();
  });

  it("mode=full on a NOT-tiny (large) file also respects a 1000-byte live cap", async () => {
    const ws = mkWorkspace("full-large-1000");
    writeFile(ws, "src/large.ts", largeFixture());
    const { body, bytes } = await call("read_file", { cwd: ws, mode: "full", path: "src/large.ts", maxBytes: 1000 });
    expect(bytes, JSON.stringify(body).slice(0, 300)).toBeLessThanOrEqual(1000);
    expect(body["kind"]).toBe("read.text");
  });

  it("mode=small_file (explicit) respects the same 1000-byte live cap as mode=full", async () => {
    const ws = mkWorkspace("smallfile-1000");
    writeFile(ws, "src/tiny.ts", tinyFixture());
    const { body, bytes } = await call("read_file", { cwd: ws, mode: "small_file", path: "src/tiny.ts", maxBytes: 1000 });
    expect(bytes, JSON.stringify(body).slice(0, 300)).toBeLessThanOrEqual(1000);
    expect(body["kind"]).toBe("read.text");
  });

  it("a handle-addressed mode=full re-read respects a live maxBytes just like the original path read", async () => {
    const ws = mkWorkspace("handle-1000");
    writeFile(ws, "src/tiny.ts", tinyFixture());
    const first = await call("read_file", { cwd: ws, mode: "full", path: "src/tiny.ts" });
    const evidence = first.body["evidence"] as Array<Record<string, unknown>>;
    const handle = evidence[0]!["handle"] as string;
    const { body, bytes } = await call("read_file", { cwd: ws, mode: "full", handle, maxBytes: 1000 });
    expect(bytes, JSON.stringify(body).slice(0, 300)).toBeLessThanOrEqual(1000);
    expect(body["kind"]).toBe("read.text");
  });

  it("a maxBytes too tight to shed into converts to a disclosed refusal{code:cap-exceeded}, never an oversized ship", async () => {
    const ws = mkWorkspace("refusal-50");
    writeFile(ws, "src/tiny.ts", tinyFixture());
    const { body, bytes } = await call("read_file", { cwd: ws, mode: "full", path: "src/tiny.ts", maxBytes: 50 });
    expect(bytes).toBeLessThan(1000); // the refusal itself stays small — nowhere near the ~8KB source file
    expect(body["kind"], JSON.stringify(body).slice(0, 300)).toBe("refusal");
    expect(body["for"]).toBe("read_file");
    expect(body["code"]).toBe("cap-exceeded");
    expect(body["retry"]).toBe("call");
    expect(String(body["detail"])).toContain("50 B");
  });
});
