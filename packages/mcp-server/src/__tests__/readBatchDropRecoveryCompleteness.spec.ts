// readBatchDropRecoveryCompleteness.spec.ts — FIX-A4 (2026-09-21), line-loss
// follow-up to FIX-A2/FIX-A3's TL-05 work.
//
// THE DEFECT, CONFIRMED (direct `runLadder` call, then reproduced through the
// real spawned server in both host configs — see below).
//
// `readBatch.ts` rung 6 (`shedBatchEntry`) builds a dropped entry's recovery
// `next` from that entry's CURRENT `range` alone. `runLadder` (`ladder.ts`)
// re-invokes a rung repeatedly while the payload is still over budget, so
// rung 4 (`truncateRangedEntries`) commonly runs SEVERAL times on one
// emission before rung 6 ever sees the payload: each pass halves the entry's
// `content`, rewrites `range` down to the surviving leading sliver, and books
// the true cut-off remainder into the entry's own `remaining_ranges`. When
// rung 6 THEN drops that SAME entry outright (still over budget, rung 4
// exhausted), the entry ships NOTHING in this response — removed from
// `entries[]` entirely — so the narrowed sliver rung 4 kept is lost too, not
// merely the recorded remainder.
//
// MEASURED (before the fix), via a direct `runLadder` call on a two-entry
// `read.batch` payload (`h1`: 40 lines, `h2`: 40 lines), budget 300 B: six
// rung-4 passes narrow `h2` to `range:"1-1"` / `remaining_ranges:["2-40"]`,
// then rung 6 drops it, and the shipped recovery was
// `{targets:[{range:"1-1",handle:"h2"}],content:"auto"}` — lines 2-40 (39 of
// the file's 40 requested lines) were reachable by NOTHING the response
// named. Reproduced end-to-end through the real spawned server (both configs)
// with an 8-line + 40-line two-file batch: the 40-line file is narrowed by
// rung 4 to a 1-line sliver, then dropped by rung 6; before the fix the
// recovery named only that sliver, losing the other 39 lines permanently
// (nothing else in the chain ever re-addresses them).
//
// THE FIX. `unservedRangeFor` (`readBatch.ts`) reconstructs the entry's WHOLE
// unserved window as `range` UNIONED with every span in `remaining_ranges`
// (min start .. max end) before naming it in the recovery call. The two are
// contiguous by construction (`truncateRangedEntries`'s own doc comment), so
// the union recovers exactly the original requested span, whether
// `remaining_ranges` came from this ladder run's own repeated rung-4 passes or
// from `server.ts`'s construction-time truncation. An entry rung 4 never
// touched carries no `remaining_ranges`, so the union is a no-op and the fix
// is byte-identical to before for that (today's common) case — pinned below
// as a regression control.

import { afterAll, afterEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Kind } from "@tokenlighten/types";

import { runLadder } from "../protocol/budget/ladder.js";
import { validateProtocolBody } from "../protocol/budget/validate.js";
import { RANGE_CONTENT_FULL_MARKER } from "../protocol/budget/shedders/registry.js";
import { shortTmpDir } from "./helpers/shortTmpDir.js";
import { rmDirWithRetry, waitForExit } from "./helpers/rmDirWithRetry.js";

// ---------------------------------------------------------------------------
// Direct ladder coverage (mirrors rangeFullBatchContinuation.spec.ts's own
// "Direct ladder-level coverage" section, same helper shape).
// ---------------------------------------------------------------------------

type Body = Record<string, unknown>;

function ladder(payload: Body, kind: Kind, budget: number, args?: Record<string, unknown>) {
  return runLadder({
    payload,
    kind,
    budget,
    context: args === undefined ? {} : { args },
    validate: (candidate) => validateProtocolBody(candidate, kind, undefined).ok,
  });
}

/** Two equal-length "handle"-form entries, long enough that halving is real progress. */
function twoHandleBatch(): Body {
  const linesA = Array.from({ length: 40 }, (_, i) => `line a${i} with some padding text to matter here`);
  const linesB = Array.from({ length: 40 }, (_, i) => `line b${i} with some padding text to matter here`);
  return {
    v: 1,
    kind: "read.batch",
    entries: [
      { form: "handle", handle: "h1", path: "src/a.ts", range: "1-40", truncated: false, content: linesA.join("\n"), sha: "sha256:aaa" },
      { form: "handle", handle: "h2", path: "src/b.ts", range: "1-40", truncated: false, content: linesB.join("\n"), sha: "sha256:bbb" },
    ],
  };
}

/** One TINY entry (never worth halving) and one LARGE one (halving is productive). */
function asymHandleBatch(): Body {
  const linesSmall = Array.from({ length: 8 }, (_, i) => `s${i}`);
  const linesLarge = Array.from({ length: 40 }, (_, i) => `line b${i} with some padding text to matter here`);
  return {
    v: 1,
    kind: "read.batch",
    entries: [
      { form: "handle", handle: "h1", path: "src/small.ts", range: "1-8", truncated: false, content: linesSmall.join("\n"), sha: "sha256:aaa" },
      { form: "handle", handle: "h2", path: "src/large.ts", range: "1-40", truncated: false, content: linesLarge.join("\n"), sha: "sha256:bbb" },
    ],
  };
}

