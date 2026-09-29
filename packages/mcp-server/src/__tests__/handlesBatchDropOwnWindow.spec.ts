/**
 * handlesBatchDropOwnWindow.spec.ts — held item 7 (review-findings.md),
 * "no widening on the A7 construction-time drop".
 *
 * THE DEFECT. FIX-A6 (TL-A6-2, v0.14.4 candidate item 2) made the A7
 * `handles=[]` batch's construction-time `cap-exceeded` omission (server.ts:
 * the aggregate-ceiling check inside the `handles=[]` loop) recoverable at
 * all, by attaching the dropped handle's `path` to its `omitted[]` entry —
 * before that, `readFamily.ts`'s `deriveNext` (rung 3) had no path to build a
 * `next` from and the drop was simply unreachable. But `deriveNext` reads
 * ONLY `.path` off every omitted entry and always minted a WHOLE-FILE
 * `mode:"full"` recovery — so a dropped `{handle, range}` entry (one that
 * only ever addressed a NARROW window of a possibly much larger file) got
 * widened into "re-read the entire file", serving lines the caller never
 * asked for and costing far more than its own declared budget just to get
 * back the one small slice it actually wanted.
 *
 * THE FIX: server.ts's TL-A6-2 push now also carries the dropped handle's own
 * `range` (from `handleTable`, no file I/O) and whether the ORIGINAL call
 * requested `content:"full"`. `readFamily.ts`'s `deriveNext` rung 3 now reads
 * `.range` off each omitted entry: an entry that has one recovers via ITS OWN
 * `{handle, range}` window (canonical `targets:[]`, `content:"full"` echoed
 * when the marker is set); only entries with NO range (unaffected by this
 * fix) still widen to the legacy whole-file `mode:"full"` bucket.
 *
 * THIS TEST pins: following the recovery `next` delivers EXACTLY the
 * requested window — no line outside it.
 */
