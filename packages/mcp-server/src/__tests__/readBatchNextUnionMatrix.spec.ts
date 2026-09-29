/**
 * readBatchNextUnionMatrix.spec.ts — R-A3 (v0.14.4 candidate, 2026-09-21),
 * completed by R-A4 (SAME DAY).
 *
 * A generated, fixed-seed matrix proving the completeness oracle for
 * `read.batch`'s `limit.next` union fix (`protocol/budget/ladder.ts`,
 * `protocol/budget/wireLimit.ts`'s `unionBatchContinuations`): following
 * ONLY `limit.next` / top-level `next` verbatim, hop after hop, delivers
 * every requested line of every entry named in the ORIGINAL call, never a
 * line outside those windows, and the chain terminates.
 *
 * Dimensions sampled (a Mulberry32 PRNG seeded with a FIXED constant, so the
 * generated cases are the SAME on every run — no flakiness from a fresh
 * random draw):
 *   - handle-entry count: 2..12 (both edges always included).
 *   - declared `budget.bytes`: the `read.batch` floor (723 B, wireBudget.ts's
 *     `FLOOR_BY_KIND`) up to 9000 B (both edges always included).
 *   - workspace path length: short vs. long — the confirmed byte-threshold
 *     dependency (a long `cwd` embedded in every minted continuation pushes
 *     a response that would otherwise fit straight past the shed ladder's
 *     rung 4/6 boundary; see this fix's own report for the measured chain).
 *   - host config: default (no TL_ / TOKENLIGHTEN_ prefixed env) vs. VS Code
 *     (`TOKENLIGHTEN_CLIENT=vscode TOKENLIGHTEN_CLIENT_ID=vscode
 *     TL_TURN_ECONOMY=1 TOKENLIGHTEN_TASK_PACK_MAX_BYTES=0`).
 *
 * ONE spawned server per (path length, config) quadrant (4 total); each
 * quadrant runs several generated (entryCount, budget) cases against fresh
 * files per case, so case count stays bounded (~5 cases x 4 servers) rather
 * than the full ~300-cell cross product, which would cost far more spawn/RPC
 * time than this fix's own risk warrants — the seeded sample still exercises
 * every dimension's both edges plus a spread of the middle.
 *
 * R-A4 ADDITION: this file's OWN two `KNOWN_FAILURES` cells (below) were a
 * SECOND, unrelated line-loss seat this same matrix happened to surface —
 * confirmed (live instrumented trace) to be `wireLimit.ts`'s own
 * `unionBatchContinuationsFitting`, which used to "progressively drop the
 * OLDEST accumulated targets" when a full union of everything still owed did
 * not fit the caller's budget. That IS a silent drop, just a smaller one than
 * the defect R-A3 closed.
 *
 * R-A5 ADDITION (v0.14.4 candidate, SAME DAY): `unionBatchContinuationsFitting`
 * is RETIRED outright, not merely "no longer trims". A first attempt at "no
 * more trimming" kept a PER-STEP budget-fit gate (refuse the step outright if
 * its own candidate did not yet fit) and that gate produced a WORSE,
 * confirmed regression of its own: a 30-entry drop sequence
 * (`rangedBatchNextPreservation.spec.ts`'s F5 test) stalled after exactly ONE
 * accepted drop, because that lone step's own candidate — 29 other entries
 * still whole — was nowhere near the calibrated budget, even though 9 more
 * drops were all that stood between it and actually fitting. `ladder.ts` now
 * takes the full union UNCONDITIONALLY on every read.batch step and judges it
 * by the SAME progress check every other candidate answers to
 * (`candidateUsed < used`), never by whether it alone satisfies the caller's
 * declared budget — that question belongs to `emit.ts`'s existing tail
 * (`if (used > limit)`), asked ONCE against the ladder's last accepted state,
 * turning a hop that genuinely could not shed enough into a
 * `budget-below-minimum` refusal naming a MEASURED, margin-padded
 * `required_min_bytes` (see `emit.ts`'s `READ_BATCH_FLOOR_MARGIN_BYTES`) —
 * never a lossy "success" and never a premature give-up either. See
 * `BELOW_FLOOR_CASES`, the `floorAdjacentCases` block below, and the new
 * "R-A5 two-entry no-emitter-next sweep" block further down (the OTHER shape
 * — no construction-time emitter `next` at all).
 */
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { shortTmpDir } from "./helpers/shortTmpDir.js";
import { rmDirWithRetry, waitForExit } from "./helpers/rmDirWithRetry.js";

