import { describe, expect, it } from "vitest";
import { nextFingerprint } from "../util/packServeLog.js";
const query = "Explain the DocumentAdapter class and its element and ordinal inputs.";
const targets = [{ path: "artifacts/source/src/DocumentAdapter.cs" }];
const fp = (args: Record<string, unknown>) => nextFingerprint("tl_read_file", args);
describe("query-target default-content fingerprint", () => {
  it("matches the dispatched task-pack read to the exact public auto-content call", () => {
    const dispatched = { mode: "task_pack", query, targets };
    expect(fp(dispatched)).toBe(fp({ query, targets, content: "auto" }));
    expect(fp(dispatched)).toBe(fp({ query, targets }));
    expect(fp({ ...dispatched, paths: targets.map(t => t.path), targets: undefined })).toBe(fp({ query, targets, content: "auto" }));
  });
  it("preserves explicit content and target distinctions", () => {
    const auto = fp({ query, targets, content: "auto" });
    for (const args of [
      { query, targets, content: "full" },
      { query, targets, content: "outline" },
      { query, targets: [{ path: "src/DocumentAdapter.cs" }], content: "auto" },
      { query, targets: [{ path: targets[0]!.path, range: "1-20" }], content: "auto" },
      { query: query + " Include cancellation.", targets, content: "auto" },
      { query, targets, content: "auto", budget: { bytes: 6000 } },
      { query, targets, content: "auto", select: { comments: "keep" } },
    ]) expect(fp(args)).not.toBe(auto);
    expect(fp({ query, targets: [{ path: targets[0]!.path, range: "1-20" }], content: "auto" }))
      .not.toBe(fp({ query, targets: [{ path: targets[0]!.path, range: "21-40" }], content: "auto" }));
  });
  it("retains ordinary target-only read canonicalization", () => {
    expect(fp({ targets })).toBe(fp({ targets, content: "auto" }));
    expect(fp({ targets, content: "full" })).toBe(fp({ mode: "full", targets }));
    expect(fp({ targets, content: "outline" })).toBe(fp({ mode: "skeleton", targets }));
    expect(fp({ targets })).not.toBe(fp({ targets, content: "full" }));
  });
});
