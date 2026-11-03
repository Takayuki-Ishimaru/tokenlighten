// dispatch-funnel — extracted implementation; imports point to the owning modules.
import type { CwdCorrection } from "./workspace-routing2.js";
import type { ReadBaselineMeasurement as UsageReadBaselineMeasurement } from "../usage-baseline/readBaseline.js";
import type { ToolCallResult } from "../protocol/result.js";
import type { UsageRecorder } from "@tokenlighten/usage";
import { HANDLE_OVERRIDES_INPUT } from "./canonical-input.js";
import { ROOT_NOTE_READ_TOOLS } from "./dispatch-funnel.js";
import { ROOT_NOTE_WRITE_TOOLS } from "./dispatch-funnel.js";
import { SERVER_BUILD_ID } from "../runtime/config.js";
import { SERVER_PACKAGE_VERSION } from "../runtime/config.js";
import { SESSION_ID } from "../runtime/config.js";
import { activeRoot } from "../runtime/config.js";
import { callPinsRootViaHandle } from "./dispatch-funnel.js";
import { checkCwdWithCorrection } from "./workspace-routing.js";
import { createUsageRecorder } from "@tokenlighten/usage";
import { creditedReadPathsByLane } from "../runtime/requestState.js";
import { declaredWorkspaceForCall } from "./workspace-routing2.js";
import { dispatchTool } from "./dispatch-funnel.js";
import { effectiveCallWorkspace } from "./workspace-routing2.js";
import { emptyReadBaseline } from "../usage-baseline/readBaseline.js";
import { ensureWireTokenizerLoaded } from "../protocol/codec/tokenizerResolver.js";
import { estimateTokensFromBytes } from "@tokenlighten/usage";
import { finalizeProtocolResponse } from "../protocol/envelope.js";
import { flushHandleEntries } from "../state/stateHandles.js";
import { handleTable } from "../util/handles.js";
import { isCwdExplicit } from "./workspace-routing2.js";
import { measureReadBaseline } from "../usage-baseline/readBaseline.js";
import { nestedWorkspaceCrossing } from "../write/workspaceBoundary.js";
import { nestedWorkspaceRoots } from "../write/workspaceBoundary.js";
import { noteCodecTraceWorkspace } from "../protocol/envelope.js";
import { noteContinuationWorkspace } from "../protocol/envelope.js";
import { noteReadServeWorkspace } from "../protocol/envelope.js";
import { noteVerifyClosureWorkspace } from "../protocol/envelope.js";
import { readTargetPaths } from "./workspace-routing2.js";
import { resolveWorkspaceRoot } from "./read-admission2.js";
import { resolvedClientId } from "../runtime/config.js";
import { rootMismatchNote } from "./dispatch-funnel.js";
import { runEditWithOperationId } from "./edit-transaction.js";
import { runWithCallWorkspace } from "../util/handles.js";
import { runWithDeclaredWorkspace } from "../util/handles.js";
import { runWithProtocolCall } from "../protocol/envelope.js";
import { runWithWalkRequestScope } from "../tools/walkRepo.js";
import { servedWindowsOfResultText } from "../usage-baseline/servedWindows.js";
import { sessionLaneOf } from "./task-binding2.js";
import { settleSymbolBaselines } from "../usage-baseline/readBaseline.js";
import { toolOk } from "../protocol/result.js";
import { toolStructuredError } from "../protocol/result.js";

/**
 * Public dispatch entry point. Runs the default path through the protocol v1
 * funnel (runWithProtocolCall / finalizeProtocolResponse) over
 * dispatchWithWorkspaceNotes, which carries Fix 3's cwd auto-correction and
 * Guard 1's root_note — see that function's own doc comment for both.
 */