// ---------------------------------------------------------------------------
// Fixed-seed PRNG (Mulberry32) — deterministic across runs and platforms.
// ---------------------------------------------------------------------------
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SEED = 20260921; // fixed, memorable (this fix's own date) — never re-rolled.
const rng = mulberry32(SEED);
function randInt(min: number, max: number): number {
  return Math.floor(min + rng() * (max - min + 1));
}

const BATCH_FLOOR_BYTES = 723; // wireBudget.ts's FLOOR_BY_KIND["read.batch"].
const MAX_BUDGET = 9000;

interface Case {
  readonly entryCount: number;
  readonly budgetBytes: number;
}

/** `count` generated cases: both dimension edges pinned, the rest seeded-random. */
function generateCases(count: number): Case[] {
  const cases: Case[] = [
    { entryCount: 2, budgetBytes: BATCH_FLOOR_BYTES },
    { entryCount: 12, budgetBytes: MAX_BUDGET },
  ];
  while (cases.length < count) {
    cases.push({
      entryCount: randInt(2, 12),
      budgetBytes: randInt(BATCH_FLOOR_BYTES, MAX_BUDGET),
    });
  }
  return cases;
}

// ---------------------------------------------------------------------------
// Spawned-server harness (same shape as readBatchDropRecoveryCompleteness
// .spec.ts's own — deliberately duplicated rather than imported, so this
// matrix stays independently runnable and does not couple to that file's own
// internals).
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
let toolCallId = 30000;

function mkDir(tag: string): string {
  // "long": pads the workspace's own basename well past the byte-threshold
  // this fix's own confirmed chain measured (a short prefix like the probe's
  // own `.tl-zzcap-` does not reproduce; the spec's own `.tl-rbdrc-
  // capconstruct-default-` prefix does).
  const dir = fs.realpathSync(shortTmpDir(HOME, tag));
  tmpDirs.push(dir);
  return dir;
}

function writeFile(dir: string, rel: string, content: string): void {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
}

function startServer(cwd: string, env: NodeJS.ProcessEnv): ServerHandle {
  // Detached on POSIX so kill() can take down the whole process group: the tsx
  // wrapper re-spawns the real server, which would otherwise outlive it.
  const child: ChildProcess = spawn(process.execPath, [TSX_CLI, "--liftoff-only", BIN_TS, cwd], {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env,
    detached: process.platform !== "win32",
  });

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
      await rpc(1, "initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "ra3-matrix", version: "0" } });
      child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    },
    call: async (args: Record<string, unknown>) => {
      const res = await rpc(toolCallId++, "tools/call", { name: "read_file", arguments: args });
      const text: string = res?.result?.content?.[0]?.text;
      expect(typeof text, `read_file returned no text content: ${JSON.stringify(res)}`).toBe("string");
      return JSON.parse(text) as Record<string, unknown>;
    },
    kill: async () => {
      try {
        if (process.platform !== "win32" && child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        /* ok */
      }
      await waitForExit(child);
    },
  };
}

// Every case starts its own server; stop it when the case ends rather than
// letting one server per case pile up until the file-level afterAll.
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
// Self-identifying fixtures + verbatim-follower oracle.
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

/** ONLY `limit.next` / top-level `next` — the verbatim-follower contract this oracle proves. */
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

const HOP_CAP = 200;
const CASES_PER_QUADRANT = 5;
const LINES_PER_ENTRY = 20;
const BYTES_PER_LINE = 70;

