// preReadyNoRepeat.spec.ts — P1-h(iii) (2026-08-28 review-fix wave, spec A-3(4)).
//
// state/session.ts's `recordExecutionContract` clears (never installs) the
// execution fence whenever `contract.state !== "ready"`:
//
//   if (contract?.state !== "ready") {
//     rememberInvalidatedPreparedHandles();
//     session.executionFence = undefined;
//     return "cleared";
//   }
//
// A discovery-phase (pre-ready) pack is therefore a FENCE NON-ARMED zone —
// the write-admissibility fence that guards edits has nothing installed to
// guard yet. A-3's no-repeat invariant ("the same successful next never
// reaches the wire twice in one taskEpoch") must hold there too: it is a
// property of the executed-next ledger (packServeLog.ts / P1-c) and the
// task-contract ledger (taskContractStore.ts / A-1), NEITHER of which the
// execution fence participates in. This spec names the pre-ready/fence-
// cleared state directly (via `getExecutionFence`) rather than inferring it
// from decision shape, so a future change that accidentally makes the
// no-repeat guarantee depend on a fence being armed is caught here even if
// every other spec that happens to also be pre-ready (sequenceCorpus.spec.ts's
// I1/I3/I5) does not name the fence state explicitly.

import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { callTool } from "../server.js";
import { getExecutionFence } from "../state/session.js";
import { resetAll as resetAllSessions } from "../util/session.js";

const HOME = process.env["HOME"] ?? process.env["USERPROFILE"] ?? os.homedir();
const tmpDirs: string[] = [];

function mkWorkspace(tag: string): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(HOME, `.tl-preready-${tag}-`)));
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
  expect("isError" in result && result.isError === true, JSON.stringify(result)).toBe(false);
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

describe("no-repeat holds in the pre-ready, fence non-armed zone (P1-h(iii), A-3(4))", () => {
  it("names the fence-cleared state directly at the pre-ready step, then proves the prescribed next does not repeat", async () => {
    const cwd = mkWorkspace("no-repeat");
    writeFile(cwd, "src/status.ts", "export enum InvoiceStatus { PENDING = 'PENDING', PAID = 'PAID' }\n");
    writeFile(cwd, "src/consumer.ts", "import { InvoiceStatus } from './status.js'; export const current = InvoiceStatus.PAID;\n");
    const lane = "pre-ready-no-repeat";

    const first = await dispatch("read_file", {
      mode: "task_pack",
      query: "Add REFUNDED everywhere InvoiceStatus is used.",
      cwd,
      lane,
      taskEpoch: "new",
    });
    const firstDecision = first["decision"] as Record<string, unknown> | undefined;
    // Pre-condition: this pack is genuinely pre-ready (still discovering),
    // which is exactly the state recordExecutionContract's `state !== "ready"`
    // branch clears the fence for.
    expect(firstDecision?.["kind"], JSON.stringify(first)).toBe("discover");
    const prescribed = nextOf(first);
    expect(prescribed, JSON.stringify(first)).toEqual({
      tool: "search_files",
      arguments: { action: "find", queries: ["REFUNDED"] },
    });

    // THE NAMED ASSERTION: the fence non-armed zone, by name, not inference.
    expect(getExecutionFence(cwd), "pre-ready pack must not install an execution fence").toBeUndefined();

    // Execute the prescribed find (authoritative absence) and re-pack.
    await dispatch(prescribed!.tool, { ...prescribed!.arguments, cwd, lane });
    // Still fence-cleared: the absence-consuming call was a read, not a
    // contract state !== "ready" -> "ready" transition.
    expect(getExecutionFence(cwd), "a read-only search_files call must not install a fence").toBeUndefined();

    const task = first["task"] as Record<string, unknown> | undefined;
    const continued = await dispatch("read_file", {
      mode: "task_pack",
      query: "Add REFUNDED everywhere InvoiceStatus is used.",
      cwd,
      lane,
      task_handle: task?.["id"],
      ...(typeof task?.["state_version"] === "number" ? { expected_state_version: task["state_version"] } : {}),
    });
    const continuedNext = nextOf(continued);
    // A-3's own invariant, pinned explicitly for the fence-cleared zone: the
    // exact fingerprint the server itself just prescribed and consumed must
    // never reach the wire again in this taskEpoch.
    expect(
      continuedNext === undefined || JSON.stringify(continuedNext) !== JSON.stringify(prescribed),
      JSON.stringify(continued),
    ).toBe(true);
  });
});
