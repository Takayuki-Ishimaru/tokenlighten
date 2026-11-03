// task-binding — extracted implementation; imports point to the owning modules.
import type { ExecutedSearchAbsence } from "../util/packServeLog.js";
import type { ExecutedSearchHit } from "../util/packServeLog.js";
import type { TaskContractScope } from "../features/task-pack/taskContractStore.js";
import type { ToolCallResult } from "../protocol/result.js";
import { hasPendingExecutableNext } from "../features/task-pack/taskContractStore.js";
import { hasPrescribedSearchTerm } from "../util/packServeLog.js";
import { normalizeContractLane } from "../util/packServeLog.js";
import { rawContractQueryForScope } from "../features/task-pack/taskContractStore.js";
import { recordExecutedSearchResult } from "../util/packServeLog.js";
import { recoverHandlelessTaskScope } from "../features/task-pack/taskContractStore.js";
import { resolveExecutableNextScope } from "../features/task-pack/taskContractStore.js";
import { resolveTaskHandle } from "../state/stateHandles.js";
import { resolveTaskQueryRef } from "../state/session.js";
import { shaOfText } from "../util/handles.js";
import { taskQueryRef } from "../state/session.js";
import { tokenizeForEpoch } from "../state/session.js";
import { toolStructuredError } from "../protocol/result.js";

// One fixed lane value per concurrent agent; 64 chars is plenty for any
// orchestrator-assigned key and keeps composite session keys bounded.
export const SESSION_LANE_MAX_CHARS = 64;

/** Structured refusal for a malformed `lane`, or null when the lane is usable. */
export function sessionLaneRefusal(args: Record<string, unknown>) {
  const raw = args["lane"];
  if (raw === undefined || (typeof raw === "string" && raw.length <= SESSION_LANE_MAX_CHARS)) return null;
  // A partition key is never coerced: silently landing a call in the wrong
  // lane is the exact cross-agent mixing lanes exist to prevent.
  return toolStructuredError({
    ok: false,
    reason: "invalid-lane",
    error: `lane must be a string of at most ${SESSION_LANE_MAX_CHARS} characters — one fixed value per concurrent agent`,
    detail: "re-issue this exact call with a valid lane, or omit lane to use the shared default session",
  });
}

/** The validated lane of a call; "" (the shared default session) when absent. */
export function sessionLaneOf(args: Record<string, unknown>): string {
  const raw = args["lane"];
  return typeof raw === "string" && raw.length <= SESSION_LANE_MAX_CHARS ? raw : "";
}

/**
 * A-F1: the lane as every CONTRACT-scoped ledger keys it.
 *
 * `sessionLaneOf` answers a different question — WorkspaceSession's lane, whose
 * documented sentinel for "no lane" is `""` ("the historical shared session,
 * byte-for-byte"). Contract state (the executed-next ledger, the task-contract
 * store) spells that same absence `"default"`. Mixing the two split the
 * executed-next ledger in half: the writer below recorded under `""` while both
 * readers looked under `"default"`, so the no-repeat gate addressed an empty
 * partition on every lane-less call. Contract-keyed call sites use THIS helper;
 * session-keyed ones keep `sessionLaneOf`.
 */
export function contractLaneOf(args: Record<string, unknown>): string {
  return normalizeContractLane(sessionLaneOf(args));
}

/** Resolve the caller-visible task handle to its stable server-owned identity. */
export function canonicalTaskBindingForHandle(workspace: string, taskHandle: unknown): string | undefined {
  if (typeof taskHandle !== "string" || taskHandle.length === 0) return undefined;
  const resolved = resolveTaskHandle(taskHandle, workspace);
  return resolved.ok ? resolved.state.taskFingerprint : undefined;
}

/**
 * `task_handle` is the normalized form of canonical `task.handle`. The
 * fingerprint is internal only: it partitions result-consumption state but is
 * never accepted as an independent wire argument or projected back out.
 */
export function canonicalTaskBindingOf(args: Record<string, unknown>, workspace: string): string | undefined {
  return canonicalTaskBindingForHandle(workspace, args["task_handle"]);
}

/**
 * The stored task identity, `task-<sha16(profile NUL query)>` — the same
 * derivation `projectTaskPackWire` and readCodeTaskPack.ts's
 * `deterministicCertificate` spell inline. The separator is built from its
 * code point because a NUL escape cannot ride an edit payload.
 */
