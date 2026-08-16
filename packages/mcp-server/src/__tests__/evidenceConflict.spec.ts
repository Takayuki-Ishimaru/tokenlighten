// evidenceConflict.spec.ts — P1 evidence completion (D7), conflict detector.
//
// Spec: scratchpad/spec-p1-shadow.md §3.1 / §8.2. Written RED before the
// detector existed.
//
// THE SCOPE IS DELIBERATELY NARROW AND THESE TESTS EXIST TO KEEP IT THAT WAY.
// The server cannot decide semantic agreement, and must not pretend to. Only
// two shapes count, both of which the resolver itself surfaces:
//   C1 literal-disagreement    — two slices in DIFFERENT classes bind the same
//                                key to different literals
//   C2 declaration-contradiction — same, where one side is normative.declaration
//                                and the key is one of its declared parameters
// Test 16 is the widening guard: a pair a human would call contradictory but
// which shares no extracted key must produce NO conflict. If someone later
// "improves" this into a semantics engine, that test fails first.

import { describe, it, expect } from "vitest";

import { detectConflicts } from "../features/task-pack/evidenceConflict.js";
import type { EvidenceSlice } from "../features/task-pack/evidenceResolution.js";

function slice(over: Partial<EvidenceSlice> & { text: string }): EvidenceSlice {
  return {
    class: "behavioral",
    path: "src/a.ts",
    range: "1-10",
    why: "test",
    matched: [],
    bytes: over.text.length,
    already_served: false,
    selected: true,
    ...over,
  } as EvidenceSlice;
}

describe("evidenceConflict — C1 literal-disagreement", () => {
  it("12: two classes binding the same key to different literals is one conflict", () => {
    const normative = slice({
      class: "normative", subclass: "prose", path: "CONTRACT.md", range: "1018-1042",
      text: "| rotor | yaw |\n| --- | --- |\n| FR | -yaw |\n| BL | -yaw |\n",
    });
    const behavioral = slice({
      class: "behavioral", path: "src/control/mixer.cpp", range: "18-31",
      text: "  FR = +yaw;\n  BL = -yaw;\n",
    });

    const conflicts = detectConflicts("c2", [normative, behavioral]);
    expect(conflicts.length, JSON.stringify(conflicts)).toBe(1);
    const c = conflicts[0]!;
    expect(c.id).toBe("c2");
    expect(c.kind).toBe("literal-disagreement");
    expect(c.key).toBe("FR");
    expect(c.positions).toHaveLength(2);
    expect(c.positions.map((p) => p.class).sort()).toEqual(["behavioral", "normative"]);
    const values = c.positions.map((p) => p.value).sort();
    expect(values).toEqual(["+yaw", "-yaw"]);
    // BL agrees on both sides, so it is NOT reported.
    expect(conflicts.some((x) => x.key === "BL")).toBe(false);
  });

  it("13: the same key with the same value is not a conflict", () => {
    const conflicts = detectConflicts("c1", [
      slice({ class: "normative", subclass: "prose", text: "| FR | -yaw |\n" }),
      slice({ class: "behavioral", text: "FR = -yaw;\n" }),
    ]);
    expect(conflicts).toEqual([]);
  });

  it("14: different keys entirely are not a conflict (intersection-based, not 'the classes differ')", () => {
    const conflicts = detectConflicts("c1", [
      slice({ class: "normative", subclass: "prose", text: "| FR | -yaw |\n" }),
      slice({ class: "behavioral", text: "BL = +yaw;\n" }),
    ]);
    expect(conflicts).toEqual([]);
  });

  it("14b: a disagreement WITHIN one class is not a cross-class conflict", () => {
    const conflicts = detectConflicts("c1", [
      slice({ class: "behavioral", path: "test/a.ts", text: "FR = -yaw;\n" }),
      slice({ class: "behavioral", path: "test/b.ts", text: "FR = +yaw;\n" }),
    ]);
    expect(conflicts).toEqual([]);
  });
});

describe("evidenceConflict — C2 declaration-contradiction", () => {
  it("15: a documented sentinel contradicted by another class is labeled declaration-contradiction", () => {
    const declaration = slice({
      class: "normative", subclass: "declaration", path: "rtos/os_mutex.h", range: "35-40",
      text: "/**\n * HAL_ERR_BUSY if timeout_ms == 0 and mutex is held.\n */\n" +
            "hal_status_t os_mutex_lock(os_mutex_t m, uint32_t timeout_ms);\n",
    });
    const behavioral = slice({
      class: "behavioral", path: "test/test_failsafe.cpp", range: "10-14",
      text: "  timeout_ms = 5;\n  assert(os_mutex_lock(m, timeout_ms) == HAL_OK);\n",
    });

    const conflicts = detectConflicts("c3", [declaration, behavioral]);
    expect(conflicts.length, JSON.stringify(conflicts)).toBe(1);
    expect(conflicts[0]!.kind).toBe("declaration-contradiction");
    expect(conflicts[0]!.key).toBe("timeout_ms");
  });
});

describe("evidenceConflict — the widening guard", () => {
  it("16: prose a human would call contradictory, sharing no extracted key, is NOT a conflict", () => {
    // "must never block" vs "blocks until acquired" is a real semantic
    // contradiction and the server has no honest way to see it. Reporting it
    // would mean holding packs on a guess and COSTING turns. If this test ever
    // fails, the detector has grown a semantics engine — revert it.
    const conflicts = detectConflicts("c1", [
      slice({
        class: "normative", subclass: "prose", path: "CONTRACT.md",
        text: "The mixer MUST never block the control loop.\n",
      }),
      slice({
        class: "behavioral", path: "test/mixer_test.cpp",
        text: "// the mixer blocks until the mutex is acquired\nassert(blocked());\n",
      }),
    ]);
    expect(conflicts, `detector widened into semantics: ${JSON.stringify(conflicts)}`).toEqual([]);
  });

  it("16b: a single class in isolation can never produce a conflict", () => {
    expect(detectConflicts("c1", [slice({ text: "FR = -yaw;\n" })])).toEqual([]);
    expect(detectConflicts("c1", [])).toEqual([]);
  });

  it("16c: unselected slices are ignored — a conflict must rest on what would be served", () => {
    const conflicts = detectConflicts("c1", [
      slice({ class: "normative", subclass: "prose", text: "| FR | -yaw |\n", selected: true }),
      slice({ class: "behavioral", text: "FR = +yaw;\n", selected: false }),
    ]);
    expect(conflicts).toEqual([]);
  });
});