/**
 * BELOW-FLOOR CASES — R-A3's own registered `KNOWN_FAILURES`, RESOLVED by
 * R-A4 (SAME DAY, 2026-09-21). Renamed from `KNOWN_FAILURES`: these two
 * generated cells are no longer failures, because the correct behaviour for
 * them turned out not to be "eventually deliver everything over dozens of
 * hops" but "refuse honestly, up front, with the exact byte floor this
 * request needs".
 *
 * ROOT CAUSE, CONFIRMED (a temporary, since-removed env-gated trace planted
 * directly in `wireLimit.ts`/`ladder.ts`/server.ts's A7 loop, run against
 * this exact `short|default|9|1011` cell): server.ts's A7 loop was NOT the
 * seat — every hop it traced named every deferred handle correctly, with
 * `path` and `range` both populated. The real seat was
 * `wireLimit.ts`'s `unionBatchContinuationsFitting`, R-A3's OWN first fix for
 * the sibling defect this file's header describes: when a hop's running
 * accumulator already promised two targets (from an earlier accepted step in
 * the SAME hop) and a third target's own drop could not be unioned with them
 * inside the budget, it "progressively drop[ped] the OLDEST accumulated
 * targets until a trimmed union fits" — sacrificing the FIRST of the two
 * already-promised targets to make room for the third. That promised target
 * is then simply absent from THIS hop's `limit.next`, and since every later
 * hop's request is built exclusively from the PRIOR hop's own `next`, nothing
 * ever asks for it again. Traced live: a 9-entry/1011 B case served
 * `entries[]`/`limit.next` target counts dropping from 9 to 8 between hop
 * ~40 and hop 56, and the chain then completed with that one entry's lines
 * 2-20 never delivered anywhere.
 *
 * THE FIX (`wireLimit.ts`, `ladder.ts`, `emit.ts`): `unionBatchContinuationsFitting`
 * no longer trims — a full union that does not fit REFUSES the step instead
 * (returns `undefined`), and `ladder.ts` treats that exactly like "no
 * constructible next" (the pre-existing E5 corollary a few lines above it):
 * the ladder stops rather than ship a lossy continuation. When the ladder
 * then ends a hop still over budget for exactly this reason, `emit.ts` turns
 * it into a `budget-below-minimum` refusal (the SAME wire shape the
 * task-pack/read-cursor floors already use) naming a MEASURED
 * `required_min_bytes` — the byte cost of the last fully-honest state, `limit.next`
 * naming EVERY target the accumulator held. Both cells below now refuse on
 * their very first real batch call (1011 B / 743 B are genuinely below what
 * 9 / 10 entries need) and complete in one more hop once retried at
 * `required_min_bytes` — verified via `runCaseTolerant` below, the SAME
 * oracle the new `floorAdjacentCases` block further down applies generically.
 */
const BELOW_FLOOR_CASES = new Set<string>([
  "short|default|9|1011",
  "short|vscode|10|743",
]);