export const TASK_FINGERPRINT_SEPARATOR = String.fromCharCode(0);

export function taskFingerprintFor(profile: string, query: string): string {
  return `task-${shaOfText(`${profile}${TASK_FINGERPRINT_SEPARATOR}${query}`).replace(/^sha256:/, "").slice(0, 16)}`;
}

/**
 * A prescribed search next deliberately need not expose a task handle. Bind
 * its result only when pending-next provenance resolves to exactly one task
 * in this lane; unregistered or colliding searches remain unbound.
 */
export function canonicalTaskBindingForExecutedCall(
  canonical: string,
  args: Record<string, unknown>,
  workspace: string,
): string | undefined {
  const direct = canonicalTaskBindingOf(args, workspace);
  if (direct !== undefined || canonical !== "tl_search_files") return direct;
  const action = typeof args["action"] === "string" ? args["action"] : undefined;
  if (action === undefined) return undefined;
  const candidates: Array<{ tool: string; arguments: Record<string, unknown> }> = [];
  if (action === "find") {
    const queries = Array.isArray(args["queries"])
      ? args["queries"].filter((value): value is string => typeof value === "string")
      : [];
    if (queries.length > 0) candidates.push({ tool: canonical, arguments: { action, queries } });
    if (queries.length === 1) candidates.push({ tool: canonical, arguments: { action, query: queries[0]! } });
    if (typeof args["query"] === "string") candidates.push({ tool: canonical, arguments: { action, query: args["query"] } });
  } else if (action === "references") {
    const scope = args["scope"];
    const symbol = scope !== null && typeof scope === "object"
      ? (scope as { symbol?: unknown }).symbol
      : args["query"];
    if (typeof symbol === "string" && symbol !== "") candidates.push({ tool: canonical, arguments: { action, query: symbol } });
  } else if (action === "tree") {
    candidates.push({
      tool: canonical,
      arguments: typeof args["path"] === "string" ? { action, path: args["path"] } : { action },
    });
  }
  for (const candidate of candidates) {
    const scope = resolveExecutableNextScope(workspace, contractLaneOf(args), candidate);
    const binding = canonicalTaskBindingForHandle(workspace, scope?.taskHandle);
    if (binding !== undefined) return binding;
  }
  return undefined;
}

/**
 * R1-S10a: the TERMS a pack's own `tl_search_files` next asks the caller to look up.
 *
 * Only the three term actions (`find` in both spellings, `symbols`, `locate`) —
 * `references` and `tree` answer different questions and the result ledger
 * deliberately does not record them. Tolerates the wire spelling of the call,
 * whose `arguments` also carry `cwd`/`lane`/`task`; only the query fields are read.
 */
export function prescribedSearchTermsOf(next: unknown): string[] {
  if (next === null || typeof next !== "object") return [];
  const call = next as { tool?: unknown; arguments?: unknown };
  if (call.tool !== "tl_search_files") return [];
  const callArgs = call.arguments;
  if (callArgs === null || typeof callArgs !== "object" || Array.isArray(callArgs)) return [];
  const record = callArgs as { action?: unknown; query?: unknown; queries?: unknown };
  if (record.action !== "find" && record.action !== "symbols" && record.action !== "locate") return [];
  const terms: string[] = [];
  if (Array.isArray(record.queries)) {
    for (const entry of record.queries) {
      if (typeof entry === "string" && entry.length > 0 && !terms.includes(entry)) terms.push(entry);
    }
  }
  if (typeof record.query === "string" && record.query.length > 0 && !terms.includes(record.query)) {
    terms.push(record.query);
  }
  return terms;
}

/**
 * R1-S10a (2026-09-13 review round): did a pack in this lane prescribe a search
 * for THIS TERM — in any of the three spellings of the one question the result
 * ledger answers?
 *
 * `find`/`symbols`/`locate` are interchangeable on the way IN (the ledger keys
 * on the term, never the action, precisely so a pack's `find` next can be
 * answered by the caller's `symbols` run), so they are interchangeable here too:
 * a pack that asked "where is `t`" authorizes learning from whichever of the
 * three the caller reached for. What is NOT authorized is a term no pack asked
 * about at all.
 *
 * Read-only (`hasPendingExecutableNext`, never `resolve`/`consume`): the callers
 * below must ask this BEFORE the sibling absence/hit concern recorders spend the
 * same capability, and a probe must not memoize a miss — see that function's own
 * doc comment for both traps.
 */
