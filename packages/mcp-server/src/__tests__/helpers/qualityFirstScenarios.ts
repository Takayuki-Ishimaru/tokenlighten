/**
 * qualityFirstScenarios.ts — ONE shared definition of fixtures, scenarios,
 * and verdicts for the v0.14.3 improvement-plan quality-first acceptance
 * work (plan §9.1 stage A, TL-07; brief-w0.md).
 *
 * Consumed by TWO callers that must never drift apart:
 *   1. `qualityFirst0143.acceptance.spec.ts` — runs every scenario against
 *      the DEV server (`bin.ts`, this working tree) under both configs.
 *   2. `scripts/tl-quality-eval.mjs` — runs the SAME scenarios against any
 *      packaged build (v0.14.2 bundle, v0.14.3 snapshot, a release candidate)
 *      via its `mcp start --stdio` CLI surface.
 *
 * Every fixture is synthetic and generic (no fixture-specific or
 * benchmark-specific special-casing is READ by product code — these are
 * test-only oracles). Every scenario id follows plan §10's table
 * (R01, C01a, C01b, C02a, Q01, Q03, Q04, Q05).
 *
 * ---------------------------------------------------------------------------
 * WIRE FACTS this module encodes (learned by spawning the real v0.14.2 and
 * v0.14.3 builds and reading raw responses — see the wave report for the
 * full reproduction ledger):
 *
 * - `next` lives in one of FOUR places, checked in this order: (a)
 *   `decision.next_call` or `decision.next` (a `read.task_pack`'s own
 *   "discover" continuation — the SAME field also carries a plain object,
 *   never wrapped, when `decision.kind` is "discover"); (b) top-level
 *   `next` (rare in what we observed, kept for AGENTS.md compatibility);
 *   (c) `limit.next` (used by the `content:"full"` CURSOR-based
 *   continuation — `limit.next.arguments.cursor`, an opaque token, not a
 *   `{handle,range}` target — and by shedder-truncated `read.batch`); (d) a
 *   `read.batch` entry's own `entries[].next`. A caller must execute
 *   whichever one is present VERBATIM; this module never edits `next`
 *   arguments before replaying them.
 * - A `next` MINTED FOR A RANGE CONTINUATION (`decision.next` with
 *   `targets:[{handle,range}]`) is observed to NEVER carry a `budget`
 *   field, even when the ORIGINAL call had an explicit `budget.bytes`
 *   (confirmed on v0.14.2 default/vscode and v0.14.3 default/vscode alike
 *   — see C01b). A caller that executes it verbatim therefore loses the
 *   per-response cap it started with.
 * - `read.task_pack`'s `decision.kind==="act.answer"` can be reached WHILE
 *   `evidence[]` still carries a non-empty `remaining` on its own entries
 *   — i.e. "answer certified" and "body fully delivered" are not the same
 *   fact on the wire; a verifier must not assume one from the other.
 * - Absence/gap disclosure for an `act.answer` appears at
 *   `decision.certificate.gaps` as an array of PLAIN STRINGS shaped
 *   `"explicit-gap:request-item-absent:<token> (...)"`. For a `discover`
 *   or `await_input` decision, the shape is instead `decision.gaps` /
 *   `decision.unresolved`, an array of STRUCTURED objects
 *   `{code|kind, refs|reason|id}`. A reader must check both shapes and
 *   both field names — see `collectDisclosureTexts`.
 * - `<token>` in a gap string is a single salient WORD the server extracted
 *   from the query, not a stable concern id — it can be a content word
 *   ("database", "executed") or a near-meaningless connective ("happens",
 *   "works") depending on phrasing, even for the SAME underlying concern.
 *   A verifier must treat gap text as a soft (keyword) signal, never an
 *   exact-match contract.
 * - A `discover` chain that bottoms out at a bodyless `read.text` (no
 *   `decision` field at all) has NOT necessarily reached the task's final
 *   verdict. Re-issuing `{qref, cwd}` alone (no `query`) resumes the SAME
 *   task and can produce a materially different final `decision.kind`
 *   (observed: `discover` dead-end -> re-pack -> `await_input`, and
 *   separately -> re-pack -> `act.answer`). `followNextToEnd` below
 *   performs this re-pack automatically (bounded) when a chain would
 *   otherwise end on a non-terminal, decision-less response.
 * - `read.receipt` bodies were observed at a near-constant ~153 bytes
 *   across source bodies of very different sizes (2,446 B and 799 B both
 *   receipted to 153 B) — the receipt payload size is not proportional to
 *   the original body.
 * ---------------------------------------------------------------------------
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { waitForExit } from "./rmDirWithRetry.js";

// ---------------------------------------------------------------------------
// Config axes (plan §2.2 / brief-common "Builds available for A/B")
// ---------------------------------------------------------------------------

export type ConfigName = "default" | "vscode";
export const CONFIG_NAMES: readonly ConfigName[] = ["default", "vscode"];

/** Env vars a config ADDS on top of a clean process — never removes any. */
export const CONFIG_ENV: Readonly<Record<ConfigName, Readonly<Record<string, string>>>> = {
  default: {},
  vscode: {
    TOKENLIGHTEN_CLIENT: "vscode",
    TOKENLIGHTEN_CLIENT_ID: "vscode",
    TL_TURN_ECONOMY: "1",
    TOKENLIGHTEN_TASK_PACK_MAX_BYTES: "0",
  },
};

/**
 * Env for a DEV-tree spawn (`tsx bin.ts <ws>`): the existing repo
 * convention (`explorationContinuation.characterization.spec.ts`) — inherit
 * the vitest worker's env, then delete `TL_LEGACY_INPUT` (this package's own
 * `vitest.config.ts` sets it for the whole test PROCESS as a legacy-fixture
 * opt-in; every call this module makes is canonical-only by construction,
 * so an accidentally-legacy field must be REFUSED like production, not
 * silently tolerated) before layering the requested config's own vars.
 */
export function devSpawnEnv(config: ConfigName): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env["TL_LEGACY_INPUT"];
  return { ...env, ...CONFIG_ENV[config] };
}

/**
 * Env for spawning an ARBITRARY packaged build (`tl-quality-eval.mjs`'s
 * job): built from a SMALL allow-list, never inheriting the caller's own
 * `TL_` / `TOKENLIGHTEN_`-prefixed vars (brief-w0.md: "never inherit the
 * caller's TL_ / TOKENLIGHTEN_ vars"). `homeDir` should be a fresh, isolated
 * directory the caller owns and cleans up — never the real `$HOME` (hard
 * rule 12: never let a probe touch the real
 * `~/Library/Application Support/tokenlighten`).
 */
export function isolatedSpawnEnv(
  config: ConfigName,
  homeDir: string,
  extra: Readonly<Record<string, string>> = {},
): NodeJS.ProcessEnv {
  // `DEVELOPER_DIR` selects the macOS toolchain. A packaged CLI started with
  // `--allow-write` (E01) checks that `git` runs; on a Mac whose Xcode licence
  // is not accepted, `/usr/bin/git` only runs with `DEVELOPER_DIR` pointing at
  // the Command Line Tools. It is not a TokenLighten setting, so passing it
  // through keeps the isolation this function exists for.
  const allow = ["PATH", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL", "SystemRoot", "windir", "ComSpec", "DEVELOPER_DIR"];
  const env: NodeJS.ProcessEnv = {};
  for (const key of allow) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  env["HOME"] = homeDir;
  env["USERPROFILE"] = homeDir;
  return { ...env, ...CONFIG_ENV[config], ...extra };
}

// ---------------------------------------------------------------------------
// Server launch + stdio JSON-RPC client
// ---------------------------------------------------------------------------

export interface ToolCallShape {
  tool: string;
  arguments: Record<string, unknown>;
}

export interface ServerHandle {
  initialize(): Promise<void>;
  /** Parsed `content[0].text` JSON body, plus its raw UTF-8 byte length. */
  callTool(name: string, args: Record<string, unknown>): Promise<{ body: any; textBytes: number }>;
  /** Raw `tools/list` result: the `tools` array plus its compact-JSON UTF-8
   *  byte length (evaluation0927Scenarios.ts V09: the fixed schema cost per
   *  `--tool-surface`, independent of any workspace/query). Added here
   *  (brief-w0.md's own example addition) rather than forked into a second
   *  copy of `spawnJsonRpcServer`. */
  listTools(): Promise<{ tools: readonly unknown[]; textBytes: number }>;
  /** Kills the server AND any process it spawned (see header: CLI-wrapped
   *  builds nest a real `bin.js` grandchild under `tl mcp start --stdio`). */
  kill(): Promise<void>;
  readonly command: string;
  readonly args: readonly string[];
  /** The DIRECT child's pid (the wrapper, for a CLI-wrapped build — not
   *  necessarily the real `bin.js` grandchild it may nest). Used only for
   *  best-effort peak-RSS sampling (plan §9.2); `undefined` if the process
   *  already exited or spawning failed in a way that never set `child.pid`. */
  readonly pid: number | undefined;
}

function spawnJsonRpcServer(command: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv): ServerHandle {
  // `detached` (POSIX): makes this child its OWN process-group leader, so a
  // grandchild it spawns without its own `detached` flag (e.g. `tl mcp
  // start --stdio`'s real `bin.js`) inherits THIS group rather than ours —
  // `process.kill(-pid, ...)` then reaches both in one signal. Verified by
  // hand (spawn `tl mcp start --stdio`, SIGKILL the wrapper's pid alone: the
  // grandchild `bin.js` can outlive it) before relying on this.
  const child: ChildProcess = spawn(command, args, {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env,
    detached: process.platform !== "win32",
  });

  let stdoutBuf = "";
  let stderrBuf = "";
  const waiters = new Map<number, (msg: any) => void>();

  child.stdout!.on("data", (chunk: Buffer) => {
    stdoutBuf += chunk.toString("utf8");
    let nl: number;
    while ((nl = stdoutBuf.indexOf("\n")) >= 0) {
      const line = stdoutBuf.slice(0, nl);
      stdoutBuf = stdoutBuf.slice(nl + 1);
      if (!line.trim()) continue;
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // stdio noise, not a JSON-RPC frame
      }
      if (msg && msg.id != null && waiters.has(msg.id)) {
        const waiter = waiters.get(msg.id)!;
        waiters.delete(msg.id);
        waiter(msg);
      }
    }
  });
  child.stderr!.on("data", (chunk: Buffer) => {
    stderrBuf += chunk.toString("utf8");
  });

  let nextId = 1;
  function rpc(method: string, params?: unknown, timeoutMs = 45_000): Promise<any> {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(id);
        reject(new Error(`rpc '${method}' timed out after ${timeoutMs}ms.\n--- stderr ---\n${stderrBuf}`));
      }, timeoutMs);
      waiters.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  return {
    command,
    args,
    get pid(): number | undefined {
      return child.pid;
    },
    async initialize(): Promise<void> {
      await rpc("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "tl-quality-first", version: "0" },
      });
      child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    },
    async callTool(name: string, callArgs: Record<string, unknown>) {
      const res = await rpc("tools/call", { name, arguments: callArgs });
      if (res?.error !== undefined) {
        throw new Error(`tool ${name} returned a JSON-RPC error: ${JSON.stringify(res.error)}`);
      }
      const text: string | undefined = res?.result?.content?.[0]?.text;
      if (typeof text !== "string") {
        throw new Error(`tool ${name} returned no text content: ${JSON.stringify(res).slice(0, 2000)}`);
      }
      return { body: JSON.parse(text), textBytes: Buffer.byteLength(text, "utf8") };
    },
    async listTools() {
      const res = await rpc("tools/list", {});
      if (res?.error !== undefined) {
        throw new Error(`tools/list returned a JSON-RPC error: ${JSON.stringify(res.error)}`);
      }
      const tools = res?.result?.tools;
      if (!Array.isArray(tools)) {
        throw new Error(`tools/list returned no tools array: ${JSON.stringify(res).slice(0, 2000)}`);
      }
      return { tools, textBytes: Buffer.byteLength(JSON.stringify(tools), "utf8") };
    },
    async kill(): Promise<void> {
      try {
        if (process.platform === "win32") {
          // /T = kill the whole tree, /F = force. Best-effort: a server that
          // already exited makes taskkill fail loudly but harmlessly.
          const { spawnSync } = await import("node:child_process");
          spawnSync("taskkill", ["/T", "/F", "/PID", String(child.pid)]);
        } else if (child.pid !== undefined) {
          process.kill(-child.pid, "SIGKILL");
        } else {
          child.kill("SIGKILL");
        }
      } catch {
        // Already exited, or the group is gone — best-effort cleanup.
        try {
          child.kill("SIGKILL");
        } catch {
          /* ok */
        }
      }
      await waitForExit(child);
    },
  };
}

export interface TraceEntry {
  tool: string;
  arguments: Record<string, unknown>;
  response: unknown;
  textBytes: number;
  timestampMs: number;
}

/**
 * Wraps a `ServerHandle` so every `callTool` invocation — regardless of
 * whether the scenario internally used `followNextToEnd` or a fixed call
 * sequence (e.g. C02a) — is appended to `sink`. Used by
 * `scripts/tl-quality-eval.mjs` to emit per-call traces without the
 * `Scenario` interface itself needing to know about tracing.
 */
export function withTracing(server: ServerHandle, sink: TraceEntry[]): ServerHandle {
  return {
    command: server.command,
    args: server.args,
    get pid(): number | undefined {
      return server.pid;
    },
    initialize: () => server.initialize(),
    async callTool(name: string, args: Record<string, unknown>) {
      const result = await server.callTool(name, args);
      sink.push({ tool: name, arguments: args, response: result.body, textBytes: result.textBytes, timestampMs: Date.now() });
      return result;
    },
    listTools: () => server.listTools(),
    kill: () => server.kill(),
  };
}

const nodeRequire = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
/** `__tests__/helpers/` -> `__tests__/` -> `src/` -> `bin.ts`. */
const DEV_BIN_TS = path.resolve(HERE, "..", "..", "bin.ts");

export interface DevServerOptions {
  toolSurface?: "code" | "full";
  allowWrite?: boolean;
  extraArgs?: readonly string[];
}

/** Starts the DEV tree's server directly (`tsx bin.ts <ws> ...`) — no CLI
 *  wrapper, no process nesting, matching the existing spec convention. */
export function startDevServer(workspace: string, config: ConfigName, opts: DevServerOptions = {}): ServerHandle {
  const tsxCli = nodeRequire.resolve("tsx/cli");
  const args = [tsxCli, "--liftoff-only", DEV_BIN_TS, workspace, "--tool-surface", opts.toolSurface ?? "code"];
  if (opts.allowWrite) args.push("--allow-write");
  if (opts.extraArgs) args.push(...opts.extraArgs);
  return spawnJsonRpcServer(process.execPath, args, workspace, devSpawnEnv(config));
}

