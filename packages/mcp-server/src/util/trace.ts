/**
 * trace.ts — opt-in JSONL trace writer for v0.7 developer observability.
 *
 * Enable with TL_TRACE=1. When disabled all calls are no-ops.
 * Output: ~/.tokenlighten/trace/<pid>-<sha8(workspaceRoot)>.jsonl
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { fileURLToPath, pathToFileURL } from "node:url";

import {
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
    { event: "p1_causal_attestation", ts: tsClock++, ...attestation },
  ])) {
    attestedTracePaths.add(filePath);
  }
}

export function trace(event: string, payload: object, workspaceRoot: string): void {
  if (!isTraceEnabled()) return;
  traceCausalAttestation(workspaceRoot);
  appendTraceRecords(
    getTracePath(workspaceRoot),
    [{ event, ts: tsClock++, ...payload }],
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
