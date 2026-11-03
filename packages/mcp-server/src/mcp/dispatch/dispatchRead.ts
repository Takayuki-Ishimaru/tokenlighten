import { read_taskPack } from "./read/taskPack.js";
import { read_map } from "./read/map.js";
import { read_overview } from "./read/overview.js";
import { read_markdownSections } from "./read/markdownSections.js";
import { read_closure } from "./read/closure.js";
import { read_slice } from "./read/slice.js";
import { read_pack } from "./read/pack.js";
import { read_artifact } from "./read/artifact.js";
import { read_skeletonBatch } from "./read/skeletonBatch.js";
import { read_fullBatch } from "./read/fullBatch.js";
import { read_csvText } from "./read/csvText.js";
import { read_symbol } from "./read/symbol.js";
import { read_full } from "./read/full.js";
import { read_auto } from "./read/auto.js";
import type { ToolCallResult } from "../../protocol/result.js";
import { batchHintsEnabled, readSnapshotEnabled, reserveSmallWindowsEnabled, artifactQueryWindowEnabled } from "../../util/flags.js";
import { requestShapeRefusal } from "../../validation/requestShape.js";
import { toolStructuredError, toolError, toolOk } from "../../protocol/result.js";
import { guardCwd } from "../../write/guardedWorkspace.js";
import { activeRoot, ALLOW_WRITE, DOC_DISABLED } from "../../runtime/config.js";
import { resolveCredentialRef } from "../../security/credentials.js";
import { HANDLE_WIRE_PREFIXES, type ToolCall } from "@tokenlighten/types";
import { currentSessionLane } from "../../util/laneKey.js";
import { protocolCallContext, canonicalToolCall, declareKind, notePostReadyDiscovery, noteEpochNewRoot, noteServedBytesSource, noteResolvedMode } from "../../protocol/envelope.js";
import { resolveReadCursor, stagedFromResolution, subtractWindows, parseWindows, windowStrings, wireWindowsCostBytes, pageEnvelopeReserve, pageRowOverhead, pageReadMetadataOverhead, type PageChoice, choosePage, fixPage, batchWindowWireCost } from "../../state/readRequestStore.js";
import { csvPageModel, csvTable } from "../../office/csv.js";
import { readBytesSafe, safeResolve } from "../../util/safePath.js";
import { shaOfBytes, shaOfText, shortSha, handleTable } from "../../util/handles.js";
import { resolveSnapshot } from "../../state/snapshotStore.js";
import { acknowledgeRangeStaleness, getExecutionFence, noteDiscoveryServedNoBytes, guardExecutionDiscovery, recordReadMode, beginServeCall, recordServedRange, recordReadPath } from "../../state/session.js";
import { estimateBytesFromTokens, bindToResponseCeiling } from "../../protocol/budget/wireBudget.js";
import { chooseCsvPage } from "../../state/artifactReadRequest.js";
import { rowsOverlappingWindows } from "../../office/csvWindow.js";
import { selectorFromArgs, virtualArchivePath, splitArchiveVirtualPath, readArchiveMember, archivePathFromTaskPaths, buildArchiveTaskPack, archiveTaskDecision, isSupportedArchivePath, buildArchiveManifest } from "../../tools/archive.js";
import { canServeCachedTaskPackReceipt } from "../../features/task-pack/engine/receiptRestoration2.js";
import { buildTaskPack } from "../../features/task-pack/engine/taskPackEntry.js";
import { resolveCallerByteCeiling, resolveSlice, resolveDigest, READ_SYMBOL_CAP_BYTES } from "../../tools/readCodeModes.js";
import { countLines } from "../../util/countLines.js";
import { type ServedTextVerdict, readServedText } from "../../util/textDecode.js";
import { elideSymbolContextForDisplay, getSymbolWithContext } from "../../tools/getSymbolWithContext.js";
import { languageForPath } from "../../util/languages.js";
import { elideDocCommentsForExplicitWindow, spansExcludingWindows } from "../../util/formatCompress.js";
import { getFileSkeleton } from "../../tools/getFileSkeleton.js";
import { selectQueryEvidence } from "../../tools/queryEvidence.js";
import { attachSupply } from "../../util/attachSupply.js";
import { runWithTaskContractScope } from "../../features/task-pack/taskContractStore.js";
import { naturalQueryForScope } from "../../features/task-pack/taskContractStore.js";
import { taskContractScopeForPack } from "../../serverOwned/task-binding2.js";
import { normalizeContractLane } from "../../util/packServeLog.js";
import { inheritedTaskProfileArgs } from "../../runtime/requestState.js";
import "../../util/trace.js";
import "../../task-state/irDispatchSeam.js";
import { existsSync, statSync } from "node:fs";
import { isMarkdownPath } from "../../util/markdownSections.js";
import "../../tools/readCodeOverview.js";
import "../../util/closureTracking.js";
import "../../protocol/readFamily.js";
import "../../protocol/coverageReceipt.js";
import "../../tools/readCodePack.js";
import { buildSmallFile } from "../../tools/readCodeSmallFile.js";
import { prepareOfficeDocument } from "../../office/decrypt.js";
import { mustFetchReadBudget } from "../../util/mustFetch.js";
import "path";
import { extractOfficeText } from "../../tools/extractOfficeText.js";
import "../../util/fullGovernor.js";
import { LEGACY_PATHS_INTERNAL_HANDLE_INPUT, MULTI_TARGET_SELECTOR_REFUSAL_INPUT, RANGE_CONTENT_FULL_INPUT, CANONICAL_ALLOWFULL_INPUT, SMALL_WINDOW_RESERVE_FORCE, HANDLE_OVERRIDES_INPUT, stageWindowReadRequest, OUTER_BATCH_RESERVE_BYTES, resolvePathsBatchEntry } from "../../serverOwned/canonical-input.js";
import { dispatchPropertiesFor, LEGACY_PATHS_SCHEMA_INTERNAL } from "../../serverOwned/tool-schema.js";
import { READ_LEDGER_SCHEMA, parseReadLedgerInput, type ReadLedgerEntry, noteReadFamilySerialSingleTargetCall } from "../../serverOwned/workspace-routing.js";
import { withPublicRecoveryKeys } from "../../serverOwned/edit-validation.js";
import { resolveWorkspaceRoot, servedTextForRoute, taskPackRecoveryFor, handleWorkspaceMissingDetail, type TaskPackQueryResolution, resolveTaskPackQueryArg, taskPackReceiptPreflightArgs, admitCallerRangedContinuation, nulStrippedNoteText, DOC_CONTENT_CAP_BYTES, officeOrArchiveSurfaceRefusal, parseTaskProfile, parseMcpLang, mapTaskPackPaths, rememberTaskPackQuery, attachServerBuildOnce, undecodableTextMessage, nulStrippedNote, configuredAllowedParents } from "../../serverOwned/read-admission2.js";
import { isCwdExplicit, resolveHandleWorkspace } from "../../serverOwned/workspace-routing2.js";
import { applyRecoveredTaskHandleFromQref, recoverAuthFailedTaskHandle, dropDeadTaskHandleForNewEpoch } from "../../serverOwned/search-support.js";
import { taskHandleRefusal } from "../../serverOwned/search-support2.js";
import { applyHandleOnlyResume } from "../../serverOwned/edit-transaction.js";
import { parseCommentsMode, csvArtifactShape, READ_FULL_CAP_BYTES, parseSmallFileContent } from "../../serverOwned/artifact-csv.js";
import { serveSnapshotExpansion, SNAPSHOT_RESERVE_BYTES, snapshotUnavailable } from "../../serverOwned/artifact-csv2.js";
import { FULL_SERVE_CHUNK_BYTES, addressServedReceipt } from "../../serverOwned/read-receipts.js";
import { collectSmallWindowTargets, measureSmallWindowTotal, RESERVE_SMALL_WINDOWS_MAX_LINES, RESERVE_SMALL_WINDOWS_MAX_BYTES, qrefRepackTargetsHaveUnservedWindow, explicitTargetsReadable, normalizeCanonicalRequest, TARGET_PROJECTION_SYNC_KEYS, discoveryScopeClass, type HeldBatchWindowEntry, heldBatchWindowEntry, windowedBatchBytes, BATCH_SINGLE_RESPONSE_MAX_BYTES } from "../../serverOwned/canonical-input4.js";
import { CANONICAL_ORIGINAL_INPUT, QUERY_CANDIDATE_POLICY_INPUT } from "../../serverOwned/canonical-input2.js";
import { inheritDeclaredTaskProfile } from "../../serverOwned/task-binding.js";
import { requestElisionProbe, autoReadServesFileContent, AUTO_SMALL_FILE_BYTES } from "../../serverOwned/canonical-input3.js";
import { rangeStartLine } from "../../serverOwned/edit-anchor.js";
import { taskPackQueryErrorPayload, projectTaskPackWire, recordTaskPackSurfaceReads, recordTaskPackExecution } from "../../serverOwned/task-pack-wire.js";
import { taskContractScopeOf, canonicalTaskBindingOf } from "../../serverOwned/task-binding2.js";
import { taskPackByteCeiling, taskPackAdmission } from "../../serverOwned/read-admission.js";
import { resolveFullReadForPath, fullReadRefusal } from "../../serverOwned/read-receipts2.js";