export interface CliServerOptions {
  toolSurface?: "code" | "full";
  allowWrite?: boolean;
  /** Isolated $HOME for the child (see `isolatedSpawnEnv`). Required: a
   *  probe against an arbitrary build must never touch the real HOME. */
  homeDir: string;
  extraEnv?: Readonly<Record<string, string>>;
  /** Set false only after confirming the target build's CLI lacks
   *  `--tool-surface` (brief-w0.md fallback clause). Both v0.14.2 and
   *  v0.14.3's bundled CLIs were confirmed to support it (`mcp start --help`
   *  lists it in both) — this defaults to true. */
  supportsToolSurface?: boolean;
}

/** Starts an arbitrary packaged build through its OWN CLI surface
 *  (`node <cli> mcp start --stdio --workspace <ws> ...`), matching how the
 *  v0.14.3 evaluator itself launched the server (brief-common). */
export function startCliServer(cliPath: string, workspace: string, config: ConfigName, opts: CliServerOptions): ServerHandle {
  const absCli = path.resolve(cliPath);
  const args = ["mcp", "start", "--stdio", "--workspace", workspace];
  if (opts.allowWrite) args.push("--allow-write");
  if (opts.supportsToolSurface !== false) args.push("--tool-surface", opts.toolSurface ?? "code");
  const env = isolatedSpawnEnv(config, opts.homeDir, opts.extraEnv);
  return spawnJsonRpcServer(process.execPath, ["--liftoff-only", absCli, ...args], workspace, env);
}

// ---------------------------------------------------------------------------
// Generic "next" chain follower
// ---------------------------------------------------------------------------

export interface Hop {
  hopIndex: number;
  call: ToolCallShape;
  response: any;
  textBytes: number;
  /** Where THIS hop's own outgoing `next` (if any) was found. */
  nextSource: "decision" | "top-level" | "limit" | "batch-entry" | "qref-repack" | "none";
}

export interface ChainResult {
  hops: Hop[];
  /** The last hop's response — convenience for verdicts that only care
   *  about the final state. */
  final: any;
  /** True if the loop stopped because it hit `hopCap`/`maxRepacks` rather
   *  than because there was genuinely no more `next` to run. Verdicts
   *  should treat a capped chain as inconclusive, not as a clean "done". */
  capped: boolean;
}

function pick(obj: unknown, keyPath: string): any {
  return keyPath.split(".").reduce((acc: any, key) => (acc == null ? undefined : acc[key]), obj);
}

/** Extract the ONE `next` call this response carries, per the wire facts in
 *  this module's header — checked in a fixed order, never guessed. Exported
 *  (in addition to being used internally by `followNextToEnd`) so scenarios
 *  that need to interleave a side effect (e.g. mutating a file, or a bare
 *  retry of the same call) BETWEEN hops — R03/R04 — can drive the chain by
 *  hand via `walkHops` below instead of duplicating this extraction logic. */
export function extractNext(response: any): { next: ToolCallShape | undefined; source: Hop["nextSource"] } {
  const decisionNext = pick(response, "decision.next_call") ?? pick(response, "decision.next");
  if (decisionNext && typeof decisionNext === "object" && typeof decisionNext.tool === "string") {
    return { next: decisionNext as ToolCallShape, source: "decision" };
  }
  const topNext = response?.next;
  if (topNext && typeof topNext === "object" && typeof topNext.tool === "string") {
    return { next: topNext as ToolCallShape, source: "top-level" };
  }
  const limitNext = pick(response, "limit.next");
  if (limitNext && typeof limitNext === "object" && typeof limitNext.tool === "string") {
    return { next: limitNext as ToolCallShape, source: "limit" };
  }
  const entries = response?.entries;
  if (Array.isArray(entries)) {
    for (const entry of entries) {
      if (entry?.next && typeof entry.next === "object" && typeof entry.next.tool === "string") {
        return { next: entry.next as ToolCallShape, source: "batch-entry" };
      }
    }
  }
  return { next: undefined, source: "none" };
}

export interface FollowOptions {
  hopCap?: number;
  /** How many times a dead-end (no `next`, but a `qref` was seen) may be
   *  resumed via `{qref, cwd}` alone. See header: a `discover` chain that
   *  bottoms out at a bodyless zoom has not necessarily reached the task's
   *  real final decision — re-packing via `qref` alone can surface a later
   *  `act.answer`/`await_input` that the naive "next" chain never reaches. */
  maxQrefRepacks?: number;
  cwd: string;
}

/**
 * Runs `firstCall`, then repeatedly executes whatever `next` each response
 * carries (verbatim — no field is added, removed, or edited), stopping when
 * a response has no `next` AND (having exhausted `maxQrefRepacks`) no more
 * qref re-pack is available, or when `hopCap` is reached.
 */
export async function followNextToEnd(server: ServerHandle, firstCall: ToolCallShape, opts: FollowOptions): Promise<ChainResult> {
  const hopCap = opts.hopCap ?? 12;
  const maxQrefRepacks = opts.maxQrefRepacks ?? 2;
  const hops: Hop[] = [];
  let call: ToolCallShape | undefined = firstCall;
  let lastQref: string | undefined;
  let repacksUsed = 0;
  let capped = false;

  while (call !== undefined) {
    if (hops.length >= hopCap) {
      capped = true;
      break;
    }
    const { body, textBytes } = await server.callTool(call.tool, call.arguments);
    if (typeof body?.qref === "string") lastQref = body.qref;

    const { next, source } = extractNext(body);
    hops.push({ hopIndex: hops.length, call, response: body, textBytes, nextSource: source });

    if (next !== undefined) {
      call = next;
      continue;
    }
    if (lastQref !== undefined && repacksUsed < maxQrefRepacks) {
      repacksUsed += 1;
      call = { tool: "read_file", arguments: { qref: lastQref, cwd: opts.cwd } };
      hops[hops.length - 1]!.nextSource = hops[hops.length - 1]!.nextSource === "none" ? "none" : hops[hops.length - 1]!.nextSource;
      continue;
    }
    call = undefined;
  }

  return { hops, final: hops[hops.length - 1]?.response, capped };
}

/**
 * A lower-level chain walker than `followNextToEnd`: executes `startCall`,
 * then whatever `next` each response carries (verbatim, via `extractNext`),
 * WITHOUT the qref-repack fallback and WITHOUT hiding the individual raw
 * responses from the caller. Used by R03/R04, which need to inject a side
 * effect (a retry of an earlier call, or a file mutation) at an EXACT point
 * mid-chain — something a caller cannot do once control is inside
 * `followNextToEnd`'s own loop. `hopCap` bounds it the same way.
 */
export async function walkHops(
  server: ServerHandle,
  startCall: ToolCallShape,
  hopCap: number,
): Promise<{ responses: unknown[]; capped: boolean }> {
  const responses: unknown[] = [];
  let call: ToolCallShape | undefined = startCall;
  while (call !== undefined) {
    if (responses.length >= hopCap) return { responses, capped: true };
    const { body } = await server.callTool(call.tool, call.arguments);
    responses.push(body);
    call = extractNext(body).next;
  }
  return { responses, capped: false };
}

/**
 * True iff `response` is an HONEST full stop rather than a silent dead end:
 * a structured `refusal`, or a terminal `discover`/`await_input` decision
 * that names what is unresolved. Mirrors the `isExplicitStop` convention
 * already used by `rangedDeliveryCompleteness.spec.ts` (product spec) for
 * the identical judgment — kept here as this module's OWN copy since that
 * file is read-only reference material, not something this harness imports
 * from (test files do not share helpers across the product/test boundary
 * this repo draws between a shared harness and a single product spec).
 */
export function isExplicitStop(response: unknown): boolean {
  if ((response as Record<string, unknown> | null | undefined)?.["kind"] === "refusal") return true;
  const decisionKind = pick(response, "decision.kind");
  return decisionKind === "await_input" || decisionKind === "await-input" || decisionKind === "done";
}

// ---------------------------------------------------------------------------
// Line-set accounting (R01 / C01a / C01b)
//
// Every data line is self-identifying (`<tag>-<NNNN> <filler>`), so coverage
// is verified from the SERVED BYTES alone via a dumb regex scan over the
// whole JSON response — never from the server's own `remaining`/`next`
// metadata, which is exactly what is under test. Scanning `JSON.stringify`
// (rather than trying to reconstruct "lines" from a rendered view) survives
// gutters for free — a numeric gutter prefix is just more text the regex
// skips over.
//
// EXTRACTION PITFALL (found by hand while building this file, fixed here):
// a bare `[A-Za-z]+-\d{4}` marker is UNSOUND under JSON escaping. A
// multi-line served body's embedded newline becomes the two literal
// characters backslash-n once `JSON.stringify`'d, and `[A-Za-z]+` — being an
// unanchored, greedy character class — swallows that lowercase "n" into the
// tag capture: every line after a body's first was silently mis-tagged
// "nalpha" instead of "alpha" and vanished from "alpha"'s coverage set
// (confirmed: a 9-line hop reported only its first line covered). Wrapping
// the marker in literal brackets (`[tag-nnnn]`) fixes extraction (`[` is not
// a letter, so a stray "n" can't extend into it — the same reason
// rangedBatchNextPreservation.spec.ts's own marker keeps its tag inside
// `[...]`), but changing the FIXTURE'S OWN BYTES to add those two extra
// characters per line was independently observed to shift the server's
// per-response chunking enough that it stopped reproducing plan-0143's R01
// regression on v0.14.3 at the exact byte target that used to reproduce it
// (confirmed: v0.14.3 default went from 78/150 to 150/150 merely by adding
// "[" "]" to every line, reproducibly across a wide sweep of byte targets).
// So the FIX here is to `extractServedIds` alone, matching against an
// EXPLICIT, CALLER-SUPPLIED tag list via alternation (`(alpha|beta)`)
// instead of a generic `[A-Za-z]+` class — an alternation can only match one
// of the exact known words, so "nalpha" simply fails the "alpha" branch at
// that position and the engine retries one character later, landing exactly
// on "alpha" — while leaving the FIXTURE BYTES themselves untouched (the
// same recipe that reproduces the plan's exact numbers, see below).
//
// Elision markers are credited with their whole represented span, matching
// the proven approach in rangedBatchNextPreservation.spec.ts (P3 fix) — not
// exercised by the plain `data/*.txt` fixtures below (no comment elision
// applies to non-code files), but kept for reuse by a future
// source-code-shaped variant.
// ---------------------------------------------------------------------------

// ASCII, not multi-byte: this EXACT filler + 120-byte target is the recipe
// CONFIRMED (by hand, spawning the real v0.14.2/v0.14.3 builds) to reproduce
// plan-0143's exact R01 numbers — v0.14.2: 98/150, v0.14.3 default: 78/150,
// v0.14.3 vscode: 150/150 (see the wave report's reproduction ledger). A
// denser multi-byte (Japanese) filler at the same nominal byte target was
// also tried and changed the server's per-response chunking enough to stop
// matching the plan's numbers exactly (the defect CLASS still reproduced —
// single-target zoom abandoning the other target — just at different
// absolute counts) — kept ASCII here so this fixture is the same one this
// module's own header/report numbers refer to.
//
// W0b UPDATE (2026-09-21, building the R01 family): re-confirming the above
// LIVE against the same v0.14.2 bundle and v0.14.3 snapshot found the
// budget=6,500-bytes / width=120 combination alone no longer reproduces
// either documented number: v0.14.2 now gives 25/150 (not 98/150) and the
// v0.14.3 snapshot now gives a FULL 150/150 at every tested width from 20 to
// 200 B (not 78/150) at that exact budget. A nearby budget (6,700-7,900 B,
// a stable plateau, confirmed by sweep) DOES reproduce the same defect
// class: v0.14.2 both configs -> 24/150; v0.14.3 default -> 79/150 (one line
// off the plan's 78/150 — expected per brief-common.md's own framing that
// reconstructed fixtures are not byte-identical to the original A/B
// comparison's); v0.14.3 vscode -> 150/150. R01's own `R01_MEMBERS` below
// therefore fixes 98/150 at width 20/55 (budget 6500, still exact) and adds
// a FOURTH member at budget 7000 for the ~78/150 number — see that
// constant's own comment for the full sweep data. The numbers this OLDER
// paragraph documents were real when written; byte-threshold sensitivity
// cuts both ways; both facts are kept here.
const LINE_FILLER = "filler text for byte padding purposes here, extra padding words follow now. ";

/** `~targetBytes` UTF-8 bytes: `<TAG>-<NNNN> ` + repeated filler. */
export function selfIdLine(tag: string, lineNum: number, targetBytes: number): string {
  const head = `${tag}-${String(lineNum).padStart(4, "0")} `;
  let line = head;
  while (Buffer.byteLength(line, "utf8") < targetBytes) line += LINE_FILLER;
  return line;
}

export function writeSelfIdFile(dir: string, relPath: string, totalLines: number, tag: string, lineBytes: number): void {
  const lines: string[] = [];
  for (let i = 1; i <= totalLines; i++) lines.push(selfIdLine(tag, i, lineBytes));
  const abs = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, lines.join("\n") + "\n", "utf8");
}

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const ELISION_MARKER_RE = /\/\* doc elided L(\d+)-(\d+) \*\/|# doc elided L(\d+)-(\d+)/g;

/**
 * Every `(tag, lineNum)` pair present ANYWHERE in a parsed JSON response,
 * for `tag` drawn ONLY from `knownTags` (see header for why this must be an
 * explicit alternation, not a generic `[A-Za-z]+` class). `elisionTag`, when
 * given, additionally credits every genuine
 * `/* doc elided La-b *\/` / `# doc elided La-b` marker's WHOLE represented
 * span to that tag — a fixture whose file is recognized source code (and so
 * can have a comment block elided) should pass its own tag here; the plain
 * `data/*.txt` fixtures below never trigger elision, so callers that only
 * ever read those may omit it.
 */
export function extractServedIds(response: unknown, knownTags: readonly string[], elisionTag?: string): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>();
  const text = JSON.stringify(response);
  if (knownTags.length > 0) {
    const marker = new RegExp(`(${knownTags.map(escapeRegExp).join("|")})-(\\d{4})\\b`, "g");
    for (const match of text.matchAll(marker)) {
      const tag = match[1]!;
      const num = Number(match[2]);
      if (!out.has(tag)) out.set(tag, new Set());
      out.get(tag)!.add(num);
    }
  }
  if (elisionTag !== undefined) {
    ELISION_MARKER_RE.lastIndex = 0;
    for (const match of text.matchAll(ELISION_MARKER_RE)) {
      const a = Number(match[1] ?? match[3]);
      const b = Number(match[2] ?? match[4]);
      if (!out.has(elisionTag)) out.set(elisionTag, new Set());
      const bucket = out.get(elisionTag)!;
      for (let i = a; i <= b; i++) bucket.add(i);
    }
  }
  return out;
}

export function idRangeSet(start: number, end: number): Set<number> {
  const out = new Set<number>();
  for (let i = start; i <= end; i++) out.add(i);
  return out;
}

export function unionInto(target: Map<string, Set<number>>, source: Map<string, Set<number>>): void {
  for (const [tag, ids] of source) {
    if (!target.has(tag)) target.set(tag, new Set());
    for (const id of ids) target.get(tag)!.add(id);
  }
}

export function missingIds(wanted: Set<number>, got: Set<number>): number[] {
  return [...wanted].filter((n) => !got.has(n)).sort((a, b) => a - b);
}

