import {afterEach, beforeEach, describe, expect, it} from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {taskPackSizePreview} from "../protocol/taskPackSizePreview.js";
import {handleTable} from "../util/handles.js";
import {laneTaskProfile} from "../state/laneTaskHandles.js";
import type {TaskPackResult} from "../features/task-pack/model.js";
import type {TaskExecutionContract} from "@tokenlighten/types";
import {canonicalToolCall, protocolCallContext, runWithProtocolCall} from "../protocol/envelope.js";
import {mintedRangedContinuationWindows, runWithSessionLane} from "../state/session.js";
import {sizedCompactNext} from "../protocol/readCallContinuation.js";
import {readCallCompactionAvailable} from "../state/readCallContinuationStore.js";
import {fitsInCap, fitsInCapUncompacted} from "../features/task-pack/readCodeTaskPack.js";
const gutter = process.env["TL_ANSWER_LINE_GUTTER"];
afterEach(() => {if (gutter === undefined) delete process.env["TL_ANSWER_LINE_GUTTER"]; else process.env["TL_ANSWER_LINE_GUTTER"] = gutter;});
describe("task pack wire size preview", () => {
  it("uses source-faithful wire projection without changing the input or lane state", () => {
    delete process.env["TL_ANSWER_LINE_GUTTER"];
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tl-size-preview-")));
    try {
      const source = "export function run() {\n  return 1;\n}\n";
      fs.writeFileSync(path.join(root, "a.ts"), source);
      const handle = handleTable.upsert({kind: "range", path: "a.ts", range: "1-3", workspaceRoot: root}).id;
      const result = {task_profile: "answer", coverage: "complete", missing: [],
        surfaces: [{handle, path: "a.ts", range: "1-3", role: "unknown", code: source, required: true}],
        route: {action: "answer_from_handles", reason: "construction metadata ".repeat(500), max_additional_tl_calls: 0},
      } as unknown as TaskPackResult;
      Object.freeze(result); const before = JSON.stringify(result), profile = laneTaskProfile(root, "");
      const bytes = taskPackSizePreview(result, "copilot-cli");
      expect(bytes).toBeGreaterThan(Buffer.byteLength(source));
      expect(bytes).toBeLessThan(Buffer.byteLength(before));
      expect(JSON.stringify(result)).toBe(before);
      expect(laneTaskProfile(root, "")).toBe(profile);
      expect(taskPackSizePreview(result, "claude-code")).toBeUndefined();
      process.env["TL_ANSWER_LINE_GUTTER"] = "1";
      expect(taskPackSizePreview(result, "copilot-cli")).toBeUndefined();
    } finally {fs.rmSync(root, {recursive: true, force: true});}
  });

  it("does not mint unsent discovery windows or suppress the subsequent real continuation", () => {
    delete process.env["TL_ANSWER_LINE_GUTTER"];
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tl-size-discovery-")));
    try {
      const source = "export function run() {\n  return 1;\n}\n";
      fs.writeFileSync(path.join(root, "a.ts"), source);
      const handle = handleTable.upsert({kind: "range", path: "a.ts", range: "1-1", workspaceRoot: root}).id;
      const contract = {version: 1, state: "needs-followup", readiness: "needs-followup",
        discovery_complete: false, next_action: "followup", max_additional_discovery_calls: 1,
        reason: "remaining source", typestate: {phase: "discovery", allowed_actions: ["read", "search"], challenge_required_for: []},
        next_call: {tool: "tl_read_file", arguments: {cwd: root, targets: [{path: "a.ts", range: "2-3"}], content: "auto"}},
      } satisfies TaskExecutionContract;
      const result = {task_profile: "answer", coverage: "partial", missing: ["source"],
        surfaces: [{handle, path: "a.ts", range: "1-1", role: "unknown", code: source.split("\n")[0],
          required: true, remaining_ranges: ["2-3"], content_completeness: "partial"}],
        execution_contract: contract,
      } as unknown as TaskPackResult;
      const before = JSON.stringify(result);
      runWithSessionLane("preview", () => {
        const context = {tool: "tl_read_file", clientId: "copilot-cli", codecTraceWorkspace: root,
          args: {cwd: root, lane: "preview"}};
        runWithProtocolCall(context, () => {
          const windows = [...(mintedRangedContinuationWindows(root, "a.ts") ?? [])];
          expect(taskPackSizePreview(result, "copilot-cli")).toBeGreaterThan(0);
          expect(mintedRangedContinuationWindows(root, "a.ts") ?? []).toEqual(windows);
          expect(protocolCallContext()).toBe(context);
          expect(protocolCallContext()?.sizePreview).toBeUndefined();
          expect(JSON.stringify(result)).toBe(before);
          canonicalToolCall("tl_read_file", contract.next_call.arguments);
          expect(mintedRangedContinuationWindows(root, "a.ts")).toContain("2-3");
        });
      });
    } finally {fs.rmSync(root, {recursive: true, force: true});}
  });

  it("falls back when exact source or the evidence handle binding cannot be proved", () => {
    delete process.env["TL_ANSWER_LINE_GUTTER"];
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tl-size-proof-")));
    const other = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tl-size-other-")));
    try {
      const source = Array.from({length: 200}, (_, i) => "const x" + i + " = " + i + ";").join("\n") + "\n";
      fs.writeFileSync(path.join(root, "a.ts"), source);
      fs.writeFileSync(path.join(other, "a.ts"), source);
      const handle = handleTable.upsert({kind: "range", path: "a.ts", range: "1-200", workspaceRoot: root}).id;
      const pack = (code = source, bodyPath = "a.ts") => ({task_profile: "answer", coverage: "complete", missing: [],
        surfaces: [{handle, path: bodyPath, range: "1-200", role: "unknown", code, required: true}],
      } as unknown as TaskPackResult);
      const result = pack();
      expect(taskPackSizePreview(result, "copilot-cli")).toBeGreaterThan(0);
      expect(taskPackSizePreview(pack(source.replace("x100 = 100", "changed = 100")), "copilot-cli")).toBeUndefined();
      expect(taskPackSizePreview(pack(source, "missing.ts"), "copilot-cli")).toBeUndefined();
      runWithProtocolCall({tool: "tl_read_file", clientId: "copilot-cli", codecTraceWorkspace: other}, () => {
        expect(taskPackSizePreview(result, "copilot-cli")).toBeUndefined();
      });
      fs.unlinkSync(path.join(root, "a.ts"));
      expect(taskPackSizePreview(result, "copilot-cli")).toBeUndefined();
    } finally {
      fs.rmSync(root, {recursive: true, force: true});
      fs.rmSync(other, {recursive: true, force: true});
    }
  });
});

