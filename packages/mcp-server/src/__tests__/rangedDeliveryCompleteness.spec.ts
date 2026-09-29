// rangedDeliveryCompleteness.spec.ts — TL-01 (plan-0143 §4, R01–R04).
//
// THE INVARIANT UNDER TEST, stated over LINE SETS and measured from the SERVED
// BYTES alone (never from the server's own `remaining`/`next` metadata, which
// is half of what is being checked):
//
//   R = the lines the caller asked for, across every caller-named ranged target
//   S = the lines actually present in bodies emitted on the wire
//   U = R − S
//
//   * a response that ENDS the chain (no executable `next`, no explicit stop)
//     => U = ∅ for EVERY caller-named target;
//   * U ≠ ∅ => an executable `next`, or an explicit stop (`refusal` /
//     `await_input`);
//   * no line OUTSIDE R is ever served for a caller-named ranged target;
//   * every hop of a verbatim `next` chain delivers at least one not-yet-
//     delivered requested line, or stops explicitly (progress / no loops);
//   * a caller-declared `budget.bytes` is a PER-RESPONSE cap that survives
//     into the server's own continuations.
//
// WHAT THIS FILE ADDS OVER `rangedBatchNextPreservation.spec.ts`: that file
// exercises the promotion/bundling defect at the server's DEFAULT cap with
// Markdown fixtures. This one pins the three delivery defects measured on the
// plan-0143 §4 payload, which only appear with an explicit small
// `budget.bytes` and plain-text lines wide enough to make the trim ladder bite:
//
//   RC-1  the execution contract / `next_call` was built BEFORE
//         `dedupeTrimAndPersist`'s post-contract shed tiers, so the emitted
//         `next` addressed bodies that no longer shipped.
//   RC-2  those tiers re-derived "did the caller name this surface?" from
//         `why`, which `trimToCap` Phase B had already cleared, so a
//         caller-named surface was deleted outright instead of having its body
//         reduced — silently, with no `dropped-by-byte-budget:` disclosure.
//   RC-3  with exactly ONE partial caller-ranged surface nothing withheld the
//         terminal: `act.edit` shipped with `remaining:["83-90"]` and no
//         `next` at all.
//
// BOTH HOST CONFIGS, always: "default" is literally no `TL_*`/`TOKENLIGHTEN_*`
// in the environment; "vscode" is the four variables the evaluator used. The
// fix is not flag-gated, so every assertion here holds in both, and the matrix
// additionally pins both states of `TL_PACK_FAIR_TRIM` (whose default IS the
// turn-economy switch, i.e. off in one config and on in the other).
//
// Harness pattern: raw JSON-RPC over stdio, copied from
// `rangedBatchNextPreservation.spec.ts` (which cites pi09StateHandles.spec.ts
// as the precedent).

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { shortTmpDir } from "./helpers/shortTmpDir.js";
import { rmDirWithRetry, waitForExit } from "./helpers/rmDirWithRetry.js";

const nodeRequire = createRequire(import.meta.url);
const TSX_CLI = nodeRequire.resolve("tsx/cli");
const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN_TS = path.resolve(HERE, "..", "bin.ts");
const HOME = process.env["HOME"] ?? process.env["USERPROFILE"] ?? os.homedir();

// Per-hop observations are a debugging aid only. Never a session-scratchpad path.
const SCRATCH_DIR = process.env["TL_EVAL_OUT_DIR"] ?? path.join(os.tmpdir(), "tl-ranged-delivery-observations");

// ---------------------------------------------------------------------------
// Host configurations
// ---------------------------------------------------------------------------

/** The four variables the v0.14.3 evaluation used for "VS Code向け設定". */
const VSCODE_ENV: Readonly<Record<string, string>> = {
  TOKENLIGHTEN_CLIENT: "vscode",
  TOKENLIGHTEN_CLIENT_ID: "vscode",
  TL_TURN_ECONOMY: "1",
  TOKENLIGHTEN_TASK_PACK_MAX_BYTES: "0",
};

/**
 * "default config" means NO `TL_*`/`TOKENLIGHTEN_*` at all — this package's own
 * vitest environment sets some (e.g. `TL_LEGACY_INPUT=accept`), so they are
 * stripped rather than merely not-added, or the "default" arm would silently
 * be testing this repo's test harness instead of a stock server.
 */
