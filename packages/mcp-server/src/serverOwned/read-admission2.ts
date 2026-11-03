import { taskPackRecoveryFor } from "./task-pack-recovery.js";
export { taskPackRecoveryFor } from "./task-pack-recovery.js";
// read-admission — extracted implementation; imports point to the owning modules.
import * as path from "path";
import type { McpLang } from "@tokenlighten/types";
import type { RefusalCode } from "@tokenlighten/types";
import type { ServedTextUndecodableReason } from "../util/textDecode.js";
import type { ServedTextVerdict } from "../util/textDecode.js";
import type { TaskProfileRequest } from "@tokenlighten/types";
import type { ToolCall } from "@tokenlighten/types";
import { ACTIVE_TOOL_SURFACE } from "../runtime/config.js";
import { CANONICAL_BUDGET } from "../protocol/toolSchemas.js";
import { CANONICAL_EDIT_ITEM } from "../protocol/toolSchemas.js";
import { CANONICAL_ORIGINAL_INPUT } from "./canonical-input2.js";
import { CANONICAL_SCOPE } from "../protocol/toolSchemas.js";
import { CANONICAL_SEARCH_BUDGET } from "../protocol/toolSchemas.js";
import { CANONICAL_SELECT } from "../protocol/toolSchemas.js";
import { CANONICAL_TARGET } from "../protocol/toolSchemas.js";
import { CANONICAL_TASK } from "../protocol/toolSchemas.js";
import { KILL_SWITCH } from "../runtime/config.js";
import { MARKDOWN_SECTIONS_HINT } from "../util/markdownSections.js";
import { MCP_LANGS } from "@tokenlighten/types";
import { NUL_STRIPPED_SERVE_NOTE } from "../util/textDecode.js";
import { PROTOCOL_META } from "../protocol/envelope.js";
import { QUERY_CANDIDATE_POLICY_INPUT } from "./canonical-input2.js";
import { SERVER_BUILD_ID } from "../runtime/config.js";
import { STALE_RANGE_PROBE_MAX_BYTES } from "./read-admission.js";
import { acknowledgeRangeStaleness } from "../state/session.js";
import { activeRoot } from "../runtime/config.js";
import { argv } from "../runtime/config.js";
import { buildMarkdownHeadingIndex } from "../util/markdownSections.js";
import { callPassedSurfaceRoles } from "../protocol/wireCompaction.js";
import { canonicalToolCall } from "../protocol/envelope.js";
import { claimServerBuildAnnouncement } from "../state/session.js";
import { clearPackDedupeForWorkspace } from "../features/task-pack/engine/packState.js";
import { clearTaskQueryRef } from "../state/session.js";
import { closed } from "../protocol/toolSchemas.js";
import { countLines } from "../util/countLines.js";
import { describeServedTextRefusal } from "../util/textDecode.js";
import { handleTable } from "../util/handles.js";
import { isRangeFullyCoveredBy } from "./read-admission.js";
import { isWithin } from "../util/safePath.js";
import { markRangeContinuationWatched } from "../state/session.js";
import { mergeRangeSpans } from "./read-admission.js";
import { mintedRangedContinuationWindows } from "../state/session.js";
import { noteNulStrippedServe } from "../protocol/envelope.js";
import { noteSurfaceRolesPassed } from "../protocol/envelope.js";
import { parseMarkdownHeadings } from "../util/markdownSections.js";
import { parseServedSpan } from "./read-admission.js";
import { readFileSafe } from "../util/safePath.js";
import { readFileSync } from "node:fs";
import { readServedTextSafe } from "../util/safePath.js";
import { realpathSync } from "node:fs";
import { rememberTaskQuery } from "../state/session.js";
import { resolveReal } from "../util/safePath.js";
import { resolveTaskQueryRef } from "../state/session.js";
import { resolveTaskQueryRefBinding } from "../state/session.js";
import { resolveTaskQueryRefSurfaceRoles } from "../state/session.js";
import { resolveWorkspaceRoot as resolveWorkspaceRootBase } from "../write/resolveWorkspace.js";
import { safeResolve } from "../util/safePath.js";
import { servedRangeStaleness } from "../state/session.js";
import { sessionLaneOf } from "./task-binding2.js";
import { shaOfText } from "../util/handles.js";
import { similarHeadingTexts } from "../util/markdownSections.js";
import { stashIndependentRangeStalenessNote } from "../util/packServeLog.js";
import { statSync } from "node:fs";
import { toolStructuredError } from "../protocol/result.js";

/**
 * TL-06 (plan-0143 §4/§8.1, R04, 2026-09-21): refuse — reusing the read
 * cursor's own `cursor-stale` vocabulary (server.ts's cursor-continuation
 * branch, ~:11633) — BEFORE the task-pack builder runs, when a caller-named
 * ranged path this epoch's own continuation already served lines of is about
 * to be re-served from a file revision that changed since.
 *
 * WHY THIS IS NEEDED AT ALL (plan-0143 §4, TL-01's `callerRangedAddress`,
 * canonicalDecision.ts): a multi-target caller-ranged `next` is addressed by
 * PATH, not by a sha-bound handle or cursor, so a verbatim follower that
 * re-issues it after the file changed mid-chain carries no sha of its own to
 * compare against — the wire call cannot detect the mismatch, only the
 * server's own served-range ledger can (`servedRangeStaleness`,
 * state/session.ts). Checked here, ahead of `buildTaskPack`/
 * `buildSeededTaskPack`, so a stale re-ask never reaches candidate/body
 * assembly at all — the same "admit before the builder runs" shape
 * `admitTaskPackBudget` above already uses for the byte-floor refusal.
 *
 * Scoped to CALLER-RANGED entries only (`entry.range !== undefined`): an
 * unranged `{path}` target is served as a whole-file read, which cannot mix
 * two revisions across hops the way a partial-window continuation can, so it
 * is left untouched here exactly as today.
 *
 * A HANDLE-ONLY entry (no `path` — the `handles=[]` A7 batch's own shape) is
 * watched/compared under its handle's OWN resolved path (`handleTable`), so
 * the identical protection covers a handle-addressed continuation, not just
 * a path-addressed one; the entry's own addressing (handle or path) is
 * preserved verbatim in the reconstructed `next` below — this function never
 * rewrites one into the other.
 *
 * GATE-A (2026-09-21, v0.14.4 candidate item 2) — NARROWED to genuine
 * continuations. The rule above, unqualified, refused pi03DedupHonesty's and
 * servedReceipts's "edit between two identical-range requests" flow, AND
 * reserveSmallWindows's "reuse the seeded task's handle to ask a small,
 * independent follow-up question about a window already served" flow — none
 * of these three is a continuation of anything the server minted; each is
 * either two unrelated top-level requests or a caller-authored follow-up
 * that happens to name a window already delivered.
 *
 * THE DISCRIMINATOR IS DATA, NOT A WIRE TOKEN. Two designs were tried and
 * rejected before this one: (a) "the incoming call's fingerprint already
 * appears in the executed-next ledger" (util/packServeLog.ts) is always true
 * for a caller who simply repeats an identical call, genuine continuation or
 * not — it cannot tell the two apart. (b) "the incoming call carries a
 * resolvable task binding" (`canonicalTaskBindingOf`) is neither necessary
 * (VS Code's `TL_LEAN_CALLS` drops `task.handle` from a plain targets-only
 * continuation whenever serving it does not strictly need one —
 * `continuationNeedsTaskHandle`, protocol/envelope.ts — so a genuine
 * continuation can arrive with NO handle at all) nor sufficient (reserveSmall
 * Windows deliberately reuses one task's handle across independent
 * follow-up sub-questions — an encouraged, documented pattern, not evidence
 * of continuing an interrupted delivery).
 *
 * What is both necessary and sufficient: a genuine continuation, BY
 * CONSTRUCTION (`callerRangedAddress`, `partialFallback`), only ever asks
 * for the window this path has NOT yet delivered — it advances the
 * boundary. An independent re-read, whatever wire dress it wears, asks for a
 * window the ledger already marked served. So: if the CURRENT request's
 * range is FULLY CONTAINED in what this path already served earlier this
 * epoch (`isRangeFullyCoveredBy` below), it is re-verification of a
 * revision that has since moved — serve it fresh, never refuse (the `else`
 * branch below), matching what clean HEAD already did for all three flows
 * above. If it reaches even one line beyond that — advancing, not
 * repeating — the strict refusal applies exactly as before.
 *
 * GATE-A2 (2026-09-21, v0.14.4 candidate item 2's own follow-up) — NARROWED
 * AGAIN. "Reaches even one line beyond what was already served" is NOT the
 * same fact as "is a continuation of something this server promised". The
 * everyday flow "read a window, edit the file with a NATIVE tool (not
 * `tl_edit_file`), read the NEXT window" also reaches beyond what was served —
 * it is an independent read of a window nobody ever promised — yet GATE-A's
 * rule above refused it as though it were a continuation, and its own
 * recovery `next` re-reads the growing union each cycle: a quadratic cost in
 * exactly the hosts that edit natively (VS Code Copilot, Claude Code
 * escapes). Pre-wave behaviour for that flow was: serve fresh, silently.
 *
 * THE DISCRIMINATOR IS NOW: DID THIS SERVER ITSELF PROMISE THIS WINDOW.
 * `mintRangedContinuationWindow` / `mintedRangedContinuationWindows`
 * (state/session.ts) record exactly the windows a `next`/`remaining_ranges`
 * THIS PROCESS wrote have promised — written from the one seat every
 * emitted continuation passes through (`canonicalToolCall`,
 * protocol/envelope.ts; see its own doc comment). A request is STRICT only
 * when it reaches into a minted window's still-UNDELIVERED part
 * (`reachesUndeliveredMintedWindow`, below, checked against the per-span
 * overlap rather than the whole minted span — a span can be PARTIALLY
 * delivered by an earlier hop of the same chain); everything else —
 * including a request that reaches past what was served, but into
 * territory this server never promised — is independent and served fresh,
 * exactly like a fully-covered request already was.
 *
 * This succeeds where the two ORIGINALLY rejected designs could not, and for
 * the same underlying reason GATE-A's OWN heuristic above then failed: the
 * executed-next-ledger fingerprint, the task-binding check, AND "reaches
 * beyond what was served" all inspect a property of the INCOMING call (its
 * wire shape, its metadata, or the caller/ledger's OWN prior activity) —
 * data an independent caller reproduces identically whether or not it is
 * continuing anything; a caller cannot help but reach beyond served lines
 * the first time it asks for a brand-new window, continuation or not. A
 * minted-window registry instead records a fact about SERVER OUTPUT — what
 * this process itself proposed — which an independent caller has no way to
 * coincidentally reproduce, because it never received that proposal.
 */