export function extraIds(got: Set<number>, wanted: Set<number>): number[] {
  return [...got].filter((n) => !wanted.has(n)).sort((a, b) => a - b);
}

/** Cumulative coverage across an entire followed chain (union of every
 *  hop's served ids — duplicates never add, per brief-w0.md). */
export function cumulativeCoverage(chain: ChainResult, knownTags: readonly string[]): Map<string, Set<number>> {
  const cumulative = new Map<string, Set<number>>();
  for (const hop of chain.hops) unionInto(cumulative, extractServedIds(hop.response, knownTags));
  return cumulative;
}

// ---------------------------------------------------------------------------
// Disclosure-text collection (Q01 / Q03 / Q04 / Q05)
//
// "Absence disclosed" is spelled at least two different ways on the wire
// (see header). This walks every hop's RESPONSE ONLY — never a `next`'s
// echoed `arguments.query`, which would otherwise make a verifier see its
// own input reflected back and mistake that for a disclosure.
// ---------------------------------------------------------------------------

function stringifyDisclosure(entry: unknown): string {
  if (typeof entry === "string") return entry;
  if (entry && typeof entry === "object") {
    const obj = entry as Record<string, unknown>;
    const parts = [obj["code"], obj["kind"], obj["id"], obj["reason"]].filter((v) => typeof v === "string");
    const refs = Array.isArray(obj["refs"]) ? (obj["refs"] as unknown[]).filter((v) => typeof v === "string") : [];
    return [...parts, ...refs].join(" ");
  }
  return "";
}

/** Every gap/unresolved-item string surfaced by ANY hop's response, from
 *  every field shape observed on the wire: `decision.certificate.gaps`
 *  (act.answer, plain strings), `decision.gaps` (discover, structured),
 *  `decision.unresolved` (await_input, structured), and the same two
 *  fields at the top level (observed defensively; not required by any
 *  confirmed response but cheap to also check). */
export function collectDisclosureTexts(chain: ChainResult): string[] {
  const out: string[] = [];
  for (const hop of chain.hops) {
    const response = hop.response;
    const sources: unknown[] = [
      pick(response, "decision.certificate.gaps"),
      pick(response, "decision.gaps"),
      pick(response, "decision.unresolved"),
      response?.["certificate"]?.["gaps"],
      response?.["unresolved"],
    ];
    for (const source of sources) {
      if (Array.isArray(source)) {
        for (const entry of source) out.push(stringifyDisclosure(entry));
      }
    }
  }
  return out.filter((s) => s.length > 0);
}

/** True iff any collected disclosure text contains one of `keywords`
 *  (case-insensitive substring — gap tokens are single salient words, see
 *  header, so substring matching on a short keyword list is the right
 *  granularity, not a stable-id equality check). */
export function anyDisclosureMatches(disclosures: readonly string[], keywords: readonly string[]): boolean {
  const lowerKeywords = keywords.map((k) => k.toLowerCase());
  return disclosures.some((text) => {
    const lower = text.toLowerCase();
    return lowerKeywords.some((k) => lower.includes(k));
  });
}

/** True iff any evidence body served across the chain contains ALL/ANY of
 *  `identifiers` (verbatim substring — these are real exported symbol
 *  names from a fixture's own source, so an exact substring match is a
 *  precise, non-fuzzy proxy for "this file's real implementation, not
 *  just its header comment, was served"). */
export function anyEvidenceContains(chain: ChainResult, identifiers: readonly string[]): boolean {
  const text = chain.hops.map((h) => JSON.stringify(h.response)).join("\n");
  return identifiers.some((id) => text.includes(id));
}

/** Every distinct `evidence[].path` served anywhere in the chain. */
export function servedEvidencePaths(chain: ChainResult): Set<string> {
  const out = new Set<string>();
  for (const hop of chain.hops) {
    const evidence = hop.response?.["evidence"];
    if (Array.isArray(evidence)) {
      for (const e of evidence) {
        if (typeof e?.path === "string") out.add(e.path);
      }
    }
  }
  return out;
}

/** The `decision.kind` of the chain's final hop, or undefined if that hop
 *  carried no `decision` at all (e.g. a bare `read.text` zoom). */
export function finalDecisionKind(chain: ChainResult): string | undefined {
  return pick(chain.final, "decision.kind");
}

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

/**
 * R01 / C01a / C01b fixture: two self-identifying data files, 200 lines
 * each. `lineBytes` controls the byte density per line — the plan asks for
 * short (~20 B) / medium (~55 B) / long (~120 B) to be tried. At the plan's
 * OWN literal budget (6,500 bytes), 120 B/line is the value CONFIRMED
 * (historically, and still true for v0.14.2) to reproduce the exact 98/150
 * / 25/150 numbers this file's fixtures target; the exact v0.14.3-default
 * 78/150 number needs a nearby-but-different budget on the CURRENT snapshot
 * build (see `R01_MEMBERS`'s own comment for the full, currently-live sweep
 * data — byte-threshold sensitivity affects budget as well as line width). A
 * shorter line length was observed to let the whole 150-line request fit in
 * two hops on EVERY build/config at budget 6,500 (no defect surfaces at
 * all) — the defect is budget-shape-dependent, not a fixed line count.
 */
export function buildRangeFixtureWorkspace(root: string, lineBytes = 120): void {
  writeSelfIdFile(root, "data/alpha.txt", 200, "alpha", lineBytes);
  writeSelfIdFile(root, "data/beta.txt", 200, "beta", lineBytes);
}

export const RANGE_FIXTURE_TAGS = ["alpha", "beta"] as const;

export const RANGE_FIXTURE_REQUEST = {
  targets: [
    { path: "data/alpha.txt", range: "11-90" },
    { path: "data/beta.txt", range: "31-100" },
  ],
  wanted: { alpha: idRangeSet(11, 90), beta: idRangeSet(31, 100) },
  totalRequestedLines: 80 + 70,
} as const;

/**
 * R01 FAMILY (brief-w0b): the plan's exact regression is byte-threshold
 * sensitive (see this module's header and the wave report) — a single fixed
 * line width proved fragile (the shipped bracket-safe marker fixture flips
 * from reproducing the regression to NOT reproducing it with a mere 2
 * bytes/line change). R01 therefore runs the SAME request/oracle across a
 * small family of members instead of pinning one shape. The scenario passes
 * only if EVERY member passes; per-member numbers are reported in the
 * verdict's metrics so a regression at one member cannot hide behind an
 * aggregate.
 *
 * TWO PITFALLS CONFIRMED LIVE while building this family (both against the
 * real v0.14.2 bundle and the real v0.14.3 snapshot — see the wave report
 * for the full sweep tables):
 *
 * 1. A subdirectory PATH PREFIX changes byte alignment too: nesting all
 *    three widths under their own subdirectory (`w20/`, `w55/`, `w120/`)
 *    dropped v0.14.2's w120 member from 98/150 down to 25/150 merely from
 *    the longer `path` strings in the request. So `w120` alone keeps the
 *    ORIGINAL fixture's own top-level paths (`data/alpha.txt`,
 *    `data/beta.txt`, no prefix) — byte-for-byte identical to the request
 *    this module's header describes as reproducing the plan's numbers.
 *
 * 2. The plan's OWN literal budget (6,500 bytes) no longer sits inside the
 *    v0.14.3-default regressing window on the CURRENT snapshot build, at
 *    ANY tested line width (20–200 B, swept densely): every one of them now
 *    fully completes (150/150) at exactly 6,500 bytes. A nearby budget
 *    (6,700–7,900 B is a STABLE plateau, not a hair-trigger) DOES reproduce
 *    it: v0.14.2 both configs -> 24/150 (not the documented 98/150 — a
 *    DIFFERENT number, same defect class: a real, non-explicit-stop partial
 *    delivery); v0.14.3 default -> 79/150 (one line off the plan's 78/150);
 *    v0.14.3 vscode -> 150/150 (matches the plan's "improves under vscode"
 *    row exactly). Per brief-common.md's own framing ("fixtures are
 *    reconstructed... a non-reproduction is most likely a fixture-shape
 *    difference"), a one-line difference from a hand-reconstructed fixture
 *    is expected, not a sign the reproduction is wrong. This member
 *    ("repro-budget7000") is therefore a DELIBERATE fourth member alongside
 *    the three fixed-budget-6500 width members, not a replacement for any
 *    of them — its own subdirectory is fine (unlike w120's) because its
 *    reproducing window is a wide, stable plateau, not byte-exact.
 */
export interface R01Member {
  id: string;
  lineBytes: number;
  budgetBytes: number;
  /** Only true for the ORIGINAL fixture's own top-level paths (see pitfall
   *  1 above) — every other member gets its own subdirectory. */
  useTopLevelPaths: boolean;
}

export const R01_MEMBERS: readonly R01Member[] = [
  { id: "w20", lineBytes: 20, budgetBytes: 6500, useTopLevelPaths: false },
  { id: "w55", lineBytes: 55, budgetBytes: 6500, useTopLevelPaths: false },
  { id: "w120", lineBytes: 120, budgetBytes: 6500, useTopLevelPaths: true },
  { id: "repro-budget7000", lineBytes: 120, budgetBytes: 7000, useTopLevelPaths: false },
];

export function buildR01FamilyWorkspace(root: string): void {
  for (const member of R01_MEMBERS) {
    if (member.useTopLevelPaths) {
      buildRangeFixtureWorkspace(root, member.lineBytes); // native top-level paths, unchanged
    } else {
      buildRangeFixtureWorkspace(path.join(root, member.id), member.lineBytes);
    }
  }
}

function r01TargetsFor(member: R01Member): ReadonlyArray<{ path: string; range: string }> {
  if (member.useTopLevelPaths) return RANGE_FIXTURE_REQUEST.targets;
  return RANGE_FIXTURE_REQUEST.targets.map((t) => ({ ...t, path: `${member.id}/${t.path}` }));
}

/** C02a fixture: one small file whose whole body fits comfortably in a
 *  single response (no continuation involved — this scenario is about
 *  receipt/force_serve/allowFull semantics, not pagination). */
export function buildSmallFileWorkspace(root: string): void {
  const lines: string[] = [];
  for (let i = 1; i <= 30; i++) lines.push(`small-${String(i).padStart(3, "0")} some content line for receipt-behaviour purposes here padding.`);
  fs.writeFileSync(path.join(root, "small.txt"), lines.join("\n") + "\n", "utf8");
}

/**
 * Q01 / Q04 fixture: a REAL credential-validation implementation, split
 * across three files (`validateCredentials`, `lookupStoredCredential`,
 * `hashWithSalt`/`constantTimeEqual`) with NO database-migration code
 * anywhere in the workspace. Neutral, generic identifiers — no fixture- or
 * plan-specific string is ever read by product code, only by this file's
 * own verdict functions (allowed: rule 5 is about product code, not test
 * oracles).
 */
export function buildCredentialsWorkspace(root: string): void {
  fs.mkdirSync(path.join(root, "src", "auth"), { recursive: true });
  fs.mkdirSync(path.join(root, "src", "util"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "src", "auth", "credentials.ts"),
    [
      "// credentials.ts — validates user-supplied login credentials against the",
      "// stored, salted password hash.",
      'import { hashWithSalt, constantTimeEqual } from "../util/crypto.js";',
      'import { lookupStoredCredential } from "./store.js";',
      "",
      "export interface CredentialCheckResult {",
      "  ok: boolean;",
      '  reason?: "unknown-user" | "bad-password";',
      "}",
      "",
      "/**",
      " * Validate a plaintext password against the stored salted hash for",
      " * `username`. Looks up the stored record, recomputes the salted hash of",
      " * the supplied password with the SAME salt, and compares the two hashes",
      " * using a constant-time comparison to avoid timing side channels.",
      " */",
      "export function validateCredentials(username: string, password: string): CredentialCheckResult {",
      "  const stored = lookupStoredCredential(username);",
      "  if (!stored) {",
      '    return { ok: false, reason: "unknown-user" };',
      "  }",
      "  const candidateHash = hashWithSalt(password, stored.salt);",
      "  const matches = constantTimeEqual(candidateHash, stored.hash);",
      '  return matches ? { ok: true } : { ok: false, reason: "bad-password" };',
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  fs.writeFileSync(
    path.join(root, "src", "auth", "store.ts"),
    [
      "// store.ts — in-memory stand-in for the credential store used by",
      "// credentials.ts. Real deployments back this with a users table, but no",
      "// migration/DDL code lives in this fixture.",
      "export interface StoredCredential {",
      "  salt: string;",
      "  hash: string;",
      "}",
      "",
      'const RECORDS = new Map<string, StoredCredential>([',
      '  ["alice", { salt: "s1", hash: "deadbeefcafef00d" }],',
      "]);",
      "",
      "export function lookupStoredCredential(username: string): StoredCredential | undefined {",
      "  return RECORDS.get(username);",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  fs.writeFileSync(
    path.join(root, "src", "util", "crypto.ts"),
    [
      "// crypto.ts — small hashing/comparison helpers used by credential validation.",
      'import { createHash, timingSafeEqual } from "node:crypto";',
      "",
      "export function hashWithSalt(value: string, salt: string): string {",
      '  return createHash("sha256").update(salt).update(value).digest("hex");',
      "}",
      "",
      "export function constantTimeEqual(a: string, b: string): boolean {",
      '  const bufA = Buffer.from(a, "utf8");',
      '  const bufB = Buffer.from(b, "utf8");',
      "  if (bufA.length !== bufB.length) return false;",
      "  return timingSafeEqual(bufA, bufB);",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "q01-fixture", version: "0.0.0", private: true }, null, 2) + "\n", "utf8");
  fs.writeFileSync(
    path.join(root, "README.md"),
    "# Q01 fixture\n\nA small workspace with a real credential-validation implementation\n"
      + "(`src/auth/credentials.ts`, `src/auth/store.ts`, `src/util/crypto.ts`).\n"
      + "This fixture intentionally contains no other subsystem's implementation.\n",
    "utf8",
  );
}

/** Every exported symbol across the credentials fixture's three files —
 *  "auth evidence served" means ANY of these appears in a served body
 *  (broad enough to tolerate the router picking a different-but-related
 *  file of the same subsystem; observed to happen between otherwise
 *  identical runs — see the wave report). */
export const CREDENTIALS_SYMBOLS = ["validateCredentials", "lookupStoredCredential", "hashWithSalt", "constantTimeEqual"] as const;

/** Keywords whose presence in a disclosure (never in served evidence) marks
 *  the migration concern as acknowledged (absent-and-said-so, or
 *  unresolved) rather than silently dropped. */
export const MIGRATION_DISCLOSURE_KEYWORDS = ["migrat", "database", "データベース", "マイグレーション"] as const;

/**
 * Q03 fixture: one cache module with BOTH TTL-based lazy expiry (`get`) and
 * explicit invalidation (`invalidate`/`invalidateAll`) — both concerns a
 * compound question can ask about are genuinely implemented in ONE file.
 */
export function buildCacheWorkspace(root: string): void {
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "src", "cache.ts"),
    [
      "// cache.ts — a small in-memory cache with TTL-based expiry and explicit",
      "// invalidation.",
      "interface CacheRecord<V> {",
      "  value: V;",
      "  expiresAtMs: number;",
      "}",
      "",
      "export class TtlCache<V> {",
      "  private records = new Map<string, CacheRecord<V>>();",
      "",
      "  constructor(private readonly defaultTtlMs: number) {}",
      "",
      "  /** Store `value` for `key`, expiring it after `ttlMs` (or the default). */",
      "  set(key: string, value: V, ttlMs?: number): void {",
      "    const expiresAtMs = Date.now() + (ttlMs ?? this.defaultTtlMs);",
      "    this.records.set(key, { value, expiresAtMs });",
      "  }",
      "",
      "  /**",
      "   * Return the cached value for `key`, or undefined when it is missing or",
      "   * has expired. An expired record is removed from the map as a side",
      "   * effect of this check (lazy expiry: expired entries are handled here",
      "   * rather than through a background sweep).",
      "   */",
      "  get(key: string): V | undefined {",
      "    const record = this.records.get(key);",
      "    if (!record) return undefined;",
      "    if (Date.now() >= record.expiresAtMs) {",
      "      this.records.delete(key);",
      "      return undefined;",
      "    }",
      "    return record.value;",
      "  }",
      "",
      "  /**",
      "   * Explicitly remove `key` from the cache regardless of whether it has",
      "   * expired yet. Callers use this to force a fresh lookup on the next",
      "   * `get`/`set` cycle.",
      "   */",
      "  invalidate(key: string): void {",
      "    this.records.delete(key);",
      "  }",
      "",
      "  /** Remove every cached entry. */",
      "  invalidateAll(): void {",
      "    this.records.clear();",
      "  }",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "q03-fixture", version: "0.0.0", private: true }, null, 2) + "\n", "utf8");
  fs.writeFileSync(
    root + "/README.md",
    "# Q03 fixture\n\nA single cache module (`src/cache.ts`) with TTL-based lazy expiry\n"
      + "(`get()`) and explicit invalidation (`invalidate()`/`invalidateAll()`).\n",
    "utf8",
  );
}

