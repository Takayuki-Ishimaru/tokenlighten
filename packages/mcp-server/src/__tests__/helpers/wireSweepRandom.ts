// ---------------------------------------------------------------------------
// __tests__/helpers/wireSweepRandom.ts — seeded PRNG for the P3a S6 wire-
// budget sweep (P3a S6), consumed by wireBudgetSweep.spec.ts's grid and by
// wireSweepBodies.ts's bulk transforms.
//
// NORMATIVE SOURCE: TL-PROTOCOL-V1-PHASE3A-PLAN-DRAFT.md §8.1 ("a payload
// generator parameterised by bulk... Range: from the exact floor to 10x the
// largest configured budget. Seeded, so a failure reproduces.").
//
// WHY HAND-ROLLED, NOT A DEPENDENCY. No property-testing library exists
// anywhere in this repo today — `search_files find query:"mulberry32"` over
// packages/mcp-server/src is 0/357 files, and neither `package.json` (root or
// this package) nor `node_modules` carries fast-check/chance/faker/seedrandom.
// AGENTS.md requires `npm run licenses` to keep passing with no new
// GPL/AGPL/SSPL/BSL/ELv2 dependency, and the plan's own §4.2 posture on
// `js-tiktoken` (devDependencies only, never runtime, and still an open
// orchestrator decision) argues against adding scope-creep dependencies for
// this file's one need. mulberry32 (public domain, ~10 lines) is the
// smallest thing that satisfies "seeded, so a failure reproduces" and adds
// nothing to the license-review surface.
// ---------------------------------------------------------------------------

/** A seeded pseudo-random source. Deterministic: same seed, same sequence,
 *  forever — this is what makes a sweep failure reproducible from its seed
 *  alone, without needing to capture and replay the actual random draws. */
export type SeededRandom = {
  readonly seed: number;
  /** Next float in [0, 1). */
  readonly next: () => number;
  /** Next integer in [min, max], inclusive on both ends. */
  readonly nextInt: (min: number, max: number) => number;
  /** True with probability `p` (default 0.5). */
  readonly nextBool: (p?: number) => boolean;
  /** Uniform pick from a non-empty array. Throws on an empty array rather
   *  than returning `undefined`, so a caller's bug surfaces immediately
   *  instead of silently producing an `undefined` body field. */
  readonly pick: <T>(items: readonly T[]) => T;
};

/**
 * mulberry32 — public domain (https://github.com/bryc/code/blob/master/jshash/PRNGs.md).
 * Not a cryptographic RNG; it exists purely to make "varied but reproducible
 * test bulk" from a small integer seed, which is all a payload-bulk
 * generator needs.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Build a seeded random source.
 *
 * CALLERS MUST LOG `seed` on every case (a `test.each` case name, or an
 * explicit message attached to the assertion) — plan §8.1's explicit
 * "seeded, so a failure reproduces" requirement is only true if the seed
 * that produced a failing case is visible in the failure output, not just
 * held in a variable nobody prints.
 */
export function seededRandom(seed: number): SeededRandom {
  const next = mulberry32(seed);
  return {
    seed,
    next,
    nextInt: (min: number, max: number) => {
      if (max < min) throw new Error(`nextInt: max (${max}) < min (${min})`);
      return min + Math.floor(next() * (max - min + 1));
    },
    nextBool: (p = 0.5) => next() < p,
    pick: <T>(items: readonly T[]): T => {
      if (items.length === 0) throw new Error("pick: items is empty");
      return items[Math.floor(next() * items.length)] as T;
    },
  };
}

/** A fixed default seed for a case that doesn't need its own — still worth
 *  logging via `seedLabel` on failure, since "default" is not self-evidently
 *  reproducible to someone reading a bare failure message. */
export const DEFAULT_SWEEP_SEED = 0x77706153;

/** Format a seed for inclusion in a test name or failure message, e.g.
 *  `` it(`grows evidence[] (${seedLabel(seed)})`, () => {...}) ``. */
export function seedLabel(seed: number): string {
  return `seed=0x${(seed >>> 0).toString(16)}`;
}