function serverEnv(overrides: Readonly<Record<string, string>> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("TL_") || key.startsWith("TOKENLIGHTEN_")) delete env[key];
  }
  return { ...env, ...overrides };
}

// ---------------------------------------------------------------------------
// Spawned-stdio-server harness
// ---------------------------------------------------------------------------

interface ServerHandle {
  initialize(clientName: string): Promise<void>;
  call(args: Record<string, unknown>): Promise<{ body: Record<string, unknown>; bytes: number; text: string }>;
  kill(): Promise<void>;
}

const tmpDirs: string[] = [];
const spawnedServers: ServerHandle[] = [];

function mkDir(tag: string): string {
  const dir = fs.realpathSync(shortTmpDir(HOME, `.tl-rdc-${tag}-`));
  tmpDirs.push(dir);
  return dir;
}

function writeFile(dir: string, rel: string, content: string): void {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
}

let toolCallId = 5000;

/**
 * FAIL-FIRST AFFORDANCE. Normally the working tree's own `bin.ts` is started
 * through tsx. Point `TL_RDC_SERVER_CLI` at a BUILT `tl-cli.js` (e.g. a
 * published-release snapshot) to run this identical spec against that server
 * instead — which is how the three defects above were shown failing before the
 * fix, without ever reverting the working tree. Stripped from the child's
 * environment like every other `TL_*`, so it cannot change server behaviour.
 */
function serverArgv(cwd: string): string[] {
  const cli = process.env["TL_RDC_SERVER_CLI"];
  return cli !== undefined && cli !== ""
    ? [cli, "mcp", "start", "--stdio", "--workspace", cwd]
    : [TSX_CLI, "--liftoff-only", BIN_TS, cwd];
}

function startServer(cwd: string, env: NodeJS.ProcessEnv): ServerHandle {
  const child: ChildProcess = spawn(process.execPath, serverArgv(cwd), {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env,
    // Own process group (POSIX), so kill() below reaches the tsx/CLI wrapper
    // AND the real server it execs underneath it (the CLI-wrapped
    // `TL_RDC_SERVER_CLI` form nests a grandchild too) — killing only the
    // direct child can orphan that real grandchild.
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
    initialize: async (clientName: string) => {
      await rpc(1, "initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: clientName, version: "0" },
      });
      child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    },
    call: async (args: Record<string, unknown>) => {
      const res = await rpc(toolCallId++, "tools/call", { name: "read_file", arguments: args });
      const text: string = res?.result?.content?.[0]?.text;
      expect(typeof text, `read_file returned no text content: ${JSON.stringify(res)}`).toBe("string");
      return { body: JSON.parse(text) as Record<string, unknown>, bytes: Buffer.byteLength(text, "utf8"), text };
    },
    kill: async () => {
      try {
        if (process.platform !== "win32" && child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        try { child.kill("SIGKILL"); } catch { /* already gone */ }
      }
      await waitForExit(child);
    },
  };
}

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
// Self-identifying fixtures.
//
// EVERY line carries its own 1-based number and its file's tag, so coverage is
// read out of the response bytes by a dumb scan. `targetBytes` is the knob the
// plan-0143 repro turns on: at ~55 B/line both configs already delivered
// 150/150 before this fix; at ~120 B/line the default config delivered 78/150.
// ---------------------------------------------------------------------------

const LINE_FILLER = "abcdefghijklmnopqrstuvwxyz0123456789 ";

function selfIdLine(tag: string, lineNum: number, targetBytes: number): string {
  let line = `L${String(lineNum).padStart(6, "0")} [${tag}] `;
  let i = 0;
  while (Buffer.byteLength(line, "utf8") < targetBytes) {
    line += LINE_FILLER[i % LINE_FILLER.length];
    i += 1;
  }
  return line;
}

/** Plain text (`.txt`), Markdown (`.md`) and TypeScript (`.ts`) all reduce to one self-identifying line per source line. */
function selfIdFileText(tag: string, totalLines: number, targetBytes: number, ext: string): string {
  const lines: string[] = [];
  for (let i = 1; i <= totalLines; i += 1) {
    const marker = selfIdLine(tag, i, targetBytes);
    // A `.ts` fixture must still be valid-ish source so the skeleton engine
    // does not reshape it; a line comment keeps every byte on its own line.
    lines.push(ext === ".ts" ? `// ${marker}` : marker);
  }
  return lines.join("\n") + "\n";
}

const LINE_MARKER_RE = /L(\d{6}) \[([A-Za-z0-9_]+)\]/g;

/** Every (tag, lineNum) pair present anywhere in a response's raw text. */
function servedLines(text: string): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>();
  for (const m of text.matchAll(LINE_MARKER_RE)) {
    const tag = m[2]!;
    if (!out.has(tag)) out.set(tag, new Set());
    out.get(tag)!.add(Number(m[1]));
  }
  return out;
}