export const CACHE_EXPIRY_KEYWORDS = ["expir", "ttl", "期限切れ", "expired"] as const;
export const CACHE_INVALIDATE_KEYWORDS = ["invalidat", "無効化"] as const;
/** Real evidence markers proving each concern's OWN body (not just the
 *  file header) was served. */
export const CACHE_EXPIRY_EVIDENCE = ["expiresAtMs", "get(key"] as const;
export const CACHE_INVALIDATE_EVIDENCE = ["invalidate(key", "invalidateAll("] as const;

/**
 * Q05 fixture: four small modules hold the evidence for a four-concern
 * compound question (authentication, cache expiry, retry scheduling,
 * request-timeout configuration), plus realistic noise (README,
 * package.json, two unrelated helper modules) a correct answer must not
 * substitute in place of a missing real concern.
 */
export function buildFourConcernWorkspace(root: string): void {
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  const write = (rel: string, content: string): void => fs.writeFileSync(path.join(root, rel), content, "utf8");

  write(
    "src/auth.ts",
    [
      "// auth.ts — authenticates a request by validating a bearer token against",
      "// the configured signing secret.",
      'import { verifySignature } from "./crypto-helpers.js";',
      "",
      "export interface AuthResult {",
      "  authenticated: boolean;",
      "  subject?: string;",
      "}",
      "",
      '/** Authenticate `token` (a "<subject>.<signature>" bearer token). */',
      "export function authenticateRequest(token: string, signingSecret: string): AuthResult {",
      '  const [subject, signature] = token.split(".", 2);',
      "  if (!subject || !signature) return { authenticated: false };",
      "  const expected = verifySignature(subject, signingSecret);",
      "  return expected === signature ? { authenticated: true, subject } : { authenticated: false };",
      "}",
      "",
    ].join("\n"),
  );
  write(
    "src/crypto-helpers.ts",
    [
      "// crypto-helpers.ts — small signature helper used by auth.ts.",
      'import { createHmac } from "node:crypto";',
      "",
      "export function verifySignature(subject: string, signingSecret: string): string {",
      '  return createHmac("sha256", signingSecret).update(subject).digest("hex").slice(0, 16);',
      "}",
      "",
    ].join("\n"),
  );
  write(
    "src/cache.ts",
    [
      "// cache.ts — small TTL cache used to avoid recomputing expensive lookups.",
      "interface Entry<V> { value: V; expiresAtMs: number; }",
      "",
      "export class TtlCache<V> {",
      "  private entries = new Map<string, Entry<V>>();",
      "  constructor(private readonly ttlMs: number) {}",
      "",
      "  set(key: string, value: V): void {",
      "    this.entries.set(key, { value, expiresAtMs: Date.now() + this.ttlMs });",
      "  }",
      "",
      "  /** Returns the cached value, evicting it first if its TTL has elapsed. */",
      "  get(key: string): V | undefined {",
      "    const entry = this.entries.get(key);",
      "    if (!entry) return undefined;",
      "    if (Date.now() >= entry.expiresAtMs) {",
      "      this.entries.delete(key);",
      "      return undefined;",
      "    }",
      "    return entry.value;",
      "  }",
      "}",
      "",
    ].join("\n"),
  );
  write(
    "src/retry.ts",
    [
      "// retry.ts — schedules retry attempts for a failing operation using",
      "// exponential backoff with a cap.",
      "export interface RetryPolicy {",
      "  maxAttempts: number;",
      "  baseDelayMs: number;",
      "  maxDelayMs: number;",
      "}",
      "",
      "/** Compute the delay (ms) before retry attempt number `attempt` (1-based). */",
      "export function computeRetryDelayMs(policy: RetryPolicy, attempt: number): number {",
      "  const exponential = policy.baseDelayMs * Math.pow(2, attempt - 1);",
      "  return Math.min(exponential, policy.maxDelayMs);",
      "}",
      "",
      "/** Whether another retry attempt should be scheduled at all. */",
      "export function shouldScheduleRetry(policy: RetryPolicy, attemptsSoFar: number): boolean {",
      "  return attemptsSoFar < policy.maxAttempts;",
      "}",
      "",
    ].join("\n"),
  );
  write(
    "src/requestTimeout.ts",
    [
      "// requestTimeout.ts — resolves the timeout (ms) to apply to an outbound",
      "// request, honoring a per-call override before falling back to config.",
      "export interface TimeoutConfig {",
      "  defaultTimeoutMs: number;",
      "  minTimeoutMs: number;",
      "  maxTimeoutMs: number;",
      "}",
      "",
      "/** Clamp `requestedMs` (or the default) into [minTimeoutMs, maxTimeoutMs]. */",
      "export function resolveRequestTimeoutMs(config: TimeoutConfig, requestedMs?: number): number {",
      "  const candidate = requestedMs ?? config.defaultTimeoutMs;",
      "  return Math.min(Math.max(candidate, config.minTimeoutMs), config.maxTimeoutMs);",
      "}",
      "",
    ].join("\n"),
  );
  // Noise: unrelated modules + typical repo furniture a correct answer
  // must not substitute in place of a missing real concern.
  write(
    "src/formatter.ts",
    [
      "// formatter.ts — unrelated helper: formats byte counts for display.",
      "export function formatBytes(n: number): string {",
      '  if (n < 1024) return `${n} B`;',
      '  const units = ["KB", "MB", "GB"];',
      "  let value = n / 1024;",
      "  let unitIndex = 0;",
      "  while (value >= 1024 && unitIndex < units.length - 1) {",
      "    value /= 1024;",
      "    unitIndex++;",
      "  }",
      "  return `${value.toFixed(1)} ${units[unitIndex]}`;",
      "}",
      "",
    ].join("\n"),
  );
  write(
    "src/logger.ts",
    [
      "// logger.ts — unrelated helper: a minimal leveled logger.",
      'type Level = "debug" | "info" | "warn" | "error";',
      "export function log(level: Level, message: string): void {",
      "  // eslint-disable-next-line no-console",
      "  console.log(`[${level}] ${message}`);",
      "}",
      "",
    ].join("\n"),
  );
  write("package.json", JSON.stringify({ name: "q05-fixture", version: "0.0.0", private: true }, null, 2) + "\n");
  write(
    "README.md",
    "# Q05 fixture\n\nFour small modules hold the evidence for this scenario's compound\n"
      + "question: authentication (`src/auth.ts` + `src/crypto-helpers.ts`),\n"
      + "cache expiry (`src/cache.ts`), retry scheduling (`src/retry.ts`), and\n"
      + "request-timeout configuration (`src/requestTimeout.ts`). `src/formatter.ts`\n"
      + "and `src/logger.ts` are unrelated noise.\n",
  );
}

export const FOUR_CONCERN_EVIDENCE: Readonly<Record<string, readonly string[]>> = {
  auth: ["authenticateRequest"],
  cache: ["TtlCache", "expiresAtMs"],
  retry: ["computeRetryDelayMs", "shouldScheduleRetry"],
  timeout: ["resolveRequestTimeoutMs"],
};
export const FOUR_CONCERN_NOISE_PATHS = ["README.md", "package.json", "src/formatter.ts", "src/logger.ts"] as const;

// ---------------------------------------------------------------------------
// Misc utilities shared by the spec and the CLI evaluator
// ---------------------------------------------------------------------------

