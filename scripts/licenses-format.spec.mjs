import { describe, expect, it } from "vitest";
import { markdownCell } from "./licenses-format.mjs";

describe("markdownCell", () => {
  it("keeps untrusted table and heading data on one physical line", () => {
    expect(markdownCell("MIT\u2028injected\u2029heading\nnext|cell")).toBe("MIT injected heading next&#124;cell");
    expect(markdownCell("\\|already escaped")).toBe("\\&#124;already escaped");
  });

  it("preserves ordinary Unicode", () => {
    expect(markdownCell("café 日本語")).toBe("café 日本語");
  });
});
