import { describe, expect, it } from "vitest";
import { renderCanonicalBlock, renderMediumBlock, INSTRUCTIONS_VERSION } from "../render.js";

describe("medium guide profile (E8)", () => {
  it("uses the shared version and stays at or below half of full bytes", () => {
    const medium = renderMediumBlock();
    const full = renderCanonicalBlock();
    expect(medium).toContain(INSTRUCTIONS_VERSION);
    expect(Buffer.byteLength(medium, "utf8")).toBeLessThanOrEqual(
      Buffer.byteLength(full, "utf8") * 0.5,
    );
  });

  it("keeps the exercised v75 rules", () => {
    const medium = renderMediumBlock();
    for (const rule of [
      "mode=task_pack",
      "decision.kind",
      "refusal",
      "retry",
      "edits[]",
      "remaining",
      "next",
      "verification kit",
      "create:true",
      "queries=[",
      "cwd",
      "SAFE-STOP",
    ]) {
      expect(medium, rule).toContain(rule);
    }
  });

  it("does not change the full default renderer", () => {
    expect(renderCanonicalBlock()).toBe(renderCanonicalBlock("en", INSTRUCTIONS_VERSION, "full"));
    expect(renderCanonicalBlock("en", INSTRUCTIONS_VERSION, "medium")).toBe(renderMediumBlock());
  });
});