export async function admitCallerRangedContinuation(
  workspace: string,
  rawPaths: unknown,
  args: Record<string, unknown>,
): Promise<ReturnType<typeof toolStructuredError> | undefined> {
  if (!Array.isArray(rawPaths) || rawPaths.length === 0) return undefined;
  const entries = mapTaskPackPaths(rawPaths);
  const watchPathOf = (entry: { path: string; handle?: string }): string | undefined =>
    entry.path !== "" ? entry.path : entry.handle !== undefined ? handleTable.get(entry.handle)?.path : undefined;
  const staleByIndex = new Map<number, { priorRanges: string[]; mergedRange: string; watchPath: string }>();
  const uncoveredIndependentStaleness: Array<{ priorRanges: string[]; watchPath: string }> = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    if (entry.range === undefined) continue;
    const watchPath = watchPathOf(entry);
    if (watchPath === undefined || watchPath === "") continue;
    let text: string;
    try {
      const abs = safeResolve(watchPath, workspace);
      if (abs === undefined) continue;
      const real = realpathSync(abs);
      if (!isWithin(real, resolveReal(workspace))) continue;
      if (statSync(real).size > STALE_RANGE_PROBE_MAX_BYTES) continue;
      // served-bytes: not-served (staleness pre-check: sha comparison only; the real serve re-reads and books independently)
      text = readFileSync(real, "utf8");
    } catch {
      continue;
    }
    const freshSha = shaOfText(text);
    // FIX-A6 (ordering fix): `servedRangeStaleness` MUST observe this path's
    // watch state as it stood BEFORE this call touched it — its own doc
    // comment (state/session.ts) names "the first hop of a genuinely fresh
    // `task.epoch:"new"` chain that happens to reuse a path a PRIOR,
    // unretired epoch also touched" as the exact false-alarm case membership
    // in `epochRangeWatch` is meant to rule out. Calling
    // `markRangeContinuationWatched` first (as this line used to) added the
    // path to that set before the check ever ran, so the very "first touch"
    // guard `servedRangeStaleness` documents could never fire — CONFIRMED
    // live: a same-lane, same-session `task.epoch:"new"` re-read of a path a
    // retired epoch had left a stale ledger entry for was refused
    // `cursor-stale`, a false alarm, once this fix wired a THIRD caller
    // (mode=slice) into this function and finally exercised the ordering.
    // The mark still runs unconditionally, immediately after, so a SECOND
    // hop within THIS SAME epoch is watched exactly as before.
    const staleness = servedRangeStaleness(workspace, watchPath, freshSha);
    markRangeContinuationWatched(workspace, watchPath);
    if (staleness === undefined) continue;
    const mintedRanges = mintedRangedContinuationWindows(workspace, watchPath) ?? [];
    if (!reachesUndeliveredMintedWindow(entry.range, mintedRanges, staleness.ranges)) {
      // GATE-A2: independent of anything THIS SERVER minted as a
      // continuation — re-verification of a revision that has since moved,
      // whether or not this request's own range happens to have been served
      // before. Served fresh, never refused. Still acknowledge (below) so
      // this exact (path, sha) is not re-flagged forever, and still
      // disclose the portion of the prior serve THIS call does not itself
      // re-cover (a one-line `note`, applied by the caller once the real
      // serve completes).
      const uncovered = staleRangesNotCoveredBy(staleness.ranges, entry.range);
      if (uncovered.length > 0) uncoveredIndependentStaleness.push({ priorRanges: uncovered, watchPath });
      acknowledgeRangeStaleness(workspace, watchPath, freshSha);
      continue;
    }
    const mergedRange = mergeRangeSpans([...staleness.ranges, entry.range]) ?? entry.range;
    staleByIndex.set(i, { priorRanges: staleness.ranges, mergedRange, watchPath });
    // See acknowledgeRangeStaleness's own doc comment: this refusal is a
    // pre-flight check, so the real serve that would otherwise advance the
    // ledger's sha never runs on this hop — mark the disclosure now so a
    // follower's retry of THIS exact restart admits the same sha and reaches
    // the real serve, instead of being refused forever.
    acknowledgeRangeStaleness(workspace, watchPath, freshSha);
  }
  // GATE-A: an independent (fully-covered) request never refuses, but a
  // stale revision this call itself does not re-cover is still worth one
  // line of disclosure — stashed here (consumed once, by the shared
  // dispatch exit) rather than returned, since this function's only other
  // return shape is "nothing to say" (`undefined`) or the bound refusal
  // below.
  if (uncoveredIndependentStaleness.length > 0) {
    stashIndependentRangeStalenessNote(      workspace,
      uncoveredIndependentStaleness
        .map((info) => `${info.watchPath}: lines ${info.priorRanges.join(", ")} were served earlier this epoch under a since-changed revision and are not covered by this request`)
        .join("; "),
    );
  }
  if (staleByIndex.size === 0) return undefined;

  const nextTargets = entries.map((entry, i) => {
    const stale = staleByIndex.get(i);
    return {
      ...(entry.path !== "" ? { path: entry.path } : {}),
      ...(stale !== undefined
        ? { range: stale.mergedRange }
        : entry.range !== undefined ? { range: entry.range } : {}),
      ...(entry.symbol !== undefined ? { symbol: entry.symbol } : {}),
      ...(entry.purpose !== undefined ? { purpose: entry.purpose } : {}),
      ...(entry.handle !== undefined ? { handle: entry.handle } : {}),
    };
  });
  const affected = [...staleByIndex.values()]
    .map((info) => `${info.watchPath} (previously served ${info.priorRanges.join(", ")})`)
    .join("; ");
  // eval-0929 §3/§7/§8: restate the CALLER'S OWN canonical request (content
  // mode, select, scope, task/qref/query — everything `CANONICAL_ORIGINAL_INPUT`
  // captured before legacy normalization; see `canonicalOriginalReadInput`),
  // with only the stale ranges widened (`nextTargets`, computed above) — never
  // a LEGACY-translated field read back off `args` after normalization may
  // have rewritten it (confirmed live: a canonical `content:"full"` caller
  // could see this refusal's own `next` restate `content:"auto"`). `budget` is
  // never present in `CANONICAL_ORIGINAL_INPUT` (deliberately, for the cursor
  // path's own reasons — see that projection's doc comment), so it is restored
  // here from THIS call's own declared ceiling instead. A LEGACY-dialect
  // caller (only reachable with `TL_LEGACY_INPUT=accept`) leaves nothing
  // canonical to restate, so the restart falls back to the legacy `content`
  // this call itself carried, exactly as before this fix.
  const canonicalOriginal = (args as Record<PropertyKey, unknown>)[CANONICAL_ORIGINAL_INPUT];
  const restartBase: Record<string, unknown> = canonicalOriginal !== null
    && typeof canonicalOriginal === "object"
    && !Array.isArray(canonicalOriginal)
    ? { ...(canonicalOriginal as Record<string, unknown>) }
    : {};
  if (Object.keys(restartBase).length === 0 && typeof args["content"] === "string") {
    restartBase["content"] = args["content"];
  }
  const declaredBytes = typeof args["maxBytes"] === "number" && args["maxBytes"] > 0 ? args["maxBytes"] : undefined;
  const declaredTokens = typeof args["maxTokens"] === "number" && args["maxTokens"] > 0 ? args["maxTokens"] : undefined;
  return toolStructuredError({
    ok: false,
    code: "cursor-stale",
    field: "targets",
    error: `the source revision of ${affected} moved since this task last served it`,
    detail: "a caller-ranged continuation is never mixed across revisions; the next call re-reads the stale range(s) under the current version",
    retry: "call",
    next: canonicalToolCall("tl_read_file", {
      ...restartBase,
      targets: nextTargets,
      ...((declaredBytes !== undefined || declaredTokens !== undefined)
        ? {
            budget: {
              ...(declaredBytes !== undefined ? { bytes: declaredBytes } : {}),
              ...(declaredTokens !== undefined ? { tokens: declaredTokens } : {}),
            },
          }
        : {}),
    }),
  });
}

