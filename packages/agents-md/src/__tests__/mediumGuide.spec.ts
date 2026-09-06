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
      "read_file {query",
      "decision.kind",
      "refusal",
      "retry",
      "edits[]",
      "remaining",
      "next",
      "read.receipt",
      "hints are advisory",
      "verification kit",
      "create:true",
      "queries=[",
      "cwd",
      "SAFE-STOP",
      "native-bypass",
    ]) {
      expect(medium, rule).toContain(rule);
    }
    expect(medium).not.toContain("mode=task_pack");
    expect(medium).toContain("<!-- tl-legacy-compat:start -->");
    expect(medium).toContain("<!-- tl-legacy-compat:end -->");
  });

  it("does not change the full default renderer", () => {
    expect(renderCanonicalBlock()).toBe(renderCanonicalBlock("en", INSTRUCTIONS_VERSION, "full"));
    expect(renderCanonicalBlock("en", INSTRUCTIONS_VERSION, "medium")).toBe(renderMediumBlock());
  });

  it("JP: uses the shared version and mirrors the EN half-of-full budget check", () => {
    const mediumJp = renderMediumBlock("jp");
    const fullJp = renderCanonicalBlock("jp");
    expect(mediumJp).toContain(INSTRUCTIONS_VERSION);
    expect(Buffer.byteLength(mediumJp, "utf8")).toBeLessThanOrEqual(
      Buffer.byteLength(fullJp, "utf8") * 0.5,
    );
  });

  it("JP: keeps the same protocol-directive vocabulary as EN medium (translation parity, not identical text)", () => {
    const mediumJp = renderMediumBlock("jp");
    for (const rule of [
      "read_file {query",
      "decision.kind",
      "next",
      "read.receipt",
      "cwd",
      "SAFE-STOP",
      "native-bypass",
      "edits[]",
    ]) {
      expect(mediumJp, rule).toContain(rule);
    }
    expect(mediumJp).not.toContain("mode=task_pack");
  });

  it("does not change the EN default when JP is requested, and both locales route through renderBlock identically", () => {
    expect(renderMediumBlock("en")).toBe(renderMediumBlock());
    expect(renderCanonicalBlock("en", INSTRUCTIONS_VERSION, "medium")).toBe(renderMediumBlock("en"));
    expect(renderCanonicalBlock("jp", INSTRUCTIONS_VERSION, "medium")).toBe(renderMediumBlock("jp"));
  });
});