// 2026-10-23 (codex-copilot-proxy r18 T03): the first reply moved with the length of
// the workspace path because the preview counted the `next` a discover pack is built
// with — the request restated as a query, every owed range and the workspace's
// absolute `cwd` — although the transport copy replaces it with one cursor call and
// drops its `cwd` under the configured root. The reply shipped without the path
// while its measured size carried it, and a pack filled to the cap shed a body for
// each extra path character past the margin.
describe("task pack wire size preview — the bytes the transport copy ships", () => {
  const query = "Explain what the OrderFlow class does around its transition table, briefly. ".repeat(6);
  const ranges = Array.from({length: 24}, (_, index) => `${100 + index * 10}-${104 + index * 10}`);

  /** A discover pack whose next restates `query` with 24 owed ranges, built in a workspace of the given directory depth. */
  function discoverPack(pad: string) {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tl-size-ship-" + pad)));
    const source = Array.from({length: 40}, (_, i) => "const x" + i + " = " + i + ";").join("\n") + "\n";
    fs.writeFileSync(path.join(root, "a.ts"), source);
    const handle = handleTable.upsert({kind: "range", path: "a.ts", range: "1-40", workspaceRoot: root}).id;
    const nextCall = {tool: "tl_read_file" as const, arguments: {cwd: root, query, targets: [{handle, ranges}], content: "auto"}};
    const contract = {version: 1, state: "needs-followup", readiness: "needs-followup",
      discovery_complete: false, next_action: "followup", max_additional_discovery_calls: 1,
      reason: "remaining source", typestate: {phase: "discovery", allowed_actions: ["read", "search"], challenge_required_for: []},
      next_call: nextCall} satisfies TaskExecutionContract;
    const result = {task_profile: "answer", coverage: "partial", missing: ["source"],
      surfaces: [{handle, path: "a.ts", range: "1-40", role: "unknown", code: source, required: true}],
      execution_contract: contract} as unknown as TaskPackResult;
    return {root, result, handle};
  }
  const sizeIn = (pack: ReturnType<typeof discoverPack>, configuredRoot: string | undefined, lane = ""): number => {
    delete process.env["TL_ANSWER_LINE_GUTTER"];
    return runWithSessionLane(lane, () => runWithProtocolCall({tool: "tl_read_file", clientId: "copilot-cli", codecTraceWorkspace: pack.root,
      args: {cwd: pack.root}, ...(configuredRoot !== undefined ? {configuredRoot} : {})}, () => taskPackSizePreview(pack.result, "copilot-cli")!));
  };

  it("does not count the workspace path, the query or the owed ranges of a next the transport copy replaces by a cursor call", () => {
    const short = discoverPack("a"), long = discoverPack("b".repeat(90));
    try {
      expect(long.root.length).toBeGreaterThan(short.root.length + 80);
      const atShort = sizeIn(short, short.root), atLong = sizeIn(long, long.root);
      expect(atShort, "same size at two path lengths").toBe(atLong);
      // …and it is the cursor call that is counted, not the restated request.
      const restated = Buffer.byteLength(JSON.stringify((short.result.execution_contract as TaskExecutionContract).next_call));
      expect(restated).toBeGreaterThan(600);
      // A root nobody published keeps the cwd counted: `"cwd":"<path>",` more than the root-equal call.
      expect(sizeIn(short, undefined) - atShort, "an unknown root keeps the cwd counted").toBe(Buffer.byteLength(`"cwd":${JSON.stringify(short.root)},`, "utf8"));
    } finally {
      fs.rmSync(short.root, {recursive: true, force: true});
      fs.rmSync(long.root, {recursive: true, force: true});
    }
  });

  it("counts the cwd of a call that keeps it: another root, or a root nobody published", () => {
    const short = discoverPack("c"), long = discoverPack("d".repeat(90));
    try {
      const other = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tl-size-other-root-")));
      try {
        // The workspace is not the configured root: the call ships with its path, which moves the size with the path.
        expect(sizeIn(long, other) - sizeIn(short, other)).toBe(long.root.length - short.root.length);
        expect(sizeIn(long, undefined) - sizeIn(short, undefined)).toBe(long.root.length - short.root.length);
      } finally { fs.rmSync(other, {recursive: true, force: true}); }
    } finally {
      fs.rmSync(short.root, {recursive: true, force: true});
      fs.rmSync(long.root, {recursive: true, force: true});
    }
  });

  it("a next that is no query-or-qref call with valid targets ships as it is", () => {
    const pack = discoverPack("e");
    try {
      const contract = pack.result.execution_contract as unknown as {next_call: {arguments: Record<string, unknown>}};
      const withQuery = sizeIn(pack, pack.root);
      contract.next_call.arguments["query"] = undefined; delete contract.next_call.arguments["query"];
      // Without a query or qref the call restates nothing: it is no plan the projection compacts, so its ranges count
      // (no cursor replaces it); its root cwd does not, for it ships without one (omitConfiguredRootCwdOnNext).
      const bare = sizeIn(pack, pack.root);
      expect(bare, "ranges counted").toBeGreaterThan(withQuery);
      expect(sizeIn(pack, undefined) - bare, "…and the cwd only where the root is not known").toBe(Buffer.byteLength(`"cwd":${JSON.stringify(pack.root)},`, "utf8"));
    } finally { fs.rmSync(pack.root, {recursive: true, force: true}); }
  });
});

