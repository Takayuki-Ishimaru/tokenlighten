/**
 * leanContinuationForVsCode.spec.ts — WP-V1 (2026-09-20).
 *
 * Direct, in-process proof of `protocol/envelope.ts`'s `canonicalToolCall`
 * leaning step (`leanContinuationForVsCode` / `continuationNeedsTaskHandle`),
 * in the same style `emittedToolCallShape.spec.ts` already uses for the
 * constructor's other attribution rules: `runWithProtocolCall({tool, args},
 * () => canonicalToolCall(...))` with no server spawn, so every field the
 * constructor does or does not attach is asserted exactly, deterministically.
 *
 * The end-to-end "does a leaned shape actually get served the same way"
 * claim is verified separately, against a REAL spawned server, in
 * rc/leanVsCodeCalls.rc.spec.ts (per AGENTS.md's own instruction to verify a
 * leaning claim before relying on it).
 */

import { describe, expect, it } from "vitest";
import { canonicalToolCall, runWithProtocolCall } from "../protocol/envelope.js";

const ROOT = "/workspace/root";

function readCallUnder(
  clientId: string | undefined,
  env: Record<string, string | undefined>,
  build: () => ReturnType<typeof canonicalToolCall>,
): ReturnType<typeof canonicalToolCall> {
  const saved: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return runWithProtocolCall({ tool: "read_file", args: { cwd: ROOT }, workspace: ROOT, clientId }, build);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe("WP-V1: leanContinuationForVsCode — cwd", () => {
  it("vscode + TL_LEAN_CALLS=1: drops cwd from a read_file continuation targeting the same workspace", () => {
    const call = readCallUnder("Visual Studio Code", { TL_LEAN_CALLS: "1" }, () =>
      canonicalToolCall("read_file", { cwd: ROOT, targets: [{ path: "src/a.ts" }] }));
    expect(call.arguments["cwd"]).toBeUndefined();
  });

  it("vscode + TL_LEAN_CALLS=1: keeps cwd when the continuation targets a DIFFERENT (continuationWorkspace) tree", () => {
    const call = readCallUnder("Visual Studio Code", { TL_LEAN_CALLS: "1" }, () =>
      runWithProtocolCall(
        { tool: "read_file", args: { cwd: ROOT }, workspace: ROOT, continuationWorkspace: "/other/root", clientId: "Visual Studio Code" },
        () => canonicalToolCall("read_file", { targets: [{ path: "src/a.ts" }] }),
      ));
    expect(call.arguments["cwd"]).toBe("/other/root");
  });

  it("vscode + TL_LEAN_CALLS=1: search_files continuations also drop cwd", () => {
    const call = readCallUnder("Visual Studio Code", { TL_LEAN_CALLS: "1" }, () =>
      canonicalToolCall("search_files", { cwd: ROOT, action: "find", queries: ["thing"] }));
    expect(call.arguments["cwd"]).toBeUndefined();
  });

  // Regression: `context.workspace` is populated by the EDIT dispatcher
  // ONLY (protocol/lineGutter.ts's own AnswerLineGutterContext doc comment)
  // -- a read_file/search_files call resolves into `codecTraceWorkspace`
  // instead. An earlier draft of this function checked ONLY
  // `context.continuationWorkspace === undefined` against a context that
  // never carried `workspace` for these two tools in production, so it
  // never fired outside this spec's own (unrealistic) test context.
  // Caught live via rc/leanVsCodeCalls.rc.spec.ts's real-server "discover"
  // decision.next, whose cwd stayed populated under vscode+TL_LEAN_CALLS=1
  // until this comparison was fixed to compare VALUES via the same
  // `workspace ?? codecTraceWorkspace` fallback lineGutter.ts uses.
  it("drops cwd when only codecTraceWorkspace (the real read_file/search_files dispatch field) is set, workspace absent", () => {
    const call = readCallUnder("Visual Studio Code", { TL_LEAN_CALLS: "1" }, () =>
      runWithProtocolCall(
        { tool: "read_file", args: { cwd: ROOT }, codecTraceWorkspace: ROOT, clientId: "Visual Studio Code" },
        () => canonicalToolCall("search_files", { cwd: ROOT, action: "find", queries: ["cancelReservation"] }),
      ));
    expect(call.arguments["cwd"]).toBeUndefined();
  });

  it("keeps cwd when it differs from codecTraceWorkspace (a genuinely different tree), workspace absent", () => {
    const call = readCallUnder("Visual Studio Code", { TL_LEAN_CALLS: "1" }, () =>
      runWithProtocolCall(
        { tool: "read_file", args: { cwd: ROOT }, codecTraceWorkspace: ROOT, clientId: "Visual Studio Code" },
        () => canonicalToolCall("search_files", { cwd: "/other/root", action: "find", queries: ["cancelReservation"] }),
      ));
    expect(call.arguments["cwd"]).toBe("/other/root");
  });

  it("edit_file continuations NEVER drop cwd, even under vscode + TL_LEAN_CALLS=1", () => {
    const call = readCallUnder("Visual Studio Code", { TL_LEAN_CALLS: "1" }, () =>
      canonicalToolCall("edit_file", { cwd: ROOT, edits: [{ path: "src/a.ts", search: "a", replace: "b" }] }));
    expect(call.arguments["cwd"]).toBe(ROOT);
  });

  it("a non-vscode client keeps cwd even with TL_LEAN_CALLS=1 (the vscode gate matters)", () => {
    const call = readCallUnder("claude-code", { TL_LEAN_CALLS: "1" }, () =>
      canonicalToolCall("read_file", { cwd: ROOT, targets: [{ path: "src/a.ts" }] }));
    expect(call.arguments["cwd"]).toBe(ROOT);
  });

  it("vscode without the flag keeps cwd (the flag gate matters)", () => {
    const call = readCallUnder("Visual Studio Code", { TL_LEAN_CALLS: undefined, TL_TURN_ECONOMY: undefined }, () =>
      canonicalToolCall("read_file", { cwd: ROOT, targets: [{ path: "src/a.ts" }] }));
    expect(call.arguments["cwd"]).toBe(ROOT);
  });

  it("vscode + TL_TURN_ECONOMY=1 (umbrella, no member override) also leans", () => {
    const call = readCallUnder("Visual Studio Code", { TL_LEAN_CALLS: undefined, TL_TURN_ECONOMY: "1" }, () =>
      canonicalToolCall("read_file", { cwd: ROOT, targets: [{ path: "src/a.ts" }] }));
    expect(call.arguments["cwd"]).toBeUndefined();
  });

  it("vscode + TL_TURN_ECONOMY=1 with an explicit TL_LEAN_CALLS=0 keeps cwd (member override wins)", () => {
    const call = readCallUnder("Visual Studio Code", { TL_TURN_ECONOMY: "1", TL_LEAN_CALLS: "0" }, () =>
      canonicalToolCall("read_file", { cwd: ROOT, targets: [{ path: "src/a.ts" }] }));
    expect(call.arguments["cwd"]).toBe(ROOT);
  });
});

describe("WP-V1: leanContinuationForVsCode — task.handle", () => {
  const env = { TL_LEAN_CALLS: "1" };

  it("drops task.handle from a read_file continuation that carries a qref", () => {
    const call = readCallUnder("Visual Studio Code", env, () =>
      canonicalToolCall("read_file", { qref: "q-1", targets: [{ path: "src/a.ts" }], task: { handle: "tlh_1" } }));
    expect(call.arguments["task"]).toBeUndefined();
    expect(call.arguments["qref"]).toBe("q-1");
  });

  it("drops task.handle from a plain targets-only read_file continuation (no query, no qref)", () => {
    const call = readCallUnder("Visual Studio Code", env, () =>
      canonicalToolCall("read_file", { targets: [{ handle: "hxyz", range: "1-10" }], task: { handle: "tlh_1" } }));
    expect(call.arguments["task"]).toBeUndefined();
  });

  it("KEEPS task.handle when the continuation still carries a query (task-pack negotiation, not a plain zoom)", () => {
    const call = readCallUnder("Visual Studio Code", env, () =>
      canonicalToolCall("read_file", { query: "how does X work", targets: [{ path: "src/a.ts" }], task: { handle: "tlh_1" } }));
    expect(call.arguments["task"]).toEqual({ handle: "tlh_1" });
  });

  it("KEEPS task.handle on a cursor continuation", () => {
    const call = readCallUnder("Visual Studio Code", env, () =>
      canonicalToolCall("read_file", { cursor: "c-1", task: { handle: "tlh_1" } }));
    expect(call.arguments["task"]).toEqual({ handle: "tlh_1" });
  });

  it("KEEPS task.handle on a task.pull:\"closure\" continuation", () => {
    const call = readCallUnder("Visual Studio Code", env, () =>
      canonicalToolCall("read_file", { targets: [{ path: "src/a.ts" }], task: { handle: "tlh_1", pull: "closure" } }));
    expect(call.arguments["task"]).toEqual({ handle: "tlh_1", pull: "closure" });
  });

  it("KEEPS task.handle on a challenge continuation", () => {
    const call = readCallUnder("Visual Studio Code", env, () =>
      canonicalToolCall("read_file", {
        targets: [{ path: "src/a.ts" }],
        task: { handle: "tlh_1", challenge: { certificate_id: "c1" } },
      }));
    expect(call.arguments["task"]).toEqual({ handle: "tlh_1", challenge: { certificate_id: "c1" } });
  });

  it("KEEPS task.handle when expected_state_version is present (dependentRequired ties it to handle)", () => {
    const call = readCallUnder("Visual Studio Code", env, () =>
      canonicalToolCall("read_file", {
        targets: [{ path: "src/a.ts" }],
        task: { handle: "tlh_1", expected_state_version: 3 },
      }));
    expect(call.arguments["task"]).toEqual({ handle: "tlh_1", expected_state_version: 3 });
  });

  it("search_files: drops task.handle on a plain find continuation", () => {
    const call = readCallUnder("Visual Studio Code", env, () =>
      canonicalToolCall("search_files", { action: "find", queries: ["thing"], task: { handle: "tlh_1" } }));
    expect(call.arguments["task"]).toBeUndefined();
  });

  it("search_files: KEEPS task.handle on a references cursor continuation", () => {
    const call = readCallUnder("Visual Studio Code", env, () =>
      canonicalToolCall("search_files", { action: "references", cursor: "c-1", task: { handle: "tlh_1" } }));
    expect(call.arguments["task"]).toEqual({ handle: "tlh_1" });
  });

  it("edit_file NEVER drops task.handle, even under vscode + TL_LEAN_CALLS=1", () => {
    const call = readCallUnder("Visual Studio Code", env, () =>
      canonicalToolCall("edit_file", {
        edits: [{ path: "src/a.ts", search: "a", replace: "b" }],
        task: { handle: "tlh_1" },
      }));
    expect(call.arguments["task"]).toEqual({ handle: "tlh_1" });
  });

  it("a non-vscode client keeps task.handle even with TL_LEAN_CALLS=1", () => {
    const call = readCallUnder("claude-code", env, () =>
      canonicalToolCall("read_file", { targets: [{ path: "src/a.ts" }], task: { handle: "tlh_1" } }));
    expect(call.arguments["task"]).toEqual({ handle: "tlh_1" });
  });

  it("vscode without the flag keeps task.handle", () => {
    const call = readCallUnder("Visual Studio Code", { TL_LEAN_CALLS: undefined, TL_TURN_ECONOMY: undefined }, () =>
      canonicalToolCall("read_file", { targets: [{ path: "src/a.ts" }], task: { handle: "tlh_1" } }));
    expect(call.arguments["task"]).toEqual({ handle: "tlh_1" });
  });
});