/** One generated case's full body — shared by the expected-pass and below-floor registrations below. */
async function runCase(
  mkWorkspace: () => string,
  env: NodeJS.ProcessEnv,
  entryCount: number,
  budgetBytes: number,
): Promise<void> {
  const ws = mkWorkspace();
  const tags = Array.from({ length: entryCount }, (_, k) => `E${k}`);
  for (const tag of tags) {
    writeFile(ws, `data/${tag}.txt`, selfIdFileText(tag, LINES_PER_ENTRY, BYTES_PER_LINE));
  }

  const server = startServer(ws, env);
  spawnedServers.push(server);
  await server.initialize();

  const seen = new Map<string, Set<number>>(tags.map((t) => [t, new Set<number>()]));
  const harvest = (body: Record<string, unknown>): void => {
    const text = JSON.stringify(body);
    for (const tag of tags) for (const n of servedLineNumbers(text, tag)) seen.get(tag)!.add(n);
  };

  // Mint each handle off a ONE-LINE slice (leaves the rest genuinely
  // unserved — see readBatchDropRecoveryCompleteness.spec.ts's own identical
  // rationale), then request every handle's FULL window in one batch under
  // the generated budget. MEASURED (that same file's own "three handles"
  // test): the mint call already puts line 1 on the wire, and the server's
  // own sha-based dedup can then skip re-sending it in `first` (or fold it
  // into a receipt) — harvest every mint response too, or line 1 reads as a
  // false "never arrived".
  const handles: string[] = [];
  for (const tag of tags) {
    const mint = await server.call({ targets: [{ path: `data/${tag}.txt`, range: "1-1" }] });
    harvest(mint);
    const handle = (mint["evidence"] as Array<Record<string, unknown>>)?.[0]?.["handle"] as string | undefined;
    expect(handle, `no handle minted for ${tag}: ${JSON.stringify(mint).slice(0, 300)}`).toBeTruthy();
    handles.push(handle!);
  }

  const first = await server.call({
    targets: handles.map((handle, k) => ({ handle, range: `1-${LINES_PER_ENTRY}`, path: `data/${tags[k]}.txt` })),
    budget: { bytes: budgetBytes },
  });
  harvest(first);

  let call = oneNext(first);
  const seenCalls = new Set<string>();
  let hops = 0;
  while (call !== undefined && hops < HOP_CAP) {
    const key = JSON.stringify(call.arguments);
    // A repeated identical call (not merely a repeated TARGET — a
    // no-progress cursor loop would resend the SAME arguments) means the
    // chain is not converging; stop rather than spin to the hop cap.
    if (seenCalls.has(key)) break;
    seenCalls.add(key);
    hops += 1;
    const body = await server.call(call.arguments);
    harvest(body);
    call = oneNext(body);
  }
  expect(call, `chain did not terminate within ${HOP_CAP} hops (possible loop) for entryCount=${entryCount} budget=${budgetBytes}`).toBeUndefined();

  for (const tag of tags) {
    for (let n = 1; n <= LINES_PER_ENTRY; n += 1) {
      expect(
        seen.get(tag)!.has(n),
        `${tag} line ${n} never arrived via limit.next/next alone (entryCount=${entryCount}, budget=${budgetBytes}) — the exact line-loss class this fix closes`,
      ).toBe(true);
    }
    // No line outside the requested 1..LINES_PER_ENTRY for any tag.
    for (const n of seen.get(tag)!) {
      expect(n, `${tag} line ${n} is outside the requested window 1-${LINES_PER_ENTRY}`).toBeLessThanOrEqual(LINES_PER_ENTRY);
    }
  }
}

/**
 * R-A4: same setup and completeness oracle as `runCase`, but TOLERANT of an
 * initial `budget-below-minimum` refusal — the honest outcome this fix
 * introduces once a budget is genuinely below the floor
 * `unionBatchContinuationsFitting` needs to name every undelivered target
 * without dropping one (see this file's own header and the
 * `BELOW_FLOOR_CASES` doc comment above).
 *
 * `budgetBytes` is either a fixed number (the two `BELOW_FLOOR_CASES` below,
 * migrated from R-A3's own `KNOWN_FAILURES`, and the R-A5 sweep further
 * down) or a function of a MEASURED floor (the `floorAdjacentCases` block
 * further down). When it is a function, this first PROBES with
 * `BATCH_FLOOR_BYTES` — the kind's own flat pin, already confirmed too small
 * for every entry count >= 9 this file exercises — to learn this exact
 * request's real floor. A refusal serves no content at all
 * (`budgetBelowMinimumRefusal`'s shape carries no `entries`), so probing
 * first costs nothing towards the completeness check below.
 *
 * THE ORACLE, EXTENDED (R-A5, v0.14.4 candidate, 2026-09-21): if the resolved
 * budget itself is refused, running the refusal's OWN `next` VERBATIM
 * (AGENTS.md's own contract — never reconstructed by hand from `targets`/
 * `resolvedBudget`) must succeed OUTRIGHT, ON THE FIRST RETRY — never refuse
 * again (a `budget-below-minimum` loop would be the "same `next` twice"
 * class AGENTS.md's `state/readRequestStore.ts` banner already forbids for
 * the read-cursor's own floor). This is stricter than R-A4's own bounded
 * "up to 5 attempts" loop (RETIRED below): `emit.ts`'s
 * `READ_BATCH_FLOOR_MARGIN_BYTES` exists specifically to make the byte
 * count this refusal names survive being fed straight back in as the
 * retry's own declared budget, so a SECOND refusal here is a genuine
 * failure of that margin, not a tolerated jitter. From there, following
 * ONLY `limit.next`/top-level `next` verbatim must still deliver every
 * requested line of every entry, none outside, and the chain must end —
 * byte-identical to `runCase`'s own oracle from that point on.
 */