function rangeSet(range: string): Set<number> {
  const m = /^(\d+)-(\d+)$/.exec(range);
  if (!m) throw new Error(`bad range ${range}`);
  const out = new Set<number>();
  for (let i = Number(m[1]); i <= Number(m[2]); i += 1) out.add(i);
  return out;
}

// ---------------------------------------------------------------------------
// The canonical continuation follower.
//
// AGENTS.md: for `read.task_pack`, `decision.kind === "discover"` => run its
// `next`; otherwise `limit.next`; otherwise a `read.batch` entry's own `next`.
// Every call is executed VERBATIM — nothing added, nothing removed.
// ---------------------------------------------------------------------------

interface ToolCallShape {
  tool: string;
  arguments: Record<string, unknown>;
}

interface ChainHop {
  index: number;
  kind: unknown;
  decisionKind: unknown;
  bytes: number;
  freshLines: number;
  next: ToolCallShape | undefined;
  explicitStop: boolean;
}

interface ChainResult {
  hops: ChainHop[];
  cumulative: Map<string, Set<number>>;
  /** True when the LAST hop neither carried a `next` nor was an explicit stop. */
  endedSilently: boolean;
  /** The follower's own cap, so the oracle can tell "a long chain" from "a loop". */
  hopCap: number;
}

/**
 * The follower's hop cap. Comfortably above the longest legitimate chain the
 * matrix produces (13 hops, measured), so reaching it with a live `next` really
 * does mean an unbounded continuation rather than a big request.
 */
const HOP_CAP = 24;

function nextOf(body: Record<string, unknown>): ToolCallShape | undefined {
  const decision = body["decision"] as Record<string, unknown> | undefined;
  const decisionNext = (decision?.["next"] ?? decision?.["next_call"]) as ToolCallShape | undefined;
  if (decision?.["kind"] === "discover" && decisionNext !== undefined) return decisionNext;
  const limit = body["limit"] as Record<string, unknown> | undefined;
  if (limit?.["next"] !== undefined) return limit["next"] as ToolCallShape;
  const entries = body["entries"] as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(entries)) {
    for (const entry of entries) {
      const entryNext = entry["next"] as ToolCallShape | undefined;
      if (entryNext != null) return entryNext;
    }
  }
  return undefined;
}

/**
 * An honest, non-silent end of the chain: a `refusal`, an `await_input`
 * decision, or a `done`. `act.answer`/`act.edit` are NOT stops — they are
 * terminal CERTIFICATES, and certifying over undelivered caller lines is
 * exactly defect RC-3.
 */
function isExplicitStop(body: Record<string, unknown>): boolean {
  if (body["kind"] === "refusal") return true;
  const kind = (body["decision"] as Record<string, unknown> | undefined)?.["kind"];
  return kind === "await_input" || kind === "await-input" || kind === "done";
}

async function followChain(
  server: ServerHandle,
  first: Record<string, unknown>,
  hopCap = HOP_CAP,
): Promise<ChainResult> {
  const hops: ChainHop[] = [];
  const cumulative = new Map<string, Set<number>>();
  let call: ToolCallShape | undefined = { tool: "read_file", arguments: first };
  let index = 0;

  while (call !== undefined && index < hopCap) {
    const { body, bytes, text } = await server.call(call.arguments);
    let fresh = 0;
    for (const [tag, lines] of servedLines(text)) {
      if (!cumulative.has(tag)) cumulative.set(tag, new Set());
      const bucket = cumulative.get(tag)!;
      for (const line of lines) {
        if (!bucket.has(line)) {
          bucket.add(line);
          fresh += 1;
        }
      }
    }
    const next = nextOf(body);
    hops.push({
      index,
      kind: body["kind"],
      decisionKind: (body["decision"] as Record<string, unknown> | undefined)?.["kind"],
      bytes,
      freshLines: fresh,
      next,
      explicitStop: isExplicitStop(body),
    });
    call = next;
    index += 1;
  }

  const last = hops[hops.length - 1];
  return {
    hops,
    cumulative,
    endedSilently: last !== undefined && last.next === undefined && !last.explicitStop,
    hopCap,
  };
}

