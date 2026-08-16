# wireSweep helpers — what the three S6 specs share

These four modules are the shared surface of the P3a S6 wire-budget work.
Nothing here is named `*.spec.ts`, deliberately: Vitest's
`include: ["src/**/*.test.ts", "src/**/*.spec.ts"]` (`vitest.config.ts:26`)
collects every matching file as its own suite, so a spec that imported another
spec would run every `describe` inside it twice.

| Module | Holds |
|---|---|
| `wireSweepRandom.ts` | mulberry32 + `seedLabel` (no dependency; see its header on why hand-rolled) |
| `wireSweepBodies.ts` | the 27-shape body catalog and the per-shape bulk transforms |
| `wireSweepPredicates.ts` | plan §8.2's P1-P16 as pure functions over one emitted cell |
| `wireSweep.ts` | the entry point: re-exports the three above, plus `invokeEmit` / `emitSweepCell` / `assertNoUnearnedResidency` / `measureEmitWallTimes` |

## Who imports what

- **`__tests__/wireBudgetSweep.spec.ts`** — the full grid: 27 shapes × 2 bulk
  points × 6 budgets = 324 cells, every predicate at full shape coverage, plus
  the §4.3 perf smoke. Runs in ~1 s.
- **`__tests__/wireBudgetShedders.spec.ts`** — the per-kind rung-content
  matrix: which field each rung takes and in what order, the per-form floors,
  and the DECLINES.
- **`__tests__/protocolConformance.spec.ts` (d)** — a representative sub-grid
  (15 shapes × 3 budgets) plus A.6.2's impossible states, so a reviewer asking
  "is (d) wired?" reads one conformance file.
- **`__tests__/replayCorpus.spec.ts`** — `assertNoUnearnedResidency` only, run
  unconditionally over every replayed wire response ([R5-31]).

## Assembly sketch

```ts
import { ALL_SHAPES, bulkTransformFor, seededRandom, emitSweepCell, checkCell }
  from "./helpers/wireSweep.js";

for (const shape of ALL_SHAPES) for (const point of BUDGET_POINTS) {
  const cell = emitSweepCell({
    shapeId: shape.id, kind: shape.kind, form: shape.form,
    seed, budget: point.of(floorBytes(...), budgetFor(...)), budgetLabel: point.label,
    body: shape.body(),
  });
  expect(checkCell(cell)).toEqual([]);      // P2-P16, all at once
}
```

## P1-P16 → where each one is asserted

| # | Where | Notes |
|---|---|---|
| P1 | the `it()` body itself | a throw fails the case by name; not a violation string |
| P2 | `p2KindIsInputOrSanctionedRefusal` | refusal only if `refusalConvertible` |
| P3 | `p3SideEffectKindIsStable` | plus `e3IsErrorMatchesShippedKind` for A.8 E-3 |
| P4 | `p4SideEffectCoreSurvives` | reinterpreted: no ledger in P3a (ruling 7) — see the predicates header |
| P5/P6 | `p5RequiredSetHolds` / `p6RequiredKeysAreSubset` | through the PRODUCTION `requiredSets.ts` + `validate.ts`, never a local table |
| P7 | `p7UsedWithinBudget` | three exemptions, not two — receipt/closure emit-regardless is conditioned on the recorded violation |
| P8 | `p8LadderIsMinimal` | skipped on a converted response (the shed body was discarded) |
| P9/P10 | `p9NoReservedRungTwo` / `p10NoShedOnSideEffectKinds` + `p10RegistryHasNoSideEffectRungs` | |
| P11 | `emitSweepCellTwice` | byte-identical text AND identical shed ledger |
| P12 | `p12NoInternalBudgetKeys` | a KEY walk, not a text scan (`"used"` is a legitimate task-pack VALUE) |
| P13 | `p13ActFloorOrHonestDiscover` | at-most-one-demotion is enforced structurally by `ladder.ts` |
| P14 | `p14LimitRules` | the `wire` half; `source`/`capped` emitter arms are P3b |
| P15 | `p15NoMintedPrior` | input-vs-output diff by handle |
| P16 | `p16InventoryIsInvariant` | skipped on a converted response |

## Perf smoke (plan §4.3)

`measureEmitWallTimes(body, kind, n, seed, budgetOverrideBytes)` +
`PERF_SMOKE_BOUNDS_MS` (p50 < 15 ms, p99 < 120 ms — ~10-15× the plan's
1 ms / 8 ms target, loose on purpose for CI fork-pool contention). Pass a
budget: without one the ladder never engages and the measurement is of the
single-serialization fast path, not §4.3's worst case.

## Resolved at S6-final (these were S6-prep open items)

- `context.shedRecords` landed with S3; `emitSweepCell` reads it off the call
  context. `emitFinalizedPayload` declares its 4th `opts` parameter with no JS
  default, and `wireLadder.spec.ts` pins `Function.length === 4` so the feature
  detection cannot silently degrade — `invokeEmit` now THROWS rather than
  falling back to the default budget.
- `read.batch`'s per-entry `code_unchanged` is checked, not excluded. The
  honest condition is derivable: the field reaches the wire only through
  `readFamily.ts`'s `DOWNGRADE_FIELDS` keep-list, whose one producer
  (`server.ts`'s `buildFullDowngradePayload`) always emits `sha` beside it — so
  a residency-claiming entry must be `file-downgraded` and must carry its
  `sha`. See `batchEntryResidency`.
- P5/P6 import the production required-set table; the local duplicate S6-prep
  contemplated was never authored.
- The catalog's `read.receipt.pack-unchanged` slot is SYNTHETIC, not pinned.
  The pin whose file name says so carries `"kind":"read.task_pack"` — the
  [R5-11] re-serve fallback (`wireBaselines.spec.ts`'s F-13 test states and
  measures the divergence), so emitting it under `read.receipt` fails the
  required-set validator. Pin coverage is 13 of 27 slots, not 14.

## Findings raised by these helpers (reported, not fixed)

1. **[R5-31]'s carrier enumeration is narrower than its own rule.** The ruling
   names "a residency-form receipt or a `read.text`", but `read.task_pack`
   carries `evidence[].prior` through the same `decisionWire.ts`
   `projectEvidence` code path, on four measured corpus responses. See
   `PRIOR_BEARING_KINDS` in `wireSweep.ts` for the case ids and the
   adopt-landed argument.
2. **The first limit-bearing step must pay for the whole E3 disclosure.** A
   `wire` limit costs ~140 B and an incremental rung-6 step drops one record,
   so a body whose records are individually smaller can never take its first
   step and never sheds at all. `read.map` form `surfaces` is blocked
   STRUCTURALLY by this (its records are pure addressing and its recovery call
   names the same path), at any size or budget.
   `wireBudgetShedders.spec.ts`'s last describe block measures both.