async function runCaseTolerant(
  mkWorkspace: () => string,
  env: NodeJS.ProcessEnv,
  entryCount: number,
  budgetBytes: number | ((floor: number) => number),
): Promise<void> {
  const ws = mkWorkspace();
  const tags = Array.from({ length: entryCount }, (_, k) => `E${k}`);
  for (const tag of tags) {
    writeFile(ws, `data/${tag}.txt`, selfIdFileText(tag, LINES_PER_ENTRY, BYTES_PER_LINE));
  }

  const server = startServer(ws, env);
  spawnedServers.push(server);
  await server.initialize();

  const seen = new Map<string, Set<number>>(tags.map((t) => [t, new Set<number>()]));
  const harvest = (body: Record<string, unknown>): void => {
    const text = JSON.stringify(body);
    for (const tag of tags) for (const n of servedLineNumbers(text, tag)) seen.get(tag)!.add(n);
  };

  const handles: string[] = [];
  for (const tag of tags) {
    const mint = await server.call({ targets: [{ path: `data/${tag}.txt`, range: "1-1" }] });
    harvest(mint);
    const handle = (mint["evidence"] as Array<Record<string, unknown>>)?.[0]?.["handle"] as string | undefined;
    expect(handle, `no handle minted for ${tag}: ${JSON.stringify(mint).slice(0, 300)}`).toBeTruthy();
    handles.push(handle!);
  }

  const targets = handles.map((handle, k) => ({ handle, range: `1-${LINES_PER_ENTRY}`, path: `data/${tags[k]}.txt` }));

  let resolvedBudget: number;
  if (typeof budgetBytes === "function") {
    const probe = await server.call({ targets, budget: { bytes: BATCH_FLOOR_BYTES } });
    expect(
      probe["kind"],
      `probe at the kind floor (${BATCH_FLOOR_BYTES} B) unexpectedly did not refuse for entryCount=${entryCount}: ${JSON.stringify(probe).slice(0, 300)}`,
    ).toBe("refusal");
    expect(probe["code"]).toBe("budget-below-minimum");
    const floor = probe["required_min_bytes"];
    expect(typeof floor, `probe carried no numeric required_min_bytes: ${JSON.stringify(probe)}`).toBe("number");
    resolvedBudget = budgetBytes(floor as number);
  } else {
    resolvedBudget = budgetBytes;
  }

  let first = await server.call({ targets, budget: { bytes: resolvedBudget } });
  // R-A5: EXACTLY one retry, via the refusal's OWN `next` run verbatim — see
  // this function's own doc comment above for why R-A4's bounded "up to 5
  // attempts" loop is retired rather than kept as extra headroom.
  if (first["kind"] === "refusal") {
    expect(
      first["code"],
      `unexpected refusal shape below the resolved budget (${resolvedBudget} B): ${JSON.stringify(first)}`,
    ).toBe("budget-below-minimum");
    const requiredMinBytes = first["required_min_bytes"];
    expect(typeof requiredMinBytes, `refusal carried no numeric required_min_bytes: ${JSON.stringify(first)}`).toBe("number");
    // THE OTHER HALF OF THE RULING: the refusal must carry an executable
    // `next` naming the SAME windows with `budget.bytes` already raised to
    // `required_min_bytes` — run VERBATIM, not reconstructed from `targets`/
    // `resolvedBudget` by hand.
    const retryNext = oneNext(first);
    expect(retryNext, `refusal carried no executable next: ${JSON.stringify(first)}`).toBeDefined();
    const retryBudget = (retryNext!.arguments["budget"] as { bytes?: number } | undefined)?.bytes;
    expect(retryBudget, `refusal's next did not raise budget.bytes to required_min_bytes: ${JSON.stringify(retryNext)}`).toBe(requiredMinBytes);
    first = await server.call(retryNext!.arguments);
    expect(
      first["kind"],
      `retrying via the refusal's own next (budget.bytes=${requiredMinBytes}) did not succeed on the FIRST try — `
        + `exactly the jitter READ_BATCH_FLOOR_MARGIN_BYTES (emit.ts) exists to absorb: ${JSON.stringify(first).slice(0, 300)}`,
    ).not.toBe("refusal");
  }
  harvest(first);

  let call = oneNext(first);
  const seenCalls = new Set<string>();
  let hops = 0;
  while (call !== undefined && hops < HOP_CAP) {
    const key = JSON.stringify(call.arguments);
    if (seenCalls.has(key)) break;
    seenCalls.add(key);
    hops += 1;
    const body = await server.call(call.arguments);
    harvest(body);
    call = oneNext(body);
  }
  expect(
    call,
    `chain did not terminate within ${HOP_CAP} hops (possible loop) for entryCount=${entryCount}, resolved budget=${resolvedBudget}`,
  ).toBeUndefined();

  for (const tag of tags) {
    for (let n = 1; n <= LINES_PER_ENTRY; n += 1) {
      expect(
        seen.get(tag)!.has(n),
        `${tag} line ${n} never arrived via limit.next/next (+ one required_min_bytes retry when refused) alone `
          + `(entryCount=${entryCount}, resolved budget=${resolvedBudget}) — the exact line-loss class this fix closes`,
      ).toBe(true);
    }
    for (const n of seen.get(tag)!) {
      expect(n, `${tag} line ${n} is outside the requested window 1-${LINES_PER_ENTRY}`).toBeLessThanOrEqual(LINES_PER_ENTRY);
    }
  }
}

