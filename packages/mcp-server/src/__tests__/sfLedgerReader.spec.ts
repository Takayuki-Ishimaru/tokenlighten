// sfLedgerReader.spec.ts — W-WIRE-2A (Wave 3 wiring)
//
// `task-state/sfLedgerReader.ts`'s `createSessionLedgerReader` is a thin
// adapter binding `SfServedLedgerReader` (the interface `sfState.ts` asks for,
// DC3's "byte residency" question) to the real per-session ledger in
// `state/session.ts`. Unit-level, driven through `state/session.ts`'s own
// public recording API — exactly like `coverageReceipt.spec.ts` — so a
// failure here names the adapter, not a whole child server.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  getReadPaths,
  recordFullExpansion,
  recordFullServeCompleteness,
  recordReadPath,
  recordServedRange,
  resetAll,
  settleServedRanges,
} from "../state/session.js";
import { createSessionLedgerReader } from "../task-state/sfLedgerReader.js";
import type { SfServedLedgerReader } from "../task-state/sfState.js";

const WS = "/ws/sf-ledger-reader";
const FILE = "src/target.ts";
const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const TOTAL = 100;

/** One honest, SETTLED serve — matches `emitFinalizedPayload`'s two-step recording. */
function serve(start: number, end: number, sha: string = SHA_A): void {
  recordServedRange(WS, FILE, sha, start, end, TOTAL, {
    mode: "slice",
    range: `${start}-${end}`,
    call: start,
  });
  settleServedRanges(WS, { unattributed: false, windows: [{ path: FILE, start, end }] });
}

let reader: SfServedLedgerReader;

beforeEach(() => {
  resetAll();
  reader = createSessionLedgerReader(WS);
});

afterEach(() => {
  resetAll();
});

describe("createSessionLedgerReader — delegation is exact, nothing manufactured", () => {
  it("hasServedPath: false before any serve, true after — getReadPaths() membership", () => {
    expect(reader.hasServedPath(FILE)).toBe(false);
    recordReadPath(WS, FILE);
    expect(reader.hasServedPath(FILE)).toBe(true);
    expect(getReadPaths(WS)).toContain(FILE);
  });

  it("hasServedPath: is per-path, not a blanket true once ANY path is read", () => {
    recordReadPath(WS, "src/other.ts");
    expect(reader.hasServedPath(FILE)).toBe(false);
  });

  it("wasFullyServed: false until a tracked full expansion is recorded at this sha", () => {
    expect(reader.wasFullyServed(FILE, SHA_A)).toBe(false);
    recordFullExpansion(WS, FILE, SHA_A, false);
    recordFullServeCompleteness(WS, FILE, SHA_A, true, false);
    expect(reader.wasFullyServed(FILE, SHA_A)).toBe(true);
    // A different sha is a different (path,sha) identity — never conflated.
    expect(reader.wasFullyServed(FILE, SHA_B)).toBe(false);
  });

  it("wasFullyServed: a CHUNKED full serve (complete:false) is never claimed as full", () => {
    recordFullExpansion(WS, FILE, SHA_A, false);
    recordFullServeCompleteness(WS, FILE, SHA_A, false, false);
    expect(reader.wasFullyServed(FILE, SHA_A)).toBe(false);
  });

  it("servedRangeCoverage: a served slice is reported back verbatim, with a live 'unserved' complement", () => {
    serve(1, 40);
    const coverage = reader.servedRangeCoverage(FILE, SHA_A, TOTAL);
    expect(coverage).toBeDefined();
    expect(coverage!.served).toEqual([[1, 40]]);
    expect(coverage!.complete).toBe(false);
    expect(coverage!.unserved.length).toBeGreaterThan(0);
  });

  it("servedRangeCoverage: cumulative slices covering the whole file report complete:true", () => {
    serve(1, 50);
    serve(51, 100);
    const coverage = reader.servedRangeCoverage(FILE, SHA_A, TOTAL);
    expect(coverage?.complete).toBe(true);
    expect(coverage?.unserved).toEqual([]);
  });

  it("servedRangeCoverage: no ledger entry at all => undefined, not an empty-but-defined shape", () => {
    expect(reader.servedRangeCoverage(FILE, SHA_A, TOTAL)).toBeUndefined();
  });

  it("EDIT, assert stale: a served slice reported at the file's OLD sha reads as undefined once the sha moves — the ledger never answers for content it never saw", () => {
    serve(1, 40, SHA_A);
    expect(reader.servedRangeCoverage(FILE, SHA_A, TOTAL)).toBeDefined();
    expect(reader.wasFullyServed(FILE, SHA_A)).toBe(false); // never a full serve here, only a slice

    // The file changed underneath the session (an external edit, or a
    // server-applied edit whose delta-transform did not run/does not apply).
    // The pre-edit sha's residency must not answer for the post-edit bytes.
    expect(reader.servedRangeCoverage(FILE, SHA_B, TOTAL)).toBeUndefined();
    recordFullExpansion(WS, FILE, SHA_A, false);
    recordFullServeCompleteness(WS, FILE, SHA_A, true, false);
    expect(reader.wasFullyServed(FILE, SHA_A)).toBe(true);
    expect(reader.wasFullyServed(FILE, SHA_B)).toBe(false);
  });

  it("is scoped per workspaceRoot — a reader for one root never answers for another's ledger", () => {
    serve(1, 40);
    const otherReader = createSessionLedgerReader("/ws/sf-ledger-reader-other");
    expect(otherReader.servedRangeCoverage(FILE, SHA_A, TOTAL)).toBeUndefined();
    expect(otherReader.hasServedPath(FILE)).toBe(false);
    // The original root is unaffected by a second reader's existence.
    expect(reader.servedRangeCoverage(FILE, SHA_A, TOTAL)).toBeDefined();
  });
});