function limitNextTargets(payload: Body): Array<Record<string, unknown>> {
  const limit = payload["limit"] as Body | undefined;
  const next = limit?.["next"] as { arguments?: Record<string, unknown> } | undefined;
  const targets = next?.arguments?.["targets"];
  expect(Array.isArray(targets), `no limit.next.targets: ${JSON.stringify(payload["limit"])}`).toBe(true);
  return targets as Array<Record<string, unknown>>;
}

describe("direct ladder: readBatch.ts rung 6 recovers the entry's WHOLE unserved window", () => {
  // R-A5 (v0.14.4 candidate, 2026-09-21) RE-PIN, rule-8 report: both cases in
  // this `it` used to assert `targets.length === 1` at budget 300 B — the
  // dropped entry's FULL range alone, with the SURVIVING entry's own
  // remainder deliberately absent from `limit.next` (present only in its own
  // `entries[0].next`). That was `wireLimit.ts`'s OLD trim
  // (`unionBatchContinuationsFitting`'s `emitterNextExists === false` arm,
  // RETIRED): it let a budget as low as 300 B reach a rung-6 drop by silently
  // dropping the surviving entry's own promise from the ONE call
  // (`limit.next`) a caller resuming from a PRIOR hop's own `next` actually
  // runs. R-A5's ruling (plan §4) is that this is exactly the same class of
  // loss `entries[i].next` cannot excuse — see `wireLimit.ts`'s own banner.
  //
  // NEW SHAPE, same purpose (never ship a bare sliver as if it were the whole
  // recovery): `limit.next` now ALWAYS names BOTH windows once rung 6 fires —
  // the dropped entry's WHOLE range ("1-40", never the sliver "1-1") AND the
  // surviving entry's own remainder ("2-40") — regardless of the CALLER's
  // declared budget. `runLadder` judges every step ONLY by whether it is
  // honest progress against its OWN prior state (`wireLimit.ts`'s banner:
  // "the CALLER's declared budget is emit.ts's question to answer, not this
  // ladder's"), so rung 6 fires here at 300 B exactly as it does at any
  // wider budget — the two are BYTE-IDENTICAL in `records`/`limit.next`,
  // differing only in whether `out.used` (518 B, measured) is <= the
  // budget the direct call happened to pass in. `emitFinalizedPayload`
  // (emit.ts, exercised by readBatchNextUnionMatrix.spec.ts's spawned-server
  // coverage) is what turns "still over budget after the ladder's best
  // honest effort" into the wire-level `budget-below-minimum` refusal; this
  // direct-ladder level has no `kind:"refusal"` to assert, only `used`
  // itself.
  it("an entry rung 4 already narrowed to a sliver, then rung 6 drops: limit.next names the dropped entry's WHOLE range AND the surviving entry's own remainder", () => {
    const out = ladder(twoHandleBatch(), "read.batch", 550, {});
    expect(out.records.some((r) => r.rung === 4), out.records.map((r) => r.rung).join(",")).toBe(true);
    expect(out.records.some((r) => r.rung === 6), out.records.map((r) => r.rung).join(",")).toBe(true);

    const entries = out.payload["entries"] as Body[];
    expect(entries.length, JSON.stringify(out.payload).slice(0, 300)).toBe(1);
    // The SURVIVING entry is narrowed (rung 4 touched it too) — sanity check
    // this fixture really does exercise both rungs, not just rung 6.
    expect(entries[0]!["remaining_ranges"], JSON.stringify(entries[0])).toBeDefined();

    const targets = limitNextTargets(out.payload);
    // THE ASSERTION, R-A5: limit.next names EVERY undelivered window, not
    // only the one rung 6 just dropped — two targets, never one.
    expect(targets.length, JSON.stringify(out.payload["limit"])).toBe(2);
    const dropped = targets.find((t) => t["handle"] === "h2");
    expect(dropped, JSON.stringify(out.payload["limit"])).toBeDefined();
    // The dropped entry's recovery must name the WHOLE original window
    // ("1-40"), never the narrow sliver ("1-1") it held at the moment it was
    // removed.
    expect(dropped!["range"]).toBe("1-40");
    expect(dropped!["range"]).not.toBe("1-1");
    // The SURVIVING entry's own remainder must ALSO ride limit.next now —
    // this is exactly what the retired trim used to omit.
    const surviving = targets.find((t) => t["handle"] === "h1");
    expect(surviving, JSON.stringify(out.payload["limit"])).toBeDefined();
    expect(surviving!["range"]).toBe("2-40");
  });

  it("R-A5: the SAME two-entry batch, direct-ladder-called at 300 B — the ladder's honest best effort is BYTE-IDENTICAL to the wider-budget case above, still over 300 B (emit.ts's tail is what would refuse it, not this layer)", () => {
    const out = ladder(twoHandleBatch(), "read.batch", 300, {});
    expect(out.records.some((r) => r.rung === 4), out.records.map((r) => r.rung).join(",")).toBe(true);
    // THE ASSERTION, R-A5: rung 6 STILL fires — dropping h2 with the full,
    // honest union is objective progress regardless of the 300 B target (see
    // this describe block's own banner). The declared budget only decides
    // whether `out.used` ends up <= it; it never narrows what limit.next says.
    expect(out.records.some((r) => r.rung === 6), out.records.map((r) => r.rung).join(",")).toBe(true);
    const targets = limitNextTargets(out.payload);
    expect(targets.length, JSON.stringify(out.payload["limit"])).toBe(2);
    const dropped = targets.find((t) => t["handle"] === "h2");
    expect(dropped, JSON.stringify(out.payload["limit"])).toBeDefined();
    expect(dropped!["range"]).toBe("1-40");
    const surviving = targets.find((t) => t["handle"] === "h1");
    expect(surviving, JSON.stringify(out.payload["limit"])).toBeDefined();
    expect(surviving!["range"]).toBe("2-40");
    // The ladder's own best effort still does not fit the 300 B this call
    // declared — this is the exact shape `emit.ts`'s `if (used > limit)`
    // tail converts into a `budget-below-minimum` refusal one layer up.
    expect(out.used, "the ladder's honest best effort should still exceed 300 B").toBeGreaterThan(300);
  });

  it("same, with content:\"full\" declared: the union range AND the marker both survive the drop for BOTH entries", () => {
    const out = ladder(twoHandleBatch(), "read.batch", 600, { [RANGE_CONTENT_FULL_MARKER]: true });
    expect(out.records.some((r) => r.rung === 6)).toBe(true);
    const targets = limitNextTargets(out.payload);
    expect(targets.length, JSON.stringify(out.payload["limit"])).toBe(2);
    const dropped = targets.find((t) => t["handle"] === "h2");
    expect(dropped, JSON.stringify(out.payload["limit"])).toBeDefined();
    expect(dropped!["range"]).toBe("1-40");
    const surviving = targets.find((t) => t["handle"] === "h1");
    expect(surviving, JSON.stringify(out.payload["limit"])).toBeDefined();
    expect(surviving!["range"]).toBe("2-40");
    const limit = out.payload["limit"] as Body;
    const next = (limit["next"] as { arguments?: Record<string, unknown> }).arguments;
    expect(next?.["content"], JSON.stringify(limit)).toBe("full");
  });

  it("R-A5: the content:\"full\" variant, direct-ladder-called at 300 B — same byte-identical honest effort, still over 300 B", () => {
    const out = ladder(twoHandleBatch(), "read.batch", 300, { [RANGE_CONTENT_FULL_MARKER]: true });
    expect(out.records.some((r) => r.rung === 6), out.records.map((r) => r.rung).join(",")).toBe(true);
    const targets = limitNextTargets(out.payload);
    expect(targets.length, JSON.stringify(out.payload["limit"])).toBe(2);
    const limit = out.payload["limit"] as Body;
    const next = (limit["next"] as { arguments?: Record<string, unknown> }).arguments;
    expect(next?.["content"], JSON.stringify(limit)).toBe("full");
    expect(out.used, "the ladder's honest best effort should still exceed 300 B").toBeGreaterThan(300);
  });

  it("unequal-size entries: the large entry is narrowed by rung 4, then dropped by rung 6, and still recovers its FULL range", () => {
    // Budget tight enough that the small entry admits trivially and the large
    // one is halved to its floor before rung 6 removes it.
    //
    // R-A5 (v0.14.4 candidate, 2026-09-21) RE-PIN, rule-8 report: this budget
    // moved from 260 to 480 B. 260 B relied on the SAME retired trim as the
    // two "sliver" cases above (`wireLimit.ts`'s OLD `unionBatchContinuations
    // Fitting`, `emitterNextExists === false` arm) — CONFIRMED via a direct
    // A/B (the pre-R-A5 code, with the trim restored, passes this test
    // unmodified at 260 B; the R-A5 no-trim code refuses the rung-6 step at
    // every budget from 260 up to 458 B, leaving `records` with no rung-6
    // entry, which is what made this assertion fail). The FULL, honest union
    // this fixture needs (the surviving small entry's own remainder "2-8"
    // PLUS the dropped large entry's WHOLE original range "1-40") measures
    // 459 B; 480 B is comfortable headroom above that measured floor, chosen
    // the same way the file's other budgets are (a round number above the
    // measured minimum, not the minimum itself). No assertion below changed —
    // this fixture never asserted `targets.length`, only that the dropped
    // entry's own recovery is present with its FULL range, which still holds.
    const out = ladder(asymHandleBatch(), "read.batch", 480, {});
    expect(out.records.some((r) => r.rung === 4)).toBe(true);
    expect(out.records.some((r) => r.rung === 6)).toBe(true);
    const targets = limitNextTargets(out.payload);
    const large = targets.find((t) => t["handle"] === "h2");
    expect(large, JSON.stringify(out.payload["limit"])).toBeDefined();
    expect(large!["range"]).toBe("1-40");
  });

  it("CONTROL — an entry rung 4 never touches (no remaining_ranges) recovers its ORIGINAL range unchanged, byte-identical to before this fix", () => {
    // A budget that drops a whole entry WITHOUT ever narrowing it first (both
    // entries are large enough that dropping one alone already fits, so rung
    // 4's own candidate is never even attempted/accepted before rung 6 runs
    // — mirrors rangeFullBatchContinuation.spec.ts's own "file"/"file-downgraded"
    // control for the sibling content:"full" fix).
    const body: Body = {
      v: 1,
      kind: "read.batch",
      entries: [
        { form: "handle", handle: "h1", path: "src/a.ts", range: "5-9", truncated: false, content: "AAAA", sha: "sha256:aaa" },
        { form: "handle", handle: "h2", path: "src/b.ts", range: "10-14", truncated: false, content: "B".repeat(2000), sha: "sha256:bbb" },
      ],
    };
    const out = ladder(body, "read.batch", 100, {});
    expect(out.records.some((r) => r.rung === 4), out.records.map((r) => r.rung).join(",")).toBe(false);
    expect(out.records.some((r) => r.rung === 6)).toBe(true);
    const targets = limitNextTargets(out.payload);
    // The dropped entry (h2) never had remaining_ranges, so the recovery is
    // its bare original `range` — exactly what the pre-fix code also produced
    // for this (untouched-by-rung-4) case.
    expect(targets[0]).toEqual({ handle: "h2", range: "10-14" });
  });
});