export function termSearchWasPrescribed(
  workspace: string,
  args: Record<string, unknown>,
  term: string,
): boolean {
  if (term.length === 0) return false;
  const lane = sessionLaneOf(args);
  // The prescription ledger: what a pack in this lane actually asked for, by
  // term, recorded at the pack exit from whichever carrier held the next.
  if (hasPrescribedSearchTerm(workspace, lane, term, canonicalTaskBindingForExecutedCall("tl_search_files", args, workspace))) {
    return true;
  }
  // The executable-next registry, as the stricter second door: when a pack DID
  // register a pending next (the `next_call` carrier), executing it is
  // prescription with per-task provenance. Read-only, never consuming — the
  // sibling concern recorders in this dispatch spend that capability themselves.
  const shapes: Array<Record<string, unknown>> = [
    { action: "find", query: term },
    { action: "find", queries: [term] },
    { action: "symbols", query: term },
    { action: "locate", query: term },
  ];
  return shapes.some((shape) => hasPendingExecutableNext(workspace, lane, {
    tool: "tl_search_files",
    arguments: shape,
  }));
}

/**
 * TL142-01A/01B (2026-09-13): record WHAT an executed term search found, beside
 * the existing `recordExecutedSearch` calls that record only THAT it ran.
 *
 * One helper for all three term actions (`find` in both its `query` and
 * `queries[]` spellings, `symbols`, `locate`) so the ledger can never learn a
 * result under one action's spelling and be unable to answer for another's —
 * the exact defect `consultExecutedLocate`'s hard-wired `"locate"` key had.
 * Lane is normalized inside `executedNextLedgerKey`, so passing the session
 * spelling here keys identically to the contract spelling `recordExecutedNext`
 * passes.
 */
export function recordTermSearchResult(
  workspace: string,
  args: Record<string, unknown>,
  action: string,
  term: string,
  hits: readonly ExecutedSearchHit[],
  provenAbsence: ExecutedSearchAbsence | undefined,
  prescribed: boolean,
): void {
  if (term.length === 0) return;
  // R1-S10a (2026-09-13 review round): THE PRESCRIBED-CALL FENCE.
  //
  // This ledger is read by `executedSearchHitSeeds` (which makes a located path
  // a surface of the next rebuild) and `promoteExecutedSearchAbsences` (which
  // mints a `request-item-absent` gap on a CERTIFIED decision). That is
  // certificate-grade state, and it was being written by EVERY find/symbols/
  // locate — the sibling recorder `recordAuthoritativeAbsentConcerns` beside it
  // has always required a server-prescribed call. So a search no pack ever asked
  // for could move an unrelated task's decision. The caller decides what to
  // search; only the pack that PRESCRIBED a search may learn from its result.
  //
  // Fail-closed: an unprescribed search records nothing at all, which leaves the
  // pack proposing its own search — the same direction every other honesty gate
  // in this file takes.
  if (!prescribed) return;
  try {
    recordExecutedSearchResult(
      workspace,
      sessionLaneOf(args),
      {
        term,
        action,
        hits,
        ...(provenAbsence !== undefined ? { absence: provenAbsence } : {}),
      },
      canonicalTaskBindingForExecutedCall("tl_search_files", args, workspace),
    );
  } catch {
    // A ledger write is never worth failing a served search over.
  }
}

/**
 * TL142-01B: the ONE place that decides whether a zero-result `find` is a
 * workspace-wide PROOF this server may later act on.
 *
 * Four conjuncts, all fail-closed:
 *  - the response issued its own `absence` certificate (findText.ts's
 *    `buildAbsenceExtra` already refuses to issue one over an oversize or
 *    undecodable remainder);
 *  - that certificate carries NO `caveat` — a caveat names paths excluded from
 *    the scan, so the claim is about a subset, not the workspace;
 *  - the call narrowed nothing (`scope.path`, normalized to `args.path`): a
 *    subtree absence is not a workspace absence;
 *  - the call was literal, not a regex (a pattern's absence is not a term's).
 *
 * A partial-scope zero result returns undefined, which leaves the pack
 * proposing the search — the safe direction, and what the brief's "absence must
 * be scope-complete to count" requires.
 */
