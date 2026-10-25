import {afterEach, describe, expect, it} from "vitest";
import {
  clearSourceCapsules, finalizeSourceCapsules, runWithSourceCapsuleCall,
  sourceCapsulePrior, stageSourceCapsules,
} from "../features/task-pack/sourceCapsuleCallScope.js";
import type {SourceBodyCapsule} from "../features/task-pack/sourceBodyCapsule.js";
import {runWithRequestSignal} from "../util/requestCancellation.js";

const key = "/workspace\0lane:a";
const capsule: SourceBodyCapsule = Object.freeze({path: "src/a.ts", sha: "sha256:current",
  handle: "h-a", startLine: 1, endLine: 1, body: "export const a = 1;\n"});
const row = {capsule, taskBinding: "binding-a", body: capsule.body, range: "1-1"};
const wire = (evidence: unknown[] = [{path: capsule.path, handle: capsule.handle, range: "1-1", body: capsule.body}]) =>
  JSON.stringify({kind: "read.task_pack", task: {id: "authenticated"}, evidence});

afterEach(() => clearSourceCapsules());

describe("outer source capsule residency", () => {
  it("keeps staged and same-outer emissions invisible until final evidence confirms them", () => {
    runWithSourceCapsuleCall(() => {
      stageSourceCapsules(key, [row]);
      stageSourceCapsules(key, [row]); // repeated internal persist is bounded and idempotent
      expect(sourceCapsulePrior(key)).toEqual([]);
      finalizeSourceCapsules(key, wire(), handle => handle === "authenticated" ? "binding-a" : undefined);
    });
    runWithSourceCapsuleCall(() => expect(sourceCapsulePrior(key)).toEqual([{capsule, taskBinding: "binding-a"}]));
  });

  it("promotes an exact numbered source prefix when the staged range is wider than its capsule", () => {
    const prefixCapsule: SourceBodyCapsule = Object.freeze({path: "src/a.ts", sha: "sha256:prefix",
      handle: "h-prefix", startLine: 265, endLine: 266, body: "alpha\nbeta\n"});
    const prefixRow = {capsule: prefixCapsule, taskBinding: "binding-a", body: prefixCapsule.body, range: "265-288"};
    const numbered = "265|alpha\n266|beta\n";
    const finalWire = wire([{path: prefixCapsule.path, handle: prefixCapsule.handle, range: "265-288", body: numbered}]);
    runWithSourceCapsuleCall(() => {
      stageSourceCapsules(key, [prefixRow]);
      expect(sourceCapsulePrior(key)).toEqual([]);
      finalizeSourceCapsules(key, finalWire, handle => handle === "authenticated" ? "binding-a" : undefined);
      expect(sourceCapsulePrior(key)).toEqual([]);
    });
    runWithSourceCapsuleCall(() => expect(sourceCapsulePrior(key)).toEqual([{capsule: prefixCapsule, taskBinding: "binding-a"}]));
  });

  it.each([
    ["wrong gutter positions", {body: "264|alpha\n266|beta\n"}],
    ["a continuation marker", {body: "265|alpha\n~\n"}],
    ["changed source bytes", {body: "265|altered\n266|beta\n"}],
    ["missing a source line", {body: "265|alpha\n"}],
    ["missing the final LF", {body: "265|alpha\n266|beta"}],
    ["an appended foreign line", {body: "265|alpha\n266|beta\n999|foreign\n"}],
    ["a mismatched handle", {handle: "h-other"}],
    ["a mismatched path", {path: "src/other.ts"}],
  ] as const)("does not promote a numbered source prefix with %s", (_label, change) => {
    const prefixCapsule: SourceBodyCapsule = Object.freeze({path: "src/a.ts", sha: "sha256:prefix",
      handle: "h-prefix", startLine: 265, endLine: 266, body: "alpha\nbeta\n"});
    const prefixRow = {capsule: prefixCapsule, taskBinding: "binding-a", body: prefixCapsule.body, range: "265-288"};
    const evidence = {path: prefixCapsule.path, handle: prefixCapsule.handle, range: "265-288", body: "265|alpha\n266|beta\n", ...change};
    runWithSourceCapsuleCall(() => {
      stageSourceCapsules(key, [prefixRow]);
      finalizeSourceCapsules(key, wire([evidence]), () => "binding-a");
    });
    expect(sourceCapsulePrior(key)).toEqual([]);
  });

  it("does not promote numbered source bytes staged under a different task binding", () => {
    const prefixCapsule: SourceBodyCapsule = Object.freeze({path: "src/a.ts", sha: "sha256:prefix",
      handle: "h-prefix", startLine: 265, endLine: 266, body: "alpha\nbeta\n"});
    const prefixRow = {capsule: prefixCapsule, taskBinding: "other-binding", body: prefixCapsule.body, range: "265-288"};
    const finalWire = wire([{path: prefixCapsule.path, handle: prefixCapsule.handle, range: "265-288", body: "265|alpha\n266|beta\n"}]);
    runWithSourceCapsuleCall(() => {
      stageSourceCapsules(key, [prefixRow]);
      finalizeSourceCapsules(key, finalWire, () => "binding-a");
    });
    expect(sourceCapsulePrior(key)).toEqual([]);
  });

  it.each([
    ["refusal", JSON.stringify({kind: "refusal", task: {id: "authenticated"}, evidence: []})],
    ["dropped body", wire([{path: capsule.path, handle: capsule.handle, range: "1-1"}])],
    ["changed body", wire([{path: capsule.path, handle: capsule.handle, range: "1-1", body: "different"}])],
  ])("does not promote an outer %s result", (_label, text) => {
    runWithSourceCapsuleCall(() => {
      stageSourceCapsules(key, [row]);
      finalizeSourceCapsules(key, text, () => "binding-a");
    });
    expect(sourceCapsulePrior(key)).toEqual([]);
  });

  it("preserves prior state on cancellation, rejects a wrong binding, and resets by exact lane key", () => {
    runWithSourceCapsuleCall(() => {
      stageSourceCapsules(key, [row]);
      finalizeSourceCapsules(key, wire(), () => "binding-a");
    });
    expect(() => runWithSourceCapsuleCall(() => {
      stageSourceCapsules(key, [{...row, capsule: {...capsule, sha: "sha256:new"}}]);
      throw new Error("outer dispatch cancelled");
    })).toThrow("outer dispatch cancelled");
    runWithSourceCapsuleCall(() => {
      stageSourceCapsules(key, [{...row, taskBinding: "other-task"}]);
      finalizeSourceCapsules(key, wire(), () => "binding-a");
    });
    expect(sourceCapsulePrior(key)).toEqual([{capsule, taskBinding: "binding-a"}]);
    clearSourceCapsules("/workspace\0lane:b");
    expect(sourceCapsulePrior(key)).toEqual([{capsule, taskBinding: "binding-a"}]);
    clearSourceCapsules(key);
    expect(sourceCapsulePrior(key)).toEqual([]);
  });

  it("does not promote after request cancellation", () => {
    const controller = new AbortController();
    runWithSourceCapsuleCall(() => {
      stageSourceCapsules(key, [row]);
      runWithRequestSignal(controller.signal, () => {
        controller.abort();
        finalizeSourceCapsules(key, wire(), () => "binding-a");
      });
    });
    expect(sourceCapsulePrior(key)).toEqual([]);
  });

  it("invalidates active epoch scopes without clearing a peer lane", async () => {
    const peerKey = "/workspace\0lane:b";
    const peerRow = {...row, taskBinding: "peer-binding"};
    runWithSourceCapsuleCall(() => {
      stageSourceCapsules(key, [row]);
      finalizeSourceCapsules(key, wire(), () => "binding-a");
      stageSourceCapsules(peerKey, [peerRow]);
      finalizeSourceCapsules(peerKey, wire(), () => "peer-binding");
    });

    // The declared epoch clear happens before this call first observes the
    // key, so its new task may stage and commit normally.
    runWithSourceCapsuleCall(() => {
      clearSourceCapsules(key); // task.epoch:new for this workspace/lane
      stageSourceCapsules(key, [row]);
      finalizeSourceCapsules(key, wire(), () => "binding-a");
    });
    expect(sourceCapsulePrior(key)).toEqual([{capsule, taskBinding: "binding-a"}]);
    expect(sourceCapsulePrior(peerKey)).toEqual([{capsule, taskBinding: "peer-binding"}]);

    let announceStaged!: () => void;
    let release!: () => void;
    const staged = new Promise<void>(resolve => {announceStaged = resolve;});
    const continueCall = new Promise<void>(resolve => {release = resolve;});
    const staleCall = runWithSourceCapsuleCall(async () => {
      stageSourceCapsules(key, [{...row, capsule: {...capsule, sha: "sha256:stale"}}]);
      expect(sourceCapsulePrior(key)).toEqual([{capsule, taskBinding: "binding-a"}]);
      announceStaged();
      await continueCall;
      expect(sourceCapsulePrior(key)).toEqual([]);
      stageSourceCapsules(key, [row]); // invalidation is permanent for this scope
      finalizeSourceCapsules(key, wire(), () => "binding-a");
    });
    await staged;
    clearSourceCapsules(key);
    release();
    await staleCall;
    expect(sourceCapsulePrior(key)).toEqual([]);
    expect(sourceCapsulePrior(peerKey)).toEqual([{capsule, taskBinding: "peer-binding"}]);

    let announceGlobal!: () => void;
    let releaseGlobal!: () => void;
    const globalStaged = new Promise<void>(resolve => {announceGlobal = resolve;});
    const continueGlobal = new Promise<void>(resolve => {releaseGlobal = resolve;});
    const globalStaleCall = runWithSourceCapsuleCall(async () => {
      sourceCapsulePrior(key);
      stageSourceCapsules(key, [row]);
      announceGlobal();
      await continueGlobal;
      stageSourceCapsules(key, [row]);
      finalizeSourceCapsules(key, wire(), () => "binding-a");
    });
    await globalStaged;
    clearSourceCapsules();
    releaseGlobal();
    await globalStaleCall;
    expect(sourceCapsulePrior(key)).toEqual([]);
    expect(sourceCapsulePrior(peerKey)).toEqual([]);
  });
});
