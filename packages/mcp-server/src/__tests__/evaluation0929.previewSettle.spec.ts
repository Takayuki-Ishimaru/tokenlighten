/**
 * evaluation0929.previewSettle.spec.ts — R2-R1 (P0-2): `previewSettledRemaining`,
 * the DRY RUN of `settleReadRequest` the emit funnel uses to SIZE a read
 * continuation before anything is booked.
 *
 * WHY IT EXISTS. `emit.ts` used to settle the served-range ledger and the read
 * request against the payload BEFORE its post-rewrite budget check. When that
 * check then dropped a line (or replaced the page by a refusal), the ledger had
 * already booked lines that never shipped, so `D = Q - (C u S)` never re-owed
 * them: the chain skipped them for good (review P0-2: lines 76-126 of a
 * 500-line file; FX1 chip 2: the last line of a window). The fix decides the
 * FINAL payload first (this preview is how it learns the post-swap size) and
 * settles once on what ships.
 *
 * WHAT IS PROVEN HERE — the contract that makes the preview safe to call:
 *   1. PURE. After a preview, `staged.state`, `staged.page`, `staged.version`
 *      and the PERSISTED store record are byte-identical (JSON) to before, and
 *      the very objects/arrays are the same references (nothing was mutated in
 *      place). Nothing is persisted for a request that never was.
 *   2. FAITHFUL. The preview equals what a REAL settle then records for the
 *      same shipped account, and a real settle afterwards still records
 *      normally (the preview left no residue that changes it).
 *   3. THE COVERAGE BASIS IS DOCUMENTED, not assumed. The preview does NOT read
 *      the live ledger — that already holds this call's PROVISIONAL bookings
 *      (`recordServedRange` writes the whole window the producer BUILT at serve
 *      time; the funnel confirms or retracts it only after the response is
 *      decided), so a line the ladder or the fit is about to cut would look
 *      delivered and a page cut to one line of a fully-booked window would
 *      preview as COMPLETE (no continuation at all) where the real settle owes
 *      the whole rest. It subtracts the request's OWN baseline — what the caller
 *      held BEFORE this call — and what the candidate payload ships. Case 4 pins
 *      that, and that a later confirm/retract of the provisional span changes
 *      nothing.
 */
