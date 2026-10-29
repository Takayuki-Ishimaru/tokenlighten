import { describe, expect, it, vi } from "vitest";
import { followPackDiscovery, followReadPages } from "./helpers/followPackDiscovery.js";

describe("RC task preparation follows bounded host continuations", () => {
  const next = { tool: "tl_read_file", arguments: { cursor: "opaque-read-cursor" } };
  const first = () => ({ task: { id: "original-task" }, decision: { kind: "discover", next } });

  it("uses the published call verbatim and preserves the actual response history", async () => {
    const initial = first();
    const before = structuredClone(initial);
    const ready = { task: { id: "original-task" }, decision: { kind: "act.edit" } };
    const call = vi.fn(async (_tool: string, _args: Record<string, unknown>) => ready);
    const result = await followPackDiscovery(initial, call);
    expect(call).toHaveBeenCalledExactlyOnceWith(next.tool, next.arguments);
    expect(call.mock.calls[0]![1]).toBe(next.arguments);
    expect(result.final).toBe(ready);
    expect(result.responses).toEqual([initial, ready]);
    expect(initial).toEqual(before);
  });

  it("does not follow optional next calls after readiness or refusal", async () => {
    for (const kind of ["act.edit", "refusal"]) {
      const terminal = { decision: { kind }, next };
      const call = vi.fn();
      expect((await followPackDiscovery(terminal, call)).final).toBe(terminal);
      expect(call).not.toHaveBeenCalled();
    }
  });

  it("rejects discovery without a next and repeated calls", async () => {
    await expect(followPackDiscovery({ decision: { kind: "discover" } }, vi.fn())).rejects.toThrow("no published next");
    await expect(followPackDiscovery(first(), async () => first())).rejects.toThrow("repeated the same next");
  });

  it("rejects a new task and bounds a progressing discovery chain", async () => {
    await expect(followPackDiscovery(first(), async () => ({ task: { id: "another-task" } }))).rejects.toThrow("task identity");
    let index = 0;
    await expect(followPackDiscovery(first(), async () => ({ decision: { kind: "discover", next: {
      tool: "tl_read_file", arguments: { cursor: `next-${++index}` },
    } } }), 2)).rejects.toThrow("exceeded 2 calls");
    expect(index).toBe(2);
  });

  it("follows read budget pages verbatim and stops before optional zoom advice", async () => {
    const final = { kind: "read.text", next };
    const call = vi.fn(async (_tool: string, _args: Record<string, unknown>) => final);
    const initial = { kind: "read.batch", limit: { next } };
    expect(await followReadPages(initial, call)).toEqual([initial, final]);
    expect(call).toHaveBeenCalledExactlyOnceWith(next.tool, next.arguments);
    expect(call.mock.calls[0]![1]).toBe(next.arguments);
  });

  it("rejects a looping read and a continuation that mints a task", async () => {
    const initial = { kind: "read.batch", limit: { next } };
    await expect(followReadPages(initial, async () => initial)).rejects.toThrow("same continuation");
    await expect(followReadPages(initial, async () => ({ task: { id: "new" } }))).rejects.toThrow("became a task");
  });
});
