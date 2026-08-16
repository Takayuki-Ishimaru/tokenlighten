/**
 * adaptive.ts — pure decision module for v0.7 adaptive session control.
 *
 * Reads session counters to determine whether the current session is regressing
 * (repeated full reads, path-edit loops). Returns advice that callers use to
 * alter MCP behavior. No I/O.
 */

import { getSession } from "../state/session.js";
import { PER_TASK_FULL_CAP } from "../shared/readLimits.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface AdaptiveAdvice {
  /** If true, the next path-edit-without-handle should be rejected. */
  lockdownPathEdits: boolean;
  /** If true, the governor should downgrade more aggressively. */
  tightenGovernor: boolean;
  /** Numeric: the effective per-task full-read cap (default PER_TASK_FULL_CAP). */
  effectivePerTaskCap: number;
}

// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------

/** Minimum repeated-read count for a (path, range) pair to trigger tightenGovernor. */
const REPEATED_READ_THRESHOLD = 3;

/** Floor for effectivePerTaskCap when governor is tightened. */
const EFFECTIVE_CAP_FLOOR = 1;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Return adaptive advice based on the current session counters for workspace.
 *
 * D10 (2026-08-14): adaptive session control is unconditional. `TL_SESSION_CONTROL`
 * and its inactive-advice off-branch are deleted.
 */
export function getAdaptiveAdvice(workspace: string): AdaptiveAdvice {
  const s = getSession(workspace);

  // lockdownPathEdits: once the agent has demonstrated it CAN use handles
  // (handleBackedEdits >= 1), repeated path edits indicate regression.
  const lockdownPathEdits =
    s.handleBackedEdits >= 1 &&
    s.pathOrSearchEditsWithoutHandle >= 2 * (s.handleBackedEdits + 1);

  // tightenGovernor: any single (path, range) read at or above the threshold.
  let tightenGovernor = false;
  for (const count of s.repeatedReadsPerPathRange.values()) {
    if (count >= REPEATED_READ_THRESHOLD) {
      tightenGovernor = true;
      break;
    }
  }

  // effectivePerTaskCap: reduce by 1 (floor 1) when tightenGovernor is true.
  const effectivePerTaskCap = tightenGovernor
    ? Math.max(EFFECTIVE_CAP_FLOOR, PER_TASK_FULL_CAP - 1)
    : PER_TASK_FULL_CAP;

  return { lockdownPathEdits, tightenGovernor, effectivePerTaskCap };
}