export interface dispatchReadPort {
  "args": Record<string, unknown>;
  "defaultResponseByteCeiling": number | undefined;
}
export async function dispatchRead(port: dispatchReadPort): Promise<ToolCallResult | undefined> {
  const { args, defaultResponseByteCeiling } = port;

      // P1 / D2 / ORCHESTRATOR CONDITION ② (§1.3.1(1)): strict recursive NAME
      // validation, before any cwd/handle/credential resolution or
      // session-state mutation — the same position tl_edit_file's own guard has
      // held since 2026-08-01. Value validation is untouched (§1.3.1(6)):
      // `lang` is still a bare string checked by parseMcpLang below.
      // W-BATCH-HINT (c): `ledger` is spliced into the validation properties
      // ONLY when TL_BATCH_HINTS is on — flag off, this is the exact same
      // `dispatchPropertiesFor("tl_read_file")` object as before, so a caller
      // sending `ledger` is refused `unknown-arguments` byte-identically to
      // any other unadvertised key (no special-case branch needed for that;
      // it falls out of requestShapeRefusal not knowing the key at all).
      // FX-M8: `args.paths` may be the internal `targets` -> `paths[]`
      // projection (legacyPathTarget, FX-M1/E1) rather than a caller's own
      // legacy input — the marker is set only at those synthesis sites. Swap
      // in the handle-inclusive internal schema for `paths` ONLY in that
      // case, so the wire-facing LEGACY_PATHS_SCHEMA (and the `keys` a real
      // caller's unknown-arguments refusal advertises) never lists `handle`.
      const pathsSynthesizedInternally = (args as Record<PropertyKey, unknown>)[LEGACY_PATHS_INTERNAL_HANDLE_INPUT] === true;
      delete (args as Record<PropertyKey, unknown>)[LEGACY_PATHS_INTERNAL_HANDLE_INPUT];
      const readFileValidationProperties = {
        ...dispatchPropertiesFor("tl_read_file"),
        ...(batchHintsEnabled() ? { ledger: READ_LEDGER_SCHEMA } : {}),
        ...(pathsSynthesizedInternally ? { paths: LEGACY_PATHS_SCHEMA_INTERNAL } : {}),
      };
      const unknownArgsRefusalRead = requestShapeRefusal("tl_read_file", readFileValidationProperties, args);
      if (unknownArgsRefusalRead !== null) {
        // FX-R3: strip legacy-only keys from the disclosed recovery list —
        // see `advertisedKeysForRefusal`'s doc comment.
        return toolStructuredError(withPublicRecoveryKeys("tl_read_file", unknownArgsRefusalRead));
      }
      // W-BATCH-HINT (c): validate/bound the declared ledger once, up front —
      // referenced later by the mode=slice branch's cross-check against this
      // session's OWN servedRangeLedger (coverageReceiptFor). A declared span
      // this server never actually served is never trusted for anything;
      // see parseReadLedgerInput's doc comment for the truncation contract.
      const readLedger = batchHintsEnabled()
        ? parseReadLedgerInput(args["ledger"])
        : { entries: [] as ReadLedgerEntry[], truncatedNote: undefined as string | undefined };
      // I-5 fix: read back normalizeCanonicalRequest's multi-target
      // archive/artifact fail-closed marker BEFORE any mode resolution and
      // BEFORE declareKind — see MULTI_TARGET_SELECTOR_REFUSAL_INPUT's own
      // doc comment for why ordering matters here (F-V13-1 Fix B / B1
      // precedent: a refusal returned after declareKind is misclassified as
      // a successful, empty read.batch).
      const multiTargetSelectorRefusal = (args as Record<PropertyKey, unknown>)[MULTI_TARGET_SELECTOR_REFUSAL_INPUT] as
        | Record<string, unknown>
        | undefined;
      if (multiTargetSelectorRefusal !== undefined) return toolStructuredError(multiTargetSelectorRefusal);
      let mode = String(args["mode"] ?? "auto");
      // B5.1: fail loud on an invalid/nonexistent cwd instead of silently
      // resolving against the pinned root (see checkCwdOrRefuse doc comment).
      // Runs through write/guardedWorkspace.ts's stage 1 so every case reaches
      // the guard the same way — read cases keep a plain `string` workspace
      // (they cannot write); only the write cases need the brand.
      const cwdGuardRead = guardCwd(args, activeRoot);
      if (!cwdGuardRead.ok) return toolStructuredError(cwdGuardRead.refusal);
      // B1: `workspace` is a `let` because a single-handle or batch handle
      // mismatch may ADOPT the handle's own workspaceRoot (see below) rather
      // than refuse — the handle IS the workspace pin, validated at mint
      // time. Must be reassigned before any file I/O uses it.
      let workspace = resolveWorkspaceRoot(args["cwd"] as string | undefined, activeRoot);
      const cwdExplicit = isCwdExplicit(args["cwd"]);
      // G4 (2026-09-08, qref-task-scope fix): recover this task's own handle
      // from a bare qref BEFORE taskHandleRefusal or any task-contract-scope
      // resolution runs — see applyRecoveredTaskHandleFromQref's own doc
      // comment. A no-op for every call shape that is not exactly this one
      // (explicit task_handle, no qref, taskEpoch:"new", ...).
      applyRecoveredTaskHandleFromQref(args, workspace);
      // TL_TASK_HANDLE_RECOVERY: a task_handle that fails authentication may
      // still be recoverable (qref binding or a lane lineage mid-splice) —
      // see recoverAuthFailedTaskHandle's own doc comment. A no-op when the
      // flag is off, when no task_handle was presented, or when it already
      // resolves.
      recoverAuthFailedTaskHandle(args, workspace, "tl_read_file");
      // ...and a handle that still names no live task is dropped when the
      // call itself asks for a new epoch — see dropDeadTaskHandleForNewEpoch.
      dropDeadTaskHandleForNewEpoch(args, workspace, "tl_read_file");
      // PI-09: a presented task_handle is validated against THIS workspace
      // before any read runs, so a wrong-purpose/stale/foreign handle can never
      // ride along as a silent no-op.
      const taskHandleRefusalRead = taskHandleRefusal(args, workspace, "tl_read_file");
      if (taskHandleRefusalRead !== null) return toolStructuredError(taskHandleRefusalRead);
      // P1-3(c): a bare, schema-valid, LIVE `task:{handle}}` (no other
      // addressing) resumes the bound query instead of falling through to
      // "path is required" — see applyHandleOnlyResume's own doc comment.
      const handleOnlyResumeRefusal = applyHandleOnlyResume(args, workspace);
      if (handleOnlyResumeRefusal !== null) return toolStructuredError(handleOnlyResumeRefusal);
      const credential = resolveCredentialRef(args["credentialRef"]);
      if (!credential.ok) {
        return toolStructuredError(credential as unknown as Record<string, unknown>);
      }
      const credentialRef = credential.credentialRef;
      const credentialPassword = credential.password;
      const taskCredential = credentialRef !== undefined && credentialPassword !== undefined
        ? { credentialRef, credentialPassword }
        : {};

      // DESIGN-v0.8 §C3: comments=elide (default) collapses multi-line
      // doc/comment blocks in full/slice/symbol/auto content; comments=keep
      // is the escape hatch. Parsed once up front — every body-returning
      // mode branch below consults `keepComments`.
      const commentsMode = parseCommentsMode(args["comments"]);
      if (!commentsMode.ok) return toolError("comments must be elide or keep", { code: "invalid-input" });
      let keepComments = commentsMode.keep;
      // TL-05 (plan §7.1): the ORIGINAL canonical `content:"full"` fact,
      // surviving normalizeCanonicalRequest's `delete args["content"]` via
      // RANGE_CONTENT_FULL_INPUT (see that Symbol's own doc comment). Read
      // once here; each ranged dispatch below ORs it into its own
      // `effectiveKeepComments` rather than into this shared `keepComments`,
      // so a plain whole-file `content:"full"` (no range) keeps eliding
      // exactly as before — only a request that ALSO named a window is
      // affected.
      const rangeContentFullMarker = (args as Record<PropertyKey, unknown>)[RANGE_CONTENT_FULL_INPUT] === true;

      // DESIGN-v0.15 §6.3 (R6) MIGRATION NOTE.
      //
      // BEFORE this fix, canonical `content:"full"` was folded into this same
      // boolean (via the `CANONICAL_CONTENT_FULL_INPUT` marker
      // `normalizeCanonicalRequest` stamped before deleting `args["content"]`,
      // so the fact survived down to here), so simply asking for the FULL
      // representation of a file ALSO forced a resend past every ledger/
      // receipt/delta shortcut on the read path — a caller could not say "I
      // want the whole file" without also saying "and re-send it even if I
      // already hold it", and a byte-identical repeated `content:"full"` read
      // could never dedup into a receipt (R6's headline defect).
      //
      // AFTER this fix, `content:"full"`/`content:"auto"`/`content:"outline"`
      // are purely a REPRESENTATION selector, judged in the SAME served-range
      // ledger as any other window by current sha + needed range +
      // representation: fully already-read -> receipt (§6.2's `next` rule
      // still applies to it, unchanged by this variable); partially read ->
      // only the unread windows (the existing, previously-unreachable-for-
      // canonical-full `buildLedgerDifferenceFullPayload`/`fullCoverage`
      // branches below); changed sha -> current content. Only two things may
      // still force a resend regardless of what the ledger holds:
      //
      //   - `task.force_serve:true` (`force_serve` here) — the ONE resend
      //     guarantee DESIGN-v0.15 §3.3/§6.3 name ("force_serveは有効な再読
      //     要求でdedupを必ず迂回する"), for full/range/symbol/cursor reads
      //     alike.
      //   - `allowFull:true` — kept as a second forcing input, UNCONDITIONALLY
      //     (not only under `TL_LEGACY_INPUT=accept`): `allowFull`'s own
      //     advertised purpose is raising the full-read BYTE CAP
      //     (`READ_FULL_CAP_BYTES_ALLOW_FULL`), and a caller asking for a
      //     higher ceiling is asking for the ACTUAL bytes back, never a
      //     receipt a normal cap would already have permitted — so treating
      //     it as a resend request too costs nothing and matches
      //     `servedReceipts.spec.ts`'s pinned `allowFull:true forces a normal
      //     serve past an otherwise-qualifying receipt` cases (which reach
      //     this via the LEGACY `mode`/`path` dialect under
      //     `TL_LEGACY_INPUT=accept`, but the input itself — `budget.
      //     allowFull` — is canonical and not gated by that flag). The legacy
      //     `mode:"full"` dialect keeps ITS existing meaning too, but only
      //     because `mode:"full"` alone was never a forcing input on its
      //     own — it always needed `allowFull`/`force_serve` alongside it,
      //     which this boolean still honors unconditionally.
      //
      // `SERVED_CONTENT_RECEIPT_NOTE` (server.ts, above) is updated to match:
      // it no longer tells a caller that `content:"full"` forces the bytes.
      let forceContentServe = args["force_serve"] === true
        // P2-1 (2026-09-08): `allowFull` decoupled from forcing for the
        // CANONICAL dialect (budget.allowFull is a byte-cap extension only
        // now) — the legacy flat `allowFull` field keeps forcing, pinned by
        // pi03DedupHonesty.spec.ts's "legacy allowFull:true still forces"
        // case. CANONICAL_ALLOWFULL_INPUT (declared above) tells the two
        // apart under the one shared `args["allowFull"]` key.
        || (args["allowFull"] === true && (args as Record<PropertyKey, unknown>)[CANONICAL_ALLOWFULL_INPUT] !== true);

      // -----------------------------------------------------------------------
      // DESIGN-v0.15 §5.2 (R2): CURSOR CONTINUATION.
      //
      // A cursor call is not a new read — it is the NEXT PAGE of a read the
      // caller already made. Resolved here, before mode resolution, and then
      // REWRITTEN into the ordinary single-file window serve below, so the
      // page travels the same code as any other slice: same served-range
      // ledger, same receipts, same elision accounting. The only thing the
      // cursor adds is memory of the ORIGINAL request, which `emit.ts`'s tail
      // turns back into the one canonical `limit.next`.
      // -----------------------------------------------------------------------
      // B1: a snapshot handle in `targets[].handle` addresses the revision it holds. No
      // other route may see this token: it is not a file handle.
      if (readSnapshotEnabled() && typeof args["handle"] === "string" && args["handle"].startsWith(HANDLE_WIRE_PREFIXES.snapshot)) {
        return serveSnapshotExpansion(args["handle"], workspace, args);
      }
      const rawCursor = args["cursor"];
      if (typeof rawCursor === "string" && rawCursor !== "") {
        delete args["cursor"];
        const cursorLane = currentSessionLane();
        const cursorTaskHandle = typeof args["task_handle"] === "string" ? args["task_handle"] : undefined;
        const cursorCwd = typeof args["cwd"] === "string" ? args["cwd"] : undefined;
        // The `cwd` the continuation this call mints is MEASURED with: the call's own, else the workspace the canonical call
        // inherits when it names none (`attributedContinuationArguments`). A follower of a root-cwd-free `next` sends none,
        // and the wire ladder measures the minted call BEFORE the transport drops the root `cwd` from it
        // (`omitConfiguredRootCwdOnNext`), so a page fitted and a floor named without it are one `cwd` short of what the ladder
        // then judges: the retry at the named floor is refused again. The larger, safe side, as `trialContinuationEcho` is.
        const cursorMeasuredCwd = cursorCwd ?? protocolCallContext()?.continuationWorkspace ?? workspace;
        const resolvedCursor = resolveReadCursor(rawCursor, workspace, {
          ...(cursorLane !== "" ? { lane: cursorLane } : {}),
          ...(cursorTaskHandle !== undefined ? { taskHandle: cursorTaskHandle } : {}),
        });
        if (!resolvedCursor.ok) {
          // NO `next`. The server holds no state for this token, so it cannot
          // name the request to restart — only the caller can restate it
          // (§5.2: "期限切れ・状態喪失なら明示的に再開始を要求する").
          return toolStructuredError({
            ok: false,
            code: "cursor-invalid",
            field: "cursor",
            error: "this read cursor is not usable here",
            detail: `${resolvedCursor.reason}; restart the original request`,
            retry: "call",
          });
        }
        const cursorEcho = {
          ...(cursorCwd !== undefined ? { cwd: cursorCwd } : {}),
          ...(cursorLane !== "" ? { lane: cursorLane } : {}),
          ...(cursorTaskHandle !== undefined ? { taskHandle: cursorTaskHandle } : {}),
        };
        const staged = stagedFromResolution(workspace, resolvedCursor, cursorEcho);

        // SOURCE REVISION FIRST, BEFORE ANY PAGE DECISION. §5.2: "source
        // revisionが一致しない場合は新旧本文を混ぜずrefusalと原要求を再開する
        // 正準nextを返す" — the restart `next` is the request's own canonical
        // original input, never a narrowed slice of it.
        const cursorContents = new Map<string, string>();
        // A3: a csv target's revision is its BYTES' hash (the ledger's key), and its
        // pages are row runs, so it reads and chooses through its own model.
        const cursorCsvModels = new Map<string, NonNullable<ReturnType<typeof csvPageModel>>>();
        // B1: the targets whose source moved and whose pages come from a snapshot instead.
        const cursorSnapshots = new Map<string, { token: string; bytes: Uint8Array; takenAtMs: number; currentSha?: string }>();
        for (const target of staged.state.targets) {
          if (target.artifact !== undefined) {
            // served-bytes: not-served (csv/tsv container bytes: csvPageModel owns the decode)
            const csvBytes = await readBytesSafe(target.path, workspace);
            const csvModel = csvBytes !== null && shaOfBytes(csvBytes) === target.sha
              ? csvPageModel(csvBytes, { ext: target.artifact.kind })
              : undefined;
            if (csvModel !== undefined) {
              cursorCsvModels.set(target.path, csvModel);
              continue;
            }
            if (target.snapshot !== undefined) {
              const held = resolveSnapshot(target.snapshot.handle, workspace, cursorLane);
              const heldModel = held.ok && held.data.source_sha === target.sha ? csvPageModel(held.bytes, { ext: target.artifact.kind }) : undefined;
              if (held.ok && heldModel !== undefined) {
                cursorCsvModels.set(target.path, heldModel);
                cursorSnapshots.set(target.path, {
                  token: target.snapshot.handle,
                  bytes: held.bytes,
                  takenAtMs: held.data.taken_at_ms,
                  ...(csvBytes !== null ? { currentSha: shaOfBytes(csvBytes) } : {}),
                });
                continue;
              }
            }
          }
          // served-bytes: readServedText
          // AB1 (round 11): every later page of this request is SERVED from
          // `cursorContents`. The sha equality below binds those bytes to the
          // ones the minting call served, so a mismatch already fails closed —
          // but the minting call served through `readServedText` (a `stripped`
          // file's sha is over the STRIPPED text), so reading the lenient text
          // here made a perfectly continuable stripped file report
          // `cursor-stale` on page 2, and made this route the one place a
          // future decode change could reintroduce raw bytes behind a matching
          // sha. One policy at both ends.
          let text: string | null = null;
          if (target.artifact === undefined) {
            // served-bytes: readServedText
            const cursorVerdict = await servedTextForRoute(target.path, workspace);
            text = cursorVerdict === null || cursorVerdict.kind === "undecodable" ? null : cursorVerdict.text;
          }
          if (text === null || shaOfText(text) !== target.sha) {
            // eval-0929 §3/§7 (TL-06 follow-up): this refusal's restart `next`
            // re-reads this path's `range`/`content` through the ordinary
            // caller-ranged door (`admitCallerRangedContinuation`), which runs
            // its OWN staleness check against the SHARED `servedRangeLedger`.
            // Acknowledge this exact (path, freshSha) here too, for the SAME
            // reason `acknowledgeRangeStaleness`'s own doc comment gives for
            // its usual call site: without it, a verbatim retry of THIS
            // restart finds the ledger in the same "stale" state and is
            // refused a SECOND time, over a file that stopped changing after
            // the first mutation (confirmed live: two refusals before any
            // progress).
            const freshSha = text !== null ? shaOfText(text) : undefined;
            if (freshSha !== undefined) acknowledgeRangeStaleness(workspace, target.path, freshSha);
            // The restart is a FRESH request (no cursor), so nothing inherits
            // this request's budget any more — restate it explicitly from
            // what THIS cursor's own state inherited (§5.2's "原要求のbudgetは
            // 状態で継承する"), the same way a resumed (non-stale) page
            // restores it onto `args` below.
            const inheritedBudget = staged.state.budget;
            const restartBudget = inheritedBudget !== undefined
              && (inheritedBudget.bytes !== undefined || inheritedBudget.tokens !== undefined)
              ? {
                  budget: {
                    ...(inheritedBudget.bytes !== undefined ? { bytes: inheritedBudget.bytes } : {}),
                    ...(inheritedBudget.tokens !== undefined ? { tokens: inheritedBudget.tokens } : {}),
                  },
                }
              : {};
            return toolStructuredError({
              ok: false,
              code: "cursor-stale",
              field: "cursor",
              error: `the source revision of ${target.path} moved under this cursor`,
              detail: "pages of one request are never mixed across revisions; restart the request",
              retry: "call",
              next: canonicalToolCall("tl_read_file", {
                ...staged.state.original_input,
                ...restartBudget,
                ...(cursorCwd !== undefined ? { cwd: cursorCwd } : {}),
                ...(cursorLane !== "" ? { lane: cursorLane } : {}),
                ...(cursorTaskHandle !== undefined ? { task: {
                  handle: cursorTaskHandle,
                  ...(staged.state.force_serve_origin === true ? { force_serve: true } : {}),
                } } : {}),
              }),
            });
          }
          cursorContents.set(target.path, text);
        }

        // -------------------------------------------------------------------
        // DESIGN-v0.15 §5.2: "原要求のbudgetは状態で継承する".
        //
        // A minted cursor call carries NO `budget` — a follower runs `next`
        // verbatim, which is exactly what AGENTS.md tells it to do. The
        // inherited budget used to reach `choosePage` ONLY, so the page was
        // SIZED for 1024 B while `emit.ts` measured the finalized response
        // against `context.args.maxBytes`/`maxTokens` — absent on a
        // cursor-only call — and therefore against the much larger calibrated
        // ceiling. The same data at an inherited 1024 B shipped at ~1193 B.
        //
        // Restored onto THIS CALL'S ARGS, in the same `maxBytes`/`maxTokens`
        // slots `mapCanonicalBudget` fills for a declared `budget`, and before
        // any dispatch reaches the producer — so the producer's own ceiling
        // sees the one number the caller actually asked for. (R2-R1: THIS
        // `args` is the dispatcher's private copy — `normalizeWireArgs` spreads
        // the input — so `ProtocolCallContext.args`, the INBOUND arguments the
        // emit funnel reads, never carries it: the wire ladder still measures
        // a cursor-only call against the calibrated ceiling. `emit.ts` therefore
        // takes the inherited budget from the staged request itself
        // (`context.readRequest.state.budget`) for its pre-settle fit.) An
        // EXPLICIT `budget` on the continuation call overrides it (§5.2's
        // sanctioned override) and BECOMES the request's inherited budget for
        // every later page.
        // -------------------------------------------------------------------
        const declaredCursorBytes = typeof args["maxBytes"] === "number" && args["maxBytes"] > 0
          ? Math.floor(args["maxBytes"])
          : undefined;
        const declaredCursorTokens = typeof args["maxTokens"] === "number" && args["maxTokens"] > 0
          ? Math.floor(args["maxTokens"])
          : undefined;
        if (declaredCursorBytes !== undefined || declaredCursorTokens !== undefined) {
          staged.state = {
            ...staged.state,
            budget: {
              ...(declaredCursorBytes !== undefined ? { bytes: declaredCursorBytes } : {}),
              ...(declaredCursorTokens !== undefined ? { tokens: declaredCursorTokens } : {}),
            },
          };
        } else {
          const inherited = staged.state.budget;
          if (inherited?.bytes !== undefined) args["maxBytes"] = inherited.bytes;
          if (inherited?.tokens !== undefined) args["maxTokens"] = inherited.tokens;
        }
        // The page-sizing budget is the TIGHTER of the two, converted through
        // the same ratio `emit.ts` uses, so `choosePage` and the wire ladder
        // are bounded by one number rather than two.
        //
        // 2026-10-24 (read-page ceiling): and never WIDER than the client's
        // response ceiling. The request's own budget used to stand alone, with the
        // ceiling only the fallback for a request that declared none; a budget the
        // request inherited from a call above the ceiling sized pages the client
        // spills. `emit.ts` binds the reply with the same rule
        // (`bindToResponseCeiling`), so the page this fixes and the reply it ships
        // are held to one number.
        const effectiveCursorBytes = staged.state.budget?.bytes;
        const effectiveCursorTokenBytes = estimateBytesFromTokens(staged.state.budget?.tokens);
        const explicitCursorBudget = effectiveCursorBytes !== undefined && effectiveCursorTokenBytes !== undefined
          ? Math.min(effectiveCursorBytes, effectiveCursorTokenBytes)
          : effectiveCursorBytes ?? effectiveCursorTokenBytes;
        const cursorBudget = bindToResponseCeiling(explicitCursorBudget, defaultResponseByteCeiling)
          ?? FULL_SERVE_CHUNK_BYTES;
        // True when the CLIENT'S CEILING, not a budget the request declared, is
        // what bounds the page: the ceiling is a target and never a reason to
        // refuse (a page's one line may be wider than it), a declared budget is
        // the caller's own floor to raise.
        const cursorCeilingBinds = defaultResponseByteCeiling !== undefined
          && (explicitCursorBudget === undefined || defaultResponseByteCeiling < explicitCursorBudget);
        const linesOf = (path: string): string[] | undefined => {
          const text = cursorContents.get(path);
          return text === undefined ? undefined : text.replace(/\r\n/gu, "\n").split("\n");
        };

        // §5.2 forbids narrowing an ALREADY-FIXED page, so a budget that
        // cannot hold one is answered with the floor, never a shrunken page.
        // Applies to every page THIS CALL did not itself choose — a plain
        // resend, and (defect 4) a page a concurrent writer fixed first and
        // this call therefore REUSED.
        const fixedPageFloorRefusal = (
          page: { windows: Array<{ path: string; window: { start: number; end: number } }> },
        ): ReturnType<typeof toolStructuredError> | undefined => {
          const pagePathFixed = page.windows[0]?.path;
          const linesFixed = pagePathFixed === undefined ? undefined : linesOf(pagePathFixed);
          if (pagePathFixed === undefined || linesFixed === undefined) return undefined;
          // MEASURED THE WAY THE WIRE MEASURES IT (`wireLineCostBytes`), the
          // same estimator `choosePage` fixed the page with — otherwise the
          // floor this names and the boundary that was chosen disagree on
          // every line carrying a quote or a backslash.
          const fixedWindows = page.windows
            .filter((entry) => entry.path === pagePathFixed)
            .map((entry) => entry.window);
          const target = staged.state.targets.find((entry) => entry.path === pagePathFixed);
          const remainingAfterPage = target === undefined
            ? []
            : subtractWindows(parseWindows(target.remaining), fixedWindows);
          const elided = target?.elided === undefined ? [] : windowStrings(target.elided);
          const required = wireWindowsCostBytes(linesFixed, fixedWindows)
            + pageEnvelopeReserve(pagePathFixed, cursorMeasuredCwd)
            + pageRowOverhead(pagePathFixed) * fixedWindows.length
            + pageReadMetadataOverhead(windowStrings(remainingAfterPage), elided);
          // A bare continuation does not carry the original request's budget:
          // that stored value sizes new pages, but is not a declared limit on
          // THIS call. Only a budget present on THIS cursor call may require a
          // fixed-page floor refusal.
          const cursorBudgetDeclaredOnThisCall = declaredCursorBytes !== undefined
            || declaredCursorTokens !== undefined;
          if (!cursorBudgetDeclaredOnThisCall || cursorBudget >= required || cursorCeilingBinds) return undefined;
          return toolStructuredError({
            ok: false,
            code: "budget-below-minimum",
            field: "budget",
            error: `budget ${cursorBudget} B cannot hold this already-fixed page`,
            detail: "a fixed page is never narrowed; raise budget.bytes to required_min_bytes",
            required_min_bytes: required,
            retry: "call",
          });
        };

        // THE PAGE, FIXED ONCE. A resend whose cursor already named a page gets
        // that page back verbatim, whatever budget it declares.
        let cursorPage = staged.state.pages.find(
          (page) => page.cursor_state_version === resolvedCursor.cursorVersion,
        );
        if (cursorPage === undefined) {
          // A client with a ceiling sizes each window's own row too: its remainder
          // is the code windows between the comment blocks the default policy
          // elides, often dozens of them, and `choosePage` charged lines alone.
          const rowOverhead = defaultResponseByteCeiling === undefined
            ? 0
            : pageRowOverhead(staged.state.targets.find((entry) => entry.remaining.length > 0)?.path ?? "");
          const chooseAt = (bytes: number): PageChoice => cursorCsvModels.size > 0
            ? chooseCsvPage(staged.state, (path) => cursorCsvModels.get(path), bytes, (path) => cursorCsvModels.get(path)?.columns ?? [], cursorMeasuredCwd, cursorSnapshots.size > 0 ? SNAPSHOT_RESERVE_BYTES : 0)
            : choosePage(staged.state, linesOf, bytes, cursorMeasuredCwd, rowOverhead);
          let choice = chooseAt(cursorBudget);
          // Materialize an indivisible line for the final wire fitter, which
          // returns a bounded terminal refusal if it cannot fit the ceiling.
          if (!choice.ok && choice.reason === "budget-below-minimum" && cursorCeilingBinds) {
            choice = chooseAt(choice.requiredMinBytes);
          }
          if (!choice.ok && choice.reason === "budget-below-minimum") {
            return toolStructuredError({
              ok: false,
              code: "budget-below-minimum",
              field: "budget",
              error: `budget ${cursorBudget} B cannot hold one whole line of this page plus its envelope`,
              detail: "raise budget.bytes to at least required_min_bytes and re-send the same cursor",
              required_min_bytes: choice.requiredMinBytes,
              retry: "call",
            });
          }
          if (choice.ok) {
            const fixed = fixPage(staged, resolvedCursor.cursorVersion, choice);
            if (!fixed.ok && fixed.reason === "state-conflict") {
              // DESIGN-v0.15 §5.2's page fixing is a CAS, and this server
              // could neither prove the boundary nor adopt a proven one
              // within its bounded retry. Serving a page whose fixation is
              // unknown is exactly the lost update that let two concurrent
              // calls on one cursor return two different windows, so this
              // fails closed instead. RE-SENDING THE SAME CURSOR recovers:
              // the winning writer's page is then simply found and reused.
              return toolStructuredError({
                ok: false,
                code: "state-conflict",
                field: "cursor",
                error: "this read cursor's page could not be fixed under CAS",
                detail: `another call is advancing the request this cursor addresses (cursor state version ${resolvedCursor.cursorVersion}); re-send the same cursor`,
                retry: "call",
              });
            }
            if (fixed.ok) {
              cursorPage = fixed.page;
              // A REUSED page was chosen by somebody else's budget.
              if (fixed.reused) {
                const refusal = fixedPageFloorRefusal(fixed.page);
                if (refusal !== undefined) return refusal;
              }
            }
          } else {
            // D became empty between pages (another read in this lane covered
            // it). Re-address the LAST page so the ordinary serve path answers
            // with its own honest `read.receipt`; the emit tail then drops the
            // continuation because nothing is owed (§3.3, §6.2).
            cursorPage = staged.state.pages[staged.state.pages.length - 1];
          }
        } else {
          const refusal = fixedPageFloorRefusal(cursorPage);
          if (refusal !== undefined) return refusal;
        }
        if (cursorPage === undefined) {
          return toolStructuredError({
            ok: false,
            code: "cursor-invalid",
            field: "cursor",
            error: "this read cursor names no servable page",
            detail: "unknown; restart the original request",
            retry: "call",
          });
        }

        // REWRITE INTO THE ORDINARY WINDOW SERVE. One path per page (see
        // `readRequestStore.ts`'s "ONE PAGE, ONE PATH" note).
        const pagePath = cursorPage.windows[0]!.path;
        // A page retains the request's resend and representation contract.
        // Restore it only after validating every source revision; replaying
        // epoch:new here would create a different task on every page.
        if (staged.state.force_serve_origin === true) {
          args["force_serve"] = true;
          forceContentServe = true;
        }
        keepComments = staged.state.targets.find(target => target.path === pagePath)?.representation.comments === "keep";
        const pageWindows = cursorPage.windows
          .filter((entry) => entry.path === pagePath)
          .map((entry) => entry.window);
        delete args["handle"];
        delete args["handles"];
        delete args["symbol"];
        args["path"] = pagePath;
        const pageCsvModel = cursorCsvModels.get(pagePath);
        if (pageCsvModel !== undefined) {
          // A3: the same whole rows the page was fixed on, through the artifact route,
          // so the page books and corroborates exactly as an explicit range does.
          const pageRows = rowsOverlappingWindows(pageCsvModel, pageWindows);
          if (pageRows === undefined) {
            return toolStructuredError({
              ok: false,
              code: "cursor-invalid",
              field: "cursor",
              error: "this read cursor names no servable page",
              detail: "unknown; restart the original request",
              retry: "call",
            });
          }
          const pageRange = `${pageCsvModel.firstDataRow + pageRows.startIdx}-${pageCsvModel.firstDataRow + pageRows.endIdx - 1}`;
          const pageSnapshot = cursorSnapshots.get(pagePath);
          if (pageSnapshot !== undefined) {
            // B1: the old revision's rows, labelled as such, and nothing booked: `S` comes
            // from this payload's `file_range`, and D stays in the old revision's lines.
            const pageKind = staged.state.targets.find((target) => target.path === pagePath)?.artifact?.kind ?? "csv";
            const pageTable = csvTable(pageSnapshot.bytes, { ext: pageKind, range: pageRange, maxRows: pageRows.endIdx - pageRows.startIdx });
            if (!pageTable.ok) return snapshotUnavailable("corrupt");
            staged.page = cursorPage;
            const snapshotContext = protocolCallContext();
            if (snapshotContext !== undefined) snapshotContext.readRequest = staged;
            declareKind("read.artifact");
            return toolOk(csvArtifactShape(pageTable, { path: pagePath, handle: pageSnapshot.token, sha: staged.state.targets.find((target) => target.path === pagePath)!.sha }, {
              snapshot: { handle: pageSnapshot.token, takenAtMs: pageSnapshot.takenAtMs },
              source: pageSnapshot.currentSha === undefined ? { status: "missing" } : { status: "moved", current_sha: shortSha(pageSnapshot.currentSha) },
            }));
          }
          args["range"] = pageRange;
          args["maxRows"] = pageRows.endIdx - pageRows.startIdx;
          args["kind"] = staged.state.targets.find((target) => target.path === pagePath)?.artifact?.kind;
          delete args["ranges"];
          delete args["query"];
          args["mode"] = "artifact";
          mode = "artifact";
        } else {
          if (pageWindows.length === 1) {
            args["range"] = `${pageWindows[0]!.start}-${pageWindows[0]!.end}`;
            delete args["ranges"];
          } else {
            args["ranges"] = windowStrings(pageWindows);
            delete args["range"];
          }
          args["mode"] = "slice";
          mode = "slice";
        }
        // finding 12: record THIS call's own fixed page so the emit tail's
        // settle can clip its `S` contribution to what the finalized wire
        // body actually ships, instead of trusting `cursorPage.windows`
        // wholesale — see `readRequestStore.ts`'s `settledTargets` doc
        // comment ("CURRENT PAGE" branch).
        staged.page = cursorPage;
        const cursorContext = protocolCallContext();
        if (cursorContext !== undefined) cursorContext.readRequest = staged;
      }

      // -----------------------------------------------------------------------
      // WP-S10 (2026-09-20), turn-economy (`reserveSmallWindowsEnabled`,
      // util/flags.ts, carries the full rationale): compute an EFFECTIVE
      // force-serve for this whole call, ONCE, here -- before S1-A1 (just
      // below), the prepared-fence `executionGuard`/`guardExecutionDiscovery`
      // short-circuit, the A7 handles=[] batch loop, and the ordinary
      // mode=slice/symbol served-range ledger, so every one of those doors
      // sees the SAME flat `args["force_serve"]` a genuine
      // `task.force_serve:true` call would have set (`mapCanonicalTask` maps
      // the canonical field onto this exact key). Only ever turns an unset/
      // false value on, never the reverse -- a caller's own explicit
      // `force_serve` (true or false) is left untouched.
      // -----------------------------------------------------------------------
      if (
        reserveSmallWindowsEnabled()
        && args["force_serve"] !== true
        && mode !== "full" && mode !== "archive" && mode !== "artifact" && mode !== "closure"
      ) {
        const smallWindowTargets = collectSmallWindowTargets(args, workspace);
        if (smallWindowTargets !== undefined && smallWindowTargets.length > 0) {
          const smallWindowTotal = await measureSmallWindowTotal(workspace, smallWindowTargets);
          if (
            smallWindowTotal !== undefined
            && smallWindowTotal.lines <= RESERVE_SMALL_WINDOWS_MAX_LINES
            && smallWindowTotal.bytes <= RESERVE_SMALL_WINDOWS_MAX_BYTES
          ) {
            args["force_serve"] = true;
            (args as Record<PropertyKey, unknown>)[SMALL_WINDOW_RESERVE_FORCE] = true;
          }
        }
      }

      // -----------------------------------------------------------------------
      // S1-A1 (2026-09-20 dispatcher dead-turn fix): a `qref` re-pack (no NEW
      // `query`) that also carries its own explicit `targets` is forced into
      // `mode:"task_pack"` by normalizeCanonicalRequest's tl_read_file branch,
      // regardless of whether those targets are a fresh discovery query or a
      // single handle zooming into specific windows (that function's
      // `targets.length > 0 && (query !== undefined || qref !== undefined)`
      // check does not distinguish the two). Under a PREPARED execution
      // fence, task_pack mode either answers from the cached-pack-fingerprint
      // shortcut (`exactPreparedTaskPackReceipt` below) or, once that fails,
      // from `preparedDiscoveryReceipt` — both compact, body-less receipts —
      // because guardExecutionDiscovery's fence-independent "any OTHER mode
      // serves real bytes" exception (added for the 2026-08-22 fence-serves-
      // unserved-scope wave) is explicitly scoped OFF for `mode==="task_pack"`.
      // Neither receipt asks "were THIS call's specific windows ever served" —
      // only "did the files/fingerprint change". A caller that re-issues the
      // qref naming windows the server's own prior response listed as
      // `remaining` therefore got a body-less reply for bytes it had never
      // received (recorded in a live Copilot session).
      //
      // The identical call WITHOUT `qref` never enters task_pack mode at all
      // (the same function's `else` branch) — it resolves directly to
      // mode=slice/symbol/full/handles-batch and serves real bytes through
      // the ordinary, fence-independent path below. So: when the fence is
      // prepared and this shape's addressed windows are not all covered by
      // the served-range ledger, redo the SAME canonical-to-legacy projection
      // with `qref` removed and adopt its target/mode fields — producing a
      // response byte-identical to the qref-less call. A server-authored
      // `discover` continuation of this same `{qref,targets}` shape while the
      // fence is NOT prepared is untouched (the `getExecutionFence` check
      // below is false). When every addressed window is already served,
      // `args` is left exactly as today, so the existing dedup-honest receipt
      // still fires. `qrefRepackTargetsHaveUnservedWindow` now counts a
      // target with NO served history at all as unserved too (see its own
      // doc comment for the 2026-09-20 second-session fix), so a qref-repack
      // naming brand-new evidence is reprojected and served exactly like a
      // zoom into partially-served evidence is. The one shape that keeps
      // TODAY's task_pack behavior unconditionally is `task.force_serve:true`
      // (read here as the already-normalized flat `args["force_serve"]`, the
      // same field `executionGuard` below reads) — taskHandleRecovery.spec.ts's
      // "declared task.profile persists across re-packs" suite re-packs onto
      // a brand-new path on every case, but sends force_serve on every one of
      // them, so skipping this whole reprojection for a forced call keeps
      // that suite green without needing this file to special-case "brand new
      // path" at all.
      //
      // 2026-10-18 (v016 decision 6t-1, T05c rep0 arm A): the same dead end
      // with a NEW `query` instead of a `qref`. After an `act.edit` pack the
      // solver continued the task (`task.handle`, no `epoch:"new"`) with
      // `{query:"<what it wanted>", targets:[{path:"CONTRACT.md",
      // range:"960-1030"}]}` and later `targets:[{path:"os_mutex.h"}]` —
      // files the pack never served — and got the 311 B body-less
      // `decision-unchanged` receipt both times, then read both natively.
      // A same-task call whose explicit targets name bytes the ledger proves
      // unserved is a read of those targets, whatever text rides along; it
      // is projected exactly like the qref shape above. `task.epoch:"new"`
      // keeps its fresh pack, `force_serve` its old path, and a call whose
      // every addressed window is already served keeps today's receipt.
      //
      // 2026-10-18 (v016 decision 6t-2, T05c rep1 arm A): the same task's
      // `{query, targets}` after its edit landed. `tl_edit_file` moves the
      // fence from `prepared` to `acting`/`verifying`, where this block used
      // not to run, so the solver's next two reads of named files under the
      // act task's own handle (`mode_manager.cpp` 150-320, and three headers)
      // came back as fresh task packs (12.5 KB and 15.1 KB) — discovery redone
      // for a read. The query shape is now projected in those phases too; the
      // qref shape stays `prepared`-only, as S1-A1 scoped it.
      //
      // Same run, once multi-target reads stopped minting tasks (S6 below):
      // the act task's certificate now outlives those reads, so a same-task
      // `{query, targets}` re-asking windows it already held met that
      // certificate's query-mismatch stop (`prepared-discovery-closed`, whose
      // `next` is a `task.epoch:"new"` re-pack) instead of the receipt a
      // freshly minted certificate used to give it (T13 rep1, replayed). When
      // the call names ONE readable file, the query shape is a read of it
      // whether or not it was served: an unserved window serves, a held one
      // answers with the single-target read's residency receipt. Several
      // held targets keep the decision receipt (a multi-target read would
      // resend them), and so does the qref shape.
      // -----------------------------------------------------------------------
      const s1a1Fence = getExecutionFence(workspace);
      const s1a1Phase = s1a1Fence?.phase;
      // 2026-10-18 (DESIGN-v0.14-plan.md §20.16, bench 6t-2 T13 rep1 #23): an
      // edit whose closure has no open check moves the fence on to `done`,
      // and the same task's verification re-reads came after it — each a new
      // pack whose fresh task dropped the fence, so the next re-read (#24)
      // was a pack too. `done` keeps the same task, like `verifying`.
      const s1a1PostEdit = s1a1Phase === "acting" || s1a1Phase === "verifying" || s1a1Phase === "done";
      if (mode === "task_pack" && (s1a1Phase === "prepared" || s1a1PostEdit) && args["force_serve"] !== true) {
        const original = (args as Record<PropertyKey, unknown>)[CANONICAL_ORIGINAL_INPUT] as
          | Record<string, unknown>
          | undefined;
        const originalTargets = original !== undefined && Array.isArray(original["targets"])
          ? original["targets"]
          : undefined;
        const qrefRepack = s1a1Phase === "prepared"
          && original !== undefined
          && typeof original["qref"] === "string" && original["qref"] !== ""
          && original["query"] === undefined;
        const sameTaskQuery = original !== undefined
          && typeof original["query"] === "string"
          && args["taskEpoch"] !== "new";
        if (
          originalTargets !== undefined
          && originalTargets.length > 0
          && (
            (qrefRepack && (await qrefRepackTargetsHaveUnservedWindow(workspace, originalTargets)))
            || (sameTaskQuery && (
              (originalTargets.length === 1 && explicitTargetsReadable(workspace, originalTargets))
              || (await qrefRepackTargetsHaveUnservedWindow(workspace, originalTargets))
            ))
          )
        ) {
          const qreflessProjection = normalizeCanonicalRequest("tl_read_file", {
            targets: originalTargets,
            ...(original!["content"] !== undefined ? { content: original!["content"] } : {}),
            ...(original!["scope"] !== undefined ? { scope: original!["scope"] } : {}),
          }) as Record<PropertyKey, unknown>;
          for (const key of TARGET_PROJECTION_SYNC_KEYS) {
            if (qreflessProjection[key] !== undefined) args[key] = qreflessProjection[key];
            else delete args[key];
          }
          if (qreflessProjection[HANDLE_OVERRIDES_INPUT] !== undefined) {
            Object.defineProperty(args, HANDLE_OVERRIDES_INPUT, {
              value: qreflessProjection[HANDLE_OVERRIDES_INPUT], enumerable: true, configurable: true,
            });
          } else {
            delete (args as Record<PropertyKey, unknown>)[HANDLE_OVERRIDES_INPUT];
          }
          delete args["qref"];
          delete args["query"];
          mode = String(args["mode"] ?? "auto");
        }
      }

      // -----------------------------------------------------------------------
      // Handle resolution: when args.handle is provided, resolve it to
      // path/symbol/range and ignore conflicting top-level path/symbol.
      // -----------------------------------------------------------------------
      const archiveSelector = selectorFromArgs(args);
      let resolvedPath = archiveSelector?.member
        ? virtualArchivePath(archiveSelector.path, archiveSelector.member)
        : archiveSelector?.path ?? (args["path"] !== undefined ? String(args["path"]) : undefined);
      let resolvedSymbol = args["symbol"] !== undefined ? String(args["symbol"]) : undefined;
      let resolvedRange = args["range"] !== undefined ? String(args["range"]) : undefined;
      if (archiveSelector && !archiveSelector.member && mode === "auto") mode = "archive";
      // BUG FIX (bench transcript forensics): a caller-supplied `range` is a
      // SUB-SLICE request over an already-known handle (AGENTS.md routing
      // rule 4: "Slice too narrow? Re-slice the SAME handle wider/narrower —
      // don't open the file natively"). The handle-range override below used
      // to run unconditionally, so `mode=slice handle=<id> range=140-183`
      // against a handle minted with its OWN stored range (e.g. a whole-file
      // "1-184" handle) silently discarded the caller's narrower range and
      // re-served the handle's full stored range instead — the agent's
      // re-slice request was a no-op. Remembered here (BEFORE the handle
      // lookup below may overwrite `resolvedRange`) so the override further
      // down can tell "caller passed an explicit range" apart from "caller
      // passed nothing, resolvedRange is still undefined".
      const callerSuppliedRange = resolvedRange !== undefined;

      // -----------------------------------------------------------------------
      // A2 ranges[] batching (2026-07-30): several "N-M" windows of ONE file in
      // ONE call. Parsed here, beside `range`, so the mutual-exclusion refusal
      // and the intent-obvious mode promotion both happen before any dispatch
      // branch can silently ignore the field (the failure mode the argMatrix
      // audit exists to prevent). `ranges` is a SIBLING of `range`, never a
      // superset: supplying both is a genuine ambiguity the caller should see.
      // -----------------------------------------------------------------------
      let rangesArg: string[] = Array.isArray(args["ranges"])
        ? (args["ranges"] as unknown[]).map((entry) => String(entry).trim()).filter((entry) => entry.length > 0)
        : [];
      let hasRangesBatch = rangesArg.length > 0;
      if (hasRangesBatch && callerSuppliedRange && archiveSelector?.member) {
        // Neither window can be chosen honestly here: archive members support
        // one range per call, and `range` plus `ranges[]` is ambiguous.  Do not
        // flatten the virtual member into an ordinary path in a recovery call.
        return toolStructuredError({
          ok: false,
          error: "range and ranges[] are mutually exclusive for archive members; choose one range and retry",
          code: "invalid-input",
          field: "range",
          awaiting_input: true,
        });
      }
      if (hasRangesBatch && callerSuppliedRange) {
        // FX-1: a target-object FRAGMENT, not a pre-joined `key=value` string —
        // the canonical `next` below embeds it inside `targets=[...]`, never the
        // legacy `mode=slice handle=… /path=…` dialect (a raw-string `next` is a
        // blind spot for `canonicalizeEmittedToolCalls`, which only rewrites
        // OBJECT-shaped embedded tool calls).
        const locator: Record<string, unknown> | undefined = typeof args["handle"] === "string"
          ? { handle: args["handle"] }
          : resolvedPath !== undefined
            ? { path: resolvedPath }
            : undefined;
        if (locator === undefined) {
          return toolStructuredError({
            ok: false,
            error: "range and ranges[] are mutually exclusive; provide a handle or path before retrying the merged ranges",
            code: "invalid-input",
            field: "path",
          });
        }
        return toolStructuredError({
          ok: false,
          error: "range and ranges[] are mutually exclusive — pass one window in `range`, or several in `ranges`",
          code: "invalid-input",
          next: canonicalToolCall("tl_read_file", {
            targets: [{ ...locator, ranges: [resolvedRange, ...rangesArg] }],
            content: "auto",
          }),
        });
      }
      if (hasRangesBatch && archiveSelector?.member) {
        // Archive members are read-only single-slice reads (the archive branch
        // below resolves ONE member range); batching is not wired through the
        // member reader, so say so with the exact single-range call instead of
        // silently serving one window and dropping the rest.
        return toolStructuredError({
          ok: false,
          error: "ranges[] is not supported for archive members; request one range per call",
          code: "invalid-input",
          next: canonicalToolCall("tl_read_file", {
            targets: [{ archive: archiveSelector, range: rangesArg[0] }],
            content: "auto",
          }),
        });
      }
      // Same intent-obvious promotion `range` already gets (see the
      // callerSuppliedRange -> "slice" promotions below): a bare ranges[] with
      // no mode is unambiguously a multi-window slice request.
      if (hasRangesBatch && mode === "auto") mode = "slice";

      let handleArg = typeof args["handle"] === "string" ? args["handle"] : undefined;
      // C3 self-heal (2026-07-24): a handle is only a cache key for a
      // (path, range/symbol) the caller very often ALSO restated inline on the
      // same re-slice call. When the handle has aged out of the table but the
      // caller DID supply a path we can still serve, treat the request as
      // "no handle, use the path" — drop the dead handle (so the resolution
      // block below is skipped) and remember it for a `note`, instead of the
      // hard refusal that used to strand a re-slice the moment its handle
      // expired (AGENTS.md routing rule 4). Only a stale handle with NO
      // recoverable path still falls through to the fresh-discovery redirect.
      let staleHandleReresolved: string | undefined;
      if (handleArg !== undefined && resolvedPath !== undefined && handleTable.get(handleArg) === undefined) {
        staleHandleReresolved = handleArg;
        handleArg = undefined;
        // handle + explicit range WITHOUT a mode is an unambiguous slice
        // request (mirrors the live-handle promotion further below).
        if (callerSuppliedRange && mode === "auto") mode = "slice";
      }
      if (handleArg) {
        const hEntry = handleTable.get(handleArg);
        if (!hEntry) {
          // 2026-07-16a bench forensics (refusal_without_next/_handle): a
          // stale/hallucinated handle with NO recoverable path used to refuse
          // with nothing else to do next — point back at fresh discovery
          // instead of a dead end (the recoverable-path case self-healed above).
          //
          // 2026-07-30: also state the path-based recovery in words. The dead
          // id rides as `requested_handle`, NOT as `handle` — a refusal must
          // never hand back a locator that cannot be resolved.
          return toolStructuredError({
            ok: false,
            reason: "handle-unknown",
            requested_handle: handleArg,
            detail: 're-read the file by path, or start a fresh task_pack with the request restated verbatim',
            // PI-09: this used to say "handles are session-scoped and do not
            // survive a server restart". They now do, when the workspace has a
            // durable state store — so the honest statement is the narrower
            // one: THIS handle is not resolvable here, and a path re-read
            // always re-mints. Overstating the loss taught agents to abandon
            // live handles.
            hint: "this handle is not resolvable in this workspace (expired, evicted, or minted elsewhere); re-reading by path re-mints one",
            // §11.4 generalization: this is reached only when the caller sent
            // a bare handle with no recoverable path (the resolvedPath-based
            // self-heal above already re-resolves the has-a-path case), so
            // there is no path to build an executable tl_read_file next from —
            // the same "no working set survives this call" recovery
            // `taskHandleRefusal`'s own freshPack falls back to. Spreads
            // `retry`/`next`/`remaining`, never a legacy `alternatives` menu.
            ...taskPackRecoveryFor(args, true),
          });
        }
        if (hEntry.workspaceRoot !== workspace) {
          if (!cwdExplicit) {
            // B1: cwd omitted — adopt the handle's own workspace. H2: refuse
            // if the worktree it was minted in no longer exists.
            const res = resolveHandleWorkspace([hEntry.workspaceRoot], cwdExplicit, workspace);
            if (res.kind === "missing") {
              return toolStructuredError({
                ok: false,
                reason: "handle-workspace-missing",
                handle: handleArg,
                handleWorkspace: res.handleWorkspace,
                detail: handleWorkspaceMissingDetail(res.handleWorkspace),
              });
            }
            if (res.kind === "adopt") workspace = res.workspace;
          } else {
            // B2: explicit conflicting cwd — refuse with an enriched payload.
            return toolStructuredError({
              ok: false,
              reason: "handle-workspace-mismatch",
              handle: handleArg,
              handleWorkspace: hEntry.workspaceRoot,
              detail: `retry with cwd=${hEntry.workspaceRoot} or omit cwd`,
            });
          }
        }
        // Handle overrides conflicting top-level fields. `range` is one
        // exception (see callerSuppliedRange above): `path` identifies WHICH
        // file the handle points at (a handle IS the canonical reference, so
        // it always wins), but `range` on a re-slice call is a request to
        // view a DIFFERENT sub-window of that same handle — honoring the
        // caller's explicit range is what makes "re-slice the same handle
        // narrower/wider" (AGENTS.md routing rule 4) actually work instead of
        // being silently ignored.
        //
        // `symbol` follows the SAME exception since anchor-focus (2026-07-11a
        // forensics): the server now mints handles carrying its OWN symbol
        // annotation, so a handle's symbol is no longer necessarily the
        // caller's identification. Unconditionally adopting it made an
        // explicit-range re-slice resolve as a symbol read — "Symbol not
        // found" errors, and one silent 74KB whole-class serve when the
        // symbol DID exist (resolveSlice checks symbol before range). A
        // caller-supplied range means "give me these lines of this handle";
        // the handle's symbol tag must yield to it.
        if (hEntry.path) resolvedPath = hEntry.path;
        if (hEntry.symbol && !callerSuppliedRange) resolvedSymbol = hEntry.symbol;
        if (hEntry.range && !callerSuppliedRange) resolvedRange = hEntry.range;

        // 2026-07-11a: handle + explicit range WITHOUT a mode is an
        // unambiguous slice request, but the "auto" default served the
        // handle's whole default view (full skeleton) instead of the asked
        // window — 13 occurrences in one run, 4 of them wasted/wrong
        // responses each needing an explicit mode:"slice" retry. Route the
        // intent-obvious shape to slice — the same promotion class as
        // query/paths[] → task_pack.
        if (callerSuppliedRange && mode === "auto") mode = "slice";
      }

      // ND-1 (2026-08-08 serve honesty): the EXACT object the brake computes
      // its signature from, kept in scope so a zero-byte outcome further down
      // files its verdict against the SAME signature. Recomputing it at the
      // miss site would drift the moment a branch mutates `mode`/`workspace`,
      // and a verdict filed under a signature the brake never sees is worse
      // than none at all.
      const discoveryGuardArgs = { ...args, mode };
      const discoveryGuardWorkspace = workspace;
      // F-C1 (wave D / D2): EXACTLY ONE task_pack query resolution per dispatch,
      // memoized here and reused by every site below that needs it (the archive
      // pack branch and the shared `taskPackQuery` binding).
      // `resolveTaskPackQueryArg` is NOT pure — a `taskEpoch:"new"` call severs
      // both the qref map (clearTaskQueryRef) and the pack-dedupe ledger
      // (clearPackDedupeForWorkspace) — so the preflight below must not become a
      // SECOND resolution beside the existing ones. Memoizing keeps the count at
      // one, exactly as before this change, whichever site asks first: no ledger
      // clear is double-counted and no epoch boundary moves.
      let taskPackQueryResolution: TaskPackQueryResolution | undefined;
      const resolveTaskPackQueryOnce = (): TaskPackQueryResolution =>
        (taskPackQueryResolution ??= resolveTaskPackQueryArg(args, workspace));
      // A continuation that omits `task.profile` keeps the profile its task
      // was declared under — see inheritDeclaredTaskProfile. Runs before the
      // receipt preflight and every builder below so they all see one profile;
      // it never resolves the query on a `taskEpoch:"new"` call, so the
      // resolver's epoch side effects stay where they were.
      inheritDeclaredTaskProfile(args, workspace, resolveTaskPackQueryOnce);
      // F-C1: the guaranteed-receipt preflight now consumes the RESOLVED query.
      // It used to read RAW pre-resolution args, so `args.query` was `undefined`
      // for every wire `{mode:"task_pack", qref}` replay — the re-pack mechanism
      // AGENTS.md documents — `computePackFingerprint` hashed an empty query,
      // and no stored record could ever match. The bypass was therefore
      // structurally unreachable for qref replays (pinned by
      // __tests__/rc/v011ReceiptFence.rc.spec.ts), which always took the heavier
      // honest path even when nothing had changed. Resolving here makes it
      // reachable; every serve-honesty gate inside `revalidateRecordToReceipt`
      // (B5's partial-surface decline, the per-surface sha proof, the
      // workspace-state proof) now actually runs on the replay shape it was
      // written for, instead of being dead code behind an unresolvable
      // fingerprint.
      //
      // `taskEpoch:"new"` short-circuits BEFORE the resolver so this preflight
      // never pulls that epoch clear ahead of `guardExecutionDiscovery`: the
      // guard handles a declared new epoch itself and returns `allowed` before
      // it ever reads this flag, so the value was unused for that shape anyway.
      //
      // `force_serve` is deliberately NOT special-cased: this flag only answers
      // "does this request re-issue a still-valid record", and PI-09's
      // unconditional bypass is applied where it has always been applied — at
      // `buildTaskPack`'s entry, which skips every dedup path when `forceServe`
      // is set and therefore re-serves full bodies once the fence lets the call
      // through. Making the flag false for `force_serve` would instead have the
      // fence BLOCK the one call shape whose entire purpose is recovering a lost
      // context (and would regress today's plain re-ask behaviour).
      const exactPreparedTaskPackReceipt = mode === "task_pack"
        && args["taskEpoch"] !== "new"
        && canServeCachedTaskPackReceipt(
          workspace,
          taskPackReceiptPreflightArgs(args, resolveTaskPackQueryOnce()) as Parameters<typeof canServeCachedTaskPackReceipt>[1],
        );
      /** This call resolved to nothing, so it put no file bytes on the wire. */
      const noteZeroByteServe = (): void =>
        noteDiscoveryServedNoBytes(discoveryGuardWorkspace, "tl_read_file", discoveryGuardArgs);
      // I-7 (2026-08-30 forensics attribution wave): snapshot BEFORE the guard
      // call/short-circuit below, either of which can itself clear or bypass
      // the fence -- "post-ready" means the fence was ALREADY prepared when
      // this call ARRIVED, not whatever state dispatch leaves it in. Fires
      // even on the force_serve short-circuit just below: a forced resend
      // post-readiness is exactly the discretionary spend this event exists
      // to observe, not a reason to skip observing it.
      if (args["taskEpoch"] !== "new" && getExecutionFence(workspace)?.phase === "prepared") {
        notePostReadyDiscovery({
          forceServe: args["force_serve"] === true,
          scopeClass: discoveryScopeClass(discoveryGuardArgs),
        });
      }
      // W14 L1/L3: an explicit full-content request must reach the read
      // dispatcher. The prepared-task fence can withhold a repeated slice, but
      // it cannot decide a whole-file complement (or a force_serve recovery)
      // without consulting the served-range ledger there.
      // A3: the `next` a pack's csv window hands out walks rows the pack does not hold.
      // Each call moves forward, so it is no repeat for the loop brake to answer.
      const csvQueryWindowCall = mode === "artifact" && typeof args["query"] === "string" && artifactQueryWindowEnabled()
        && resolvedPath !== undefined && /\.(?:csv|tsv)$/iu.test(resolvedPath);
      // Natural-origin packs rederive their semantic plan before reusing any
      // prepared receipt, including same-size changes outside prior evidence.
      const naturalPreparedRevalidation = mode === "task_pack"
        && naturalQueryForScope(workspace, taskContractScopeForPack(args, workspace, resolveTaskPackQueryOnce().query)) !== undefined;
      const executionGuard = naturalPreparedRevalidation || args["force_serve"] === true
        || (mode !== "full" && forceContentServe)
        || csvQueryWindowCall
        ? { allowed: true as const }
        : guardExecutionDiscovery(
            workspace,
            "tl_read_file",
            discoveryGuardArgs,
            // Read-only handle->path resolution, the same shape the edit guard
            // gets: it lets the loop brake recognize a repeat of THIS session's
            // own served bytes and answer it with a receipt (L2a) instead of a
            // refusal it cannot discharge.
            (handleId) => {
              const entry = handleTable.get(handleId);
              return entry !== undefined && entry.workspaceRoot === workspace && entry.path !== undefined && entry.path !== ""
                ? entry.path
                : undefined;
            },
            exactPreparedTaskPackReceipt,
            // 2026-10-19: the comment windows this request's own rendering
            // elides are not owed to the loop brake's held check.
            requestElisionProbe(
              workspace,
              keepComments || rangeContentFullMarker,
              (callerSuppliedRange || hasRangesBatch) && protocolCallContext()?.readRequest?.page === undefined,
            ),
            // 2026-10-20 (decision run 6t-7): what the fence cannot read off
            // the arguments (state/session.ts `FenceReadView`).
            {
              keepComments: keepComments || rangeContentFullMarker,
              servesWholeFileContent: mode === "auto"
                && resolvedRange === undefined
                && resolvedSymbol === undefined
                && !hasRangesBatch
                && resolvedPath !== undefined
                && autoReadServesFileContent(workspace, resolvedPath),
            },
          );
      // 2026-10-20 (decision run 6t-8): the guard may have left the
      // epoch-repeat advisory this call earned pending in the session; the
      // funnel tail hands it to this call's reply (protocol/envelope.ts's
      // `applyEpochRepeatAdvisory`).
      if (args["taskEpoch"] === "new") noteEpochNewRoot(workspace);
      // W-BATCH-HINT candidate 3: records this call's single/multi-target
      // shape regardless of what executionGuard decides below — a repeat
      // read served as a receipt is still a single-target call for streak
      // purposes; `applySerialSingleTargetHint` (protocol/envelope.ts) is
      // what keeps the hint off a receipt/refusal-shaped response.
      noteReadFamilySerialSingleTargetCall(workspace, "tl_read_file", undefined, args);
      if (!executionGuard.allowed) {
        // A served receipt is NOT a refusal: it says the caller already holds
        // these bytes, so it travels as a normal (non-isError) result.
        if ("servedReceipt" in executionGuard) {
          noteServedBytesSource("dedup");
          return toolOk(addressServedReceipt(executionGuard.servedReceipt, workspace));
        }
        return toolStructuredError(executionGuard.refusal);
      }

      // -----------------------------------------------------------------------
      // FIX B (2026-07-12c workbook forensics): `sheet=` is only ever consulted
      // inside the mode=artifact xlsx branch further below — a caller that
      // passed {handle/path, sheet} without mode="artifact" used to silently
      // fall through to mode=auto's xlsx roster branch, which ignores
      // `sheet` entirely and re-serves the SAME roster every time (a
      // silent-wrong-data bug, 4 wasted calls). `mode` already defaults to
      // "auto" when omitted (line ~4345), so "omitted" and explicit "auto"
      // are the same value by this point — both imply artifact routing when
      // the extension supports it (xlsx; exactly what mode=artifact's own
      // kind switch accepts for `sheet`). An explicit, DIFFERENT content
      // mode (skeleton/symbol/full/slice/pack/digest/map/task_pack/...)
      // alongside `sheet` is a genuine conflict the caller should see, not a
      // silent override in either direction — mirrors the callerSuppliedRange
      // "auto" -> "slice" promotion immediately above.
      // -----------------------------------------------------------------------
      {
        const sheetArg = typeof args["sheet"] === "string" ? args["sheet"] : undefined;
        if (sheetArg !== undefined && mode !== "artifact") {
          if (mode !== "auto") {
            return toolStructuredError({
              ok: false,
              reason: "invalid-input",
              error: `mode=${mode} conflicts with sheet= — sheet= requires mode=artifact (or omit mode)`,
              hint: "sheet= requires mode=artifact (or omit mode)",
            });
          }
          const sheetExt = (resolvedPath ?? "").toLowerCase().match(/\.([^.\\/]+)$/)?.[1] ?? "";
          if (sheetExt === "xlsx") mode = "artifact";
        }
      }

      // protocol v1 (D4): publish the mode this dispatch ACTUALLY resolved —
      // after every `auto` promotion above — so the envelope's `kind` names the
      // member the response really is. Placed here, at the last promotion and
      // before the first mode branch, so no branch can be reached with a stale
      // mode; branches whose member is not a function of `mode` (the batch
      // reads) declare their kind outright instead.
      noteResolvedMode(mode);

      // -----------------------------------------------------------------------
      // A7: handles=[] batch read — resolves N handles to N slices in one
      // grouped response. mode=slice takes exactly one handle; this collapses
      // "one handle per turn" serialization for multi-surface tasks. Reuses
      // resolveSlice (the same slice/handle machinery mode=slice uses) per
      // handle, so drift/cap behavior stays identical to a single-handle read.
      // Checked before any mode branch — independent of `mode`.
      // -----------------------------------------------------------------------
      if (mode !== "closure" && Array.isArray(args["handles"]) && (args["handles"] as unknown[]).length > 0) {
        const requested = (args["handles"] as unknown[]).map(String);

        // F-V13-1 Fix B (DESIGN-v0.13-plan.md:167): per-target range/symbol
        // overrides a canonical multi-handle `targets:[]` batch carried
        // through normalizeCanonicalRequest's HANDLE_OVERRIDES_INPUT (an
        // internal-only Symbol key — never reachable as a wire property, see
        // that constant's own doc comment). Absent for every call that does
        // not use this: an ordinary legacy `handles:["h1","h2"]`
        // continuation, a verification-kit re-fetch, or any existing corpus/
        // replay call falls through untouched to the exact pre-fix
        // hEntry.range/hEntry.symbol resolution below.
        const handleOverrides = (args as Record<PropertyKey, unknown>)[HANDLE_OVERRIDES_INPUT] as
          | Array<Record<string, unknown>>
          | undefined;
        // Scope note: `ranges[]` (plural, multi-window) on one target of a
        // multi-HANDLE batch has no per-item carrier here — unlike a singular
        // `range` override (honored per-item below), there is no slot to
        // resolve several windows of ONE handle inside this batch's one-
        // range-per-item shape. Since 2026-10-20 the canonical projection
        // splits a well-formed per-target `ranges[]` into one item per window
        // before this loop (`expandMultiTargetRanges`), so only a `ranges` it
        // left as sent (beside a `range` on the same target, or not all
        // non-empty strings) still arrives. Refuse the WHOLE batch with a
        // concrete task_pack recovery instead of silently falling back to that
        // target's stored range — exactly the misdelivery this fix exists to
        // close, just for a shape Fix B's override carrier cannot express.
        //
        // MUST run BEFORE `declareKind("read.batch")` below:
        // `kindForCall` (protocol/envelope.ts) returns a declared kind
        // UNCONDITIONALLY — `if (context.kind !== undefined) return
        // context.kind;` is its first line, before the refusal test — so a
        // `toolStructuredError` returned AFTER declareKind has already fired
        // would be mis-classified as a SUCCESSFUL `read.batch` (and, having
        // no `items`, project as `entries:[]` with no error visible at all;
        // confirmed live while building this fix). This ordering constraint
        // is pre-existing and not new to this fix — the B1 pre-pass refusals
        // immediately below USED TO run in that same busted position (after
        // declareKind), which was out of scope for F-V13-1 to touch. A later
        // fix (2026-08-30) moved B1 ahead of declareKind too, for the exact
        // same reason — see its own comment below.
        if (handleOverrides?.some((ov) => Array.isArray(ov["ranges"]) && (ov["ranges"] as unknown[]).length > 0)) {
          const recoveryPaths = requested.map((hId, idx) => {
            const ov = handleOverrides[idx];
            const entryPath = handleTable.get(hId)?.path;
            const ranges = Array.isArray(ov?.["ranges"]) ? ov["ranges"] : undefined;
            const range = typeof ov?.["range"] === "string" ? ov["range"] : undefined;
            return {
              ...(entryPath !== undefined ? { path: entryPath } : { handle: hId }),
              ...(ranges !== undefined ? { ranges } : range !== undefined ? { range } : {}),
            };
          });
          return toolStructuredError({
            ok: false,
            code: "invalid-input",
            field: "targets",
            error: "ranges[] on one target of a multi-handle batch is not supported; request one range per target, or re-read via task_pack",
            next: canonicalToolCall("tl_read_file", { mode: "task_pack", paths: recoveryPaths }),
          });
        }

        // TL-06 (plan-0143 §4/§8.1, R04): the SAME staleness protection the
        // task_pack promotion above gets, extended to this handle-addressed
        // batch (admitCallerRangedContinuation resolves a handle-only entry
        // to its path via handleTable itself). Per-item effective range/
        // symbol mirrors the resolution the per-item loop below performs
        // (override, else the handle's own stored range/symbol).
        {
          const rangeAdmissionTargets = requested.map((hId, idx) => {
            const ov = handleOverrides?.[idx];
            const overrideRange = typeof ov?.["range"] === "string" ? ov["range"] : undefined;
            const overrideSymbol = typeof ov?.["symbol"] === "string" ? ov["symbol"] : undefined;
            const hEntry = handleTable.get(hId);
            const effectiveRange = overrideRange ?? hEntry?.range;
            // P2-11: mirror the actual serve loop's rangeContentFullMarker
            // suppression below (its own doc comment has the full
            // repro/rationale) — this admission pre-check must reason about
            // the SAME effective window the serve loop will honor.
            const effectiveSymbol = overrideSymbol
              ?? (overrideRange === undefined && !rangeContentFullMarker ? hEntry?.symbol : undefined);
            return {
              handle: hId,
              ...(effectiveRange !== undefined ? { range: effectiveRange } : {}),
              ...(effectiveSymbol !== undefined ? { symbol: effectiveSymbol } : {}),
            };
          });
          const rangeAdmission = await admitCallerRangedContinuation(workspace, rangeAdmissionTargets, args);
          if (rangeAdmission !== undefined) return rangeAdmission;
        }

        // B1 batch pre-pass: all handles in one handles=[] call must share ONE
        // workspaceRoot. When cwd was omitted, adopt that single root (the
        // handles ARE the workspace pin); when the batch spans more than one
        // root, refuse the whole batch up front. Unknown handles are left for
        // the per-item loop below (same omitted[] shape as today). When cwd
        // was explicit, defer to the per-item mismatch check below (unchanged
        // shape — still omitted[] with reason handle-workspace-mismatch).
        //
        // MUST run BEFORE `declareKind("read.batch")` below — same reasoning
        // as Fix B's block immediately above this one (2026-08-30 fix): this
        // pre-pass used to sit AFTER declareKind, so a `handle-workspace-
        // mismatch` / `handle-workspace-missing` refusal returned from here
        // was misclassified by `kindForCall` as a SUCCESSFUL, empty
        // `read.batch` (`{v:1, kind:"read.batch", entries:[]}`, confirmed
        // live) instead of a `refusal` — a caller saw zero error signal for a
        // call that touched none of its requested handles. Moved ahead of
        // declareKind, matching Fix B's own precedent exactly.
        if (!cwdExplicit) {
          const candidateRoots: string[] = [];
          for (const hId of requested) {
            const hEntry = handleTable.get(hId);
            if (!hEntry) continue; // handle-unknown surfaces in the per-item loop below.
            candidateRoots.push(hEntry.workspaceRoot);
          }
          const res = resolveHandleWorkspace(candidateRoots, cwdExplicit, workspace);
          if (res.kind === "multi") {
            return toolStructuredError({
              ok: false,
              reason: "handle-workspace-mismatch",
              handleWorkspaces: res.roots,
              // The conflicting roots ride the detail because the v1 advisory
              // allowlist drops handleWorkspaces: without them the caller
              // cannot know WHICH workspaces collided (2026-08-09 guard class).
              detail: `all handles in one batch must share a workspace (got: ${res.roots.join(", ")}); omit cwd or pass a single cwd`,
            });
          }
          if (res.kind === "missing") {
            // H2: the single worktree this batch's handles were minted in no
            // longer exists — refuse the whole batch (no per-item soft-omit is
            // meaningful when the adopted root itself is gone).
            return toolStructuredError({
            ok: false,
            reason: "handle-workspace-missing",
            handleWorkspace: res.handleWorkspace,
            detail: handleWorkspaceMissingDetail(res.handleWorkspace),
            });
          }
          if (res.kind === "adopt") workspace = res.workspace;
        }

        // A.5.4: a multi-target serve reporting per-item completeness is
        // `read.batch` whatever `mode` says — this branch runs BEFORE any mode
        // branch, so the member is a function of `handles[]`, not of `mode`.
        declareKind("read.batch");

        recordReadMode(workspace, "handles");
        const items: Array<{ handle: string; path: string; range: string; content: string; truncated: boolean; sha: string; note?: string; concern_note?: string; downgraded_from?: "symbol"; remaining_ranges?: string[]; next?: ToolCall; synthesized_range?: boolean } | HeldBatchWindowEntry> = [];
        // D1: reason stays the stable enum every existing caller matches on;
        // code/candidates/skeleton are additive fields carried ONLY for a
        // symbol-not-found miss from resolveSlice, so unrelated omitted
        // shapes (handle-unknown, handle-workspace-mismatch, cap-exceeded)
        // are untouched.
        const omitted: Array<{
          handle: string;
          // `not-decodable-text` (BLOCKER 53, AB1 round 11): the file exists and
          // reads, and `readServedText` refuses to put its bytes on the wire.
          // `not-found` would be a lie about the caller's own file. This enum is
          // otherwise INTERNAL — `readFamily.ts::omittedClasses` collapses every
          // `omitted[]` entry to `limit.omitted:["evidence"]`, so widening it
          // moves no wire byte and adds no protocol vocabulary EXCEPT for
          // `not-decodable-text` itself: AB1 residual R4 / MX-B (2026-09-14)
          // closes the "caller learns THAT, never WHY" gap for exactly this
          // reason, via `path` below — `projectBatch` reads it (when present)
          // to disclose the member as a `file-downgraded` batch entry.
          reason: "handle-unknown" | "handle-workspace-mismatch" | "not-found" | "cap-exceeded" | "not-decodable-text";
          // Populated for `not-decodable-text` (see above) AND, since TL-A6-2
          // (v0.14.4 candidate, item 2), for `cap-exceeded` WHEN the dropped
          // handle resolves in THIS workspace — a construction-time cap drop
          // is a deferral, not an unresolvable reference, so its path (and
          // `next`, below) can be named for free from the handle table with
          // no file I/O. `handle-unknown`/`handle-workspace-mismatch`/
          // `not-found` are still untouched: none of them has a safe path to
          // name.
          path?: string;
          // held item 7 (2026-09-21, adversarial review of the v0.14.3
          // improvement-plan fix wave): the SAME TL-A6-2 cap-exceeded drop
          // also carries the dropped handle's OWN stored `range` (when it had
          // one) and whether this call requested `content:"full"` — see the
          // TL-A6-2 push site below for why. `readFamily.ts`'s `deriveNext`
          // reads these to recover the entry with ITS OWN window instead of
          // widening every drop to a whole-file `mode:"full"` continuation.
          range?: string;
          contentFull?: boolean;
          code?: "not-found" | "range-invalid";
          candidates?: string[];
          skeleton?: string;
          next?: ToolCall;
          total_lines?: number;
        }> = [];

        // T2 (2026-08-27 field-eval): bound the AGGREGATE serve, not just
        // each item's own per-item cap (resolveSlice's own
        // sliceResult.capExceeded below, unchanged). A first-party report the
        // same day: a 6-handle batch produced a ~126KB single response that
        // overflowed the CALLING agent's own tool-result limit -- every item
        // individually fit resolveSlice's per-item cap, but nothing bounded
        // their sum. `undefined` (no explicit maxBytes/maxTokens and no
        // client-profile ceiling) keeps this branch byte-identical to today:
        // handlesBatchCapHit never flips, so every existing corpus/replay
        // call is unaffected. Whole-entry granularity is preserved -- the
        // item that CROSSES the ceiling is still served in full (never
        // split), and at least one item always gets through regardless of
        // how small the ceiling is, so the batch can never starve to zero
        // progress the way a bare refusal would.
        const handlesBatchCeiling = bindToResponseCeiling(
          resolveCallerByteCeiling(
            typeof args["maxBytes"] === "number" ? args["maxBytes"] : undefined,
            typeof args["maxTokens"] === "number" ? args["maxTokens"] : undefined,
            undefined,
          ),
          defaultResponseByteCeiling,
        );
        let handlesBatchBytesSoFar = 0;
        let handlesBatchCapHit = false;
        // F3: one serve-call ordinal for the whole batch (beginServeCall's
        // contract), claimed by the first item that records served lines. It
        // was claimed per item, so the `served_by` of a three-window batch
        // read #3, #4 and #5 (2026-10-18, found writing the §20.17 tests).
        let handlesBatchServeCall: number | undefined;
        // 2026-10-20 (v016 decision 6t-7, T13 rep1 #9): a window this session
        // already served in full at the file's current content answers with
        // the windowed paths batch's short already-served entry
        // (`heldBatchWindowEntry`) instead of its bytes. The replayed #9 (two
        // handles: tasks_init.cpp 1-77, 115-322 and 394-440, telemetry_task.cpp
        // 1-198) resent verbatim came back 20,235 B with every body again,
        // where its path form answered four already-served entries; it is
        // 2,083 B of four such entries now (replay corpus v016hb). On the
        // windowed paths batch's terms: every item reads a line window (no
        // symbol override, and no symbol handle read as its symbol), and the
        // call names no content mode (a path batch with `content:"full"` is
        // the full batch loop, which serves every window), declares no budget
        // and is neither `task.force_serve:true` (the documented resend) nor
        // a new task (`task.epoch:"new"`): a path batch with a budget or a
        // new task takes the task_pack route instead.
        const handlesBatchAnswersHeld = (args["mode"] === undefined || mode === "auto" || mode === "handles")
          && args["force_serve"] !== true && args["taskEpoch"] !== "new"
          && args["maxBytes"] === undefined && args["maxTokens"] === undefined
          && requested.every((hId, idx) => {
            const ov = handleOverrides?.[idx];
            if (typeof ov?.["symbol"] === "string") return false;
            return typeof ov?.["range"] === "string" || rangeContentFullMarker || handleTable.get(hId)?.symbol === undefined;
          });

        // A bounded batch that deliberately resends must owe all its windows,
        // including targets deferred before the producer visits them. Stage
        // that existing policy once so the tail publishes a parent cursor,
        // rather than a fresh slice that can collapse into an old receipt.
        if (!handlesBatchAnswersHeld && defaultResponseByteCeiling !== undefined) {
          const stagedWindows: Array<{path: string; content: string; range: string}> = [];
          for (const [index, id] of requested.entries()) {
            const entry = handleTable.get(id), override = handleOverrides?.[index];
            if (!entry?.path || entry.workspaceRoot !== workspace || splitArchiveVirtualPath(entry.path)
              || typeof override?.["symbol"] === "string"
              || (override?.["range"] === undefined && !rangeContentFullMarker && entry.symbol !== undefined)) break;
            // served-bytes: readServedText
            const verdict = await servedTextForRoute(entry.path, workspace);
            if (verdict === null || verdict.kind === "undecodable") break;
            const range = typeof override?.["range"] === "string" ? override["range"]
              : entry.range ?? `1-${Math.max(1, countLines(verdict.text))}`;
            if (parseWindows([range]).length === 0) break;
            stagedWindows.push({path: entry.path, content: verdict.text, range});
          }
          if (stagedWindows.length === requested.length) {
            for (const target of stagedWindows) stageWindowReadRequest(workspace, target.path, target.content,
              target.range, keepComments || rangeContentFullMarker, true);
          }
        }

        for (let hIdx = 0; hIdx < requested.length; hIdx++) {
          const hId = requested[hIdx]!;
          if (handlesBatchCapHit) {
            // TL-A6-2 (v0.14.4 candidate, item 2): a construction-time cap
            // drop used to omit ONLY {handle, reason:"cap-exceeded"}, with no
            // `path` — readFamily.ts's `deriveNext` (rung 3) can only turn a
            // PATH-BEARING omission into a recoverable `mode:"full"`
            // continuation, and it reads `.path` off every omitted entry
            // regardless of `reason`, so this handle was UNREACHABLE by any
            // executable `next` a follower could run even though (unlike a
            // genuinely unknown handle) the server can name it for free: it
            // is merely deferred, not invalid. Resolve its path via a plain
            // handleTable lookup (no file I/O — this branch never reads the
            // file) so `deriveNext` can fold it into the SAME "re-read what
            // was omitted" continuation it already builds for other path-
            // bearing omissions. An unresolvable or foreign-workspace handle
            // falls back to today's bare omission unchanged — neither case
            // has a path safe to name.
            //
            // held item 7 (2026-09-21): also carry the handle's OWN stored
            // `range` (when it addressed one — `handleTable`'s entry, the
            // SAME field `rangeAdmissionTargets` above reads) and whether
            // THIS call requested `content:"full"`. Without `range`,
            // `deriveNext`'s rung 3 could only widen every dropped entry —
            // ranged or not — to a whole-file `mode:"full"` recovery, which
            // re-serves lines the caller never asked for and, for a large
            // file, can cost far more than the caller's own declared budget
            // just to reach the one small window it actually wanted back.
            const capHEntry = handleTable.get(hId);
            if (capHEntry === undefined || capHEntry.workspaceRoot !== workspace || !capHEntry.path) {
              omitted.push({ handle: hId, reason: "cap-exceeded" });
              continue;
            }
            // The window THIS call asked for: the entry's own `range` override
            // when it carries one, else the handle's stored range — the same
            // resolution `rangeAdmissionTargets` above and the per-item loop
            // below perform. The handle's stored range alone is the window it
            // was MINTED from, which can be far narrower than what this batch
            // requested (mint `1-1`, then ask `{handle, range:"1-400"}`):
            // recovering the mint window would silently drop the rest. A symbol
            // override names no line window, so it recovers whole-file.
            const capOverride = handleOverrides?.[hIdx];
            const capOverrideRange = typeof capOverride?.["range"] === "string" ? capOverride["range"] : undefined;
            const capOverrideSymbol = typeof capOverride?.["symbol"] === "string" ? capOverride["symbol"] : undefined;
            const capEffectiveRange = capOverrideRange ?? (capOverrideSymbol === undefined ? capHEntry.range : undefined);
            omitted.push({
              handle: hId,
              path: capHEntry.path,
              reason: "cap-exceeded",
              ...(capEffectiveRange !== undefined ? { range: capEffectiveRange } : {}),
              ...(args["content"] === "full" ? { contentFull: true } : {}),
            });
            continue;
          }
          const hEntry = handleTable.get(hId);
          if (!hEntry) {
            omitted.push({ handle: hId, reason: "handle-unknown" });
            continue;
          }
          if (hEntry.workspaceRoot !== workspace) {
            omitted.push({ handle: hId, reason: "handle-workspace-mismatch" });
            continue;
          }
          const hPath = hEntry.path;
          if (!hPath) {
            omitted.push({ handle: hId, reason: "not-found" });
            continue;
          }
          const virtual = splitArchiveVirtualPath(hPath);
          let hContent: string | null;
          // served-bytes: readServedText
          // BLOCKER 53 (AB1, 2026-09-14, review round 11): `hVerdict` is the ONE
          // verdict for this batch arm. Round 10 measured the ordinary Windows
          // accident this module's own doc comment says it exists to prevent:
          // mint two ranged handles, let an editor re-save one file as BOM-less
          // UTF-16, and `targets:[{handle},{handle}]` served 62 raw NULs —
          // `truncated:false`, a `sha` and a handle asserting those bytes are
          // pinned — while `targets:[{handle}]` alone refused `read-error` in the
          // SAME run. A consumer that trusts that `sha` builds an
          // `expected-hash` precondition over bytes that are not on disk.
          let hVerdict: ServedTextVerdict | null = null;
          if (virtual) {
            // served-bytes: not-served (archive CONTAINER bytes: readArchiveMember gates the member; the decoded member is classified below)
            const archiveBytes = await readBytesSafe(virtual.outerPath, workspace);
            if (archiveBytes === null) {
              hContent = null;
            } else {
              const memberResult = await readArchiveMember(
                archiveBytes,
                virtual.outerPath,
                virtual.member,
                workspace,
                credentialPassword,
              );
              // An archive member is already gated by `readArchiveMember`
              // (`archive-entry-binary`, verified fail-closed independently of
              // this policy); its `content` is a decoded string, not bytes, so
              // it is classified rather than re-read.
              hContent = memberResult.ok ? memberResult.data.content : null;
              if (hContent !== null) {
                // served-bytes: readServedText
                hVerdict = readServedText(Buffer.from(hContent, "utf8"));
              }
            }
          } else {
            // served-bytes: readServedText
            hVerdict = await servedTextForRoute(hPath, workspace);
            hContent = hVerdict === null ? null : hVerdict.kind === "undecodable" ? null : hVerdict.text;
          }
          if (hVerdict !== null && hVerdict.kind === "undecodable") {
            // AB1 residual R4 / MX-B (2026-09-14): `path` rides alongside the
            // handle so `readFamily.ts::projectBatch` can disclose this member
            // as a `file-downgraded` batch entry (A.5.4's frozen shape
            // requires `path`) instead of only a coarse `limit.omitted` class.
            omitted.push({ handle: hId, path: hPath, reason: "not-decodable-text" });
            continue;
          }
          if (hContent === null) {
            omitted.push({ handle: hId, reason: "not-found" });
            continue;
          }
          // A BARE FILE HANDLE (kind:"file", no symbol and no range — what a
          // mode=full mint and every verification-kit entry carry) has no slice
          // coordinates, and resolveSlice refuses without them: this batch used
          // to answer `not-found` for a file that exists and reads fine.
          // 2026-07-31 verify-kit-gap: that is what made the kit's own standing
          // advice ("slice it via its handle") unexecutable, so an omitted body
          // had NO working recovery at all and the solver went to `cat` —
          // measured across 20 of 31 arm-A native-IO escapes. Address the whole
          // file instead, which is what "fetch this body" means; the range
          // branch still truncates-and-continues (remaining_ranges + next) for
          // anything over the serve cap, so this cannot blow the response.
          // T3 (2026-08-27 field-eval): mark whenever THIS branch synthesizes
          // the "1-N" window from a bare file-kind handle (no stored range, no
          // symbol) rather than serving a range the caller/mint-time actually
          // asked for — see the 2026-07-31 verify-kit-gap comment above for
          // why the synthesis itself exists. Independent of `truncated`: a
          // small whole file served complete THIS way is still a default, not
          // a real narrow-range serve, so an agent expecting "my sliced range"
          // can tell the two apart. Absence stays the norm on every item with
          // a genuine range (real ranged handles, symbol-branch handles).
          //
          // F-V13-1 Fix B: an explicit per-target override (see
          // handleOverrides above) takes the SAME precedence the single-
          // handle mode=slice path already gives a caller-supplied `range`
          // (the "BUG FIX (bench transcript forensics)" comment further up
          // this function): a caller-supplied range is a sub-slice request
          // over an already-known handle, so it wins over BOTH the handle's
          // own stored range AND the handle's own stored symbol tag — never
          // pass resolveSlice a stored symbol alongside an override range,
          // or "resolveSlice checks symbol before range" silently re-serves
          // the symbol's own span instead of the requested window (the exact
          // bug the single-handle fix closed). An explicit override symbol
          // with no override range still wins over the stored symbol, same
          // as the single-handle path's `args["symbol"]` precedent. No
          // override at all (the common case) falls through to the ORIGINAL
          // expression byte-for-byte: overrideRange/overrideSymbol are both
          // undefined, so effectiveRange/effectiveSymbol reduce to
          // hEntry.range/hEntry.symbol exactly as before this fix.
          //
          // P2-11 (round-4 evaluation): a bare `{handle}` batch target whose
          // handle happens to be a `kind:"symbol"` mint (paymentStep0, minted
          // by an earlier symbol-focused facet read) STILL fell back to
          // `hEntry.symbol` here even when THIS call declared
          // `content:"full"` — so a `form:"handle"` wire entry reported an
          // honest `range` (the symbol's OWN stored span, e.g. "4-10", from
          // `hEntry.range`) over a `content` that was actually
          // getSymbolWithContext's ASSEMBLED view (a `// tokenlighten:scope`
          // header + elided enclosing scope + sibling signatures + target —
          // 20+ lines for a 7-line range), never the verbatim source of that
          // range. AGENTS.md is explicit that `content:"full"` on a handle
          // entry ships "the verbatim source of the handle's window" — the
          // window a symbol handle stores IS `hEntry.range`, so
          // `rangeContentFullMarker` suppresses the passive stored-symbol
          // fallback exactly like an explicit override range already does,
          // and the plain-range branch below reports (and serves) that same
          // window honestly. An EXPLICIT per-item override symbol (a
          // deliberate ask, not a passive fallback) still wins regardless —
          // only the IMPLICIT `hEntry.symbol` fallback is suppressed.
          const override = handleOverrides?.[hIdx];
          const overrideRange = typeof override?.["range"] === "string" ? override["range"] : undefined;
          const overrideSymbol = typeof override?.["symbol"] === "string" ? override["symbol"] : undefined;
          const effectiveRange = overrideRange ?? hEntry.range;
          const effectiveSymbol = overrideSymbol
            ?? (overrideRange === undefined && !rangeContentFullMarker ? hEntry.symbol : undefined);
          const isSynthesizedFileRange = effectiveRange === undefined && effectiveSymbol === undefined;
          const hRange = effectiveRange
            ?? (effectiveSymbol === undefined ? `1-${Math.max(1, countLines(hContent))}` : undefined);
          // 2026-10-24 (read-page ceiling): the batch's FIRST window is cut to the
          // client's ceiling here, on a line boundary, by the slice's own byte-exact
          // fill (`budgetedSliceCapBytes`), instead of being left at the fixed 24 KiB
          // cap for the emit tail to halve (a halved window fills 50-70% of the
          // page, and a batch of four 300-line windows cost six round trips). Only
          // the first: a later window that does not fit is deferred WHOLE (the
          // aggregate ceiling above, then the tail's whole-entry rung) and opens
          // the next page, where it is first. Only for a client with a ceiling --
          // a declared budget on any other client sizes this batch exactly as it
          // always has.
          const firstWindowBudget = items.length === 0 && defaultResponseByteCeiling !== undefined
            ? handlesBatchCeiling
            : undefined;
          const sliceResult = await resolveSlice(workspace, hPath, hContent, effectiveSymbol, hRange, firstWindowBudget);
          if (!sliceResult.ok) {
            // D1: a symbol-not-found miss (sliceResult.code === "not-found",
            // as opposed to a range/path miss) carries candidates/skeleton
            // through to the omitted entry instead of collapsing to a bare
            // reason string. W2 (2026-07-30): a range-invalid miss carries
            // next/total_lines the same way — every omitted entry keeps at
            // least one piece of recovery data instead of a bare reason.
            omitted.push({
              handle: hId,
              reason: sliceResult.capExceeded ? "cap-exceeded" : "not-found",
              ...(sliceResult.code ? { code: sliceResult.code } : {}),
              ...(sliceResult.candidates ? { candidates: sliceResult.candidates } : {}),
              ...(sliceResult.skeleton ? { skeleton: sliceResult.skeleton } : {}),
              ...(sliceResult.next ? { next: sliceResult.next } : {}),
              ...(sliceResult.total_lines !== undefined ? { total_lines: sliceResult.total_lines } : {}),
            });
            continue;
          }
          // DESIGN-v0.8 §C3: comments elided by default (comments=keep escape);
          // sliceResult.data.sha is already computed from the RAW content
          // (resolveSlice), so it stays a valid content pin regardless.
          // item 11: pass the slice's true file start line so elision markers
          // read as file lines, not slice-relative lines — EXCEPT when
          // resolveSlice took the symbol branch (`assembled: true`), whose
          // `content` is getSymbolWithContext's ASSEMBLED view (preamble +
          // body); `range` there is only the body's file range and does not
          // describe content's own line numbering, so markers must stay
          // code-relative (startLine 1), mirroring mode=symbol's documented
          // exception (server.ts ~:7308).
          // C2 (2026-07-24): elideDocCommentsForDisplay so an all-comment batch
          // item serves RAW content + a note rather than a lone elision marker,
          // parity with the single-handle mode=slice serve. Identical output to
          // elideDocComments for every non-empty item.
          //
          // FIX-A3 (TL-05 follow-up, item 3, 2026-09-21): `rangeContentFullMarker`
          // joins `keepComments` here exactly as it already does for the
          // single-handle mode=slice branch's `effectiveKeepComments` — this A7
          // `handles=[]` loop is itself a common CONTINUATION destination (a
          // multi-handle `next`/cursor lands right back here), and it used to
          // consult only the caller's `comments:"keep"` setting, silently
          // re-eliding a window a `content:"full"` request had asked to see
          // unelided. `hRange` is always populated here (a real per-item range,
          // an override range, or the synthesized "1-N" whole-file window for a
          // bare handle), so this follows the same "range + full => unelided"
          // rule uniformly across every item of the batch.
          const itemDisplay = (keepComments || rangeContentFullMarker)
            ? { content: sliceResult.data.content, note: undefined as string | undefined, elided: [] as Array<[number, number]> }
            : sliceResult.data.assembled
              ? elideSymbolContextForDisplay(sliceResult.data.content, languageForPath(hPath))
              // A window the caller named renders like the single-target read:
              // one that is mostly a comment block keeps it (code-fix probe, 2026-11-01).
              : elideDocCommentsForExplicitWindow(sliceResult.data.content, languageForPath(hPath), rangeStartLine(sliceResult.data.range), countLines(hContent));
          // SHOULD-FIX 57: a `stripped` serve is STATED here too — this item
          // carries a `sha`, and that sha is over the stripped text.
          const itemNote = [sliceResult.data.note, itemDisplay.note, nulStrippedNoteText(hVerdict)]
            .filter(Boolean).join("; ") || undefined;
          // 2026-10-20: a window held in full is not resent (see
          // `handlesBatchAnswersHeld`). An archive member is never booked.
          if (handlesBatchAnswersHeld && !virtual) {
            const held = heldBatchWindowEntry(
              workspace, hPath, hContent, sliceResult.data, itemDisplay.elided,
              keepComments || rangeContentFullMarker, hId,
            );
            if (held !== undefined) {
              items.push(held);
              continue;
            }
          }
          // 2026-10-24 (read-page ceiling): for a client with a response ceiling the
          // aggregate is judged BEFORE this window is committed and booked, and by
          // what it costs on the wire (`batchWindowWireCost`: one entry per run of
          // code, each with its own envelope), not by its raw content. The check
          // below (after commit) lets the window that crosses the ceiling ship
          // whole -- right for a caller's declared budget, which asked for less of
          // everything -- but a page of a dozen one-line windows then came back at
          // 16.5 KB for a 14,336 B ceiling, and the emit tail could not cut it back:
          // its first whole-entry drop costs more in `limit.next` than the one-line
          // entry it removes, so the ladder reads it as no progress and stops. This
          // window is deferred whole instead (with every one after it, by the cap
          // branch at the top of the loop), and the reserve covers the envelope and
          // the `next` that will name what is left. The first window always ships.
          if (defaultResponseByteCeiling !== undefined && handlesBatchCeiling !== undefined && items.length > 0
            && handlesBatchBytesSoFar
              + batchWindowWireCost(hPath, itemDisplay.content, itemDisplay.elided.length)
              + OUTER_BATCH_RESERVE_BYTES + 130 * (requested.length - hIdx)
              > handlesBatchCeiling) {
            handlesBatchCapHit = true;
            hIdx -= 1;
            continue;
          }
          // S1 (2026-08-07): BOOK WHAT THIS BATCH ACTUALLY SERVES. This path
          // put bodies on the wire and recorded nothing, so every later
          // consumer of the served-range ledger — code_unchanged receipts, the
          // full governor, and now the verification kit's per-entry collapse —
          // still believed those bytes were unserved. The kit's own
          // `verification.next_call` IS this call, so an omitted body the
          // caller fetched came back inlined again on the next edit: the exact
          // repeat S1 exists to remove. Booked through
          // spansExcludingWindows over the renderer's own `elided` accounting
          // (ruling (aa)) like every other serve path, so elided comment
          // blocks stay in `unserved` and no span is claimed that the
          // wire did not carry (2026-08-02 serve-honesty).
          if (!sliceResult.data.assembled && !virtual) {
            const itemStart = rangeStartLine(sliceResult.data.range);
            const itemTotalLines = countLines(hContent);
            const itemEnd = Math.min(
              itemTotalLines,
              itemStart + countLines(sliceResult.data.content) - 1,
            );
            const itemCall = handlesBatchServeCall ??= beginServeCall(workspace);
            // FX-W3 (ruling (aa)): renderer-accounted spans, not a re-parse of
            // `itemDisplay.content`.
            for (const [spanStart, spanEnd] of spansExcludingWindows(itemStart, itemEnd, itemDisplay.elided)) {
              recordServedRange(
                workspace, hPath, shaOfText(hContent), spanStart, spanEnd, itemTotalLines,
                { mode: "handles", range: sliceResult.data.range, call: itemCall },
              );
            }
          }
          items.push({
            handle: hId,
            path: sliceResult.data.path,
            range: sliceResult.data.range,
            content: itemDisplay.content,
            truncated: sliceResult.data.truncated,
            // C10.1: short display sha (response only) — the handle minted in
            // resolveSlice keeps the full sha.
            sha: shortSha(sliceResult.data.sha),
            // C10.2 completion / D2: forward the boundary-cut `note` resolveSlice
            // now returns (the single-handle mode=slice path already does — this
            // batch item shape had dropped it), composed with any C2 raw-serve note.
            ...(itemNote ? { note: itemNote } : {}),
            // Guard 2 (2026-07-12b): forward the out-of-slice concern_note the
            // same way — the single-handle mode=slice path below gets this for
            // free via its full `...sliceResult.data` spread; this explicit
            // per-item shape needs the same one-line addition `note` got.
            ...(sliceResult.data.concern_note ? { concern_note: sliceResult.data.concern_note } : {}),
            // DESIGN-v0.9 §4.2: forward the symbol-branch cap downgrade markers
            // so a symbol-kind handle over READ_SYMBOL_CAP_BYTES serves a
            // trimmed head HERE too (not the old bare cap-exceeded omit) — the
            // §4.6b codeless-handles internal execution depends on this batch
            // path not re-refusing. The single-handle path gets them free via
            // its `...sliceResult.data` spread.
            ...(sliceResult.data.downgraded_from ? { downgraded_from: sliceResult.data.downgraded_from } : {}),
            ...(sliceResult.data.remaining_ranges ? { remaining_ranges: sliceResult.data.remaining_ranges } : {}),
            ...(sliceResult.data.next ? { next: sliceResult.data.next } : {}),
            ...(isSynthesizedFileRange ? { synthesized_range: true } : {}),
          });
          // 2026-10-24 (read-page ceiling): the tail of a window the budgeted slice
          // cut (the batch's first window, `firstWindowBudget`) is named by the
          // response's own `limit.next` too, as a deferred window -- the entry's
          // per-entry `next` alone is a continuation only a follower that reads
          // entries finds, and nothing else on the page would say the batch owes
          // anything. A client without a ceiling is served as before.
          if (defaultResponseByteCeiling !== undefined && sliceResult.data.truncated === true
            && sliceResult.data.remaining_ranges !== undefined) {
            for (const tail of sliceResult.data.remaining_ranges) {
              omitted.push({
                handle: hId,
                path: hPath,
                reason: "cap-exceeded",
                range: tail,
                ...(args["content"] === "full" ? { contentFull: true } : {}),
              });
            }
          }
          // T2: account AFTER commit, never before -- an item that itself
          // crosses the ceiling still ships whole (see the doc comment above
          // handlesBatchCeiling); only ITEMS AFTER IT are deferred.
          if (handlesBatchCeiling !== undefined) {
            handlesBatchBytesSoFar += defaultResponseByteCeiling === undefined
              ? Buffer.byteLength(itemDisplay.content, "utf8")
              : batchWindowWireCost(hPath, itemDisplay.content, itemDisplay.elided.length);
            if (handlesBatchBytesSoFar > handlesBatchCeiling) handlesBatchCapHit = true;
          }
        }

        const completeness = omitted.length === 0 ? "complete" : items.length === 0 ? "empty" : "partial";
        return toolOk({ mode: "handles", items, omitted, completeness });
      }

      // -----------------------------------------------------------------------
      // Read-only archive input. Generic archive bytes must never enter the
      // UTF-8/code pipeline below. Explicit archive selectors are canonical;
      // a single archive in paths[] is also promoted so existing task_pack
      // callers get the safe one-call behavior without a schema migration.
      // -----------------------------------------------------------------------
      const virtualResolved = resolvedPath ? splitArchiveVirtualPath(resolvedPath) : undefined;
      if (virtualResolved) {
        // served-bytes: not-served (archive CONTAINER bytes: readArchiveMember gates the member)
        const archiveBytes = await readBytesSafe(virtualResolved.outerPath, workspace);
        if (archiveBytes === null) {
          return toolStructuredError({
            ok: false,
            code: "archive-not-found",
            error: `File not found or outside workspace: ${virtualResolved.outerPath}`,
          });
        }
        const memberResult = await readArchiveMember(
          archiveBytes,
          virtualResolved.outerPath,
          virtualResolved.member,
          workspace,
          credentialPassword,
        );
        if (!memberResult.ok) {
          return toolStructuredError(memberResult as unknown as Record<string, unknown>);
        }
        const member = memberResult.data;
        const memberSha = member.sha;
        const memberHandle = handleTable.upsert({
          kind: resolvedRange ? "range" : "file",
          path: member.virtualPath,
          ...(resolvedRange ? { range: resolvedRange } : {}),
          workspaceRoot: workspace,
          sha: memberSha,
        });

        if (resolvedRange || mode === "slice") {
          const slice = await resolveSlice(
            workspace,
            member.virtualPath,
            member.content,
            resolvedSymbol,
            resolvedRange,
          );
          if (!slice.ok) return toolStructuredError({ ok: false, code: slice.code ?? "not-found", error: slice.error });
          return toolOk({
            ...slice.data,
            handle: memberHandle.id,
            sha: shortSha(memberSha),
            archive: {
              path: member.outerPath,
              member: member.member,
              format: member.format,
              archive_sha: shortSha(member.archiveSha),
              read_only: true,
            },
          });
        }
        if (mode === "symbol") {
          if (!resolvedSymbol) return toolError("symbol is required for mode=symbol", { code: "invalid-input" });
          const symbolResult = await getSymbolWithContext(member.content, {
            path: member.virtualPath,
            symbol: resolvedSymbol,
          });
          if (!symbolResult.ok) {
            return toolStructuredError(symbolResult as unknown as Record<string, unknown>);
          }
          return toolOk({
            ...symbolResult.data,
            handle: memberHandle.id,
            sha: shortSha(memberSha),
            archive: { path: member.outerPath, member: member.member, format: member.format, read_only: true },
          });
        }
        if (mode === "skeleton") {
          const skeleton = await getFileSkeleton(member.content, { path: member.virtualPath });
          if (!skeleton.ok) return toolError(skeleton.error);
          // A.5.3 (C2-3): a member SKELETON is a projection, not a window —
          // `read.map`'s `signatures` form. Declared because `mode` here can be
          // `archive`, which otherwise names `read.artifact`.
          declareKind("read.map");
          return toolOk({
            ...skeleton.data,
            handle: memberHandle.id,
            sha: shortSha(memberSha),
            archive: { path: member.outerPath, member: member.member, format: member.format, read_only: true },
          });
        }
        const semanticQuery = typeof args["query"] === "string" ? args["query"].trim() : "";
        const evidence = semanticQuery
          ? selectQueryEvidence(member.content, semanticQuery, { path: member.virtualPath })
          : undefined;
        if (evidence) {
          // A.5.2 (C2-3): a member BODY serve is `read.text` — the archive
          // container is provenance (`archive`), not the payload's family.
          declareKind("read.text");
          return toolOk({
            content: evidence.content,
            // §3.3: fresh evidence is addressed by handle + path + range. The
            // path was the one leg missing here, so the projected `Evidence`
            // could not name the member it served.
            path: member.virtualPath,
            range: evidence.range,
            truncated: true,
            handle: memberHandle.id,
            sha: shortSha(memberSha),
            archive: { path: member.outerPath, member: member.member, format: member.format, read_only: true },
          });
        }
        const memberBytes = Buffer.from(member.content, "utf8");
        const memberCap = mode === "full" ? READ_FULL_CAP_BYTES : DOC_CONTENT_CAP_BYTES;
        const memberBody = memberBytes.subarray(0, memberCap).toString("utf8");
        declareKind("read.text");
        return toolOk({
          content: memberBody,
          path: member.virtualPath,
          language: languageForPath(member.virtualPath) ?? "text",
          handle: memberHandle.id,
          sha: shortSha(memberSha),
          truncated: memberBytes.length > Buffer.byteLength(memberBody, "utf8"),
          archive: { path: member.outerPath, member: member.member, format: member.format, read_only: true },
        });
      }

      const taskArchivePath = archiveSelector?.member
        ? undefined
        : archiveSelector?.path ?? archivePathFromTaskPaths(args["paths"]);
      const archiveTaskRequested =
        taskArchivePath !== undefined &&
        (
          mode === "task_pack" ||
          (
            (args["mode"] === undefined || mode === "auto") &&
            Array.isArray(args["paths"]) &&
            (args["paths"] as unknown[]).length === 1
          )
        );
      if (archiveTaskRequested && taskArchivePath) {
        // DESIGN-v0.15 §8.2 (R7 Part B): a single-path task_pack query over a
        // zip auto-detects an archive task pack purely from the extension —
        // no advertised full-only field is present for the schema gate to
        // catch. Gate the auto-detected capability itself.
        const archiveTaskSurfaceRefusal = officeOrArchiveSurfaceRefusal();
        if (archiveTaskSurfaceRefusal !== undefined) {
          return toolStructuredError({ ok: false, code: archiveTaskSurfaceRefusal.code, error: archiveTaskSurfaceRefusal.error });
        }
        // served-bytes: not-served (archive CONTAINER bytes: readArchiveMember gates the member)
        const archiveBytes = await readBytesSafe(taskArchivePath, workspace);
        if (archiveBytes === null) {
          return toolStructuredError({
            ok: false,
            code: "archive-not-found",
            error: `File not found or outside workspace: ${taskArchivePath}`,
          });
        }
        const queryResolution = resolveTaskPackQueryOnce();
        if (queryResolution.error) {
          return toolStructuredError(taskPackQueryErrorPayload(queryResolution));
        }
        const requestedProfile = parseTaskProfile(args["taskProfile"]);
        const taskResult = await buildArchiveTaskPack(
          archiveBytes,
          taskArchivePath,
          queryResolution.query,
          workspace,
          requestedProfile === "answer" ? "answer" : "generic",
          credentialPassword,
        );
        if (!taskResult.ok) {
          return toolStructuredError(taskResult as unknown as Record<string, unknown>);
        }
        // A.5.1 (C2-3): an archive pack is a task pack, whatever `mode` the
        // caller reached it through (`task_pack`, or a single-path `auto`).
        declareKind("read.task_pack");
        const archivePack = attachSupply(taskResult.data as unknown as Record<string, unknown>, workspace);
        // S2b: the archive family's own decision projector, read off the pack
        // BEFORE `projectReadBody` deletes `route`/`execution_contract` from the
        // wire. `projectTaskPackWire` cannot derive one here (typestate-less
        // contract), so without this the response ships a `read.task_pack` with
        // no `decision` at all — C2-3's recorded handoff.
        projectTaskPackWire(
          archivePack,
          queryResolution.query,
          archiveTaskDecision(taskResult.data),
        );
        return toolOk(archivePack);
      }

      const outerArchivePath =
        archiveSelector?.member ? undefined : archiveSelector?.path ?? resolvedPath;
      // DESIGN-v0.15 §8.2 (R7 Part B): a bare `mode=auto` read of a `.zip`
      // path auto-detects archive-manifest handling purely from the
      // extension — gate the capability once, ahead of both branches below
      // (the manifest success path and the "archive-read-only-container"
      // refusal further down, whose own `next` would otherwise suggest
      // `mode:"archive"`, a shape this surface can never accept).
      const outerArchiveSurfaceRefusal = outerArchivePath && isSupportedArchivePath(outerArchivePath)
        ? officeOrArchiveSurfaceRefusal()
        : undefined;
      if (outerArchiveSurfaceRefusal !== undefined) {
        return toolStructuredError({ ok: false, code: outerArchiveSurfaceRefusal.code, error: outerArchiveSurfaceRefusal.error });
      }
      if (
        outerArchivePath &&
        isSupportedArchivePath(outerArchivePath) &&
        (mode === "archive" || mode === "auto")
      ) {
        // served-bytes: not-served (archive CONTAINER bytes: readArchiveMember gates the member)
        const archiveBytes = await readBytesSafe(outerArchivePath, workspace);
        if (archiveBytes === null) {
          return toolStructuredError({
            ok: false,
            code: "archive-not-found",
            error: `File not found or outside workspace: ${outerArchivePath}`,
          });
        }
        const manifest = await buildArchiveManifest(
          archiveBytes,
          outerArchivePath,
          workspace,
          archiveSelector?.prefix,
          credentialPassword,
        );
        // S2b: THE FAILURE BRANCH FIRST, and no `declareKind` on it.
        //
        // `declareKind` wins over every derivation in `kindForCall`
        // (protocol/envelope.ts:319), so
        // declaring `read.artifact` before the outcome was known stamped that
        // member onto `openArchive`'s failures too — `archive-encrypted`,
        // `archive-unsafe-path` and `archive-bomb` shipped as `read.artifact`
        // bodies carrying none of A.5.5's required keys (`handle`, `sha`,
        // `content`, `warnings`) and an invalid continuation, instead of the
        // `refusal` they are. Nothing else about them changes: the SAME
        // `toolStructuredError` payload now reaches `buildRefusal`, which is
        // the only thing the premature declaration was suppressing.
        if (!manifest.ok) {
          return toolStructuredError(manifest as unknown as Record<string, unknown>);
        }
        // A.5.5 (C2-3): an archive manifest is `read.artifact` whether the
        // caller said `mode=archive` or reached it through `auto` — the member
        // is a function of the payload, not of the request token (D4).
        declareKind("read.artifact");
        return toolOk(manifest.data);
      }
      if (outerArchivePath && isSupportedArchivePath(outerArchivePath)) {
        return toolStructuredError({
          ok: false,
          code: "archive-read-only-container",
          error: `mode=${mode} cannot read raw archive bytes`,
          next: canonicalToolCall("tl_read_file", { mode: "archive", path: outerArchivePath }),
        });
      }

      // -----------------------------------------------------------------------
      // S6 (2026-09-20, Copilot dead-turn forensics): query-less multi-target
      // paths[]/handles batch with a per-entry symbol window --
      // `targets:[{path,symbol},{path,symbol},{path}]` (a documented,
      // advertised shape: targets[].symbol, "partial=>targets[].range/
      // .ranges/.symbol") must not fall into the mode-unspecified task_pack
      // promotion just below (`pathlessExploratoryPaths` ->
      // buildSeededTaskPack). That builder treats every path as a ranking
      // CANDIDATE for a query and has no per-entry "this symbol does not
      // exist" signal to give back -- confirmed live: an unresolvable symbol
      // silently served a truncated, mislabeled first line instead of the
      // candidates/skeleton/next a single-target mode=symbol miss gives. A
      // range-only batch is deliberately NOT rerouted here: it already
      // resolves its exact windows correctly through that same promotion
      // (F-V13-1 Fix A / rangedBatchNextPreservation.spec.ts) and must keep
      // doing so unchanged -- only a target carrying `symbol` trips this
      // branch.
      //
      // Recorded live (2026-09-20 GitHub Copilot session, new build): two
      // {path,symbol} targets plus a bare {path}, under an already-prepared
      // answer-profile task, hard-refused "path is required" -- the FIRST
      // entry's symbol forces the whole call to mode="symbol"
      // (normalizeCanonicalRequest above), which only ever resolves a
      // single top-level path/symbol and never promotes one for
      // targets.length > 1. Resolved here instead, independent of what
      // `mode` ended up as, using the SAME resolveSlice/servedTextForRoute
      // machinery and the SAME omitted[] not-found shape the A7 handles=[]
      // batch above already uses -- in request order, one response, no
      // whole-call refusal for one bad symbol.
      //
      // 2026-10-18 (v016 decision 6t-2): a batch whose EVERY entry is an
      // explicit window — its own `range`, or a small whole file (below) —
      // now takes this loop too, reversing the "range-only batch is
      // deliberately NOT rerouted" note above. The task_pack promotion
      // resolves those windows correctly, but it answers a read with a new
      // task, a new ready certificate and a decision envelope: 11 of arm A's
      // multi-target reads after the first pack were all-range, each minted
      // its own task (T09 rep2: `issueService.ts` 162-211 and 434-457 came
      // back as a 3,926 B `act.edit` pack for ~2.3 KB of lines), and the
      // guides tell agents to batch independent reads in ONE `targets` call.
      // A bare `{path}` entry qualifies only for a regular file no larger than
      // mode=auto's whole-file threshold (`smallBatchFileBytes`): a single
      // bare-path read of such a file already serves all of it. 12 of arm A's
      // 13 bare multi-file reads were such files, and their packs ran 1.0x to
      // 5.2x the files' own bytes (T05c rep2: 3,464 B of files, 18,048 B of
      // pack). A larger file, a directory or a missing path still seeds the
      // exploratory pack (a whole-file entry here would ship the whole file),
      // and a `ranges[]` entry still gets the refusal below.
      //
      // A call that opens a new task (`task.epoch:"new"`) keeps its pack. A
      // window this session has served already does not (§20.16-§20.17): one
      // served only in part comes here and is served whole, as the pack
      // served it, and one served in full gets a short already-served entry
      // (`file-downgraded`, `code_unchanged`) instead of its bytes. The
      // window bound must fit BATCH_SINGLE_RESPONSE_MAX_BYTES, with no caller
      // budget. A tighter host ceiling does not change a read into a task:
      // emit stages the original read request and pages the unserved windows
      // under that ceiling, with its existing source-bound cursors. Larger
      // windows and explicit caller budgets retain the task_pack route.
      //
      // 2026-10-19 (v016 decision 6t-3): that one response is the reply's own
      // 32 KiB ceiling, checked against a bound on the reply rather than the
      // raw windows (`windowedBatchBytes`, BATCH_SINGLE_RESPONSE_MAX_BYTES),
      // and no window may exceed what `resolveSlice` serves uncut. At the old
      // 16 KiB of raw windows, T03 rep2's four OrderOrchestrator.java windows
      // and T10 rep2's CONTRACT.md 100-230 beside two whole files were packs.
      //
      // 2026-10-20 (v016 decision 6t-7, T13 rep1): a `{handle}` entry counts
      // as the window it resolves to (`handleBatchEntryWindow`), so a
      // query-less read mixing handle and path targets is this batch too. It
      // took the task_pack route whatever its windows: the recorded #7, two
      // ekf.cpp windows by handle beside drv_imu.h and drv_gps.h by path,
      // came back as a 23,784 B pack under a new task, and is a 20,403 B
      // read.batch now (replay corpus v016hb).
      // -----------------------------------------------------------------------
      const pathsBatchEntries = Array.isArray(args["paths"]) ? (args["paths"] as unknown[]) : [];
      const entryField = (entry: unknown, name: string): unknown =>
        typeof entry === "object" && entry !== null ? (entry as Record<string, unknown>)[name] : undefined;
      const pathsBatchModeEligible = mode !== "task_pack" && mode !== "closure"
        && (args["mode"] === undefined || mode === "auto" || mode === "symbol");
      const pathsBatchHasSymbol = pathsBatchEntries.some((entry) => entryField(entry, "symbol") !== undefined);
      const pathsBatchWindowBytes = pathsBatchModeEligible && pathsBatchEntries.length > 1 && !pathsBatchHasSymbol
        && args["maxBytes"] === undefined && args["maxTokens"] === undefined && args["taskEpoch"] !== "new"
        ? await windowedBatchBytes(workspace, pathsBatchEntries, rangeContentFullMarker)
        : undefined;
      const pathsBatchIsWindowed = pathsBatchWindowBytes !== undefined
        && pathsBatchWindowBytes <= BATCH_SINGLE_RESPONSE_MAX_BYTES;
      if (
        pathsBatchModeEligible
        && pathsBatchEntries.length > 1
        && (pathsBatchHasSymbol || pathsBatchIsWindowed)
      ) {
        const rawEntries = args["paths"] as unknown[];
        // `ranges[]` (plural, multi-window) on one target has no per-item
        // carrier in this batch's one-range-per-item shape -- the same scope
        // note the A7 handles=[] batch's own HANDLE_OVERRIDES_INPUT gate
        // documents. Since 2026-10-20 the canonical projection splits a
        // well-formed per-target `ranges[]` into one entry per window
        // (`expandMultiTargetRanges`), so only one it left as sent reaches
        // here. Refuse the WHOLE batch with a concrete task_pack recovery
        // instead of silently falling back to a default window.
        const rangesEntry = rawEntries.find(
          (entry) => typeof entry === "object" && entry !== null
            && Array.isArray((entry as Record<string, unknown>)["ranges"])
            && ((entry as Record<string, unknown>)["ranges"] as unknown[]).length > 0,
        );
        if (rangesEntry !== undefined) {
          return toolStructuredError({
            ok: false,
            code: "invalid-input",
            field: "targets",
            error: "ranges[] on one target of a mixed symbol/range batch is not supported; request one range per target, or re-read via task_pack",
            next: canonicalToolCall("tl_read_file", { mode: "task_pack", paths: rawEntries }),
          });
        }

        // TL-06 (plan-0143 §4/§8.1, R04, FIX-A6): the SAME staleness
        // protection the A7 handles=[] batch and the task_pack doors already
        // have — see admitCallerRangedContinuation's own doc comment. This
        // mixed symbol/path batch is its own, separate multi-target serve
        // loop (S6, above) with a per-entry effective range/symbol precedence
        // (entry override, else a handle's own stored tag) that mirrors the
        // A7 loop's own; a ranged entry here was exactly as unprotected as
        // the single-target mode=slice door until this fix, since neither
        // `pathlessExploratoryPaths` nor the A7 pre-pass ever sees a call
        // shape that trips THIS branch (mode="symbol" or a mixed batch).
        // MUST run BEFORE `declareKind("read.batch")` below, same reasoning
        // as every other admission/refusal pre-pass in this function.
        {
          const rangeAdmissionTargets = rawEntries.map((raw) => {
            const resolvedEntry = resolvePathsBatchEntry(raw, workspace);
            const rawObject = typeof raw === "object" && raw !== null ? raw as Record<string, unknown> : undefined;
            const entrySymbol = typeof rawObject?.["symbol"] === "string" ? rawObject["symbol"] : undefined;
            const entryRange = typeof rawObject?.["range"] === "string" ? rawObject["range"] : undefined;
            const hEntryForOverride = resolvedEntry.handle !== undefined ? handleTable.get(resolvedEntry.handle) : undefined;
            // P2-11: mirror the actual serve loop's rangeContentFullMarker
            // suppression below, so this admission pre-check reasons about the
            // SAME effective window the serve loop will honor (see that loop's
            // own P2-11 comment for the full rationale).
            const effectiveSymbol = entrySymbol
              ?? (entryRange === undefined && !rangeContentFullMarker ? hEntryForOverride?.symbol : undefined);
            const effectiveRange = entryRange ?? (entrySymbol === undefined ? hEntryForOverride?.range : undefined);
            return {
              ...(resolvedEntry.handle !== undefined ? { handle: resolvedEntry.handle } : { path: resolvedEntry.path }),
              ...(effectiveRange !== undefined ? { range: effectiveRange } : {}),
              ...(effectiveSymbol !== undefined ? { symbol: effectiveSymbol } : {}),
            };
          });
          const rangeAdmission = await admitCallerRangedContinuation(workspace, rangeAdmissionTargets, args);
          if (rangeAdmission !== undefined) return rangeAdmission;
        }

        // A.5.4: a multi-target serve reporting per-item completeness is
        // `read.batch` whatever `mode` says -- same declaration point (and
        // the same reason) as the A7 handles=[] batch above: a refusal
        // returned AFTER declareKind would be misclassified as a
        // successful, empty read.batch.
        declareKind("read.batch");
        recordReadMode(workspace, "paths");

        const items: Record<string, unknown>[] = [];
        const omitted: Record<string, unknown>[] = [];
        const pathsBatchCeiling = bindToResponseCeiling(
          resolveCallerByteCeiling(
            typeof args["maxBytes"] === "number" ? args["maxBytes"] : undefined,
            typeof args["maxTokens"] === "number" ? args["maxTokens"] : undefined,
            undefined,
          ),
          defaultResponseByteCeiling,
        );
        let pathsBatchBytesSoFar = 0;
        let pathsBatchCapHit = false;
        // F3: one serve-call ordinal for the whole batch, as in the handles
        // loop above.
        let pathsBatchServeCall: number | undefined;

        for (const raw of rawEntries) {
          const resolvedEntry = resolvePathsBatchEntry(raw, workspace);
          if (pathsBatchCapHit) {
            omitted.push({ path: resolvedEntry.path, ...(resolvedEntry.handle ? { handle: resolvedEntry.handle } : {}), reason: "cap-exceeded" });
            continue;
          }
          if (!resolvedEntry.path) {
            omitted.push(resolvedEntry.handleReason !== undefined
              ? { path: resolvedEntry.path, handle: resolvedEntry.handle, reason: resolvedEntry.handleReason }
              : { path: resolvedEntry.path, reason: "path is required" });
            continue;
          }
          const rawObject = typeof raw === "object" && raw !== null ? raw as Record<string, unknown> : undefined;
          const entrySymbol = typeof rawObject?.["symbol"] === "string" ? rawObject["symbol"] : undefined;
          const entryRange = typeof rawObject?.["range"] === "string" ? rawObject["range"] : undefined;
          // A handle-addressed entry with NEITHER an explicit symbol nor range
          // of its own falls back to the handle's OWN stored symbol/range --
          // the same override precedence the A7 handles=[] batch gives an
          // explicit per-target override over a handle's stored tag.
          const hEntryForOverride = resolvedEntry.handle !== undefined ? handleTable.get(resolvedEntry.handle) : undefined;
          // P2-11 (round-4 evaluation): the same fix as the A7 handles=[]
          // batch loop above (see its own doc comment for the full
          // repro/rationale) — a handle-addressed entry with no explicit
          // symbol/range must not silently fall back to the handle's OWN
          // stored symbol (an assembled getSymbolWithContext view) when THIS
          // call declared `content:"full"`; AGENTS.md's own rule is that
          // content:"full" ships the verbatim source of the handle's window,
          // and a symbol handle's window is its stored `range`. An explicit
          // per-entry symbol is a deliberate ask and still wins.
          const effectiveSymbol = entrySymbol
            ?? (entryRange === undefined && !rangeContentFullMarker ? hEntryForOverride?.symbol : undefined);
          const effectiveRange = entryRange ?? (entrySymbol === undefined ? hEntryForOverride?.range : undefined);

          // served-bytes: readServedText
          const verdict = await servedTextForRoute(resolvedEntry.path, workspace);
          if (verdict !== null && verdict.kind === "undecodable") {
            omitted.push({ path: resolvedEntry.path, ...(resolvedEntry.handle ? { handle: resolvedEntry.handle } : {}), reason: "not-decodable-text" });
            continue;
          }
          const content = verdict === null ? null : verdict.text;
          if (content === null) {
            omitted.push({ path: resolvedEntry.path, ...(resolvedEntry.handle ? { handle: resolvedEntry.handle } : {}), reason: "not-found" });
            continue;
          }

          // A bare entry (no symbol, no range anywhere) addresses the whole
          // file -- the same synthesized "1-N" whole-file window the A7
          // handles=[] batch gives a bare, override-less handle (2026-07-31
          // verify-kit-gap), so the third target in the recorded shape above
          // serves the file it named instead of an unservable bare entry.
          const isSynthesizedFileRange = effectiveRange === undefined && effectiveSymbol === undefined;
          const rangeForSlice = effectiveRange
            ?? (effectiveSymbol === undefined ? `1-${Math.max(1, countLines(content))}` : undefined);
          const sliceResult = await resolveSlice(workspace, resolvedEntry.path, content, effectiveSymbol, rangeForSlice);
          if (!sliceResult.ok) {
            // D1: an unknown-symbol miss carries the SAME candidates/skeleton/
            // next a single-target mode=symbol call gives -- resolveSlice is
            // the one shared primitive both routes call, so this entry's
            // not-found information is not a lesser copy of the single-target
            // shape, it is that shape.
            omitted.push({
              path: resolvedEntry.path,
              ...(resolvedEntry.handle ? { handle: resolvedEntry.handle } : {}),
              reason: sliceResult.capExceeded ? "cap-exceeded" : "not-found",
              ...(sliceResult.code ? { code: sliceResult.code } : {}),
              ...(sliceResult.candidates ? { candidates: sliceResult.candidates } : {}),
              ...(sliceResult.skeleton ? { skeleton: sliceResult.skeleton } : {}),
              ...(sliceResult.next ? { next: sliceResult.next } : {}),
              ...(sliceResult.total_lines !== undefined ? { total_lines: sliceResult.total_lines } : {}),
            });
            continue;
          }

          // FIX-A4 (TL-05 follow-up, 2026-09-21): `rangeContentFullMarker`
          // joins `keepComments` here exactly as it already does for the
          // single-handle mode=slice branch's `effectiveKeepComments` (FIX-A2)
          // and the A7 `handles=[]` batch loop above (FIX-A3, item 3) — this
          // S6 `paths[]`/mixed handle-path batch is itself a common
          // CONTINUATION destination (a per-entry `next`/cursor lands right
          // back here), and it used to consult only the caller's
          // `comments:"keep"` setting, silently re-eliding a window a
          // `content:"full"` request had asked to see unelided.
          // `rangeForSlice` is always populated here (a real per-entry range,
          // an override range, or the synthesized "1-N" whole-file window for
          // a bare entry), so this follows the same "range + full =>
          // unelided" rule uniformly across every item of the batch. The
          // served-range booking below (`spansExcludingWindows` over
          // `itemDisplay.elided`) stays consistent for free: an unelided item
          // reports `elided: []`, exactly as the two sibling branches already
          // do.
          const itemDisplay = (keepComments || rangeContentFullMarker)
            ? { content: sliceResult.data.content, note: undefined as string | undefined, elided: [] as Array<[number, number]> }
            : sliceResult.data.assembled
              ? elideSymbolContextForDisplay(sliceResult.data.content, languageForPath(resolvedEntry.path))
              : elideDocCommentsForExplicitWindow(sliceResult.data.content, languageForPath(resolvedEntry.path), rangeStartLine(sliceResult.data.range), countLines(content));
          const itemNote = [sliceResult.data.note, itemDisplay.note, nulStrippedNoteText(verdict)]
            .filter(Boolean).join("; ") || undefined;

          // 2026-10-18 (DESIGN-v0.14-plan.md §20.17): in a windowed batch, a
          // window this session already served in full at this content answers
          // with a short already-served entry instead of its bytes
          // (`heldBatchWindowEntry`, which the A7 handles batch shares). Before
          // it, such a re-ask went to the task_pack route, whose `prior` rows
          // know only windows an earlier PACK served, and came back with every
          // body resent. Not for a symbol batch, or `task.force_serve:true`,
          // the documented resend.
          if (pathsBatchIsWindowed && !pathsBatchHasSymbol && args["force_serve"] !== true) {
            const held = heldBatchWindowEntry(
              workspace, resolvedEntry.path, content, sliceResult.data, itemDisplay.elided,
              keepComments || rangeContentFullMarker, resolvedEntry.handle ?? sliceResult.data.handle,
            );
            if (held !== undefined) {
              items.push(held);
              recordReadPath(workspace, resolvedEntry.path);
              continue;
            }
          }

          if (!sliceResult.data.assembled) {
            const itemStart = rangeStartLine(sliceResult.data.range);
            const itemTotalLines = countLines(content);
            const itemEnd = Math.min(itemTotalLines, itemStart + countLines(sliceResult.data.content) - 1);
            const itemCall = pathsBatchServeCall ??= beginServeCall(workspace);
            for (const [spanStart, spanEnd] of spansExcludingWindows(itemStart, itemEnd, itemDisplay.elided)) {
              recordServedRange(
                workspace, resolvedEntry.path, shaOfText(content), spanStart, spanEnd, itemTotalLines,
                { mode: "paths", range: sliceResult.data.range, call: itemCall },
              );
            }
          }

          items.push({
            // A handle-addressed entry keeps ITS OWN handle identity (the A7
            // convention); a path-addressed entry uses the handle
            // resolveSlice just minted for this exact slice.
            handle: resolvedEntry.handle ?? sliceResult.data.handle,
            path: sliceResult.data.path,
            range: sliceResult.data.range,
            content: itemDisplay.content,
            truncated: sliceResult.data.truncated,
            sha: shortSha(sliceResult.data.sha),
            ...(itemNote ? { note: itemNote } : {}),
            ...(sliceResult.data.concern_note ? { concern_note: sliceResult.data.concern_note } : {}),
            ...(sliceResult.data.downgraded_from ? { downgraded_from: sliceResult.data.downgraded_from } : {}),
            ...(sliceResult.data.remaining_ranges ? { remaining_ranges: sliceResult.data.remaining_ranges } : {}),
            ...(sliceResult.data.next ? { next: sliceResult.data.next } : {}),
            ...(isSynthesizedFileRange ? { synthesized_range: true } : {}),
          });
          if (pathsBatchCeiling !== undefined) {
            pathsBatchBytesSoFar += Buffer.byteLength(itemDisplay.content, "utf8");
            if (pathsBatchBytesSoFar > pathsBatchCeiling) pathsBatchCapHit = true;
          }
          recordReadPath(workspace, resolvedEntry.path);
        }

        const completeness = omitted.length === 0 ? "complete" : items.length === 0 ? "empty" : "partial";
        return toolOk({ mode: "paths", items, omitted, completeness });
      }

      // -----------------------------------------------------------------------
      // Pathless query entry: a caller asking "find/read context for this task"
      // without a path is exploring, not requesting a file auto-read. Route the
      // natural tl_read_file({ query }) shape to task_pack instead of falling
      // through to the path-required auto/skeleton/symbol modes.
      //
      // FIX (2026-07-10a dispatch-gap forensics): the same reasoning applies
      // when the caller passes paths[] instead of (or alongside) a query —
      // {query, paths:[...]} with mode unspecified used to fall through this
      // block entirely (guarded by !hasPathList below) into the path-required
      // modes further down, which only ever look at the singular `path`/
      // `handle` fields, so a paths[]-only request landed on "path is
      // required". paths[] IS the entry's scoping — a caller that already
      // knows which file(s)/dir(s) a task needs is exploring exactly like the
      // pathless-query case, just with a stronger signal than free text. This
      // is also the exact recovery route.reason itself recommends ("re-scope
      // with paths=[...]"), so it must work without ALSO requiring
      // mode=task_pack or a query — buildTaskPack's own paths[] branch
      // (buildSeededTaskPack) already handles a query-less paths[] fine: file
      // entries seed as surfaces, directory entries become confinement scopes
      // or actionable missing-markers.
      // -----------------------------------------------------------------------
      const taskPackQuery = mode === "task_pack" || args["mode"] === undefined || mode === "auto"
        ? resolveTaskPackQueryOnce()
        : {
            query: typeof args["query"] === "string" ? args["query"].trim() : "",
          };
      if (taskPackQuery.error !== undefined) {
        return toolStructuredError(taskPackQueryErrorPayload(taskPackQuery));
      }
      {
        const queryArg = taskPackQuery.query;
        const hasPathList = Array.isArray(args["paths"]) && (args["paths"] as unknown[]).length > 0;
        const modeUnspecifiedOrAuto = args["mode"] === undefined || mode === "auto";
        const promotionEligible =
          modeUnspecifiedOrAuto &&
          !resolvedPath &&
          !resolvedSymbol &&
          !handleArg &&
          args["includeClosure"] !== false;
        const pathlessExploratoryQuery = promotionEligible && queryArg.length > 0 && !hasPathList;
        const pathlessExploratoryPaths = promotionEligible && hasPathList;

        if (pathlessExploratoryQuery || pathlessExploratoryPaths) {
          recordReadMode(workspace, "task_pack");
          // A.5.1 (C2-3 gap, closed in P2): this branch PROMOTES a mode-less /
          // `mode=auto` request to a task pack, and `kindForCall`'s fallback
          // rungs never see it — `noteResolvedMode` is not called here and the
          // request's own `mode` argument is absent or `"auto"`, so the response
          // fell through to `read.text` (pathless query) or `read.batch`
          // (paths[]). The payload IS a task pack, and D4 says `kind` names the
          // payload's family, not the argument the caller typed. Same
          // declaration the archive-pack branch above (:5010) and the
          // `action=locate` closure branch (:9959) already make, for the same
          // reason.
          const promoteLang = parseMcpLang(args["lang"]);
          const taskContractScope = taskContractScopeOf(args);
          // G3 (2026-09-08, qref-binding fix): a bare `{qref}` re-pack carries
          // no `task.handle` of its own, so the direct handle-derived binding
          // is always undefined here. Fall back to the binding recovered from
          // THIS call's own qref (resolveTaskPackQueryArg, via
          // state/session.ts's resolveTaskQueryRefBinding) — the SAME
          // canonical identity an earlier pack of this task stamped onto that
          // qref — so the builder's no-repeat gate
          // (suppressNonProgressingNextCall) and the wire-level `consumed`
          // predicate below see an executed next filed under an explicit
          // `task.handle` exactly as they would if THIS call had resent it.
          const taskBinding = canonicalTaskBindingOf(args, workspace) ?? taskPackQuery.taskBinding;
          const packByteCeiling = taskPackByteCeiling(defaultResponseByteCeiling, {
            taskBinding, fromRef: taskPackQuery.fromRef === true, hasPathList, forceServe: args["force_serve"] === true, query: queryArg,
          });
          const admission = taskPackAdmission(args, packByteCeiling);
          if (admission !== undefined) return admission;
          // TL-06 (plan-0143 §4/§8.1, R04): see admitCallerRangedContinuation's
          // own doc comment — a caller-ranged targets[]/paths[] promotion is
          // exactly the shape that lost sha-bound continuation protection.
          const rangeAdmission = await admitCallerRangedContinuation(workspace, args["paths"], args);
          if (rangeAdmission !== undefined) return rangeAdmission;
          declareKind("read.task_pack");
          const result = await runWithTaskContractScope(taskContractScope, () => buildTaskPack(
            ({
              ...taskCredential,
              // DESIGN-v0.15-sf-intent-layers.md §4.1: threaded so profile
              // binding and structural-concern extraction can gate "edit"
              // disposition on the real CLI flag rather than guessing.
              writeAllowed: ALLOW_WRITE,
              ...((args as Record<PropertyKey, unknown>)[QUERY_CANDIDATE_POLICY_INPUT] === true
                ? { queryCandidatePolicy: "unanchored" as const } : {}),
              // Internal-only: the producer's no-repeat gate needs the same
              // normalized lane that records successful next execution.
              lane: normalizeContractLane(taskContractScope.lane),
              ...(taskBinding !== undefined ? { taskBinding } : {}),
              ...(typeof args["taskEpoch"] === "string" ? { taskEpoch: args["taskEpoch"] } : {}),
              // PI-09 close-out: the explicit "I lost my context" switch.
              ...(args["force_serve"] === true ? { forceServe: true as const } : {}),
              ...((args as Record<PropertyKey, unknown>)[SMALL_WINDOW_RESERVE_FORCE] === true ? { forceServeCallerTargetsOnly: true as const } : {}),
              ...(queryArg.length > 0 ? { query: queryArg } : {}),
              // C2: a qref replay is a call over a working set the caller still
              // holds, so a context-only addition must not re-derive coverage.
              ...(taskPackQuery.fromRef === true ? { taskQueryRefReplay: true as const } : {}),
              ...(parseTaskProfile(args["taskProfile"]) ? { taskProfile: parseTaskProfile(args["taskProfile"]), ...(inheritedTaskProfileArgs.has(args) ? { taskProfileInherited: true as const } : {}) } : {}),
              ...(promoteLang ? { lang: promoteLang } : {}),
              ...(typeof args["limit"] === "number" ? { limit: args["limit"] } : {}),
              ...(Array.isArray(args["surfaceRoles"]) ? { surfaceRoles: (args["surfaceRoles"] as unknown[]).map(String) } : {}),
              ...(hasPathList ? { paths: mapTaskPackPaths(args["paths"] as unknown[]) } : {}),
              ...(typeof args["maxBytes"] === "number" ? { maxBytes: args["maxBytes"] } : {}),
              ...(typeof args["maxTokens"] === "number" ? { maxTokens: args["maxTokens"] } : {}),
              ...(packByteCeiling !== undefined ? { clientDefaultByteCeilingHint: packByteCeiling } : {}),
            }) as unknown as Parameters<typeof buildTaskPack>[0],
            workspace,
          ));
          // Feature 1 (2026-07-12b2): task_pack surfaces with embedded code count as read.
          recordTaskPackSurfaceReads(workspace, result);
          // DESIGN-v0.9 §4.7: shared read-side post-processor stamps
          // continuation (derives next), normalizes/verifies inlined[], guards
          // FORBIDDEN_KEYS. content_completeness/inlined were already set inside
          // dedupeTrimAndPersist; this is the uniform read-side exit.
          const suppliedBase = attachSupply(result as unknown as Record<string, unknown>, workspace);
          // W2 (2026-07-30): re-issue on EVERY non-empty resolved query, not
          // only a freshly-supplied `query` arg. rememberTaskQuery is a pure
          // function of (workspace, query text) -> deterministic ref, so a
          // qref-replay call (query resolved FROM the ref, not re-typed)
          // re-mints the SAME ref here — the caller always gets a live qref
          // back, so a qref-driven pack never reads as a dead end after one
          // replay (see resolveTaskPackQueryArg's qref branch above).
          const issuedRef = taskPackQuery.query.length > 0
            ? rememberTaskPackQuery(workspace, taskPackQuery.query, args)
            : undefined;
          const supplied = issuedRef !== undefined
            ? { ...suppliedBase, qref: issuedRef }
            : suppliedBase;
          recordTaskPackExecution(workspace, queryArg, supplied, taskContractScope, taskPackQuery.taskBinding, result);
          return toolOk(attachServerBuildOnce(supplied, workspace));
        }
      }

      // -----------------------------------------------------------------------
      // mode=task_pack — v0.7 task closure pack.
      // -----------------------------------------------------------------------
      { const __routeResult1 = await read_taskPack({ mode, taskPackQuery, args, workspace, resolvedPath, resolvedRange, defaultResponseByteCeiling, taskCredential, resolvedSymbol }); if (__routeResult1 !== undefined) return __routeResult1; }

      // -----------------------------------------------------------------------
      // mode=map — R0: surface map (no code body).
      // -----------------------------------------------------------------------
      { const __routeResult2 = await read_map({ mode, workspace, args, resolvedPath, resolvedSymbol }); if (__routeResult2 !== undefined) return __routeResult2; }

      // -----------------------------------------------------------------------
      // mode=overview — broad repo/package map for "what is this system?" tasks.
      // -----------------------------------------------------------------------
      { const __routeResult3 = await read_overview({ mode, workspace, resolvedPath, args }); if (__routeResult3 !== undefined) return __routeResult3; }

      // Markdown section read: the existing sections[] field provides a
      // direct heading -> range-handle route for ordinary repository docs.
      // The returned handle is the same exact range handle tl_edit_file accepts
      // with {handle,content} or {handle,search,replace}.
      const requestedMarkdownSections = Array.isArray(args["sections"])
        ? [...new Set((args["sections"] as unknown[]).map(String).map((value) => value.trim()).filter(Boolean))]
        : [];
      // R1 (2026-07-25 doc-navigation forensics): a SYMBOL lookup against a
      // markdown file is a heading question in disguise — md has no code
      // symbols, so getSymbolWithContext could only ever refuse it. Route it
      // through this same section machinery instead, but ONLY when the caller
      // supplied no range: a range is more specific than a symbol tag (the
      // af2 rule) and stays with mode=slice/resolveSlice, whose own markdown
      // guard serves it.
      const markdownSymbolSection =
        resolvedPath !== undefined &&
        isMarkdownPath(resolvedPath) &&
        requestedMarkdownSections.length === 0 &&
        resolvedRange === undefined &&
        resolvedSymbol !== undefined &&
        resolvedSymbol.trim() !== ""
          ? resolvedSymbol.trim()
          : undefined;
      { const __routeResult4 = await read_markdownSections({ mode, resolvedPath, requestedMarkdownSections, markdownSymbolSection, workspace, noteZeroByteServe, keepComments, forceContentServe, args }); if (__routeResult4 !== undefined) return __routeResult4; }

      // -----------------------------------------------------------------------
      // mode=closure — cheap final self-check: "what task_pack checks are still
      // open?" in one tiny call. Runs the SAME scan attachClosure does
      // (TL-edited FIRST, then git-detected native edits; single-token AND
      // 2-token co-occurrence).
      //
      // FIX-1 (2026-07-09d forensics): total==0 (no pack was ever built
      // this session, OR a pack was built but has zero machine-verifiable
      // checks) used to report complete:true — wire-identical to "every check
      // was verified satisfied". Arm-A agents ran mode=closure, got
      // complete:true off a total==0 response, and declared the task done
      // with nothing actually verified. complete:true now requires total>0
      // AND every check satisfied; the total==0 case reports complete:false
      // with a self-explaining note so the caller falls back to git diff /
      // tests instead of trusting a hollow "done" signal.
      // Response stays tiny: descs only (≤8, each ≤140ch), no handles/code.
      //
      // WS-P3 (DESIGN-v0.9 §6, "zero-content turns"): a CHECKLESS call — no
      // pack ever registered a machine-verifiable check (total==0), or every
      // check the pack DID register is now satisfied (total>0, open==[]) —
      // used to return either the bare note above or a thin
      // {open:[],done,total,complete} shell: real ceremony, since the agent
      // learns nothing it did not already know from the edit response that
      // prompted the call. Both branches below now ALSO carry a `summary` of
      // what this session actually did (closureSessionSummary), built ONLY
      // from data the session/closure ledger already tracks (getEditedPaths
      // — the same TL-edited-paths ledger attachClosure/closureTracking.ts's
      // own scan reads; no new tracking added). The total>0/all-satisfied
      // branch additionally stamps the same top-level `closure_complete:true`
      // the last closing EDIT response carries (§3.1) — kept OFF the total==0
      // branch deliberately: that branch's own `complete:false` exists
      // specifically so a never-built pack can never wire-read as "verified
      // done" (FIX-1 above), and a `closure_complete:true` sibling would
      // silently reintroduce that exact hollow-completion signal under a
      // different field name.
      // -----------------------------------------------------------------------
      { const __routeResult5 = await read_closure({ mode, workspace }); if (__routeResult5 !== undefined) return __routeResult5; }

      // -----------------------------------------------------------------------
      // mode=digest — R1: file/symbol digest.
      // -----------------------------------------------------------------------
      if (mode === "digest") {
        const digestPath = resolvedPath ?? "";
        if (!digestPath) return toolError("path (or handle) is required for mode=digest", { code: "invalid-input" });
        // served-bytes: readServedText
        const digestVerdict = await servedTextForRoute(digestPath, workspace);
        if (digestVerdict !== null && digestVerdict.kind === "undecodable") {
          return toolError(undecodableTextMessage(digestPath, digestVerdict), { code: "read-error" });
        }
        const content = digestVerdict === null ? null : digestVerdict.text;
        if (content === null) return toolError(`File not found or outside workspace: ${digestPath}`, { code: "not-found" });
        const digestResult = await resolveDigest(workspace, digestPath, content, resolvedSymbol);
        // dead at HEAD (see C2-6 audit): resolveDigest has no ok:false
        // return path; coded honestly for the day it does.
        if (!digestResult.ok) return toolError(digestResult.error, { code: "invalid-input" });
        // SHOULD-FIX 57: state a strip here too — the digest is derived from the
        // stripped text, and its counts describe that text.
        return toolOk({ ...digestResult.data, ...nulStrippedNote(digestVerdict) });
      }

      // -----------------------------------------------------------------------
      // mode=slice — R2: exact symbol/range slice with handle + sha.
      // -----------------------------------------------------------------------
      { const __routeResult6 = await read_slice({ mode, resolvedPath, args, hasRangesBatch, rangesArg, resolvedRange, workspace, handleArg, resolvedSymbol, keepComments, rangeContentFullMarker, callerSuppliedRange, defaultResponseByteCeiling, readLedger, forceContentServe, staleHandleReresolved, noteZeroByteServe }); if (__routeResult6 !== undefined) return __routeResult6; }

      // -----------------------------------------------------------------------
      // mode=pack: assemble multiple slices under a token cap.
      // Auto-promotes to task_pack when:
      //   paths is empty AND query is non-empty AND includeClosure !== false.
      // -----------------------------------------------------------------------
      { const __routeResult7 = await read_pack({ mode, args, defaultResponseByteCeiling, workspace, taskCredential, resolvedPath, resolvedSymbol }); if (__routeResult7 !== undefined) return __routeResult7; }

      // -----------------------------------------------------------------------
      // mode=small_file — one-call full+handle response for tiny files.
      // -----------------------------------------------------------------------
      if (mode === "small_file") {
        // D10 (2026-08-14): `TL_SMALL_FILE_ONE_CALL` is deleted; the one-call
        // tiny-file serve is unconditional and `small-file-disabled` is gone.
        const sfPath = resolvedPath ?? "";
        if (!sfPath) return toolError("path is required for mode=small_file", { code: "invalid-input" });
        const smallFileContent = parseSmallFileContent(args["content"]);
        if (!smallFileContent.ok) return toolError("content must be full, outline, defer, or auto", { code: "invalid-input" });
        try {
          const sfResult = await buildSmallFile(workspace, sfPath, String(args["cwd"] ?? ""), { content: smallFileContent.value, keepComments, allowedParents: configuredAllowedParents(workspace) });
          if (!("mode" in sfResult)) {
            // not-tiny refusal
            return toolOk(sfResult);
          }
          return toolOk(sfResult);
        } catch (err: unknown) {
          return toolError(`small_file read failed: ${err instanceof Error ? err.message : String(err)}`, { code: "read-error" });
        }
      }

      // -----------------------------------------------------------------------
      // mode=artifact — structured office document reads (v0.7).
      // -----------------------------------------------------------------------
      { const __routeResult8 = await read_artifact({ mode, resolvedPath, args, workspace, credentialPassword, forceContentServe, defaultResponseByteCeiling }); if (__routeResult8 !== undefined) return __routeResult8; }

      // -----------------------------------------------------------------------
      // mode=skeleton paths=[...] — batch file skeletons.  This is the same
      // per-file, order-preserving batch contract as mode=full: one bad path
      // does not discard the useful skeletons already requested, and a byte
      // cap leaves an executable continuation for the remainder.
      // -----------------------------------------------------------------------
      { const __routeResult9 = await read_skeletonBatch({ mode, args, workspace, defaultResponseByteCeiling }); if (__routeResult9 !== undefined) return __routeResult9; }

      // -----------------------------------------------------------------------
      // mode=full paths=[...] (1+ entries) — batch full-read. Observed
      // repeatedly in bench transcripts: `read_code mode=full paths=[a,b]`
      // errored "path is required" (mode=full only ever accepted a single
      // `path`), so the agent re-issued one read_code call per file — an
      // avoidable extra round trip per file beyond the first. FIX (2026-07-09e
      // forensics): this branch used to require 2+ entries, so a 1-entry
      // paths[] fell through to the singular branch below (which only reads
      // args["path"], never paths[0]) and hard-errored on exactly the shape a
      // caller working down to its last requested file would send — lowered
      // to >=1. Each path is evaluated INDEPENDENTLY through the SAME
      // resolveFullReadForPath helper the single-path branch below uses
      // (office redirect, byte cap, governor, C5 auto-allow) — no cap is
      // weakened: a served full here counts against
      // PER_PATH_FULL_CAP/PER_TASK_FULL_CAP exactly as a separate single-path
      // call would, because decideFullRead's session bookkeeping is keyed on
      // (workspace, path, sha) regardless of call shape. paths[] omitted
      // entirely (or an empty array) still falls through to the existing
      // single-path branch below, unchanged.
      // -----------------------------------------------------------------------
      { const __routeResult10 = await read_fullBatch({ mode, args, workspace, taskCredential, executionGuard, defaultResponseByteCeiling, keepComments }); if (__routeResult10 !== undefined) return __routeResult10; }

      // -----------------------------------------------------------------------
      // Remaining modes (auto, skeleton, symbol, full) require a file path.
      // -----------------------------------------------------------------------
      const filePath = resolvedPath ?? "";
      if (!filePath) {
        return toolError("path is required", {
          code: "invalid-input",
          ...(mode === "symbol" && resolvedSymbol
            ? { next: canonicalToolCall("tl_search_files", {
                action: "find",
                queries: [resolvedSymbol],
                scope: { kind: "symbol" },
              }) }
            : {}),
        });
      }
      const symbolArg = resolvedSymbol ?? "";
      const ext = (filePath.toLowerCase().match(/\.([^.\\/]+)$/)?.[1]) ?? "";
      const isOffice = ext === "docx" || ext === "xlsx" || ext === "pptx" || ext === "pdf";

      // Office files: route based on mode.
      // mode=artifact is handled above. mode=full redirects unless allowFull:true.
      // mode=auto/skeleton/symbol return roster (xlsx) or extractOfficeText (docx/pptx).
      if (isOffice) {
        // DESIGN-v0.15 §8.2 (R7 Part B): see resolveFullReadForPath's twin gate
        // above — this is the single-target inline dispatch's own
        // extension-based auto-detection entry point.
        const officeSurfaceRefusal = officeOrArchiveSurfaceRefusal();
        if (officeSurfaceRefusal !== undefined) return toolError(officeSurfaceRefusal.error, { code: officeSurfaceRefusal.code });
        if (DOC_DISABLED) return toolError("Document extraction is disabled.", { code: "not-a-document" });

        // mode=full on office files: routes through resolveFullReadForPath
        // (shared with the paths[] batch below) — office redirect unless
        // allowFull is explicitly true, or extractOfficeText when it is.
        if (mode === "full") {
          const fr = await resolveFullReadForPath(workspace, filePath, args["allowFull"] === true, keepComments, {
            ...taskCredential,
            ...(args["maxBytes"] !== undefined ? { maxBytes: Number(args["maxBytes"]) } : {}),
            ...(args["maxTokens"] !== undefined ? { maxTokens: Number(args["maxTokens"]) } : {}),
            forceServe: args["force_serve"] === true,
            postReadyTrim: executionGuard.postReadyTrim === true,
          });
          // A.5.5 (C2-3 gap, closed in P2): the `allowFull:true` arm of that
          // helper does NOT serve file bytes — it runs `extractOfficeText` and
          // returns `{text, kind, truncated, warnings}`, an artifact extraction
          // wearing `mode=full`'s clothes. `mode` is a READ_TEXT_MODE, so the
          // response claimed `read.text` and `projectText` — which knows
          // `content`/`code`, not `text` — shipped `evidence: []`: a whole
          // extracted document silently dropped, the same failure the
          // `mode=auto` xlsx branch below carries a declaration for. The other
          // arm is the office REDIRECT (`ok:false`), which is a refusal and
          // must keep classifying as one, so the declaration is scoped to the
          // extraction shape rather than to the branch.
          if (fr.ok && typeof (fr.data as Record<string, unknown>)["text"] === "string") {
            declareKind("read.artifact");
          }
          if (fr.ok) {
            const data = fr.data as Record<string, unknown>;
            // The Office redirect is a refusal, not a successful response
            // carrying an ok:false payload. Keep its payload byte-for-byte so
            // `next` and `path` remain the executable recovery (IL-W5b
            // §11.4: no legacy `alternatives:[{mode:…}]` menu rides here).
            if (data["reason"] === "artifact-full-downgraded") {
              return toolStructuredError(data);
            }
            return toolOk(attachSupply(data, workspace));
          }
          return fullReadRefusal(fr);
        }

        // mode=auto on xlsx: return roster with next suggestions
        if ((mode === "auto" || mode === "skeleton" || mode === "symbol") && ext === "xlsx") {
          // A.5.5 (C2-3): the IMPLICIT artifact route. `noteResolvedMode` runs
          // at the top of the dispatch, before this branch decides that an
          // `auto` read of an .xlsx is a workbook roster rather than a text
          // serve, so the context still says `auto` — which is a READ_TEXT_MODE.
          // Left alone, a bare `tl_read_file path=x.xlsx` claimed `read.text` and
          // `projectText` then found none of the roster's fields and shipped
          // `evidence: []`: the whole workbook silently dropped. The member is a
          // function of the payload (D4), so it is declared where the payload is
          // decided — the same fix the archive-manifest branch above carries.
          declareKind("read.artifact");
          // served-bytes: not-served (office container bytes: extractOfficeText owns the decode)
          const offBytes = await readBytesSafe(filePath, workspace);
          if (offBytes === null) return toolError(`File not found or outside workspace: ${filePath}`, { code: "not-found" });
          const prepared = await prepareOfficeDocument(offBytes, credentialPassword);
          if (!prepared.ok) {
            return toolStructuredError({
              ok: false,
              kind: "xlsx",
              path: filePath,
              error: prepared.error,
              code: prepared.code,
              ...(prepared.hint ? { hint: prepared.hint } : {}),
            });
          }
          const xlsxBytes = prepared.bytes;
          const { xlsxRoster, xlsxTable, pickLargestSheetByCells } = await import("../../office/xlsx.js");
          // B5.2: full-content hash, not a first-48-bytes truncation.
          const offSha = shaOfBytes(offBytes);
          const offHEntry = handleTable.upsert({
            kind: "file",
            path: filePath,
            workspaceRoot: workspace,
            sha: offSha,
          });
          const rosterResult = await xlsxRoster(xlsxBytes);
          if (!rosterResult.ok) return toolError(rosterResult.error, { code: "corrupt" });
          // Same content-based pick as the mode=artifact no-sheet branch:
          // largest visible sheet by non-empty cells, never by name (hidden
          // sheets must be requested explicitly; ties keep workbook order,
          // so single-sheet and tie workbooks behave exactly as before).
          const autoInlineCandidates = rosterResult.sheets.filter((s) => !s.hidden);
          const inlineSheetName = pickLargestSheetByCells(autoInlineCandidates) || (rosterResult.sheets[0]?.name ?? "");
          const rosterOut: Record<string, unknown> = {
            mode: "artifact",
            kind: "xlsx",
            path: filePath,
            view: "roster",
            handle: offHEntry.id,
            sha: shortSha(offSha), // C10.1: short display prefix; offHEntry above minted on the FULL sha.
            sheets: rosterResult.sheets,
            warnings: rosterResult.warnings,
            next: canonicalToolCall("tl_read_file", {
              mode: "artifact",
              path: filePath,
              sheet: inlineSheetName,
              as: "json",
              ...(credentialRef !== undefined ? { credentialRef } : {}),
            }),
          };
          // DESIGN-v0.9 §4.6d known-artifact-section internal execution: the
          // server already extracted the sheet ROSTER and names the largest
          // visible data sheet in `next` — serving that sheet's data is
          // deterministic and in hand. Inline it as `section` (bounded by the
          // §4.8 must-fetch read budget) and stamp
          // inlined:["artifact-section:<path>#<sheet>"], KEEPING the roster
          // listing + next so a caller wanting a DIFFERENT sheet still has
          // the map. Bounded by READ_SYMBOL_CAP_BYTES either way — that base
          // cap (24576) already exceeds the must-fetch read tier (16384), so
          // TL_MUSTFETCH_EXPAND has no effect on this specific check.
          if (inlineSheetName) {
            const tableResult = await xlsxTable(xlsxBytes, { sheet: inlineSheetName, as: "json" });
            if (tableResult.ok) {
              const candidate: Record<string, unknown> = {
                ...rosterOut,
                section: {
                  sheet: tableResult.sheet,
                  range: tableResult.range,
                  columns: tableResult.columns,
                  rows: tableResult.rows,
                  truncated: tableResult.truncated,
                },
                inlined: [`artifact-section:${filePath}#${inlineSheetName}`],
              };
              if (Buffer.byteLength(JSON.stringify(candidate), "utf8") <= mustFetchReadBudget(READ_SYMBOL_CAP_BYTES)) {
                return toolOk(attachSupply(candidate, workspace));
              }
            }
          }
          return toolOk(attachSupply(rosterOut, workspace));
        }

        // All other office modes (auto/skeleton/symbol on docx/pptx, and full with allowFull:true)
        // Same implicit-artifact route as the xlsx roster above: docx/pptx/pdf
        // reached through `auto` extract to `sections`/`slides`/`pages`, which
        // `projectArtifact` reads and `projectText` cannot see at all.
        declareKind("read.artifact");
        // served-bytes: not-served (office container bytes: extractOfficeText owns the decode)
        const bytes = await readBytesSafe(filePath, workspace);
        if (bytes === null) return toolError(`File not found or outside workspace: ${filePath}`, { code: "not-found" });
        const result = await extractOfficeText(
          bytes,
          {
            path: filePath,
            ...(credentialRef !== undefined ? { credentialRef } : {}),
            ...(args["maxBytes"] !== undefined ? { maxBytes: Number(args["maxBytes"]) } : {}),
            ...(args["maxTokens"] !== undefined ? { maxTokens: Number(args["maxTokens"]) } : {}),
          },
          credentialPassword,
        );
        if (!result.ok) {
          return toolStructuredError(result as unknown as Record<string, unknown>);
        }
        return toolOk(result.data);
      }

      // -----------------------------------------------------------------------
      // CSV / TSV — size-gated structured serving (parallel to the office
      // artifact path above; csv/tsv are text, not binary office documents, so
      // they route HERE, not through isOffice). A csv larger than the
      // small-file threshold gets the bounded structured TABLE view on the
      // FIRST auto/skeleton/symbol read — the same "serve data, not a redirect"
      // treatment xlsx gets — instead of the generic S1/C1 doc-content
      // byte-slice further below, which would blindly cut the file at a byte
      // boundary. A small csv (<= TINY_BYTES, the same threshold isTinyFile and
      // the auto-mode small-content serve already use) KEEPS today's text
      // behavior by falling through. mode=full keeps its existing text
      // semantics (handled below); mode=slice (legitimate line slices) is
      // dispatched far above and never reaches here.
      // -----------------------------------------------------------------------
      { const __routeResult11 = await read_csvText({ ext, mode, filePath, workspace, forceContentServe }); if (__routeResult11 !== undefined) return __routeResult11; }

      // AA1 (2026-09-14, review round 10): the direct slice/symbol/full/skeleton
      // route -- the one a caller reaches as `targets:[{path}]` /
      // `targets:[{path, range}]`, and the destination of several task-pack
      // `next`s -- read through `readFileSafe`, whose decode is deliberately
      // LENIENT (its ~40-80 call sites include scans and edit preconditions
      // whose mandate is explicitly not a new failure mode). That made this the
      // door that SERVED, raw, the very bytes the task-pack doors disclosed:
      // review rounds 6-9 measured 63 raw NULs from a BOM-less UTF-16 file and a
      // lone NUL from a 73-byte file arriving here after the pack had refused
      // them (residuals W1-3 / X1-1). `readServedTextSafe` keeps every guard
      // `readFileSafe` applies and adds the ONE serve-side verdict, so the whole
      // server now agrees about which bytes are servable text.
      // served-bytes: readServedText
      const servedVerdict = await servedTextForRoute(filePath, workspace);
      const content = servedVerdict === null || servedVerdict.kind === "undecodable"
        ? null
        : servedVerdict.text;
      if (servedVerdict !== null && servedVerdict.kind === "undecodable") {
        // The read SUCCEEDED and the bytes are not text in this encoding: say so,
        // never serve mojibake and never a misleading `not-found`. `read-error`
        // is the existing RefusalCode for "this read could not produce content"
        // (already this route's own code for a failed `small_file` read); the
        // message names the actual verdict so the caller can act on it. A NEW
        // `not-decodable-text` code would be more precise and is filed as a chip
        // — minting a wire code is a protocol change, not a fix-wave edit.
        return toolError(undecodableTextMessage(filePath, servedVerdict), { code: "read-error" });
      }
      if (content === null) {
        // FIX (2026-07-10a dispatch-gap forensics): readFileSafe's
        // fs.readFile throws EISDIR for a directory target, caught the same
        // as a genuinely missing/escaped path, so an EXISTING directory
        // reported the exact same generic wording as a typo'd path — the
        // caller had no way to tell "this is a directory" apart from
        // "missing" to reach for either real recovery. Re-stat (same
        // safeResolve + statSync pattern the mode=full paths[] batch already
        // uses to tell the two apart) only to swap in an actionable message
        // when it really is a directory; a genuinely missing/escaped path
        // keeps the exact original wording.
        const dirAbs = safeResolve(filePath, workspace);
        if (dirAbs !== undefined && existsSync(dirAbs) && statSync(dirAbs).isDirectory()) {
          // #60 (C2-6 audit): "target is a directory" had no A.7.1 member of
          // its own — not-a-directory is the INVERSE case (expected a
          // directory, got a file); directory-handle-wrong-kind is scoped to
          // HANDLE addressing and no handle is involved here. The gap filed
          // for R5 was RATIFIED (R5-29, 2026-08-14) and `is-a-directory`
          // minted for exactly this emitter, so the `invalid-input` coercion
          // is gone: a caller can now branch on the code instead of parsing
          // the message.
          return toolError(
            `"${filePath}" is a directory — use tl_read_file {query:"...", targets:[{path:"${filePath}"}]} (task pack) or tl_search_files {action:"tree", scope:{path:"${filePath}"}}`,
            { code: "is-a-directory" },
          );
        }
        return toolError(`File not found or outside workspace: ${filePath}`, { code: "not-found" });
      }

      // Explicit mode=symbol, OR auto-mode with a symbol arg → symbol extraction
      { const __routeResult12 = await read_symbol({ mode, symbolArg, content, filePath, noteZeroByteServe, workspace, forceContentServe, keepComments, args }); if (__routeResult12 !== undefined) return __routeResult12; }

      // Explicit mode=full, OR auto-mode under the small-file threshold → full content
      // Smart bypass threshold ~ 750 tokens at 4 chars/tok. Tuned conservatively;
      // the small-file research (B3) found 800 tok as the regime where skeleton's
      // header + signatures-only payload costs more than the raw content.
      // 2026-07-16a: raised 3000 -> 8192, mirroring readCodeSmallFile.ts's
      // AUTO_FULL_THRESHOLD_BYTES (documented there as intentionally aligned
      // with this constant). This is mode=auto's OWN small-file threshold for
      // the fallback path taken when the tiny-file/small_file route above
      // doesn't apply (feature flag off, or a tiny-by-bytes file with more
      // than TINY_LINES lines) — leaving it at 3000 would have reintroduced
      // the exact same outline-then-refetch waste on this parallel path.
      const SMALL_FILE_BYTES = AUTO_SMALL_FILE_BYTES;
      { const __routeResult13 = await read_full({ mode, content, forceContentServe, workspace, filePath, keepComments, args, executionGuard, defaultResponseByteCeiling }); if (__routeResult13 !== undefined) return __routeResult13; }
      { const __routeResult14 = await read_auto({ mode, content, forceContentServe, workspace, filePath, keepComments, args, SMALL_FILE_BYTES }); if (__routeResult14 !== undefined) return __routeResult14; }

      // mode=skeleton (explicit) OR auto-mode on a large code file
      const profileArg = args["profile"];
      const validProfiles = ["class-map", "symbol-map", "doc-map", "full-skeleton"] as const;
      type ValidProfile = typeof validProfiles[number];
      const profile: ValidProfile | undefined =
        typeof profileArg === "string" && (validProfiles as readonly string[]).includes(profileArg)
          ? (profileArg as ValidProfile)
          : undefined;
      const result = await getFileSkeleton(content, { path: filePath, ...(profile ? { profile } : {}) });
      // dead at HEAD (see C2-6 audit): getFileSkeleton has no ok:false
      // return path; coded honestly for the day it does.
      if (!result.ok) return toolError(result.error, { code: "invalid-input" });
      // Augment skeleton with handle (C.6). No sha for skeletons (not the full content).
      const skelHEntry = handleTable.upsert({
        kind: "file",
        path: filePath,
        workspaceRoot: workspace,
      });
      // Feature 1 (2026-07-12b2): successful mode=skeleton (explicit) OR
      // auto-mode-fallback skeleton serve.
      recordReadPath(workspace, filePath);
      return toolOk({ ...result.data, handle: skelHEntry.id });


}