export function sha256File(filePath: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

// ---------------------------------------------------------------------------
// Scenario framework
// ---------------------------------------------------------------------------

export interface ScenarioVerdict {
  pass: boolean;
  reason: string;
  metrics: Record<string, unknown>;
}

export interface ScenarioContext {
  server: ServerHandle;
  ws: string;
  /**
   * Kills the CURRENT server and starts a fresh one against the SAME
   * workspace, config and build, returning the new handle (S01: "a server
   * RESTART mid-chain"). Both callers of this framework wire this to the
   * right build (`startDevServer` in the acceptance spec, `startDevServer`/
   * `startCliServer` in the CLI evaluator) so a scenario never has to know
   * which build it is running against. A scenario that needs this but finds
   * it `undefined` must treat restart-testing as inconclusive (pass, not
   * fail) rather than throw — defensive only; both current callers provide it.
   */
  restartServer?(): Promise<ServerHandle>;
  /**
   * Starts an ADDITIONAL server against the same build/config/workspace as
   * `ctx.server`, but with its own `--allow-write` setting — for a scenario
   * whose members need DIFFERENT write-modes in one run (evaluation0927
   * V10: one member must observe a READ-ONLY server's `write-not-enabled`
   * refusal even though the scenario's other members need a writable
   * `ctx.server`). The caller kills the returned handle itself; it is not
   * tracked by `ctx.restartServer`. Optional, same convention as
   * `restartServer`: a scenario that needs this but finds it `undefined`
   * must treat that ONE member as inconclusive (pass, not fail), never throw.
   * `toolSurface` (optional) overrides the advertised surface for that one
   * server (evaluation0927 V09 measures `tools/list` for BOTH surfaces).
   */
  startServerWithWrite?(allowWrite: boolean, toolSurface?: "code" | "full"): Promise<ServerHandle>;
}

export interface Scenario {
  id: string;
  planItem: string;
  summary: string;
  /** True iff this scenario calls `edit_file` and needs the server started
   *  with `--allow-write` (E01). Both callers must start the server for this
   *  scenario accordingly; every other scenario is read-only by default. */
  needsWrite?: boolean;
  buildWorkspace(root: string): void;
  run(ctx: ScenarioContext): Promise<ScenarioVerdict>;
}

/** A plan §10 acceptance-table row this harness does NOT automate (H01: real
 *  host install/reconnect needs an actual VS Code/Copilot client, not a
 *  spawned stdio server). Listed here — separately from `SCENARIOS` — purely
 *  so the table has a documented placeholder instead of a silent omission;
 *  neither caller executes or counts these toward pass/fail (brief-w0b:
 *  "never counted as pass"). */
export interface ManualScenario {
  id: string;
  planItem: string;
  summary: string;
  manual: true;
}

export const MANUAL_SCENARIOS: readonly ManualScenario[] = [
  {
    id: "H01",
    planItem: "H01",
    summary:
      "Real host install/reconnect/re-setup (VS Code/Copilot, an actual client) — out of scope for a "
      + "spawned-stdio-server harness. Verify by hand: install onto a real host, confirm the three "
      + "advertised tools are reachable, reconnect/re-setup, confirm state survives. See plan §10 H01.",
    manual: true,
  },
];

// --- R01 (TL-01): delivered-range completeness, across a line-width family -

async function runR01Member(ctx: ScenarioContext, member: R01Member): Promise<Record<string, unknown> & { pass: boolean }> {
  const chain = await followNextToEnd(
    ctx.server,
    {
      tool: "read_file",
      arguments: {
        targets: r01TargetsFor(member),
        content: "auto",
        budget: { bytes: member.budgetBytes },
        task: { epoch: "new" },
        cwd: ctx.ws,
      },
    },
    { cwd: ctx.ws },
  );
  const coverage = cumulativeCoverage(chain, RANGE_FIXTURE_TAGS);
  const alphaGot = coverage.get("alpha") ?? new Set<number>();
  const betaGot = coverage.get("beta") ?? new Set<number>();
  const missingAlpha = missingIds(RANGE_FIXTURE_REQUEST.wanted.alpha, alphaGot);
  const missingBeta = missingIds(RANGE_FIXTURE_REQUEST.wanted.beta, betaGot);
  const extraAlpha = extraIds(alphaGot, RANGE_FIXTURE_REQUEST.wanted.alpha);
  const extraBeta = extraIds(betaGot, RANGE_FIXTURE_REQUEST.wanted.beta);
  const deliveredLines = RANGE_FIXTURE_REQUEST.totalRequestedLines - missingAlpha.length - missingBeta.length;
  const hasRefusal = chain.hops.some((h) => (h.response as Record<string, unknown> | null | undefined)?.["kind"] === "refusal");
  const pass = missingAlpha.length === 0 && missingBeta.length === 0 && extraAlpha.length === 0 && extraBeta.length === 0 && !chain.capped && !hasRefusal;
  return {
    pass,
    variant: member.id,
    budgetBytes: member.budgetBytes,
    deliveredLines,
    totalRequestedLines: RANGE_FIXTURE_REQUEST.totalRequestedLines,
    missingAlpha: missingAlpha.length,
    missingBeta: missingBeta.length,
    extraAlpha: extraAlpha.length,
    extraBeta: extraBeta.length,
    hops: chain.hops.length,
    capped: chain.capped,
    refusal: hasRefusal,
  };
}

async function runR01(ctx: ScenarioContext): Promise<ScenarioVerdict> {
  const members: Array<Record<string, unknown> & { pass: boolean }> = [];
  for (const member of R01_MEMBERS) {
    members.push(await runR01Member(ctx, member));
  }
  const pass = members.every((m) => m.pass);
  return {
    pass,
    reason: pass
      ? `every line-width member delivered all ${RANGE_FIXTURE_REQUEST.totalRequestedLines} requested lines cleanly (${members.map((m) => `${String(m["variant"])}=${String(m["deliveredLines"])}/${String(m["totalRequestedLines"])}`).join(", ")})`
      : `failing member(s): ${members
          .filter((m) => !m.pass)
          .map(
            (m) =>
              `${String(m["variant"])} (${String(m["deliveredLines"])}/${String(m["totalRequestedLines"])}, missingAlpha=${String(m["missingAlpha"])}, missingBeta=${String(m["missingBeta"])}, extraAlpha=${String(m["extraAlpha"])}, extraBeta=${String(m["extraBeta"])}, capped=${String(m["capped"])}, refusal=${String(m["refusal"])})`,
          )
          .join(" | ")}`,
    metrics: { members },
  };
}

// --- R02 (TL-01): 1/2/3-file delivery across order/width/budget variants ---
//
// Deliberately hand-authored (fixed), not seeded-random: `rangedDelivery
// Completeness.spec.ts` (product spec, read-only reference) already runs a
// seeded fuzz matrix (mulberry32) over this exact concern at the product
// level; duplicating that depth here would only add runtime, not signal, at
// the ACCEPTANCE layer this file operates at. Every member's requested range
// ends AT the file's true EOF (200) — never within 40 lines of EOF without
// reaching it — to sidestep `TL_FOLD_SMALL_REMAINDER` (default ON under
// vscode; sanctioned small-EOF-remainder widening, not a defect) so this
// scenario cannot spuriously fail under the vscode config for an unrelated,
// already-accepted reason.

function buildR02Workspace(root: string): void {
  writeSelfIdFile(root, "m1/one.txt", 200, "one", 120);
  writeSelfIdFile(root, "m2/two.txt", 200, "two", 20);
  writeSelfIdFile(root, "m2/three.txt", 200, "three", 20);
  writeSelfIdFile(root, "m3/four.txt", 200, "four", 120);
  writeSelfIdFile(root, "m3/five.txt", 200, "five", 120);
  writeSelfIdFile(root, "m3/six.txt", 200, "six", 120);
  writeSelfIdFile(root, "m4/seven.txt", 200, "seven", 20);
  writeSelfIdFile(root, "m4/eight.txt", 200, "eight", 20);
}

interface R02Member {
  id: string;
  budgetBytes: number;
  targets: ReadonlyArray<{ path: string; range: string }>;
  tags: readonly string[];
  wanted: Readonly<Record<string, readonly [number, number]>>;
}

// Budgets {6144, 6500, 12000} per plan §10 R02; 6144 is CONFIRMED (see the
// wave report) to be the server's own budget-below-minimum floor for a
// 2-path batch — used here deliberately to exercise the floor, not avoid it.
const R02_MEMBERS: readonly R02Member[] = [
  {
    id: "1file-long-6144",
    budgetBytes: 6144,
    targets: [{ path: "m1/one.txt", range: "101-200" }],
    tags: ["one"],
    wanted: { one: [101, 200] },
  },
  {
    id: "2file-reversed-order-short-6500",
    budgetBytes: 6500,
    // reversed order: the SECOND file's target listed before the first's.
    targets: [
      { path: "m2/three.txt", range: "121-200" },
      { path: "m2/two.txt", range: "151-200" },
    ],
    tags: ["two", "three"],
    wanted: { two: [151, 200], three: [121, 200] },
  },
  {
    id: "3file-scrambled-order-long-12000",
    budgetBytes: 12000,
    // scrambled order: six, four, five (not the natural four/five/six).
    targets: [
      { path: "m3/six.txt", range: "171-200" },
      { path: "m3/four.txt", range: "171-200" },
      { path: "m3/five.txt", range: "171-200" },
    ],
    tags: ["four", "five", "six"],
    wanted: { four: [171, 200], five: [171, 200], six: [171, 200] },
  },
  {
    id: "2file-natural-order-short-12000",
    budgetBytes: 12000,
    targets: [
      { path: "m4/seven.txt", range: "141-200" },
      { path: "m4/eight.txt", range: "141-200" },
    ],
    tags: ["seven", "eight"],
    wanted: { seven: [141, 200], eight: [141, 200] },
  },
];

async function runR02(ctx: ScenarioContext): Promise<ScenarioVerdict> {
  const members: Array<Record<string, unknown>> = [];
  for (const member of R02_MEMBERS) {
    const chain = await followNextToEnd(
      ctx.server,
      {
        tool: "read_file",
        arguments: { targets: member.targets, content: "auto", budget: { bytes: member.budgetBytes }, task: { epoch: "new" }, cwd: ctx.ws },
      },
      { cwd: ctx.ws },
    );
    const coverage = cumulativeCoverage(chain, member.tags);
    let missing = 0;
    let extra = 0;
    const perTag: Record<string, unknown> = {};
    for (const [tag, [start, end]] of Object.entries(member.wanted)) {
      const wanted = idRangeSet(start, end);
      const got = coverage.get(tag) ?? new Set<number>();
      const m = missingIds(wanted, got);
      const e = extraIds(got, wanted);
      missing += m.length;
      extra += e.length;
      perTag[tag] = { missing: m.length, extra: e.length };
    }
    // "whatever is not delivered stays in an executable next or an explicit
    // stop; chain end => all requested lines delivered" (brief-w0b R02).
    const explicitStop = isExplicitStop(chain.final);
    const pass = extra === 0 && (missing === 0 || (explicitStop && !chain.capped));
    members.push({ id: member.id, pass, missing, extra, explicitStop, capped: chain.capped, hops: chain.hops.length, perTag });
  }
  const pass = members.every((m) => m["pass"] === true);
  return {
    pass,
    reason: pass
      ? "every R02 member delivered fully, or stopped with an explicit, honest reason -- never a silent drop"
      : `failing members: ${JSON.stringify(members.filter((m) => !m["pass"]))}`,
    metrics: { members },
  };
}

// --- R03 (TL-01): adjacent + overlapping ranges, a mid-chain retry, last page

function buildR03Workspace(root: string): void {
  writeSelfIdFile(root, "gamma.txt", 200, "gamma", 80);
  writeSelfIdFile(root, "delta.txt", 200, "delta", 80);
  writeSelfIdFile(root, "epsilon.txt", 200, "epsilon", 80);
}

async function runR03(ctx: ScenarioContext): Promise<ScenarioVerdict> {
  const firstCall: ToolCallShape = {
    tool: "read_file",
    arguments: {
      targets: [
        { path: "gamma.txt", range: "61-110" }, // overlaps the next gamma range at 90-110
        { path: "gamma.txt", range: "90-150" },
        { path: "delta.txt", range: "1-75" }, // adjacent to the next delta range, no overlap
        { path: "delta.txt", range: "76-150" },
        { path: "epsilon.txt", range: "181-200" }, // the last page: ends exactly at true EOF
      ],
      content: "auto",
      budget: { bytes: 9000 },
      task: { epoch: "new" },
      cwd: ctx.ws,
    },
  };
  const first = await ctx.server.callTool(firstCall.tool, firstCall.arguments);

  // A retry of the SAME call, mid-chain (before the rest of the chain is
  // followed): must not corrupt server state or the eventual delivery.
  let retryError: string | undefined;
  let retryKind: unknown;
  try {
    const retry = await ctx.server.callTool(firstCall.tool, firstCall.arguments);
    retryKind = (retry.body as Record<string, unknown> | null)?.["kind"];
  } catch (err) {
    retryError = err instanceof Error ? err.message : String(err);
  }

  const { next } = extractNext(first.body);
  const rest = next ? await walkHops(ctx.server, next, 14) : { responses: [], capped: false };
  const all = [first.body, ...rest.responses];
  const coverage = new Map<string, Set<number>>();
  for (const r of all) unionInto(coverage, extractServedIds(r, ["gamma", "delta", "epsilon"]));

  const wanted = { gamma: idRangeSet(61, 150), delta: idRangeSet(1, 150), epsilon: idRangeSet(181, 200) };
  const missing = {
    gamma: missingIds(wanted.gamma, coverage.get("gamma") ?? new Set()),
    delta: missingIds(wanted.delta, coverage.get("delta") ?? new Set()),
    epsilon: missingIds(wanted.epsilon, coverage.get("epsilon") ?? new Set()),
  };
  const extra = {
    gamma: extraIds(coverage.get("gamma") ?? new Set(), wanted.gamma),
    delta: extraIds(coverage.get("delta") ?? new Set(), wanted.delta),
    epsilon: extraIds(coverage.get("epsilon") ?? new Set(), wanted.epsilon),
  };
  const totalMissing = missing.gamma.length + missing.delta.length + missing.epsilon.length;
  const totalExtra = extra.gamma.length + extra.delta.length + extra.epsilon.length;
  // "duplicates never count twice; an honest read.receipt for already-served
  // lines is fine" (brief-w0b R03): the retry only needs to not error and
  // not be a hard refusal -- a receipt, or a fresh re-serve, are both fine.
  const retryOk = retryError === undefined && retryKind !== "refusal";
  const pass = retryOk && totalMissing === 0 && totalExtra === 0 && !rest.capped;
  return {
    pass,
    reason: pass
      ? "overlapping + adjacent ranges and the true-EOF last page all covered by the line SET; a mid-chain retry of the same call caused no corruption"
      : `retryOk=${retryOk} retryError=${String(retryError)} retryKind=${String(retryKind)} totalMissing=${totalMissing} totalExtra=${totalExtra} capped=${rest.capped} missing=${JSON.stringify(missing)} extra=${JSON.stringify(extra)}`,
    metrics: { retryOk, retryKind, totalMissing, totalExtra, capped: rest.capped, missing, extra, hops: all.length },
  };
}

// --- R04 (TL-01/TL-06): file changes mid-chain; a stale/garbled cursor -----
//
// Four members, each isolated in its own subdirectory so one mutation never
// touches another member's files.

function buildR04Workspace(root: string): void {
  writeSelfIdFile(root, "append/data.txt", 200, "rfour", 120);
  writeSelfIdFile(root, "rewrite/data.txt", 200, "rfourrw1", 120);
  writeSelfIdFile(root, "garbled/data.txt", 200, "rfourg", 120);
  writeSelfIdFile(root, "mix/alpha.txt", 200, "rfourmixold", 120);
  writeSelfIdFile(root, "mix/beta.txt", 200, "rfourmixbeta", 120);
}

interface R04MemberResult {
  pass: boolean;
  reason: string;
  metrics: Record<string, unknown>;
}

/** Member 1: appending past the requested window. Appending never changes
 *  the BYTES of the already-requested range, so either a conservative
 *  refusal-with-recovery OR a plain full completion are both legitimate;
 *  only a broken/capped chain is not. */
async function runR04Append(ctx: ScenarioContext): Promise<R04MemberResult> {
  const relPath = "append/data.txt";
  const first = await ctx.server.callTool("read_file", {
    targets: [{ path: relPath, range: "1-150" }],
    content: "auto",
    budget: { bytes: 3000 },
    task: { epoch: "new" },
    cwd: ctx.ws,
  });
  const { next } = extractNext(first.body);
  if (!next) return { pass: true, reason: "completed in one hop; nothing to mutate mid-chain", metrics: {} };

  fs.appendFileSync(path.join(ctx.ws, relPath), "rfour-9999 appended tail line for the R04 append case.\n");
  const second = await ctx.server.callTool(next.tool, next.arguments);
  if ((second.body as Record<string, unknown>)?.["kind"] === "refusal") {
    const body = second.body as Record<string, unknown>;
    const hasRecovery = typeof body["retry"] === "string";
    return { pass: hasRecovery, reason: `append mutation -> refusal(code=${String(body["code"])}), recovery=${hasRecovery}`, metrics: { code: body["code"], retry: body["retry"] } };
  }
  const restNext = extractNext(second.body).next;
  const rest = restNext ? await walkHops(ctx.server, restNext, 10) : { responses: [], capped: false };
  const all = [first.body, second.body, ...rest.responses];
  const coverage = new Map<string, Set<number>>();
  for (const r of all) unionInto(coverage, extractServedIds(r, ["rfour"]));
  const got = coverage.get("rfour") ?? new Set<number>();
  const missing = missingIds(idRangeSet(1, 150), got);
  const pass = missing.length === 0 && !rest.capped;
  return {
    pass,
    reason: pass ? "append tolerated; the full 1-150 range was still delivered" : `missing=${missing.length} capped=${rest.capped}`,
    metrics: { missing: missing.length, capped: rest.capped, hops: all.length },
  };
}

/** Member 2: rewriting the WHOLE file (every line, new tag) mid-chain. Any
 *  hop after the mutation serving content tagged with the OLD (no-longer-
 *  true) tag WITHIN the requested range, while the chain overall reports a
 *  clean, non-refused, non-capped finish, is exactly the forbidden case:
 *  "a clean completion that mixes old and new bodies." */
async function runR04Rewrite(ctx: ScenarioContext): Promise<R04MemberResult> {
  const relPath = "rewrite/data.txt";
  const first = await ctx.server.callTool("read_file", {
    targets: [{ path: relPath, range: "1-150" }],
    content: "auto",
    budget: { bytes: 3000 },
    task: { epoch: "new" },
    cwd: ctx.ws,
  });
  const { next } = extractNext(first.body);
  if (!next) return { pass: true, reason: "completed in one hop; nothing to mutate mid-chain", metrics: {} };

  writeSelfIdFile(ctx.ws, relPath, 200, "rfourrw2", 120);
  const second = await ctx.server.callTool(next.tool, next.arguments);
  if ((second.body as Record<string, unknown>)?.["kind"] === "refusal") {
    const body = second.body as Record<string, unknown>;
    const hasRecovery = typeof body["retry"] === "string";
    return { pass: hasRecovery, reason: `rewrite mutation -> refusal(code=${String(body["code"])}), recovery=${hasRecovery}`, metrics: { code: body["code"], retry: body["retry"] } };
  }
  const restNext = extractNext(second.body).next;
  const rest = restNext ? await walkHops(ctx.server, restNext, 10) : { responses: [], capped: false };
  const all = [first.body, second.body, ...rest.responses];
  const coverage = new Map<string, Set<number>>();
  for (const r of all) unionInto(coverage, extractServedIds(r, ["rfourrw1", "rfourrw2"]));
  const oldInRange = [...(coverage.get("rfourrw1") ?? new Set<number>())].filter((n) => n >= 1 && n <= 150);
  const newInRange = [...(coverage.get("rfourrw2") ?? new Set<number>())].filter((n) => n >= 1 && n <= 150);
  const mixed = oldInRange.length > 0 && newInRange.length > 0;
  const endedCleanly = !rest.capped && !all.some((r) => (r as Record<string, unknown> | null)?.["kind"] === "refusal");
  const pass = !(mixed && endedCleanly);
  return {
    pass,
    reason: pass
      ? `no forbidden mixing (oldInRange=${oldInRange.length} newInRange=${newInRange.length} endedCleanly=${endedCleanly})`
      : `MIXED old+new bytes within one claimed-clean completion: oldInRange=${oldInRange.length} newInRange=${newInRange.length}`,
    metrics: { oldInRange: oldInRange.length, newInRange: newInRange.length, endedCleanly, capped: rest.capped },
  };
}

/** Member 3: a deliberately corrupted (not merely stale) cursor. Must refuse
 *  gracefully, and a fresh restart of the ORIGINAL request afterward must
 *  still work -- proving the corrupt attempt left no server-side damage. */
async function runR04GarbledCursor(ctx: ScenarioContext): Promise<R04MemberResult> {
  const relPath = "garbled/data.txt";
  const first = await ctx.server.callTool("read_file", {
    targets: [{ path: relPath, range: "1-150" }],
    content: "auto",
    budget: { bytes: 3000 },
    task: { epoch: "new" },
    cwd: ctx.ws,
  });
  const { next } = extractNext(first.body);
  const cursor = next ? (next.arguments as Record<string, unknown>)["cursor"] : undefined;
  if (!next || typeof cursor !== "string") {
    return { pass: true, reason: "no cursor-based continuation to corrupt (completed in one hop, or used a different continuation shape)", metrics: {} };
  }
  const garbledArgs = { ...next.arguments, cursor: cursor.slice(0, -8) + "GARBLED0" };
  const garbled = await ctx.server.callTool(next.tool, garbledArgs);
  const garbledBody = garbled.body as Record<string, unknown>;
  const isGracefulRefusal = garbledBody["kind"] === "refusal" && typeof garbledBody["retry"] === "string";

  const restart = await ctx.server.callTool("read_file", {
    targets: [{ path: relPath, range: "1-150" }],
    content: "auto",
    budget: { bytes: 3000 },
    task: { epoch: "new" },
    cwd: ctx.ws,
  });
  const restartOk = (restart.body as Record<string, unknown>)?.["kind"] !== "refusal";
  const pass = isGracefulRefusal && restartOk;
  return {
    pass,
    reason: pass ? "garbled cursor refused gracefully; a fresh restart of the original request still works" : `garbledKind=${String(garbledBody["kind"])} garbledCode=${String(garbledBody["code"])} restartKind=${String((restart.body as Record<string, unknown>)?.["kind"])}`,
    metrics: { garbledKind: garbledBody["kind"], garbledCode: garbledBody["code"], restartKind: (restart.body as Record<string, unknown>)?.["kind"] },
  };
}

/** Member 4: a MULTI-target (decision/handle-based, not cursor-based)
 *  continuation, mutating only ONE of the two targets mid-chain. Same
 *  "no mixing within a clean completion" oracle as the rewrite member. */
async function runR04MultiTargetMix(ctx: ScenarioContext): Promise<R04MemberResult> {
  const alphaPath = "mix/alpha.txt";
  const betaPath = "mix/beta.txt";
  const first = await ctx.server.callTool("read_file", {
    targets: [{ path: alphaPath, range: "11-90" }, { path: betaPath, range: "31-100" }],
    content: "auto",
    budget: { bytes: 6500 },
    task: { epoch: "new" },
    cwd: ctx.ws,
  });
  const { next } = extractNext(first.body);
  if (!next) return { pass: true, reason: "completed in one hop; nothing to mutate mid-chain", metrics: {} };

  writeSelfIdFile(ctx.ws, alphaPath, 200, "rfourmixnew", 120); // mutate ONLY alpha, mid-chain
  const rest = await walkHops(ctx.server, next, 12);
  const all = [first.body, ...rest.responses];
  const coverage = new Map<string, Set<number>>();
  for (const r of all) unionInto(coverage, extractServedIds(r, ["rfourmixold", "rfourmixnew", "rfourmixbeta"]));
  const oldInRange = [...(coverage.get("rfourmixold") ?? new Set<number>())].filter((n) => n >= 11 && n <= 90);
  const newInRange = [...(coverage.get("rfourmixnew") ?? new Set<number>())].filter((n) => n >= 11 && n <= 90);
  const mixed = oldInRange.length > 0 && newInRange.length > 0;
  const endedCleanly = !rest.capped && !all.some((r) => isExplicitStop(r));
  const pass = !(mixed && endedCleanly);
  return {
    pass,
    reason: pass
      ? `no forbidden mixing (oldInRange=${oldInRange.length} newInRange=${newInRange.length} endedCleanly=${endedCleanly})`
      : `MIXED pre/post-mutation bytes for the SAME requested range (data/alpha.txt 11-90: old-tag=${oldInRange.length} lines, new-tag=${newInRange.length} lines) while the chain reported a clean, non-refused, non-capped completion -- a torn read presented as one coherent delivered range`,
    metrics: { oldInRange: oldInRange.length, newInRange: newInRange.length, endedCleanly, capped: rest.capped, hopKinds: all.map((r) => (r as Record<string, unknown> | null)?.["kind"]) },
  };
}

async function runR04(ctx: ScenarioContext): Promise<ScenarioVerdict> {
  const members = [
    { id: "append", ...(await runR04Append(ctx)) },
    { id: "rewrite", ...(await runR04Rewrite(ctx)) },
    { id: "garbled-cursor", ...(await runR04GarbledCursor(ctx)) },
    { id: "multitarget-mix", ...(await runR04MultiTargetMix(ctx)) },
  ];
  const pass = members.every((m) => m.pass);
  return {
    pass,
    reason: pass
      ? "all R04 members handled file-change/stale-cursor cases honestly (restart, refusal-with-recovery, or a consistent re-serve)"
      : `failing members: ${members.filter((m) => !m.pass).map((m) => `${m.id}: ${m.reason}`).join(" | ")}`,
    metrics: { members },
  };
}

// --- C01a (TL-05): content:"full" + range must not expand to whole file ----

async function runC01a(ctx: ScenarioContext): Promise<ScenarioVerdict> {
  const chain = await followNextToEnd(
    ctx.server,
    {
      tool: "read_file",
      arguments: {
        targets: RANGE_FIXTURE_REQUEST.targets,
        content: "full",
        budget: { bytes: 6500 },
        task: { epoch: "new" },
        cwd: ctx.ws,
      },
    },
    { cwd: ctx.ws, hopCap: 20 },
  );
  const coverage = cumulativeCoverage(chain, RANGE_FIXTURE_TAGS);
  const alphaGot = coverage.get("alpha") ?? new Set<number>();
  const betaGot = coverage.get("beta") ?? new Set<number>();
  const extraAlpha = extraIds(alphaGot, RANGE_FIXTURE_REQUEST.wanted.alpha);
  const extraBeta = extraIds(betaGot, RANGE_FIXTURE_REQUEST.wanted.beta);
  const missingAlpha = missingIds(RANGE_FIXTURE_REQUEST.wanted.alpha, alphaGot);
  const missingBeta = missingIds(RANGE_FIXTURE_REQUEST.wanted.beta, betaGot);
  const totalDelivered = alphaGot.size + betaGot.size;
  const pass = extraAlpha.length === 0 && extraBeta.length === 0 && missingAlpha.length === 0 && missingBeta.length === 0 && !chain.capped;
  return {
    pass,
    reason: pass
      ? `exactly the requested ${RANGE_FIXTURE_REQUEST.totalRequestedLines} lines delivered under content:"full"`
      : `${totalDelivered} total lines delivered over ${chain.hops.length} call(s) (requested ${RANGE_FIXTURE_REQUEST.totalRequestedLines}); extraAlpha=${extraAlpha.length} extraBeta=${extraBeta.length} — content:"full" expanded past the requested range`,
    metrics: { totalDelivered, extraAlpha: extraAlpha.length, extraBeta: extraBeta.length, calls: chain.hops.length, capped: chain.capped },
  };
}

// --- C01b (TL-05): a budgeted chain's `next` must keep the same cap --------

const BUDGET_ENVELOPE_TOLERANCE_BYTES = 512; // generous; no server-documented tolerance was found (see header).

async function runC01b(ctx: ScenarioContext): Promise<ScenarioVerdict> {
  const initialBudgetBytes = 6500;
  const chain = await followNextToEnd(
    ctx.server,
    {
      tool: "read_file",
      arguments: {
        targets: RANGE_FIXTURE_REQUEST.targets,
        content: "auto",
        budget: { bytes: initialBudgetBytes },
        task: { epoch: "new" },
        cwd: ctx.ws,
      },
    },
    { cwd: ctx.ws },
  );
  const overBudgetHops: Array<{ hop: number; textBytes: number }> = [];
  const nextsMissingBudget: number[] = [];
  for (let i = 1; i < chain.hops.length; i++) {
    const hop = chain.hops[i]!;
    if (hop.textBytes > initialBudgetBytes + BUDGET_ENVELOPE_TOLERANCE_BYTES) {
      overBudgetHops.push({ hop: i, textBytes: hop.textBytes });
    }
    const priorHop = chain.hops[i - 1]!;
    if (priorHop.nextSource !== "none" && priorHop.nextSource !== "qref-repack") {
      const carriedBudget = (hop.call.arguments as Record<string, unknown>)["budget"];
      if (carriedBudget === undefined) nextsMissingBudget.push(i);
    }
  }
  const pass = overBudgetHops.length === 0 && nextsMissingBudget.length === 0;
  return {
    pass,
    reason: pass
      ? "every continuation stayed within the initial budget and carried it forward"
      : `overBudgetHops=${JSON.stringify(overBudgetHops)} nextsMissingBudget=${JSON.stringify(nextsMissingBudget)} (initial budget ${initialBudgetBytes} B, tolerance ${BUDGET_ENVELOPE_TOLERANCE_BYTES} B)`,
    metrics: { initialBudgetBytes, overBudgetHops, nextsMissingBudget, hops: chain.hops.length },
  };
}

// --- C02a (regression control): identical re-read is receipted -------------

async function runC02a(ctx: ScenarioContext): Promise<ScenarioVerdict> {
  const baseArgs = { targets: [{ path: "small.txt" }], content: "full", cwd: ctx.ws };
  const call1 = await ctx.server.callTool("read_file", { ...baseArgs, task: { epoch: "new" } });
  const call2 = await ctx.server.callTool("read_file", { ...baseArgs });
  const call3 = await ctx.server.callTool("read_file", { ...baseArgs, task: { force_serve: true } });
  const call4 = await ctx.server.callTool("read_file", { ...baseArgs, budget: { allowFull: true } });

  const checks = {
    firstIsFullBody: call1.body?.kind === "read.text",
    secondIsSmallerReceipt: call2.body?.kind === "read.receipt" && call2.textBytes < call1.textBytes,
    forceServeResendsBody: call3.body?.kind === "read.text" && call3.textBytes === call1.textBytes,
    allowFullAloneStaysReceipted: call4.body?.kind === "read.receipt",
  };
  const pass = Object.values(checks).every(Boolean);
  return {
    pass,
    reason: pass ? "receipt/force_serve/allowFull semantics all hold" : `failed checks: ${JSON.stringify(checks)}`,
    metrics: { checks, textBytes: { call1: call1.textBytes, call2: call2.textBytes, call3: call3.textBytes, call4: call4.textBytes } },
  };
}

// --- Q01 (TL-02): a compound request must not silently drop a concern ------

export const Q01_QUERY = "Explain how credentials are validated and how database migrations are executed.";

async function runQ01(ctx: ScenarioContext): Promise<ScenarioVerdict> {
  const chain = await followNextToEnd(
    ctx.server,
    { tool: "read_file", arguments: { query: Q01_QUERY, task: { epoch: "new", profile: "answer" }, cwd: ctx.ws } },
    { cwd: ctx.ws },
  );
  const authServed = anyEvidenceContains(chain, CREDENTIALS_SYMBOLS);
  const disclosures = collectDisclosureTexts(chain);
  const migrationDisclosed = anyDisclosureMatches(disclosures, MIGRATION_DISCLOSURE_KEYWORDS);
  const finalKind = finalDecisionKind(chain);
  const pass = authServed && migrationDisclosed;
  return {
    pass,
    reason: pass
      ? `both concerns visible: authServed=true, migration disclosed via ${JSON.stringify(disclosures)}`
      : `authServed=${authServed} migrationDisclosed=${migrationDisclosed} finalKind=${String(finalKind)} disclosures=${JSON.stringify(disclosures)}`,
    metrics: { authServed, migrationDisclosed, finalKind, disclosures, hops: chain.hops.length, capped: chain.capped },
  };
}

// --- Q02 (TL-02): paraphrase/negation/quote/example must not break retention
//
// Reuses Q01's own fixture (real auth, genuinely no migrations) and its
// exported CREDENTIALS_SYMBOLS/MIGRATION_DISCLOSURE_KEYWORDS. Two members use
// the LITERAL phrasing patterns brief-w0b names (particle "…と、…", "また");
// the "jp-mata" form was CONFIRMED (by hand, spawning the dev server) to
// retain and disclose both concerns cleanly. The "jp-to-particle" form is the
// documented KNOWN LIMIT already registered as `it.fails` in
// `concernRetentionMatrix.spec.ts` (product spec, read-only reference) for
// this exact 「…と、…」 shape -- kept here anyway (not fixture-specific: it is
// literally the pattern the plan and the brief name) so a fix is visible
// here too, not only in the product spec.
//
// For negation / quoted-phrase / in-question-example / type-member-mention,
// the plan's own bar is narrower: the SPURIOUS phrase must never become an
// independent BLOCKING concern. Whether the server also volunteers a
// migration-absence disclosure for the negated clause is left open (both a
// correctly-suppressed and a conservatively-still-disclosed migration
// mention are safe outcomes; only silently blocking or silently dropping the
// REAL concern -- credentials -- is not).

interface Q02Member {
  id: string;
  query: string;
  requireMigrationDisclosed: boolean;
}

const Q02_MEMBERS: readonly Q02Member[] = [
  { id: "jp-to-particle", query: "認証情報の検証方法と、データベースマイグレーションの実行方法を説明してください。", requireMigrationDisclosed: true },
  { id: "jp-mata", query: "認証情報はどこで検証されますか。また、データベースのマイグレーションはどのように実行されますか。", requireMigrationDisclosed: true },
  { id: "negation", query: "Explain how credentials are validated, but not how database migrations are executed.", requireMigrationDisclosed: false },
  {
    id: "quoted-phrase",
    query: 'Explain how credentials are validated. The code contains the phrase "stored, salted password hash" in a comment.',
    requireMigrationDisclosed: false,
  },
  { id: "in-question-example", query: "Explain how credentials are validated, such as by comparing password hashes.", requireMigrationDisclosed: false },
  { id: "type-member-mention", query: "Explain how CredentialCheckResult is produced by validateCredentials.", requireMigrationDisclosed: false },
];

async function runQ02(ctx: ScenarioContext): Promise<ScenarioVerdict> {
  const members: Array<Record<string, unknown>> = [];
  for (const member of Q02_MEMBERS) {
    const chain = await followNextToEnd(
      ctx.server,
      { tool: "read_file", arguments: { query: member.query, task: { epoch: "new", profile: "answer" }, cwd: ctx.ws } },
      { cwd: ctx.ws },
    );
    const authServed = anyEvidenceContains(chain, CREDENTIALS_SYMBOLS);
    const finalKind = finalDecisionKind(chain);
    const disclosures = collectDisclosureTexts(chain);
    const migrationDisclosed = anyDisclosureMatches(disclosures, MIGRATION_DISCLOSURE_KEYWORDS);
    const reachedAnswer = finalKind === "act.answer";
    const pass = authServed && reachedAnswer && !chain.capped && (!member.requireMigrationDisclosed || migrationDisclosed);
    members.push({ id: member.id, pass, authServed, finalKind, migrationDisclosed, requireMigrationDisclosed: member.requireMigrationDisclosed, capped: chain.capped });
  }
  const pass = members.every((m) => m["pass"] === true);
  return {
    pass,
    reason: pass
      ? "every paraphrase/negation/quote/example variant retained the real concern without spurious blocking"
      : `failing members: ${JSON.stringify(members.filter((m) => !m["pass"]))}`,
    metrics: { members },
  };
}

// --- Q03 (TL-03): JP compound cache question, no false absence ------------

export const Q03_QUERY_JP = "キャッシュが期限切れの場合の処理と、無効化する処理を説明してください";

async function runQ03(ctx: ScenarioContext): Promise<ScenarioVerdict> {
  const chain = await followNextToEnd(
    ctx.server,
    { tool: "read_file", arguments: { query: Q03_QUERY_JP, task: { epoch: "new", profile: "answer" }, cwd: ctx.ws } },
    { cwd: ctx.ws },
  );
  const expiryServed = anyEvidenceContains(chain, CACHE_EXPIRY_EVIDENCE);
  const invalidateServed = anyEvidenceContains(chain, CACHE_INVALIDATE_EVIDENCE);
  const disclosures = collectDisclosureTexts(chain);
  const falseExpiryAbsence = expiryServed && anyDisclosureMatches(disclosures, CACHE_EXPIRY_KEYWORDS);
  const falseInvalidateAbsence = invalidateServed && anyDisclosureMatches(disclosures, CACHE_INVALIDATE_KEYWORDS);
  const falseAbsenceCount = (falseExpiryAbsence ? 1 : 0) + (falseInvalidateAbsence ? 1 : 0);
  const pass = expiryServed && invalidateServed && falseAbsenceCount === 0;
  return {
    pass,
    reason: pass
      ? "both bodies served, zero false-absence entries"
      : `expiryServed=${expiryServed} invalidateServed=${invalidateServed} falseAbsenceCount=${falseAbsenceCount} disclosures=${JSON.stringify(disclosures)}`,
    metrics: { expiryServed, invalidateServed, falseAbsenceCount, disclosures, hops: chain.hops.length },
  };
}

// --- Q04 (TL-03 control): `validated` vs `validate` inflection ------------

export const Q04_QUERY = "Explain how credentials are validated; also explain what happens on a bad password.";

async function runQ04(ctx: ScenarioContext): Promise<ScenarioVerdict> {
  const chain = await followNextToEnd(
    ctx.server,
    { tool: "read_file", arguments: { query: Q04_QUERY, task: { epoch: "new", profile: "answer" }, cwd: ctx.ws } },
    { cwd: ctx.ws },
  );
  const authServed = anyEvidenceContains(chain, CREDENTIALS_SYMBOLS);
  const disclosures = collectDisclosureTexts(chain);
  const falseValidatedAbsence = anyDisclosureMatches(disclosures, ["valid"]);
  const pass = authServed && !falseValidatedAbsence;
  return {
    pass,
    reason: pass
      ? "no false absence reported for the validated/validate inflection"
      : `authServed=${authServed} falseValidatedAbsence=${falseValidatedAbsence} disclosures=${JSON.stringify(disclosures)}`,
    metrics: { authServed, falseValidatedAbsence, disclosures, hops: chain.hops.length },
  };
}

// --- Q05 (TL-04): four-concern recovery, no unrelated substitution --------

export const Q05_QUERY =
  "Explain how authentication works, how the cache expires entries, how retries are scheduled, and how the request timeout is configured.";

async function runQ05(ctx: ScenarioContext): Promise<ScenarioVerdict> {
  const chain = await followNextToEnd(
    ctx.server,
    { tool: "read_file", arguments: { query: Q05_QUERY, task: { epoch: "new", profile: "answer" }, cwd: ctx.ws } },
    { cwd: ctx.ws, hopCap: 16 },
  );
  const coverage: Record<string, boolean> = {};
  for (const [concern, markers] of Object.entries(FOUR_CONCERN_EVIDENCE)) coverage[concern] = anyEvidenceContains(chain, markers);
  const allFourCovered = Object.values(coverage).every(Boolean);
  const finalKind = finalDecisionKind(chain);
  const endsInAnswer = finalKind === "act.answer";
  const servedPaths = [...servedEvidencePaths(chain)];
  const noiseServed = FOUR_CONCERN_NOISE_PATHS.filter((p) => servedPaths.includes(p));
  const noiseSubstituted = noiseServed.length > 0 && !allFourCovered;
  const pass = allFourCovered && endsInAnswer && !noiseSubstituted;
  return {
    pass,
    reason: pass
      ? "all four concerns covered, chain ended in act.answer, no noise substitution"
      : `coverage=${JSON.stringify(coverage)} finalKind=${String(finalKind)} noiseServed=${JSON.stringify(noiseServed)}`,
    metrics: { coverage, finalKind, servedPaths, noiseServed, hops: chain.hops.length, capped: chain.capped },
  };
}

// --- Q06 (TL-03/TL-04): absence honesty under exclusion/unreadability ------
//
// Four members sharing one workspace. CONFIRMED live (by hand): an EXACT,
// literal symbol-name query bypasses `.gitignore` entirely for an
// answer-profile lookup (the server served `secret/hidden.ts` verbatim) --
// that is not what this scenario is about (a direct, precise reference is a
// different, legitimate case) and would not exercise discovery at all, so
// every query below is phrased INDIRECTLY (never names the real identifier),
// forcing reliance on the same broad search a real "is this here at all"
// question would use. Also CONFIRMED live: the ignored-path and
// undecodable-file members both terminate in `await_input` /
// `no-grounded-call-remains` -- an honest "could not determine" -- with NO
// disclosure claiming the concept was absent from a "scope complete" scan;
// the ambiguous-concept member serves real evidence for the query rather
// than declaring absence. `scopeCompleteAbsenceClaimed` below encodes the one
// invariant plan §10 Q06 actually requires: a "scope complete" / confident
// no-occurrence claim (confirmed wire wording, e.g. "no occurrence in
// scanned workspace files; scope complete") must never fire for a concept
// that is real but excluded, unreadable, or ambiguous.

function buildQ06Workspace(root: string): void {
  fs.mkdirSync(path.join(root, ".git"), { recursive: true });
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "visible.ts"), "export function visible(): number { return 1; }\n", "utf8");
  // Member: concept living only in a .gitignore-excluded path.
  fs.mkdirSync(path.join(root, "secret"), { recursive: true });
  fs.writeFileSync(path.join(root, "secret", "hidden.ts"), "export function computeQuotaFromIgnoredModule(): number { return 42; }\n", "utf8");
  fs.writeFileSync(path.join(root, ".gitignore"), "secret/\n", "utf8");
  // Member: concept living only in an undecodable (binary-suffixed) file.
  const throttleBody = Buffer.concat([
    Buffer.from("export function computeThrottleWindow(): number { return 7; }\n", "utf8"),
    Buffer.from([0x00, 0xff, 0xfe, 0x00, 0xc0, 0xc1]),
  ]);
  fs.writeFileSync(path.join(root, "src", "throttle.dat"), throttleBody);
  // Member: an ambiguous concept -- two equally-plausible, genuinely
  // different implementations, neither of which is "the" answer.
  fs.writeFileSync(path.join(root, "src", "pricing.ts"), "export function computeDiscount(price) {\n  return price * 0.9;\n}\n", "utf8");
  fs.writeFileSync(path.join(root, "src", "billing.ts"), "export function computeDiscountRate(tier) {\n  return tier === 'gold' ? 0.2 : 0.1;\n}\n", "utf8");
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "q06-fixture", version: "0.0.0", private: true }, null, 2) + "\n", "utf8");
}

