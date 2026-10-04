/**
 * evaluation0929.readServingHonesty.spec.ts — eval-0929 §9 (WP-L, adopted
 * chips from V15-BCF2's own live reproductions during the budgetFillSlice/
 * batchEntryShrink work).
 *
 * R2-R1 NOTE (2026-09-30): the flat-reserve sizing ITEM 1 was written against
 * (`GOVERNED_HEAD_EXTRA_RESERVE_BYTES`, `resolveGovernedChunkCapBytes`) is GONE.
 * `planBudgetedFullServe` (tools/readCodeModes.ts) now sizes a `content:"full"`
 * head from the MEASURED response — whole first, then the largest head of whole
 * lines with the continuation counted once, never fewer than one line — which
 * removes the cause (a raw-byte cap that could go below one line) rather than
 * patching its symptom. The INVARIANT this item pins is unchanged and is what
 * its tests still assert: never an inverted `1-0` range, never a mid-line byte
 * prefix as evidence. The arithmetic quoted below is the historical defect.
 *
 * ITEM 1 — DEFECT. `buildFullServePayload` (server.ts)'s BCF narrowing
 * (`chunkCapBytes`, ~L6398) computes the governed-head chunk target as
 * `callerBudgetBytes - pageEnvelopeReserve(path, cwd) - GOVERNED_HEAD_EXTRA_RESERVE_BYTES`
 * with NO floor. Under a small declared budget and a long workspace path,
 * that arithmetic can go below the byte cost of the file's own FIRST logical
 * line: `serveGovernedFullHead` then takes its documented degenerate
 * single-long-line branch (correct ONLY when a line genuinely exceeds the
 * cap) on an ORDINARY file, and the truncated-branch return shipped
 * `range:"1-${servedLines}"` = the inverted `"1-0"`, plus a `content` that is
 * a mid-line byte PREFIX of line 1 — non-verbatim evidence at an invalid
 * address (replayCorpus `r2c1`'s own fixture, `src/statusBar.ts`, 113 lines,
 * reproduces this at budget 1024 once `cwd` is long enough).
 *
 * FIX (server.ts). `resolveGovernedChunkCapBytes` (new, exported, right
 * above `buildFullServePayload`) asks `serveGovernedFullHead` itself whether
 * the narrowed cap can fit line 1; when narrowing alone starves it but the
 * UN-NARROWED `FULL_SERVE_CHUNK_BYTES` can, the un-narrowed cap is used
 * instead — reproducing the pre-BCF chunk target for that content exactly
 * (the emit-time shed ladder's whole-line halving, or the caller's own
 * `budget-below-minimum` refusal, take over from there, never this
 * builder). `buildFullServePayload`'s truncated branch ALSO gained an
 * independent guard: whenever `servedLines < 1` survives that (a single
 * logical line genuinely larger than `FULL_SERVE_CHUNK_BYTES` — the ONE case
 * the narrowing fix cannot rescue, and does not try to, per
 * `serveGovernedFullHead`'s own reviewed doc comment on that branch), the
 * response omits `content`/`range` entirely rather than emit an
 * inverted/empty one — the BODYLESS "addressed, nothing shipped, here is
 * what remains" form `protocol/readFamily.ts`'s `textEvidence` (its "GATE-A"
 * branch) already recognizes from a governed downgrade that shipped neither
 * bytes nor an outline. Purely byte/line arithmetic — no language-specific
 * logic — so this covers every language TL reads (TS/JS, Python, Go, Java,
 * Kotlin, C#, Rust, C/C++, plain text) identically.
 *
 * ITEM 2 — DEFECT. `protocol/budget/wireLimit.ts`'s `unionBatchContinuations`
 * (the mechanism that merges a construction-time `read.batch` drop with the
 * shed ladder's own rung-4/rung-6 continuation into ONE `limit.next`, R-A3..
 * R-A5) built its merged result as a raw `{tool:"tl_read_file",arguments:
 * {targets,content}}` OBJECT LITERAL — the one continuation-minting seat in
 * this whole subsystem that never passed through `emittableToolCall` /
 * `canonicalToolCall` / `attributedContinuationArguments` /
 * `inheritCallerResponseBudget` (`protocol/envelope.ts`), unlike EVERY other
 * continuation this tree mints (`shedBatchEntry`'s and `truncateRangedEntries`'s
 * own per-entry/per-step continuations both go through `emittableToolCall`
 * already). So a `tl_read_file {targets:[{handle:H1,range},{handle:H2,range}]}`
 * batch (both targets handle-addressed — promoted to the A7 `handles=[]`
 * door, server.ts) that needed the union at least once silently dropped the
 * caller's declared `budget.bytes` (and `cwd`/`lane`/task continuity) off
 * that ONE merged `next` — measured live: a 900 B caller budget followed by
 * a ~19.7 KB next hop, about 22x over, with the deferred target itself never
 * separately disclosed (no `entries[]` item, no top-level omission — only
 * this ONE, budget-blind `next`). A caller that ran it verbatim (AGENTS.md)
 * got a response re-opened to the calibrated server ceiling instead of the
 * budget it had just declared.
 *
 * FIX (protocol/budget/wireLimit.ts). `unionBatchContinuations` now passes
 * its merged literal through `emittableToolCall` (falling back to the raw
 * literal only if canonicalization itself rejects it — defense in depth,
 * never a silent drop of the whole continuation), so it inherits `budget`/
 * `cwd`/task continuity exactly like every sibling continuation already
 * does. Consequence, confirmed by chasing a full chain to completion: the
 * SAME two-target ranged batch now pages 1-2 lines/hop under a genuinely
 * tight budget instead of ignoring it — slower, but honest and non-lossy
 * (exact-once full delivery, verified below) — which is why
 * `readBatchDropRecoveryCompleteness.spec.ts`'s own `HOP_CAP` needed raising
 * (see that file's own updated comment; both host configs measured at 40/44
 * calls for its fixture, up from comfortably under the old 40 pre-fix).
 * Purely mechanical (merges `ToolCall` objects) — independent of language.
 *
 * OUT OF SCOPE, FOUND WHILE BUILDING THIS FIX (reported, not touched):
 * `fxoServeCoordinateSettlement.spec.ts`'s "a MULTI-window slice narrows each
 * window independently (round-17 finding 1, `r17_q`)" fails on a CLEAN
 * checkout of this wave's starting tree (verified by reverting this
 * package's own `wireLimit.ts` edit in isolation and re-running just that
 * test — it fails identically with or without this fix, and is `read.text`
 * kind, never reaching `unionBatchContinuations`, which only ever runs for
 * `read.batch`). Looks related to `tools/readCodeModes.ts`'s
 * `resolveSliceRanges` multi-window construction (V15-BCF2's own region, not
 * this package's) — see this file's own final report for the exact repro.
 *
 * Every case drives a REAL stdio server (`startDevServer`) and follows
 * `next` verbatim (AGENTS.md), exactly as the other eval-0929 specs do.
 */
