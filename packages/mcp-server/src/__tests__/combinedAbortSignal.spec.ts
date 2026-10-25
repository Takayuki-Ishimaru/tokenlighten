import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { combinedAbortSignal } from "../util/combinedAbortSignal.js";

const descriptor = Object.getOwnPropertyDescriptor(AbortSignal, "any")!;
beforeEach(() => { Object.defineProperty(AbortSignal, "any", { ...descriptor, value: undefined }); });
afterEach(() => { Object.defineProperty(AbortSignal, "any", descriptor); vi.restoreAllMocks(); });

describe("Node 20.0 scoped abort-signal composition", () => {
  it("preserves the first already-aborted reason without attaching listeners", () => {
    const waiting = new AbortController();
    const first = new AbortController();
    const second = new AbortController();
    first.abort(new Error("first")); second.abort(new Error("second"));
    const added = vi.spyOn(waiting.signal, "addEventListener");
    const combined = combinedAbortSignal([waiting.signal, first.signal, second.signal]);
    expect(combined.signal.aborted).toBe(true);
    expect(combined.signal.reason).toBe(first.signal.reason);
    expect(added).not.toHaveBeenCalled();
    combined.dispose();
  });

  it("deduplicates sources and removes every listener after cancellation", () => {
    const parent = new AbortController();
    const deadline = new AbortController();
    const parentAdded = vi.spyOn(parent.signal, "addEventListener");
    const parentRemoved = vi.spyOn(parent.signal, "removeEventListener");
    const deadlineRemoved = vi.spyOn(deadline.signal, "removeEventListener");
    const combined = combinedAbortSignal([parent.signal, parent.signal, deadline.signal]);
    expect(parentAdded).toHaveBeenCalledTimes(1);
    parent.abort(new Error("cancelled"));
    expect(combined.signal.reason).toBe(parent.signal.reason);
    expect(parentRemoved).toHaveBeenCalledTimes(1);
    expect(deadlineRemoved).toHaveBeenCalledTimes(1);
    combined.dispose(); combined.dispose();
    deadline.abort(new Error("too late"));
    expect(combined.signal.reason).toBe(parent.signal.reason);
    expect(parentRemoved).toHaveBeenCalledTimes(1);
  });

  it("releases successful operations without retaining future cancellation", () => {
    const parent = new AbortController();
    const removed = vi.spyOn(parent.signal, "removeEventListener");
    const combined = combinedAbortSignal([parent.signal]);
    combined.dispose();
    parent.abort();
    expect(removed).toHaveBeenCalledTimes(1);
    expect(combined.signal.aborted).toBe(false);
  });

  it("keeps concurrent operations independent when one deadline expires", () => {
    const parent = new AbortController();
    const firstDeadline = new AbortController();
    const secondDeadline = new AbortController();
    const first = combinedAbortSignal([parent.signal, firstDeadline.signal]);
    const second = combinedAbortSignal([parent.signal, secondDeadline.signal]);
    firstDeadline.abort(new Error("first deadline"));
    expect(first.signal.reason).toBe(firstDeadline.signal.reason);
    expect(second.signal.aborted).toBe(false);
    parent.abort(new Error("parent cancelled"));
    expect(second.signal.reason).toBe(parent.signal.reason);
    expect(first.signal.reason).toBe(firstDeadline.signal.reason);
    first.dispose(); second.dispose();
  });

  it("propagates the platform timeout signal", async () => {
    const deadline = AbortSignal.timeout(5);
    const combined = combinedAbortSignal([deadline]);
    try {
      await new Promise<void>(resolve => combined.signal.addEventListener("abort", () => resolve(), { once: true }));
      expect(combined.signal.reason).toBe(deadline.reason);
      expect(combined.signal.reason).toMatchObject({ name: "TimeoutError" });
    } finally { combined.dispose(); }
  });
});