export async function callToolUninstrumented(name: string, args: Record<string, unknown>, editOperationCount?: number) {
  const canonical = name;

  // A1: the emit funnel counts synchronously, so an opted-in tokenizer loads here.
  // Free unless TL_WIRE_TOKENIZER asks for one, and it never throws.
  await ensureWireTokenizerLoaded();

  // protocol v1 (D1/D4/D6/§2.6): ONE funnel, one envelope. Every response the
  // three advertised tools emit on the default path leaves through here, which
  // is what makes "a payload without `v` is not a protocol-v1 payload" (§1.2)
  // a property of the code rather than of 287 disciplined call sites.
  // `args` rides the context so the family projectors can SYNTHESISE a
  // continuation from what the caller actually asked for (A.5.8's `find` and
  // `symbols` limits) rather than from a rendering of it — see
  // `ProtocolCallContext.args`.
  // F-A7: clientId rides the SAME shared funnel context every era/leg
  // already threads through this one call site.
  const clientId = resolvedClientId();
  let configuredRoot: string | undefined;
  if (canonical === "tl_read_file") {
    try { configuredRoot = resolveWorkspaceRoot(undefined, activeRoot); }
    catch { /* the wire-size projection then counts every cwd */ }
  }
  const runThroughFunnel = (): Promise<ToolCallResult> =>
    runWithProtocolCall(
      { tool: canonical, args, ...(editOperationCount !== undefined ? { editOperationCount } : {}), ...(clientId !== undefined ? { clientId } : {}), ...(configuredRoot !== undefined ? { configuredRoot } : {}) },
      async () => finalizeProtocolResponse(canonical, await dispatchWithWorkspaceNotes(canonical, args)),
    );

  // PI-09 close-out: `operation_id` is edit-only (see its schema comment), so
  // only tl_edit_file is wrapped; a read tool that sends it is refused by the
  // strict `unknown-arguments` fence inside dispatch. The wrapper sits OUTSIDE
  // the funnel deliberately — see `runEditWithOperationId`'s doc comment.
  if (canonical === "tl_edit_file" && args["operation_id"] !== undefined) {
    return runEditWithOperationId(args, runThroughFunnel);
  }
  return runThroughFunnel();
}

/**
 * The pre-v1 body of `callToolUninstrumented`: cwd correction, the root-mismatch
 * note, and the nested-workspace disclosure. Split out so the protocol envelope
 * has exactly one place to attach (above) and this function keeps its single
 * responsibility — none of what it does is protocol-v1 business.
 *
 * Fix 3: tl_read_file/tl_search_files-ONLY cwd auto-correction (a hallucinated
 * `.claire` cwd, or checkCwdOrRefuse's own single unambiguous
 * `nearest_existing` suggestion — see checkCwdWithCorrection's doc comment).
 * tl_edit_file and every write path is unaffected: canonical is never
 * "tl_read_file"/"tl_search_files" for them, so dispatchTool's own
 * checkCwdOrRefuse call runs completely unmodified for writes.
 *
 * Also Guard 1 (2026-07-12b; write paths 2026-08-01): a cwd-less,
 * handle-less call that resolves against the default root while another
 * workspace is also active this session carries a root_note — on the read
 * tools and on every write entry point in ROOT_NOTE_WRITE_TOOLS, so a
 * silent wrong-root WRITE self-identifies instead of reporting bare
 * success. See the otherActiveRoots block below.
 */
