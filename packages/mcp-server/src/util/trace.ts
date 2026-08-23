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

import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { fileURLToPath, pathToFileURL } from "node:url";
import { AsyncLocalStorage } from "node:async_hooks";

import {
  activeExperimentFlags,
  adaptiveWholeFileEnabled,
  evidenceCompletionEnabled,
  evidenceCompletionShadowEnabled,
  graphIndexMode,
  hop1ClosureEnabled,
  traceEnabled,
  verificationRecipeEnabled,
  writeCapabilityEnabled,
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
  return [
    ["TL_ADAPTIVE_WHOLE_FILE", bool(adaptiveWholeFileEnabled())],
    ["TL_EVIDENCE_COMPLETION", bool(evidenceCompletionEnabled())],
    ["TL_EVIDENCE_SHADOW", bool(evidenceCompletionShadowEnabled())],
    ["TL_GRAPH_INDEX", graphIndexMode()],
    ["TL_HOP1_CLOSURE", bool(hop1ClosureEnabled())],
    // The raw env-resolved value, NOT the test override: an override is not
    // configuration and must not move a production digest.
    ["TL_TRACE", bool(traceEnabled())],
    ["TL_VERIFICATION_RECIPE", bool(verificationRecipeEnabled())],
    ["TL_WRITE_CAPABILITY", bool(writeCapabilityEnabled())],
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
    effective_flags: {
      TL_EVIDENCE_COMPLETION: evidenceCompletionEnabled() ? "1" : "0",
      TL_EVIDENCE_SHADOW: evidenceCompletionShadowEnabled() ? "1" : "0",
      TL_WRITE_CAPABILITY: writeCapabilityEnabled() ? "1" : "0",
    },
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