// ---------------------------------------------------------------------------
// The oracle
// ---------------------------------------------------------------------------

interface RequestedTarget {
  readonly tag: string;
  readonly path: string;
  readonly range: string;
}

function requestedUnion(targets: readonly RequestedTarget[]): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>();
  for (const t of targets) {
    if (!out.has(t.tag)) out.set(t.tag, new Set());
    for (const n of rangeSet(t.range)) out.get(t.tag)!.add(n);
  }
  return out;
}

/** Every oracle violation this chain shows, as readable strings ([] = the cell passed). */
function oracleViolations(
  label: string,
  targets: readonly RequestedTarget[],
  chain: ChainResult,
  budgetBytes: number | undefined,
): string[] {
  const problems: string[] = [];
  const wanted = requestedUnion(targets);

  // R1(a): a chain that ended silently must have delivered every requested line.
  // R1(b): otherwise the chain must still be live or explicitly stopped.
  for (const [tag, want] of wanted) {
    const got = chain.cumulative.get(tag) ?? new Set<number>();
    const missing = [...want].filter((n) => !got.has(n)).sort((a, b) => a - b);
    if (missing.length > 0 && chain.endedSilently) {
      problems.push(`${label} ${tag}: chain ended with no next and no explicit stop, ${missing.length} requested line(s) never served (first: ${missing.slice(0, 8).join(",")})`);
    }
    // R1: never a line OUTSIDE the caller's own ranges for a caller-named target.
    const extra = [...got].filter((n) => !want.has(n)).sort((a, b) => a - b);
    if (extra.length > 0) {
      problems.push(`${label} ${tag}: ${extra.length} line(s) served OUTSIDE the requested ranges (first: ${extra.slice(0, 8).join(",")})`);
    }
  }

  // R2: progress. Every hop after the first delivers at least one new requested
  // line, or is itself an explicit stop.
  for (const hop of chain.hops.slice(1)) {
    if (hop.freshLines === 0 && !hop.explicitStop) {
      problems.push(`${label} hop ${hop.index}: zero new lines served and no explicit stop (kind=${String(hop.kind)}, decision=${String(hop.decisionKind)})`);
    }
  }

  // R4: the caller's declared per-response cap survives into the server's own
  // continuations. A `refusal` is the one documented exception — the minimal
  // error response may exceed a very small budget (plan §7.2).
  if (budgetBytes !== undefined) {
    for (const hop of chain.hops) {
      if (hop.kind === "refusal") continue;
      if (hop.bytes > budgetBytes) {
        problems.push(`${label} hop ${hop.index}: response ${hop.bytes} B exceeds the declared ${budgetBytes} B per-response budget (kind=${String(hop.kind)})`);
      }
    }
  }

  // No unbounded loop: the follower's cap must not be the thing that stopped it.
  const last = chain.hops[chain.hops.length - 1];
  if (chain.hops.length >= chain.hopCap && last?.next !== undefined) {
    problems.push(`${label}: chain still had a next after ${chain.hops.length} hops (hop cap reached — possible loop)`);
  }

  return problems;
}

// ===========================================================================
// 1. Plan R01 — the exact §4 payload, three line widths, both configs.
// ===========================================================================

const R01_TARGETS = (tagA: string, tagB: string, dir: string): RequestedTarget[] => [
  { tag: tagA, path: `${dir}/alpha.txt`, range: "11-90" },
  { tag: tagB, path: `${dir}/beta.txt`, range: "31-100" },
];

interface ConfigCase {
  readonly name: string;
  readonly env: Readonly<Record<string, string>>;
}

const CONFIGS: readonly ConfigCase[] = [
  { name: "default", env: {} },
  { name: "vscode", env: VSCODE_ENV },
];