function scopeCompleteAbsenceClaimed(chain: ChainResult, keywords: readonly string[]): boolean {
  const disclosures = collectDisclosureTexts(chain);
  return disclosures.some((d) => {
    const lower = d.toLowerCase();
    return keywords.some((k) => lower.includes(k.toLowerCase())) && lower.includes("scope complete");
  });
}

async function runQ06(ctx: ScenarioContext): Promise<ScenarioVerdict> {
  const members: Array<Record<string, unknown>> = [];

  {
    const chain = await followNextToEnd(
      ctx.server,
      { tool: "read_file", arguments: { query: "How is rate limiting implemented in this project?", task: { epoch: "new", profile: "answer" }, cwd: ctx.ws } },
      { cwd: ctx.ws },
    );
    const fabricated = anyEvidenceContains(chain, ["RateLimit", "rateLimit", "rate_limit"]);
    const finalKind = finalDecisionKind(chain);
    const reachedTerminal = finalKind === "act.answer" || finalKind === "await_input" || finalKind === "await-input";
    members.push({ id: "plain-absent", pass: !fabricated && reachedTerminal && !chain.capped, fabricated, finalKind, capped: chain.capped });
  }
  {
    const chain = await followNextToEnd(
      ctx.server,
      { tool: "read_file", arguments: { query: "How is the quota computation implemented in this project?", task: { epoch: "new", profile: "answer" }, cwd: ctx.ws } },
      { cwd: ctx.ws },
    );
    const falseAbsolute = scopeCompleteAbsenceClaimed(chain, ["quota"]);
    members.push({ id: "ignored-path", pass: !falseAbsolute, falseAbsolute, finalKind: finalDecisionKind(chain), disclosures: collectDisclosureTexts(chain) });
  }
  {
    const chain = await followNextToEnd(
      ctx.server,
      { tool: "read_file", arguments: { query: "How is the throttle window computed in this project?", task: { epoch: "new", profile: "answer" }, cwd: ctx.ws } },
      { cwd: ctx.ws },
    );
    const falseAbsolute = scopeCompleteAbsenceClaimed(chain, ["throttle"]);
    members.push({ id: "unreadable-binary", pass: !falseAbsolute, falseAbsolute, finalKind: finalDecisionKind(chain), disclosures: collectDisclosureTexts(chain) });
  }
  {
    const chain = await followNextToEnd(
      ctx.server,
      { tool: "read_file", arguments: { query: "How is the discount computed?", task: { epoch: "new", profile: "answer" }, cwd: ctx.ws } },
      { cwd: ctx.ws },
    );
    const evidenceServed = anyEvidenceContains(chain, ["computeDiscount", "computeDiscountRate"]);
    members.push({ id: "ambiguous-concept", pass: evidenceServed, evidenceServed, finalKind: finalDecisionKind(chain), servedPaths: [...servedEvidencePaths(chain)] });
  }

  const pass = members.every((m) => m["pass"] === true);
  return {
    pass,
    reason: pass
      ? "absence honesty held: no fabricated evidence, no false scope-complete claim over excluded/unreadable paths, ambiguous-but-real concept still served"
      : `failing members: ${JSON.stringify(members.filter((m) => !m["pass"]))}`,
    metrics: { members },
  };
}

