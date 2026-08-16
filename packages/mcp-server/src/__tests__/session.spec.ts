/**
 * session.spec.ts — unit tests for util/session.ts
 *
 * Covers:
 *   - counters increment correctly
 *   - per-path full counter resets on sha change
 *   - recordHandleEdit halves full_expansions_total (ceil)
 *   - resetWorkspace clears one workspace without touching another
 *   - recordRepeatedRead returns increasing counts for the same (path, range)
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  getSession,
  recordReadMode,
  recordFullExpansion,
  recordTinyFullExpansion,
  recordHandleEdit,
  recordPathSearchEdit,
  recordSingleEditCompletion,
  recordEditsBatchUsed,
  BATCH_HINT_THRESHOLD,
  recordRepeatedRead,
  recordClosureOpenStreak,
  CLOSURE_ESCALATION_THRESHOLD,
  resetWorkspace,
  resetAll,
  snapshotForTrace,
} from "../util/session.js";

const ROOT_A = "/workspace/project-a";
const ROOT_B = "/workspace/project-b";

beforeEach(() => {
  resetAll();
});

// ---------------------------------------------------------------------------
// getSession
// ---------------------------------------------------------------------------

describe("getSession", () => {
  it("creates a session lazily on first access", () => {
    const s = getSession(ROOT_A);
    expect(s).toBeDefined();
    expect(s.fullExpansionsTotal).toBe(0);
    expect(s.handleBackedEdits).toBe(0);
  });

  it("returns the same object for the same root", () => {
    const s1 = getSession(ROOT_A);
    const s2 = getSession(ROOT_A);
    expect(s1).toBe(s2);
  });

  it("returns distinct objects for different roots", () => {
    const sA = getSession(ROOT_A);
    const sB = getSession(ROOT_B);
    expect(sA).not.toBe(sB);
  });
});

// ---------------------------------------------------------------------------
// recordReadMode
// ---------------------------------------------------------------------------

describe("recordReadMode", () => {
  it("starts at 0 for an unseen mode", () => {
    const s = getSession(ROOT_A);
    expect(s.readsByMode.get("full")).toBeUndefined();
  });

  it("increments count for successive calls", () => {
    recordReadMode(ROOT_A, "full");
    recordReadMode(ROOT_A, "full");
    recordReadMode(ROOT_A, "digest");

    const s = getSession(ROOT_A);
    expect(s.readsByMode.get("full")).toBe(2);
    expect(s.readsByMode.get("digest")).toBe(1);
  });

  it("tracks all distinct modes independently", () => {
    const modes = ["map", "digest", "slice", "full", "skeleton", "pack", "task_pack", "small_file"];
    for (const m of modes) recordReadMode(ROOT_A, m);

    const s = getSession(ROOT_A);
    for (const m of modes) {
      expect(s.readsByMode.get(m)).toBe(1);
    }
  });
});

// ---------------------------------------------------------------------------
// recordFullExpansion
// ---------------------------------------------------------------------------

describe("recordFullExpansion", () => {
  it("increments per-path count and total on first expansion", () => {
    recordFullExpansion(ROOT_A, "src/foo.ts", "sha256:aaa");

    const s = getSession(ROOT_A);
    expect(s.fullExpansionsPerPath.get("src/foo.ts")?.count).toBe(1);
    expect(s.fullExpansionsPerPath.get("src/foo.ts")?.lastSha).toBe("sha256:aaa");
    expect(s.fullExpansionsTotal).toBe(1);
  });

  it("increments per-path count further when sha is unchanged", () => {
    recordFullExpansion(ROOT_A, "src/foo.ts", "sha256:aaa");
    const { resetByShaChange } = recordFullExpansion(ROOT_A, "src/foo.ts", "sha256:aaa");

    expect(resetByShaChange).toBe(false);
    const s = getSession(ROOT_A);
    expect(s.fullExpansionsPerPath.get("src/foo.ts")?.count).toBe(2);
    expect(s.fullExpansionsTotal).toBe(2);
  });

  it("resets per-path count to 1 when sha changes", () => {
    recordFullExpansion(ROOT_A, "src/foo.ts", "sha256:aaa");
    recordFullExpansion(ROOT_A, "src/foo.ts", "sha256:aaa");
    const { resetByShaChange } = recordFullExpansion(ROOT_A, "src/foo.ts", "sha256:bbb");

    expect(resetByShaChange).toBe(true);
    const s = getSession(ROOT_A);
    expect(s.fullExpansionsPerPath.get("src/foo.ts")?.count).toBe(1);
    expect(s.fullExpansionsPerPath.get("src/foo.ts")?.lastSha).toBe("sha256:bbb");
    // Total still counts every expansion call regardless of reset.
    expect(s.fullExpansionsTotal).toBe(3);
  });

  it("tracks different paths independently", () => {
    recordFullExpansion(ROOT_A, "src/a.ts", "sha256:111");
    recordFullExpansion(ROOT_A, "src/b.ts", "sha256:222");
    recordFullExpansion(ROOT_A, "src/a.ts", "sha256:111");

    const s = getSession(ROOT_A);
    expect(s.fullExpansionsPerPath.get("src/a.ts")?.count).toBe(2);
    expect(s.fullExpansionsPerPath.get("src/b.ts")?.count).toBe(1);
    expect(s.fullExpansionsTotal).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// recordTinyFullExpansion — FIX-3a (2026-07-09d forensics): exempt calls land
// in a SEPARATE counter so pack-recorded (governorExempt) expansions cannot
// erode the agent-facing TINY_TASK_CAP budget.
// ---------------------------------------------------------------------------

describe("recordTinyFullExpansion", () => {
  it("increments tinyFullExpansionsTotal by default (non-exempt)", () => {
    recordTinyFullExpansion(ROOT_A);
    recordTinyFullExpansion(ROOT_A);
    const s = getSession(ROOT_A);
    expect(s.tinyFullExpansionsTotal).toBe(2);
    expect(s.tinyFullExpansionsExemptTotal).toBe(0);
  });

  it("explicit exempt:false behaves identically to the default (omitted) form", () => {
    recordTinyFullExpansion(ROOT_A, false);
    const s = getSession(ROOT_A);
    expect(s.tinyFullExpansionsTotal).toBe(1);
    expect(s.tinyFullExpansionsExemptTotal).toBe(0);
  });

  it("exempt:true records into tinyFullExpansionsExemptTotal, NOT tinyFullExpansionsTotal", () => {
    recordTinyFullExpansion(ROOT_A, true);
    recordTinyFullExpansion(ROOT_A, true);
    recordTinyFullExpansion(ROOT_A, true);
    const s = getSession(ROOT_A);
    expect(s.tinyFullExpansionsTotal).toBe(0);
    expect(s.tinyFullExpansionsExemptTotal).toBe(3);
  });

  it("exempt and non-exempt calls accumulate independently in the same session", () => {
    recordTinyFullExpansion(ROOT_A);       // non-exempt: 1
    recordTinyFullExpansion(ROOT_A, true); // exempt: 1
    recordTinyFullExpansion(ROOT_A, true); // exempt: 2
    recordTinyFullExpansion(ROOT_A);       // non-exempt: 2
    const s = getSession(ROOT_A);
    expect(s.tinyFullExpansionsTotal).toBe(2);
    expect(s.tinyFullExpansionsExemptTotal).toBe(2);
  });

  it("tracks different workspaces independently", () => {
    recordTinyFullExpansion(ROOT_A, true);
    recordTinyFullExpansion(ROOT_B);
    expect(getSession(ROOT_A).tinyFullExpansionsExemptTotal).toBe(1);
    expect(getSession(ROOT_A).tinyFullExpansionsTotal).toBe(0);
    expect(getSession(ROOT_B).tinyFullExpansionsTotal).toBe(1);
    expect(getSession(ROOT_B).tinyFullExpansionsExemptTotal).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// recordHandleEdit — decay rule
// ---------------------------------------------------------------------------

describe("recordHandleEdit", () => {
  it("increments handle edit counter", () => {
    recordHandleEdit(ROOT_A);
    recordHandleEdit(ROOT_A);
    expect(getSession(ROOT_A).handleBackedEdits).toBe(2);
  });

  it("decays fullExpansionsTotal by floor(total/2) — total becomes ceil(total/2)", () => {
    // Put total at 10 via full expansions.
    for (let i = 0; i < 10; i++) {
      recordFullExpansion(ROOT_A, `src/file${i}.ts`, "sha256:aaa");
    }
    expect(getSession(ROOT_A).fullExpansionsTotal).toBe(10);

    recordHandleEdit(ROOT_A);
    // ceil(10/2) = 5
    expect(getSession(ROOT_A).fullExpansionsTotal).toBe(5);

    recordHandleEdit(ROOT_A);
    // ceil(5/2) = 3
    expect(getSession(ROOT_A).fullExpansionsTotal).toBe(3);

    recordHandleEdit(ROOT_A);
    // ceil(3/2) = 2
    expect(getSession(ROOT_A).fullExpansionsTotal).toBe(2);

    recordHandleEdit(ROOT_A);
    // ceil(2/2) = 1
    expect(getSession(ROOT_A).fullExpansionsTotal).toBe(1);

    recordHandleEdit(ROOT_A);
    // ceil(1/2) = 1 (never goes below 1 until it hits 0)
    expect(getSession(ROOT_A).fullExpansionsTotal).toBe(1);
  });

  it("handles total=0 without going negative", () => {
    recordHandleEdit(ROOT_A);
    // ceil(0/2) = 0
    expect(getSession(ROOT_A).fullExpansionsTotal).toBe(0);
  });

  it("handles odd total correctly (ceil)", () => {
    for (let i = 0; i < 7; i++) {
      recordFullExpansion(ROOT_A, `src/f${i}.ts`, "sha256:x");
    }
    recordHandleEdit(ROOT_A);
    // ceil(7/2) = 4
    expect(getSession(ROOT_A).fullExpansionsTotal).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// recordPathSearchEdit
// ---------------------------------------------------------------------------

describe("recordPathSearchEdit", () => {
  it("increments the counter on each call", () => {
    recordPathSearchEdit(ROOT_A);
    recordPathSearchEdit(ROOT_A);
    expect(getSession(ROOT_A).pathOrSearchEditsWithoutHandle).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// recordSingleEditCompletion / recordEditsBatchUsed — one-shot batching hint
// ---------------------------------------------------------------------------

describe("recordSingleEditCompletion", () => {
  it("returns false on the 1st call, true on the 2nd (BATCH_HINT_THRESHOLD)", () => {
    expect(recordSingleEditCompletion(ROOT_A)).toBe(false); // 1
    expect(recordSingleEditCompletion(ROOT_A)).toBe(true);  // 2 === BATCH_HINT_THRESHOLD
    expect(getSession(ROOT_A).singleEditCompletions).toBe(BATCH_HINT_THRESHOLD);
  });

  it("returns false again on the 3rd call — fires exactly once per session", () => {
    for (let i = 0; i < 2; i++) recordSingleEditCompletion(ROOT_A);
    expect(recordSingleEditCompletion(ROOT_A)).toBe(false); // 3rd
    expect(getSession(ROOT_A).singleEditCompletions).toBe(3);
  });

  it("never returns true once recordEditsBatchUsed has been called", () => {
    recordEditsBatchUsed(ROOT_A);
    for (let i = 0; i < 10; i++) {
      expect(recordSingleEditCompletion(ROOT_A)).toBe(false);
    }
    expect(getSession(ROOT_A).singleEditCompletions).toBe(10);
  });

  it("suppression applies even when the batch call lands between qualifying edits", () => {
    expect(recordSingleEditCompletion(ROOT_A)).toBe(false); // 1
    recordEditsBatchUsed(ROOT_A);
    expect(recordSingleEditCompletion(ROOT_A)).toBe(false); // 2 — would have fired without the batch call
    expect(recordSingleEditCompletion(ROOT_A)).toBe(false); // 3
  });

  it("tracks different workspaces independently", () => {
    recordEditsBatchUsed(ROOT_A);
    expect(recordSingleEditCompletion(ROOT_A)).toBe(false);
    expect(recordSingleEditCompletion(ROOT_A)).toBe(false); // suppressed on A (would fire at 2)

    // B never saw a batch call — fires normally on its own 2nd.
    expect(recordSingleEditCompletion(ROOT_B)).toBe(false);
    expect(recordSingleEditCompletion(ROOT_B)).toBe(true);
  });
});

describe("recordEditsBatchUsed", () => {
  it("sets usedEditsBatch to true", () => {
    expect(getSession(ROOT_A).usedEditsBatch).toBe(false);
    recordEditsBatchUsed(ROOT_A);
    expect(getSession(ROOT_A).usedEditsBatch).toBe(true);
  });

  it("does not itself affect singleEditCompletions", () => {
    recordEditsBatchUsed(ROOT_A);
    expect(getSession(ROOT_A).singleEditCompletions).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// recordClosureOpenStreak — one-shot ignored-open-check escalation
// (2026-07-12c forensics). Mirrors recordSingleEditCompletion's
// one-shot-hint SHAPE (counter + fired flag) but tracks check-id CONTINUITY
// across calls rather than a plain call count — see the function's own doc
// comment in session.ts for the exact continuation/reset rules.
// ---------------------------------------------------------------------------

describe("recordClosureOpenStreak", () => {
  it("returns false for the first 4 calls with the same id, true on the 5th (CLOSURE_ESCALATION_THRESHOLD)", () => {
    expect(CLOSURE_ESCALATION_THRESHOLD).toBe(5);
    expect(recordClosureOpenStreak(ROOT_A, ["chk-a"])).toBe(false); // 1
    expect(recordClosureOpenStreak(ROOT_A, ["chk-a"])).toBe(false); // 2
    expect(recordClosureOpenStreak(ROOT_A, ["chk-a"])).toBe(false); // 3
    expect(recordClosureOpenStreak(ROOT_A, ["chk-a"])).toBe(false); // 4
    expect(recordClosureOpenStreak(ROOT_A, ["chk-a"])).toBe(true);  // 5 === CLOSURE_ESCALATION_THRESHOLD
    expect(getSession(ROOT_A).closureOpenStreak).toBe(CLOSURE_ESCALATION_THRESHOLD);
  });

  it("returns false again on the 6th, 7th, 8th call — fires exactly once per session", () => {
    for (let i = 0; i < 5; i++) recordClosureOpenStreak(ROOT_A, ["chk-a"]);
    expect(recordClosureOpenStreak(ROOT_A, ["chk-a"])).toBe(false); // 6
    expect(recordClosureOpenStreak(ROOT_A, ["chk-a"])).toBe(false); // 7
    expect(recordClosureOpenStreak(ROOT_A, ["chk-a"])).toBe(false); // 8
    expect(getSession(ROOT_A).closureOpenStreak).toBe(8);
    expect(getSession(ROOT_A).closureEscalationFired).toBe(true);
  });

  it("does not fire before the threshold even with a larger open set, as long as it keeps overlapping", () => {
    expect(recordClosureOpenStreak(ROOT_A, ["chk-a", "chk-b"])).toBe(false); // 1
    expect(recordClosureOpenStreak(ROOT_A, ["chk-b", "chk-c"])).toBe(false); // 2 (shares chk-b)
    expect(recordClosureOpenStreak(ROOT_A, ["chk-c"])).toBe(false);          // 3 (shares chk-c)
    expect(getSession(ROOT_A).closureOpenStreak).toBe(3);
  });

  it("an id set with ZERO overlap vs the previous snapshot restarts the streak at 1, not 0", () => {
    recordClosureOpenStreak(ROOT_A, ["chk-a"]);
    recordClosureOpenStreak(ROOT_A, ["chk-a"]);
    expect(getSession(ROOT_A).closureOpenStreak).toBe(2);
    // A completely unrelated check id, no overlap with {chk-a} → fresh run.
    recordClosureOpenStreak(ROOT_A, ["chk-z"]);
    expect(getSession(ROOT_A).closureOpenStreak).toBe(1);
  });

  it("an empty openIds (all checks closed) resets the streak and snapshot to zero/empty", () => {
    recordClosureOpenStreak(ROOT_A, ["chk-a"]);
    recordClosureOpenStreak(ROOT_A, ["chk-a"]);
    recordClosureOpenStreak(ROOT_A, ["chk-a"]);
    expect(getSession(ROOT_A).closureOpenStreak).toBe(3);
    expect(recordClosureOpenStreak(ROOT_A, [])).toBe(false);
    expect(getSession(ROOT_A).closureOpenStreak).toBe(0);
    expect(getSession(ROOT_A).closureOpenStreakIds).toEqual([]);
  });

  it("a check that closes resets the run: a fresh 5-in-a-row AFTER the reset still escalates on its own 5th, not carried over from the prior streak", () => {
    recordClosureOpenStreak(ROOT_A, ["chk-a"]); // 1
    recordClosureOpenStreak(ROOT_A, ["chk-a"]); // 2
    recordClosureOpenStreak(ROOT_A, ["chk-a"]); // 3 — closes next, never reaches 5
    recordClosureOpenStreak(ROOT_A, []);        // closed: reset to 0
    expect(getSession(ROOT_A).closureOpenStreak).toBe(0);
    // A different check now opens and stays open for its own run of 5.
    expect(recordClosureOpenStreak(ROOT_A, ["chk-b"])).toBe(false); // 1
    expect(recordClosureOpenStreak(ROOT_A, ["chk-b"])).toBe(false); // 2
    expect(recordClosureOpenStreak(ROOT_A, ["chk-b"])).toBe(false); // 3
    expect(recordClosureOpenStreak(ROOT_A, ["chk-b"])).toBe(false); // 4
    expect(recordClosureOpenStreak(ROOT_A, ["chk-b"])).toBe(true);  // 5 — escalates on ITS OWN 5th
  });

  it("closing the check after escalation does not un-latch closureEscalationFired", () => {
    for (let i = 0; i < 5; i++) recordClosureOpenStreak(ROOT_A, ["chk-a"]);
    expect(getSession(ROOT_A).closureEscalationFired).toBe(true);
    recordClosureOpenStreak(ROOT_A, []); // the check closes
    expect(getSession(ROOT_A).closureOpenStreak).toBe(0);
    expect(getSession(ROOT_A).closureEscalationFired).toBe(true); // still latched
    // A brand-new check now runs 5-in-a-row of its own — must NOT escalate again.
    for (let i = 0; i < 5; i++) {
      expect(recordClosureOpenStreak(ROOT_A, ["chk-new"])).toBe(false);
    }
  });

  it("tracks different workspaces independently", () => {
    for (let i = 0; i < 4; i++) recordClosureOpenStreak(ROOT_A, ["chk-a"]);
    expect(getSession(ROOT_A).closureOpenStreak).toBe(4);
    expect(getSession(ROOT_B).closureOpenStreak).toBe(0);
    expect(recordClosureOpenStreak(ROOT_B, ["chk-a"])).toBe(false); // B's own 1st, not A's 5th
    expect(getSession(ROOT_B).closureOpenStreak).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// recordRepeatedRead
// ---------------------------------------------------------------------------

describe("recordRepeatedRead", () => {
  it("returns 1 on the first call for a (path, range) pair", () => {
    const count = recordRepeatedRead(ROOT_A, "src/service.ts", "10-50");
    expect(count).toBe(1);
  });

  it("returns increasing counts for repeated calls", () => {
    recordRepeatedRead(ROOT_A, "src/service.ts", "10-50");
    recordRepeatedRead(ROOT_A, "src/service.ts", "10-50");
    const third = recordRepeatedRead(ROOT_A, "src/service.ts", "10-50");
    expect(third).toBe(3);
  });

  it("tracks distinct (path, range) pairs independently", () => {
    recordRepeatedRead(ROOT_A, "src/a.ts", "1-10");
    recordRepeatedRead(ROOT_A, "src/a.ts", "1-10");

    const countB = recordRepeatedRead(ROOT_A, "src/b.ts", "1-10");
    expect(countB).toBe(1);

    const countA2 = recordRepeatedRead(ROOT_A, "src/a.ts", "20-30");
    expect(countA2).toBe(1);
  });

  it("stores the count in the session map", () => {
    recordRepeatedRead(ROOT_A, "src/x.ts", "5-15");
    recordRepeatedRead(ROOT_A, "src/x.ts", "5-15");

    const s = getSession(ROOT_A);
    expect(s.repeatedReadsPerPathRange.get("src/x.ts#5-15")).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// resetWorkspace
// ---------------------------------------------------------------------------

describe("resetWorkspace", () => {
  it("clears the target workspace without touching another", () => {
    recordReadMode(ROOT_A, "full");
    recordReadMode(ROOT_A, "digest");
    recordReadMode(ROOT_B, "map");

    resetWorkspace(ROOT_A);

    // ROOT_A is gone (new empty session created on access).
    expect(getSession(ROOT_A).readsByMode.size).toBe(0);

    // ROOT_B is untouched.
    expect(getSession(ROOT_B).readsByMode.get("map")).toBe(1);
  });

  it("clears all counters for the workspace", () => {
    recordReadMode(ROOT_A, "full");
    recordFullExpansion(ROOT_A, "src/a.ts", "sha256:abc");
    recordHandleEdit(ROOT_A);
    recordPathSearchEdit(ROOT_A);
    recordRepeatedRead(ROOT_A, "src/a.ts", "1-5");
    recordSingleEditCompletion(ROOT_A);
    recordEditsBatchUsed(ROOT_A);

    resetWorkspace(ROOT_A);

    const s = getSession(ROOT_A);
    expect(s.readsByMode.size).toBe(0);
    expect(s.fullExpansionsPerPath.size).toBe(0);
    expect(s.fullExpansionsTotal).toBe(0);
    expect(s.handleBackedEdits).toBe(0);
    expect(s.pathOrSearchEditsWithoutHandle).toBe(0);
    expect(s.repeatedReadsPerPathRange.size).toBe(0);
    expect(s.singleEditCompletions).toBe(0);
    expect(s.usedEditsBatch).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// resetAll
// ---------------------------------------------------------------------------

describe("resetAll", () => {
  it("clears sessions for all workspaces", () => {
    recordReadMode(ROOT_A, "full");
    recordReadMode(ROOT_B, "map");

    resetAll();

    expect(getSession(ROOT_A).readsByMode.size).toBe(0);
    expect(getSession(ROOT_B).readsByMode.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// snapshotForTrace
// ---------------------------------------------------------------------------

describe("snapshotForTrace", () => {
  it("returns a plain object with all counters serialized", () => {
    recordReadMode(ROOT_A, "full");
    recordReadMode(ROOT_A, "full");
    recordFullExpansion(ROOT_A, "src/a.ts", "sha256:111");
    recordHandleEdit(ROOT_A);
    recordPathSearchEdit(ROOT_A);
    recordRepeatedRead(ROOT_A, "src/a.ts", "1-10");
    recordSingleEditCompletion(ROOT_A);
    recordEditsBatchUsed(ROOT_A);

    const snap = snapshotForTrace(ROOT_A);

    expect(snap.workspaceRoot).toBe(ROOT_A);
    expect((snap.readsByMode as Record<string, number>)["full"]).toBe(2);
    expect(snap.fullExpansionsTotal).toBe(1); // was 1, halved to 1 by ceil
    expect(snap.handleBackedEdits).toBe(1);
    expect(snap.pathOrSearchEditsWithoutHandle).toBe(1);
    expect(
      (snap.fullExpansionsPerPath as Record<string, { count: number; lastSha: string }>)["src/a.ts"]?.count
    ).toBe(1);
    expect(
      (snap.repeatedReadsPerPathRange as Record<string, number>)["src/a.ts#1-10"]
    ).toBe(1);
    expect(snap.singleEditCompletions).toBe(1);
    expect(snap.usedEditsBatch).toBe(true);
  });

  it("is a plain object, not a WorkspaceSession (no Maps)", () => {
    const snap = snapshotForTrace(ROOT_A);
    expect(snap.readsByMode).not.toBeInstanceOf(Map);
    expect(snap.fullExpansionsPerPath).not.toBeInstanceOf(Map);
    expect(snap.repeatedReadsPerPathRange).not.toBeInstanceOf(Map);
  });
});
