/**
 * trace.ts — opt-in JSONL trace writer for v0.7 developer observability.
 *
 * Enable with TL_TRACE=1. When disabled all calls are no-ops.
 * Output: ~/.tokenlighten/trace/<pid>-<sha8(workspaceRoot)>.jsonl
 *
 * ---------------------------------------------------------------------------
 * V10-02 (Telemetry v2 / Measurement Engine v1) — envelope + observation
 * events (2026-08-20)
 * ---------------------------------------------------------------------------
 *
 * DESIGN-v0.10-expansion-plan-v1.3.md lines 885-941; deferred halves per
 * DESIGN-v0.10-expansion-plan-reconciliation.md §5 D-8 (the paired
 * calibration/ablation RUNS, not this engine or this enrichment).
 *
 * ENVELOPE. Every record `trace()`/`traceCausalAttestation()` writes now
 * carries a common, additive envelope on top of its event-specific payload:
 * `trace_id` (stable per server process — see TRACE_ID below), `call_id`
 * (monotonic per tool call, ALS-scoped so concurrent/interleaved calls under
 * different session `lane`s never see each other's counter — mirrors
 * state/session.ts's `_sessionLane` pattern), `task_ref` (the qref/task
 * IDENTITY CLASS a caller's `query`/`qref` argument resolves to — NEVER a
 * `tlh_*` wire handle, which is single-mint, signed and expiring; `task_ref`
 * is the pure, replayable hash session.ts's `taskQueryRef` already derives),
 * `route` (routing/classifier.ts's advisory bucket), `flags_active` (the D10
 * (B) out-of-contract experiment flags currently on, by name —
 * flags.ts's `activeExperimentFlags()`), `workspaceRef` (state/
 * handleCodec.ts's existing `workspaceRefOf` — a truncated sha256, never the
 * raw path, already used to bind handle tokens to a workspace), and
 * `protocol_era` (mcp/transport/index.ts's `resolveProtocolEra()` — D-3
 * explicitly keeps this OUT of the wire body and puts it here instead).
 * `call_id`/`task_ref`/`route` are "when known": they read as absent
 * (dropped by JSON.stringify) for any record emitted outside
 * `runWithTraceCall`'s scope, e.g. a call site invoked directly from a unit
 * test. `trace_id`/`flags_active`/`workspaceRef`/`protocol_era` are always
 * present. ONE enrichment point (`traceEnvelope` below, folded into both
 * `trace()` and `traceCausalAttestation()`) plus ONE per-call context setter
 * (`runWithTraceCall`/`setTraceContext`, invoked from server.ts's `callTool`
 * dispatch boundary) means the ~20 existing `trace()` call sites across the
 * tree never had to change individually.
 *
 * NEW OBSERVATION EVENTS (all additive, all behind the existing TL_TRACE
 * gate, all zero-cost when it is off):
 *   - `repeated_query`  — a call's resolved task_ref was ALREADY this
 *     workspace session's active qref (a same-qref re-pack, or a verified
 *     qref-replay). Emitted generically off `args.query`/`args.qref` at the
 *     server.ts dispatch boundary, so read_file and search_files are both
 *     covered without their own deep dispatch logic changing.
 *   - `repeated_range`  — a served-range ledger hit answered with a receipt
 *     ("code-unchanged"/prior) instead of fresh bytes. Emitted from the THREE
 *     server.ts functions that already build that receipt shape —
 *     `buildFullDowngradePayload`, `verificationBodyHeld`,
 *     `servedContentReceipt` — each a single function several read-dispatch
 *     branches already funnel through, not touched at each call site.
 *   - `forced_resend`   — a generic `force_serve`-style bypass arg, read
 *     structurally off the raw request args (no hard dependency on the
 *     PI-09 wire-arg workstream that would introduce it; the event simply
 *     never fires while the arg does not exist in this tree).
 *   - `post_edit_readback` — a task_pack surface serving a path already
 *     present in this session's edited-paths ledger (state/session.ts's
 *     `getEditedPaths`). Emitted from `recordTaskPackSurfaceReads`, the one
 *     function every task_pack read-exit already calls.
 *   - `native_escape` is explicitly OUT OF SCOPE: it is CLIENT-side (an
 *     agent choosing `cat`/`sed`/a native editor over TL) and structurally
 *     unobservable from this server — there is no request this process ever
 *     receives for a call that never happened. It is not faked or
 *     approximated here.
 *
 * `state/session.ts` and `util/attachSupply.ts` are both documented I/O-free
 * modules (their own file headers say so); every new `trace()` call this
 * wave adds lives in server.ts, which already owns the ~20 existing ones —
 * no side-effecting import was added to either pure module.
 */