// ---------------------------------------------------------------------------
// FIX-A6 (v0.14.4 candidate, item 3): a served window that reaches a file's
// true EOF keeps the source's own trailing newline (readCodeModes.ts's
// `sliceLinesToText`, T1b) — `content.split("\n")` on that text counts one
// phantom empty final segment (util/countLines.ts's own bug write-up), which
// inflated `truncateRangedEntries`'s (rung 4) `keep`/`unkeptEnd` arithmetic by
// one, naming a "remaining"/recovery range that reached line N+1 of an
// N-line file. The single-target route (resolveSlice) already counts lines
// via `countLines()` and does not have this bug — this is the batch route's
// own copy of the same class FIX-A4/FIX-A5's own comments flagged as still
// open.
// ---------------------------------------------------------------------------
describe("direct ladder: readBatch.ts rung 4 never names a phantom line past a file's true EOF", () => {
  /** Recursively collects the numeric END bound of every "start-end" string
   *  reachable from `value` (a bare range string, or an array of them). */
  function collectRangeEnds(value: unknown, into: number[]): void {
    if (typeof value === "string") {
      const m = /^(\d+)-(\d+)$/.exec(value);
      if (m) into.push(Number(m[2]));
      return;
    }
    if (Array.isArray(value)) {
      for (const v of value) collectRangeEnds(v, into);
    }
  }

  it("an entry whose served window reaches the file's true EOF (trailing newline restored, T1b) is halved without inflating range/remaining_ranges/next past the true last line", () => {
    const TRUE_LAST_LINE = 40;
    const lines = Array.from({ length: TRUE_LAST_LINE }, (_, i) => `line${i} with some padding text to matter here`);
    // Trailing "\n": mirrors sliceLinesToText's EOF restoration (T1b) — the
    // exact shape that used to inflate content.split("\n").length by one. h1
    // is a single-line, single-byte entry (rung 4's own `lines.length < 2`
    // guard skips it forever), so ALL of the shed burden falls on h2 alone —
    // isolating the arithmetic this fix touches.
    const eofContent = lines.join("\n") + "\n";
    const body: Body = {
      v: 1,
      kind: "read.batch",
      entries: [
        { form: "handle", handle: "h1", path: "src/tiny.ts", range: "1-1", truncated: false, content: "x", sha: "sha256:aaa" },
        { form: "handle", handle: "h2", path: "src/eof.ts", range: `1-${TRUE_LAST_LINE}`, truncated: false, content: eofContent, sha: "sha256:bbb" },
      ],
    };
    const out = ladder(body, "read.batch", 1000, {});
    expect(out.records.some((r) => r.rung === 4), out.records.map((r) => r.rung).join(",")).toBe(true);

    const ends: number[] = [];
    const entries = out.payload["entries"] as Body[] | undefined;
    const h2Entry = entries?.find((e) => e["handle"] === "h2");
    if (h2Entry !== undefined) {
      collectRangeEnds(h2Entry["range"], ends);
      collectRangeEnds(h2Entry["remaining_ranges"], ends);
      const h2Next = h2Entry["next"] as { arguments?: Record<string, unknown> } | undefined;
      collectRangeEnds(h2Next?.arguments?.["range"], ends);
    } else {
      // h2 was narrowed to the floor and THEN dropped by rung 6 too — its
      // recovery lives in limit.next instead of entries[].
      const targets = limitNextTargets(out.payload);
      const recovered = targets.find((t) => t["handle"] === "h2");
      expect(recovered, JSON.stringify(out.payload["limit"])).toBeDefined();
      collectRangeEnds(recovered!["range"], ends);
    }
    expect(ends.length, `no range bound found to check: ${JSON.stringify(out.payload).slice(0, 500)}`).toBeGreaterThan(0);
    for (const end of ends) {
      expect(end, `named line ${end}, past the file's true last line (${TRUE_LAST_LINE}): ${JSON.stringify(out.payload).slice(0, 800)}`).toBeLessThanOrEqual(TRUE_LAST_LINE);
    }
  });
});