// 2026-10-23 (codex-copilot-proxy r18 T03): the same pack measured with its `next` RESTATED — the
// request and every owed window as the pack builds the call, without the root `cwd` — is what the
// optional content of a discover (its `gaps`) is admitted against (readCodeTaskPack.ts
// `fitsInCapUncompacted`): room that exists only because the transport compacts the `next` belongs
// to the reply's rows. It must not move with the workspace's path either.
describe("task pack wire size preview — the restated next", () => {
  const query = "Explain what the OrderFlow class does around its transition table, briefly. ".repeat(6);
  const ranges = Array.from({length: 24}, (_, index) => `${100 + index * 10}-${104 + index * 10}`);
  function discoverPack(pad: string) {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tl-size-restated-" + pad)));
    const source = Array.from({length: 40}, (_, i) => "const x" + i + " = " + i + ";").join("\n") + "\n";
    fs.writeFileSync(path.join(root, "a.ts"), source);
    const handle = handleTable.upsert({kind: "range", path: "a.ts", range: "1-40", workspaceRoot: root}).id;
    const nextCall = {tool: "tl_read_file" as const, arguments: {cwd: root, query, targets: [{handle, ranges}], content: "auto"}};
    const contract = {version: 1, state: "needs-followup", readiness: "needs-followup",
      discovery_complete: false, next_action: "followup", max_additional_discovery_calls: 1,
      reason: "remaining source", typestate: {phase: "discovery", allowed_actions: ["read", "search"], challenge_required_for: []},
      next_call: nextCall} satisfies TaskExecutionContract;
    const result = {task_profile: "answer", coverage: "partial", missing: ["source"],
      surfaces: [{handle, path: "a.ts", range: "1-40", role: "unknown", code: source, required: true}],
      execution_contract: contract} as unknown as TaskPackResult;
    return {root, result};
  }
  const sizeIn = (pack: ReturnType<typeof discoverPack>, configuredRoot: string | undefined, form: "shipped" | "restated"): number => {
    delete process.env["TL_ANSWER_LINE_GUTTER"];
    return runWithSessionLane("", () => runWithProtocolCall({tool: "tl_read_file", clientId: "copilot-cli", codecTraceWorkspace: pack.root,
      args: {cwd: pack.root}, ...(configuredRoot !== undefined ? {configuredRoot} : {})}, () => taskPackSizePreview(pack.result, "copilot-cli", form)!));
  };

  it("counts the query and every owed range, so it is larger than the shipped size by about the call the cursor replaces, and the default is the shipped size", () => {
    const pack = discoverPack("a");
    try {
      const shipped = sizeIn(pack, pack.root, "shipped"), restated = sizeIn(pack, pack.root, "restated");
      const call = (pack.result.execution_contract as TaskExecutionContract).next_call;
      const withoutCwd = Buffer.byteLength(JSON.stringify({...call, arguments: {...(call!.arguments as Record<string, unknown>), cwd: undefined}}));
      expect(restated - shipped, "the restated call is counted, the cursor call is not").toBeGreaterThan(withoutCwd - 400);
      expect(restated - shipped).toBeLessThan(withoutCwd + 400);
      delete process.env["TL_ANSWER_LINE_GUTTER"];
      expect(runWithSessionLane("", () => runWithProtocolCall({tool: "tl_read_file", clientId: "copilot-cli", codecTraceWorkspace: pack.root,
        args: {cwd: pack.root}, configuredRoot: pack.root}, () => taskPackSizePreview(pack.result, "copilot-cli")))).toBe(shipped);
    } finally { fs.rmSync(pack.root, {recursive: true, force: true}); }
  });

  it("does not count the workspace's path under the configured root: the same size at two path lengths", () => {
    const short = discoverPack("b"), long = discoverPack("c".repeat(90));
    try {
      expect(long.root.length).toBeGreaterThan(short.root.length + 80);
      expect(sizeIn(short, short.root, "restated")).toBe(sizeIn(long, long.root, "restated"));
    } finally {
      fs.rmSync(short.root, {recursive: true, force: true});
      fs.rmSync(long.root, {recursive: true, force: true});
    }
  });

  it("counts the cwd of a call that ships with it: another root, or a root nobody published", () => {
    const short = discoverPack("d"), long = discoverPack("e".repeat(90));
    try {
      const other = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tl-size-restated-other-")));
      try {
        expect(sizeIn(long, other, "restated") - sizeIn(short, other, "restated")).toBe(long.root.length - short.root.length);
        expect(sizeIn(long, undefined, "restated") - sizeIn(short, undefined, "restated")).toBe(long.root.length - short.root.length);
      } finally { fs.rmSync(other, {recursive: true, force: true}); }
    } finally {
      fs.rmSync(short.root, {recursive: true, force: true});
      fs.rmSync(long.root, {recursive: true, force: true});
    }
  });

  it("is the shipped size for a pack with nothing to compact or restate: no discover next", () => {
    const pack = discoverPack("f");
    try {
      const contract = pack.result.execution_contract as unknown as Record<string, unknown>;
      delete contract["next_call"];
      expect(sizeIn(pack, pack.root, "restated")).toBe(sizeIn(pack, pack.root, "shipped"));
    } finally { fs.rmSync(pack.root, {recursive: true, force: true}); }
  });
});