import { afterAll, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";

import {
  choosePage,
  fixPage,
  openReadRequest,
  previewSettledRemaining,
  settleReadRequest,
  stagedFromResolution,
  type StagedReadRequest,
} from "../state/readRequestStore.js";
import { beginServeCall, recordServedRange, settleServedCallBookings } from "../state/session.js";
import { resetStateStoresForTests, stateStoreFor } from "../state/stateStore.js";
import { rmDirWithRetry } from "./helpers/rmDirWithRetry.js";
import { shortTmpDir } from "./helpers/shortTmpDir.js";

const HOME = process.env["HOME"] ?? process.env["USERPROFILE"] ?? os.homedir();
const SHA = `sha256:${"a".repeat(64)}`;
const REL = "src/a.ts";
const TOTAL = 120;
const tmpDirs: string[] = [];

afterAll(async () => {
  resetStateStoresForTests();
  for (const dir of tmpDirs.splice(0)) {
    try {
      await rmDirWithRetry(dir);
    } catch {
      /* best-effort cleanup */
    }
  }
});

function freshWs(tag: string): string {
  const ws = fs.realpathSync(shortTmpDir(HOME, `.tl-e0929-pvs-${tag}-`));
  tmpDirs.push(ws);
  resetStateStoresForTests();
  return ws;
}

function open(ws: string): StagedReadRequest {
  const staged = openReadRequest({
    workspaceRoot: ws,
    originalInput: { targets: [{ path: REL }], content: "full" },
    budget: { bytes: 6144 },
    forceServeOrigin: false,
    echo: { cwd: ws },
    targets: [{
      path: REL,
      sha: SHA,
      totalLines: TOTAL,
      representation: { content: "full", comments: "elide" },
      requested: [{ start: 1, end: TOTAL }],
    }],
  });
  if (staged === undefined) throw new Error("openReadRequest returned undefined");
  return staged;
}

function shipped(start: number, end: number): Map<string, Array<{ start: number; end: number }>> {
  return new Map([[REL, [{ start, end }]]]);
}

/** A resumed request: persisted once, a page FIXED under its cursor version, ready to be settled. */
function resumedWithFixedPage(ws: string): { staged: StagedReadRequest; page: { start: number; end: number } } {
  const opened = open(ws);
  expect(settleReadRequest(opened), "the opening settle must persist the request").toBeDefined();
  const staged = stagedFromResolution(
    ws,
    { state: opened.state, version: opened.version, storeKey: opened.storeKey },
    { cwd: ws },
  );
  const lines = Array.from({ length: TOTAL }, (_, i) => `export const L${i + 1} = ${i + 1};`);
  const choice = choosePage(staged.state, () => lines, 900, ws);
  if (!choice.ok) throw new Error(`choosePage refused: ${JSON.stringify(choice)}`);
  const fixed = fixPage(staged, staged.version, choice);
  if (!fixed.ok) throw new Error(`fixPage failed: ${JSON.stringify(fixed)}`);
  staged.page = fixed.page;
  const window = choice.windows[0]!;
  return { staged, page: { start: window.start, end: window.end } };
}

describe("previewSettledRemaining is a pure dry run of settleReadRequest", () => {
  it("open request: previews D, mutates nothing, persists nothing — and a real settle afterwards records normally", () => {
    const ws = freshWs("open");
    const staged = open(ws);
    const before = JSON.stringify(staged);
    const stateRef = staged.state;
    const pagesRef = staged.state.pages;
    const versionBefore = staged.version;

    const preview = previewSettledRemaining(staged, shipped(1, 40));

    expect([...preview.entries()]).toEqual([[REL, [{ start: 41, end: TOTAL }]]]);
    // byte-identical AND the same objects: nothing was mutated in place.
    expect(JSON.stringify(staged)).toBe(before);
    expect(staged.state).toBe(stateRef);
    expect(staged.state.pages).toBe(pagesRef);
    expect(staged.state.pages).toHaveLength(0);
    expect(staged.page).toBeUndefined();
    expect(staged.version).toBe(versionBefore);
    // nothing was written for a request that was never persisted.
    expect(stateStoreFor(ws)!.get(staged.storeKey)).toBeUndefined();

    // A REAL settle afterwards still records normally.
    const settled = settleReadRequest(staged, shipped(1, 40));
    expect(settled).toBeDefined();
    expect(settled!.targets[0]!.remaining).toEqual([{ start: 41, end: TOTAL }]);
    expect(staged.version).toBeGreaterThan(versionBefore);
    const stored = stateStoreFor(ws)!.get(staged.storeKey)!;
    expect(stored.version).toBe(staged.version);
    // the opening page (finding 8) carries exactly what shipped
    expect(settled!.pages).toHaveLength(1);
    expect(settled!.pages[0]!.shipped).toEqual([{ path: REL, window: { start: 1, end: 40 } }]);
    // and the preview said the same thing the real settle recorded
    expect(preview.get(REL)).toEqual(settled!.targets[0]!.remaining);
  });

  it("resumed request with a fixed page: preview re-owes a shrunk-away line, leaves the persisted record untouched, and equals the real settle", () => {
    const ws = freshWs("resume");
    const { staged, page } = resumedWithFixedPage(ws);
    expect(page.end - page.start, "the page must span several lines for a shrink to mean something").toBeGreaterThan(2);
    const store = stateStoreFor(ws)!;
    const recordBefore = JSON.stringify(store.get(staged.storeKey));
    const stagedBefore = JSON.stringify(staged);
    const stateRef = staged.state;
    const pagesRef = staged.state.pages;
    const pageRef = staged.page;

    // The page shipped ONE LINE SHORT (the emit tail's post-rewrite shrink).
    const shrunk = shipped(page.start, page.end - 1);
    const preview = previewSettledRemaining(staged, shrunk);

    expect(JSON.stringify(staged)).toBe(stagedBefore);
    expect(JSON.stringify(store.get(staged.storeKey))).toBe(recordBefore);
    expect(staged.state).toBe(stateRef);
    expect(staged.state.pages).toBe(pagesRef);
    expect(staged.page).toBe(pageRef);
    // the dropped last line of the page is OWED again, first in D.
    const owed = preview.get(REL)!;
    expect(owed[0]!.start).toBe(page.end);

    // a real settle records exactly what the preview said, and persists.
    const real = settleReadRequest(staged, shrunk);
    expect(real).toBeDefined();
    expect(real!.targets[0]!.remaining).toEqual(owed);
    expect(JSON.stringify(store.get(staged.storeKey))).not.toBe(recordBefore);
    const persisted = store.get(staged.storeKey)!.data as { pages: Array<{ cursor_state_version: number; shipped?: unknown[] }> };
    const fixedPage = persisted.pages.find((p) => p.cursor_state_version === (staged.page as { cursor_state_version: number }).cursor_state_version)!;
    expect(fixedPage.shipped, "the real settle books ONLY what shipped (one line short)").toEqual([
      { path: REL, window: { start: page.start, end: page.end - 1 } },
    ]);
  });

  it("a receipt-shaped account (shipped undefined) previews as the real settle credits it, also without side effects", () => {
    const ws = freshWs("receipt");
    const { staged, page } = resumedWithFixedPage(ws);
    const store = stateStoreFor(ws)!;
    const recordBefore = JSON.stringify(store.get(staged.storeKey));
    const stagedBefore = JSON.stringify(staged);

    const preview = previewSettledRemaining(staged, undefined);
    expect(JSON.stringify(staged)).toBe(stagedBefore);
    expect(JSON.stringify(store.get(staged.storeKey))).toBe(recordBefore);
    // a receipt credits the PLANNED page wholesale: D starts right after it.
    expect(preview.get(REL)![0]!.start).toBe(page.end + 1);

    const real = settleReadRequest(staged, undefined);
    expect(real!.targets[0]!.remaining).toEqual(preview.get(REL));
  });

  it("COVERAGE BASIS: the preview subtracts the request's own baseline and what the payload ships — never this call's still-provisional bookings", () => {
    const ws = freshWs("basis");
    // 1-30 was served and SETTLED by an earlier call: the caller holds it.
    recordServedRange(ws, REL, SHA, 1, 30, TOTAL, { mode: "full-head", range: "1-30", call: beginServeCall(ws) });
    settleServedCallBookings({ unattributed: false, windows: [{ path: REL, start: 1, end: 30 }] }, ws);
    const staged = open(ws); // baseline = 1-30
    // THIS call books 31-90 PROVISIONALLY (a producer building a big window) ...
    recordServedRange(ws, REL, SHA, 31, 90, TOTAL, { mode: "full-head", range: "31-90", call: beginServeCall(ws) });

    // ... of which the funnel will ship only 31-40. The cut lines are OWED: a
    // live-ledger preview would have called 41-90 delivered.
    expect(previewSettledRemaining(staged, shipped(31, 40)).get(REL)).toEqual([{ start: 41, end: TOTAL }]);
    // Nothing shipped at all: everything except the baseline is owed.
    expect(previewSettledRemaining(staged, new Map()).get(REL)).toEqual([{ start: 31, end: TOTAL }]);

    // Whether the funnel then confirms (narrowing to what shipped) or retracts the
    // provisional span makes no difference to the preview: it never read it.
    settleServedCallBookings({ unattributed: false, windows: [{ path: REL, start: 31, end: 40 }] }, ws);
    expect(previewSettledRemaining(staged, shipped(31, 40)).get(REL)).toEqual([{ start: 41, end: TOTAL }]);
    expect(previewSettledRemaining(staged, new Map()).get(REL)).toEqual([{ start: 31, end: TOTAL }]);
  });
});
