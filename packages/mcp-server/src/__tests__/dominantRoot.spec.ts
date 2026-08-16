import { describe, it, expect } from "vitest";
import { dominantRoot } from "../util/dominantRoot.js";

describe("dominantRoot", () => {
  it("returns null for an empty item list", () => {
    expect(dominantRoot<string>([], (s) => s)).toBeNull();
  });

  it("count-majority: picks the root with the most items when weightOf is omitted", () => {
    const items = ["a/1", "a/2", "b/1"];
    const root = dominantRoot(items, (p) => p.split("/")[0]!);
    expect(root).toBe("a");
  });

  it("count-majority: ties break toward the first-encountered root", () => {
    const items = ["a/1", "b/1"];
    const root = dominantRoot(items, (p) => p.split("/")[0]!);
    expect(root).toBe("a");
  });

  it("weighted-majority: a single high-weight item beats many low-weight items in a different root", () => {
    const items = [
      { path: "a/1", score: 10 },
      { path: "b/1", score: 1 },
      { path: "b/2", score: 1 },
      { path: "b/3", score: 1 },
    ];
    const root = dominantRoot(items, (i) => i.path.split("/")[0]!, (i) => i.score);
    expect(root).toBe("a");
  });

  it("weighted-majority: ties break toward the first-encountered root", () => {
    const items = [
      { path: "a/1", score: 5 },
      { path: "b/1", score: 5 },
    ];
    const root = dominantRoot(items, (i) => i.path.split("/")[0]!, (i) => i.score);
    expect(root).toBe("a");
  });

  it("returns the sole root when every item shares it", () => {
    const items = ["x/1", "x/2", "x/3"];
    const root = dominantRoot(items, (p) => p.split("/")[0]!);
    expect(root).toBe("x");
  });
});
