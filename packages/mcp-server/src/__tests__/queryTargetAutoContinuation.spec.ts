import { describe, expect, it } from "vitest";
import {
  hasExecutedNextBoundOrUnbound,
  nextFingerprint,
  recordExecutedNext,
} from "../util/packServeLog.js";

// Synthetic generic-name regression for the promoted task-pack read whose
// server-side representation ({mode:"task_pack", query, targets}) must be
// recognized as consumed by the equivalent public default-content call.
const QUERY = "Explain how the Widget class in Widget.cs works and what it uses slot for.";
const ARTIFACT = [{ path: "artifacts/release/source/src/Widget.cs" }];
const SOURCE = [{ path: "src/Widget.cs" }];
const fp = (args: Record<string, unknown>) => nextFingerprint("tl_read_file", args);
const dispatched = { mode: "task_pack", query: QUERY, targets: ARTIFACT };

describe("promoted task-pack read continuation fingerprint", () => {
  it("matches every equivalent public spelling of the promoted read", () => {
    expect(fp(dispatched)).toBe(fp({ query: QUERY, targets: ARTIFACT, content: "auto" }));
    expect(fp(dispatched)).toBe(fp({ query: QUERY, targets: ARTIFACT }));
    expect(fp({ ...dispatched, paths: ARTIFACT.map((t) => t.path), targets: undefined }))
      .toBe(fp({ query: QUERY, targets: ARTIFACT, content: "auto" }));
  });

  it("keeps explicit content, source-vs-artifact paths, ranges, query and options distinct", () => {
    const auto = fp({ query: QUERY, targets: ARTIFACT, content: "auto" });
    for (const args of [
      { query: QUERY, targets: ARTIFACT, content: "full" },
      { query: QUERY, targets: ARTIFACT, content: "outline" },
      { query: QUERY, targets: SOURCE, content: "auto" },
      { query: QUERY, targets: [{ path: ARTIFACT[0]!.path, range: "1-20" }], content: "auto" },
      { query: QUERY + " Include retries.", targets: ARTIFACT, content: "auto" },
      { query: QUERY, targets: ARTIFACT, content: "auto", budget: { bytes: 6000 } },
      { query: QUERY, targets: ARTIFACT, content: "auto", select: { comments: "keep" } },
    ]) expect(fp(args)).not.toBe(auto);
    expect(fp({ query: QUERY, targets: [{ path: ARTIFACT[0]!.path, range: "1-20" }], content: "auto" }))
      .not.toBe(fp({ query: QUERY, targets: [{ path: ARTIFACT[0]!.path, range: "21-40" }], content: "auto" }));
  });

  it("preserves task semantics: closure pull and task fields survive normalization", () => {
    expect(fp({ mode: "closure", query: QUERY, targets: ARTIFACT }))
      .not.toBe(fp({ query: QUERY, targets: ARTIFACT, content: "auto" }));
    expect(fp({ query: QUERY, targets: ARTIFACT, content: "auto", task: { epoch: "e1" } }))
      .not.toBe(fp({ query: QUERY, targets: ARTIFACT, content: "auto", task: { epoch: "e2" } }));
  });

  it("marks the consumed dispatched read while a progressing next stays unbound", () => {
    const root = "/tmp/tl-synthetic-auto-continuation";
    const binding = "task-fp-synthetic";
    recordExecutedNext(root, "default", "tl_read_file", dispatched, undefined, binding);
    const owed = (args: Record<string, unknown>) =>
      hasExecutedNextBoundOrUnbound(root, "default", "tl_read_file", args, binding);
    expect(owed({ query: QUERY, targets: ARTIFACT, content: "auto" })).toBe(true);
    expect(owed({ query: QUERY, targets: SOURCE, content: "auto" })).toBe(false);
    expect(owed({ query: QUERY, targets: [{ path: ARTIFACT[0]!.path, range: "1-20" }], content: "auto" })).toBe(false);
    expect(owed({ query: QUERY, targets: ARTIFACT, content: "full" })).toBe(false);
  });
});