for (const config of CONFIGS) {
  describe(`R01 — plan-0143 §4 payload, ${config.name} config`, () => {
    let ws: string;
    let server: ServerHandle;

    beforeAll(async () => {
      ws = mkDir(`r01-${config.name}`);
      for (const [idx, width] of [20, 55, 120].entries()) {
        const dir = `w${idx}`;
        writeFile(ws, `${dir}/alpha.txt`, selfIdFileText(`A${idx}`, 200, width, ".txt"));
        writeFile(ws, `${dir}/beta.txt`, selfIdFileText(`B${idx}`, 200, width, ".txt"));
      }
      server = startServer(ws, serverEnv(config.env));
      spawnedServers.push(server);
      await server.initialize(`vitest-rdc-${config.name}`);
    }, 90000);

    // Stop this describe's OWN server now, rather than letting it ride the
    // file-level afterAll through the R02/R03 matrix and R04 sections too.
    // Still left in the shared `spawnedServers` array as well; killing twice
    // is a safe no-op (see startServer's kill()).
    afterAll(async () => {
      await server.kill();
    });

    // 80 + 70 = 150 requested lines. Before this fix the ~120 B width
    // reproduced the plan's 78/150 EXACTLY in the default config (alpha 60/80,
    // missing 11-30; beta 18/70, missing 49-100) while ~55 B already passed —
    // which is why all three widths are pinned, not just the failing one.
    for (const [idx, width] of [20, 55, 120].entries()) {
      it(
        `delivers 150/150 with no extra lines and ends the chain at ~${width} B per line`,
        async () => {
          const dir = `w${idx}`;
          const targets = R01_TARGETS(`A${idx}`, `B${idx}`, dir);
          const chain = await followChain(server, {
            targets: targets.map((t) => ({ path: t.path, range: t.range })),
            content: "auto",
            budget: { bytes: 6500 },
            task: { epoch: "new" },
            lane: `r01w${idx}`,
            cwd: ws,
          });
          const problems = oracleViolations(`r01/${config.name}/${width}B`, targets, chain, 6500);
          expect(problems, problems.join("\n")).toEqual([]);
          // The positive half: full coverage really was reached, not merely
          // "not-yet-contradicted" because the chain is still running.
          for (const [tag, want] of requestedUnion(targets)) {
            const got = chain.cumulative.get(tag) ?? new Set<number>();
            const missing = [...want].filter((n) => !got.has(n));
            expect(missing, `${tag}: ${missing.length} of ${want.size} requested lines never served`).toEqual([]);
          }
        },
        120000,
      );
    }

    // RC-3: with a budget big enough that only ONE surface stays partial, the
    // pack used to certify `act.edit` with `remaining:["83-90"]` and NO `next`.
    it(
      "never certifies a terminal action while a caller-ranged surface still has undelivered lines",
      async () => {
        const dir = "w2"; // the ~120 B width
        const targets = R01_TARGETS("A2", "B2", dir);
        const first = await server.call({
          targets: targets.map((t) => ({ path: t.path, range: t.range })),
          content: "auto",
          budget: { bytes: 20000 },
          task: { epoch: "new" },
          lane: "r01rc3",
          cwd: ws,
        });
        const decision = first.body["decision"] as Record<string, unknown> | undefined;
        const evidence = (first.body["evidence"] as Array<Record<string, unknown>> | undefined) ?? [];
        const stillPartial = evidence.filter((e) => Array.isArray(e["remaining"]) && (e["remaining"] as unknown[]).length > 0);
        // Meaningfulness: this assertion is only informative while the fixture
        // really does leave a surface partial at this budget.
        expect(stillPartial.length, `fixture no longer leaves a partial surface at 20000 B: ${JSON.stringify(evidence.map((e) => [e["path"], e["range"], e["remaining"]]))}`).toBeGreaterThan(0);
        expect(
          decision?.["kind"],
          `terminal decision over undelivered caller lines: ${JSON.stringify({ decision, remaining: stillPartial.map((e) => [e["path"], e["remaining"]]) })}`,
        ).toBe("discover");
        expect(decision?.["next"] ?? decision?.["next_call"], "a discover decision must carry an executable next").toBeDefined();

        // ...and the whole chain from there still converges.
        const chain = await followChain(server, {
          targets: targets.map((t) => ({ path: t.path, range: t.range })),
          content: "auto",
          budget: { bytes: 20000 },
          task: { epoch: "new" },
          lane: "r01rc3b",
          cwd: ws,
        });
        const problems = oracleViolations(`rc3/${config.name}`, targets, chain, 20000);
        expect(problems, problems.join("\n")).toEqual([]);
      },
      120000,
    );

    // R4: the caller's per-response cap must reach the server's OWN minted
    // continuation. Measured before the fix: hop 0 respected 6,500 B and hop 1
    // came back at 14,589 B (default) / 15,687 B (vscode).
    it(
      "carries the caller's declared budget into every continuation it mints",
      async () => {
        const dir = "w2";
        const first = await server.call({
          targets: [
            { path: `${dir}/alpha.txt`, range: "11-90" },
            { path: `${dir}/beta.txt`, range: "31-100" },
          ],
          content: "auto",
          budget: { bytes: 6500 },
          task: { epoch: "new" },
          lane: "r01budget",
          cwd: ws,
        });
        const next = nextOf(first.body);
        expect(next, `hop 0 must still mint a continuation: ${JSON.stringify(first.body).slice(0, 600)}`).toBeDefined();
        expect(
          (next!.arguments["budget"] as Record<string, unknown> | undefined)?.["bytes"],
          `minted continuation dropped the caller's per-response budget: ${JSON.stringify(next)}`,
        ).toBe(6500);
      },
      120000,
    );

    // The control for R4's "only a CALLER-supplied budget is propagated": a
    // request that declares no budget must not acquire one from the server's
    // own default ceiling.
    it(
      "never invents a budget on a continuation when the caller declared none",
      async () => {
        const dir = "w2";
        const first = await server.call({
          targets: [
            { path: `${dir}/alpha.txt`, range: "11-90" },
            { path: `${dir}/beta.txt`, range: "31-100" },
          ],
          content: "auto",
          task: { epoch: "new" },
          lane: "r01nobudget",
          cwd: ws,
        });
        const next = nextOf(first.body);
        if (next !== undefined) {
          expect(
            next.arguments["budget"],
            `a server default leaked onto a continuation: ${JSON.stringify(next)}`,
          ).toBeUndefined();
        }
      },
      120000,
    );
  });
}