import { createHash, createHmac, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { fileURLToPath, pathToFileURL } from "node:url";
import { AsyncLocalStorage } from "node:async_hooks";

import {
  activeExperimentFlags,
  graphEvidenceMode,
  graphIndexMode,
  semanticFrontierGuardEnabled,
  semanticFrontierV2FlagValues,
  traceEnabled,
} from "./flags.js";
import { deriveServerBuildId } from "./serverBuild.js";
import { workspaceRefOf } from "../state/handleCodec.js";
import { resolveProtocolEra } from "../mcp/transport/index.js";

// ---------------------------------------------------------------------------
// V10-02 Telemetry v2 — per-call trace context
// ---------------------------------------------------------------------------

/**
 * Stable per SERVER PROCESS (not per call, not per workspace) — the envelope
 * field that lets an analyzer group every record one process ever wrote,
 * across every workspace root and every trace file it touched. Computed once
 * at module load, same rationale as SERVER_BUILD_IDENTITY below: cheap,
 * side-effect-free, and cannot change while the process runs.
 */
const TRACE_ID: string = randomUUID();

/** Per-call fields the envelope reads back; refined via setTraceContext as
 *  dispatch learns more (route is known immediately, task_ref only once the
 *  caller's lane is resolved) — see runWithTraceCall's doc comment. */
interface TraceCallContext {
  callId: number;
  taskRef?: string;
  route?: string;
}

/**
 * ALS-scoped, mirroring state/session.ts's `_sessionLane` exactly: a plain
 * module-level counter/object would be corrupted by two tool calls
 * interleaved across awaits (concurrent agents under different `lane`s are a
 * first-class, already-supported scenario in this server — see
 * runWithSessionLane), so `call_id` and the fields setTraceContext refines
 * must live in an async-context-scoped store, not a bare variable.
 */
const _traceCallContext = new AsyncLocalStorage<TraceCallContext>();

/** Monotonic; bumped once per tool call, never per trace line. */
let callIdClock = 0;

/**
 * Per-call context setter — the dispatch boundary (server.ts's `callTool`)
 * wraps its ENTIRE body in this ONCE, at the very top, before route
 * classification or any trace() call for the invocation. Every trace() line
 * emitted anywhere during that call — including nested calls many frames
 * deep, and across every `await` — reads the SAME call_id back out, without
 * threading it through a single function signature. A trace() call made
 * outside any runWithTraceCall scope (e.g. a unit test exercising trace()
 * directly) simply omits call_id/task_ref/route from its envelope; the
 * degrade is graceful, matching every other "when known" envelope field.
 */
export function runWithTraceCall<T>(fn: () => T): T {
  return _traceCallContext.run({ callId: ++callIdClock }, fn);
}

/**
 * Refines the CURRENT call's context as dispatch learns more. A no-op
 * outside runWithTraceCall's scope — refining a context that does not exist
 * is silently discarded, never thrown, so a misordered call can never turn
 * observability into an outage.
 */
export function setTraceContext(fields: { taskRef?: string; route?: string }): void {
  const store = _traceCallContext.getStore();
  if (store === undefined) return;
  if (fields.taskRef !== undefined) store.taskRef = fields.taskRef;
  if (fields.route !== undefined) store.route = fields.route;
}

/** Test-only: reset the call_id counter so pinned-envelope assertions do not
 *  depend on suite execution order. Production never calls this — the
 *  counter is meant to keep climbing for the life of the process. */
export function resetTraceCallIdForTest(): void {
  callIdClock = 0;
}

/**
 * The current call's own monotonic id, when known — "when known" matches
 * every other per-call envelope field (see `traceEnvelope`'s own doc
 * comment); `undefined` outside any `runWithTraceCall` scope.
 *
 * I-7 (2026-08-30 forensics attribution wave): exported so an emission site
 * whose underlying mechanism runs MORE THAN ONCE per tool call (a read-only
 * preflight that probes the same code path the real serve later re-runs,
 * e.g. `canServeCachedTaskPackReceipt` ahead of the real
 * `tryServeCachedPack`) can dedupe to one trace line per CALL rather than per
 * invocation — see readCodeTaskPack.ts's `receipt_next_repair` emission for
 * the concrete case this exists for.
 */
export function currentTraceCallId(): number | undefined {
  return _traceCallContext.getStore()?.callId;
}

/**
 * The common envelope every trace record carries, folded into both
 * `trace()` and `traceCausalAttestation()` — see this file's V10-02 header
 * doc for the field-by-field rationale. Spread AFTER a record's own
 * event-specific payload wherever it is used, so these seven names can never
 * be shadowed by an unrelated payload field of the same name.
 */
function traceEnvelope(workspaceRoot: string): Record<string, unknown> {
  const ctx = _traceCallContext.getStore();
  return {
    trace_id: TRACE_ID,
    ...(ctx?.callId !== undefined ? { call_id: ctx.callId } : {}),
    ...(ctx?.taskRef !== undefined ? { task_ref: ctx.taskRef } : {}),
    ...(ctx?.route !== undefined ? { route: ctx.route } : {}),
    flags_active: activeExperimentFlags(),
    workspaceRef: workspaceRefOf(workspaceRoot),
    protocol_era: resolveProtocolEra(),
  };
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/**
 * Test-only override. `undefined` (the normal path) means "read the env at
 * call time".
 *
 * T2 (2026-08-02, P1 shadow prerequisite): this used to be
 * `let traceEnabled = process.env.TL_TRACE === "1"` — evaluated ONCE at module
 * load, which contradicted flags.ts's documented "reads process.env at call
 * time so tests can manipulate env per-test" contract and made the channel
 * untestable without setTraceEnabledForTest. It also disagreed with the
 * (orphaned) flags.ts traceEnabled() on `TL_TRACE=true`: strict `=== "1"` said
 * off, parseBool said on. There is now ONE predicate.
 */
let traceOverride: boolean | undefined;

/** Monotonic counter; intentionally NOT Date.now. */
let tsClock = 0;

/** Cache of already-created trace file directories to avoid repeated mkdirSync. */
const dirCreated = new Set<string>();

/** Trace paths that already received this server process's causal attestation. */
const attestedTracePaths = new Set<string>();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sha8(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 8);
}

/**
 * FX-R3 (2026-09-03, round-18B finding 7): hash an absolute filesystem path
 * (or any other caller-shaped string a call site would otherwise put verbatim
 * into a trace payload) before it reaches a `trace()` event. Same convention
 * as `handleCodec.ts`'s `workspaceRefOf` — a truncated sha256, never the raw
 * value — deliberately NOT applied generically to every trace payload:
 * `p1CausalAttestationPayload`'s `workspace_root` field carries the raw
 * canonical path ON PURPOSE (`record_run.mjs` joins a trace file to a bench
 * cell by matching it exactly; see this module's header doc), so a blanket
 * redaction over all payloads would silently break that join. Call sites that
 * would otherwise emit a raw path in a NEW event (e.g. `server.ts`'s
 * `cwd_near_miss_resolved`/`cwd_near_miss_pool_too_large`) hash it through
 * this at the call site instead.
 */
export function hashedTraceValue(value: string): string {
  return createHash("sha256").update(`trace-value:${value}`).digest("hex").slice(0, 16);
}

const CONFIG_SHA256_RE = /^[0-9a-f]{64}$/;
const RUN_NONCE_RE = /^[A-Za-z0-9_.-]{1,200}$/;

// ---------------------------------------------------------------------------
// Workspace canonicalization
// ---------------------------------------------------------------------------

/**
 * ONE canonical spelling of a workspace root, used by BOTH the trace filename
 * (`sha8` input) and the attestation's `workspace_root`.
 *
 * `record_run.mjs` joins a trace file to a bench cell by hashing the solver's
 * workspace root and matching `record.workspace_root` exactly. If the server
 * and the harness canonicalize differently the join silently fails — and on
 * macOS it WOULD have: a bench worktree under `/var/...` realpaths to
 * `/private/var/...`, so the server's raw spelling and the harness's canonical
 * one never matched. Mirrors the bench-side `canonicalizeWorkspaceRoot`.
 *
 * Rules, in order:
 *  1. `path.resolve` — absolutize and normalize `.`/`..`.
 *  2. `fs.realpathSync` — resolve every symlink to its real path.
 *  3. On any realpath failure (a not-yet-created worktree, EACCES, a broken
 *     link) keep the step-1 result. Same fallback as the bench helper.
 *  4. Strip a trailing separator, except from a filesystem root.
 *  5. NO case folding — a case-insensitive filesystem still stores one true
 *     spelling, and folding would merge two roots that realpath kept distinct.
 *
 * Memoized for the process: `trace()` runs on a hot path and would otherwise
 * pay a `realpath` syscall per line. The consequence is deliberate — a root
 * keeps one identity for the lifetime of the process even if the symlink is
 * repointed under it, which is what a per-run attestation wants.
 */
const canonicalRootCache = new Map<string, string>();

export function canonicalizeWorkspaceRoot(workspaceRoot: string): string {
  const cached = canonicalRootCache.get(workspaceRoot);
  if (cached !== undefined) return cached;

  const resolved = path.resolve(workspaceRoot);
  let canonical: string;
  try {
    canonical = fs.realpathSync(resolved);
  } catch {
    canonical = resolved;
  }
  if (canonical.length > 1 && canonical.endsWith(path.sep)) {
    const trimmed = canonical.slice(0, -1);
    // Never trim a root ("/" on POSIX, "C:\" on Windows) down to something
    // that no longer names a directory.
    if (path.dirname(trimmed) !== trimmed || trimmed.endsWith(":")) {
      canonical = trimmed;
    }
  }
  canonicalRootCache.set(workspaceRoot, canonical);
  return canonical;
}

// ---------------------------------------------------------------------------
// Computed configuration digest
// ---------------------------------------------------------------------------

/**
 * Every flag `flags.ts` resolves, keyed by its env var name, read through the
 * ACCESSOR rather than the raw env so the digest covers EFFECTIVE values:
 * `TRUE`, `on` and `1` all fold to the same digest, and a flag left unset
 * contributes its documented default.
 *
 * This list is an explicit allowlist, which is what makes the two exclusions
 * structural rather than a filter that could be forgotten:
 * `TL_MCP_CONFIG_SHA256` (digest self-reference) and `TL_P1_CAUSAL_RUN_NONCE`
 * (per-run drift) are not flags.ts flags, so they cannot enter the input at
 * all. Adding a flag to flags.ts and forgetting it here weakens the digest but
 * cannot corrupt it; the trace spec pins that unrelated flags do move it.
 *
 * D10 (2026-08-14): the fifteen permanent-on flags left this list with their
 * readers. They are no longer configuration — an unconditional behaviour
 * contributes nothing to a digest of what the operator chose — so the digest
 * now covers exactly the out-of-contract (B)/(C) flags that can still vary.
 */
function resolvedFlagValues(): ReadonlyArray<readonly [string, string]> {
  const bool = (on: boolean): string => (on ? "1" : "0");
  // v0.14 flag inventory (2026-08-31): the six expired-experiment entries
  // left this list with their readers, same rule as D10's fifteen — a deleted
  // behaviour contributes nothing to a digest of what the operator chose.
  return [
    ["TL_GRAPH_INDEX", graphIndexMode()],
    ["TL_SEMANTIC_FRONTIER_GUARD", bool(semanticFrontierGuardEnabled())],
    // FX-R3 D5 (2026-09-04): THE PAID A/B ARMS MUST BE DISTINGUISHABLE. The
    // list above predates v0.15, so a treatment server (the ten Semantic
    // Frontier v2 flags plus TL_GRAPH_EVIDENCE, all on) and a control server
    // (all off) hashed to the SAME `config_sha256` — the p1 causal
    // attestation could not tell the two arms apart, which is exactly what
    // that digest exists to prove. `semanticFrontierV2FlagValues()` walks the
    // frozen registry through the accessors (see its own doc in flags.ts):
    // effective values, registry order, and a compile error rather than a
    // silent omission if a future flag is added without an accessor.
    ["TL_GRAPH_EVIDENCE", graphEvidenceMode()],
    ...semanticFrontierV2FlagValues(),
    // The raw env-resolved value, NOT the test override: an override is not
    // configuration and must not move a production digest.
    ["TL_TRACE", bool(traceEnabled())],
  ];
}

/**
 * Build identity of the running server, resolved WITHOUT importing server.ts
 * — server.ts imports this module, so asking it directly would be a cycle.
 *
 * Reuses `deriveServerBuildId`'s two-tier rule against the server ENTRY module
 * (this file's parent directory), so tier 1 finds the `.build-stamp` that
 * `scripts/write-build-stamp.mjs` writes beside it — a content hash over the
 * whole dist tree, which is what actually answers "did any server code
 * change?". Falls back to this module's own stat fingerprint under `tsx`
 * (running from `src/`, where no stamp exists), and to the literal
 * `"unavailable"` when nothing is derivable, so the digest stays deterministic
 * in every case.
 *
 * Computed once per process: it cannot change while the process runs, and
 * recomputing would add a stat to the attestation path for no information.
 */
const SERVER_BUILD_IDENTITY: string = (() => {
  try {
    const selfPath = fileURLToPath(import.meta.url);
    const parent = path.dirname(path.dirname(selfPath));
    for (const candidate of [
      path.join(parent, "server.js"),
      path.join(parent, "server.ts"),
      selfPath,
    ]) {
      if (!fs.existsSync(candidate)) continue;
      const derived = deriveServerBuildId(pathToFileURL(candidate).href);
      if (derived !== undefined) return derived;
    }
  } catch {
    // fall through to the honest sentinel
  }
  return "unavailable";
})();

/**
 * The server's OWN digest over its resolved configuration.
 *
 * `config_sha256` is a verbatim echo of `TL_MCP_CONFIG_SHA256`: whoever can
 * set that env var is the attester, so the field cannot by itself establish
 * what the server ran. This one is computed here, from state the server
 * resolved for itself, so an analyzer can hold the injected value against an
 * independent statement.
 *
 * CANONICAL DIGEST INPUT — SHA-256 over exactly this UTF-8 byte string:
 *
 *     "tl-mcp-config-digest/v1\n"
 *     "build\x00" <SERVER_BUILD_IDENTITY> "\n"
 *     ( "flag\x00" <ENV_NAME> "\x00" <EFFECTIVE_VALUE> "\n" ) *
 *
 * where the flag lines are every entry of `resolvedFlagValues()` sorted
 * ascending by `ENV_NAME` (plain code-unit order, locale-independent), values
 * are `"1"`/`"0"` for booleans and the resolved enum string otherwise, `\x00`
 * is a literal NUL separator (impossible in an env NAME, so no field can be
 * confused with another), and every line ends `\n`. The version prefix lets a
 * future input change be told apart from a configuration change.
 *
 * EXCLUDED BY CONSTRUCTION: `TL_MCP_CONFIG_SHA256` (including it would make
 * the digest self-referential) and `TL_P1_CAUSAL_RUN_NONCE` (it changes every
 * run, which would destroy the across-run comparability the digest exists
 * for). Neither is reachable: the input is built from the flags.ts allowlist,
 * not from `process.env` iteration.
 *
 * Deterministic across restarts of identical code and configuration; changes
 * when any effective flag changes or the server build changes.
 */
export function computedConfigSha256(): string {
  const lines = [
    "tl-mcp-config-digest/v1\n",
    `build\u0000${SERVER_BUILD_IDENTITY}\n`,
    ...[...resolvedFlagValues()]
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([name, value]) => `flag\u0000${name}\u0000${value}\n`),
  ];
  return createHash("sha256").update(lines.join(""), "utf8").digest("hex");
}