import { afterAll, afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { shortTmpDir } from "./helpers/shortTmpDir.js";
import { rmDirWithRetry } from "./helpers/rmDirWithRetry.js";
import {
  extractNext,
  extractServedIds,
  idRangeSet,
  missingIds,
  selfIdLine,
  startDevServer,
  walkHops,
  writeSelfIdFile,
  type ServerHandle,
} from "./helpers/qualityFirstScenarios.js";

const HOME = process.env["HOME"] ?? process.env["USERPROFILE"] ?? os.homedir();
const tmpDirs: string[] = [];
const servers: ServerHandle[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.kill();
});
afterAll(async () => {
  for (const server of servers.splice(0)) await server.kill();
  for (const dir of tmpDirs.splice(0)) {
    try {
      await rmDirWithRetry(dir);
    } catch {
      /* best-effort cleanup */
    }
  }
});

function bytesOf(x: unknown): number {
  return Buffer.byteLength(JSON.stringify(x), "utf8");
}

/** Every `"range":"start-end"` string anywhere in the response must be a
 *  real, non-inverted, non-empty span (end >= start). Catches the exact
 *  "1-0" shape item 1 fixes, wherever in the payload it might appear. */
function assertNoInvertedOrEmptyRange(body: unknown): void {
  const text = JSON.stringify(body);
  const re = /"range":"(\d+)-(\d+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const start = Number(m[1]);
    const end = Number(m[2]);
    expect(end, `inverted/empty range "${m[1]}-${m[2]}" in: ${text.slice(0, 500)}`).toBeGreaterThanOrEqual(start);
  }
}

/** Every served body's lines are VERBATIM whole lines of the known fixture
 *  — never a byte-truncated prefix of one. Walks every `content`/`body`
 *  string in the payload; for each, every line must either be blank
 *  (a boundary artifact of `\n`-splitting) or match `selfIdLine` for SOME
 *  line number 1..totalLines exactly. */
