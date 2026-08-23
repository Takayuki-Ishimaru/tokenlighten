/**
 * hardFloor.spec.ts — V10-08 Hybrid Retrieval v1: the hard-floor property.
 *
 * "fused output contains every floor item, none demoted below any non-floor
 * item it outranked before fusion" (task spec). Tested here with synthetic,
 * deliberately ADVERSARIAL fused scores — a floor item with a LOW fused
 * score against a non-floor item with a HIGH one — so passing is not an
 * accident of realistic score distributions.
 */

import { describe, it, expect } from "vitest";
import { applyHardFloor } from "../hardFloor.js";

interface Item {
  key: string;
}

const keyOf = (i: Item): string => i.key;

describe("applyHardFloor — nothing is dropped", () => {
  it("output is a permutation of the input (same length, same elements)", () => {
    const items: Item[] = [{ key: "a" }, { key: "b" }, { key: "c" }, { key: "d" }];
    const fused = new Map([["a", 0.1], ["b", 0.9], ["c", 0.5], ["d", 0.2]]);
    const floorKeys = new Set(["b", "d"]);
    const out = applyHardFloor(items, keyOf, fused, floorKeys);
    expect(out).toHaveLength(items.length);
    expect(new Set(out.map(keyOf))).toEqual(new Set(["a", "b", "c", "d"]));
  });

  it("every floor item is present in the output even with an EMPTY fused-score map", () => {
    const items: Item[] = [{ key: "floor1" }, { key: "floor2" }, { key: "rest1" }];
    const out = applyHardFloor(items, keyOf, new Map(), new Set(["floor1", "floor2"]));
    expect(out.map(keyOf)).toEqual(expect.arrayContaining(["floor1", "floor2", "rest1"]));
  });
});

describe("applyHardFloor — no floor item is ever demoted below a non-floor item", () => {
  it("adversarial case: a floor item with the LOWEST fused score still precedes every non-floor item, including one with the HIGHEST fused score", () => {
    const items: Item[] = [{ key: "floor-weak" }, { key: "non-floor-strong" }, { key: "non-floor-mid" }];
    const fused = new Map([
      ["floor-weak", 0.001], // lowest fused score of all three
      ["non-floor-strong", 0.999], // highest fused score of all three
      ["non-floor-mid", 0.5],
    ]);
    const out = applyHardFloor(items, keyOf, fused, new Set(["floor-weak"]));
    const floorIndex = out.findIndex((i) => i.key === "floor-weak");
    const strongIndex = out.findIndex((i) => i.key === "non-floor-strong");
    const midIndex = out.findIndex((i) => i.key === "non-floor-mid");
    expect(floorIndex).toBeLessThan(strongIndex);
    expect(floorIndex).toBeLessThan(midIndex);
  });

  it("the literal property: a floor item that outranked a non-floor item BEFORE fusion is not demoted below it AFTER, even when fusion's own score ordering would have reversed them", () => {
    // Pre-fusion order: floorItem (index 0) precedes nonFloorItem (index 1).
    const items: Item[] = [{ key: "floorItem" }, { key: "nonFloorItem" }];
    // Fusion's raw score ordering, taken alone, would REVERSE them.
    const fused = new Map([["floorItem", 0.01], ["nonFloorItem", 0.9]]);
    const out = applyHardFloor(items, keyOf, fused, new Set(["floorItem"]));
    expect(out.map(keyOf).indexOf("floorItem")).toBeLessThan(out.map(keyOf).indexOf("nonFloorItem"));
  });

  it("holds over a larger randomized-shape adversarial set (every floor item's fused score is deliberately below every non-floor item's)", () => {
    const floorItems: Item[] = Array.from({ length: 5 }, (_, i) => ({ key: `floor${i}` }));
    const nonFloorItems: Item[] = Array.from({ length: 5 }, (_, i) => ({ key: `rest${i}` }));
    const items = [...floorItems, ...nonFloorItems];
    const fused = new Map<string, number>();
    floorItems.forEach((it, i) => fused.set(it.key, i * 0.001)); // 0, 0.001, 0.002, 0.003, 0.004
    nonFloorItems.forEach((it, i) => fused.set(it.key, 1 + i)); // 1, 2, 3, 4, 5 — all far higher
    const out = applyHardFloor(items, keyOf, fused, new Set(floorItems.map(keyOf)));
    const lastFloorIndex = Math.max(...floorItems.map((it) => out.findIndex((o) => o.key === it.key)));
    const firstNonFloorIndex = Math.min(...nonFloorItems.map((it) => out.findIndex((o) => o.key === it.key)));
    expect(lastFloorIndex).toBeLessThan(firstNonFloorIndex);
  });
});

describe("applyHardFloor — within-group ordering", () => {
  it("orders the floor group by fused score descending", () => {
    const items: Item[] = [{ key: "f1" }, { key: "f2" }, { key: "f3" }];
    const fused = new Map([["f1", 0.2], ["f2", 0.8], ["f3", 0.5]]);
    const out = applyHardFloor(items, keyOf, fused, new Set(["f1", "f2", "f3"]));
    expect(out.map(keyOf)).toEqual(["f2", "f3", "f1"]);
  });

  it("orders the non-floor group by fused score descending", () => {
    const items: Item[] = [{ key: "n1" }, { key: "n2" }, { key: "n3" }];
    const fused = new Map([["n1", 0.2], ["n2", 0.8], ["n3", 0.5]]);
    const out = applyHardFloor(items, keyOf, fused, new Set());
    expect(out.map(keyOf)).toEqual(["n2", "n3", "n1"]);
  });

  it("breaks a fused-score tie by the item's original index", () => {
    const items: Item[] = [{ key: "first" }, { key: "second" }];
    const fused = new Map([["first", 0.5], ["second", 0.5]]);
    const out = applyHardFloor(items, keyOf, fused, new Set());
    expect(out.map(keyOf)).toEqual(["first", "second"]);
  });

  it("an item missing from the fused-score map sorts as score 0 within its group", () => {
    const items: Item[] = [{ key: "scored" }, { key: "unscored" }];
    const fused = new Map([["scored", 0.1]]);
    const out = applyHardFloor(items, keyOf, fused, new Set());
    expect(out.map(keyOf)).toEqual(["scored", "unscored"]);
  });
});