describe.each([
  ["short", "default", () => mkDir(".tl-mx-"), serverEnv()],
  ["short", "vscode", () => mkDir(".tl-mx-"), serverEnv(VSCODE_ENV)],
  ["long", "default", () => mkDir(".tl-ra3-union-matrix-longpath-default-"), serverEnv()],
  ["long", "vscode", () => mkDir(".tl-ra3-union-matrix-longpath-vscode-"), serverEnv(VSCODE_ENV)],
] as const)("R-A3 generated matrix (path=%s, config=%s)", (pathLabel, configLabel, mkWorkspace, env) => {
  const cases = generateCases(CASES_PER_QUADRANT);
  const expectedPass = cases.filter((c) => !BELOW_FLOOR_CASES.has(`${pathLabel}|${configLabel}|${c.entryCount}|${c.budgetBytes}`));
  const expectedBelowFloor = cases.filter((c) => BELOW_FLOOR_CASES.has(`${pathLabel}|${configLabel}|${c.entryCount}|${c.budgetBytes}`));

  it.each(expectedPass.map((c, i) => [i, c.entryCount, c.budgetBytes] as const))(
    "case %i: %i entries, budget %i B — following ONLY limit.next/next verbatim delivers every requested line, none outside, chain ends",
    async (_i, entryCount, budgetBytes) => runCase(mkWorkspace, env, entryCount, budgetBytes),
    60_000,
  );

  it.each(expectedBelowFloor.map((c, i) => [i, c.entryCount, c.budgetBytes] as const))(
    "below-floor case %i: %i entries, budget %i B — refuses budget-below-minimum with required_min_bytes, and retrying at that size delivers every requested line, none outside, chain ends",
    async (_i, entryCount, budgetBytes) => runCaseTolerant(mkWorkspace, env, entryCount, budgetBytes),
    60_000,
  );
});

