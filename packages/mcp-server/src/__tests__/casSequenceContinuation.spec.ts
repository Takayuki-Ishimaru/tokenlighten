// casSequenceContinuation.spec.ts — P1-h(i) (2026-08-28 review-fix wave,
// spec A-2(4) acceptance).
//
// Pins the exact sequence A-2(4) requires: a wrong `expected_state_version`
// on a `task_handle` refuses (naming the LIVE version via `actual`, never
// silently ignored or accepted) -> the task's own prescribed `find` is then
// actually executed (a proof-transition write, per P1-a/A-2) -> a further
// `task_handle` continuation of the SAME task does not fall into
// `retry:"new-task"` merely because the server itself consumed the work it
// prescribed. The CAS policy this fixes (A-REPORT's "A-2 CAS and
// continuation policy"): a prescribed-next proof transition does not ADVANCE
// the visible `expected_state_version`, so a genuinely wrong version is still
// caught (this spec's step 1), while the correct find -> absence -> re-pack
// sequence (this spec's steps 2-3) is never itself forced into a spurious
// new-task refusal.
//
// In-process `callTool` (same pattern as pi09StateHandles.spec.ts's
// expected_state_version suite) — the claim is about wire-visible CAS
// behavior, not filesystem effects, so a spawned child process buys nothing
// a shared-process dispatch does not already prove.

import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { callTool } from "../server.js";
import { resolveTaskHandle } from "../state/stateHandles.js";
import { resetAll as resetAllSessions } from "../util/session.js";

const HOME = process.env["HOME"] ?? process.env["USERPROFILE"] ?? os.homedir();
const tmpDirs: string[] = [];

function mkWorkspace(tag: string): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(HOME, `.tl-cas-seq-${tag}-`)));
  tmpDirs.push(root);
  return root;
}

function writeFile(root: string, rel: string, content: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
}

async function dispatch(tool: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = await callTool(tool, args);
  const text = (result.content[0] as { text?: string } | undefined)?.text ?? "{}";
  return JSON.parse(text) as Record<string, unknown>;
}

function nextOf(body: Record<string, unknown>): { tool: string; arguments: Record<string, unknown> } | undefined {
  const decision = body["decision"] as Record<string, unknown> | undefined;
  const next = decision?.["next"] as { tool?: unknown; arguments?: unknown } | undefined;
  return typeof next?.tool === "string" && next.arguments !== undefined
    ? { tool: next.tool, arguments: next.arguments as Record<string, unknown> }
    : undefined;
}

afterEach(() => {
  resetAllSessions();
  for (const dir of tmpDirs.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

describe("CAS refusal then prescribed-find continuation does not fall to new-task (P1-h(i), A-2(4))", () => {
  it("wrong expected_state_version refuses naming the live version, then the same task_handle continues past the prescribed find", async () => {
    const cwd = mkWorkspace("refunded");
    writeFile(cwd, "src/status.ts", "export enum InvoiceStatus { PENDING = 'PENDING', PAID = 'PAID' }\n");
    writeFile(cwd, "src/consumer.ts", "import { InvoiceStatus } from './status.js'; export const current = InvoiceStatus.PAID;\n");
    const lane = "cas-sequence";
    const query = "Add REFUNDED everywhere InvoiceStatus is used.";

    // STEP 0: open the task and learn its real CAS version.
    const first = await dispatch("read_file", { mode: "task_pack", query, cwd, lane, taskEpoch: "new" });
    expect(first["kind"], JSON.stringify(first)).toBe("read.task_pack");
    const task = first["task"] as Record<string, unknown> | undefined;
    const taskHandle = String(task?.["id"]);
    expect(taskHandle).toMatch(/^tlh_task_v1_/);
    const resolved = resolveTaskHandle(taskHandle, cwd);
    expect(resolved.ok, JSON.stringify(resolved)).toBe(true);
    const liveVersion = (resolved as { stateVersion: number }).stateVersion;
    const prescribed = nextOf(first);
    expect(prescribed, JSON.stringify(first)).toEqual({
      tool: "search_files",
      arguments: { action: "find", queries: ["REFUNDED"] },
    });

    // STEP 1: a WRONG expected_state_version refuses fail-closed and names
    // the LIVE version via `actual` — the exact shape
    // pi09StateHandles.spec.ts's own expected_state_version suite pins.
    const wrongVersion = liveVersion + 7;
    const refused = await dispatch("read_file", {
      mode: "task_pack", query, cwd, lane,
      task_handle: taskHandle, expected_state_version: wrongVersion,
    });
    expect(refused["kind"], JSON.stringify(refused)).toBe("refusal");
    expect(refused["field"]).toBe("expected_state_version");
    expect(refused["actual"], JSON.stringify(refused)).toBe(liveVersion);
    expect(refused["retry"]).toBe("new-task");

    // STEP 2: execute the task's own PRESCRIBED find. This is a
    // proof-transition write (P1-a: the ledger records the authoritative
    // absence), not a state-version-advancing call under the adopted CAS
    // policy.
    const absence = await dispatch(prescribed!.tool, { ...prescribed!.arguments, cwd, lane });
    expect((absence["matches"] as Record<string, unknown> | undefined)?.["absence"]).toBeDefined();

    // STEP 3: continuing the SAME task_handle — with its ORIGINAL version,
    // exactly as returned at STEP 0 — must NOT fall to `retry:"new-task"`.
    // A correct implementation of the adopted CAS policy keeps the visible
    // version unchanged by the prescribed find's own proof-transition write,
    // so retrying with the version the caller already holds is the honest,
    // supported continuation shape (not a second, harder-to-justify
    // "omit expected_state_version entirely" workaround).
    const continued = await dispatch("read_file", {
      mode: "task_pack", query, cwd, lane,
      task_handle: taskHandle, expected_state_version: liveVersion,
    });
    expect(continued["kind"], JSON.stringify(continued)).not.toBe("refusal");
    expect((continued as { retry?: unknown })["retry"], JSON.stringify(continued)).not.toBe("new-task");
    // Still the SAME task (A-2's continuity guarantee), and the prescribed
    // find that just ran is not re-issued (A-2/P0-2's core no-repeat claim).
    expect(continued["task"], JSON.stringify(continued)).toMatchObject({ id: taskHandle });
    const continuedNext = nextOf(continued);
    expect(
      continuedNext === undefined || JSON.stringify(continuedNext) !== JSON.stringify(prescribed),
      JSON.stringify(continued),
    ).toBe(true);
  });
});