export function provenFindAbsence(
  args: Record<string, unknown>,
  body: Record<string, unknown>,
): ExecutedSearchAbsence | undefined {
  if (args["path"] !== undefined) return undefined;
  if (args["regex"] === true) return undefined;
  const absence = body["absence"];
  if (absence === null || typeof absence !== "object") return undefined;
  const record = absence as { caveat?: unknown; scanned_files?: unknown };
  if (record.caveat !== undefined) return undefined;
  // R1-B1 (2026-09-13 review round): the response's own machine-readable
  // exclusion disclosure, as a second, independent conjunct beside the caveat.
  // `buildAbsenceExtra` derives its caveat prose from the same omission counts,
  // so for today's `findText.ts` this is belt-and-braces — which is the point:
  // the recorded absence carries `omittedCount` onto the wire gap
  // (`promoteExecutedSearchAbsences`), so it must be READ off the body, never
  // assumed, and a disclosure class that grows a caveat-free spelling later
  // cannot silently back a "scope complete" claim.
  const omittedCount = disclosedOmissionCount(body);
  if (omittedCount > 0) return undefined;
  const scanned = typeof record.scanned_files === "number" ? record.scanned_files : 0;
  // R2-B14 (2026-09-13 review round 2): stamp WHEN this scan proved the absence.
  // `promoteExecutedSearchAbsences` reads it to refuse a proof the workspace has
  // since outgrown — see `ExecutedSearchAbsence.recordedAtMs`.
  return scanned > 0
    ? { scannedFiles: scanned, omittedCount, scopeComplete: true, recordedAtMs: Date.now() }
    : undefined;
}

/**
 * Paths a find response disclosed as EXCLUDED from its own scan (`omitted`).
 *
 * `outside_workspace` is deliberately not counted: it names paths outside the
 * workspace root, which a workspace-wide absence claim never covered in the
 * first place. Every other class (ignore rules, symlinks, non-text, secrets,
 * oversize, unreadable directories, product-rule source-only exclusions,
 * undecodable bytes) is content inside the workspace that this scan did not
 * read, so it bounds what the absence may claim.
 */
export function disclosedOmissionCount(body: Record<string, unknown>): number {
  const omitted = body["omitted"];
  if (omitted === null || typeof omitted !== "object") return 0;
  let total = 0;
  for (const [key, value] of Object.entries(omitted as Record<string, unknown>)) {
    if (key === "outside_workspace") continue;
    if (typeof value === "number" && value > 0) total += value;
  }
  return total;
}

/** Hit rows off a `find` response body (`files[].path` + its first matched line). */
export function findResponseHits(body: Record<string, unknown>): ExecutedSearchHit[] {
  const files = body["files"];
  if (!Array.isArray(files)) return [];
  const hits: ExecutedSearchHit[] = [];
  for (const raw of files) {
    if (raw === null || typeof raw !== "object") continue;
    const entry = raw as { path?: unknown; lines?: unknown };
    if (typeof entry.path !== "string" || entry.path.length === 0) continue;
    const line = Array.isArray(entry.lines) && typeof entry.lines[0] === "number" ? entry.lines[0] : undefined;
    hits.push({ path: entry.path, ...(line !== undefined ? { line } : {}) });
  }
  return hits;
}

/** The authenticated scope available internally for task-pack construction. */
export function taskContractScopeOf(args: Record<string, unknown>): TaskContractScope {
  const taskHandle = args["task_handle"];
  return {
    lane: sessionLaneOf(args),
    ...(typeof taskHandle === "string" && taskHandle.length > 0 ? { taskHandle } : {}),
  };
}