export async function dispatchWithWorkspaceNotes(canonical: string, args: Record<string, unknown>) {
  let cwdCorrection: CwdCorrection | undefined;
  if (canonical === "tl_read_file" || canonical === "tl_search_files") {
    const cwdCheck = checkCwdWithCorrection(args["cwd"], activeRoot);
    if (cwdCheck.refusal) return toolStructuredError(cwdCheck.refusal);
    if (cwdCheck.correction) {
      cwdCorrection = cwdCheck.correction;
      // Thread the corrected cwd through to dispatchTool — its own
      // checkCwdOrRefuse/resolveWorkspaceRoot calls re-validate this exact
      // string themselves, so nothing below is trusting this blindly.
      args = { ...args, cwd: cwdCheck.correction.to };
    }
  }

  // Declaration scope (2026-08-09 root-mismatch incident): every handle minted
  // during this call inherits whether the CALLER named the root it resolves
  // against — an explicit cwd, or the single declared root it adopts from the
  // handles it already carries. Without this a handle records only WHICH root
  // it captured, never whether anyone chose it, and a cwd-less mint → cwd-less
  // edit chain has no premise for any guard to evaluate. See
  // util/handles.ts's workspaceDeclared.
  // PI-09 rehydration scope. DELIBERATELY SEPARATE from the declaration scope
  // above: declaration is a security premise (did the CALLER name this root?)
  // and must stay narrow, while "which store may this call read?" is a
  // question every call can answer. Wrapping the two together would have
  // widened the write guard as a side effect of adding persistence.
  let callWorkspaceRoot: string | undefined;
  try {
    callWorkspaceRoot = resolveWorkspaceRoot(args["cwd"] as string | undefined, activeRoot);
  } catch {
    // An unresolvable cwd is refused inside dispatch with its own shape; no
    // store scope simply means handle rehydration is unavailable for it.
    callWorkspaceRoot = undefined;
  }
  // D1 (F-C2a): thread the workspace this call resolved against into a
  // DEDICATED context slot for protocol/codec/pipeline.ts's trace emissions
  // -- tl_read_file/tl_search_files never called `noteWorkspaceRoot` (only
  // tl_edit_file's finishEdit does), so the codec pipeline's
  // `context.workspace !== undefined` trace gate was permanently closed for
  // the two codec-ELIGIBLE tools, and the wire_codec_shadow/
  // wire_codec_v2_cell measurement feed could never fire through real
  // dispatch (F-C2). `callWorkspaceRoot` (just above) is exactly the root
  // dispatchTool is about to run against (`runWithCallWorkspace` below), so
  // this is the SAME value, taken at dispatch entry rather than at a
  // write's completion because tl_read_file/tl_search_files have no post-dispatch
  // completion hook to take it at.
  //
  // NOTE: this calls `noteCodecTraceWorkspace`, NOT `noteWorkspaceRoot` --
  // an earlier version of this fix populated `context.workspace` directly
  // and broke wireBaselines.spec.ts's pinned bytes, because
  // `readFamily.ts`'s `projectReadBody` ALSO reads `context.workspace` (via
  // this module's envelope, to decide whether a `read.receipt`'s
  // continuation echoes `cwd`) and `emit.ts` reads it to settle the
  // served-range ledger -- both wire/state-affecting, and both previously
  // saw `undefined` on every read/search call. `codecTraceWorkspace` is
  // read by nothing except the codec pipeline, so this note is genuinely
  // TRACE-ONLY: zero wire bytes, zero served-range-ledger effect.
  // `noteWorkspaceRoot`'s own tl_edit_file call site (finishEdit, below) is
  // untouched either way.
  //
  // We are still inside runWithProtocolCall's AsyncLocalStorage scope here
  // (callToolUninstrumented's runThroughFunnel wraps this whole function), so
  // the note lands in the same context finalizeProtocolResponse reads later,
  // exactly like finishEdit's own call does many frames deeper.
  if (callWorkspaceRoot !== undefined) noteContinuationWorkspace(callWorkspaceRoot);
  if ((canonical === "tl_read_file" || canonical === "tl_search_files") && callWorkspaceRoot !== undefined) {
    noteCodecTraceWorkspace(callWorkspaceRoot);
  }
  // VF-5/VF-7: same dedicated-slot posture as `noteCodecTraceWorkspace` just
  // above -- tl_read_file's `mode==="closure"` handler needs a workspace root
  // to look up the task epoch's recorded verify obligations and to gate a
  // kit-less `closure-complete` claim, and (like the codec trace slot) this
  // must NOT reuse `noteWorkspaceRoot`'s `context.workspace`, which stays
  // edit-only per that function's own doc comment.
  if (canonical === "tl_read_file" && callWorkspaceRoot !== undefined) {
    noteVerifyClosureWorkspace(callWorkspaceRoot);
  }
  // FX-N (ruling (s), 2026-09-03): same dedicated-slot posture again, for the
  // one consumer that turns [R5-10]'s retraction half back on for the READ
  // family -- `protocol/emit.ts`'s `settleServedCallBookings`. Before this
  // line, `settleServedRanges` ran only under `context.workspace`, which only
  // `finishEdit` ever sets, so a `tl_read_file` that booked a provisional serve
  // span and then shed to `refusal/cap-exceeded` kept the booking and answered
  // the next slice `code-unchanged` naming the refusal as the serve (round-16
  // finding 1a). Read/search only: an edit already carries `context.workspace`
  // and must keep using it, since that value is taken as late as possible (a
  // handle may make the write ADOPT its own mint root).
  if ((canonical === "tl_read_file" || canonical === "tl_search_files") && callWorkspaceRoot !== undefined) {
    noteReadServeWorkspace(callWorkspaceRoot);
  }
  // Perf (2026-09-27, item C): a per-request walkCodeFiles memo, open ONLY
  // for tl_read_file/tl_search_files — never tl_edit_file, since a write can change
  // what the very next walk in the SAME request would see (see
  // runWithWalkRequestScope's own doc comment in walkRepo.ts). Nested
  // OUTSIDE runWithCallWorkspace/runWithDeclaredWorkspace: it is its own
  // independent AsyncLocalStorage slot, so nesting order relative to those
  // two does not matter, but keeping it outermost here means every walk
  // triggered anywhere in dispatchTool's call tree for this dispatch sees it.
  const runDispatch = () => runWithCallWorkspace(callWorkspaceRoot, () => runWithDeclaredWorkspace(
    declaredWorkspaceForCall(args),
    () => dispatchTool(canonical, args),
  ));
  const result = await (
    canonical === "tl_read_file" || canonical === "tl_search_files"
      ? runWithWalkRequestScope(runDispatch)
      : runDispatch()
  );
  // Land this call's handle mints BEFORE the response is emitted. Flushing
  // here rather than on a timer is what makes "answer, then SIGKILL, then
  // replay the handle against a fresh process" a deterministic test instead of
  // a race — and it batches a task_pack's dozens of mints into one append.
  flushHandleEntries();

  // Guard 1 (2026-07-12b cross-workspace-bleed forensics; write paths added
  // 2026-08-01): a cwd-less, handle-less call silently resolves against the
  // server's DEFAULT root. When another workspace also holds an active
  // session (an agent working a worktree that has issued at least one
  // cwd=<worktree> call this server lifetime), that silent resolution is a
  // live hazard — the agent can read the WRONG tree's complete state and
  // conclude a feature is "already wired" (bench 2026-07-12a2 forensics), or
  // CREATE a file in it and be told plainly that it worked (bench
  // 2026-08-01-semantic-signal5-2 T13 rep2). A handle carries its own mint
  // root so it is exempt; an explicit cwd states intent so it is exempt too.
  // otherActiveRoots is a read-only registry scan — it never creates a
  // session for the resolved root or any other root, so merely asking never
  // manufactures the very ambiguity this is trying to detect. Independent of
  // the cwd-correction block above, so it can fire whether or not a
  // correction also happened.
  const rootNoteWriteTool = ROOT_NOTE_WRITE_TOOLS.has(canonical);
  let rootNote: string | undefined;
  if (
    (ROOT_NOTE_READ_TOOLS.has(canonical) || rootNoteWriteTool) &&
    // Read paths keep their success-only contract (a failed read reports the
    // failure it hit, not an unrelated note). Write paths disclose on
    // FAILURE too: a refusal minted against a root the caller never named is
    // precisely when "which tree answered?" is load-bearing — e.g. a
    // search-not-found that is really a wrong-tree miss.
    (rootNoteWriteTool || !result.isError) &&
    !isCwdExplicit(args["cwd"]) &&
    !callPinsRootViaHandle(args)
  ) {
    rootNote = rootMismatchNote(
      resolveWorkspaceRoot(args["cwd"] as string | undefined, activeRoot),
    );
  }

  // Ambiguity disclosure (2026-08-09): the incident's four responses named no
  // root anywhere — mints and applied edits alike — so the caller had nothing
  // to check its own assumption against, and the wrong tree was only found by
  // running `git status` outside TL entirely. When (and ONLY when) the
  // resolved workspace physically contains another live workspace, every mint
  // and every write success states which tree answered, and a read that
  // reaches into a nested workspace says so instead of looking local. The
  // this is the bounded default-protocol form of the same honesty, kept off
  // the unambiguous path so single-root deployments stay byte-identical.
  let workspaceDisclosure: string | undefined;
  let workspaceCrossing: string | undefined;
  if (
    !result.isError
    && (ROOT_NOTE_READ_TOOLS.has(canonical) || rootNoteWriteTool)
  ) {
    const effective = effectiveCallWorkspace(args);
    if (nestedWorkspaceRoots(effective).length > 0) {
      workspaceDisclosure = effective;
      for (const target of readTargetPaths(args)) {
        const crossed = nestedWorkspaceCrossing(target, effective);
        if (crossed !== undefined) {
          workspaceCrossing = crossed;
          break;
        }
      }
    }
  }

  // Stamp the adopted correction and/or root-mismatch note onto the
  // top-level payload. A write path's root_note also rides its structured
  // refusals, per the condition below.
  //
  // FX-P4 (2026-09-03, closing the gap FX-P3 reported as `cwdNearMiss.spec.ts`
  // test "B"): Finding 2 (INV-H; DESIGN-v0.15-sf-turn-economy.md §1.2 ratified
  // ruling) calls for disclosing `cwd_corrected` on an error response too, when
  // a correction happened but the subsequent lookup still failed (e.g. the
  // corrected root is the right tree but lacks the requested file, so the call
  // ends in an ordinary `not-found`). This stamp used to reach the wire only
  // for the SUCCESS kind: for tl_read_file/tl_search_files,
  // `finalizeProtocolResponse` (protocol/envelope.ts) classifies every error
  // body as `kind:"refusal"` and rebuilds the payload from scratch via
  // `buildRefusal` (protocol/refusal.ts), which reads only its own closed
  // core+advisory key set off `body` and used to drop anything else —
  // including a `cwd_corrected` spliced in here before that rebuild ran.
  // `buildRefusal` now carries `cwd_corrected` in `REFUSAL_ADVISORY_KEYS`
  // (excluded for the `invalid-cwd`/`cwd-required-for-edit`/
  // `cwd-required-for-create` codes, where a correction and the refusal that
  // names the cwd itself as the problem would be contradictory — a
  // combination `checkCwdWithCorrection` never actually produces, since a
  // correction and its own pre-correction refusal are mutually exclusive
  // return arms), so this site only needs to stop withholding the value on
  // error; `cwdCorrection` is populated exclusively on the tl_read_file/
  // tl_search_files path above, so widening this to every tool never applies.
  const stampRootNoteOnError =
    rootNote !== undefined && rootNoteWriteTool && result.isError === true;
  const stampCwdCorrectionOnError =
    cwdCorrection !== undefined && result.isError === true;
  if (
    (cwdCorrection || rootNote || workspaceDisclosure)
    && (!result.isError || stampRootNoteOnError || stampCwdCorrectionOnError)
  ) {
    try {
      const parsed = JSON.parse(result.content[0]!.text) as Record<string, unknown>;
      const payload = {
        ...parsed,
        ...(cwdCorrection ? { cwd_corrected: cwdCorrection } : {}),
        ...(rootNote ? { root_note: rootNote } : {}),
        ...(workspaceDisclosure ? { workspace: workspaceDisclosure } : {}),
        ...(workspaceCrossing ? { workspace_crossing: workspaceCrossing } : {}),
      };
      // Re-mint a refusal envelope directly instead of routing back through
      // toolStructuredError: `parsed` already carries supplyRefusalGuidance's
      // output, and re-running it would double-apply that guidance.
      return result.isError
        ? { content: [{ type: "text", text: JSON.stringify(payload) }], isError: true as const }
        : toolOk(payload);
    } catch {
      return result; // defensive: every helper above emits JSON; should be unreachable.
    }
  }
  return result;
}