/** GATE-A: the entries of `priorRanges` ("start-end" strings) that `currentRange` does not fully subsume — the part of an independent call's disclosure that is not moot because THIS request already re-reads it. An unparsable `currentRange` discloses everything (fail open toward disclosure, never silently drop it). */
export function staleRangesNotCoveredBy(priorRanges: readonly string[], currentRange: string): string[] {
  const current = parseServedSpan(currentRange);
  if (current === undefined) return [...priorRanges];
  return priorRanges.filter((range) => {
    const span = parseServedSpan(range);
    return span === undefined || span[0] < current[0] || span[1] > current[1];
  });
}

/**
 * GATE-A2 (2026-09-21, v0.14.4 candidate item 2's own follow-up): true iff
 * `range` reaches into a window THIS SERVER ITSELF minted as a continuation
 * for the path being checked (`mintedRanges`,
 * `state/session.ts`'s `mintedRangedContinuationWindows`) that is not
 * itself already fully delivered under the stale sha (`deliveredRanges`,
 * `servedRangeStaleness`'s own `ranges`). This is the necessary-and-
 * sufficient test `admitCallerRangedContinuation`'s own doc comment
 * describes: a genuine continuation is the caller reaching into a promise
 * this server made and has not yet kept.
 *
 * Checked PER MINTED SPAN, against the OVERLAP with `range` specifically —
 * NOT "is the whole minted span still open" — because a minted span can be
 * PARTIALLY delivered by an earlier hop of the same chain (a second
 * continuation minted for what a first continuation left over): a request
 * that only touches the ALREADY-delivered part of an otherwise-still-open
 * minted span must still be independent re-verification, not a
 * continuation. An unparsable `range` never reaches anything (fails toward
 * "independent", the same safe direction `isRangeFullyCoveredBy` fails
 * toward "not covered").
 */