/**
 * R-A2 item 1 (2026-09-21 fix wave, held item 4): the epoch tokens a plain
 * caller-ranged read (this file's own single-target/batch ranged dispatch,
 * never a task-pack build) should attach its served span to in the read-only
 * epoch-served view (`recordReadOnlyServedRangedServe`, readCodeTaskPack.ts)
 * — so a later bare `{qref}` re-pack of the SAME declared-answer task can see
 * bytes a caller already zoomed to by handle instead of running the pack's
 * own `next`. See that function's own doc comment for the write-gate this
 * must respect (the read-only view, never the cumulative served-surface log).
 *
 * Returns:
 *  - `undefined` — do not record at all: an explicit `task.epoch:"new"`, an
 *    explicitly declared non-answer profile, or a `task.handle` that
 *    resolves (fails to resolve) to a DIFFERENT (non-answer) or unrecognized
 *    task. A handle the caller bothered to name is authoritative; this never
 *    second-guesses it by falling back to the lane's live view instead.
 *  - `[]` — no usable `task.handle` was named at all: let
 *    `recordReadOnlyServedRangedServe`'s own lane-scoped fallback decide (a
 *    live view for this lane can only ever hold a declared-answer epoch's
 *    tokens in the first place — see that module's write-gate).
 *  - a non-empty token list — the explicit, resolved epoch of the named
 *    `task.handle`, proven to have been packed under profile "answer" by the
 *    same fingerprint comparison `inheritDeclaredTaskProfile` already makes
 *    (`taskFingerprintFor`), never re-derived a second, divergent way.
 */
export function resolveDeclaredAnswerEpochTokens(workspace: string, args: Record<string, unknown>): string[] | undefined {
  if (args["taskEpoch"] === "new") return undefined;
  const declaredProfile = typeof args["taskProfile"] === "string" ? args["taskProfile"] : undefined;
  // "auto" declares nothing (it asks the server to infer) and is therefore
  // not treated as a blocking non-answer declaration; every other named
  // profile (generic, change_propagation, ...) is.
  if (declaredProfile !== undefined && declaredProfile !== "answer" && declaredProfile !== "auto") return undefined;
  const taskHandle = args["task_handle"];
  if (typeof taskHandle !== "string" || taskHandle.length === 0) return [];
  const scope = taskContractScopeOf(args);
  const storedQuery = rawContractQueryForScope(workspace, scope);
  if (storedQuery === undefined) return undefined;
  const binding = canonicalTaskBindingOf(args, workspace);
  if (binding === undefined || binding !== taskFingerprintFor("answer", storedQuery)) return undefined;
  return tokenizeForEpoch(storedQuery);
}

/**
 * A handleless re-pack can retain a task binding only through one exact,
 * unambiguous server-owned provenance record. New epochs and collisions stay
 * unbound so an unrelated task can never inherit another task's consumption.
 */
export function taskContractScopeForPack(
  args: Record<string, unknown>,
  workspace: string,
  query: string,
): TaskContractScope {
  const direct = taskContractScopeOf(args);
  if (direct.taskHandle !== undefined) return direct;
  return recoverHandlelessTaskScope(
    workspace,
    direct.lane,
    query,
    typeof args["taskEpoch"] === "string" ? args["taskEpoch"] : undefined,
  ) ?? direct;
}

/** Bytes of the payload an MCP client hands to the model: content[*].text only. */
export function modelVisibleBytes(result: { content: Array<{ text: string }> }): number {
  let bytes = 0;
  for (const item of result.content) bytes += Buffer.byteLength(item.text, "utf8");
  return bytes;
}

// Mirrors the `mode`/`action` enum literals advertised in the tl_read_file/
// tl_search_files tool input schemas above (see the `mode`/`action` `enum:`
// entries near each tool's registration) — kept as a private allowlist here,
// not a shared contract, purely so the diagnostics ring file (packages/usage's
// diagRing.ts) never carries anything but a known enum token in its `mode`
// field.
export const DIAG_READ_FILE_MODES = new Set([
  "auto", "skeleton", "symbol", "full", "pack", "map", "digest",
  "slice", "task_pack", "small_file", "artifact", "archive", "overview", "closure",
]);

export const DIAG_SEARCH_FILES_ACTIONS = new Set([
  "find", "symbols", "references", "diff", "locate", "tree",
]);

/** Diagnostics-only mode label for the last-call ring file — an enum value, never free user text. */
export function observedCallMode(canonical: string, args: Record<string, unknown>): string | undefined {
  if (canonical === "tl_read_file") {
    const mode = args["mode"];
    return typeof mode === "string" && DIAG_READ_FILE_MODES.has(mode) ? mode : undefined;
  }
  if (canonical === "tl_search_files") {
    const action = args["action"];
    return typeof action === "string" && DIAG_SEARCH_FILES_ACTIONS.has(action) ? action : undefined;
  }
  return undefined;
}

/**
 * Diagnostics-only envelope peek for the last-call ring file: the response
 * `kind` and, for a refusal, its short `code`. Parses content[0].text
 * defensively — malformed/missing JSON yields {} and this must never throw
 * or alter the MCP outcome.
 */