// --- C02b (TL-06, extends C02a): a projection change must not be receipted -
//
// CONFIRMED live: `content:"full"` -> `read.text`; `content:"outline"` on the
// SAME unchanged file -> `read.map` (a genuinely different projection, never
// a receipt); repeating the ORIGINAL `content:"full"` call afterward ->
// correctly `read.receipt`. C02a already covers identical-reread/
// force_serve/allowFull; this covers the one axis it does not: a projection
// (outline vs full-body) change on an unchanged file.

function buildC02bWorkspace(root: string): void {
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "src", "thing.ts"),
    ["// header comment one", "// header comment two", "export function thing(): number {", "  // inline comment explaining the constant", "  return 7;", "}", ""].join("\n"),
    "utf8",
  );
}

async function runC02b(ctx: ScenarioContext): Promise<ScenarioVerdict> {
  const relPath = "src/thing.ts";
  const call1 = await ctx.server.callTool("read_file", { targets: [{ path: relPath }], content: "full", cwd: ctx.ws, task: { epoch: "new" } });
  const call2 = await ctx.server.callTool("read_file", { targets: [{ path: relPath }], content: "outline", cwd: ctx.ws });
  const call3 = await ctx.server.callTool("read_file", { targets: [{ path: relPath }], content: "full", cwd: ctx.ws });
  const checks = {
    fullIsBody: call1.body?.kind === "read.text",
    outlineIsNotReceipted: call2.body?.kind !== "read.receipt",
    outlineDiffersFromFull: call2.textBytes !== call1.textBytes || call2.body?.kind !== call1.body?.kind,
    repeatOfFullIsReceipted: call3.body?.kind === "read.receipt",
  };
  const pass = Object.values(checks).every(Boolean);
  return {
    pass,
    reason: pass ? "projection change (full -> outline) served fresh, not receipted; returning to full is correctly receipted" : `failed checks: ${JSON.stringify(checks)}`,
    metrics: { checks, kinds: { call1: call1.body?.kind, call2: call2.body?.kind, call3: call3.body?.kind }, textBytes: { call1: call1.textBytes, call2: call2.textBytes, call3: call3.textBytes } },
  };
}

// --- S01 (TL-06): epoch/lane isolation, profile persistence, repack, restart

function buildS01Workspace(root: string): void {
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "src", "widget.ts"),
    ["// widget.ts -- a tiny module used by the S01 state-control scenario.", "export function computeWidgetValue(seed: number): number {", "  return seed * 2 + 1;", "}", ""].join("\n"),
    "utf8",
  );
}

const S01_DECISION_RANK: Readonly<Record<string, number>> = {
  discover: 0,
  await_input: 1,
  "await-input": 1,
  "act.edit": 2,
  "act.answer": 2,
  done: 3,
};