// ---------------------------------------------------------------------------
// Spawned-server harness (trimmed from rangedDeliveryCompleteness.spec.ts).
// ---------------------------------------------------------------------------

const nodeRequire = createRequire(import.meta.url);
const TSX_CLI = nodeRequire.resolve("tsx/cli");
const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN_TS = path.resolve(HERE, "..", "bin.ts");
const HOME = process.env["HOME"] ?? process.env["USERPROFILE"] ?? os.homedir();

const VSCODE_ENV: Readonly<Record<string, string>> = {
  TOKENLIGHTEN_CLIENT: "vscode",
  TOKENLIGHTEN_CLIENT_ID: "vscode",
  TL_TURN_ECONOMY: "1",
  TOKENLIGHTEN_TASK_PACK_MAX_BYTES: "0",
};

function serverEnv(overrides: Readonly<Record<string, string>> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("TL_") || key.startsWith("TOKENLIGHTEN_")) delete env[key];
  }
  return { ...env, ...overrides };
}

interface ServerHandle {
  initialize(): Promise<void>;
  call(args: Record<string, unknown>): Promise<Record<string, unknown>>;
  kill(): Promise<void>;
}

const tmpDirs: string[] = [];
const spawnedServers: ServerHandle[] = [];
let toolCallId = 9000;

