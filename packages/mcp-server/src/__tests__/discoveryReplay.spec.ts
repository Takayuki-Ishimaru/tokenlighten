import {describe, expect, it} from "vitest";
import type {ToolCall} from "@tokenlighten/types";
import {withDiscoveryReplay} from "../protocol/decisionWire.js";

describe("server-authored discovery replay", () => {
  // Deliberately accepts malformed/immutable JSON shapes to exercise the wire guard.
  const read = (args: unknown): ToolCall => ({tool: "tl_read_file", arguments: args as ToolCall["arguments"]});
  it("binds canonical and legacy address forms without changing targets, budget or task", () => {
    for (const args of [
      {targets: [{path: "src/a.ts", range: "3-7"}], task: {handle: "task"}, budget: {bytes: 8000}},
      {targets: [{handle: "ha", ranges: ["3-7", "12-15"]}], content: "auto"},
      {handle: "ha", range: "3-7"}, {path: "src/a.ts", range: "3-7"},
    ]) {
      const call = read(args), before = JSON.stringify(call);
      expect(withDiscoveryReplay({qref: "q-original"}, call)).toEqual(read({...args, qref: "q-original"}));
      expect(JSON.stringify(call)).toBe(before);
    }
  });
  it("never replaces an explicit query, replay or cursor, including malformed empty values", () => {
    for (const field of ["query", "qref", "cursor", "mode", "taskEpoch"]) for (const value of ["", "other"]) {
      const call = read({targets: [{path: "a.ts"}], [field]: value});
      expect(withDiscoveryReplay({qref: "q-original"}, call)).toBe(call);
    }
  });
  it("leaves new epochs, closure pulls and fixed-range recovery unchanged", () => {
    for (const task of [{epoch: "new"}, {pull: "closure"}, {force_serve: true}, {force_serve: false}, null, []]) {
      const call = read({targets: [{path: "a.ts"}], task});
      expect(withDiscoveryReplay({qref: "q-original"}, call)).toBe(call);
    }
  });
  it("does not invent a query for address-less or non-read calls", () => {
    for (const call of [undefined, read({targets: []}), read({targets: [{symbol: "A"}]}),
      {tool: "tl_search_files" as const, arguments: {action: "find", queries: ["A"]}}]) {
      expect(withDiscoveryReplay({qref: "q-original"}, call)).toBe(call);
    }
    const call = read({targets: [{path: "a.ts"}]});
    for (const qref of [undefined, "", 42]) expect(withDiscoveryReplay({qref}, call)).toBe(call);
  });
  it("retains the producer profile on its own discovery continuation, never overriding an explicit one", () => {
    const call = read({targets: [{path: "a.ts"}], task: {handle: "task"}});
    expect(withDiscoveryReplay({qref: "q-original", profile_binding: {requested: "generic", selected: "change_propagation", source: "evidence"}}, call)).toEqual(
      read({targets: [{path: "a.ts"}], task: {handle: "task", profile: "generic"}, qref: "q-original"}));
    expect(withDiscoveryReplay({qref: "q-original", profile: "generic"}, read({...call.arguments, task: {profile: "answer"}}))?.arguments["task"])
      .toEqual({profile: "answer"});
  });
  it("is idempotent and works with immutable producer inputs", () => {
    const call = Object.freeze(read(Object.freeze({targets: Object.freeze([Object.freeze({path: "a.ts"})])})));
    const projected = withDiscoveryReplay(Object.freeze({qref: "q-original"}), call);
    expect(projected).not.toBe(call);
    expect(withDiscoveryReplay({qref: "q-original"}, projected)).toBe(projected);
  });
});