function p1CausalAttestationPayload(
  workspaceRoot: string,
  filePath: string,
): object | undefined {
  const configSha256 = process.env["TL_MCP_CONFIG_SHA256"];
  const runNonce = process.env["TL_P1_CAUSAL_RUN_NONCE"];
  if (
    configSha256 === undefined
    || !CONFIG_SHA256_RE.test(configSha256)
    || runNonce === undefined
    || !RUN_NONCE_RE.test(runNonce)
  ) {
    return undefined;
  }
  return {
    source: "tokenlighten-mcp-server",
    // Injected by the launcher and echoed verbatim — kept so an analyzer can
    // compare what it was TOLD against what the server COMPUTED below.
    config_sha256: configSha256,
    computed_config_sha256: computedConfigSha256(),
    // Already canonical: traceCausalAttestation canonicalizes once and passes
    // the same string here and to getTracePath, so the filename and the
    // payload can never disagree.
    workspace_root: workspaceRoot,
    trace_file: path.basename(filePath),
    run_nonce: runNonce,
    // v0.14 flag inventory (2026-08-31): the P1 evidence-completion lever and
    // its two siblings were deleted with their experiment, so a live server
    // has no ablation flags left to attest. The key stays (consumers validate
    // "must be an object"); a NEW manifest analyzed by the retired
    // p1_causal.py analyzer now fails its flag-match loudly, which is the
    // correct fail-closed posture for a lever that no longer exists.
    // Historical run artifacts keep their recorded values and stay analyzable.
    effective_flags: {},
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function getTracePath(workspaceRoot: string): string {
  const home = process.env.HOME ?? os.homedir();
  const dir = path.join(home, ".tokenlighten", "trace");
  // Canonicalize before hashing so `/var/…` and `/private/var/…`, a symlinked
  // worktree and a trailing-separator spelling all name ONE trace file.
  // Idempotent, so callers that already canonicalized pay only a cache hit.
  return path.join(dir, `${process.pid}-${sha8(canonicalizeWorkspaceRoot(workspaceRoot))}.jsonl`);
}

/**
 * Whether the trace channel is live right now. Single source of truth for
 * TL_TRACE, shared with flags.ts's `traceEnabled()`.
 */
export function isTraceEnabled(): boolean {
  return traceOverride ?? traceEnabled();
}

function appendTraceRecords(filePath: string, records: object[]): boolean {
  const dir = path.dirname(filePath);
  try {
    if (!dirCreated.has(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      dirCreated.add(dir);
    }
    fs.appendFileSync(
      filePath,
      records.map((record) => JSON.stringify(record)).join("\n") + "\n",
      "utf8",
    );
    return true;
  } catch {
    // Trace failures must never crash the server.
    return false;
  }
}

/** Emit launch/config identity without adding anything to an MCP response. */
export function traceCausalAttestation(workspaceRoot: string): void {
  if (!isTraceEnabled()) return;
  // Canonicalize ONCE and use that one string for both the file identity and
  // the payload — the harness matches them against each other.
  const canonicalRoot = canonicalizeWorkspaceRoot(workspaceRoot);
  const filePath = getTracePath(canonicalRoot);
  if (attestedTracePaths.has(filePath)) return;
  const attestation = p1CausalAttestationPayload(canonicalRoot, filePath);
  if (attestation === undefined) return;
  if (appendTraceRecords(filePath, [
    // V10-02: envelope spread AFTER the attestation payload — see
    // traceEnvelope's doc comment. `attestation.workspace_root` (the raw
    // canonical path, needed so record_run.mjs can join a trace file to a
    // bench cell) and the envelope's `workspaceRef` (the opaque sha) are
    // deliberately DIFFERENT fields; neither shadows the other.
    { event: "p1_causal_attestation", ts: tsClock++, ...attestation, ...traceEnvelope(canonicalRoot) },
  ])) {
    attestedTracePaths.add(filePath);
  }
}

export function trace(event: string, payload: object, workspaceRoot: string): void {
  if (!isTraceEnabled()) return;
  traceCausalAttestation(workspaceRoot);
  appendTraceRecords(
    getTracePath(workspaceRoot),
    // V10-02: envelope spread AFTER payload so trace_id/call_id/task_ref/
    // route/flags_active/workspaceRef/protocol_era are never shadowable by
    // an unrelated payload field a call site happens to name the same way.
    [{ event, ts: tsClock++, ...payload, ...traceEnvelope(workspaceRoot) }],
  );
}

/** Maximum bytes for a single trace JSONL record, including its envelope. */
export const TRACE_RECORD_BYTE_CAP = 12 * 1024;

type TraceRecord = Record<string, unknown>;

function traceRecordFor(event: string, payload: TraceRecord, workspaceRoot: string): TraceRecord {
  // Keep this construction byte-for-byte equivalent to trace()'s record
  // shape: the common envelope is part of the budget, not an afterthought.
  return { event, ts: tsClock, ...payload, ...traceEnvelope(workspaceRoot) };
}

function jsonCloneRecord(record: TraceRecord): TraceRecord {
  return JSON.parse(JSON.stringify(record)) as TraceRecord;
}

function arraySlots(value: unknown, found: unknown[][] = []): unknown[][] {
  if (Array.isArray(value)) {
    found.push(value);
    for (const item of value) arraySlots(item, found);
  } else if (value !== null && typeof value === "object") {
    for (const item of Object.values(value as TraceRecord)) arraySlots(item, found);
  }
  return found;
}

function noteTraceArrayTruncation(payload: TraceRecord, count: number): void {
  if (count <= 0) return;
  const prior = payload["truncated_count"];
  if (prior !== null && typeof prior === "object" && !Array.isArray(prior)) {
    const counts = prior as TraceRecord;
    const existing = typeof counts["trace_arrays"] === "number" ? counts["trace_arrays"] : 0;
    counts["trace_arrays"] = existing + count;
  } else {
    payload["truncated_count"] = { trace_arrays: count };
  }
}

/**
 * Emit an event with a real JSONL record cap.  Unlike trace(), this is for a
 * bounded shadow whose rich payload contains arrays that may need shaving;
 * trace() remains intentionally unchanged for existing observation records.
 */
export function traceBounded(
  event: string,
  payload: TraceRecord,
  workspaceRoot: string,
  minimumPayload: TraceRecord,
  cap = TRACE_RECORD_BYTE_CAP,
): boolean {
  if (!isTraceEnabled()) return false;
  traceCausalAttestation(workspaceRoot);

  const fits = (candidate: TraceRecord): boolean =>
    Buffer.byteLength(JSON.stringify(traceRecordFor(event, candidate, workspaceRoot)), "utf8") <= cap;
  let bounded = jsonCloneRecord(payload);
  let shaved = 0;
  while (!fits(bounded)) {
    const slots = arraySlots(bounded).filter((slot) => slot.length > 0);
    if (slots.length === 0) break;
    // Remove from the heaviest currently-present array first.  Recompute each
    // pass because a nested candidate can disappear with its parent.
    const slot = slots.sort((left, right) => JSON.stringify(right).length - JSON.stringify(left).length)[0]!;
    slot.pop();
    shaved += 1;
    noteTraceArrayTruncation(bounded, 1);
  }
  if (!fits(bounded)) {
    bounded = jsonCloneRecord(minimumPayload);
    // The fallback itself proves that rich fields were omitted, even when
    // every array had already been shaved before a scalar forced fallback.
    noteTraceArrayTruncation(bounded, Math.max(1, shaved));
  }
  if (!fits(bounded)) {
    // The supplied minimum is designed to fit for Semantic Frontier.  Keep a
    // final cap-preserving escape hatch for future callers with pathological
    // scalar input; observability must never create an over-cap JSONL line.
    bounded = { trace_truncated: true, truncated_count: { trace_arrays: Math.max(1, shaved) } };
  }
  const record = traceRecordFor(event, bounded, workspaceRoot);
  if (Buffer.byteLength(JSON.stringify(record), "utf8") > cap) return false;
  const wrote = appendTraceRecords(getTracePath(workspaceRoot), [record]);
  if (wrote) tsClock += 1;
  return wrote;
}

/**
 * A compact binding to the exact final MCP response bytes.  The nonce is
 * supplied only by the P1 runner and is never copied into the response or a
 * semantic record.  This deliberately hashes the complete final text rather
 * than a parsed projection: codec/shedding/fail-closed changes therefore
 * cannot be hidden behind an equivalent-looking body.  It is a correlation
 * witness, not a capability or a secret-bearing protocol field.
 */
export function responseWitnessHmac(finalResponseText: string, runNonce = process.env["TL_P1_CAUSAL_RUN_NONCE"]): string | undefined {
  if (typeof runNonce !== "string" || !RUN_NONCE_RE.test(runNonce)) return undefined;
  return `hmac-sha256:${createHmac("sha256", runNonce)
    .update("tokenlighten.semantic-frontier.response.v1\\0", "utf8")
    .update(finalResponseText, "utf8")
    .digest("hex")}`;
}

/** Force the channel on/off for a test; pass `undefined` to restore env control. */
export function setTraceEnabledForTest(enabled: boolean | undefined): void {
  traceOverride = enabled;
  // Reset path-local caches so tests with different HOME values don't reuse stale state.
  dirCreated.clear();
  attestedTracePaths.clear();
  // A test may recreate a workspace path with different symlink targets
  // between cases; a memoized canonical root would outlive it.
  canonicalRootCache.clear();
}
