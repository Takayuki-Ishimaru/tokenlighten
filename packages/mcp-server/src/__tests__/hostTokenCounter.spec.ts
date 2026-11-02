// ---------------------------------------------------------------------------
// B6 -- the host counter's contract. A host's countTokens is asynchronous and the
// selector's TokenCounter is synchronous, so every candidate is counted first and
// the sync counter only ever answers from those results. Fake bridges only: no
// host is exercised here.
// ---------------------------------------------------------------------------

import { describe, expect, it, vi } from "vitest";
import { precountForHost, type HostCounterBridge } from "../protocol/codec/hostTokenCounter.js";

function bridge(count: (text: string, signal: AbortSignal) => Promise<number> | number, id = "vscode/model-a/host-exact"): HostCounterBridge {
  return { id, method: "host-exact", countTokens: async (text, signal) => count(text, signal) };
}

const OPTS = { timeoutMs: 200 };

describe("precountForHost", () => {
  it("answers from the bridge's own counts, with an identity naming the host and model", async () => {
    const result = await precountForHost(() => bridge((text) => text.length * 2), ["abc", "defgh"], OPTS);
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.counter.count("abc")).toBe(6);
    expect(result.counter.count("defgh")).toBe(10);
    expect(result.counter.id).toBe("vscode/model-a/host-exact");
    expect(result.counter.unit).toBe("tokens");
    expect(result.counter.encoding).toBe("host");
    expect(result.counter.method).toBe("host-exact");
  });

  it("never answers for a text it did not count: there is no fallback value", async () => {
    const result = await precountForHost(() => bridge(() => 3), ["abc"], OPTS);
    if (result.status !== "ready") throw new Error("expected ready");
    expect(() => result.counter.count("not counted")).toThrow(/host-count-missing/);
  });

  it("counts each distinct text once", async () => {
    const count = vi.fn(async () => 5);
    const result = await precountForHost(() => ({ id: "h", method: "host-estimate", countTokens: count }), ["a", "b", "a", "a"], OPTS);
    expect(result.status).toBe("ready");
    expect(count).toHaveBeenCalledTimes(2);
  });

  it("two models are two identities, so their counts cannot share a cache slot", async () => {
    const a = await precountForHost(() => bridge(() => 1, "vscode/a/host-exact"), ["x"], OPTS);
    const b = await precountForHost(() => bridge(() => 2, "vscode/b/host-exact"), ["x"], OPTS);
    if (a.status !== "ready" || b.status !== "ready") throw new Error("expected ready");
    expect(a.counter.id).not.toBe(b.counter.id);
    expect(a.counter.count("x")).toBe(1);
    expect(b.counter.count("x")).toBe(2);
  });

  it.each([
    ["NaN", Number.NaN],
    ["negative", -1],
    ["fractional", 1.5],
    ["infinite", Number.POSITIVE_INFINITY],
    ["zero for a non-empty text", 0],
  ])("refuses an invalid count: %s", async (_name, value) => {
    expect(await precountForHost(() => bridge(() => value), ["text"], OPTS)).toEqual({ status: "unavailable", reason: "invalid-count" });
  });

  it("allows zero for an empty text", async () => {
    const result = await precountForHost(() => bridge(() => 0), [""], OPTS);
    expect(result.status).toBe("ready");
  });

  it("a bridge that rejects is unavailable, and never rejects to its caller", async () => {
    await expect(precountForHost(() => bridge(() => { throw new Error("offline"); }), ["x"], OPTS)).resolves.toEqual({ status: "unavailable", reason: "bridge-error" });
  });

  it("no bridge at all is unavailable", async () => {
    expect(await precountForHost(() => undefined, ["x"], OPTS)).toEqual({ status: "unavailable", reason: "no-bridge" });
  });

  it("a getter that throws is unavailable", async () => {
    expect(await precountForHost(() => { throw new Error("gone"); }, ["x"], OPTS)).toEqual({ status: "unavailable", reason: "bridge-error" });
  });

  it("times out, aborts the bridge, and a late answer changes nothing", async () => {
    let seen: AbortSignal | undefined;
    let release: (value: number) => void = () => {};
    const late = new Promise<number>((resolve) => { release = resolve; });
    const result = await precountForHost(() => bridge((_text, signal) => { seen = signal; return late; }), ["x"], { timeoutMs: 20 });
    expect(result).toEqual({ status: "unavailable", reason: "timeout" });
    expect(seen?.aborted).toBe(true);
    release(9);
    await late;
    expect(result).toEqual({ status: "unavailable", reason: "timeout" });
  });

  it("a caller's cancel stops the work, and an already-cancelled signal never reaches the bridge", async () => {
    const controller = new AbortController();
    const count = vi.fn((_text: string, signal: AbortSignal) => new Promise<number>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("aborted")));
    }));
    const pending = precountForHost(() => ({ id: "h", method: "unknown", countTokens: count }), ["x"], { timeoutMs: 5_000, signal: controller.signal });
    controller.abort();
    expect(await pending).toEqual({ status: "unavailable", reason: "cancelled" });

    const early = vi.fn(async () => 1);
    const aborted = AbortSignal.abort();
    expect(await precountForHost(() => ({ id: "h", method: "unknown", countTokens: early }), ["x"], { timeoutMs: 100, signal: aborted }))
      .toEqual({ status: "unavailable", reason: "cancelled" });
    expect(early).not.toHaveBeenCalled();
  });

  it("a model switch during counting discards every count", async () => {
    let id = "vscode/a/host-exact";
    const getter = (): HostCounterBridge => ({
      id,
      method: "host-exact",
      countTokens: async () => { id = "vscode/b/host-exact"; return 4; },
    });
    expect(await precountForHost(getter, ["x"], OPTS)).toEqual({ status: "unavailable", reason: "model-changed" });
  });

  it("bounds what it will send", async () => {
    const count = vi.fn(async () => 1);
    const b: HostCounterBridge = { id: "h", method: "unknown", countTokens: count };
    expect(await precountForHost(() => b, Array.from({ length: 9 }, (_, i) => `t${i}`), OPTS)).toEqual({ status: "unavailable", reason: "too-many-texts" });
    expect(await precountForHost(() => b, ["x".repeat(600 * 1024)], OPTS)).toEqual({ status: "unavailable", reason: "input-too-large" });
    expect(count).not.toHaveBeenCalled();
  });
});
