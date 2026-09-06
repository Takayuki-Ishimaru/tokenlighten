// ---------------------------------------------------------------------------
// sfLedgerReader.ts — Wave 3 wiring: `SfServedLedgerReader` over the real
// `state/session.ts` served-range ledger.
//
// `sfState.ts` (DESIGN-v0.15-semantic-frontier-plan.md §3.2/DC3) deliberately
// takes byte residency through an INJECTED `SfServedLedgerReader` rather than
// importing `state/session.ts` directly — that seam is what let Wave 1/2 land
// with zero coupling to the file this module now wires. This is that wiring,
// and NOTHING ELSE: a thin adapter that binds the three ledger accessors
// `sfState.ts` asks for to one `workspaceRoot`, so a caller building an
// `SfTaskContext` can hand it a ready `ledger` without touching `session.ts`
// itself.
//
// W-WIRE-2A SCOPE NOTE: this module does not construct `SfTaskContext` and is
// not called from production `server.ts` yet — `SfTaskContext` production
// wiring is Wave 3 proper. This file only makes the reader exist and proves it
// correct against a real session (see `sfLedgerReader.spec.ts`).
// ---------------------------------------------------------------------------

import { getReadPaths, servedRangeCoverage, wasFullyServed } from "../state/session.js";
import type { SfServedLedgerReader } from "./sfState.js";

/**
 * Builds an `SfServedLedgerReader` bound to `workspaceRoot`, backed by the
 * real per-session served-range ledger in `state/session.ts`.
 *
 * Every method is a direct, unmodified delegation — this adapter reshapes
 * argument order (dropping the now-implicit `workspaceRoot`) and nothing else,
 * so it can manufacture no residency claim `state/session.ts` itself would not
 * make.
 */
export function createSessionLedgerReader(workspaceRoot: string): SfServedLedgerReader {
  return {
    hasServedPath(path: string): boolean {
      // `getReadPaths()` membership, as `SfServedLedgerReader`'s own doc
      // comment specifies: "has any body of this path been served?" — a
      // structural read (an outline/skeleton) also books a `readPaths` entry,
      // so this answers "has ANY serve of this path happened", not "does the
      // session hold direct bytes" (that is `wasFullyServed`/`servedRangeCoverage`).
      return getReadPaths(workspaceRoot).includes(path);
    },
    wasFullyServed(path: string, sha: string): boolean {
      return wasFullyServed(workspaceRoot, path, sha);
    },
    servedRangeCoverage(path: string, sha: string, totalLines: number) {
      return servedRangeCoverage(workspaceRoot, path, sha, totalLines);
    },
  };
}