// 2026-10-23 (codex-copilot-proxy r18 T03): the full execution contract — the capability gaps that ride a
// discover as `decision.gaps` — is optional content, admitted only when the pack fits its cap both as the
// transport ships it and with its `next` restated. The recorded Copilot T03 discovers carried no gaps
// because the build that recorded them counted the restated call; counting the shipped one alone admitted
// 369 B of gaps into every one of them (t03OwedRows.spec.ts holds the chain against the recording).
describe("fitsInCapUncompacted — optional contract content is admitted only when the pack fits with its next restated", () => {
  const query = "Explain what the OrderFlow class does around its transition table, briefly. ".repeat(6);
  const ranges = Array.from({length: 24}, (_, index) => `${100 + index * 10}-${104 + index * 10}`);
  function packOf(lines: number) {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tl-admit-")));
    const source = Array.from({length: lines}, (_, i) => "const x" + i + " = " + i + ";").join("\n") + "\n";
    fs.writeFileSync(path.join(root, "a.ts"), source);
    const handle = handleTable.upsert({kind: "range", path: "a.ts", range: `1-${lines}`, workspaceRoot: root}).id;
    const nextCall = {tool: "tl_read_file" as const, arguments: {cwd: root, query, targets: [{handle, ranges}], content: "auto"}};
    const contract = {version: 1, state: "needs-followup", readiness: "needs-followup",
      discovery_complete: false, next_action: "followup", max_additional_discovery_calls: 1,
      reason: "remaining source", typestate: {phase: "discovery", allowed_actions: ["read", "search"], challenge_required_for: []},
      next_call: nextCall} satisfies TaskExecutionContract;
    const result = {task_profile: "answer", coverage: "partial", missing: ["source"],
      surfaces: [{handle, path: "a.ts", range: `1-${lines}`, role: "unknown", code: source, required: true}],
      execution_contract: contract} as unknown as TaskPackResult;
    return {root, result};
  }
  const states = (lines: number, client = "copilot-cli"): {root: string; exact: boolean; uncompacted: boolean} => {
    const pack = packOf(lines);
    delete process.env["TL_ANSWER_LINE_GUTTER"];
    try {
      return runWithSessionLane("", () => runWithProtocolCall({tool: "tl_read_file", clientId: client, codecTraceWorkspace: pack.root,
        args: {cwd: pack.root}, configuredRoot: pack.root}, () => ({root: pack.root, exact: fitsInCap(pack.result), uncompacted: fitsInCapUncompacted(pack.result)})));
    } finally { fs.rmSync(pack.root, {recursive: true, force: true}); }
  };

  const stateOf = (lines: number): "both" | "shipped-only" | "neither" => {
    const {exact, uncompacted} = states(lines);
    expect(exact || !uncompacted, `${lines} lines: fitting restated implies fitting as shipped`).toBe(true);
    return exact ? (uncompacted ? "both" : "shipped-only") : "neither";
  };

  it("fits both ways well below the cap, only as shipped in a band under it, and neither above it — in that order, with the band as wide as the restated call is longer", () => {
    // Coarse: the first size that no longer fits both ways. Fine: one line at a time around it.
    let edge = 100;
    while (stateOf(edge) === "both" && edge < 8000) edge += 50;
    expect(edge, "a pack large enough to leave the first state").toBeLessThan(8000);
    const seen: string[] = [];
    const first = new Map<string, number>(), last = new Map<string, number>();
    for (let lines = edge - 50; lines <= edge + 400; lines += 1) {
      const state = stateOf(lines);
      if (seen.at(-1) !== state) seen.push(state);
      if (!first.has(state)) first.set(state, lines);
      last.set(state, lines);
    }
    expect(seen, "monotone in the pack's size").toEqual(["both", "shipped-only", "neither"]);
    // About 20 B a line; the restated call is some 0.8 KB longer than the cursor call that replaces it.
    const band = last.get("shipped-only")! - first.get("shipped-only")! + 1;
    expect(band, "a band where the compaction alone brings the pack under the cap").toBeGreaterThanOrEqual(20);
    expect(band).toBeLessThan(200);
  });

  it("is fitsInCap for a client whose packs are not previewed", () => {
    for (const lines of [100, 1000, 2000, 3000, 4000, 6000]) {
      const {exact, uncompacted} = states(lines, "claude-code");
      expect(uncompacted).toBe(exact);
    }
  });
});