function mkDir(tag: string): string {
  const dir = fs.realpathSync(shortTmpDir(HOME, `.tl-rbdrc-${tag}-`));
  tmpDirs.push(dir);
  return dir;
}

function writeFile(dir: string, rel: string, content: string): void {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
}

function startServer(cwd: string, env: NodeJS.ProcessEnv): ServerHandle {
  // Own process group (POSIX), so one group SIGKILL reaches the tsx wrapper
  // AND the server it runs; killing the wrapper alone orphans it.
  const child: ChildProcess = spawn(process.execPath, [TSX_CLI, "--liftoff-only", BIN_TS, cwd], {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env,
    detached: process.platform !== "win32",
  });
  const killGroup = (): void => {
    try {
      if (process.platform !== "win32" && child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      else child.kill("SIGKILL");
    } catch { /* ok */ }
  };

  let stdoutBuf = "";
  let stderr = "";
  const waiters = new Map<number, (msg: any) => void>();

  child.stdout!.on("data", (d: Buffer) => {
    stdoutBuf += d.toString();
    let nl: number;
    while ((nl = stdoutBuf.indexOf("\n")) >= 0) {
      const line = stdoutBuf.slice(0, nl);
      stdoutBuf = stdoutBuf.slice(nl + 1);
      if (!line.trim()) continue;
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg && msg.id != null && waiters.has(msg.id)) {
        const w = waiters.get(msg.id)!;
        waiters.delete(msg.id);
        w(msg);
      }
    }
  });
  child.stderr!.on("data", (d: Buffer) => {
    stderr += d.toString();
  });

  function rpc(id: number, method: string, params?: unknown, timeoutMs = 45000): Promise<any> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(id);
        reject(new Error(`rpc '${method}' timed out after ${timeoutMs}ms.\n--- server stderr ---\n${stderr}`));
      }, timeoutMs);
      waiters.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  return {
    initialize: async () => {
      await rpc(1, "initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "fixa4", version: "0" } });
      child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    },
    call: async (args: Record<string, unknown>) => {
      const res = await rpc(toolCallId++, "tools/call", { name: "read_file", arguments: args });
      const text: string = res?.result?.content?.[0]?.text;
      expect(typeof text, `read_file returned no text content: ${JSON.stringify(res)}`).toBe("string");
      return JSON.parse(text) as Record<string, unknown>;
    },
    kill: async () => {
      killGroup();
      await waitForExit(child);
    },
  };
}

// Every server is started inside one test; stop it when that test ends so a
// long file never holds all of them at once.
afterEach(async () => {
  for (const s of spawnedServers.splice(0)) await s.kill();
});

afterAll(async () => {
  for (const s of spawnedServers.splice(0)) await s.kill();
  for (const d of tmpDirs.splice(0)) {
    try {
      await rmDirWithRetry(d);
    } catch {
      /* ok */
    }
  }
});

// ---------------------------------------------------------------------------
// Self-identifying fixtures + chain follower.
// ---------------------------------------------------------------------------

function selfIdFileText(tag: string, totalLines: number, targetBytes: number): string {
  const filler = "abcdefghijklmnopqrstuvwxyz0123456789 ";
  const lines: string[] = [];
  for (let n = 1; n <= totalLines; n += 1) {
    let line = `L${String(n).padStart(4, "0")}[${tag}]`;
    let i = 0;
    while (Buffer.byteLength(line, "utf8") < targetBytes) {
      line += filler[i % filler.length];
      i += 1;
    }
    lines.push(line);
  }
  return lines.join("\n") + "\n";
}

function servedLineNumbers(text: string, tag: string): Set<number> {
  const re = new RegExp(`L(\\d{4})\\[${tag}\\]`, "g");
  const out = new Set<number>();
  for (const m of text.matchAll(re)) out.add(Number(m[1]));
  return out;
}

interface ToolCallShape {
  tool: string;
  arguments: Record<string, unknown>;
}

function extractNext(body: Record<string, unknown>): ToolCallShape | undefined {
  const limit = body["limit"] as Record<string, unknown> | undefined;
  const limitNext = limit?.["next"] as { tool?: unknown; arguments?: unknown } | undefined;
  if (limitNext && typeof limitNext.tool === "string") {
    return { tool: limitNext.tool, arguments: (limitNext.arguments as Record<string, unknown>) ?? {} };
  }
  const topNext = body["next"] as { tool?: unknown; arguments?: unknown } | undefined;
  if (topNext && typeof topNext.tool === "string") {
    return { tool: topNext.tool, arguments: (topNext.arguments as Record<string, unknown>) ?? {} };
  }
  const entries = body["entries"];
  if (Array.isArray(entries)) {
    for (const raw of entries) {
      const entry = raw as Record<string, unknown> | undefined;
      const entryNext = entry?.["next"] as { tool?: unknown; arguments?: unknown } | undefined;
      if (entryNext && typeof entryNext.tool === "string") {
        return { tool: entryNext.tool, arguments: (entryNext.arguments as Record<string, unknown>) ?? {} };
      }
    }
  }
  return undefined;
}