// ===========================================================================
// 2. R02 / R03 — the generated matrix.
//
// One server per (host config x TL_PACK_FAIR_TRIM) combination; cells are
// isolated inside it by their own subdirectory (so path-keyed state cannot
// cross), their own `lane`, and `task.epoch:"new"`. That is what keeps 80
// chains cheap enough to run as a guard.
// ===========================================================================

/** Deterministic 32-bit PRNG — the matrix must be identical on every machine. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MATRIX_SEED = 20260921;
const TARGET_COUNTS = [1, 2, 3, 5] as const;
/** 6144 is the server's own `budget-below-minimum` floor; `undefined` = none declared. */
const MATRIX_BUDGETS: ReadonlyArray<number | undefined> = [6144, 6500, 9000, 20000, undefined];
const MATRIX_EXTENSIONS = [".txt", ".md", ".ts"] as const;
const MATRIX_WIDTHS = [20, 55, 120] as const;
const MATRIX_FILE_LINES = 200;

interface MatrixCell {
  readonly id: string;
  readonly dir: string;
  readonly budget: number | undefined;
  readonly targets: RequestedTarget[];
  readonly files: Array<{ rel: string; tag: string; width: number; ext: string }>;
}

/**
 * Range shapes, chosen per cell by the seeded PRNG so the matrix covers the
 * plan's R02/R03 dimensions (overlapping, adjacent, single-line, end-of-file)
 * without enumerating their cross product.
 */
function rangeShape(kind: number, fileLines: number): string[] {
  switch (kind % 6) {
    case 0: return ["11-90"];                                   // the plan's own window
    case 1: return ["31-100", "95-140"];                        // OVERLAPPING
    case 2: return ["1-60", "61-120"];                          // ADJACENT
    case 3: return [`${fileLines}-${fileLines}`, "20-70"];      // SINGLE LINE at END OF FILE
    case 4: return [`${fileLines - 40}-${fileLines}`];          // END OF FILE window
    // R1's "never serve lines OUTSIDE the caller's ranges" against the one
    // shipped lever that is allowed to WIDEN a surface: `TL_FOLD_SMALL_REMAINDER`
    // (WP-S7) folds a file-boundary remainder of at most 40 lines into the whole
    // file, and its default IS the turn-economy switch — i.e. ON in the VS Code
    // arms of this matrix. This window leaves exactly a 30-line tail, inside
    // that bound, so the fold is eligible and the "no extra lines" half of the
    // oracle is the thing that decides.
    default: return [`1-${fileLines - 30}`];
  }
}