/**
 * R-A4 addition: the matrix extension the ruling asked for — {9, 12, 16}
 * entries x {floor - 1, floor, floor + 200}, where "floor" is MEASURED per
 * entry count (`runCaseTolerant`'s own probe), not a hand-derived formula —
 * this repo's shed ladder has no single closed-form byte count for "N
 * targets' worth of continuation", and probing the real system is exact
 * where a formula would only be an estimate. `short` workspace path and both
 * host configs, matching the byte-threshold dependency this whole file's
 * header names.
 *
 * ORACLE (identical for every cell, via `runCaseTolerant`): below the
 * measured floor -> the honest `budget-below-minimum` refusal naming
 * `required_min_bytes`, and re-issuing at that size makes real progress
 * (never refuses twice); at or above it -> following ONLY `limit.next`/`next`
 * verbatim delivers every requested line of every entry, none outside, and
 * the chain ends. Both halves are the SAME assertion block
 * (`runCaseTolerant`), so "below" and "at/above" are exercised identically
 * rather than by two different oracles that could quietly drift apart.
 */
describe.each([
  ["default", serverEnv()],
  ["vscode", serverEnv(VSCODE_ENV)],
] as const)("R-A4 floor-adjacent matrix (config=%s)", (_configLabel, env) => {
  const entryCounts = [9, 12, 16] as const;
  const offsets = [
    ["floor - 1", (floor: number) => floor - 1],
    ["floor", (floor: number) => floor],
    ["floor + 200", (floor: number) => floor + 200],
  ] as const;
  const cells = entryCounts.flatMap((entryCount) => offsets.map(([label, fn]) => [entryCount, label, fn] as const));

  it.each(cells)(
    "%i entries at %s — budget-below-minimum with required_min_bytes below the floor, verbatim-follower completeness at/above it",
    async (entryCount, _label, resolveBudget) => runCaseTolerant(() => mkDir(".tl-ra4-floor-"), env, entryCount, resolveBudget),
    60_000,
  );
});

/**
 * R-A5 (v0.14.4 candidate, 2026-09-21) addition — the ruling's own explicit
 * cell family: a plain TWO-entry batch (rung 4 narrows both, rung 6 drops
 * one — `readBatchDropRecoveryCompleteness.spec.ts`'s direct-ladder "sliver"
 * cases exercise exactly this shape at the unit level, see that file's own
 * R-A5 banner), with NO construction-time emitter `next` at all — two modest
 * entries never trip `server.ts`'s A7 `handlesBatchCeiling` aggregate cap,
 * so this is structurally the OTHER half of `wireLimit.ts`'s no-trim rule
 * from the floor-adjacent matrix above (9/12/16 entries, which DO trip that
 * cap at a tight budget and so exercise the WITH-emitter-`next` shape).
 * Swept across a wide, fixed budget range — not floor-relative — spanning
 * well below and well above this fixture's own measured floor, `short`
 * workspace path, both host configs.
 *
 * ORACLE: identical to every other cell in this file, via `runCaseTolerant`
 * — below the floor, the honest `budget-below-minimum` refusal whose own
 * `next` (run verbatim) makes real progress on the FIRST retry (never
 * refuses twice); at or above it, following ONLY `limit.next`/`next`
 * verbatim delivers every requested line of both entries, none outside, and
 * the chain ends.
 */
describe.each([
  ["default", serverEnv()],
  ["vscode", serverEnv(VSCODE_ENV)],
] as const)("R-A5 two-entry no-emitter-next sweep (config=%s)", (_configLabel, env) => {
  const budgets = [250, 400, 500, 600, 723, 900, 1200, 1600, 2000] as const;

  it.each(budgets.map((b) => [b] as const))(
    "2 entries, budget %i B — honest refusal below the floor (first-retry-via-next makes progress) or verbatim-follower completeness at/above it",
    async (budgetBytes) => runCaseTolerant(() => mkDir(".tl-ra5-sweep-"), env, 2, budgetBytes),
    60_000,
  );
});
