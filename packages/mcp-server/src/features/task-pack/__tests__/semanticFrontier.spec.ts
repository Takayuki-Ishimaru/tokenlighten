import { describe, expect, it } from "vitest";
import { annotateSemanticFrontierContinuation, buildSemanticFrontierAttestation, isSemanticFrontierContinuationOptional } from "../semanticFrontier.js";

describe("semantic frontier shadow attestation", () => {
  it("compiles typed query concerns and bounded final candidates without serializing query or bodies", () => {
    const query = "inspect --fast generated template relation src/order.ts and measure `order`";
    const payload = buildSemanticFrontierAttestation({
      query,
      guardEnabled: true,
      result: {
        mode: "task_pack", coverage: "partial", missing: [],
        surfaces: [
          { path: "src/order.ts", range: "1-20", role: "definition", code: "const FAST = true", required: true },
          { path: "src/support.ts", range: "1-2", role: "unknown", code: "support", required: false },
        ],
        wiring: { evidence_graph: { nodes: [{ id: "order", path: "src/order.ts" }], relations: [{ from: "order", to: "order", kind: "imports" }] } },
      } as any,
    });
    expect(payload).toMatchObject({ schema_version: 1, eligible: true, attempted: true, committed: false, guard_enabled: true, required_path_ids: [expect.stringMatching(/^sha256:/)], supporting_path_ids: [expect.stringMatching(/^sha256:/)] });
    expect(payload["concerns"]).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "flag" }), expect.objectContaining({ kind: "generated" }), expect.objectContaining({ kind: "measurement" }), expect.objectContaining({ kind: "relation" })]));
    expect(payload["candidates"]).toEqual(expect.arrayContaining([expect.objectContaining({ path_id: expect.stringMatching(/^sha256:/), required: true, bindings: expect.arrayContaining([expect.objectContaining({ proof: "path-exact" })]) })]));
    const concerns = payload["concerns"] as Array<{ kind: string; anchors: Array<{ id: string; kind: string }> }>;
    expect(concerns.find((concern) => concern.kind === "flag")?.anchors).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "sigil" })]));
    expect(concerns.find((concern) => concern.kind === "generated")?.anchors.every((anchor) => anchor.kind !== "sigil")).toBe(true);
    expect(concerns.flatMap((concern) => concern.anchors).every((anchor) => anchor.id.startsWith("sha256:"))).toBe(true);
    expect(JSON.stringify(payload)).not.toContain(query);
    expect(JSON.stringify(payload)).not.toContain("src/order.ts");
    expect(JSON.stringify(payload)).not.toContain("const FAST = true");
    expect(buildSemanticFrontierAttestation({ query, guardEnabled: false, result: payload["result"] as any ?? { mode: "task_pack", coverage: "partial", missing: [], surfaces: [] } } as any)["committed"]).toBe(false);
  });

  it("does not resolve a template concern from an unrelated definition or symbol", () => {
    const payload = buildSemanticFrontierAttestation({
      query: "review template", guardEnabled: true,
      result: { mode: "task_pack", coverage: "partial", missing: [], surfaces: [{ path: "src/runtime.ts", range: "1-1", role: "definition", symbol: "TemplateLike", code: "export const value = 1;" }] } as any,
    });
    expect(payload["unresolved"]).toEqual(expect.arrayContaining([expect.objectContaining({ id: "semantic-frontier:template", reason: "no-concern-hard-proof" })]));
  });

  it("marks only an unbound supporting duplicate by object identity", () => {
    const bound = { path: "src/item.ts", range: "1-1", handle: "h-bound", role: "definition", code: "--feature" } as any;
    const primaryUnbound = { path: "src/item.ts", range: "2-2", handle: "h-primary", role: "definition", code: "plain", required: true } as any;
    const supportingUnbound = { path: "src/item.ts", range: "3-3", handle: "h-supporting", role: "definition", code: "plain", required: false } as any;
    const result = { mode: "task_pack", coverage: "partial", missing: [], surfaces: [bound, primaryUnbound, supportingUnbound] } as any;
    annotateSemanticFrontierContinuation(result, "--feature flag", true);
    expect(isSemanticFrontierContinuationOptional(bound)).toBe(false);
    expect(isSemanticFrontierContinuationOptional(primaryUnbound)).toBe(false);
    expect(isSemanticFrontierContinuationOptional(supportingUnbound)).toBe(true);
  });

  it("recognizes delimiter-aware template providers and Japanese/quoted Markdown paths", () => {
    for (const path of ["src/invoice_template.html", "templates/invoice.html"]) {
      const payload = buildSemanticFrontierAttestation({ query: "review template", guardEnabled: true, result: { mode: "task_pack", coverage: "partial", missing: [], surfaces: [{ path, range: "1-1", role: "unknown" }] } as any });
      expect(payload["unresolved"]).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: "semantic-frontier:template", reason: "no-concern-hard-proof" })]));
    }
    const payload = buildSemanticFrontierAttestation({ query: "`docs/CONTRACT.mdについて` を review template。", guardEnabled: true, result: { mode: "task_pack", coverage: "partial", missing: [], surfaces: [{ path: "docs/CONTRACT.md", range: "1-1", role: "doc" }] } as any });
    expect(JSON.stringify(payload)).not.toContain("docs/CONTRACT.md");
    expect(payload["concerns"]).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "template" })]));
  });
});