export function reachesUndeliveredMintedWindow(
  range: string,
  mintedRanges: readonly string[],
  deliveredRanges: readonly string[],
): boolean {
  const requested = parseServedSpan(range);
  if (requested === undefined) return false;
  for (const minted of mintedRanges) {
    const span = parseServedSpan(minted);
    if (span === undefined) continue;
    const overlapStart = Math.max(requested[0], span[0]);
    const overlapEnd = Math.min(requested[1], span[1]);
    if (overlapStart > overlapEnd) continue; // no overlap with this minted window
    if (!isRangeFullyCoveredBy(`${overlapStart}-${overlapEnd}`, deliveredRanges)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Workspace root resolution
// ---------------------------------------------------------------------------





// Exported as a live binding for ./mcp/transport/* (v0.10 alpha.1 transport
// extraction); assigned exactly once, here. `path.resolve` absolutizes a
// relative `--workspace`/positional arg or TOKENLIGHTEN_ROOT against this
// process's own launch cwd — ordinary CLI ergonomics, and a prerequisite for
// `assertActiveRootExists` (below `run()`) to validate the SAME value every
// downstream resolver (`resolveWorkspaceRoot`, `checkCwdOrRefuse`) sees; it
// does not by itself make the path exist.
// A pooled test process must not hold a removable fixture as its physical cwd
// on Windows. The harness launches from a stable directory and supplies the
// original launch cwd only for workspace resolution. Production ignores it.





// F-A7 (v0.11 wave C): the client identity `initialize`'s clientInfo declares,
// captured once per connection below (the only leg where our own code ever
// sees clientInfo — the modern SDK-backed leg resolves initialize internally
// and never surfaces it here); threaded into ProtocolCallContext.clientId by
// callToolUninstrumented via resolvedClientId() just below.


/** Test-only reset for {@link capturedClientId}. */


/**
 * Test-only session reset (TL_TEST_SESSION_RESET=1; testing/sessionReset.ts):
 * re-roots this process at `workspaceRoot`, validated as startup validates
 * its own root, and clears this module's per-session state. The launch
 * configuration (`--allow-write`, `--tool-surface`, env flags) stays as
 * started, so a harness reuses a process only for an identical launch.
 */


/**
 * F-A7: TOKENLIGHTEN_CLIENT_ID overrides/supplies clientId for a leg that
 * never populates capturedClientId (every leg but the hand-rolled legacy-era
 * transport, i.e. the modern SDK v2 one);
 * an explicit override wins. Undefined resolves to the conservative "unknown"
 * client profile (protocol/codec/clientProfile.ts) — the designed fallback.
 */



/**
 * Default-protocol workspace resolution shares C2's explicit
 * `--allowed-parent` configuration without enabling the C2 protocol. The
 * resolver still accepts $HOME as before; each configured parent admits only
 * one of its direct-child worktree boundaries, never the parent itself.
 */
export function configuredAllowedParents(_fallbackRoot: string): readonly string[] {
  // The public protocol still honors explicit parent grants.
  const parents: string[] = [];
  const add = (candidate: string): void => {
    const real = resolveReal(candidate);
    if (!parents.includes(real)) parents.push(real);
  };
  for (const parent of (process.env["TOKENLIGHTEN_ALLOWED_PARENTS"] ?? "").split(path.delimiter)) {
    if (parent) add(parent);
  }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--allowed-parent" && typeof argv[i + 1] === "string") {
      add(argv[i + 1]!);
      i += 1;
    }
  }
  return parents;
}

export function resolveWorkspaceRoot(cwd: string | undefined, fallbackRoot: string): string {
  return resolveWorkspaceRootBase(cwd, fallbackRoot, configuredAllowedParents(fallbackRoot));
}

// ---------------------------------------------------------------------------
// PI-09: install the handle table's durable backing
// ---------------------------------------------------------------------------
//
// Before this, `util/handles.ts`'s own header said the table "is never
// persisted to disk", and the handle-unknown refusal told the agent so:
// "handles are session-scoped and do not survive a server restart". Both were
// true, and both were the T-PI09-03 dead end — every handle an agent held
// became garbage the moment the server restarted, with a full re-read as the
// only recovery.
//
// The hooks are registered UNCONDITIONALLY: `recordHandleEntry` only buffers,
// and both hooks resolve to no-ops when the workspace has no writable store
// (or when `TOKENLIGHTEN_STATE_STORE=off`), so installing them cannot make a
// read-only or hostile filesystem fail — it degrades to exactly the v0.9
// behavior the corpus pins.


// Read helpers (readFileSafe, readBytesSafe, resolveReal) are imported from
// util/safePath.ts. Each call site passes an explicit workspace root — worktree-
// isolated callers pass their worktree path so reads come from THEIR tree, not the
// main checkout. See write/resolveWorkspace.ts.
//
// enforcePreconditions expects a callback with an optional root arg; bind activeRoot.
// served-bytes: not-served (wrapper: binds the active root; every caller is annotated at its own site)
export function readFileSafeOpt(rel: string, root?: string): Promise<string | null> {
  // served-bytes: not-served (the wrapper's own forwarding call; see the tag above this function)
  return readFileSafe(rel, root ?? activeRoot);
}

/**
 * AA1 (2026-09-14, review round 10): the ONE message every server route uses
 * when a file was READ successfully but its bytes are not servable text under
 * `util/textDecode.ts::readServedText` (invalid UTF-8, a BOM-less UTF-16 save,
 * or NULs too dense to be incidental). Paired with `readServedTextSafe` at every
 * route below that puts file text on the wire, so the whole server agrees with
 * the task-pack doors about which bytes are text -- rounds 6-9 measured raw NULs
 * and mojibake arriving through `readFileSafe`-based serve routes for files the
 * task pack had already disclosed as unreadable.
 *
 * `read-error` is the existing A.7.1 code for "this read could not produce
 * content" (already this file's code for a failed `small_file` read). A more
 * precise `not-decodable-text` code would be better and is filed as a chip:
 * minting a wire code is a protocol change, not a fix-wave edit.
 */
/**
 * SHOULD-FIX 60 (AB1, 2026-09-14, review round 11): takes the VERDICT, not a
 * bare tag, so the wire message names the rule that fired and the numbers it
 * measured. Round 10 measured "not decodable as UTF-8 (nul-dense)" on a 42-byte
 * file holding ONE NUL — the sparsest corruption possible — and the caller was
 * told its file was NUL-dense when the rule that actually fired was "any NUL is
 * refused below 100 characters". A bare reason string is still accepted for the
 * callers that have nothing else to give.
 */
export function undecodableTextMessage(
  relPath: string,
  verdict: Extract<ServedTextVerdict, { kind: "undecodable" }> | ServedTextUndecodableReason,
): string {
  const reason = typeof verdict === "string"
    ? describeServedTextRefusal(verdict)
    : describeServedTextRefusal(verdict.reason, { nulCount: verdict.nulCount, totalLength: verdict.totalLength });
  return `Cannot read ${relPath} as text: not decodable as UTF-8 (${reason}) — re-save the file as UTF-8, or read it with tl_search_files / an artifact mode`;
}

/**
 * SHOULD-FIX 57: the one place a server route turns a `"stripped"` verdict into
 * the annotation the policy requires. Spread into any response body that
 * already carries a prose `note` (`read.text`, `read.map`, the `form:"handle"`
 * and `form:"file"` batch entries) — E-1, so a `clean` serve pays nothing.
 */
/**
 * SERVED-BYTES COMPLETENESS (AB1, 2026-09-14, review round 11) — the ONE way a
 * `tl_read_file` route in this file obtains file text it intends to put on the
 * wire. `readServedTextSafe` is the policy; this is the policy plus the two
 * things every door also has to do and two doors forgot:
 *
 *   1. `readServedText`'s verdict decides whether the bytes may be served at
 *      all (BLOCKERs 52 and 53 were routes that still called `readFileSafe`,
 *      the LENIENT reader, and therefore served exactly the bytes the
 *      single-target form of the same request refused);
 *   2. a `"stripped"` serve publishes itself into the protocol call context, so
 *      `projectSuccessBody` states it once for the whole read family
 *      (SHOULD-FIX 57: five routes served a stripped body silently, each under
 *      a `sha` computed over the stripped text).
 *
 * `__tests__/servedBytesDoors.spec.ts` greps this file (and the other
 * wire-serving modules) for every byte-read primitive and fails unless each hit
 * is annotated `// served-bytes: readServedText` or
 * `// served-bytes: not-served (<why>)`, so a seventh door cannot be added
 * silently. That guard is why this helper exists as a named funnel rather than
 * as nine copies of the same three lines.
 */
export async function servedTextForRoute(rel: string, workspace: string): Promise<ServedTextVerdict | null> {
  // served-bytes: readServedText
  const verdict = await readServedTextSafe(rel, workspace);
  if (verdict !== null && verdict.kind === "stripped") noteNulStrippedServe();
  return verdict;
}

export function nulStrippedNoteText(verdict: ServedTextVerdict | null | undefined): string | undefined {
  return verdict?.kind === "stripped" ? NUL_STRIPPED_SERVE_NOTE : undefined;
}

/** The spreadable form of {@link nulStrippedNoteText} — E-1: absent when clean. */
export function nulStrippedNote(verdict: ServedTextVerdict | null | undefined): { note?: string } {
  const note = nulStrippedNoteText(verdict);
  return note === undefined ? {} : { note };
}

export function textForLineRange(text: string, range: { start: number; end: number }): string {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized.split("\n");
  const selected = lines.slice(range.start - 1, range.end).join("\n");
  return range.end < lines.length ? selected + "\n" : selected;
}

export function uniqueMatchRefusalInScope(opts: {
  fileText: string;
  search: string;
  path: string;
  workspace: string;
  range: { start: number; end: number };
}): Record<string, unknown> | undefined {
  if (opts.search === "") return undefined;
  const scoped = textForLineRange(opts.fileText, opts.range).normalize("NFC");
  const search = opts.search.replace(/\r\n/g, "\n").replace(/\r/g, "\n").normalize("NFC");
  if (search === "") return undefined;
  let count = 0;
  let index = scoped.indexOf(search);
  const lines: number[] = [];
  while (index !== -1) {
    count += 1;
    lines.push(opts.range.start + scoped.slice(0, index).split("\n").length - 1);
    index = scoped.indexOf(search, index + search.length);
    if (count > 3) break;
  }
  if (count === 1) return undefined;
  const matches = lines.slice(0, 3).map((line) => {
    const handle = handleTable.upsert({
      kind: "range",
      path: opts.path,
      range: String(line) + "-" + String(line),
      workspaceRoot: opts.workspace,
    });
    return { handle: handle.id, path: opts.path, line };
  });
  return {
    ok: false,
    // 2026-11-02 (v0.16.4 field evaluation): zero matches are `not-found`.
    reason: count === 0 ? "not-found" : "search-not-unique",
    detail: count === 0
      ? "the search string has no match in the handle range (unique-match needs exactly one)"
      : "the search string matches more than one location in the handle range — add surrounding context to make it unique",
    ...(matches.length > 0 ? { matches } : {}),
  };
}

// ---------------------------------------------------------------------------
// Kill switch, feature flags, and write mode
// ---------------------------------------------------------------------------



// ---------------------------------------------------------------------------
// W3 (2026-07-30, dist build-id echo): filesystem-only identity for the
// dispatch/schema logic THIS process loaded (see util/serverBuild.ts), so a
// stale MCP child still serving pre-fix dist/ bytes is detectable from the
// outside instead of every response looking identical regardless of which
// build produced it. Computed once at module load (ES module top-level code
// runs exactly once) — never re-derived per call/response.
// ---------------------------------------------------------------------------

// Exported for ./mcp/transport/* — derived from THIS module's URL, so the
// transport legs must import it rather than re-derive it from their own depth.

// Published to the session layer so responses IT builds — the prepared-stop
// receipt in particular — can carry the same identity without re-deriving it
// from a module that is a poor proxy for "did the server's behavior change".


/** Attaches `server_build` to the FIRST task_pack response of a session only — byte economy (see claimServerBuildAnnouncement). */
export function attachServerBuildOnce(result: Record<string, unknown>, workspace: string): Record<string, unknown> {
  if (SERVER_BUILD_ID === undefined) return result;
  if (!claimServerBuildAnnouncement(workspace)) return result;
  return { ...result, server_build: SERVER_BUILD_ID };
}

// D11 (protocol v1, P2): the alias gating flags are DELETED with the alias
// surface they gated — `TL_ENABLE_DEPRECATED_ALIASES` plus the three per-alias
// kill switches `TL_DISABLE_GET_FILE_SKELETON`,
// `TL_DISABLE_GET_SYMBOL_WITH_CONTEXT` and `TL_DISABLE_EXTRACT_OFFICE_TEXT`.
// All four are now INERT: setting any of them changes nothing, because there
// is no alias left to enable or disable. `TOKENLIGHTEN_DOCUMENT_EXTRACTION`
// below is NOT one of them — it gates the advertised office-extraction
// capability itself and stays.


/** --allow-write flag: write tools are registered and callable only when true. */


// ---------------------------------------------------------------------------
// DESIGN-v0.15 §8.2 (R7 Part B): the startup-selected advertised tool
// surface. See `ToolSurface`'s doc comment (@tokenlighten/types) for what
// each value advertises. Resolved ONCE, here, at module evaluation — same
// timing as `ALLOW_WRITE` above — and never re-read for the
// life of this process; a caller cannot change it mid-connection because
// nothing downstream re-reads argv/env after this line runs. An unrecognized
// value fails the process closed with a clear message instead of silently
// coercing to a default: this is launcher configuration, not request input,
// so there is no caller to send a recoverable refusal to.
// ---------------------------------------------------------------------------




/**
 * The resolved, immutable tool surface for this process. `full` (default)
 * advertises every capability this server has ever advertised; `code`
 * removes Office/archive-member/credential-ref inputs from the advertised
 * schema, the inbound validator, and every internal extension-based
 * auto-detection path that would otherwise reach the same capability
 * without an advertised field (see `officeOrArchiveSurfaceRefusal` below).
 */

// DESIGN-v0.15 §8.2 (R7 Part B residual close-out): push the resolved value
// into `protocol/envelope.ts`'s own copy at this SAME module-load moment —
// that module is a DEPENDENCY of this one (it exports `canonicalToolCall`,
// imported above), so it cannot import `ACTIVE_TOOL_SURFACE` back without a
// cycle. A setter call, not a second resolution, so the two can never
// disagree. See `canonicalToolCall`'s own surface-aware minting there.


/**
 * Per-process session ID: embedded in shadow-git checkpoint commit messages.
 * Generated once at startup so all checkpoints in a session share the same ID.
 * Uses randomBytes for uniqueness; NOT Date.now (see BYTE_DETERMINISM rule).
 */


/**
 * S1/C1: cap for the capped-content fallback that read_code mode=auto uses
 * on large (>= the read_code-local SMALL_FILE_BYTES threshold, 8192 bytes)
 * NON-CODE files (docs/config/logs/etc. — see isSkeletonizableLanguage).
 * Those files get useless "(no signatures detected)" skeletons; this cap
 * bounds the raw-content slice returned instead. Truncation is on a line
 * boundary, never mid-line.
 */
export const DOC_CONTENT_CAP_BYTES = 4096;

/**
 * Total byte budget for the mode=map paths=[...] multi-file signature map:
 * the serialized files[] section (per-file signature blocks plus their
 * path/handle overhead) never exceeds this. Mirrors skeleton-engine's
 * repo-map cap (render.ts, 64KB enforced across signature blocks by
 * 5b252d24) so the MCP-served multi-file map obeys the same contract as the
 * CLI-built one: deterministic file-boundary trim only, flagged with the
 * same 'tokenlighten:skeleton-truncated' indicator vocabulary as that
 * renderer's footer.
 */
export const MULTI_FILE_MAP_CAP_BYTES = 65536;

/**
 * 2026-10-24 (read-page ceiling): bytes an outline batch's reply carries beside
 * its entries when `restPaths` are left over for the `next` -- the envelope and
 * `limit` scaffolding (about 1 KB measured, `cwd` excluded), the working
 * directory the `next` echoes, and one `{"path":<path>},` target per path left.
 * Deliberately generous: a batch that ends a path short costs one more round
 * trip, one that ends a path long is cut by the emit tail's whole-entry rung,
 * whose recovery for a dropped outline entry is the wrong read.
 */
export function skeletonBatchReserveBytes(workspace: string, restPaths: readonly string[]): number {
  let reserve = 1100 + Buffer.byteLength(workspace, "utf8");
  for (const restPath of restPaths) reserve += 14 + Buffer.byteLength(restPath, "utf8");
  return reserve;
}

/**
 * Markdown outline envelopes (S1/C1 doc-content `headings`, mode=overview
 * `sections`): capped by entry count AND serialized bytes. 2026-07-17
 * spec-final rc2 (cell md_4800kb): a generated ~4.8MB .md returned 22,680
 * uncapped `headings` entries — a 3.72MB envelope beside the correctly capped
 * 4KB body (917x envelope/body). The outline must never exceed the body's own
 * byte cap, and truncation is explicit (headings_truncated/headings_total,
 * truncated/sections_total), never silent.
 */
export const DOC_HEADINGS_CAP_ENTRIES = 40;

export const DOC_HEADINGS_CAP_BYTES = DOC_CONTENT_CAP_BYTES;

/** Longest prefix of `entries` that fits both caps once JSON-serialized. */
export function capEnvelopeArray<T>(entries: readonly T[], maxEntries: number, maxBytes: number): T[] {
  const kept: T[] = [];
  let bytes = 2; // "[]"
  for (const entry of entries) {
    if (kept.length >= maxEntries) break;
    const entryBytes = Buffer.byteLength(JSON.stringify(entry), "utf8") + (kept.length > 0 ? 1 : 0);
    if (bytes + entryBytes > maxBytes) break;
    kept.push(entry);
    bytes += entryBytes;
  }
  return kept;
}

// ---------------------------------------------------------------------------
// Markdown navigation (R1, 2026-07-25 doc-navigation forensics)
//
// A PARTIAL markdown serve (a slice, a section, a byte-capped doc read, a
// refused symbol lookup) shows one window of a long doc and, pre-fix, said
// nothing about the rest: mode=slice needs line numbers the solver does not
// have, so solvers escaped to `grep -n section | head` + `sed -n 'A,Bp'` +
// native Read (live: 13 calls / 35KB on one 1500-line CONTRACT.md). Every
// partial doc surface now carries the same capped heading index + the one
// instruction that turns it into a call (`sections:[...]`).
// ---------------------------------------------------------------------------

/**
 * Doc size at/below which proposing a whole-file read is still cheap. Kept
 * well under the 32KB line above which a bare full-file `next` hint is never
 * emitted for a doc under any branch (that is the escape this fix exists to
 * remove, not to relocate).
 */
export const DOC_FULL_HINT_MAX_BYTES = 16384;

/** First `n` lines of a heading-less doc worth proposing as a starting slice. */
export const DOC_HEADLESS_SLICE_LINES = 200;

/**
 * Stamp `headings` / `headings_truncated` / `headings_total` /
 * `sections_hint` onto a markdown response. `focus` (the served window) is
 * what the index keeps first when the cap bites, so a truncated index still
 * describes where the solver actually is. No-ops for a doc with no headings
 * — an empty index is pure overhead.
 */
export function attachMarkdownHeadingIndex(
  out: Record<string, unknown>,
  content: string,
  focus?: { start: number; end: number },
): Record<string, unknown> {
  const index = buildMarkdownHeadingIndex(parseMarkdownHeadings(content), {
    maxEntries: DOC_HEADINGS_CAP_ENTRIES,
    maxBytes: DOC_HEADINGS_CAP_BYTES,
    ...(focus ? { focus } : {}),
  });
  if (index.headings.length === 0) return out;
  out["headings"] = index.headings;
  if (index.truncated) {
    out["headings_truncated"] = true;
    out["headings_total"] = index.total;
    if (index.note) out["headings_note"] = index.note;
  }
  out["sections_hint"] = MARKDOWN_SECTIONS_HINT;
  return out;
}

/**
 * Recovery payload for a SYMBOL lookup that missed on a doc file. The live
 * refusal dead-ended: candidates/skeleton are empty for markdown, so the
 * shared refusal-guidance fallback derived `next: tl_read_file path=<doc>` — a
 * whole 1500-line file, strictly worse than the 50-line native slice the
 * solver reached for instead. The miss now answers the question the caller
 * was really asking ("where is this in the doc?") with the heading index and
 * a concrete sections call; a doc over DOC_FULL_HINT_FORBIDDEN_BYTES never
 * gets a whole-file hint in any branch.
 */
export function markdownSymbolMissPayload(args: {
  path: string;
  symbol: string;
  content: string;
}): Record<string, unknown> {
  const headings = parseMarkdownHeadings(args.content);
  const similar = similarHeadingTexts(headings, args.symbol, 3);
  const bytes = Buffer.byteLength(args.content, "utf8");
  const next = similar.length > 0
    ? canonicalToolCall("tl_read_file", { path: args.path, sections: similar })
    : bytes <= DOC_FULL_HINT_MAX_BYTES
      ? canonicalToolCall("tl_read_file", { mode: "full", path: args.path })
      : canonicalToolCall("tl_read_file", {
          mode: "slice",
          path: args.path,
          range: `1-${Math.min(countLines(args.content), DOC_HEADLESS_SLICE_LINES)}`,
        });
  const payload: Record<string, unknown> = {
    ok: false,
    error: `Symbol "${args.symbol}" not found in ${args.path} — markdown carries headings, not code symbols`,
    code: "not-found",
    kind: "markdown",
    path: args.path,
  };
  attachMarkdownHeadingIndex(payload, args.content);
  payload["next"] = next;
  return payload;
}

/**
 * The `handle-workspace-missing` recovery line, WITH the tree it is about.
 *
 * Six sites shipped a fixed string that never named the worktree, and the
 * structured `handleWorkspace` beside it is dropped by the v1 advisory
 * allowlist (it is not a recovery contract — `code` + `retry` + `next` are), so
 * on the wire the refusal said a worktree was gone without saying which. That
 * is the class the 2026-08-09 root-mismatch wave closed everywhere else: a
 * guard's disclosure that does not name its tree is a disclosure the caller
 * cannot act on. Interpolating it mirrors the sibling `resolveHandleWorkspace`
 * multi-root refusals, whose `next` already carries `pass cwd=<root>` and whose
 * spec pins that prose precisely because it is the surviving carrier.
 */
export function handleWorkspaceMissingDetail(handleWorkspace: string): string {
  return `the worktree this handle was minted in (${handleWorkspace}) no longer exists;`
    + " re-read the file by path with cwd set";
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

/**
 * Optional per-call workspace-root override, advertised on every write tool.
 * Worktree-isolated callers pass their own absolute worktree path here so the
 * edit lands in THEIR tree rather than the server's startup-pinned root. See
 * write/resolveWorkspace.ts for the acceptance rules and rationale.
 */

/**
 * D11: `deprecated` and `renamedAlias` are DELETED. Every entry in ALL_TOOLS is
 * now an ADVERTISED tool — the set that `tools/list` returns and the set that
 * `tools/call` accepts are the same set, so "accepted but not advertised" is
 * no longer a state this type can express.
 */
export interface ToolEntry {
  name: string;
  enabled: boolean;
  definition: Record<string, unknown>;
}

// C9 (DESIGN-v0.8) replaced inline MCP_LANGS enums with bare-string `lang`
// schemas; WS6 (DESIGN-v0.9 §10) re-advertises tl_edit_file.lang in that compact
// form. parseMcpLang below still validates against the full MCP_LANGS list at
// dispatch time, so an invalid lang value is rejected exactly as before —
// only the ADVERTISED schema lost the enum, not the acceptance behavior.
export function parseMcpLang(value: unknown): McpLang | undefined {
  return typeof value === "string" && (MCP_LANGS as readonly string[]).includes(value)
    ? (value as McpLang)
    : undefined;
}

export const TASK_PROFILE_REQUESTS: readonly TaskProfileRequest[] = [
  "auto", "generic", "answer", "change_propagation", "multi_concern", "artifact_build", "wiring",
];

export function parseTaskProfile(value: unknown): TaskProfileRequest | undefined {
  return typeof value === "string" && (TASK_PROFILE_REQUESTS as readonly string[]).includes(value)
    ? (value as TaskProfileRequest)
    : undefined;
}

/**
 * Maps a tl_read_file `paths[]` argument (bare strings or {path,range?,symbol?,
 * purpose?} objects) to buildTaskPack's TaskPackArgs["paths"] entry shape.
 * FIX (2026-07-10a dispatch-gap forensics): shared by every tl_read_file
 * dispatch branch that feeds paths[] into buildTaskPack — the explicit
 * mode="task_pack" dispatch and the mode-unspecified/"auto" promotion — so
 * the mapping cannot drift between call sites the way task_pack's and
 * mode=pack's separate inline copies once did (2026-07-09e forensics: a
 * bare-string entry has no `.path` and used to collapse to path:"" before
 * buildTaskPack's own normalizer ever saw the original string).
 */
export function mapTaskPackPaths(paths: unknown[]): Array<{ path: string; range?: string; symbol?: string; purpose?: string; handle?: string }> {
  return paths.flatMap((p) => {
    if (typeof p !== "object" || p === null) return [{ path: String(p) }];
    const e = p as Record<string, unknown>;
    const rawPath = String(e["path"] ?? "");
    const base = {
      path: rawPath,
      ...(e["symbol"] !== undefined ? { symbol: String(e["symbol"]) } : {}),
      ...(e["purpose"] !== undefined ? { purpose: String(e["purpose"]) } : {}),
      // FX-M1/E1: this is the SECOND paths[]-item coercion `legacyPathTarget`'s
      // preserved `handle` had to survive — `mapTaskPackPaths` feeds BOTH the
      // explicit mode="task_pack" dispatch and the mode-unspecified/"auto"
      // promotion above, and used to drop every field but path/range/symbol/
      // purpose, discarding a bare `{handle}` entry's only identifying field
      // before `buildTaskPack`'s own `normalizePathEntry`
      // (readCodeTaskPack.ts) ever got a chance to resolve it. Only carried
      // when `path` itself is empty — an entry that already resolved both
      // keeps its existing path-only projection unchanged.
      ...(rawPath.length === 0 && typeof e["handle"] === "string" ? { handle: e["handle"] } : {}),
    };
    const ranges = Array.isArray(e["ranges"])
      ? e["ranges"].filter((range): range is string => typeof range === "string" && range !== "")
      : [];
    if (ranges.length > 0) return ranges.map((range) => ({ ...base, range }));
    return [{ ...base, ...(e["range"] !== undefined ? { range: String(e["range"]) } : {}) }];
  });
}

export interface TaskPackQueryResolution {
  query: string;
  error?: string;
  /** Concrete recovery for `error`, forwarded to toolError by the call sites. */
  next?: ToolCall;
  /** Human rationale retained beside a structured executable recovery. */
  detail?: string;
  /**
   * C2: the query came from a `qref`, so this call is a replay over a working
   * set the caller still holds — not a freshly-typed request.
   */
  fromRef?: true;
  /**
   * G2 (2026-09-04): the sanctioned transition when no working set survives —
   * see `taskPackRecoveryFor` below. Forwarded to `taskPackQueryErrorPayload`
   * verbatim; `protocol/refusal.ts`'s `retryOf` honors an explicit `retry`
   * before falling back to its own heuristic ladder.
   */
  retry?: "new-task";
  /**
   * G2: prose recovery for the case `next` cannot be built without inventing
   * text (A.5.15's `remaining` is a plain string — never a placeholder-bearing
   * `ToolCall`, which `protocol/refusal.ts`'s `containsPlaceholder` gate would
   * silently strip to nothing).
   */
  remaining?: string;
  /**
   * G3 (2026-09-08, qref-binding fix): set only alongside `fromRef` — the
   * canonical task binding `state/session.ts`'s `resolveTaskQueryRefBinding`
   * recovered for this qref, i.e. the fingerprint an earlier pack of this SAME
   * task epoch stamped on it. Lets a handleless `tl_read_file {qref}` re-pack's
   * own executed-next lookups (both the fresh-build no-repeat gate and the
   * wire-level producer exit) land in the same ledger partition an explicit
   * `task.handle` would have, instead of the always-unbound one a call with no
   * task fields at all otherwise computes.
   */
  taskBinding?: string;
}

/**
 * G2 (2026-09-04, DESIGN-v0.15 §0.3(ll)): the shared recovery a task-pack
 * refusal offers when its OWN working set (a `qref`, a `task_handle`) did not
 * resolve. `"<restate the request verbatim>"` — the placeholder every one of
 * these call sites used to embed — is not executable text: it is exactly what
 * `protocol/refusal.ts`'s `containsPlaceholder` gate exists to catch, and a
 * caught `next` is not degraded, it is DELETED (`emittableToolCall` returns
 * `undefined`, and `detailOf` only rescues a STRING `next`, never a structured
 * one with a placeholder buried in its arguments) — so every refusal that used
 * to build one of these placeholder calls shipped with no `next` at all, the
 * exact `handle-unknown` dead end G2 exists to close.
 *
 * The honest fix is not a better placeholder; it is never inventing the query
 * text. When the CALLER'S OWN request already carries it (`args.query`, sent
 * alongside a `qref`/`task_handle` that turned out not to resolve), it is
 * echoed back verbatim — not fabricated, since the caller supplied it in the
 * very call being refused. Otherwise no `next` is built at all: `retry` is
 * still `"new-task"` (a fresh task_pack is always a sanctioned transition —
 * AGENTS.md's standing re-pack rule) and `remaining` says in prose what to
 * resend, satisfying "still executable-by-instruction, never a bare
 * placeholder" without asserting a `ToolCall` this server cannot back.
 *
 * `canEchoQuery` gates the echo on WHICH property `args.query` actually names.
 * `taskHandleRefusal` (below) is the SAME function shared by `tl_read_file`,
 * `tl_edit_file` and `tl_search_files` — all three accept a `task_handle`, but only
 * `tl_read_file`'s own `query` is the task_pack natural-language request; a
 * `tl_search_files` call's `query` (a legacy/incidental spelling — the canonical
 * field is `queries[]`) or a stray `tl_edit_file` argument of that name means
 * something else entirely, and echoing it into a `tl_read_file mode=task_pack
 * query=…` recipe would be a wrong, misleading recovery, not a merely-unhelpful
 * one. Defaults to true for `resolveTaskPackQueryArg`'s own two call sites,
 * which are reachable ONLY from `tl_read_file`'s task_pack dispatch.
 *
 * M2 (2026-09-05 R28 remediation): also exported for `util/attachSupply.ts`'s
 * `supplyRefusalGuidance`, whose OWN generic last-resort exit built the exact
 * same kind of placeholder this function exists to avoid — but for refusals
 * that never carry the real caller `args` (only whatever fields the failing
 * call site chose to put on the refusal body). That caller passes the refusal
 * BODY itself as `args` and gates `canEchoQuery` on the body already being
 * self-identified task_pack-shaped (`mode:"task_pack"`), so the same
 * "echo only what the caller already supplied, in the very call being
 * refused" rule holds there too.
 */


/**
 * F-C1 (wave D / D2, 2026-08-21): the args the guaranteed-receipt preflight
 * (`canServeCachedTaskPackReceipt`) must be handed — the caller's own args with
 * the RESOLVED task_pack query spliced in, plus the internal replay marker a
 * qref resolution implies. Those are exactly the two fields dispatch itself
 * hands `buildTaskPack` further down, so the preflight's verdict and the
 * builder's own dedup decision are computed from the SAME request identity
 * instead of drifting apart the moment a caller uses `qref`.
 *
 * A resolution ERROR (query+qref together, or an expired qref) deliberately
 * keeps the RAW args: dispatch refuses such a call on its own terms a few
 * hundred lines below, and this preflight must not change WHICH refusal the
 * caller sees.
 */
export function taskPackReceiptPreflightArgs(
  args: Record<string, unknown>,
  resolution: TaskPackQueryResolution,
): Record<string, unknown> {
  if (resolution.error !== undefined) return args;
  // `taskQueryRefReplay` is internal-only: the two buildTaskPack call sites set
  // it from THIS resolution and never from the wire, and B5's guard keys off it.
  // Drop any inbound spelling before re-adding it from the resolution, so this
  // new path cannot become the one place a caller reaches that marker — which
  // would also split the preflight's verdict from the build's own dedup
  // decision, the exact agreement servedRecordPartialSurface.spec.ts pins.
  const base: Record<string, unknown> = { ...args };
  delete base["taskQueryRefReplay"];
  delete base["queryCandidatePolicy"];
  return {
    ...base,
    ...(resolution.query.length > 0 ? { query: resolution.query } : {}),
    ...(resolution.fromRef === true ? { taskQueryRefReplay: true } : {}),
    ...((args as Record<PropertyKey, unknown>)[QUERY_CANDIDATE_POLICY_INPUT] === true
      ? { queryCandidatePolicy: "unanchored" as const } : {}),
  };
}

/**
 * `rememberTaskQuery` for a task-pack call, which also says — to the reply's
 * emission — whether the TASK was first requested with `surfaceRoles`.
 *
 * Wire-compaction review F1 (2026-10-23): a continuation page re-packs by
 * `qref` (or by the query alone) and the cursor behind it stores that call, so
 * the page's own arguments never carry the scope its first request had. The
 * qref's slot remembers the fact for the life of the task (state/session.ts
 * `rememberTaskQuery`, carried over while the same query is re-issued), and the
 * reply is emitted knowing it (`ProtocolCallContext.surfaceRolesPassed`):
 * `role:"unknown"` stays on a page of a task that passed roles, because for it
 * a missing `role` reads "the selector did not bind" (wireCompaction.ts).
 */
export function rememberTaskPackQuery(workspace: string, query: string, args: Record<string, unknown>): string {
  const passed = callPassedSurfaceRoles(args);
  const ref = rememberTaskQuery(workspace, query, undefined, passed);
  if (passed || resolveTaskQueryRefSurfaceRoles(workspace, ref)) noteSurfaceRolesPassed();
  return ref;
}

export function resolveTaskPackQueryArg(
  args: Record<string, unknown>,
  workspace: string,
): TaskPackQueryResolution {
  const explicit = typeof args["query"] === "string" ? args["query"].trim() : "";
  const requestedRef = typeof args["qref"] === "string" ? args["qref"].trim() : "";
  const isNewEpoch = args["taskEpoch"] === "new";
  // G2 (2026-09-04) fix: a bare `{qref, task:{epoch:"new"}}` call — exactly
  // the "fresh pack" recipe this function's own stale-qref branch below, and
  // `taskHandleRefusal`'s `freshPack`, both prescribe as the sanctioned
  // continuation — used to be UNCONDITIONALLY self-defeating: the epoch reset
  // below clears the workspace's single active-qref slot BEFORE this ref is
  // ever read, so resolving it a few lines down always missed, restart or
  // not. `task.epoch:"new"` means "sever pack-dedupe/ledger continuity for a
  // different task", not "forget the query identity THIS SAME call is asking
  // to replay" — those are different claims, and only the qref-only shape
  // (no `explicit` query) makes the second one live at all. Resolve BEFORE
  // clearing so the read happens against the slot as it stood when this call
  // arrived; downstream `rememberTaskQuery` re-mints the slot from the
  // resolved query text regardless, so nothing about the eventual "cleared,
  // then re-issued" ledger state changes.
  const refBeforeEpochReset = isNewEpoch && explicit.length === 0 && requestedRef.length > 0
    ? resolveTaskQueryRef(workspace, requestedRef)
    : undefined;
  if (isNewEpoch) {
    clearTaskQueryRef(workspace);
    // 2026-08-21 smoke-gate forensics: an explicit new-epoch declaration must
    // sever the pack-dedupe ledger too, or a workspace path reused by a
    // later, unrelated task (e.g. a bench harness cell resealed across
    // separate runs) can have its genuinely-first-served surfaces silently
    // stripped to a false "— see prior pack" pointer. See
    // clearPackDedupeForWorkspace's doc comment for the full incident.
    clearPackDedupeForWorkspace(workspace, sessionLaneOf(args));
  }
  if (explicit.length > 0 && requestedRef.length > 0) {
    // D6 (2026-08-07, T13 rep0 forensics): the cheaper recovery depends on
    // whether the caller ALSO holds paths[]. A paths-bearing retry already
    // carries a certified (qref, paths) working set -- the certificate stays
    // valid and nothing has to be re-discovered if it just drops the
    // redundant query. The old unconditional "drop qref, restate query" hint
    // forced a paths-bearing caller to discard that certified set on every
    // retry instead (observed live: 39 turns / 1.54MB across 4 discarded
    // packs, versus sibling reps that happened to drop query and stayed
    // prepared). A query-only retry (no paths) has no working set worth
    // keeping, so that branch keeps the original hint unchanged. Embeds the
    // real qref/paths already in hand here, not placeholders -- the same
    // actionable-hint convention as the path=/handle=/symbol= hints
    // elsewhere in this file (e.g. supplyRefusalGuidance, attachSupply.ts).
    const pathsArg = Array.isArray(args["paths"]) ? (args["paths"] as unknown[]) : [];
    const hasPaths = pathsArg.length > 0;
    // G2: the `!hasPaths` arm used to embed the "<restate the request
    // verbatim>" placeholder even though `explicit` (this same call's OWN
    // `query` argument) is sitting right here — `taskPackRecoveryFor` echoes
    // it back verbatim instead, so this refusal carries a genuinely
    // executable `next` rather than one the placeholder gate silently
    // deletes.
    return {
      query: "",
      error: "query and qref are mutually exclusive for task_pack",
      ...(hasPaths
        ? {
            next: canonicalToolCall("tl_read_file", { mode: "task_pack", qref: requestedRef, paths: pathsArg }),
            detail: `query and qref are mutually exclusive for task_pack; drop query and keep the certified working set qref=${requestedRef} paths=${JSON.stringify(pathsArg)}`,
          }
        : taskPackRecoveryFor(args)),
    };
  }
  if (explicit.length > 0) {
    return { query: explicit };
  }
  if (requestedRef.length > 0) {
    // `refBeforeEpochReset` was captured above, before this call's own
    // `taskEpoch:"new"` cleared the slot; otherwise (no epoch reset on this
    // call) resolve normally.
    const query = isNewEpoch ? refBeforeEpochReset : resolveTaskQueryRef(workspace, requestedRef);
    // A qref is session-scoped and single-epoch: it expires when a newer
    // query supersedes it, when a DIFFERENT call declares `taskEpoch:"new"`
    // with no qref of its own, and — pre-G2 — on every server restart,
    // because `resolveTaskQueryRef`'s backing was in-process only. G2
    // (state/stateHandles.ts's `persistQueryRef`/`rehydrateQueryRef`) durably
    // mirrors the active slot, so this branch is now reached only for a
    // GENUINELY unrecoverable ref (truly unknown, or superseded/cleared by an
    // earlier call) — the args carry no `query` in this branch (only `qref`
    // reached here), so `taskPackRecoveryFor` cannot fabricate one and
    // correctly falls back to `retry:"new-task"` + `remaining` instead of a
    // dead placeholder `next`.
    if (query === undefined) {
      return {
        query: "",
        error: `unknown-or-stale-qref: ${requestedRef}`,
        ...taskPackRecoveryFor(args),
      };
    }
    // G3 (2026-09-08, qref-binding fix): never carried across an explicit
    // `taskEpoch:"new"` — that boundary deliberately severs task identity
    // (see clearTaskQueryRef/clearPackDedupeForWorkspace above), so
    // attaching the PRIOR task's binding here would misattribute this call's
    // own executed-next lookups to the very task this request asked to leave
    // behind. Resolved only on the ordinary (non-epoch-reset) continuation.
    const taskBinding = isNewEpoch ? undefined : resolveTaskQueryRefBinding(workspace, requestedRef);
    return {
      query,
      fromRef: true,
      ...(taskBinding !== undefined ? { taskBinding } : {}),
    };
  }
  return { query: "" };
}

/**
 * DESIGN-v0.15 §8.2 (R7 Part B): true once dispatch is about to enter an
 * Office- or archive-specific code path — reached either through an
 * advertised full-only field (already refused earlier, at validation, by
 * `filterToolDefinitionForSurface`'s effect on `dispatchPropertiesFor`) or
 * through extension-based auto-detection (`isOffice`, `isSupportedArchivePath`
 * below), which carries no advertised field for the schema-level gate to
 * catch, and through a legacy `mode` value a v0.13.x caller can still send
 * directly (`mode` itself stays a generic, non-Office-specific legacy key —
 * see `FULL_ONLY_LEGACY_KEYS`'s doc comment). Every such branch must check
 * this immediately before running, so a `--tool-surface code` connection can
 * never reach Office/archive behavior — including a suggested `next`/
 * `next_call` naming an unadvertised field — regardless of how the request
 * arrived (canonical or legacy).
 */
export function officeOrArchiveSurfaceRefusal(): { error: string; code: RefusalCode } | undefined {
  if (ACTIVE_TOOL_SURFACE !== "code") return undefined;
  return { error: "Office documents and archive access require --tool-surface full.", code: "not-a-document" };
}

// D-2 advertised-only input surface. Legacy spellings are normalized at the
// dispatch boundary for the v0.13.x compatibility window.
// Exported for ./mcp/transport/* (the advertised-or-refused gate, D11); the
// single source of truth for the advertised surface stays right here.
export const ALL_TOOLS: ToolEntry[] = [
  {
    name: "tl_read_file",
    enabled: !KILL_SWITCH,
    definition: {
      name: "tl_read_file",
      description: "Source lookup/read: query = entire request verbatim; unknown paths: omit targets. Or batch targets[].",
      _meta: { "anthropic/alwaysLoad": true, ...PROTOCOL_META },
      annotations: { readOnlyHint: true },
      inputSchema: {
        ...closed({
          query: { type: "string", description: "Task-pack intent, verbatim." },
          qref: { type: "string", description: "Replay token; re-pack with it." },
          targets: { type: "array", items: CANONICAL_TARGET, description: "Files/handles to read." },
          content: { enum: ["auto", "outline", "full"], description: "auto/outline/full hint." },
          select: { ...CANONICAL_SELECT, description: "Artifact/projection selector." },
          budget: { ...CANONICAL_BUDGET, description: "Serving budget caps." },
          task: { ...CANONICAL_TASK, description: "Task/closure control." },
          lane: { type: "string", description: "Concurrency isolation key." },
          cwd: { type: "string", description: "Worktree root for this call." },
          scope: { ...CANONICAL_SCOPE, description: "Read scope fields." },
          // DESIGN-v0.15 §5.2 (R2): the ONE additive wire field of this wave.
          // An opaque, purpose-bound token that resumes the ORIGINAL fetch
          // request — the caller never composes it, and a cursor call carries
          // nothing else except `cwd`/`lane`/`task.handle` echoes and the two
          // sanctioned overrides (`budget`, `task.force_serve`).
          cursor: { type: "string", description: "Resumes a read from prior limit.next; send alone + cwd/lane/task/budget." },
        }),
        // P1-3(a) fix (report-items.md / DESIGN-v0.15 hands-on-report wave):
        // every SANCTIONED shape must match EXACTLY ONE branch below, so a
        // strict ajv consumer (`advertisedSchemaExclusivity.spec.ts`) agrees
        // with what dispatch actually executes. Before this fix, branch 3
        // (task-only) excluded only query/targets, so a real budget-cut
        // `{cursor, task:{force_serve:true}}` continuation — which the
        // server has always executed correctly — matched BOTH branch 3 and
        // branch 4, and ajv's `oneOf` rejects any 2-branch match
        // (`passingSchemas:[3,4]`), even though nothing was wrong with the
        // CALL. Each branch below now excludes every OTHER branch's own
        // required field, not just the two that happened to collide first:
        oneOf: [
          { required: ["query"], not: { anyOf: [{ required: ["targets"] }, { required: ["qref"] }] } },
          { required: ["targets"], not: { required: ["query"] } },
          { required: ["query", "targets"] },
          // Excludes cursor/qref too (previously only query/targets), so a
          // task-only call (bare `{task:{pull:"closure"}}`, or the P1-3(c)
          // handle-only resume shape) never double-matches branch 4 or 5.
          {
            required: ["task"],
            not: { anyOf: [{ required: ["query"] }, { required: ["targets"] }, { required: ["cursor"] }, { required: ["qref"] }] },
          },
          // R2: the cursor-only continuation shape, permissive for its
          // sanctioned riders (cwd/lane/budget/task.force_serve/
          // task.handle — none of which any branch here requires, so none
          // can cause a double-match). `not:{required:["qref"]}` closes the
          // one gap those riders do NOT cover: a cursor is its own opaque
          // continuation identity, and `qref` names a DIFFERENT one, so
          // `{cursor, qref}` must be rejected (0 matches), not silently
          // accepted through this permissive branch alone.
          // `{cursor, query}` / `{cursor, targets}` still match two branches
          // (this one plus branch 0/1) and are rejected by that composition;
          // `cursorCoInputRefusal` (dispatch) then names the offending field,
          // which a schema rejection cannot do.
          { required: ["cursor"], not: { required: ["qref"] } },
          // W3-4(a) (wave-2 handoff): a BARE `qref` (no query/targets/task) is
          // the sanctioned replay shape AGENTS.md documents verbatim ("Re-pack
          // with the returned `qref`, no `query`"), and the legacy dispatch
          // path (resolveTaskPackQueryArg, further down this file) has always
          // resolved it correctly on its own — `qref` needs no canonical ->
          // legacy translation because it is already the same top-level
          // spelling both ways. Only the ADVERTISED schema was missing this
          // branch (capabilityReachability.spec.ts's "read.qref-only" case,
          // filed there as a wave-3 finding rather than fixed in wave 2).
          // P1-3(a): excludes cursor (added), but deliberately NOT task —
          // `{qref, task:{epoch:"new"}}` is a live, dispatched shape (G2's
          // stale-qref-with-epoch-reset recipe above, and P1-3(c)'s
          // handle-only resume redirect below both emit exactly this), so
          // it must still validate — via THIS branch once branch 3 above
          // starts excluding qref.
          { required: ["qref"], not: { anyOf: [{ required: ["query"] }, { required: ["targets"] }, { required: ["cursor"] }] } },
        ],
      },
    },
  },
  {
    name: "tl_edit_file",
    enabled: !KILL_SWITCH,
    definition: {
      name: "tl_edit_file",
      description: "Edit via edits[] or artifact.",
      _meta: { "anthropic/alwaysLoad": true },
      // W3-4(d) (wave-2 handoff, cross-audit P2): tl_edit_file deliberately has
      // NO top-level `scope`. The D-REPORT census approved exactly 7
      // top-level fields for this tool (edits, artifact, operation_id, task,
      // lane, cwd, credentials); an 8th, `scope`, was live on this schema
      // between waves 1 and 3, reusing the same CANONICAL_SCOPE object
      // tl_read_file/tl_search_files advertise. Live probing confirmed this was an
      // ACTIVE DEFECT, not merely unused surface: `normalizeCanonicalRequest`'s
      // shared preamble runs `mapCanonicalScope` for every tool alike, so
      // `scope.regex` / `scope.includeClosure` / `scope.archive` /
      // `scope.depth` / `scope.surfaceRoles` / `scope.includeScores` were
      // schema-VALID per this file's own advertised shape yet refused
      // `unknown-arguments` at dispatch (none of those legacy-mapped names
      // are in `LEGACY_DISPATCH_PROPERTIES.tl_edit_file`) — an advertised
      // capability the server could never actually honour, the mirror image
      // of the capability-reachability class W2-1 fixed. The remaining
      // fields that DID happen to pass through (`scope.path`,
      // `scope.credentialRef`, `scope.lang`, `scope.symbol`, because those
      // spellings are ALSO legacy tl_edit_file properties for unrelated
      // reasons) are duplicate-authority shadows of tl_edit_file's own
      // dedicated, already-census-approved homes: `edits[].path` /
      // `edits[].handle` for target addressing, `credentials.in` for the
      // input credential, and `edits[].intent.lang` / `edits[].intent.symbol`
      // for intent-scoped hints — exactly the "two spellings of one
      // capability" class this codebase deletes rather than declares (see
      // the `allow_create` removal comment above `create`). Deleted here
      // rather than repaired, restoring the census-7 shape; capabilityReachability.spec.ts's
      // old `edit.scope` positive case is removed to match (D-REPORT
      // records the before/after).
      inputSchema: {
        ...closed({
          edits: { type: "array", items: CANONICAL_EDIT_ITEM, description: "Batch independent edits, ONE call." },
          artifact: {
            ...closed({
              kind: { type: "string", enum: ["xlsx", "docx", "pptx", "pdf", "zip"], description: "Artifact format." },
              cells: {
                type: "array",
                description: "Sheet/cell/value/formula writes.",
                items: {
                  ...closed({
                    sheet: { type: "string", description: "Worksheet name." },
                    cell: { type: "string", description: "A1-style cell address." },
                    value: { description: "Literal cell value to write." },
                    formula: { type: "string", description: "Formula to write." },
                  }),
                },
              },
              replacements: {
                type: "array",
                description: "search/replace/all text edits.",
                items: {
                  ...closed({
                    search: { type: "string", description: "Text to find." },
                    replace: { type: "string", description: "Replacement text." },
                    all: { type: "boolean", description: "Replace every match." },
                  }),
                },
              },
              form: { type: "object", description: "PDF form field values." },
              flatten: { type: "boolean", description: "Flatten the PDF form." },
              members: {
                type: "array",
                description: "Zip member ops: add/replace/delete.",
                items: {
                  ...closed({
                    action: { type: "string", description: "Member op: add, replace, or delete." },
                    member: { type: "string", description: "Member path in the archive." },
                    content: { type: "string", description: "Text content for add/replace." },
                    sourcePath: { type: "string", description: "Copy bytes from this file." },
                  }),
                },
              },
            }),
            description: "xlsx/docx/pptx/pdf/zip edit.",
          },
          operation_id: { type: "string", description: "Idempotency key." },
          task: { ...CANONICAL_TASK, description: "Task/closure control." },
          lane: { type: "string", description: "Concurrency isolation key." },
          cwd: { type: "string", description: "Worktree root for this call." },
          credentials: {
            ...closed({
              in: { type: "string", description: "Ref for input artifact." },
              out: { type: "string", description: "Ref for output artifact." },
            }),
            description: "Artifact credential refs.",
          },
        }),
        // W2-1(a): `required:["edits"]` made an artifact-only call
        // (`tl_edit_file artifact={kind:"zip",members:[...]}`, AGENTS.md's own
        // documented archive-edit shape) schema-INVALID even though dispatch
        // has always accepted it — the advertised surface refused a capability
        // the server implements. Either top-level carrier is sufficient on its
        // own; a call with neither is still refused for the same reason it
        // always was.
        anyOf: [{ required: ["edits"] }, { required: ["artifact"] }],
      },
    },
  },
  {
    name: "tl_search_files",
    enabled: !KILL_SWITCH,
    definition: {
      name: "tl_search_files",
      description: "Find/reference/diff/tree via queries[].",
      _meta: { "anthropic/alwaysLoad": true },
      annotations: { readOnlyHint: true },
      inputSchema: {
        ...closed({
          action: { enum: ["find", "references", "diff", "tree"], description: "find/references/diff/tree." },
          // W9 (2026-08-22) / W3-2 restoration: `queries` had no description at
          // all before this property was advertised, and the ONLY live signal
          // that batching exists was a reactive one-per-session hint fired
          // AFTER two single-token find calls were already billed. Losing this
          // description again silently reintroduces that serial fan-out —
          // schemaSize.spec.ts pins the exact substring below for that reason.
          queries: {
            type: "array",
            items: { type: "string" },
            description: "Batch call; reports matched|absent|unknown.",
          },
          scope: { ...CANONICAL_SCOPE, description: "Search scope fields." },
          budget: { ...CANONICAL_SEARCH_BUDGET, description: "Serving budget caps." },
          cursor: { type: "string", description: "Continuation token." },
          task: { ...CANONICAL_TASK, description: "Task/closure control." },
          lane: { type: "string", description: "Concurrency isolation key." },
          cwd: { type: "string", description: "Worktree root for this call." },
        }),
        required: ["action"],
        oneOf: [
          { properties: { action: { enum: ["find"] } }, required: ["queries"] },
          { properties: { action: { enum: ["references", "diff", "tree"] } } },
        ],
      },
    },
  },
];
