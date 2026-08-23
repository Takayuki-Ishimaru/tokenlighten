/**
 * observationEventsV2.spec.ts — V10-02 new observation events, in-process
 * integration tests. Calls server.ts's `callTool` directly in THIS test
 * process (no subprocess spawn — mirrors taskProfileBinding.spec.ts /
 * sessionLanes.spec.ts's own in-process pattern), so each test exercises the
 * REAL dispatch seam an event is wired to:
 *
 *   repeated_query     — callTool's dispatch-level dispatchTaskRef check
 *   forced_resend      — callTool's dispatch-level generic force_serve read
 *   repeated_range     — buildFullDowngradePayload (mode=full repeat read)
 *   post_edit_readback — recordTaskPackSurfaceReads
 *
 * server.ts's `ALLOW_WRITE` is resolved once from `process.argv` at module
 * load, so an in-process vitest run (no `--allow-write`) cannot exercise a
 * REAL edit_file write. The post_edit_readback tests seed state/session.ts's
 * edited-paths ledger directly via `recordEditedPath` — exactly what a
 * successful edit_file call would have written there — so the test still
 * exercises the actual READ-side seam under test, not a mocked substitute.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { callTool } from "../server.js";
import { handleTable } from "../util/handles.js";
import { recordEditedPath, resetAll as resetAllSessions } from "../state/session.js";
import { resetRootResolverCache } from "../tools/locateTaskContext.js";
import { resetTokenlightenIgnoreCache } from "../tools/walkRepo.js";
import { resetPackDedupeCache, resetRoleInventoryCache } from "../tools/readCodeTaskPack.js";
import { getTracePath, setTraceEnabledForTest, resetTraceCallIdForTest } from "../util/trace.js";
import { workspaceRefOf } from "../state/handleCodec.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const roots: string[] = [];

function workspace(tag: string): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.homedir(), `.tl-obsv2-${tag}-`)));
  roots.push(root);
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: tag, type: "module" }) + "\n");
  return root;
}

function write(root: string, rel: string, content: string): void {
  const target = path.join(root, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, "utf8");
}

function resetState(): void {
  handleTable.reset();
  resetAllSessions();
  resetPackDedupeCache();
  resetRoleInventoryCache();
  resetRootResolverCache();
  resetTokenlightenIgnoreCache();
}

function readTraceRecords(root: string): Array<Record<string, unknown>> {
  const p = getTracePath(root);
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, "utf8")
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

beforeEach(() => {
  resetState();
  setTraceEnabledForTest(true);
  resetTraceCallIdForTest();
});

afterEach(() => {
  setTraceEnabledForTest(false);
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

interface ToolResult {
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
}

function parseResult(result: ToolResult): Record<string, unknown> {
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// repeated_query
// ---------------------------------------------------------------------------

describe("V10-02 observation events — repeated_query", () => {
  it("fires when the SAME query text re-packs the already-active qref", async () => {
    const root = workspace("repeated-query");
    write(root, "src/order.ts", "export function order() { return 1; }\n");

    const first = await callTool("read_file", {
      mode: "task_pack", query: "update order handling", paths: ["src/order.ts"], cwd: root,
    }) as ToolResult;
    expect(first.isError, JSON.stringify(first)).not.toBe(true);

    const second = await callTool("read_file", {
      mode: "task_pack", query: "update order handling", paths: ["src/order.ts"], cwd: root,
    }) as ToolResult;
    expect(second.isError, JSON.stringify(second)).not.toBe(true);

    const records = readTraceRecords(root);
    const repeats = records.filter((r) => r["event"] === "repeated_query");
    expect(repeats).toHaveLength(1);
    expect(repeats[0]!["task_ref"]).toMatch(/^q-[0-9a-f]{16}$/);
    // Never the volatile tlh_ handle string.
    expect(repeats[0]!["task_ref"]).not.toContain("tlh_");
    // The full V10-02 envelope really did ride a REAL dispatch call, not
    // just the hermetic trace.ts-level mechanism (traceEnvelopeV2.spec.ts).
    expect(typeof repeats[0]!["call_id"]).toBe("number");
    expect(typeof repeats[0]!["trace_id"]).toBe("string");
    expect(repeats[0]!["workspaceRef"]).toBe(workspaceRefOf(root));
    expect(Array.isArray(repeats[0]!["flags_active"])).toBe(true);
    expect(typeof repeats[0]!["protocol_era"]).toBe("string");

    // route_decision fires on every call and also carries call_id/task_ref.
    const routeDecisions = records.filter((r) => r["event"] === "route_decision");
    expect(routeDecisions).toHaveLength(2);
    expect(routeDecisions[1]!["task_ref"]).toBe(repeats[0]!["task_ref"]);
  });

  it("does NOT fire on the first call establishing a fresh qref", async () => {
    const root = workspace("fresh-query");
    write(root, "src/order.ts", "export function order() { return 1; }\n");

    await callTool("read_file", {
      mode: "task_pack", query: "brand new task never seen before", paths: ["src/order.ts"], cwd: root,
    });

    const records = readTraceRecords(root);
    expect(records.filter((r) => r["event"] === "repeated_query")).toHaveLength(0);
  });

  it("does NOT fire for two DIFFERENT query texts against the same workspace", async () => {
    const root = workspace("different-queries");
    write(root, "src/order.ts", "export function order() { return 1; }\n");

    await callTool("read_file", {
      mode: "task_pack", query: "first distinct task", paths: ["src/order.ts"], cwd: root,
    });
    await callTool("read_file", {
      mode: "task_pack", query: "second distinct task", paths: ["src/order.ts"], cwd: root,
    });

    const records = readTraceRecords(root);
    expect(records.filter((r) => r["event"] === "repeated_query")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// forced_resend
// ---------------------------------------------------------------------------

describe("V10-02 observation events — forced_resend", () => {
  it("fires when the generic force_serve arg is present and truthy", async () => {
    const root = workspace("forced-resend");
    write(root, "src/order.ts", "export function order() { return 1; }\n");

    await callTool("read_file", {
      mode: "full", path: "src/order.ts", cwd: root, force_serve: true,
    });

    const records = readTraceRecords(root);
    const forced = records.filter((r) => r["event"] === "forced_resend");
    expect(forced).toHaveLength(1);
    expect(forced[0]!["tool"]).toBe("read_file");
  });

  it("never fires when the arg is absent (no wire schema declares it in this tree)", async () => {
    const root = workspace("no-forced-resend");
    write(root, "src/order.ts", "export function order() { return 1; }\n");

    await callTool("read_file", { mode: "full", path: "src/order.ts", cwd: root });

    const records = readTraceRecords(root);
    expect(records.filter((r) => r["event"] === "forced_resend")).toHaveLength(0);
  });

  it("never fires when force_serve is present but falsy", async () => {
    const root = workspace("falsy-forced-resend");
    write(root, "src/order.ts", "export function order() { return 1; }\n");

    await callTool("read_file", { mode: "full", path: "src/order.ts", cwd: root, force_serve: false });

    const records = readTraceRecords(root);
    expect(records.filter((r) => r["event"] === "forced_resend")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// repeated_range
// ---------------------------------------------------------------------------

/**
 * Non-tiny content (>8KiB, matching readCodeFullDowngrade.spec.ts's own
 * makeContent recipe): a genuinely tiny file is exempt from full-read
 * governance (state/session.ts's recordTinyFullExpansion path) and is served
 * fresh every time, never through buildFullDowngradePayload's wasFullyServed
 * branch — this size is what actually reaches the governed path under test.
 */