describe("sizedCompactNext — the cursor call the transport copy ships in place of a discover next", () => {
  const resolve = () => undefined;
  const workspace = "/work/tree/root";
  type Call = {tool: string; arguments: Record<string, unknown>};
  const base = (): Call => ({tool: "tl_read_file", arguments: {cwd: workspace, query: "Explain the flow.".repeat(8),
    targets: [{path: "src/a.ts", ranges: ["10-20", "30-40"]}], content: "auto"}});

  it("is a placeholder alias of the real alias's length; the cwd stays only outside the configured root; the lane and a CAS rider ride", () => {
    expect(sizedCompactNext(base(), workspace, "", workspace, resolve)).toEqual({tool: "tl_read_file", arguments: {cursor: "tlc_s1_xxxxxxxxxxxx_xxxxxxxxxxxxxxxxxxxxxx"}});
    expect(sizedCompactNext(base(), workspace, "", "/another/root", resolve)?.arguments).toEqual({cwd: workspace, cursor: "tlc_s1_xxxxxxxxxxxx_xxxxxxxxxxxxxxxxxxxxxx"});
    expect(sizedCompactNext(base(), workspace, "", undefined, resolve)?.arguments).toHaveProperty("cwd", workspace);
    const lane = base(); lane.arguments["lane"] = "agent-a";
    expect(sizedCompactNext(lane, workspace, "agent-a", workspace, resolve)?.arguments).toEqual({lane: "agent-a", cursor: "tlc_s1_xxxxxxxxxxxx_xxxxxxxxxxxxxxxxxxxxxx"});
    const rider = base(); rider.arguments["task"] = {expected_state_version: 3};
    expect(sizedCompactNext(rider, workspace, "", workspace, resolve)?.arguments).toEqual({cursor: "tlc_s1_xxxxxxxxxxxx_xxxxxxxxxxxxxxxxxxxxxx", task: {expected_state_version: 3}});
    expect("tlc_s1_xxxxxxxxxxxx_xxxxxxxxxxxxxxxxxxxxxx".length).toBe(42);
  });

  it.each<[string, (call: Call) => unknown]>([
    ["another tool", call => { call.tool = "tl_search_files"; }],
    ["a cursor already", call => { call.arguments["cursor"] = "tlc_s1_aaaaaaaaaaaa_bbbbbbbbbbbbbbbbbbbbbb"; }],
    ["a cwd that is not the workspace", call => { call.arguments.cwd = workspace + "-x"; }],
    ["a lane that is not the call's", call => { call.arguments["lane"] = "other"; }],
    ["a new task epoch", call => { call.arguments["task"] = {epoch: "new"}; }],
    ["neither a query nor a qref", call => { delete call.arguments["query"]; }],
    ["both a query and a qref", call => { call.arguments["qref"] = "q-0123456789abcdef"; }],
    ["no targets", call => { delete call.arguments["targets"]; }],
    ["a target with neither range nor ranges", call => { call.arguments.targets = [{path: "src/a.ts"}]; }],
    ["a path that is not workspace-relative", call => { call.arguments.targets = [{path: "../outside.ts", ranges: ["1-2"]}]; }],
    ["more than 64 windows", call => { call.arguments.targets = [{path: "src/a.ts", ranges: Array.from({length: 65}, (_, i) => `${i * 3 + 1}-${i * 3 + 2}`)}]; }],
  ])("is not compacted for %s: undefined, the call ships as it stands", (_name, change) => {
    const call = base();
    change(call);
    expect(sizedCompactNext(call, workspace, "", workspace, resolve)).toBeUndefined();
  });

  it("is not compacted when the cursor call would not be shorter than the call", () => {
    const short: Call = {tool: "tl_read_file", arguments: {cwd: workspace, query: "x", targets: [{path: "a.ts", range: "1-2"}]}};
    expect(sizedCompactNext(short, workspace, "", workspace, resolve)).toBeUndefined();
    expect(sizedCompactNext("not a call", workspace, "", workspace, resolve)).toBeUndefined();
    expect(sizedCompactNext(undefined, workspace, "", workspace, resolve)).toBeUndefined();
  });
});