async function runS01(ctx: ScenarioContext): Promise<ScenarioVerdict> {
  const checks: Array<{ id: string; pass: boolean; detail: string }> = [];
  const query = "Explain how the widget module's computeWidgetValue function computes its return value.";

  // (a) task.epoch:"new" issued twice for the same query does its OWN fresh
  // work each time rather than inheriting served state as a substitute for
  // it. NOTE: `task.id` alone is NOT a valid freshness signal -- CONFIRMED
  // live that it is stable/content-keyed (identical across two separate
  // epoch:"new" calls for the same query+workspace+lane), so this checks
  // real, non-empty evidence on BOTH calls instead (brief-w0b: "does not
  // inherit served state" -- a hollow second answer with no evidence would
  // be exactly that; a stable id with fresh evidence each time is not).
  {
    const call1 = await ctx.server.callTool("read_file", { query, task: { epoch: "new", profile: "answer" }, cwd: ctx.ws });
    const call2 = await ctx.server.callTool("read_file", { query, task: { epoch: "new", profile: "answer" }, cwd: ctx.ws });
    const evidence1 = (call1.body as Record<string, unknown> | null)?.["evidence"];
    const evidence2 = (call2.body as Record<string, unknown> | null)?.["evidence"];
    const pass = Array.isArray(evidence1) && evidence1.length > 0 && Array.isArray(evidence2) && evidence2.length > 0;
    checks.push({
      id: "epoch-new-fresh-task",
      pass,
      detail: `evidence1Count=${Array.isArray(evidence1) ? evidence1.length : "n/a"} evidence2Count=${Array.isArray(evidence2) ? evidence2.length : "n/a"} id1=${String(pick(call1.body, "task.id"))} id2=${String(pick(call2.body, "task.id"))}`,
    });
  }

  // (b) another lane does not see this lane's receipts.
  {
    const args = { targets: [{ path: "src/widget.ts" }], content: "full", cwd: ctx.ws };
    const laneA1 = await ctx.server.callTool("read_file", { ...args, lane: "s01-lane-a", task: { epoch: "new" } });
    const laneA2 = await ctx.server.callTool("read_file", { ...args, lane: "s01-lane-a" });
    const laneB1 = await ctx.server.callTool("read_file", { ...args, lane: "s01-lane-b" });
    const pass = laneA1.body?.kind !== "read.receipt" && laneA2.body?.kind === "read.receipt" && laneB1.body?.kind !== "read.receipt";
    checks.push({ id: "lane-isolated-receipts", pass, detail: `A1=${String(laneA1.body?.kind)} A2=${String(laneA2.body?.kind)} B1=${String(laneB1.body?.kind)}` });
  }

  // (c) qref/task.handle continuation keeps the declared read-only "answer"
  // profile when a re-pack omits `profile`.
  {
    const first = await ctx.server.callTool("read_file", { query, task: { epoch: "new", profile: "answer" }, cwd: ctx.ws });
    const qref = first.body?.qref;
    const handle = pick(first.body, "task.id");
    let repacked: any;
    if (typeof qref === "string") {
      repacked = (await ctx.server.callTool("read_file", { qref, cwd: ctx.ws })).body;
    } else if (typeof handle === "string") {
      repacked = (await ctx.server.callTool("read_file", { task: { handle }, cwd: ctx.ws })).body;
    }
    const profileHeld = repacked === undefined ? true : repacked?.profile === "answer" || pick(repacked, "profile_binding.selected") === "answer";
    checks.push({ id: "repack-keeps-answer-profile", pass: profileHeld, detail: `qref=${String(qref)} repackedProfile=${String(repacked?.profile)}` });
  }

  // (d) a bare {qref} re-pack must never regress a certified decision
  // BACKWARD to an earlier, less-resolved one (the exact probe that exposed
  // the defect this wave's FIX-D is fixing -- brief-w0b UPDATE: keep this
  // chain even if it still fails).
  {
    const chain = await followNextToEnd(ctx.server, { tool: "read_file", arguments: { query, task: { epoch: "new", profile: "answer" }, cwd: ctx.ws } }, { cwd: ctx.ws, maxQrefRepacks: 2 });
    const kinds = chain.hops.map((h) => pick(h.response, "decision.kind")).filter((k): k is string => typeof k === "string");
    let regressed = false;
    for (let i = 1; i < kinds.length; i++) {
      const prevRank = S01_DECISION_RANK[kinds[i - 1]!] ?? -1;
      const currRank = S01_DECISION_RANK[kinds[i]!] ?? -1;
      if (currRank < prevRank) regressed = true;
    }
    checks.push({ id: "no-repack-regression", pass: !regressed, detail: `decisionKinds=${JSON.stringify(kinds)}` });
  }

  // (e) a server restart mid-chain: continuation by task.handle either
  // resumes honestly or refuses with retry:"new-task" -- never fabricates a
  // decision with no evidence behind it.
  if (typeof ctx.restartServer === "function") {
    const first = await ctx.server.callTool("read_file", { query, task: { epoch: "new", profile: "answer" }, cwd: ctx.ws });
    const handle = pick(first.body, "task.id");
    const newServer = await ctx.restartServer();
    let afterRestart: any;
    if (typeof handle === "string") {
      afterRestart = (await newServer.callTool("read_file", { task: { handle }, cwd: ctx.ws })).body;
    }
    const honestOutcome = afterRestart === undefined ? true : afterRestart?.kind === "refusal" ? typeof afterRestart?.retry === "string" : true;
    const fabricated =
      afterRestart !== undefined
      && afterRestart?.kind !== "refusal"
      && pick(afterRestart, "decision.kind") === "act.answer"
      && (!Array.isArray(afterRestart?.evidence) || afterRestart.evidence.length === 0);
    const pass = honestOutcome && !fabricated;
    checks.push({ id: "restart-mid-chain-honest", pass, detail: `afterRestartKind=${String(afterRestart?.kind)} code=${String(afterRestart?.code)} retry=${String(afterRestart?.retry)} fabricated=${fabricated}` });
  } else {
    checks.push({ id: "restart-mid-chain-honest", pass: true, detail: "no restart capability provided by this caller -- skipped, not counted as a failure" });
  }

  const pass = checks.every((c) => c.pass);
  return {
    pass,
    reason: pass ? "epoch/lane isolation, profile persistence, repack monotonicity and restart honesty all held" : `failing checks: ${JSON.stringify(checks.filter((c) => !c.pass))}`,
    metrics: { checks },
  };
}

// --- E01 (edit safety controls, expected to pass) ---------------------------
//
// Four independent checks over one write-enabled workspace (Scenario.
// needsWrite:true — both callers must start this scenario's server with
// `--allow-write`). All four are CONFIRMED live against the dev server.

function buildE01Workspace(root: string): void {
  fs.mkdirSync(path.join(root, "opid"), { recursive: true });
  fs.writeFileSync(path.join(root, "opid", "target.txt"), "hello world\nsecond line\n", "utf8");
  fs.mkdirSync(path.join(root, "ambiguous"), { recursive: true });
  fs.writeFileSync(path.join(root, "ambiguous", "dup.txt"), "same line\nsame line\nsame line\n", "utf8");
  fs.mkdirSync(path.join(root, "fence"), { recursive: true });
  fs.writeFileSync(path.join(root, "fence", "seen.txt"), "line one\nline two\n", "utf8");
  fs.writeFileSync(path.join(root, "fence", "unseen.txt"), "target text here\nmore text\n", "utf8");
  fs.mkdirSync(path.join(root, "batch"), { recursive: true });
  fs.writeFileSync(path.join(root, "batch", "good.txt"), "alpha content here\n", "utf8");
  fs.writeFileSync(path.join(root, "batch", "bad.txt"), "beta content here\n", "utf8");
}

async function runE01(ctx: ScenarioContext): Promise<ScenarioVerdict> {
  const checks: Array<{ id: string; pass: boolean; detail: string }> = [];

  // (1) duplicate operation_id replays instead of re-applying.
  {
    const relPath = "opid/target.txt";
    await ctx.server.callTool("read_file", { targets: [{ path: relPath }], content: "full", cwd: ctx.ws, task: { epoch: "new" } });
    const opId = "w0b-e01-op-" + Math.random().toString(36).slice(2);
    const edit1 = await ctx.server.callTool("edit_file", { edits: [{ path: relPath, search: "hello world", replace: "hello universe" }], cwd: ctx.ws, operation_id: opId });
    const edit2 = await ctx.server.callTool("edit_file", { edits: [{ path: relPath, search: "hello world", replace: "hello universe" }], cwd: ctx.ws, operation_id: opId });
    const contentAfter = fs.readFileSync(path.join(ctx.ws, relPath), "utf8");
    const pass = edit1.body?.kind === "edit.applied" && edit2.body?.replayed === true && contentAfter === "hello universe\nsecond line\n";
    checks.push({ id: "operation-id-replay", pass, detail: `edit1Kind=${String(edit1.body?.kind)} edit2Replayed=${String(edit2.body?.replayed)} contentAfter=${JSON.stringify(contentAfter)}` });
  }

  // (2) an ambiguous replace refuses rather than auto-picking a match.
  {
    const relPath = "ambiguous/dup.txt";
    await ctx.server.callTool("read_file", { targets: [{ path: relPath }], content: "full", cwd: ctx.ws, task: { epoch: "new" } });
    const edit1 = await ctx.server.callTool("edit_file", { edits: [{ path: relPath, search: "same line", replace: "changed line" }], cwd: ctx.ws });
    const contentAfter = fs.readFileSync(path.join(ctx.ws, relPath), "utf8");
    const pass = edit1.body?.kind === "refusal" && contentAfter === "same line\nsame line\nsame line\n";
    checks.push({ id: "ambiguous-replace-refuses", pass, detail: `kind=${String(edit1.body?.kind)} code=${String(edit1.body?.code)} unchanged=${contentAfter === "same line\nsame line\nsame line\n"}` });
  }

  // (3) an edit of never-served bytes under a live fence refuses with an
  // executable `next`.
  {
    await ctx.server.callTool("read_file", { query: "Explain line one in fence/seen.txt", task: { epoch: "new", profile: "generic" }, cwd: ctx.ws });
    const edit1 = await ctx.server.callTool("edit_file", { edits: [{ path: "fence/unseen.txt", search: "target text here", replace: "replaced text here" }], cwd: ctx.ws });
    const contentAfter = fs.readFileSync(path.join(ctx.ws, "fence/unseen.txt"), "utf8");
    const pass = edit1.body?.kind === "refusal" && edit1.body?.code === "execution-typestate" && edit1.body?.next !== undefined && contentAfter.includes("target text here");
    checks.push({ id: "unserved-fence-refuses", pass, detail: `kind=${String(edit1.body?.kind)} code=${String(edit1.body?.code)} hasNext=${edit1.body?.next !== undefined} unchanged=${contentAfter.includes("target text here")}` });
  }

  // (4) a failing item in a batch rolls the WHOLE batch back.
  {
    await ctx.server.callTool("read_file", { targets: [{ path: "batch/good.txt" }, { path: "batch/bad.txt" }], content: "full", cwd: ctx.ws, task: { epoch: "new" } });
    const edit1 = await ctx.server.callTool("edit_file", {
      edits: [
        { path: "batch/good.txt", search: "alpha content here", replace: "alpha CHANGED here" },
        { path: "batch/bad.txt", search: "NO SUCH TEXT EXISTS ANYWHERE", replace: "whatever" },
      ],
      cwd: ctx.ws,
    });
    const goodAfter = fs.readFileSync(path.join(ctx.ws, "batch/good.txt"), "utf8");
    const pass = edit1.body?.kind === "refusal" && goodAfter === "alpha content here\n";
    checks.push({ id: "batch-all-or-nothing", pass, detail: `kind=${String(edit1.body?.kind)} goodUnchanged=${goodAfter === "alpha content here\n"}` });
  }

  const pass = checks.every((c) => c.pass);
  return {
    pass,
    reason: pass ? "operation_id replay, ambiguous refusal, unserved-fence refusal and batch rollback all held" : `failing checks: ${JSON.stringify(checks.filter((c) => !c.pass))}`,
    metrics: { checks },
  };
}

// ---------------------------------------------------------------------------
// The registry — ONE definition, consumed by the spec AND the CLI evaluator.
// ---------------------------------------------------------------------------

export const SCENARIOS: readonly Scenario[] = [
  {
    id: "R01",
    planItem: "TL-01",
    summary:
      "Two-file ranged read (11-90 + 31-100) must deliver all 150 requested lines, 0 extras -- across a "
      + "4-member family (~20/55/120 B/line at 6500 B, plus a 7000 B budget member) since the regression "
      + "is byte-threshold sensitive in BOTH line width and response budget.",
    buildWorkspace: buildR01FamilyWorkspace,
    run: runR01,
  },
  {
    id: "R02",
    planItem: "TL-01",
    summary: "1/2/3-file ranged reads across order permutations, short/long lines and budgets {6144,6500,12000}.",
    buildWorkspace: buildR02Workspace,
    run: runR02,
  },
  {
    id: "R03",
    planItem: "TL-01",
    summary: "Overlapping + adjacent ranges, a mid-chain retry of the same call, and the true-EOF last page.",
    buildWorkspace: buildR03Workspace,
    run: runR03,
  },
  {
    id: "R04",
    planItem: "TL-01",
    summary: "File changes mid-chain (append; whole-file rewrite; multi-target rewrite) and a garbled cursor.",
    buildWorkspace: buildR04Workspace,
    run: runR04,
  },
  {
    id: "C01a",
    planItem: "TL-05",
    summary: "content:\"full\" + explicit ranges must serve only the requested 150 lines, never the whole files.",
    buildWorkspace: (root) => buildRangeFixtureWorkspace(root, 120),
    run: runC01a,
  },
  {
    id: "C01b",
    planItem: "TL-05",
    summary: "A server-written `next` in a budgeted chain must keep the same effective per-response cap.",
    buildWorkspace: (root) => buildRangeFixtureWorkspace(root, 120),
    run: runC01b,
  },
  {
    id: "C02a",
    planItem: "regression-control",
    summary: "Identical re-read receipts small; force_serve resends; allowFull alone does not force a resend.",
    buildWorkspace: buildSmallFileWorkspace,
    run: runC02a,
  },
  {
    id: "C02b",
    planItem: "TL-06",
    summary: "A projection change (full body vs outline) on an unchanged file must not be receipted as unchanged.",
    buildWorkspace: buildC02bWorkspace,
    run: runC02b,
  },
  {
    id: "Q01",
    planItem: "TL-02",
    summary: "A compound 'and how' request must keep both concerns visible, never a bare act.answer for only one.",
    buildWorkspace: buildCredentialsWorkspace,
    run: runQ01,
  },
  {
    id: "Q02",
    planItem: "TL-02",
    summary: "JP paraphrase (と/また), negation, quoted phrase, example and type/member mention must not drop or spuriously block the real concern.",
    buildWorkspace: buildCredentialsWorkspace,
    run: runQ02,
  },
  {
    id: "Q03",
    planItem: "TL-03",
    summary: "A Japanese compound cache question must not report a concern absent when its evidence was served.",
    buildWorkspace: buildCacheWorkspace,
    run: runQ03,
  },
  {
    id: "Q04",
    planItem: "TL-03 (regression control)",
    summary: "A 'validated' query against a 'validate...' implementation must not be reported absent.",
    buildWorkspace: buildCredentialsWorkspace,
    run: runQ04,
  },
  {
    id: "Q05",
    planItem: "TL-04",
    summary: "A four-concern compound question must recover all four modules' evidence, never substitute noise.",
    buildWorkspace: buildFourConcernWorkspace,
    run: runQ05,
  },
  {
    id: "Q06",
    planItem: "TL-03",
    summary: "Absent, excluded, unreadable and ambiguous concepts must never collapse into a false workspace-wide absence claim.",
    buildWorkspace: buildQ06Workspace,
    run: runQ06,
  },
  {
    id: "S01",
    planItem: "TL-06",
    summary: "epoch/lane isolation, profile persistence across a re-pack, repack monotonicity, and restart honesty.",
    buildWorkspace: buildS01Workspace,
    run: runS01,
  },
  {
    id: "E01",
    planItem: "edit-safety-control",
    summary: "operation_id replay, ambiguous-replace refusal, unserved-fence refusal and all-or-nothing batch rollback.",
    needsWrite: true,
    buildWorkspace: buildE01Workspace,
    run: runE01,
  },
];

export function scenarioById(id: string): Scenario {
  const found = SCENARIOS.find((s) => s.id === id);
  if (!found) throw new Error(`unknown scenario id ${JSON.stringify(id)} (known: ${SCENARIOS.map((s) => s.id).join(", ")})`);
  return found;
}
