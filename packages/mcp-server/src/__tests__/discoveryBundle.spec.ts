import { describe, expect, it } from "vitest";
import { discoveryBundleAdvisory, discoveryBundleNext } from "../features/task-pack/canonicalDecision.js";

describe("discovery bundle next", () => {
  it("emits the exact bounded qref task-pack bundle for known candidates", () => {
    const result = {
      mode: "task_pack", qref: "q-known", coverage: "partial", coverage_reason: "candidate-list",
      surfaces: [{ path: "src/a.ts" }, { path: "src/b.ts" }, { path: "src/a.ts" }], missing: [],
    } as any;
    expect(discoveryBundleNext(result)).toEqual({
      tool: "read_file", arguments: { mode: "task_pack", qref: "q-known", paths: ["src/a.ts", "src/b.ts"] },
    });
    expect(discoveryBundleAdvisory(result)).toBe(
      "advisory: bundled paths are limited to files already related by served candidates or evidence edges",
    );
  });

  it("does not offer a bundle for a complete single-file pack", () => {
    expect(discoveryBundleNext({
      mode: "task_pack", qref: "q-complete", coverage: "complete", surfaces: [{ path: "src/a.ts" }], missing: [],
    } as any)).toBeUndefined();
  });

  it("caps a candidate bundle at eight paths, in surface order", () => {
    const surfaces = Array.from({ length: 11 }, (_, i) => ({ path: `src/f${String(i).padStart(2, "0")}.ts` }));
    const next = discoveryBundleNext({
      mode: "task_pack", qref: "q-cap", coverage: "partial", coverage_reason: "candidate-list",
      surfaces, missing: [],
    } as any);
    expect(next?.arguments["paths"]).toEqual(surfaces.slice(0, 8).map((s) => s.path));
  });

  it("uses only graph endpoints when partial discovery has evidence relations", () => {
    const result = {
      mode: "task_pack", qref: "q-graph", coverage: "partial", surfaces: [], missing: [],
      wiring: { evidence_graph: {
        nodes: [{ id: "a", path: "src/producer.ts" }, { id: "b", path: "src/consumer.ts" }, { id: "noise", path: "src/noise.ts" }],
        relations: [{ from: "a", to: "b" }],
      } },
    } as any;
    expect(discoveryBundleNext(result)?.arguments).toEqual({
      mode: "task_pack", qref: "q-graph", paths: ["src/producer.ts", "src/consumer.ts"],
    });
  });
});