// 2026-10-23 (independent review of T03 A/B, F1): the preview counts the cursor call the transport
// copy ships in place of a discover's `next` -- but only where a cursor can be issued. With the state
// store off (TOKENLIGHTEN_STATE_STORE=off), unable to open, or read-only, the plan cannot be persisted:
// `mintReadCallContinuation` publishes nothing and the pack's own call ships, the request restated and
// every owed window listed. A pack fitted to the 42-character cursor then outgrew its cap by the query,
// the windows and (with the root `cwd` kept) the workspace's path -- 18,492 B against 18,432 at a path of
// 846 characters. What ships without a cursor is the restated call WITHOUT the root `cwd`
// (the transport drops it under the configured root, as it does for every read next: `omitConfiguredRootCwdOnNext`),
// which is what the preview counts there.
describe("task pack wire size preview — where no cursor can be issued", () => {
  const query = "Explain what the OrderFlow class does around its transition table, briefly. ".repeat(6);
  const ranges = Array.from({length: 24}, (_, index) => `${100 + index * 10}-${104 + index * 10}`);
  const storeSetting = process.env["TOKENLIGHTEN_STATE_STORE"];
  afterEach(() => {if (storeSetting === undefined) delete process.env["TOKENLIGHTEN_STATE_STORE"]; else process.env["TOKENLIGHTEN_STATE_STORE"] = storeSetting;});
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) {
      try {fs.chmodSync(path.join(root, ".tokenlighten", "state"), 0o700);} catch {/* never made read-only */}
      fs.rmSync(root, {recursive: true, force: true});
    }
  });
  function discoverPack(pad: string) {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tl-size-nocursor-" + pad)));
    roots.push(root);
    const source = Array.from({length: 40}, (_, i) => "const x" + i + " = " + i + ";").join("\n") + "\n";
    fs.writeFileSync(path.join(root, "a.ts"), source);
    const handle = handleTable.upsert({kind: "range", path: "a.ts", range: "1-40", workspaceRoot: root}).id;
    const nextCall = {tool: "tl_read_file" as const, arguments: {cwd: root, query, targets: [{handle, ranges}], content: "auto"}};
    const contract = {version: 1, state: "needs-followup", readiness: "needs-followup",
      discovery_complete: false, next_action: "followup", max_additional_discovery_calls: 1,
      reason: "remaining source", typestate: {phase: "discovery", allowed_actions: ["read", "search"], challenge_required_for: []},
      next_call: nextCall} satisfies TaskExecutionContract;
    const result = {task_profile: "answer", coverage: "partial", missing: ["source"],
      surfaces: [{handle, path: "a.ts", range: "1-40", role: "unknown", code: source, required: true}],
      execution_contract: contract} as unknown as TaskPackResult;
    return {root, result};
  }
  const sizeIn = (pack: ReturnType<typeof discoverPack>, configuredRoot: string | undefined, form: "shipped" | "restated"): number => {
    delete process.env["TL_ANSWER_LINE_GUTTER"];
    return runWithSessionLane("", () => runWithProtocolCall({tool: "tl_read_file", clientId: "copilot-cli", codecTraceWorkspace: pack.root,
      args: {cwd: pack.root}, ...(configuredRoot !== undefined ? {configuredRoot} : {})}, () => taskPackSizePreview(pack.result, "copilot-cli", form)!));
  };
  const readOnlyAfterOpening = (pack: ReturnType<typeof discoverPack>): void => {
    // The store opens (its meta file loads) and fails only when a writer takes its lock: the permission is what tells.
    expect(readCallCompactionAvailable(pack.root)).toBe(true);
    fs.chmodSync(path.join(pack.root, ".tokenlighten", "state"), 0o500);
  };
  const canMakeReadOnly = process.platform !== "win32" && (process.getuid?.() ?? 1) !== 0;

  it("with the store off the call that ships is the restated one: the shipped size is the restated size, larger than the cursor call's by about the call, and the same at two path lengths", () => {
    const short = discoverPack("a"), long = discoverPack("b".repeat(90));
    const cursor = sizeIn(short, short.root, "shipped");
    process.env["TOKENLIGHTEN_STATE_STORE"] = "off";
    expect(readCallCompactionAvailable(short.root)).toBe(false);
    const shipped = sizeIn(short, short.root, "shipped");
    expect(shipped, "the restated call ships").toBe(sizeIn(short, short.root, "restated"));
    const call = (short.result.execution_contract as TaskExecutionContract).next_call!;
    const withoutCwd = Buffer.byteLength(JSON.stringify({...call, arguments: {...(call.arguments as Record<string, unknown>), cwd: undefined}}));
    expect(shipped - cursor, "the query and every owed window are counted").toBeGreaterThan(withoutCwd - 400);
    expect(shipped - cursor).toBeLessThan(withoutCwd + 400);
    expect(long.root.length).toBeGreaterThan(short.root.length + 80);
    expect(sizeIn(long, long.root, "shipped"), "no path in what ships").toBe(shipped);
  });

  it("with the store off and no published root the call ships with its cwd, so its size moves with the path", () => {
    const short = discoverPack("c"), long = discoverPack("d".repeat(90));
    process.env["TOKENLIGHTEN_STATE_STORE"] = "off";
    expect(sizeIn(long, undefined, "shipped") - sizeIn(short, undefined, "shipped")).toBe(long.root.length - short.root.length);
    const other = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tl-size-nocursor-other-")));
    roots.push(other);
    expect(sizeIn(long, other, "shipped") - sizeIn(short, other, "shipped"), "another root than the workspace").toBe(long.root.length - short.root.length);
  });

  it.skipIf(!canMakeReadOnly)("a state directory that opens but takes no writer is as good as no store: the restated size, where the same pack counted the cursor before", () => {
    const pack = discoverPack("e");
    const cursor = sizeIn(pack, pack.root, "shipped");
    readOnlyAfterOpening(pack);
    expect(readCallCompactionAvailable(pack.root)).toBe(false);
    expect(sizeIn(pack, pack.root, "shipped")).toBe(sizeIn(pack, pack.root, "restated"));
    expect(sizeIn(pack, pack.root, "shipped")).toBeGreaterThan(cursor + 400);
  });

  it("with a working store nothing changes: the cursor call is what is counted, at any path length", () => {
    const short = discoverPack("f"), long = discoverPack("g".repeat(90));
    expect(readCallCompactionAvailable(short.root)).toBe(true);
    expect(sizeIn(short, short.root, "shipped")).toBe(sizeIn(long, long.root, "shipped"));
    expect(sizeIn(short, short.root, "restated") - sizeIn(short, short.root, "shipped")).toBeGreaterThan(400);
  });

  it("readCallCompactionAvailable: a workspace that is no directory, a store switched off and one that cannot be written are none", () => {
    const pack = discoverPack("h");
    expect(readCallCompactionAvailable(pack.root)).toBe(true);
    expect(readCallCompactionAvailable(path.join(pack.root, "does", "not", "exist"))).toBe(false);
    process.env["TOKENLIGHTEN_STATE_STORE"] = "off";
    expect(readCallCompactionAvailable(pack.root)).toBe(false);
  });
});