export let usageRecorder: UsageRecorder | undefined;

export function recorder(): UsageRecorder {
  usageRecorder ??= createUsageRecorder({
    workspaceRoot: activeRoot,
    sessionId: SESSION_ID,
    serverVersion: SERVER_PACKAGE_VERSION,
    serverBuild: SERVER_BUILD_ID,
  });
  return usageRecorder;
}

// v0.16.4: the baseline is what a NATIVE read of the same files/ranges would
// return, not the whole-file size of every requested path — see
// usage-baseline/readBaseline.ts. A whole-file read keeps the file's size up to
// one native read window (2,000 lines / 25,000 tokens; credited once per path
// per lane); a ranged, symbol or handle-slice read is credited only its
// range/served-symbol bytes (same bound) and recorded as "range-bytes".
export type ReadBaselineMeasurement = UsageReadBaselineMeasurement;

export function readBaselineMeasurement(
  canonical: string,
  args: Readonly<Record<string, unknown>>,
): ReadBaselineMeasurement {
  if (canonical !== "tl_read_file") return emptyReadBaseline();
  let workspace: string;
  try {
    workspace = resolveWorkspaceRoot(
      typeof args["cwd"] === "string" ? args["cwd"] : undefined,
      activeRoot,
    );
  } catch {
    return emptyReadBaseline();
  }
  try {
    return measureReadBaseline({
      workspace,
      args,
      credited: creditedReadPathsByLane.get(sessionLaneOf(args as Record<string, unknown>)),
      resolveHandle: (handle) => {
        const entry = handleTable.get(handle);
        return entry !== undefined && entry.workspaceRoot === workspace
          ? { path: entry.path, range: entry.range, symbol: entry.symbol }
          : undefined;
      },
      handleOverrides: (args as Record<PropertyKey, unknown>)[HANDLE_OVERRIDES_INPUT] as
        | Array<Record<string, unknown> | undefined>
        | undefined,
    });
  } catch {
    // Usage measurement runs outside the call's try block and must never alter its outcome.
    return emptyReadBaseline();
  }
}

/** Estimated native-read tokens for a (settled) baseline measurement; null = none. */
export function readBaselineTokens(measurement: ReadBaselineMeasurement): number | null {
  return measurement.bytes === null ? null : estimateTokensFromBytes(measurement.bytes);
}

/**
 * A symbol read's baseline is the symbol window the response SERVED, known only
 * once the result exists. A result that declares no window settles it to 0
 * bytes rather than the whole file.
 */
export function settleReadBaselineSymbols(
  measurement: ReadBaselineMeasurement,
  args: Readonly<Record<string, unknown>>,
  result: { content: Array<{ text: string }> },
): ReadBaselineMeasurement {
  if (measurement.pendingSymbols.length === 0) return measurement;
  try {
    const workspace = resolveWorkspaceRoot(
      typeof args["cwd"] === "string" ? args["cwd"] : undefined,
      activeRoot,
    );
    return settleSymbolBaselines(
      measurement,
      workspace,
      servedWindowsOfResultText(result.content[0]?.text),
    );
  } catch {
    return { ...measurement, pendingSymbols: [] };
  }
}