function buildMatrix(): MatrixCell[] {
  const rnd = mulberry32(MATRIX_SEED);
  const cells: MatrixCell[] = [];
  let n = 0;
  for (const count of TARGET_COUNTS) {
    for (const budget of MATRIX_BUDGETS) {
      const dir = `c${n}`;
      const files: MatrixCell["files"] = [];
      const targets: RequestedTarget[] = [];
      for (let f = 0; f < count; f += 1) {
        const ext = MATRIX_EXTENSIONS[Math.floor(rnd() * MATRIX_EXTENSIONS.length)]!;
        const width = MATRIX_WIDTHS[Math.floor(rnd() * MATRIX_WIDTHS.length)]!;
        const tag = `M${n}F${f}`;
        const rel = `${dir}/f${f}${ext}`;
        files.push({ rel, tag, width, ext });
        for (const range of rangeShape(Math.floor(rnd() * 5), MATRIX_FILE_LINES)) {
          targets.push({ tag, path: rel, range });
        }
      }
      // Order permutation: a deterministic rotation of the target list, so a
      // "first target is the long one" assumption cannot hide anywhere.
      const rotate = Math.floor(rnd() * Math.max(1, targets.length));
      const rotated = [...targets.slice(rotate), ...targets.slice(0, rotate)];
      cells.push({ id: `n${n}-t${count}-b${budget ?? "none"}`, dir, budget, targets: rotated, files });
      n += 1;
    }
  }
  return cells;
}

const MATRIX = buildMatrix();

interface MatrixArm {
  readonly name: string;
  readonly env: Readonly<Record<string, string>>;
}

const MATRIX_ARMS: readonly MatrixArm[] = [
  { name: "default+fairtrim-off", env: {} },
  { name: "default+fairtrim-on", env: { TL_PACK_FAIR_TRIM: "1" } },
  { name: "vscode+fairtrim-on", env: VSCODE_ENV },
  { name: "vscode+fairtrim-off", env: { ...VSCODE_ENV, TL_PACK_FAIR_TRIM: "0" } },
];

const matrixObservations: Array<Record<string, unknown>> = [];

afterAll(() => {
  if (matrixObservations.length === 0) return;
  try {
    fs.mkdirSync(SCRATCH_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(SCRATCH_DIR, "rangedDeliveryCompleteness-matrix.json"),
      JSON.stringify(matrixObservations, null, 2),
      "utf8",
    );
  } catch {
    /* observations are a debugging aid, never a gate */
  }
});

for (const arm of MATRIX_ARMS) {
  describe(`R02/R03 matrix — ${arm.name}`, () => {
    let ws: string;
    let server: ServerHandle;

    beforeAll(async () => {
      ws = mkDir(`mx-${arm.name.replace(/[^a-z]/gi, "")}`);
      for (const cell of MATRIX) {
        for (const file of cell.files) {
          writeFile(ws, file.rel, selfIdFileText(file.tag, MATRIX_FILE_LINES, file.width, file.ext));
        }
      }
      server = startServer(ws, serverEnv(arm.env));
      spawnedServers.push(server);
      await server.initialize(`vitest-rdc-mx`);
    }, 120000);

    // Stop this describe's OWN server now, rather than letting it ride the
    // file-level afterAll through the other matrix arms and R04. Still left
    // in the shared `spawnedServers` array too; killing twice is a safe
    // no-op (see startServer's kill()).
    afterAll(async () => {
      await server.kill();
    });

    it(
      `every cell keeps R = (R∩S) ∪ U with U reachable, no extra lines, progress on every hop, and every response inside the declared budget`,
      async () => {
        const failures: string[] = [];
        for (const cell of MATRIX) {
          const chain = await followChain(server, {
            targets: cell.targets.map((t) => ({ path: t.path, range: t.range })),
            content: "auto",
            ...(cell.budget === undefined ? {} : { budget: { bytes: cell.budget } }),
            task: { epoch: "new" },
            lane: `mx${cell.id}`,
            cwd: ws,
          });
          const problems = oracleViolations(`${arm.name}/${cell.id}`, cell.targets, chain, cell.budget);
          matrixObservations.push({
            arm: arm.name,
            cell: cell.id,
            targets: cell.targets.map((t) => `${t.path}:${t.range}`),
            hops: chain.hops.map((h) => ({ kind: h.kind, decision: h.decisionKind, bytes: h.bytes, fresh: h.freshLines })),
            problems,
          });
          failures.push(...problems);
        }
        expect(failures, `${failures.length} oracle violation(s) across ${MATRIX.length} cells:\n${failures.join("\n")}`).toEqual([]);
      },
      600000,
    );
  });
}