// 2026-10-24 (generality audit §3.7): the preview counts every `tl_read_file` call the reply publishes as a
// next the way the transport ships it, WITHOUT the root `cwd` -- through the very function the transport uses
// (omitConfiguredRootCwdOnNext) -- whatever the call's shape. Until then it dropped the cwd only from a
// discover's `decision.next` (and the copies `limit` held): in the shipped form where a cursor replaced the call
// or it restated a query or a qref, in the restated form from that one `next` alone. A `{qref, targets, cwd,
// task}` re-pack (the discovery bundle: whole files, no window to bind to a cursor) kept its path in the count
// and in the reply, and a pack filled to its cap shed a row for every path character past the margin.
describe("task pack wire size preview — a read next of any shape is counted without the root cwd, as it ships", () => {
  const query = "Explain what the OrderFlow class does around its transition table, briefly. ".repeat(6);
  const ranges = Array.from({length: 24}, (_, index) => `${100 + index * 10}-${104 + index * 10}`);
  const storeSetting = process.env["TOKENLIGHTEN_STATE_STORE"];
  afterEach(() => {if (storeSetting === undefined) delete process.env["TOKENLIGHTEN_STATE_STORE"]; else process.env["TOKENLIGHTEN_STATE_STORE"] = storeSetting;});
  const roots: string[] = [];
  afterEach(() => {for (const root of roots.splice(0)) fs.rmSync(root, {recursive: true, force: true});});
  /** The call a pack is built with, given its workspace root and the handle of its served window; `cursor`: the transport replaces it by a cursor call where one can be issued. */
  type Shape = (root: string, handle: string) => Record<string, unknown>;
  const shapes: Array<[string, Shape, boolean]> = [
    ["a qref re-pack over bare-path targets (the discovery bundle)", root => ({qref: "q-0123456789abcdef", targets: [{path: "a.ts"}, {path: "b.ts"}], cwd: root, task: {handle: "tlh_task_v1_example"}}), false],
    ["a qref re-pack over owed windows", (root, handle) => ({qref: "q-0123456789abcdef", targets: [{handle, ranges}], content: "auto", cwd: root}), true],
    ["a window list with no request or qref", (root, handle) => ({targets: [{handle, ranges}], content: "auto", cwd: root}), false],
    ["a restated request that no cursor can replace (a new task epoch)", (root, handle) => ({query, targets: [{handle, ranges}], cwd: root, task: {epoch: "new"}}), false],
    ["a restated request a cursor replaces", (root, handle) => ({cwd: root, query, targets: [{handle, ranges}], content: "auto"}), true],
  ];
  function discoverPack(pad: string, shape: Shape) {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tl-size-shape-" + pad)));
    roots.push(root);
    const source = Array.from({length: 40}, (_, i) => "const x" + i + " = " + i + ";").join("\n") + "\n";
    fs.writeFileSync(path.join(root, "a.ts"), source);
    const handle = handleTable.upsert({kind: "range", path: "a.ts", range: "1-40", workspaceRoot: root}).id;
    const args = shape(root, handle);
    const contract = {version: 1, state: "needs-followup", readiness: "needs-followup",
      discovery_complete: false, next_action: "followup", max_additional_discovery_calls: 1,
      reason: "remaining source", typestate: {phase: "discovery", allowed_actions: ["read", "search"], challenge_required_for: []},
      next_call: {tool: "tl_read_file" as const, arguments: args}} satisfies TaskExecutionContract;
    const result = {task_profile: "answer", coverage: "partial", missing: ["source"],
      surfaces: [{handle, path: "a.ts", range: "1-40", role: "unknown", code: source, required: true}],
      execution_contract: contract} as unknown as TaskPackResult;
    return {root, result};
  }
  const sizeIn = (pack: ReturnType<typeof discoverPack>, configuredRoot: string | undefined, form: "shipped" | "restated"): number => {
    delete process.env["TL_ANSWER_LINE_GUTTER"];
    return runWithSessionLane("", () => runWithProtocolCall({tool: "tl_read_file", clientId: "copilot-cli", codecTraceWorkspace: pack.root,
      args: {cwd: pack.root}, ...(configuredRoot !== undefined ? {configuredRoot} : {})}, () => taskPackSizePreview(pack.result, "copilot-cli", form)!));
  };

  describe.each(["a working state store", "no state store"])("with %s", mode => {
    const forms = ["shipped", "restated"] as const;
    const issuable = mode === "a working state store";
    if (!issuable) beforeEach(() => {process.env["TOKENLIGHTEN_STATE_STORE"] = "off";});

    it.each(shapes)("%s: the same size at two path lengths, in both forms", (_name, shape) => {
      const short = discoverPack("a", shape), long = discoverPack("b".repeat(90), shape);
      expect(long.root.length).toBeGreaterThan(short.root.length + 80);
      for (const form of forms) expect(sizeIn(long, long.root, form), form).toBe(sizeIn(short, short.root, form));
    });

    it.each(shapes)("%s: what the published root withholds is the cwd of the calls that name it, a whole number of `\"cwd\":<path>,` members and nothing else", (_name, shape) => {
      const pack = discoverPack("c", shape), member = Buffer.byteLength(`"cwd":${JSON.stringify(pack.root)},`, "utf8");
      for (const form of forms) {
        const withheld = sizeIn(pack, undefined, form) - sizeIn(pack, pack.root, form);
        expect(withheld, form).toBeGreaterThan(0);
        expect(withheld % member, `${form}: ${withheld} B is not a whole number of ${member}-byte members`).toBe(0);
      }
    });

    it.each(shapes)("%s: its cwd is counted where it ships with it, another root than the workspace or a root nobody published", (_name, shape) => {
      const short = discoverPack("e", shape), long = discoverPack("f".repeat(90), shape);
      const other = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tl-size-shape-other-")));
      roots.push(other);
      for (const form of forms) {
        expect(sizeIn(long, other, form) - sizeIn(short, other, form), form + ", another root").toBe(long.root.length - short.root.length);
        expect(sizeIn(long, undefined, form) - sizeIn(short, undefined, form), form + ", no published root").toBe(long.root.length - short.root.length);
      }
    });

    it("the form differs only by the next a cursor replaces", () => {
      for (const [name, shape, cursor] of shapes) {
        const pack = discoverPack("g", shape), restated = sizeIn(pack, pack.root, "restated"), shipped = sizeIn(pack, pack.root, "shipped");
        if (cursor && issuable) expect(restated - shipped, `${name}: a cursor replaces the call`).toBeGreaterThan(200);
        else expect(restated, `${name}: the call ships as it is`).toBe(shipped);
      }
    });
  });
});
