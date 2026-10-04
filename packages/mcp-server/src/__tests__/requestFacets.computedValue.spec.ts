/**
 * requestFacets.computedValue.spec.ts — the computed-value frames
 * (requestFacets.ts `VALUE_COMPUTED_*`, Copilot standard-setup retest,
 * 2026-10-02) on the shapes they exist for, and on the over-firing shapes the
 * batch's independent review found (each fired `value` before the fix).
 * Held-out recall/precision lives in requestFacets.heldout6/7.spec.ts.
 */
import { describe, expect, it } from "vitest";

import { extractFacetRequirements } from "../features/task-pack/requestFacets.js";

const facets = (text: string): string[] => [...new Set(extractFacetRequirements(text).map((r) => r.facet))];

describe("computed-value frames", () => {
  it.each([
    "What exact delay sequence does retrySchedule return and why?",
    "What does `rollDamage('fire', crit=0.25)` compute?",
    "What will `pickStrategy(priority)` hand back if the list is empty?",
    "What is the output of `calibrateBarometer(raw=4095)`?",
    "What's the result of calling `assignRoute(vehicleId)`?",
    "Calculate the exact result of `estimateDeliveryDate(warehouse='FRA-3')`.",
    "Calculate exact quote() outputs for carts in src/checkout.",
    "Inspect src/checkout and calculate the exact quote() result for each cart below.",
    "Compute what `nextBitrate(bandwidthKbps=8500)` gives.",
    "Compute the idle timeout that `getStandbyDuration()` returns.",
    "`calcShippingFee(weight=4.2, zone=3)` は何を返しますか？",
    "この入力での `evaluatePitch(melody, bpm=120)` の計算結果を教えて。",
    "`renderFrame(buffer)` の出力は？",
  ])("reads %j as a value question", (text) => {
    expect(facets(text)).toContain("value");
  });

  it.each([
    // review 2026-10-02: the filler swallowed the auxiliary ("does the pipeline" + "do")
    "What does the pipeline do after transform() produces its output?",
    // review 2026-10-02: change requests that merely say compute/work out
    "Can you compute the total in reduceCart() instead of a for loop?",
    "Please compute the digest once and reuse the result.",
    "Work out which module produces the warning and silence it.",
    // review 2026-10-02: a result/output with no code subject at all
    "What's the result of the last CI run?",
    "What is the output of the build step for the docs package?",
    // same-word callers / condition questions
    "Where in the codebase is the result of `resolveDependency(module)` used?",
    "Under what conditions does `pickOptimalServer(region, load)` return null?",
    "`calculateScore(game)` の結果はどの関数で使われている？",
    "The compute shader output is misaligned on Metal.",
  ])("does not read %j as a value question", (text) => {
    expect(facets(text)).not.toContain("value");
  });
});