export function observedEnvelopeMeta(
  result: { content: Array<{ text: string }> },
): { kind?: string; errorCode?: string; retry?: string; field?: string } {
  try {
    const text = result.content[0]?.text;
    if (typeof text !== "string") return {};
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object") return {};
    const envelope = parsed as { kind?: unknown; code?: unknown; retry?: unknown; field?: unknown };
    return {
      kind: typeof envelope.kind === "string" ? envelope.kind : undefined,
      errorCode: typeof envelope.code === "string" ? envelope.code : undefined,
      retry: typeof envelope.retry === "string" ? envelope.retry : undefined,
      field: typeof envelope.field === "string" ? envelope.field : undefined,
    };
  } catch {
    return {};
  }
}

/**
 * V10-02: the qref/task-identity CLASS for THIS call, derived GENERICALLY
 * from `args.query` (a fresh request) or `args.qref` (a replay) so tl_read_file
 * and tl_search_files both feed the trace envelope's `task_ref` without their
 * own deep dispatch internals (resolveTaskPackQueryArg et al.) changing.
 * `repeated` means this ref was ALREADY the workspace session's active qref
 * before this call — a genuine same-qref re-pack. Returns undefined when
 * neither arg names a task (tl_edit_file; a path/handle-only read) — task_ref
 * stays a "when known" envelope field, never fabricated. Must run inside the
 * caller's OWN session lane (see the runWithSessionLane wrapper at the call
 * site below) — resolveTaskQueryRef reads lane-scoped session state.
 */
export function dispatchTaskRef(
  args: Record<string, unknown>,
  workspaceRoot: string,
): { ref: string; repeated: boolean } | undefined {
  const query = typeof args["query"] === "string" ? args["query"].trim() : "";
  if (query.length > 0) {
    const ref = taskQueryRef(workspaceRoot, query);
    return { ref, repeated: resolveTaskQueryRef(workspaceRoot, ref) !== undefined };
  }
  const qref = typeof args["qref"] === "string" ? args["qref"].trim() : "";
  if (qref.length === 0) return undefined;
  // An explicit qref is trustworthy for the envelope only once VERIFIED
  // against this session's own ledger — unverified it names no real task
  // (stale, foreign, or simply fabricated), so it is omitted rather than
  // echoing an unchecked caller string. Verified, a qref replay is BY
  // DEFINITION a repeat of the same task.
  return resolveTaskQueryRef(workspaceRoot, qref) !== undefined
    ? { ref: qref, repeated: true }
    : undefined;
}

/**
 * Public tool boundary. Usage recording is best-effort and deliberately sees
 * only derived counts; raw arguments and result content are never handed to
 * the recorder.
 *
 * V10-02: the WHOLE body runs inside runWithTraceCall so every trace() line
 * this invocation emits — route_decision below, and every downstream one
 * nested arbitrarily deep across awaits — shares one call_id. This is the
 * "per-call context setter from dispatch" the trace envelope depends on; see
 * util/trace.ts's V10-02 header doc.
 *
 * `requestMeta` is the `tools/call` params `_meta`, forwarded verbatim by both
 * transport legs (the hand-rolled legacy-era JSON-RPC transport and the modern
 * SDK v2 one). It is UNTRUSTED INPUT: the only thing read out of it is PI-03's
 * attestation channel, and that is authenticated before it can change
 * anything. Optional, so every existing caller — and every test — is unchanged.
 */
export const LEGACY_INPUT_FIELDS = new Set([
  "mode", "paths", "handles", "taskProfile", "taskEpoch", "task_handle",
  "outputCredentialRef", "maxBytes", "maxTokens", "limit",
]);

export function legacyInputRefusal(args: Record<string, unknown>): ToolCallResult | undefined {
  if (process.env["TL_LEGACY_INPUT"] === "accept") return undefined;
  const field = Object.keys(args).find((key) => LEGACY_INPUT_FIELDS.has(key));
  if (field === undefined) return undefined;
  return toolStructuredError({
    ok: false,
    error: `legacy input '${field}' is disabled; use the canonical protocol-v1 field shape`,
    code: "legacy-input",
    field,
    did_you_mean: ["task", "scope", "budget", "targets", "edits", "queries"],
    retry: "call",
  });
}