// Generous: the dropped 40-line file pages back at 2 lines/hop once the
// per-response budget forces a cursor continuation (measured: ~20 hops for
// BETA alone) plus a couple more for ALPHA's own remainder and beta's first
// non-cursor hop — comfortably above the longest legitimate chain this
// fixture produces, so hitting the cap still means a loop, not a big request.
const HOP_CAP = 40;

describe.each([
  ["default", serverEnv()],
  ["vscode", serverEnv(VSCODE_ENV)],
] as const)("spawned server (%s config): rung 4 then rung 6 must not lose lines", (_label, env) => {
  it("a small entry + a large entry, tight budget: the large entry is narrowed then dropped, and every requested line of BOTH files eventually arrives", async () => {
    const ws = mkDir(_label);
    const ALPHA_LINES = 8;
    const BETA_LINES = 40;
    writeFile(ws, "data/alpha.txt", selfIdFileText("ALPHA", ALPHA_LINES, 30));
    writeFile(ws, "data/beta.txt", selfIdFileText("BETA", BETA_LINES, 50));

    const server = startServer(ws, env);
    spawnedServers.push(server);
    await server.initialize();

    // Mint each handle off a ONE-LINE slice, not a whole-file read: this
    // repo's small-file route serves a whole small file in one shot, which
    // would pre-deliver every line via the mint call itself and make the
    // completeness check below vacuous (it would pass even on the unfixed
    // code, since the caller already has everything from minting). A 1-line
    // mint leaves the rest of each file genuinely unserved, so the chain
    // below is the ONLY source of lines 2+.
    const mintAlpha = await server.call({ targets: [{ path: "data/alpha.txt", range: "1-1" }] });
    const mintBeta = await server.call({ targets: [{ path: "data/beta.txt", range: "1-1" }] });
    const hAlpha = (mintAlpha["evidence"] as Array<Record<string, unknown>>)?.[0]?.["handle"] as string;
    const hBeta = (mintBeta["evidence"] as Array<Record<string, unknown>>)?.[0]?.["handle"] as string;
    expect(hAlpha, JSON.stringify(mintAlpha).slice(0, 300)).toBeTruthy();
    expect(hBeta, JSON.stringify(mintBeta).slice(0, 300)).toBeTruthy();

    const first = await server.call({
      targets: [{ handle: hAlpha, range: `1-${ALPHA_LINES}` }, { handle: hBeta, range: `1-${BETA_LINES}` }],
      budget: { bytes: 700 },
    });
    expect(first["kind"], JSON.stringify(first).slice(0, 400)).toBe("read.batch");

    // THE DIRECT ASSERTION, on the FIRST hop: whatever recovery this hop
    // mints for the file it could not keep, it must not be a narrow sliver.
    // A pre-fix server would name `{"range":"1-1", ...}` here (or similar) for
    // whichever file rung 6 dropped after rung 4 had already narrowed it.
    const hop0Next = extractNext(first);
    expect(hop0Next, JSON.stringify(first)).toBeDefined();
    const hop0Range = hop0Next!.arguments["targets"]
      ? (hop0Next!.arguments["targets"] as Array<Record<string, unknown>>)[0]?.["range"] as string | undefined
      : (hop0Next!.arguments["range"] as string | undefined);
    if (hop0Range !== undefined) {
      const bounds = /^(\d+)-(\d+)$/.exec(hop0Range);
      expect(bounds, hop0Range).not.toBeNull();
      const span = Number(bounds![2]) - Number(bounds![1]) + 1;
      // The dropped file has >= 8 lines; a sliver recovery (the bug) spans 1-2
      // lines. Requiring a much wider span pins the fix directly.
      expect(span, `recovery span too narrow — looks like the pre-fix sliver bug: ${hop0Range}`).toBeGreaterThan(5);
    }

    // COMPLETENESS, following EVERY executable continuation this response and
    // its descendants carry — not only `limit.next`. A entry rung 4 merely
    // NARROWED (not dropped) keeps its own remainder reachable through its
    // OWN per-entry `next` (A.5.4's "handle" form field), which is a
    // DIFFERENT, independently-executable call from whatever `limit.next`
    // names for a DROPPED sibling entry (`wireLimit.ts`'s clause 4: only one
    // continuation can win `limit.next`, so the other's own remainder rides
    // its own field instead — see `truncateRangedEntries`'s doc comment).
    // Every call here is still run VERBATIM (AGENTS.md); this only widens
    // which of the response's own named calls get queued, never edits one.
    function everyNext(body: Record<string, unknown>): ToolCallShape[] {
      const out: ToolCallShape[] = [];
      const seenArgs = new Set<string>();
      const push = (c: ToolCallShape | undefined) => {
        if (c === undefined) return;
        const key = JSON.stringify(c.arguments);
        if (seenArgs.has(key)) return;
        seenArgs.add(key);
        out.push(c);
      };
      const limit = body["limit"] as Record<string, unknown> | undefined;
      const limitNext = limit?.["next"] as { tool?: unknown; arguments?: unknown } | undefined;
      if (limitNext && typeof limitNext.tool === "string") {
        push({ tool: limitNext.tool, arguments: (limitNext.arguments as Record<string, unknown>) ?? {} });
      }
      const topNext = body["next"] as { tool?: unknown; arguments?: unknown } | undefined;
      if (topNext && typeof topNext.tool === "string") {
        push({ tool: topNext.tool, arguments: (topNext.arguments as Record<string, unknown>) ?? {} });
      }
      const entries = body["entries"];
      if (Array.isArray(entries)) {
        for (const raw of entries) {
          const entry = raw as Record<string, unknown> | undefined;
          const entryNext = entry?.["next"] as { tool?: unknown; arguments?: unknown } | undefined;
          if (entryNext && typeof entryNext.tool === "string") {
            push({ tool: entryNext.tool, arguments: (entryNext.arguments as Record<string, unknown>) ?? {} });
          }
        }
      }
      return out;
    }

    const seenAlpha = new Set<number>();
    const seenBeta = new Set<number>();
    const harvest = (body: Record<string, unknown>): void => {
      const text = JSON.stringify(body);
      for (const n of servedLineNumbers(text, "ALPHA")) seenAlpha.add(n);
      for (const n of servedLineNumbers(text, "BETA")) seenBeta.add(n);
    };
    harvest(first);
    const queue: ToolCallShape[] = everyNext(first);
    const seenCalls = new Set<string>(queue.map((c) => JSON.stringify(c.arguments)));
    let calls = 0;
    while (queue.length > 0 && calls < HOP_CAP) {
      const call = queue.shift()!;
      calls += 1;
      const body = await server.call(call.arguments);
      harvest(body);
      for (const next of everyNext(body)) {
        const key = JSON.stringify(next.arguments);
        if (seenCalls.has(key)) continue;
        seenCalls.add(key);
        queue.push(next);
      }
    }
    expect(queue.length, `chain did not end within ${HOP_CAP} calls — possible loop`).toBe(0);

    for (let n = 1; n <= ALPHA_LINES; n += 1) {
      expect(seenAlpha.has(n), `ALPHA line ${n} never arrived across the chain`).toBe(true);
    }
    for (let n = 1; n <= BETA_LINES; n += 1) {
      expect(seenBeta.has(n), `BETA line ${n} never arrived across the chain — this is the exact line-loss defect`).toBe(true);
    }
    // No line outside the requested range for either self-identifying tag.
    for (const n of seenAlpha) expect(n, `ALPHA line ${n} is outside the requested 1-${ALPHA_LINES}`).toBeLessThanOrEqual(ALPHA_LINES);
    for (const n of seenBeta) expect(n, `BETA line ${n} is outside the requested 1-${BETA_LINES}`).toBeLessThanOrEqual(BETA_LINES);
  });
});