function assertVerbatimWholeLines(body: unknown, tag: string, lineBytes: number, totalLines: number): void {
  // `util/formatCompress.ts`'s `compressFormat` — applied to every served
  // body, unrelated to items 1/2 — strips TRAILING whitespace from each
  // line ("Strips redundant whitespace without touching indentation"), and
  // `writeSelfIdFile`'s own generated lines end in a trailing filler space.
  // Compared trimEnd'd on both sides so this stays a real verbatim-content
  // check without false-failing on that pre-existing, orthogonal transform.
  const expected = new Set<string>();
  for (let n = 1; n <= totalLines; n++) expected.add(selfIdLine(tag, n, lineBytes).trimEnd());
  const walk = (value: unknown): void => {
    if (typeof value === "string") {
      if (!value.includes(`${tag}-`)) return;
      for (const line of value.split("\n")) {
        if (line === "") continue;
        expect(expected.has(line.trimEnd()), `non-verbatim / mid-line body fragment: ${JSON.stringify(line)}`).toBe(true);
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (value !== null && typeof value === "object") {
      for (const v of Object.values(value as Record<string, unknown>)) walk(v);
    }
  };
  walk(body);
}

function freshWorkspace(tag: string): { ws: string; server: ServerHandle } {
  const ws = fs.realpathSync(shortTmpDir(HOME, `.tl-e0929-rsh-${tag}-`));
  tmpDirs.push(ws);
  const server = startDevServer(ws, "default", { allowWrite: true });
  servers.push(server);
  return { ws, server };
}

/** A workspace nested under an artificially long path — long enough that
 *  `pageEnvelopeReserve`'s own `cwd` term drives BCF's narrowed chunk cap
 *  below one ordinary line at the budgets this suite exercises. Mirrors
 *  `evaluation0929.batchEntryShrink.spec.ts`'s own `freshLongPathWorkspace`
 *  (kept local rather than imported — this wave's specs do not import across
 *  spec files, matching `evaluation0929.batchNoSilentDrop.spec.ts`'s own
 *  documented convention). */
function freshLongPathWorkspace(tag: string): { ws: string; server: ServerHandle } {
  const base = fs.realpathSync(shortTmpDir(HOME, `.tl-e0929-rshL-${tag}-`));
  tmpDirs.push(base);
  // Moderate, not extreme: long enough to reliably drive the narrowed cap
  // below one line at budgets 1024/2048 (this file's own math: `1024 - 540 -
  // GOVERNED_HEAD_EXTRA_RESERVE_BYTES(400) - len(path) - len(cwd)` goes
  // negative for almost any real cwd once GOVERNED_HEAD_EXTRA_RESERVE_BYTES
  // is counted), while staying short enough that the response itself — one
  // line plus a cursor naming this same cwd — still fits comfortably inside
  // those budgets. `batchEntryShrink.spec.ts`'s own 600+-char path targets a
  // DIFFERENT, more extreme single-line-floor phenomenon and is too long for
  // this suite's own budgets to serve anything at all.
  const seg = "p" + "a".repeat(150);
  const ws = path.join(base, seg);
  fs.mkdirSync(ws, { recursive: true });
  const server = startDevServer(ws, "default", { allowWrite: true });
  servers.push(server);
  return { ws, server };
}

const ITEM1_LINE_BYTES = 70;
const ITEM1_TOTAL_LINES = 113;

describe("item 1 — buildFullServePayload never ships a 1-0 range or a mid-line prefix", () => {
  for (const budget of [512, 1024, 2048]) {
    it(`budget ${budget}, LONG workspace path: honest response, never "1-0", bodies verbatim`, async () => {
      const { ws, server } = freshLongPathWorkspace(`long-${budget}`);
      await server.initialize();
      writeSelfIdFile(ws, "big.ts", ITEM1_TOTAL_LINES, "sb", ITEM1_LINE_BYTES);

      const r = await server.callTool("tl_read_file", {
        targets: [{ path: "big.ts" }],
        content: "full",
        budget: { bytes: budget },
        task: { epoch: "new" },
        cwd: ws,
      });

      expect(JSON.stringify(r.body), "must never contain a literal 1-0 range").not.toContain('"1-0"');
      assertNoInvertedOrEmptyRange(r.body);
      assertVerbatimWholeLines(r.body, "sb", ITEM1_LINE_BYTES, ITEM1_TOTAL_LINES);

      if (r.body["kind"] === "refusal") {
        // The other sanctioned pre-BCF outcome: an honest, actionable floor
        // (which specific code depends on which gate the caller's own
        // budget+cwd combination reaches first — `budget-below-minimum` from
        // the read cursor/ladder floor, or `cap-exceeded` from an earlier
        // admission gate; either is a clean refusal, never a fabricated
        // partial body).
        expect(typeof r.body["code"], JSON.stringify(r.body)).toBe("string");
        expect(r.body["retry"], JSON.stringify(r.body)).toBeDefined();
        return;
      }
      expect(r.body["kind"], JSON.stringify(r.body).slice(0, 300)).toBe("read.text");
      const evidence = (r.body["evidence"] as Array<Record<string, unknown>>)[0]!;
      // Either a real served window (range present, body verbatim — checked
      // above) or the bodyless GATE-A form (no range/content, but the
      // address + remainder are still named so `next` stays executable).
      if (evidence["range"] === undefined) {
        expect(evidence["body"], "bodyless entry must carry no body either").toBeUndefined();
        expect(r.body["total_lines"] ?? evidence["total_lines"]).toBeDefined();
      } else {
        const bounds = /^(\d+)-(\d+)$/.exec(String(evidence["range"]));
        expect(bounds, String(evidence["range"])).not.toBeNull();
        expect(Number(bounds![1])).toBeGreaterThanOrEqual(1);
      }
      // Every open outcome keeps an executable continuation.
      if (r.body["total_lines"] !== undefined && Number(r.body["total_lines"]) > 0) {
        const looksTruncated = JSON.stringify(r.body).includes('"truncated":true');
        if (looksTruncated) {
          expect(extractNext(r.body).next, "a truncated serve must carry a next").toBeDefined();
        }
      }
    }, 60_000);

    it(`budget ${budget}, SHORT workspace path: recall control — still honest, unaffected shape`, async () => {
      const { ws, server } = freshWorkspace(`short-${budget}`);
      await server.initialize();
      writeSelfIdFile(ws, "big.ts", ITEM1_TOTAL_LINES, "sc", ITEM1_LINE_BYTES);

      const r = await server.callTool("tl_read_file", {
        targets: [{ path: "big.ts" }],
        content: "full",
        budget: { bytes: budget },
        task: { epoch: "new" },
        cwd: ws,
      });

      expect(JSON.stringify(r.body)).not.toContain('"1-0"');
      assertNoInvertedOrEmptyRange(r.body);
      assertVerbatimWholeLines(r.body, "sc", ITEM1_LINE_BYTES, ITEM1_TOTAL_LINES);
      if (r.body["kind"] !== "refusal") {
        expect(r.body["kind"]).toBe("read.text");
      }
    }, 60_000);
  }

  it("r2c1's own fixture shape (113-line file, budget 1024, long cwd) never degenerates and stays chain-complete", async () => {
    const { ws, server } = freshLongPathWorkspace("r2c1-shape");
    await server.initialize();
    const lines = Array.from({ length: 113 }, (_, i) =>
      `export const statusBarRow${i + 1} = "row-${i + 1}-abcdefghijklmnopqrstuvwxyz";`);
    fs.writeFileSync(path.join(ws, "src_statusBar.ts"), lines.join("\n") + "\n", "utf8");

    const first = await server.callTool("tl_read_file", {
      targets: [{ path: "src_statusBar.ts" }],
      content: "full",
      budget: { bytes: 1024 },
      task: { epoch: "new" },
      cwd: ws,
    });
    expect(JSON.stringify(first.body)).not.toContain('"1-0"');
    assertNoInvertedOrEmptyRange(first.body);
    if (first.body["kind"] === "refusal") {
      // An honest, actionable floor is a sanctioned outcome too — the
      // invariant this test exists for (no "1-0", no inverted range) is
      // already checked above regardless of which shape the response takes.
      expect(typeof first.body["code"], JSON.stringify(first.body)).toBe("string");
      return;
    }

    const firstNext = extractNext(first.body).next;
    const chain = firstNext !== undefined ? await walkHops(server, firstNext, 40) : { responses: [], capped: false };
    expect(chain.capped, JSON.stringify(chain.responses).slice(0, 500)).toBe(false);
    const allResponses = [first.body, ...chain.responses];
    for (const r of allResponses) assertNoInvertedOrEmptyRange(r);

    const seen = new Set<number>();
    for (const r of allResponses) {
      const text = JSON.stringify(r);
      for (const m of text.matchAll(/statusBarRow(\d+)/g)) seen.add(Number(m[1]));
    }
    expect(missingIds(idRangeSet(1, 113), seen), "every row must eventually arrive").toEqual([]);
  }, 60_000);
});

describe("item 2 — a handle-addressed multi-range batch never drops an entry", () => {
  async function mintHandle(server: ServerHandle, ws: string, relPath: string): Promise<string> {
    const mint = await server.callTool("tl_read_file", { targets: [{ path: relPath, range: "1-1" }], cwd: ws });
    const handle = (mint.body?.["evidence"] as Array<Record<string, unknown>> | undefined)?.[0]?.["handle"];
    expect(typeof handle, JSON.stringify(mint.body)).toBe("string");
    return handle as string;
  }

  /** Runs `targets` under `budget`, follows `next` to completion, and checks:
   *  (a) every requested line of every tag arrives EXACTLY once across the
   *  whole chain; (b) every hop that carries a `next` restates a `budget`
   *  matching the ORIGINAL declared bytes (the direct regression pin for the
   *  `unionBatchContinuations` fix) — no hop after the first re-opens to the
   *  calibrated server ceiling; (c) every hop stays within budget (a small
   *  envelope tolerance). */
  async function runAndVerify(
    server: ServerHandle,
    ws: string,
    targets: Array<{ handle: string; range: string }>,
    budgetBytes: number,
    tags: readonly string[],
    wanted: ReadonlyMap<string, Set<number>>,
    hopCap: number,
  ): Promise<void> {
    const first = await server.callTool("tl_read_file", {
      targets,
      content: "full",
      budget: { bytes: budgetBytes },
      cwd: ws,
    });
    expect(first.body["kind"], JSON.stringify(first.body).slice(0, 300)).not.toBe("refusal");

    const firstNext = extractNext(first.body).next;
    const chain = firstNext !== undefined ? await walkHops(server, firstNext, hopCap) : { responses: [], capped: false };
    expect(chain.capped, `chain never completed: ${JSON.stringify(chain.responses).slice(-500)}`).toBe(false);
    const allResponses = [first.body, ...chain.responses];

    // (b) + (c): every response stays in budget, and every non-final next
    // restates the SAME declared budget — this is what the fix restores.
    for (const r of allResponses) {
      expect(bytesOf(r), `over budget: ${JSON.stringify(r).slice(0, 300)}`).toBeLessThanOrEqual(budgetBytes + 300);
      const next = extractNext(r).next;
      if (next === undefined) continue;
      const declaredBudget = (next.arguments as Record<string, unknown> | undefined)?.["budget"] as
        | Record<string, unknown>
        | undefined;
      expect(
        declaredBudget?.["bytes"],
        `next lost the caller's declared budget: ${JSON.stringify(next)}`,
      ).toBe(budgetBytes);
    }

    // (a): exact-once full delivery, tag by tag.
    for (const tag of tags) {
      const seen = new Set<number>();
      let occurrences = 0;
      const re = new RegExp(`${tag}-(\\d{4})`, "g");
      for (const r of allResponses) {
        const text = JSON.stringify(r);
        for (const n of extractServedIds(r, [tag]).get(tag) ?? []) seen.add(n);
        re.lastIndex = 0;
        while (re.exec(text) !== null) occurrences += 1;
      }
      const want = wanted.get(tag) ?? new Set<number>();
      expect(missingIds(want, seen), `${tag}: lines missing across the chain`).toEqual([]);
      expect(occurrences, `${tag}: duplicated delivery`).toBe(seen.size);
    }
  }

  for (const budget of [6144, 8192]) {
    it(`2 handles, DIFFERENT files, budget ${budget}`, async () => {
      const { ws, server } = freshWorkspace(`2diff-${budget}`);
      await server.initialize();
      writeSelfIdFile(ws, "alpha.ts", 80, "a2d", 90);
      writeSelfIdFile(ws, "beta.ts", 80, "b2d", 90);
      const hA = await mintHandle(server, ws, "alpha.ts");
      const hB = await mintHandle(server, ws, "beta.ts");

      await runAndVerify(
        server, ws,
        [{ handle: hA, range: "1-80" }, { handle: hB, range: "1-80" }],
        budget,
        ["a2d", "b2d"],
        new Map([["a2d", idRangeSet(1, 80)], ["b2d", idRangeSet(1, 80)]]),
        60,
      );
    }, 180_000);

    it(`2 handles, SAME file (two disjoint windows), budget ${budget}`, async () => {
      const { ws, server } = freshWorkspace(`2same-${budget}`);
      await server.initialize();
      writeSelfIdFile(ws, "alpha.ts", 160, "a2s", 90);
      const h1 = await mintHandle(server, ws, "alpha.ts");
      const mint2 = await server.callTool("tl_read_file", { targets: [{ path: "alpha.ts", range: "100-100" }], cwd: ws });
      const h2 = (mint2.body?.["evidence"] as Array<Record<string, unknown>>)?.[0]?.["handle"] as string;

      await runAndVerify(
        server, ws,
        [{ handle: h1, range: "1-40" }, { handle: h2, range: "100-140" }],
        budget,
        ["a2s"],
        new Map([["a2s", new Set([...idRangeSet(1, 40), ...idRangeSet(100, 140)])]]),
        60,
      );
    }, 180_000);
  }

  it("3 handles, different files, budget 8192", async () => {
    const { ws, server } = freshWorkspace("3diff");
    await server.initialize();
    writeSelfIdFile(ws, "alpha.ts", 60, "a3", 90);
    writeSelfIdFile(ws, "beta.ts", 60, "b3", 90);
    writeSelfIdFile(ws, "gamma.ts", 60, "c3", 90);
    const hA = await mintHandle(server, ws, "alpha.ts");
    const hB = await mintHandle(server, ws, "beta.ts");
    const hC = await mintHandle(server, ws, "gamma.ts");

    await runAndVerify(
      server, ws,
      [{ handle: hA, range: "1-60" }, { handle: hB, range: "1-60" }, { handle: hC, range: "1-60" }],
      8192,
      ["a3", "b3", "c3"],
      new Map([["a3", idRangeSet(1, 60)], ["b3", idRangeSet(1, 60)], ["c3", idRangeSet(1, 60)]]),
      60,
    );
  }, 180_000);

  it("4 handles, different files, budget 8192", async () => {
    const { ws, server } = freshWorkspace("4diff");
    await server.initialize();
    writeSelfIdFile(ws, "alpha.ts", 50, "a4", 90);
    writeSelfIdFile(ws, "beta.ts", 50, "b4", 90);
    writeSelfIdFile(ws, "gamma.ts", 50, "c4", 90);
    writeSelfIdFile(ws, "delta.ts", 50, "d4", 90);
    const hA = await mintHandle(server, ws, "alpha.ts");
    const hB = await mintHandle(server, ws, "beta.ts");
    const hC = await mintHandle(server, ws, "gamma.ts");
    const hD = await mintHandle(server, ws, "delta.ts");

    await runAndVerify(
      server, ws,
      [
        { handle: hA, range: "1-50" }, { handle: hB, range: "1-50" },
        { handle: hC, range: "1-50" }, { handle: hD, range: "1-50" },
      ],
      8192,
      ["a4", "b4", "c4", "d4"],
      new Map([
        ["a4", idRangeSet(1, 50)], ["b4", idRangeSet(1, 50)],
        ["c4", idRangeSet(1, 50)], ["d4", idRangeSet(1, 50)],
      ]),
      80,
    );
  }, 180_000);

  it("recall control: a batch that fits in ONE hop (wide budget) is unaffected — no next at all", async () => {
    const { ws, server } = freshWorkspace("recall-onehop");
    await server.initialize();
    writeSelfIdFile(ws, "alpha.ts", 10, "arc", 90);
    writeSelfIdFile(ws, "beta.ts", 10, "brc", 90);
    const hA = await mintHandle(server, ws, "alpha.ts");
    const hB = await mintHandle(server, ws, "beta.ts");

    const r = await server.callTool("tl_read_file", {
      targets: [{ handle: hA, range: "1-10" }, { handle: hB, range: "1-10" }],
      content: "full",
      budget: { bytes: 65536 },
      cwd: ws,
    });
    expect(r.body["kind"]).toBe("read.batch");
    expect(extractNext(r.body).next, "nothing deferred: no continuation of any kind").toBeUndefined();
    const ids = extractServedIds(r.body, ["arc", "brc"]);
    expect(missingIds(idRangeSet(1, 10), ids.get("arc") ?? new Set())).toEqual([]);
    expect(missingIds(idRangeSet(1, 10), ids.get("brc") ?? new Set())).toEqual([]);
  }, 60_000);
});