function makeNonTinyContent(targetBytes = 9000): string {
  const lines: string[] = [];
  let totalBytes = 0;
  let i = 0;
  while (totalBytes < targetBytes) {
    const line = `export const VAR_${i} = ${i}; // padding-comment-to-increase-line-length\n`;
    lines.push(line);
    totalBytes += Buffer.byteLength(line, "utf8");
    i++;
  }
  return lines.join("");
}

describe("V10-02 observation events — repeated_range", () => {
  it("fires on a governed mode=full repeat read of the SAME unchanged sha", async () => {
    const root = workspace("repeated-range");
    write(root, "src/pid.cpp", makeNonTinyContent());

    const first = await callTool("read_file", { mode: "full", path: "src/pid.cpp", cwd: root }) as ToolResult;
    expect(first.isError, JSON.stringify(first)).not.toBe(true);
    expect(parseResult(first)["kind"]).toBe("read.text");

    const second = await callTool("read_file", { mode: "full", path: "src/pid.cpp", cwd: root }) as ToolResult;
    expect(second.isError, JSON.stringify(second)).not.toBe(true);
    // The W1 content-equivalent receipt shape (readCodeFullDowngrade.spec.ts
    // pins the same recipe for the response side).
    expect(parseResult(second)["kind"]).toBe("read.receipt");

    const records = readTraceRecords(root);
    const repeats = records.filter((r) => r["event"] === "repeated_range");
    expect(repeats).toHaveLength(1);
    expect(repeats[0]!["mode"]).toBe("full");
    expect(repeats[0]!["path"]).toBe("src/pid.cpp");
    expect(repeats[0]!["complete"]).toBe(true);
  });

  it("does NOT fire on the first (fresh) read of a path", async () => {
    const root = workspace("fresh-full-read");
    write(root, "src/pid.cpp", makeNonTinyContent());

    await callTool("read_file", { mode: "full", path: "src/pid.cpp", cwd: root });

    const records = readTraceRecords(root);
    expect(records.filter((r) => r["event"] === "repeated_range")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// post_edit_readback
// ---------------------------------------------------------------------------

describe("V10-02 observation events — post_edit_readback", () => {
  it("fires when a task_pack surface serves a path already in the edited-paths ledger", async () => {
    const root = workspace("post-edit-readback");
    write(root, "src/order.ts", "export function order() { return 1; }\n");

    // See this file's header doc: recordEditedPath is exactly what a
    // successful edit_file call writes into this ledger.
    recordEditedPath(root, "src/order.ts");

    const result = await callTool("read_file", {
      mode: "task_pack", query: "review the order function", paths: ["src/order.ts"], cwd: root,
    }) as ToolResult;
    expect(result.isError, JSON.stringify(result)).not.toBe(true);

    const records = readTraceRecords(root);
    const readbacks = records.filter((r) => r["event"] === "post_edit_readback");
    expect(readbacks.length).toBeGreaterThan(0);
    expect(readbacks[0]!["path"]).toBe("src/order.ts");
  });

  it("does NOT fire for a path never edited this session", async () => {
    const root = workspace("no-post-edit-readback");
    write(root, "src/order.ts", "export function order() { return 1; }\n");

    await callTool("read_file", {
      mode: "task_pack", query: "review the order function", paths: ["src/order.ts"], cwd: root,
    });

    const records = readTraceRecords(root);
    expect(records.filter((r) => r["event"] === "post_edit_readback")).toHaveLength(0);
  });

  it("does NOT fire for a DIFFERENT path than the one recorded as edited", async () => {
    const root = workspace("other-path-edited");
    write(root, "src/order.ts", "export function order() { return 1; }\n");
    write(root, "src/other.ts", "export function other() { return 2; }\n");

    recordEditedPath(root, "src/other.ts");

    await callTool("read_file", {
      mode: "task_pack", query: "review the order function", paths: ["src/order.ts"], cwd: root,
    });

    const records = readTraceRecords(root);
    expect(records.filter((r) => r["event"] === "post_edit_readback")).toHaveLength(0);
  });
});