// ---------------------------------------------------------------------------
// FIX-A6 (v0.14.4 candidate, item 2): a handle dropped at CONSTRUCTION TIME
// (server.ts's A7 `handles=[]` loop, `handlesBatchCeiling`/
// `handlesBatchCapHit` — BEFORE the wire ladder above ever runs) used to be
// pushed to `omitted` as bare `{handle, reason:"cap-exceeded"}`, with no
// `path`. `readFamily.ts`'s `deriveNext` (rung 3) only turns a PATH-BEARING
// `omitted[]` entry into a recoverable `mode:"full"` continuation — and it
// reads `.path` off EVERY omitted entry regardless of `reason` — so a
// construction-time cap drop had NO executable `next` naming it at all: not
// `limit.next` (nothing to derive one from) and not any per-entry field
// (dropped entries never reach `entries[]`). Unlike a genuinely unknown
// handle, the server already knows this one's path for free (a handleTable
// hit, no file I/O) — it was simply never looked up because the loop skips
// straight to `continue` once the aggregate ceiling has fired.
// ---------------------------------------------------------------------------
describe.each([
  ["default", serverEnv()],
  ["vscode", serverEnv(VSCODE_ENV)],
] as const)("spawned server (%s config): a construction-time cap-exceeded handle stays reachable", (_label, env) => {
  it("three handles, a ceiling only the first fits under: the other two are dropped at construction time and must still be recoverable via next", async () => {
    const ws = mkDir(`capconstruct-${_label}`);
    const A_LINES = 30;
    const B_LINES = 12;
    const C_LINES = 12;
    // ~90 B/line: A alone (30 lines) serves comfortably over 2000 B, so a
    // 1200 B ceiling is crossed by A alone and `handlesBatchCapHit` flips
    // BEFORE the loop ever reaches B or C — the exact construction-time drop
    // this item targets, not the wire-level shed ladder the describe block
    // above exercises. (Measured: 500 B was too tight — the WIRE-level ladder
    // (a separate, later pass fed the SAME budget.bytes) could not fit even a
    // one-line A sliver alongside the two enriched omitted[] entries and
    // hard-refused before this item's fix ever got a chance to matter; 1200 B
    // leaves it enough room to truncate A via rung 4 instead.)
    writeFile(ws, "data/capa.txt", selfIdFileText("CAPA", A_LINES, 90));
    writeFile(ws, "data/capb.txt", selfIdFileText("CAPB", B_LINES, 90));
    writeFile(ws, "data/capc.txt", selfIdFileText("CAPC", C_LINES, 90));

    const server = startServer(ws, env);
    spawnedServers.push(server);
    await server.initialize();

    // Mint each handle off a narrow slice, matching the sibling test's own
    // rationale: leaving the rest of each file genuinely unserved so the
    // completeness check below is not vacuous.
    const mintA = await server.call({ targets: [{ path: "data/capa.txt", range: "1-1" }] });
    const mintB = await server.call({ targets: [{ path: "data/capb.txt", range: "1-1" }] });
    const mintC = await server.call({ targets: [{ path: "data/capc.txt", range: "1-1" }] });
    const hA = (mintA["evidence"] as Array<Record<string, unknown>>)?.[0]?.["handle"] as string;
    const hB = (mintB["evidence"] as Array<Record<string, unknown>>)?.[0]?.["handle"] as string;
    const hC = (mintC["evidence"] as Array<Record<string, unknown>>)?.[0]?.["handle"] as string;
    expect(hA, JSON.stringify(mintA).slice(0, 300)).toBeTruthy();
    expect(hB, JSON.stringify(mintB).slice(0, 300)).toBeTruthy();
    expect(hC, JSON.stringify(mintC).slice(0, 300)).toBeTruthy();

    const first = await server.call({
      targets: [
        { handle: hA, range: `1-${A_LINES}` },
        { handle: hB, range: `1-${B_LINES}` },
        { handle: hC, range: `1-${C_LINES}` },
      ],
      budget: { bytes: 1200 },
    });
    expect(first["kind"], JSON.stringify(first).slice(0, 400)).toBe("read.batch");

    // Local single-target next extraction + line harvest (mirrors the
    // sibling describe block's `everyNext`/`harvest` conventions — duplicated
    // rather than shared, to keep this addition isolated from the
    // must-stay-green test above).
    function oneNext(body: Record<string, unknown>): ToolCallShape | undefined {
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
    function entryNexts(body: Record<string, unknown>): ToolCallShape[] {
      const out: ToolCallShape[] = [];
      const entries = body["entries"];
      if (Array.isArray(entries)) {
        for (const raw of entries) {
          const entry = raw as Record<string, unknown> | undefined;
          const entryNext = entry?.["next"] as { tool?: unknown; arguments?: unknown } | undefined;
          if (entryNext && typeof entryNext.tool === "string") {
            out.push({ tool: entryNext.tool, arguments: (entryNext.arguments as Record<string, unknown>) ?? {} });
          }
        }
      }
      return out;
    }
    const seenA = new Set<number>();
    const seenB = new Set<number>();
    const seenC = new Set<number>();
    const harvest = (body: Record<string, unknown>): void => {
      const text = JSON.stringify(body);
      for (const n of servedLineNumbers(text, "CAPA")) seenA.add(n);
      for (const n of servedLineNumbers(text, "CAPB")) seenB.add(n);
      for (const n of servedLineNumbers(text, "CAPC")) seenC.add(n);
    };
    // MEASURED while building this test: the mint calls above ALREADY put
    // line 1 of each file on the wire — the construction-time recovery's own
    // `next` (mode="full", a real dedup-aware serve, unlike the A7 handles=[]
    // loop's un-deduped resolveSlice calls the sibling describe block relies
    // on) correctly skips re-shipping content this session already holds, so
    // line 1 of CAPB/CAPC never reappears in the chain below — it was never
    // lost, just never re-sent. Harvesting the mint responses too (not only
    // `first` and the chain) is what makes the completeness check honest.
    harvest(mintA);
    harvest(mintB);
    harvest(mintC);
    // Walks ONE continuation to completion before starting the next one —
    // simpler to reason about than one shared queue, and each of the two
    // continuations here (A's own `entries[0].next`, if any, and the
    // construction-time recovery's `limit.next`) is fully independent.
    async function drain(startCall: ToolCallShape | undefined): Promise<void> {
      let call = startCall;
      let hops = 0;
      while (call !== undefined && hops < HOP_CAP) {
        hops += 1;
        const body = await server.call(call.arguments);
        harvest(body);
        call = oneNext(body);
      }
      expect(hops, `a continuation chain did not end within ${HOP_CAP} hops — possible loop`).toBeLessThan(HOP_CAP);
    }

    harvest(first);
    // A's OWN remainder (if any — it may have shipped whole) and the
    // construction-time recovery (B+C) are independent; drain each fully.
    for (const start of entryNexts(first)) await drain(start);
    await drain(oneNext(first));

    // THE ASSERTION: every line of B and C — dropped at CONSTRUCTION time,
    // never even reaching `entries[]` on the first hop — must still arrive
    // somewhere in the chain. A never needed recovery (it always rides the
    // first hop in full, by the "at least one item always gets through"
    // guarantee), so it is checked too only as a sanity control.
    for (let n = 1; n <= A_LINES; n += 1) expect(seenA.has(n), `CAPA line ${n} never arrived`).toBe(true);
    for (let n = 1; n <= B_LINES; n += 1) {
      expect(seenB.has(n), `CAPB line ${n} never arrived — the construction-time cap-exceeded drop had no executable recovery`).toBe(true);
    }
    for (let n = 1; n <= C_LINES; n += 1) {
      expect(seenC.has(n), `CAPC line ${n} never arrived — the construction-time cap-exceeded drop had no executable recovery`).toBe(true);
    }
  });
});