// ===========================================================================
// 3. R04 — the file changes under the chain, and a stale/foreign cursor.
//
// The plan's acceptance wording is "古い版を混ぜた成功ではなく、再開または
// 明示的な中断になる" (never a success that mixes an old revision in: restart or
// stop explicitly). These tests OBSERVE what the handle/sha machinery does and
// pin the honest outcomes, rather than prescribing one of them.
// ===========================================================================

describe("R04 — mid-chain file change and stale/foreign cursors", () => {
  let ws: string;
  let server: ServerHandle;

  beforeAll(async () => {
    ws = mkDir("r04");
    writeFile(ws, "m/alpha.txt", selfIdFileText("RA", 200, 120, ".txt"));
    writeFile(ws, "m/beta.txt", selfIdFileText("RB", 200, 120, ".txt"));
    writeFile(ws, "m/gamma.txt", selfIdFileText("RG", 200, 120, ".txt"));
    server = startServer(ws, serverEnv());
    spawnedServers.push(server);
    await server.initialize("vitest-rdc-r04");
  }, 90000);

  it(
    "a rewritten requested window is never reported as the OLD content, and the chain still terminates honestly",
    async () => {
      const first = await server.call({
        targets: [{ path: "m/alpha.txt", range: "11-90" }, { path: "m/beta.txt", range: "31-100" }],
        content: "auto",
        budget: { bytes: 6500 },
        task: { epoch: "new" },
        lane: "r04rewrite",
        cwd: ws,
      });
      const next = nextOf(first.body);
      expect(next, "hop 0 must mint a continuation for this shape").toBeDefined();

      // REWRITE the requested window: every line keeps its own number but gains
      // a REV2 stamp, so old and new bytes are distinguishable on the wire.
      const rewritten: string[] = [];
      for (let i = 1; i <= 200; i += 1) {
        rewritten.push(selfIdLine("RA", i, 120).replace(/^(L\d{6} \[RA\] )/, "$1REV2 "));
      }
      writeFile(ws, "m/alpha.txt", rewritten.join("\n") + "\n");

      const hop1 = await server.call(next!.arguments as Record<string, unknown>);
      const oldShaped = /L\d{6} \[RA\] (?!REV2)/.test(hop1.text);
      const newShaped = /L\d{6} \[RA\] REV2/.test(hop1.text);
      const stopped = isExplicitStop(hop1.body);
      // Honest outcomes: re-serve the CURRENT bytes, or stop explicitly. The one
      // forbidden outcome is presenting PRE-change bytes as this hop's answer.
      expect(
        !oldShaped || stopped,
        `hop 1 served pre-change alpha bytes as current content: ${hop1.text.slice(0, 500)}`,
      ).toBe(true);
      expect(newShaped || stopped || !/\[RA\]/.test(hop1.text), `hop 1 neither re-served nor stopped: ${hop1.text.slice(0, 500)}`).toBe(true);
    },
    120000,
  );

  it(
    "a foreign cursor is refused with a recovery, never answered with someone else's page",
    async () => {
      const r = await server.call({
        cursor: "tlc_not_a_real_cursor_from_this_server",
        cwd: ws,
        lane: "r04cursor",
      });
      expect(r.body["kind"], JSON.stringify(r.body).slice(0, 400)).toBe("refusal");
      const code = String(r.body["code"] ?? "");
      expect(
        /cursor/.test(code) || code === "invalid-argument" || code === "unknown-arguments",
        `a foreign cursor must refuse by its own code, got ${code}: ${JSON.stringify(r.body).slice(0, 400)}`,
      ).toBe(true);
      // Fail-closed: no evidence body may ride a refused cursor.
      expect(servedLines(r.text).size, `a refused cursor served content: ${r.text.slice(0, 400)}`).toBe(0);
    },
    60000,
  );
});