import { afterAll, afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { shortTmpDir } from "./helpers/shortTmpDir.js";
import { rmDirWithRetry } from "./helpers/rmDirWithRetry.js";
import { startDevServer, type ServerHandle } from "./helpers/qualityFirstScenarios.js";

const HOME = process.env["HOME"] ?? process.env["USERPROFILE"] ?? os.homedir();

function pick(obj: unknown, keyPath: string): any {
  return keyPath.split(".").reduce((acc: any, key) => (acc == null ? undefined : acc[key]), obj);
}

/** `count` self-identifying lines, each padded to `width` bytes, for `label`. */
function selfIdLines(label: string, count: number, width: number): string {
  const lines: string[] = [];
  for (let i = 1; i <= count; i += 1) {
    const prefix = `${label}-line-${i.toString().padStart(5, "0")} `;
    lines.push(prefix.padEnd(width, "x"));
  }
  return lines.join("\n") + "\n";
}

const activeServers: ServerHandle[] = [];
const tmpDirs: string[] = [];
// Every server is started inside one test (held item 7's single case, and
// each of the two `describe.each` config cells below); stop it when that
// test ends so this file's 5 cases never hold all their servers alive at
// once.
afterEach(async () => {
  for (const s of activeServers.splice(0)) await s.kill();
});

afterAll(async () => {
  for (const s of activeServers.splice(0)) await s.kill();
  for (const dir of tmpDirs.splice(0)) {
    try {
      await rmDirWithRetry(dir);
    } catch {
      /* best-effort */
    }
  }
});

describe("held item 7: a construction-time handles=[] cap-exceeded drop recovers its OWN window, never the whole file", () => {
  it("pinned: the dropped ranged handle's next targets its own range; following it serves exactly that window", async () => {
    const ws = fs.realpathSync(shortTmpDir(HOME, ".tl-h7-dropwindow-"));
    tmpDirs.push(ws);
    // Two sizable files, each far larger than the narrow window we will
    // request a handle for — the whole-file widening this fix forbids would
    // be trivially observable (many more lines than the requested range).
    const TOTAL_LINES = 2000;
    const LINE_WIDTH = 120;
    fs.writeFileSync(path.join(ws, "alpha.txt"), selfIdLines("alpha", TOTAL_LINES, LINE_WIDTH), "utf8");
    fs.writeFileSync(path.join(ws, "beta.txt"), selfIdLines("beta", TOTAL_LINES, LINE_WIDTH), "utf8");

    const server = startDevServer(ws, "default");
    activeServers.push(server);
    await server.initialize();

    // Mint two RANGED handles (narrow windows, each ~200 lines * 120B =~24KB
    // — sizable but each individually well under any per-item cap), one per
    // file — this is the "handle addressed a range" precondition.
    const REQUESTED_RANGE = "1-200";
    const alphaRead = await server.callTool("read_file", {
      targets: [{ path: "alpha.txt", range: REQUESTED_RANGE }],
      cwd: ws,
    });
    const betaRead = await server.callTool("read_file", {
      targets: [{ path: "beta.txt", range: REQUESTED_RANGE }],
      cwd: ws,
    });
    const alphaHandle: string | undefined = pick(alphaRead.body, "evidence.0.handle") ?? alphaRead.body?.entries?.[0]?.handle;
    const betaHandle: string | undefined = pick(betaRead.body, "evidence.0.handle") ?? betaRead.body?.entries?.[0]?.handle;
    expect(typeof alphaHandle, `no handle minted for alpha.txt: ${JSON.stringify(alphaRead.body).slice(0, 800)}`).toBe("string");
    expect(typeof betaHandle, `no handle minted for beta.txt: ${JSON.stringify(betaRead.body).slice(0, 800)}`).toBe("string");

    // A `handles=[]` batch of BOTH (canonical `targets:[{handle}]` shape —
    // `handles:[]`/`maxBytes` are legacy and refused by default), with a
    // byte ceiling that fits the FIRST handle's ~24KB body but not both —
    // forcing the aggregate ceiling (T2, server.ts) to construction-time-drop
    // the SECOND.
    // Small enough that ALPHA alone (guaranteed through in full at
    // construction time, per T2's "at least one item always gets through")
    // already exceeds it, so BETA sees `handlesBatchCapHit` and is dropped
    // at CONSTRUCTION TIME (never even resolved) rather than truncated by
    // the later wire-level shed ladder.
    const batch = await server.callTool("read_file", {
      targets: [{ handle: alphaHandle }, { handle: betaHandle }],
      budget: { bytes: 8_000 },
      cwd: ws,
    });
    const entries: any[] = Array.isArray(batch.body?.entries) ? batch.body.entries : [];
    const droppedCount = 2 - entries.length;
    const diagnostic = {
      entryCount: entries.length,
      droppedCount,
      limit: batch.body?.limit,
      bodyKeys: Object.keys(batch.body ?? {}),
      fullBody: batch.body,
    };
    expect(droppedCount, `expected exactly one handle dropped by the aggregate cap: ${JSON.stringify(diagnostic, null, 2)}`).toBe(1);

    const next = pick(batch.body, "limit.next") ?? batch.body?.next;
    expect(next, `no recovery next was minted for the dropped handle: ${JSON.stringify(diagnostic, null, 2)}`).toBeDefined();

    // THE PIN: the minted recovery must NOT be a whole-file `mode:"full"`
    // widening — it must target the dropped handle's OWN range.
    const nextArgs = next.arguments ?? {};
    const isLegacyWholeFile = nextArgs.mode === "full" && Array.isArray(nextArgs.paths);
    expect(
      isLegacyWholeFile,
      `held item 7 regression: the dropped ranged handle's recovery widened to a whole-file mode:"full" continuation: ${JSON.stringify(next, null, 2)}`,
    ).toBe(false);
    const nextTargets: any[] = Array.isArray(nextArgs.targets) ? nextArgs.targets : [];
    const targetsOwnWindow = nextTargets.some((t) => t?.range === REQUESTED_RANGE && (t?.handle === betaHandle || t?.handle === alphaHandle || t?.path === "beta.txt" || t?.path === "alpha.txt"));
    expect(
      targetsOwnWindow,
      `recovery next does not target the dropped handle's own ${REQUESTED_RANGE} window: ${JSON.stringify(next, null, 2)}`,
    ).toBe(true);

    // Follow the recovery verbatim and verify it delivers EXACTLY the
    // requested window — no line outside 1-200.
    const recovered = await server.callTool(next.tool, next.arguments);
    const recoveredText = JSON.stringify(recovered.body);
    if (recovered.body?.kind === "read.receipt") {
      // beta's 1-200 slice was already served once (minting the handle
      // above), so the server's own sha-based dedup recognizes this
      // recovery as requesting the IDENTICAL bytes it already holds and
      // returns a compact receipt instead of re-sending them — itself
      // authoritative proof the recovery targeted the SAME window (a
      // whole-file widening would name a DIFFERENT range/handle and could
      // never dedup-match here). `served_by` states the exact slice.
      const servedBy = String(recovered.body?.receipt?.served_by ?? "");
      expect(
        servedBy.includes(REQUESTED_RANGE),
        `held item 7 regression: receipt's served_by does not name the requested window — recovery widened to something else: ${recoveredText}`,
      ).toBe(true);
    } else {
      // The window's own first/last self-identifying lines must be present...
      expect(recoveredText.includes("-line-00001 "), `recovered body: ${recoveredText.slice(0, 2000)}`).toBe(true);
      expect(recoveredText.includes("-line-00200 "), `recovered body: ${recoveredText.slice(0, 2000)}`).toBe(true);
      // ...and NOTHING past it (the whole-file-widening symptom this fix
      // forbids: line 201+ would appear only if the whole 2000-line file was
      // served instead of just 1-200).
      expect(
        recoveredText.includes("-line-00201 "),
        `recovery served past the requested window (whole-file widening): ${recoveredText.slice(0, 1500)}`,
      ).toBe(false);
      expect(
        recoveredText.includes("-line-02000 "),
        `recovery served the file's tail (whole-file widening): ${recoveredText.slice(0, 1500)}`,
      ).toBe(false);
    }
  }, 60_000);
});

// ---------------------------------------------------------------------------
// R-A3 (v0.14.4 candidate, 2026-09-21) — regression for a SMALL follow-up fix
// to the SAME TL-A6-2 push site the "pinned" test above exercises.
//
// THE DEFECT (pre-fix). The TL-A6-2 push computed the dropped handle's
// recovery `range` from `capHEntry.range` ALONE — the handle's own STORED
// range, fixed at MINT time. A handle minted from a NARROW window (`1-1`)
// and re-addressed in a LATER handles=[] batch item with its OWN EXPLICIT
// override (`{handle, range:"1-12"}`) recovered only the MINT window
// (`1-1`) when construction-time-dropped: lines 2-12 — the part THIS call
// actually asked for — were silently lost, because the override lives only
// in THIS call's own arguments, never in the handle table `capHEntry` reads.
//
// THE FIX (server.ts, orchestrator, already in the tree): the push now
// prefers `handleOverrides[hIdx].range` (the window THIS call requested)
// over `capHEntry.range` (the handle's stored MINT window), falling back to
// the stored range only when the call carried no override — a symbol
// override still recovers whole-file (no line window to name).
// ---------------------------------------------------------------------------
describe.each(["default", "vscode"] as const)(
  "R-A3 regression (%s config): a construction-time drop uses THIS call's own override range, not the handle's mint range",
  (config) => {
    it("a handle minted from a NARROW range, re-addressed with a WIDER override, recovers the OVERRIDE window — not the mint sliver", async () => {
      const ws = fs.realpathSync(shortTmpDir(HOME, `.tl-r-a3-override-${config}-`));
      tmpDirs.push(ws);
      const TOTAL_LINES = 2000;
      const LINE_WIDTH = 120;
      fs.writeFileSync(path.join(ws, "big.txt"), selfIdLines("big", TOTAL_LINES, LINE_WIDTH), "utf8");
      fs.writeFileSync(path.join(ws, "narrow.txt"), selfIdLines("narrow", TOTAL_LINES, LINE_WIDTH), "utf8");

      const server = startDevServer(ws, config);
      activeServers.push(server);
      await server.initialize();

      // bigHandle: minted over a wide window (~24 KB), big enough to alone
      // cross the aggregate ceiling below (T2's "at least one item always
      // gets through" ships it whole regardless). narrowHandle: minted over
      // a NARROW one-line window ("1-1") — its own STORED range.
      const BIG_RANGE = "1-200";
      const MINT_RANGE = "1-1";
      const OVERRIDE_RANGE = "1-12";
      const bigRead = await server.callTool("read_file", { targets: [{ path: "big.txt", range: BIG_RANGE }], cwd: ws });
      const narrowRead = await server.callTool("read_file", { targets: [{ path: "narrow.txt", range: MINT_RANGE }], cwd: ws });
      const bigHandle: string | undefined = pick(bigRead.body, "evidence.0.handle") ?? bigRead.body?.entries?.[0]?.handle;
      const narrowHandle: string | undefined = pick(narrowRead.body, "evidence.0.handle") ?? narrowRead.body?.entries?.[0]?.handle;
      expect(typeof bigHandle, `no handle minted for big.txt: ${JSON.stringify(bigRead.body).slice(0, 800)}`).toBe("string");
      expect(typeof narrowHandle, `no handle minted for narrow.txt: ${JSON.stringify(narrowRead.body).slice(0, 800)}`).toBe("string");

      // A handles=[] batch: bigHandle FIRST with NO override (re-serves its
      // own ~24 KB mint window, crossing the ceiling alone), THEN
      // narrowHandle SECOND with an EXPLICIT override range ("1-12") WIDER
      // than its own mint window ("1-1") — forcing the aggregate ceiling
      // (T2) to construction-time-drop narrowHandle.
      const batch = await server.callTool("read_file", {
        targets: [{ handle: bigHandle }, { handle: narrowHandle, range: OVERRIDE_RANGE }],
        budget: { bytes: 8_000 },
        cwd: ws,
      });
      const entries: any[] = Array.isArray(batch.body?.entries) ? batch.body.entries : [];
      const droppedCount = 2 - entries.length;
      const diagnostic = {
        entryCount: entries.length,
        droppedCount,
        limit: batch.body?.limit,
        bodyKeys: Object.keys(batch.body ?? {}),
        fullBody: batch.body,
      };
      expect(droppedCount, `expected exactly one handle dropped by the aggregate cap: ${JSON.stringify(diagnostic, null, 2)}`).toBe(1);

      const next = pick(batch.body, "limit.next") ?? batch.body?.next;
      expect(next, `no recovery next was minted for the dropped handle: ${JSON.stringify(diagnostic, null, 2)}`).toBeDefined();

      // THE PIN: the minted recovery must target the OVERRIDE window
      // ("1-12"), never the handle's own MINT window ("1-1") — the exact
      // regression the orchestrator's fix closes.
      const nextArgs = next.arguments ?? {};
      const nextTargets: any[] = Array.isArray(nextArgs.targets) ? nextArgs.targets : [];
      const recovered = nextTargets.find((t) => t?.handle === narrowHandle || t?.path === "narrow.txt");
      expect(recovered, `no recovery target names narrowHandle/narrow.txt: ${JSON.stringify(next, null, 2)}`).toBeDefined();
      expect(
        recovered?.range,
        `R-A3 regression: the dropped handle's recovery used the MINT range ("${MINT_RANGE}") instead of THIS call's own override ("${OVERRIDE_RANGE}"): ${JSON.stringify(next, null, 2)}`,
      ).toBe(OVERRIDE_RANGE);
      expect(recovered?.range).not.toBe(MINT_RANGE);

      // Follow the recovery verbatim: it must deliver exactly lines 1-12 of
      // narrow.txt — no line outside that window.
      const recoveredCall = await server.callTool(next.tool, next.arguments);
      const recoveredText = JSON.stringify(recoveredCall.body);
      if (recoveredCall.body?.kind === "read.receipt") {
        // Only reachable if the recovery's own range happens to dedup-match
        // bytes already on the wire (line 1, from minting) — the assertion
        // above already pinned the recovery's OWN range to "1-12", so this
        // arm is a defensive fallback, not the expected shape.
        const servedBy = String(recoveredCall.body?.receipt?.served_by ?? "");
        expect(servedBy.includes(OVERRIDE_RANGE) || servedBy.includes(MINT_RANGE), recoveredText).toBe(true);
      } else {
        expect(recoveredText.includes("narrow-line-00001 "), recoveredText.slice(0, 1500)).toBe(true);
        expect(recoveredText.includes("narrow-line-00012 "), recoveredText.slice(0, 1500)).toBe(true);
        expect(
          recoveredText.includes("narrow-line-00013 "),
          `recovery served past the requested window: ${recoveredText.slice(0, 1500)}`,
        ).toBe(false);
      }
    }, 60_000);
  },
);

// ---------------------------------------------------------------------------
// R-A3 (v0.14.4 candidate, 2026-09-21) — target-count cap. `readFamily.ts`'s
// `deriveNext` used to `.slice(0, 8)` the construction-time-omitted bundle it
// builds a recovery `next` from — a silent truncation that lost windows 9+
// for a verbatim follower, with no OTHER field ever re-addressing them (an
// omitted-at-construction-time entry never reaches `entries[]`, so it has no
// per-entry fallback the way a wire-level narrowed-but-present entry does).
// The advertised `read_file` schema declares no `maxItems` on `targets`, so
// the fix is to name EVERY undelivered window and let the response budget
// decide how much of the recovery hop's own body fits (plan §4's rule, per
// this file's own R-A3 banner further up). This test proves it with MORE
// THAN 8 constructions-time-dropped handles in one call.
// ---------------------------------------------------------------------------
describe.each(["default", "vscode"] as const)(
  "R-A3 (%s config): a construction-time recovery names every dropped handle, not just the first 8",
  (config) => {
    it("12 handles, only the first fits under the ceiling: all 11 dropped handles are named in ONE recovery next, and every requested line eventually arrives", async () => {
      const ws = fs.realpathSync(shortTmpDir(HOME, `.tl-r-a3-12cap-${config}-`));
      tmpDirs.push(ws);
      const SMALL_COUNT = 11;
      const SMALL_LINES = 3;
      const SMALL_WIDTH = 40;
      const BIG_LINES = 200;
      const BIG_WIDTH = 120;
      fs.writeFileSync(path.join(ws, "big.txt"), selfIdLines("big", BIG_LINES, BIG_WIDTH), "utf8");
      for (let i = 0; i < SMALL_COUNT; i += 1) {
        fs.writeFileSync(path.join(ws, `small${i}.txt`), selfIdLines(`small${i}`, SMALL_LINES, SMALL_WIDTH), "utf8");
      }

      const server = startDevServer(ws, config);
      activeServers.push(server);
      await server.initialize();

      // bigHandle: minted over its own whole ~24 KB window — alone crosses
      // the aggregate ceiling below (T2's "at least one item always gets
      // through" ships it whole). Each smallN handle: minted over its own
      // whole (tiny) window — same range it will be re-requested with, so
      // the construction-time drop's recovery is proven complete rather than
      // (also, separately, R-A3 Item 2's own concern) correctly re-targeted.
      const bigRead = await server.callTool("read_file", { targets: [{ path: "big.txt", range: `1-${BIG_LINES}` }], cwd: ws });
      const bigHandle: string | undefined = pick(bigRead.body, "evidence.0.handle") ?? bigRead.body?.entries?.[0]?.handle;
      expect(typeof bigHandle, `no handle minted for big.txt: ${JSON.stringify(bigRead.body).slice(0, 800)}`).toBe("string");

      const smallHandles: string[] = [];
      for (let i = 0; i < SMALL_COUNT; i += 1) {
        const read = await server.callTool("read_file", { targets: [{ path: `small${i}.txt`, range: `1-${SMALL_LINES}` }], cwd: ws });
        const handle: string | undefined = pick(read.body, "evidence.0.handle") ?? read.body?.entries?.[0]?.handle;
        expect(typeof handle, `no handle minted for small${i}.txt: ${JSON.stringify(read.body).slice(0, 800)}`).toBe("string");
        smallHandles.push(handle!);
      }

      // A 12-target handles=[] batch: bigHandle FIRST (crosses the ceiling
      // alone), then all 11 smallN handles — every one of them dropped at
      // CONSTRUCTION TIME, before the wire ladder ever runs.
      const batch = await server.callTool("read_file", {
        targets: [{ handle: bigHandle }, ...smallHandles.map((handle) => ({ handle }))],
        budget: { bytes: 8_000 },
        cwd: ws,
      });
      const entries: any[] = Array.isArray(batch.body?.entries) ? batch.body.entries : [];
      const diagnostic = { entryCount: entries.length, limit: batch.body?.limit, bodyKeys: Object.keys(batch.body ?? {}) };
      expect(entries.length, `expected exactly bigHandle to ship at construction time: ${JSON.stringify(diagnostic, null, 2)}`).toBe(1);

      const next = pick(batch.body, "limit.next") ?? batch.body?.next;
      expect(next, `no recovery next was minted for the 11 dropped handles: ${JSON.stringify(diagnostic, null, 2)}`).toBeDefined();
      const nextTargets: any[] = Array.isArray(next.arguments?.targets) ? next.arguments.targets : [];

      // THE PIN: all 11 dropped handles are named — not silently capped at 8.
      const namedHandles = new Set(nextTargets.map((t) => t?.handle).filter((h): h is string => typeof h === "string"));
      for (const handle of smallHandles) {
        expect(
          namedHandles.has(handle),
          `R-A3 target-count-cap regression: handle ${handle} is missing from the recovery next (named ${namedHandles.size} of ${SMALL_COUNT}): ${JSON.stringify(next, null, 2).slice(0, 3000)}`,
        ).toBe(true);
      }
      // NOT an exact-length pin: bigHandle (the one entry construction-time
      // admitted whole) can ALSO be wire-level narrowed by this response's
      // own shed ladder to fit `budget.bytes:8000` alongside 11 targets'
      // worth of recovery JSON — R-A3's OWN clause-4 union (item 1) then
      // correctly folds bigHandle's own remainder into this SAME `next`
      // too, since it is a pre-existing emitter limit case. That is a
      // DIFFERENT, already-covered concern (`readBatchDropRecoveryCompleteness
      // .spec.ts`'s own construction-time-drop suite); this test only pins
      // "at least the 11 small handles, never fewer via a silent 8-cap".
      expect(
        nextTargets.length,
        `expected at least ${SMALL_COUNT} targets (the 11 dropped handles, plus possibly bigHandle's own remainder), got ${nextTargets.length}: ${JSON.stringify(next).slice(0, 2000)}`,
      ).toBeGreaterThanOrEqual(SMALL_COUNT);

      // Follow the recovery verbatim: every small file's line 1..N must
      // arrive somewhere in the chain (the wire-level shed ladder may still
      // narrow/drop entries of THIS hop's own body if it does not fit
      // `budget.bytes:8000` — that is a SEPARATE, already-covered concern;
      // this walk only needs completeness, following limit.next/top-level
      // next AND each entry's own next, to exhaustion).
      const seen = new Map<string, Set<number>>();
      for (let i = 0; i < SMALL_COUNT; i += 1) seen.set(`small${i}`, new Set());
      const harvestOne = (text: string, label: string): void => {
        const re = new RegExp(`${label}-line-(\\d{5}) `, "g");
        for (const m of text.matchAll(re)) seen.get(label)!.add(Number(m[1]));
      };
      const harvest = (body: unknown): void => {
        const text = JSON.stringify(body);
        for (let i = 0; i < SMALL_COUNT; i += 1) harvestOne(text, `small${i}`);
      };
      function oneNext(body: Record<string, unknown>): { tool: string; arguments: Record<string, unknown> } | undefined {
        const limit = body["limit"] as Record<string, unknown> | undefined;
        const limitNext = limit?.["next"] as { tool?: unknown; arguments?: unknown } | undefined;
        if (limitNext && typeof limitNext.tool === "string") {
          return { tool: limitNext.tool, arguments: (limitNext.arguments as Record<string, unknown>) ?? {} };
        }
        const topNext = body["next"] as { tool?: unknown; arguments?: unknown } | undefined;
        if (topNext && typeof topNext.tool === "string") {
          return { tool: topNext.tool, arguments: (topNext.arguments as Record<string, unknown>) ?? {} };
        }
        return undefined;
      }
      function entryNexts(body: Record<string, unknown>): Array<{ tool: string; arguments: Record<string, unknown> }> {
        const out: Array<{ tool: string; arguments: Record<string, unknown> }> = [];
        const entries2 = body["entries"];
        if (Array.isArray(entries2)) {
          for (const raw of entries2) {
            const entry = raw as Record<string, unknown> | undefined;
            const entryNext = entry?.["next"] as { tool?: unknown; arguments?: unknown } | undefined;
            if (entryNext && typeof entryNext.tool === "string") {
              out.push({ tool: entryNext.tool, arguments: (entryNext.arguments as Record<string, unknown>) ?? {} });
            }
          }
        }
        return out;
      }
      harvest(batch.body);
      const HOP_CAP = 60;
      const queue: Array<{ tool: string; arguments: Record<string, unknown> }> = [];
      const recoveryBody = await server.callTool(next.tool, next.arguments);
      harvest(recoveryBody.body);
      queue.push(...entryNexts(recoveryBody.body));
      const rec0Next = oneNext(recoveryBody.body);
      if (rec0Next !== undefined) queue.push(rec0Next);
      const seenCalls = new Set<string>(queue.map((c) => JSON.stringify(c.arguments)));
      let hops = 0;
      while (queue.length > 0 && hops < HOP_CAP) {
        const call = queue.shift()!;
        hops += 1;
        const body = await server.callTool(call.tool, call.arguments);
        harvest(body.body);
        for (const nx of [...entryNexts(body.body), ...(oneNext(body.body) ? [oneNext(body.body)!] : [])]) {
          const key = JSON.stringify(nx.arguments);
          if (seenCalls.has(key)) continue;
          seenCalls.add(key);
          queue.push(nx);
        }
      }
      expect(queue.length, `chain did not end within ${HOP_CAP} hops — possible loop`).toBe(0);

      for (let i = 0; i < SMALL_COUNT; i += 1) {
        const label = `small${i}`;
        for (let n = 1; n <= SMALL_LINES; n += 1) {
          expect(seen.get(label)!.has(n), `${label} line ${n} never arrived across the chain`).toBe(true);
        }
      }
    }, 60_000);
  },
);
