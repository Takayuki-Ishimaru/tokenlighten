import type { ToolCallResult } from "../../protocol/result.js";
import * as path from "path";
import { activeRoot, ALLOW_WRITE, SESSION_ID } from "../../runtime/config.js";
import { repeatedEditRefusalAdvisory, otherActiveRoots, guardExecutionEdit, servedRangeCoverage, isHandleShippedInThisLane, recordHandleEdit, getExecutionFence, recordExecutionEditResult, getEditedPaths, recordEditedPath, hasUnreadSiblingNoteFired, isClosureSatisfied, markUnreadSiblingNoteFired, recordSingleEditCompletion, recordEditsBatchUsed, recordCreatedEditAdmissibility, READ_BACK_RANGE_PLACEHOLDER, recordPathSearchEdit } from "../../state/session.js";
import { toolStructuredError, toolError, toolOk } from "../../protocol/result.js";
import { guardCwd, guardWriteRouting, type GuardedWorkspaceRoot, resolveGuardedWorkspaceRoot, adoptGuardedWorkspaceRoot } from "../../write/guardedWorkspace.js";
import { handleTable, type HandleEntry, shaOfText, shaOfBytes, shortSha } from "../../util/handles.js";
import { nestedWorkspaceRoots } from "../../write/workspaceBoundary.js";
import { isWorkspaceCandidateAccepted, WORKSPACE_CANDIDATE_LIMIT } from "../../workspace/candidates.js";
import { resolveCredentialRef } from "../../security/credentials.js";
import { effLenientEditEnabled, reasoningIrV2Enabled } from "../../util/flags.js";
import { canonicalToolCall, noteWorkspaceRoot } from "../../protocol/envelope.js";
import { splitArchiveVirtualPath, isSupportedArchivePath } from "../../tools/archive.js";
import { countLines } from "../../util/countLines.js";
import { type ToolCall } from "@tokenlighten/types";
import { readFileSafe, readBytesSafe } from "../../util/safePath.js";
import { getSymbolWithContext } from "../../tools/getSymbolWithContext.js";
import { classifySurface, deriveTokenVariants } from "../../util/impact.js";
import { findText } from "../../features/search/find/findText.js";
import { recordReasoningIrV2ClosureFromEdit, deriveIrTaskRef } from "../../task-state/irDispatchSeam.js";
import { attachClosure } from "../../util/closureTracking.js";
import { enforcePreconditions } from "../../write/preconditions.js";
import { editArtifact } from "../../write/artifactEdit.js";
import { applyIntent } from "../../intents/index.js";
import { renameSymbol } from "../../tools/renameSymbol.js";
import { applyEditsMulti } from "../../tools/applyEditsMulti.js";
import { createFile } from "../../tools/createFile.js";
import { parseBlastRange, measureBlastRadius, blastRadiusRefusal, measureReplaceAllBlastRadius } from "../../write/blastRadius.js";
import { replaceRangeContent, inspectRangeEditTarget, replaceAllInRange } from "../../write/rangeEdit.js";
import { pathlessSymbolEdit, pathlessExactEdit } from "../../write/pathlessEdit.js";
import { readAndEdit } from "../../tools/readAndEdit.js";
import { alreadyAppliedForensics } from "../../write/editForensics.js";
import { getAdaptiveAdvice } from "../../util/adaptive.js";
import { searchReplaceEdit } from "../../tools/searchReplaceEdit.js";
import { getFileSkeleton } from "../../tools/getFileSkeleton.js";
import { editFileUnknownArgumentRefusal, editFileValueRefusal, editDietEnabled, batchItemGuardArgs, batchItemNeedsPreconditionCheck } from "../../serverOwned/edit-validation.js";
import { snapshotEditArgs, pathFormOfEditItem, repairedEditBatchCall, unknownEditItemHandleRefusal } from "../../serverOwned/edit-transaction.js";
import { isCwdExplicit, resolveHandleWorkspace } from "../../serverOwned/workspace-routing2.js";
import { configuredAllowedParents, handleWorkspaceMissingDetail, officeOrArchiveSurfaceRefusal, readFileSafeOpt, parseMcpLang, uniqueMatchRefusalInScope, textForLineRange } from "../../serverOwned/read-admission2.js";
import { compactTemplateArgs, createDirectoryEvidence } from "../../serverOwned/workspace-routing.js";
import { taskHandleRefusal } from "../../serverOwned/search-support2.js";
import { uniqueExactMatchPaths } from "../../serverOwned/canonical-input3.js";
import { type StagedPostEditWindow, holdEchoAuthoredLines, shedPostEditWindowsToFit, editWireView, bookShippedPostEditWindows, attachAppliedReadback } from "../../serverOwned/edit-review2.js";
import { type StagedAuthoredLines, snapshotGoEditTargets, goPostEditReviewNote } from "../../serverOwned/edit-review.js";
import { firstDisallowedTextControlCharacter, textControlCharacterRefusal, artifactTextControlCharacterField, type ElisionMarkerField, contentHasElisionMarker, applyElidedEditAnchor, elidedContentRefusal, sliceShaForRange, artifactReplacementElisionField, resolveCreateSourceContent, MAX_CREATE_CONTENT_BYTES, createContentTooLargeRefusal, createTargetExistsRefusal, attachOrphanTailWarning } from "../../serverOwned/edit-anchor.js";
import { editedPathsOf, buildUnreadSiblingNote } from "../../serverOwned/task-pack-wire.js";
import { sessionLaneOf } from "../../serverOwned/task-binding2.js";
import { attachVerification } from "../../serverOwned/verification2.js";
import { BATCH_HINT_TEXT } from "../../serverOwned/artifact-csv2.js";

export interface dispatchEditPort {
  "args": Record<string, unknown>;
  "defaultResponseByteCeiling": number | undefined;
}
export async function dispatchEdit(port: dispatchEditPort): Promise<ToolCallResult | undefined> {
  const { args, defaultResponseByteCeiling } = port;

      // 2026-08-01: fail CLOSED on unknown arguments BEFORE any cwd/handle/
      // credential resolution or session-state mutation — see
      // editFileUnknownArgumentRefusal's doc comment for the measured incident.
      const unknownArgsRefusalEdit = editFileUnknownArgumentRefusal(args);
      if (unknownArgsRefusalEdit !== null) {
        const correction = typeof unknownArgsRefusalEdit["next"] === "string"
          ? unknownArgsRefusalEdit["next"] as string
          : typeof unknownArgsRefusalEdit["error"] === "string"
            ? unknownArgsRefusalEdit["error"] as string
            : `remove or correct ${String(unknownArgsRefusalEdit["field"] ?? "the unadvertised argument")}`;
        // This is only a refusal-ledger namespace, not an authorized workspace
        // resolution. Keep unknown-argument precedence and the write guard order
        // intact while isolating an explicitly named alternate worktree.
        const refusalWorkspace = typeof args["cwd"] === "string"
          ? path.resolve(activeRoot, args["cwd"])
          : activeRoot;
        const advisory = repeatedEditRefusalAdvisory(refusalWorkspace, args, correction);
        return toolStructuredError(advisory === undefined
          ? unknownArgsRefusalEdit
          : { ...unknownArgsRefusalEdit, detail: advisory });
      }
      // P1 (2026-10-10 review): an out-of-enum guard, a non-string
      // replacement or a string where a boolean decides the write refuses
      // here, before any cwd/handle resolution or write — see
      // editFileValueRefusal.
      const valueRefusalEdit = editFileValueRefusal(args);
      if (valueRefusalEdit !== null) return toolStructuredError(valueRefusalEdit);
      // 2026-10-19 (v016 decision 6t-3): the caller's edit as SENT, taken before
      // anything below rewrites an item in place. A fixable refusal re-issues
      // it corrected (`repairedEditBatchCall`), and TL_EFF_EDIT_DIET's echo
      // check compares the post-edit file with the text the caller sent
      // (`postEditEchoTexts`).
      const sentEditArgs = snapshotEditArgs(args);
      const editDiet = editDietEnabled();
      // B5.1: fail loud on an invalid/nonexistent cwd instead of silently
      // resolving against the pinned root (see checkCwdOrRefuse doc comment).
      // Stage 1 of the guard stack (write/guardedWorkspace.ts): its pass token
      // is what stage 2 below requires, and stage 2's token is what mints the
      // `GuardedWorkspaceRoot` every write entry point demands.
      const cwdGuardEdit = guardCwd(args, activeRoot);
      if (!cwdGuardEdit.ok) return toolStructuredError(cwdGuardEdit.refusal);
      // PI-09: task_handle validation happens BELOW, against the
      // GuardedWorkspaceRoot the stage-2 guard mints — a write case never
      // resolves its workspace through the unbranded resolver
      // (dispatchGuardConformance pins this), and the validation still runs
      // before any write decision.
      const cwdExplicit = isCwdExplicit(args["cwd"]);

      // D5/W1: a new path has no served-file anchor. Never let a raw
      // create:true guess the pinned/default workspace. The only cwd-less
      // carve-out is an existing capability already carried by this call:
      // every relevant handle must resolve to one and the same workspace.
      // Dispatch-incompatible shapes retain their established earlier/later
      // refusal conventions; this guard applies only to the real create arm.
      // C-6 (§1.3.1(2)): `allow_create` was DELETED from tl_edit_file's request
      // surface. It was a silent, unadvertised synonym for the advertised
      // `create` — the codebase's own words, searchReplaceEdit.spec.ts:139:
      // "(create:true), never the unadvertised engine-internal allow_create".
      // Advertising it would freeze a duplicate spelling of one capability
      // into v1 (the §3.4 E4 duplicate-authority class, and the thing D11
      // deletes the 12 aliases for); so the third state closes by removal, not
      // by declaration. The ENGINE option survives — searchReplaceEdit() still
      // takes `allow_create`, fed only from the advertised `create`. D11 then
      // deleted the search_replace_edit alias that used to advertise
      // `allow_create` on a schema of its own, so no request surface anywhere
      // spells the capability that way.
      const createDispatchRequested = (args["create"] === true)
        && args["artifact"] === undefined
        && args["intent"] === undefined
        && args["mode"] === undefined
        && !Array.isArray(args["edits"]);
      const createCapabilityHandleIds = [...new Set([
        ...(typeof args["handle"] === "string" ? [args["handle"]] : []),
        ...(typeof args["directoryHandle"] === "string" ? [args["directoryHandle"]] : []),
        ...(typeof args["from"] === "string" && handleTable.get(args["from"]) !== undefined ? [args["from"]] : []),
      ])];
      const createCapabilityEntries = createCapabilityHandleIds
        .map((id) => ({ id, entry: handleTable.get(id) }))
        .filter((item): item is { id: string; entry: HandleEntry } => item.entry !== undefined);
      const singleRootDefaultAvailable = otherActiveRoots(activeRoot).length === 0
        && nestedWorkspaceRoots(activeRoot).length === 0;
      const singleRootDefaultCreate = createDispatchRequested
        && !cwdExplicit
        && createCapabilityHandleIds.length === 0
        && singleRootDefaultAvailable;
      let batchCreateUsesServerDefault = false;
      if (
        createDispatchRequested
        && !cwdExplicit
        && createCapabilityHandleIds.length === 0
        && !singleRootDefaultCreate
      ) {
        // PI-07 / F-A1-5 unification: validated + capped through the same
        // workspace/candidates.ts check that workspaceCandidates() above and
        // every did_you_mean use (see checkCwdOrRefuse) also go through.
        const cwdCandidates = [
          { cwd: activeRoot, source: "server-default" },
          ...otherActiveRoots(activeRoot).map((cwd) => ({ cwd, source: "active-session" })),
          ...createCapabilityEntries.map(({ id, entry }) => ({
            cwd: entry.workspaceRoot,
            source: "handle",
            handle: id,
          })),
        ]
          .filter((candidate, index, all) =>
            all.findIndex((other) => other.cwd === candidate.cwd) === index)
          .filter((candidate) => isWorkspaceCandidateAccepted(candidate.cwd, activeRoot, configuredAllowedParents(activeRoot)))
          .slice(0, WORKSPACE_CANDIDATE_LIMIT);
        return toolStructuredError({
          ok: false,
          reason: "cwd-required-for-create",
          code: "cwd-required-for-create",
          applied: false,
          detail: "a create names a new path, so its workspace cannot be inferred from the server default; choose and pass the intended cwd explicitly or carry a single-root handle capability",
          cwd_candidates: cwdCandidates,
          next_call_is_template: true,
          next_call: {
            tool: "tl_edit_file",
            arguments: { ...compactTemplateArgs(args), cwd: "<absolute intended workspace cwd>" },
          },
        });
      }

      // Root-mismatch guard (2026-08-09): runs on the shared preamble, so
      // every sub-dispatch below — single edit, edits[] batch, intent, rename,
      // artifact zip, create — inherits it without its own copy, exactly the
      // way checkCwdOrRefuse and the D.1 handle block already do. Write-mode
      // only: on a read-only server tl_edit_file must keep reporting that writes
      // are disabled rather than a routing refusal for a write it would never
      // perform — the ALLOW_WRITE gate now lives inside guardWriteRouting, so
      // every write case inherits it identically. See workspaceRoutingRefusal.
      const routingGuardEdit = guardWriteRouting("tl_edit_file", args, cwdGuardEdit.pass);
      if (!routingGuardEdit.ok) return toolStructuredError(routingGuardEdit.refusal);

      // L1 (2026-08-07): how THIS call named the workspace it creates into.
      // Computed from exactly the two facts W1's cwd-required-for-create
      // refusal above keys on, so the pin exists precisely when that refusal
      // does not fire: an explicit cwd, or a handle capability the call
      // already carries. Undefined for every other shape (an
      // artifact/intent/rename dispatch, or a batch/single create with
      // neither an explicit cwd nor a capability handle) — those keep the
      // historical frontier verdict. Consumed ONLY by guardExecutionEdit's
      // create branch; the containment checks that actually bound the write
      // live in createFile.ts and are untouched.
      //
      // v0.14.1 defect 1 fix (2026-09-07): a canonical edits[] batch may mark
      // individual items create:true (mixed batches included) --
      // `createDispatchRequested` deliberately excludes
      // `Array.isArray(args["edits"])` (it also drives
      // singleRootDefaultCreate/batchCreateUsesServerDefault and the
      // cwd-required-for-create refusal above, none of which this fix
      // touches), so it never saw those. Detected independently and
      // consulted ONLY here, so a per-item create gets the SAME two pin
      // sources -- explicit cwd, or a handle capability -- as the legacy
      // single-target shape; singleRootDefaultCreate stays scoped to that
      // legacy shape, unchanged.
      const batchCreateItemRequested = Array.isArray(args["edits"])
        && args["edits"].some((edit) =>
          edit !== null && typeof edit === "object" && (edit as Record<string, unknown>)["create"] === true);
      const createWorkspacePin = (createDispatchRequested || batchCreateItemRequested)
        ? (cwdExplicit
            ? "explicit-cwd" as const
            : createCapabilityHandleIds.length > 0
              ? "handle-capability" as const
              : singleRootDefaultCreate
                ? "single-root-default" as const
                : undefined)
        : undefined;

      // B1: `workspace` is a `let` because a single-handle/batch/directory
      // handle mismatch may ADOPT the handle's own workspaceRoot (see below)
      // rather than refuse — the handle IS the workspace pin, validated at
      // mint time. Must be reassigned before any file I/O uses it. Every
      // reassignment goes through adoptGuardedWorkspaceRoot so the brand — and
      // with it the proof that both guards ran — survives adoption.
      let workspace: GuardedWorkspaceRoot =
        resolveGuardedWorkspaceRoot(args, activeRoot, routingGuardEdit.pass);
      // PI-09 — see the tl_read_file arm. Validated against the BRANDED root the
      // guard stack just minted (pre-adoption, matching the read path's
      // requested-cwd semantics), and still before any write decision, so a
      // stale/foreign handle can never contribute to one.
      const taskHandleRefusalEdit = taskHandleRefusal(args, workspace, "tl_edit_file");
      if (taskHandleRefusalEdit !== null) return toolStructuredError(taskHandleRefusalEdit);
      const artifactRequested = args["artifact"] !== undefined;
      const editCredential = artifactRequested
        ? resolveCredentialRef(args["credentialRef"])
        : { ok: true as const, credentialRef: undefined, password: undefined };
      if (!editCredential.ok) {
        return toolStructuredError(editCredential as unknown as Record<string, unknown>);
      }
      const outputCredentialSupplied = artifactRequested && args["outputCredentialRef"] !== undefined;
      const outputCredential = outputCredentialSupplied
        ? resolveCredentialRef(args["outputCredentialRef"])
        : { ok: true as const, credentialRef: undefined, password: undefined };
      if (!outputCredential.ok) {
        return toolStructuredError(outputCredential as unknown as Record<string, unknown>);
      }
      // Deliberately a plain `string`: this root only LOCATES the execution
      // fence, it never reaches a write entry point, so it must not carry the
      // guard brand around and blur what the brand certifies.
      let guardWorkspace: string = workspace;
      if (!cwdExplicit) {
        const fenceHandleIds = [
          ...(typeof args["handle"] === "string" ? [args["handle"]] : []),
          ...(Array.isArray(args["edits"])
            ? (args["edits"] as unknown[]).flatMap((edit) =>
                edit && typeof edit === "object" && typeof (edit as Record<string, unknown>)["handle"] === "string"
                  ? [(edit as Record<string, unknown>)["handle"] as string]
                  : [])
            : []),
        ];
        const fenceRoots = [...new Set(fenceHandleIds.flatMap((id) => {
          const entry = handleTable.get(id);
          return entry ? [entry.workspaceRoot] : [];
        }))];
        const fenceResolution = resolveHandleWorkspace(fenceRoots, cwdExplicit, workspace);
        // This root is only for locating the execution fence. Keep `workspace`
        // untouched so the established adoption/missing/mixed-batch checks below
        // retain their validation order and exact refusal semantics.
        if (fenceResolution.kind === "adopt") guardWorkspace = fenceResolution.workspace;
      }
      // EFF (TL_EFF_LENIENT_EDIT, default OFF): see uniqueExactMatchPaths.
      const uniqueMatchPaths = effLenientEditEnabled() ? uniqueExactMatchPaths(workspace, args) : undefined;
      const executionGuard = guardExecutionEdit(
        guardWorkspace,
        args,
        (handleId) => {
          const entry = handleTable.get(handleId);
          return entry !== undefined && entry.workspaceRoot === guardWorkspace && entry.path !== undefined && entry.path !== ""
            ? entry.path
            : undefined;
        },
        {
          ...(createWorkspacePin !== undefined ? { createWorkspacePin } : {}),
          ...(uniqueMatchPaths !== undefined && uniqueMatchPaths.size > 0 ? { uniqueMatchPaths } : {}),
          // FX-P1 (INV-I-2): the minting lane of each requested handle, read
          // from the same table (and the same workspace scoping) the path
          // resolver above uses. `undefined` for an unknown handle, a handle
          // from another workspace, or a lane-less mint — the gate admits all
          // three, so this can only ever refuse a handle that genuinely
          // crossed lanes.
          resolveHandleLane: (handleId: string) => {
            const entry = handleTable.get(handleId);
            return entry !== undefined && entry.workspaceRoot === guardWorkspace
              ? entry.lane
              : undefined;
          },
          // FX-Q2 (ruling (w), round-19A, 2026-09-03): the same handle's own
          // stored line range, from the SAME table/workspace scoping as the
          // lane resolver above. `undefined` for an unknown/foreign-workspace
          // handle (never consulted — the lane resolver already declined a
          // lane for those) or for a WHOLE-FILE handle, which simply has no
          // `range` on its entry.
          resolveHandleRange: (handleId: string) => {
            const entry = handleTable.get(handleId);
            return entry !== undefined && entry.workspaceRoot === guardWorkspace
              ? entry.range
              : undefined;
          },
        },
      );
      if (!executionGuard.allowed) return toolStructuredError(executionGuard.refusal);
      const pendingReclassification = executionGuard.reclassified;
      // FX-L soft frontier marker (user ruling 2026-09-14). Carried beside
      // `pendingReclassification`, never inside it: `recordExecutionEditResult`
      // treats a reclassification as a fence RE-TYPING (terminalAction ->
      // "edit", phase -> "verifying"), and an advisory landing-site disclosure
      // must not trigger that.
      const pendingFrontierMarker = executionGuard.frontierMarker;
      const pendingCreateAuthorization = executionGuard.createAuthorization;
      const wantReview = args["review"] === true;
      // One-shot edits[] batching hint (see recordSingleEditCompletion doc in
      // util/session.ts): stays true through the plain single-edit dispatch
      // paths below (search/replace, handle+content, target=all, pathless,
      // symbol+search). Flipped false at the top of the intent/rename/
      // edits[]-batch/create branches below — those completions are not
      // poolable into an edits[] call, so they must not count toward the
      // threshold.
      let singleEditForHint = true;
      // R2-PEW (review P0-1): the wide post-edit windows `attachAppliedReadback`
      // built for THIS call, staged for `bookShippedPostEditWindows` in
      // `finishEdit` — see that function. Per call, never shared: a window is
      // booked only from the response it shipped on.
      const stagedPostEditWindows = new Map<string, StagedPostEditWindow>();
      // TL_EFF_EDIT_DIET: the caller-authored lines of each echo entry (no
      // window shipped for it), held by `finishEdit` — see
      // `holdServerEditAuthoredLines`.
      const stagedAuthoredLines = new Map<string, StagedAuthoredLines>();

      // -----------------------------------------------------------------------
      // D.1 Handle resolution: resolve handle BEFORE any sub-dispatch.
      // When a handle is supplied, override path/symbol/range from the entry.
      // On failure, return a structured error immediately.
      // -----------------------------------------------------------------------
      let handleId = typeof args["handle"] === "string" ? args["handle"] : null;
      let handlePath: string | undefined;
      let handleSymbol: string | undefined;
      let handleRange: string | undefined;
      // INV-I-5 (FX-P2): true iff a stale/unknown `handle` was dropped in
      // favor of `path`+`search` under `allowPathFallback:true`, immediately
      // below. Threaded to the eventual success response so `applied[]` can
      // additively disclose that this edit did not land through the handle
      // it was addressed by (see the two success sites further down this
      // dispatch that spread `path_fallback` onto the result).
      let pathFallbackApplied = false;

      if (handleId) {
        const entry = handleTable.get(handleId);
        if (!entry) {
          // Historically an unconditional refusal regardless of
          // `allowPathFallback` — INV-I-5's own live repro: "Unknown/foreign
          // handle ... both refuse handle-unknown immediately ... the flag
          // has zero effect here". The flag's own schema description
          // ("Fallback to path if handle fails") says this IS exactly the
          // case it should govern. Fix: when the caller opted in
          // (`allowPathFallback:true`, never the default/omitted case — that
          // keeps "false must refuse as today" for both spellings) and also
          // supplied a plain path+search/replace shape, drop the dead handle
          // and let `handleId` fall through as null. Every branch below this
          // point already treats a null `handleId` as an ordinary bare-path
          // edit — the plain single-file search/replace dispatch further
          // down — so this call now goes through the EXACT SAME
          // enforcePreconditions call, execution-typestate admissibility
          // fence, and uniqueness/auto-mint logic a caller who never
          // mentioned a handle would hit. It "applies exactly once" because
          // that downstream logic already requires the search to match
          // exactly once before it writes anything; a non-unique or
          // zero-match search still refuses (ambiguous/not-found/
          // handle-required), same as any other path edit — never a bypass.
          if (
            args["allowPathFallback"] === true
            && typeof args["path"] === "string" && args["path"] !== ""
            && typeof args["search"] === "string" && args["search"] !== ""
          ) {
            handleId = null;
            pathFallbackApplied = true;
          } else {
            // 2026-10-19 (v016 decision 6t-3): the item also carries its own
            // path and a search/replace, so the corrected call exists — the
            // path form `allowPathFallback:true` takes — and the refusal names
            // it instead of sending the caller back to a whole new task pack.
            const pathForm = Array.isArray(sentEditArgs["edits"]) ? undefined : pathFormOfEditItem(sentEditArgs);
            if (pathForm !== undefined) {
              return toolStructuredError({
                ok: false,
                reason: "handle-unknown",
                field: "handle",
                detail: "this handle is not one this server holds (stale, or minted by another session); nothing was written — next re-issues this edit by its own path, where the search must still match exactly once",
                retry: "call",
                next: canonicalToolCall("tl_edit_file", pathForm),
              });
            }
            return toolStructuredError({ ok: false, reason: "handle-unknown" });
          }
        } else if (entry.workspaceRoot !== workspace) {
          if (!cwdExplicit) {
            // B1: cwd omitted — adopt the handle's own workspace. H2: refuse
            // if the worktree it was minted in no longer exists.
            const res = resolveHandleWorkspace([entry.workspaceRoot], cwdExplicit, workspace);
            if (res.kind === "missing") {
              return toolStructuredError({
                ok: false,
                reason: "handle-workspace-missing",
                handle: handleId,
                handleWorkspace: res.handleWorkspace,
                detail: handleWorkspaceMissingDetail(res.handleWorkspace),
              });
            }
            if (res.kind === "adopt") workspace = adoptGuardedWorkspaceRoot(res.workspace, workspace);
          } else {
            // B2: explicit conflicting cwd — refuse with an enriched payload.
            return toolStructuredError({
              ok: false,
              reason: "handle-workspace-mismatch",
              handle: handleId,
              handleWorkspace: entry.workspaceRoot,
              detail: `retry with cwd=${entry.workspaceRoot} or omit cwd`,
            });
          }
        }
        // `entry` is undefined here only when the `!entry` branch above took
        // the path-fallback arm (handleId is now null in that case) — every
        // other arm either returned or left `entry` defined.
        if (entry !== undefined) {
          handlePath = entry.path;
          handleSymbol = entry.symbol;
          handleRange = entry.range;
        }
      }

      // Effective path: explicit arg takes precedence only when handle was not provided;
      // when handle was provided, the handle's path overrides.
      const filePath = String(handleId
        ? (handlePath ?? args["path"] ?? "")
        : (args["path"] ?? ""));

      const artifactArg = args["artifact"];
      const artifactKind = artifactArg !== null && typeof artifactArg === "object" && !Array.isArray(artifactArg)
        ? String((artifactArg as Record<string, unknown>)["kind"] ?? "")
        : "";
      const lowerFilePath = filePath.toLowerCase();
      const isBinaryDocumentPath = /\.(docx|xlsx|pptx|pdf)$/.test(lowerFilePath);
      const isWritableZipRequest = artifactKind === "zip" && lowerFilePath.endsWith(".zip");

      // DESIGN-v0.15 §8.2 (R7 Part B): both branches below already refuse a
      // zip/Office edit target under code surface as a side effect (`artifact`
      // is unreachable, so `isWritableZipRequest`/`artifactRequested` are
      // always false there) — but their messages point at `artifact={...}`,
      // an input this surface never advertises. Give the surface-specific
      // reason first so the refusal is honest about why.
      if ((splitArchiveVirtualPath(filePath) || isSupportedArchivePath(filePath) || isBinaryDocumentPath)) {
        const editArchiveSurfaceRefusal = officeOrArchiveSurfaceRefusal();
        if (editArchiveSurfaceRefusal !== undefined) {
          return toolStructuredError({ ok: false, code: editArchiveSurfaceRefusal.code, path: filePath, error: editArchiveSurfaceRefusal.error });
        }
      }
      if (splitArchiveVirtualPath(filePath) || (isSupportedArchivePath(filePath) && !isWritableZipRequest)) {
        return toolStructuredError({
          ok: false,
          reason: "archive-member-read-only",
          code: "archive-member-read-only",
          path: filePath,
          detail: "archive containers and members are read-only; edit the source file outside the archive",
        });
      }
      if (isBinaryDocumentPath && !artifactRequested) {
        return toolStructuredError({
          ok: false,
          reason: "artifact-edit-required",
          code: "artifact-edit-required",
          path: filePath,
          detail: "pass artifact={kind:..., ...} and credentialRef when the document is password-protected",
        });
      }
      if (Array.isArray(args["edits"])) {
        for (const rawEdit of args["edits"] as unknown[]) {
          if (!rawEdit || typeof rawEdit !== "object") continue;
          const edit = rawEdit as Record<string, unknown>;
          const editHandle = typeof edit["handle"] === "string" ? handleTable.get(edit["handle"]) : undefined;
          const editPath = String(editHandle?.path ?? edit["path"] ?? "");
          if (splitArchiveVirtualPath(editPath) || isSupportedArchivePath(editPath)) {
            // DESIGN-v0.15 §8.2 (R7 Part B): per-item variant of the file-level
            // gate above — a batch `edits[]` entry can target a different
            // path than `filePath`.
            const perEditArchiveSurfaceRefusal = officeOrArchiveSurfaceRefusal();
            if (perEditArchiveSurfaceRefusal !== undefined) {
              return toolStructuredError({ ok: false, code: perEditArchiveSurfaceRefusal.code, path: editPath, error: perEditArchiveSurfaceRefusal.error });
            }
            return toolStructuredError({
              ok: false,
              reason: "archive-member-read-only",
              code: "archive-member-read-only",
              path: editPath,
              detail: "use one top-level tl_edit_file artifact={kind:\"zip\",members:[...]} call for a ZIP copy-on-write edit",
            });
          }
          if (/\.(docx|xlsx|pptx|pdf)$/i.test(editPath)) {
            return toolStructuredError({
              ok: false,
              reason: "artifact-edit-required",
              code: "artifact-edit-required",
              path: editPath,
              detail: "binary document edits cannot be mixed into edits[]; use one top-level artifact edit",
            });
          }
        }
      }

      // D.2 Compute effectivePath for precondition checks.
      const effectivePath = filePath;

      // W7: all text-bearing write arguments are rejected before any write
      // route can reach its engine. NUL and every other C0/C1 control character
      // except LF/TAB/CR are invalid text; ZIP sourcePath stays binary-by-reference.
      const topLevelControlCharacter = firstDisallowedTextControlCharacter([
        ["content", args["content"]],
        ["replace", args["replace"]],
        ["search", args["search"]],
        ["target", args["target"]],
        ["to", args["to"]],
      ]);
      if (topLevelControlCharacter !== undefined) {
        return toolStructuredError(textControlCharacterRefusal(topLevelControlCharacter));
      }
      const artifactControlCharacter = artifactTextControlCharacterField(args["artifact"]);
      if (artifactControlCharacter !== undefined) {
        return toolStructuredError(textControlCharacterRefusal(artifactControlCharacter));
      }
      if (Array.isArray(args["edits"])) {
        for (const [index, rawEdit] of (args["edits"] as unknown[]).entries()) {
          if (rawEdit === null || typeof rawEdit !== "object" || Array.isArray(rawEdit)) continue;
          const entry = rawEdit as Record<string, unknown>;
          const entryControlCharacter = firstDisallowedTextControlCharacter([
            [`edits[${index}].content`, entry["content"]],
            [`edits[${index}].replace`, entry["replace"]],
            [`edits[${index}].search`, entry["search"]],
          ], index);
          if (entryControlCharacter !== undefined) {
            return toolStructuredError(textControlCharacterRefusal(entryControlCharacter));
          }
        }
      }

      // item 10 (companion to W1's scanner fix): refuse any single-edit path
      // whose agent-supplied top-level `content` (range-replace / create) or
      // `replace` (exact / target=all / symbol+search / pathless) text carries
      // an elision marker from a compressed read — pasting it back would write
      // the marker into the file, deleting what it stood for. The edits[] batch
      // has its OWN per-item guard (its content/replace are nested, not
      // top-level). Matches the exact marker shape only, so prose containing the
      // literal words "doc elided" is acceptable collateral (documented).
      const topLevelElisionField: ElisionMarkerField | undefined =
        contentHasElisionMarker(args["content"]) ? "content"
          : contentHasElisionMarker(args["replace"]) ? "replace"
            : contentHasElisionMarker(args["search"]) ? "search"
              : contentHasElisionMarker(args["target"]) ? "target"
                : undefined;
      if (topLevelElisionField !== undefined) {
        // FX-OH F4: a marker in `search` is a LOCATING problem, and this server
        // holds the file being located against. Resolve it; refuse only when
        // the anchor is genuinely ambiguous (see resolveElidedEditAnchor).
        const resolvedTopLevelAnchor = topLevelElisionField === "search" || topLevelElisionField === "replace"
          ? await applyElidedEditAnchor(args, filePath, workspace)
          : false;
        if (!resolvedTopLevelAnchor) {
          return toolStructuredError(elidedContentRefusal({
            field: topLevelElisionField,
            path: filePath || undefined,
            range: handleRange,
          }));
        }
      }

      // P0 (evidence: bench run 2026-07-12a2 — a live agent
      // passed `content` where it meant `replace`). `content` is ONLY ever
      // consumed by create:true (search absent there) and the handle+range
      // no-search branch below (`args["search"] === undefined` is part of
      // ITS OWN guard condition) — every search/replace dispatch branch
      // below (fallback exact edit, target=all, pathless, symbol+search)
      // reads only args["search"]/args["replace"] and never args["content"].
      // So a single-edit call pairing `search` with `content` used to have
      // `content` silently DROPPED, `replace` default to "", and the
      // matched `search` text deleted — live repro wiped a whole file to 0
      // bytes. Reject before any branch below can mutate. Same two message
      // constants are reused by the edits[] per-item guard further down so
      // both surfaces teach the identical fix.
      const SEARCH_CONTENT_CONFLICT_MSG =
        "content is for create:true or handle+content range replacement; for search-based edits use replace — did you mean replace?";
      // Companion guard: `search` with neither `replace` nor `content` used
      // to silently default replace to "" (delete the matched text) with no
      // signal the caller meant that. Audited (2026-07-12a2): every
      // search:-bearing call across this package's specs and the replay
      // corpus also passes replace (including explicit replace:"" for
      // intentional deletion, which stays valid and does not hit this
      // guard) — nothing relies on the omitted-replace default, so it is
      // now a hard error instead of a silent delete.
      const SEARCH_NEEDS_REPLACE_MSG =
        "search requires replace — pass replace (use replace:\"\" to delete the matched text)";
      if (args["search"] !== undefined && args["content"] !== undefined) {
        return toolError(SEARCH_CONTENT_CONFLICT_MSG, { code: "invalid-input" });
      }
      if (args["search"] !== undefined && args["replace"] === undefined && args["content"] === undefined) {
        return toolError(SEARCH_NEEDS_REPLACE_MSG, { code: "invalid-input" });
      }

      // 2026-08-01 incident wave item 3: shared by the single-edit path and
      // the edits[] batch mirror below. The OLD text ("pass its handle with
      // content for a full-body replacement") never said the replacement
      // covers the handle's ENTIRE range — the incident caller believed a
      // top-level range would scope it. Say so, and point at the edits[]
      // anchor item for partial replacements.
      const FILE_EXISTS_FULL_BODY_MSG =
        "file exists — passing its handle with content replaces the handle's ENTIRE range (the whole file for a file or 1-EOF range handle); to replace only specific lines use edits:[{handle, range:\"N-M\", content}]; or use search/replace; create:true is only for new files";

      // IL-W5 (DESIGN-v0.15-sf-intent-layers.md §11.2(1)): the auto-resolve
      // predicate for a bare `{path, content}` full-body edit — true only
      // when this LANE demonstrably already holds the file's FULL current
      // body. Two independent, PRECISE signals (never the coarse per-path
      // `editPathResidency` ledger — see `isHandleShippedInThisLane`'s doc
      // comment for the measured regression that check produces):
      //   (A) `servedRangeCoverage(...).complete` — the served-range ledger
      //       proves every line 1..N was actually put on the wire (a
      //       `content:"full"` read `bookFullFileExpansionServe`s the whole
      //       span, or several range/slice reads happen to union to it);
      //   (B) the canonical whole-file `{kind:"file", path, sha:<current>}`
      //       handle — the SAME id a `create:true` mint or a task_pack
      //       whole-file surface already minted, resolved via
      //       `handleTable.upsert` rather than invented — is itself marked
      //       `"shipped"` (never a DIFFERENT handle's or the bare path's
      //       residency).
      // `currentContent` is the caller's own pre-fetched `readFileSafeOpt`
      // result (never re-read here).
      function hasFullBodyResidencyForAutoResolve(
        workspaceRoot: string,
        path: string,
        currentContent: string,
      ): boolean {
        const sha = shaOfText(currentContent);
        const totalLines = countLines(currentContent);
        const coverage = servedRangeCoverage(workspaceRoot, path, sha, totalLines);
        if (coverage !== undefined && coverage.complete) return true;
        const wholeFileHandle = handleTable.upsert({ kind: "file", path, workspaceRoot, sha });
        return isHandleShippedInThisLane(workspaceRoot, wholeFileHandle.id);
      }

      // IL-W5 (DESIGN-v0.15-sf-intent-layers.md §11.2(2)/(3)): the executable
      // recovery every `write-intent-ambiguous` refusal carries, built via
      // `canonicalToolCall` (so `cwd`/`task.handle` inherit automatically —
      // envelope.ts's `attributedContinuationArguments`) rather than the
      // legacy `mode`-keyed shape. Presence of `next` here is also what keeps
      // `supplyRefusalGuidance` (util/attachSupply.ts) from decorating this
      // refusal with its own last-resort `alternatives:[{mode:"task_pack"}]`
      // menu — that fallback only fires when a refusal carries NEITHER
      // `next` nor `alternatives` already.
      //
      // Unserved (nothing in `servedRangeCoverage` for this path/sha, or the
      // file could not be re-read): a plain whole-file `content:"full"` read.
      // Partially served (this lane holds SOME of the file, per the same
      // served-range ledger `tl_read_file`'s own capped-serve recovery already
      // reads — see the `coverage.unserved` sites above): the SAME shape
      // scoped to exactly the `unserved` windows, so the round trip this
      // refusal buys back never re-fetches bytes the caller already has.
      function writeIntentAmbiguousRecoveryNext(
        workspaceRoot: string,
        path: string,
        currentContent: string | null,
      ): ToolCall {
        if (currentContent !== null) {
          const sha = shaOfText(currentContent);
          const totalLines = countLines(currentContent);
          const coverage = servedRangeCoverage(workspaceRoot, path, sha, totalLines);
          if (coverage !== undefined && !coverage.complete && coverage.unserved.length > 0) {
            return canonicalToolCall("tl_read_file", { targets: [{ path, ranges: coverage.unserved }], content: "auto" });
          }
        }
        return canonicalToolCall("tl_read_file", { targets: [{ path }], content: "full" });
      }

      // -----------------------------------------------------------------------
      // D.4 Helper: augment a successful result with handle + post-edit sha
      // when the edit was driven by a handle. Also records a handle-backed edit
      // in session state so the full-read governor can refill its budget.
      // -----------------------------------------------------------------------
      async function withHandleAugment(result: Record<string, unknown>): Promise<Record<string, unknown>> {
        if (!handleId) return result;
        const ok = (result as { ok?: boolean }).ok;
        if (ok === false) return result;
        // Record a handle-backed edit so the governor can decay fullExpansionsTotal.
        recordHandleEdit(workspace);
        // Read post-edit file to compute new sha.
        // Handle nested readAndEdit shape: { ok: true, context, edit: { path, ... } }
        const nestedEdit = (result as { edit?: { path?: string } }).edit;
        const postPath = nestedEdit?.path ?? (result as { path?: string }).path ?? effectivePath;
        const binaryPostPath = /\.(docx|xlsx|pptx|pdf|zip)$/i.test(postPath);
        // served-bytes: not-served (post-edit sha refresh: shaOfText/shaOfBytes only, no body)
        const postContent = binaryPostPath ? null : await readFileSafe(postPath, workspace);
        // served-bytes: not-served (post-edit sha refresh: shaOfBytes only, no body)
        const postBytes = binaryPostPath ? await readBytesSafe(postPath, workspace) : null;
        const postSha = postBytes !== null
          ? shaOfBytes(postBytes)
          : postContent !== null
            ? shaOfText(postContent)
            : undefined;
        // DESIGN-v0.8 B3.3: re-key the driving handle to the post-edit sha
        // (handleTable.refreshSha, not a field mutation — see its doc
        // comment for why canonicalKey requires a re-key). Only when a sha
        // was actually computed above; a read failure leaves the handle
        // untouched rather than refreshing it to a bogus/absent sha.
        //
        // Range-shift: `result.lines` (present on any range-scoped edit
        // result — replaceRangeContent/replaceAllInRange) is the POST-edit
        // line span the edit's own replacement now occupies. Only pass it as
        // the handle's new range when the driving handle actually HAD a
        // range to begin with (a plain file/symbol-without-range handle has
        // nothing to shift) — normalized to "start-end" since formatLines
        // returns a bare number when start===end but HandleEntry.range is
        // always the two-sided "start-end" form.
        if (postSha !== undefined) {
          const drivingEntry = handleTable.get(handleId);
          const resultLines = typeof (result as { lines?: unknown }).lines === "string"
            ? (result as { lines: string }).lines
            : undefined;
          const isRangeBearing = drivingEntry?.range !== undefined;
          const newRange = isRangeBearing && resultLines !== undefined
            ? (resultLines.includes("-") ? resultLines : `${resultLines}-${resultLines}`)
            : undefined;
          // H4: a range/symbol handle's stored sha is the sha of its CONTENT
          // SLICE (HandleEntry.sha contract, handles.ts), NOT the whole file —
          // it was minted that way by resolveSlice. Refreshing it to the
          // whole-file `postSha` breaks that contract, so a post-edit re-read
          // of the same symbol (which hashes the slice again in resolveSlice)
          // would NOT dedupe to this id and would mint a duplicate. Recompute
          // the slice sha the SAME way the re-read will:
          //   - kind:"symbol" → getSymbolWithContext over the post-edit content
          //     (sha over data.code incl. scopeHeader, range = the symbol's
          //     recomputed span) so a re-read via resolveSlice dedupes exactly;
          //   - plain kind:"range" → the "start-end" line slice.
          // whole-file/file-kind handles (no range) keep the whole-file postSha.
          let refreshSha = postSha;
          let refreshRange = newRange;
          if (isRangeBearing && postContent !== null && drivingEntry !== undefined) {
            if (drivingEntry.kind === "symbol" && drivingEntry.symbol) {
              const symResult = await getSymbolWithContext(postContent, {
                path: postPath,
                symbol: drivingEntry.symbol,
              });
              if (symResult.ok) {
                refreshSha = shaOfText(symResult.data.code);
                refreshRange = `${symResult.data.range.start}-${symResult.data.range.end}`;
              } else {
                // Symbol no longer resolvable post-edit — fall back to the
                // line-slice sha over the (possibly shifted) range so at least
                // the stored sha reflects real slice content, not the whole file.
                const r = newRange ?? drivingEntry.range;
                refreshSha = (r !== undefined ? sliceShaForRange(postContent, r) : undefined) ?? postSha;
              }
            } else {
              const r = newRange ?? drivingEntry.range;
              refreshSha = (r !== undefined ? sliceShaForRange(postContent, r) : undefined) ?? postSha;
            }
          }
          handleTable.refreshSha(handleId, refreshSha, refreshRange);
        }
        // C10.1: shorten the sha in the RESPONSE only; the full sha above is
        // never stored anywhere from this function (no handleTable write
        // happens here), so there is nothing to keep full for.
        return {
          ...result,
          handle: handleId,
          ...(postSha !== undefined ? { sha: shortSha(postSha) } : {}),
        };
      }

      // Attach review object to a successful write result when review:true.
      async function withReview(result: Record<string, unknown>): Promise<Record<string, unknown>> {
        if (!wantReview) return result;
        // applyEditsMulti returns `files: EditFileResult[]` (each {path,lines,delta,handle},
        // NO per-item `ok` on the happy path); an older draft read `results`, which is never
        // present, so `isBatch` was always false and review.touched stayed empty for real
        // batches. Read `files` (keep `results` as a defensive fallback). Per-entry success is
        // `ok !== false` since the happy-path entries carry no `ok` field.
        type BatchEntry = { ok?: boolean; path?: string };
        type BatchResult = { files?: BatchEntry[]; results?: BatchEntry[] };
        const batchR = result as BatchResult;
        const batchEntries = batchR.files ?? batchR.results;
        const isBatch = Array.isArray(batchEntries);
        const allOk = isBatch
          ? (batchEntries ?? []).every((r) => r.ok !== false)
          : (result as { ok?: boolean }).ok === true;
        if (!allOk) return result;

        const touchedPaths: string[] = isBatch
          ? (batchEntries ?? []).filter((r) => r.ok !== false && r.path).map((r) => r.path as string)
          : ((result as { path?: string }).path ? [(result as { path?: string }).path as string] : []);

        const touched = [...new Set(touchedPaths)].map((p) => ({ path: p, surface: classifySurface(p) }));
        const touchedSurfaces = new Set(touched.map((t) => t.surface));

        const rawToken = typeof args["search"] === "string" ? args["search"]
          : typeof args["from"] === "string" ? args["from"] : "";
        const allCapsMatch = rawToken.match(/\b([A-Z_]{2,})\b/);
        const distinctiveToken = allCapsMatch ? allCapsMatch[1]! : null;

        let possibleMissingSurfaces: string[] = [];
        let confidence: number;

        if (distinctiveToken) {
          const variants = deriveTokenVariants(distinctiveToken).slice(0, 3);
          const touchedPathSet = new Set(touchedPaths);
          const missingSurfaces = new Set<string>();
          for (const variant of variants) {
            const found = findText({ query: variant }, workspace);
            for (const m of found.matches) {
              if (!touchedPathSet.has(m.path)) {
                const surf = classifySurface(m.path);
                if (!touchedSurfaces.has(surf)) missingSurfaces.add(surf);
              }
            }
            if (missingSurfaces.size >= 4) break;
          }
          possibleMissingSurfaces = [...missingSurfaces].sort().slice(0, 4);
          const missing = possibleMissingSurfaces.length;
          const total = touched.length + missing;
          confidence = total === 0 ? 0.8 : Math.max(0, Math.min(1, 1 - missing / total));
          if (missing >= 2) confidence = Math.min(confidence, 0.4);
        } else {
          confidence = 0.5;
        }

        if (possibleMissingSurfaces.length === 0) confidence = 0.8;

        const r = result as { path?: string; lines?: unknown; delta?: unknown };
        const diffLine = `@@ ${r.path ?? touchedPaths.join(",")} ${r.lines ?? ""} ${r.delta ?? ""}`.trimEnd();
        const compactDiff = diffLine.length > 120 ? diffLine.slice(0, 120) : diffLine;

        let review: Record<string, unknown> = { touched, possibleMissingSurfaces, confidence, compactDiff };
        while (Buffer.byteLength(JSON.stringify(review), "utf8") > 512 && possibleMissingSurfaces.length > 0) {
          possibleMissingSurfaces = possibleMissingSurfaces.slice(0, -1);
          review = { touched, possibleMissingSurfaces, confidence, compactDiff };
        }
        return { ...result, review };
      }

      // R1 (2026-10-22, codex-copilot-proxy r18 T07): the Go files this call addresses, as they are before
      // any branch below writes (see snapshotGoEditTargets); read again in augmentEdit.
      const goReviewSnapshot = snapshotGoEditTargets(workspace, args);

      // Single closure-attach choke point for every edit_code SUCCESS return.
      // Wraps the (already handle-/review-/orphan-augmented) result and, when the
      // session holds token-bearing task_pack checks, appends a compact `closure`
      // reminder of still-open checks so the solver self-corrects before declaring
      // done (DESIGN-v0.8, see closureTracking.ts). No-ops on failures and on
      // non-pack workflows — zero added bytes there.
      async function finishEdit(
        result: Record<string, unknown> | Promise<Record<string, unknown>>,
      ): Promise<Record<string, unknown>> {
        const resolved = await result;
        // C2-5 / §4.2.1: the workspace this write resolved against, published
        // for `SideEffectCore.workspace`. Taken HERE and not at `workspace`'s
        // binding site because that binding is a `let` — a handle mismatch may
        // make the call ADOPT the handle's own mint root — and a marker minted
        // against a tree the write never touched would bind the report to the
        // wrong state, which is the 2026-08-09 root-mismatch class.
        noteWorkspaceRoot(workspace);
        try {
          const augmented = await augmentEdit(resolved);
          // TL_EFF_EDIT_DIET: an echo file carries no window for the shed
          // below to drop, so the lines its caller wrote are held as soon as
          // the reply is built (once: the call empties the staging map).
          holdEchoAuthoredLines(workspace, stagedAuthoredLines);
          // PEW (v0.15.0) requirement 3: the caller/host ceiling `dispatchTool`
          // already resolved once per call — `after` is the first thing shed
          // against it, computed HERE (last) so the kit/closure augmentEdit
          // just attached are already at their real, final size. Isolated in
          // its OWN try/catch: a bug in the shed must lose only the shed,
          // never fall all the way back to the pre-augmentation `resolved`.
          let shipped = augmented;
          try {
            shipped = shedPostEditWindowsToFit(
              augmented,
              defaultResponseByteCeiling,
              (candidate) => editWireView(candidate, workspace),
            );
          } catch {
            shipped = augmented;
          }
          // R2-PEW (review P0-1): the ledger is booked from what SHIPS — after
          // the shed above, never from the windows augmentEdit merely built.
          bookShippedPostEditWindows(workspace, shipped, stagedPostEditWindows);
          return shipped;
        } catch {
          // The edit landed either way; an echo file must still leave its
          // pre-edit served-range entry behind (best-effort, like the booking;
          // a no-op when the hold above already ran).
          holdEchoAuthoredLines(workspace, stagedAuthoredLines);
          // §4.2.1, THE CARDINAL RULE. Everything below this line is
          // BOOKKEEPING that runs AFTER the bytes are on disk: the fence
          // ledger, the sibling scan, the post-edit read-back, the closure and
          // verification kits. An exception in any of it used to propagate to
          // `callTool`'s JSON-RPC catch and emit a contentless -32603 — the
          // caller told that nothing happened about a batch that already
          // landed, with the only record of what happened thrown away. The
          // emitter's own result is returned instead: less well-appointed,
          // still true, still the right `kind`.
          return resolved;
        }
      }

      async function augmentEdit(
        resolved: Record<string, unknown>,
      ): Promise<Record<string, unknown>> {
        const editOk = (resolved as { ok?: boolean }).ok !== false;
        const editWasPrepared = getExecutionFence(workspace)?.phase === "prepared";
        // C5: hoisted above recordExecutionEditResult so the fence's demand
        // ledger is discharged by the PATHS this edit actually wrote — handle
        // identity is not stable across re-minting (2026-08-02 T05c rep0 idx
        // 149 landed the demanded batch through fresh handles and was still
        // told "unchanged since previous refusal"). Reused verbatim by the
        // unread-sibling note below.
        const editedNow = editOk ? editedPathsOf(resolved, effectivePath) : [];
        recordExecutionEditResult(workspace, editOk, editedNow, pendingReclassification);

        // A1-pre (TL_REASONING_IR_V2, class (B), default OFF): the edit-side
        // half of the V11-04 obligation-closure gap (DESIGN-v0.12-plan.md §2
        // row A1-pre). The task_pack seam only ever ADDS obligations — a
        // re-served surface is not proof anything changed — so nothing on the
        // read side may transition one to "satisfied". `editedNow` above is
        // the one thing the server can actually prove: paths tl_edit_file just
        // wrote. `fence.epochQuery` recomputes the SAME taskRef the task_pack
        // call that opened this certificate used: that call's own seam site
        // (above, in the task_pack branch) never passes an explicit `taskId`,
        // and `buildTaskPack`'s own result never sets `.qref` itself (only
        // server.ts's post-seam `supplied.qref` reassignment does, AFTER the
        // seam already ran) — so `deriveIrTaskRef` fell through to hashing
        // the query alone. Recomputing with `taskQueryRef` here (workspace-
        // bound, dash-prefixed) would silently mismatch that and land on an
        // empty/foreign IR record; `deriveIrTaskRef({ query })` is the exact
        // same function call the pack seam made, so it reproduces the SAME
        // identity by construction rather than by coincidence. No fence, or
        // an empty epochQuery, means no provable correlation and the seam is
        // skipped entirely. No wire field, no new kind, same total try/catch
        // posture as the pack seam.
        if (reasoningIrV2Enabled() && editOk && editedNow.length > 0) {
          const epochQuery = getExecutionFence(workspace)?.epochQuery;
          if (epochQuery !== undefined && epochQuery !== "") {
            recordReasoningIrV2ClosureFromEdit({
              workspaceRoot: workspace,
              lane: sessionLaneOf(args as Record<string, unknown>),
              taskId: deriveIrTaskRef({ query: epochQuery }),
              editedPaths: editedNow,
            });
          }
        }

        // Feature 1 (2026-07-12b2): one-shot unread-sibling note, checked on
        // the session's FIRST successful edit (editedPaths transitioning
        // from empty — recordEditedPath below is this session's only
        // writer). Fires for both single edits and edits[] batches; note
        // text itself is additionally gated (inside buildUnreadSiblingNote)
        // on the session's concern-token set being non-empty. The
        // one-shot flag is marked on this transition regardless of outcome,
        // so a later edit never re-attempts the scan.
        let unreadNote: string | undefined;
        if (editOk) {
          if (editedNow.length > 0) {
            const isFirstEdit = getEditedPaths(workspace).length === 0;
            for (const p of editedNow) recordEditedPath(workspace, p);
            // 2026-07-16a re-read-loop forensics: also gated on !isClosureSatisfied — if the
            // session's closure ledger was already certified complete BEFORE
            // this (session-first) edit landed, sending the agent to go
            // scan for an "unread" sibling file re-arms the exact re-read
            // spiral this flag exists to prevent. See buildConcernNote
            // (readCodeModes.ts) for the sibling gate on the read side.
            // A prepared fence already proved and bounded the edit frontier.
            // Re-opening discovery with a lexical sibling hint after that edit
            // contradicts the execution contract and caused the measured
            // comment-only unread_note regression.
            if (isFirstEdit && !editWasPrepared && !hasUnreadSiblingNoteFired(workspace) && !isClosureSatisfied(workspace)) {
              markUnreadSiblingNoteFired(workspace);
              unreadNote = await buildUnreadSiblingNote(workspace, editedNow, args);
            }
          }
        }
        const withReclassification = editOk && pendingReclassification !== undefined
          ? { ...resolved, reclassified: pendingReclassification }
          : resolved;
        // FX-L soft frontier marker (user ruling 2026-09-14): an internal
        // carrier only — `protocol/editFamily.ts`'s `projectApplied` folds it
        // into `reclassification.frontier_status` (once, top level) and
        // `applied[].frontier_status` (per marked file) and DELETES this key,
        // so it never reaches the wire under this spelling.
        const withFrontierMarker = editOk && pendingFrontierMarker !== undefined
          ? { ...withReclassification, frontier_marker: pendingFrontierMarker }
          : withReclassification;
        const withUnreadNote = unreadNote !== undefined
          ? { ...withFrontierMarker, unread_note: unreadNote }
          : withFrontierMarker;
        // R1: an edit that changed a Go function above a final write its return still reads, and left
        // that write alone, says so (goPostEditReview); it may ride beside `unread_note`.
        const reviewNote = editOk && goReviewSnapshot.size > 0
          ? await goPostEditReviewNote(workspace, goReviewSnapshot, editedNow)
          : undefined;
        const withReviewNote = reviewNote !== undefined
          ? { ...withUnreadNote, review_note: reviewNote }
          : withUnreadNote;
        const withApplied = editOk
          ? await attachAppliedReadback(withReviewNote, args, workspace, stagedPostEditWindows, editDiet ? sentEditArgs : undefined, stagedAuthoredLines)
          : withReviewNote;
        // L1: a create admitted by its own workspace pin says so, in the same
        // `create_target` shape the read side already uses for a pack-resolved
        // create route. Only the create branch of guardExecutionEdit ever sets
        // this, so no other edit path can pick the field up.
        const createdPath = typeof (withApplied as { path?: unknown }).path === "string"
          ? String((withApplied as { path?: unknown }).path)
          : pendingCreateAuthorization?.paths[0];
        const withCreateAuthorization = editOk
          && pendingCreateAuthorization !== undefined
          && createdPath !== undefined
          && createdPath !== ""
          ? {
              ...withApplied,
              create_target: {
                path: createdPath,
                directory_evidence: createDirectoryEvidence(workspace, createdPath),
                authorized_by: pendingCreateAuthorization.pin,
              },
            }
          : withApplied;

        // One-shot edits[] batching hint: only plain single-edit paths leave
        // singleEditForHint at its default `true` (see its declaration
        // above). Gate on ok!==false to match the success convention used by
        // recordHandleEdit/recordPathSearchEdit call sites elsewhere in this
        // case — a failed/refused edit must not count. (unread_note fires on
        // the 1st edit, this hint on the 2nd — they never co-occur, but both
        // are threaded through withUnreadNote/resolved uniformly regardless.)
        if (singleEditForHint && editOk && recordSingleEditCompletion(workspace)) {
          return attachVerification(attachClosure({ ...withCreateAuthorization, hint: BATCH_HINT_TEXT }, workspace), workspace, args);
        }
        return attachVerification(attachClosure(withCreateAuthorization, workspace), workspace, args);
      }

      if (artifactRequested) {
        singleEditForHint = false;
        if (
          Array.isArray(args["edits"])
          || args["create"] === true
          || args["mode"] !== undefined
          || args["intent"] !== undefined
          || args["search"] !== undefined
          || args["replace"] !== undefined
          || args["content"] !== undefined
        ) {
          return toolStructuredError({
            ok: false,
            reason: "artifact-edit-incompatible-arguments",
            detail: "use one artifact object with path/handle and optional credentialRef/outputCredentialRef",
          });
        }
        if (args["precondition"] !== undefined) {
          return toolStructuredError({
            ok: false,
            reason: "artifact-precondition-unsupported",
            detail: "artifact writes already verify and atomically replace the complete binary; omit the text-edit precondition",
          });
        }
        const artifactElisionField = artifactReplacementElisionField(artifactArg);
        if (artifactElisionField !== undefined) {
          return toolStructuredError(elidedContentRefusal({
            field: artifactElisionField,
            path: filePath || undefined,
          }));
        }
        const preCheckArtifact = await enforcePreconditions(args, effectivePath, workspace, readFileSafeOpt);
        if (!preCheckArtifact.ok) {
          return toolStructuredError(preCheckArtifact.failure as unknown as Record<string, unknown>);
        }
        const artifactResult = await editArtifact(
          {
            path: filePath,
            artifact: artifactArg,
            ...(editCredential.password !== undefined ? { credentialPassword: editCredential.password } : {}),
            ...(outputCredential.password !== undefined ? { outputPassword: outputCredential.password } : {}),
            outputCredentialSupplied,
          },
          workspace,
          ALLOW_WRITE,
          SESSION_ID,
        );
        const compactArtifactResult = artifactResult.ok
          ? { ...artifactResult, sha: shortSha(artifactResult.sha) }
          : artifactResult;
        return toolOk(await finishEdit(withReview(await withHandleAugment(compactArtifactResult as Record<string, unknown>))));
      }

      // -----------------------------------------------------------------------
      // Phase 5 intent dispatch: checked BEFORE all other branches.
      // Requires: non-empty intent string AND handle resolved (handle provides
      // the target scope for all intents). D10 (2026-08-14): intents are
      // unconditional — `TL_EDIT_INTENTS` and `edit-intents-disabled` are gone.
      // -----------------------------------------------------------------------
      const intentArg = typeof args["intent"] === "string" && args["intent"].trim() !== ""
        ? args["intent"].trim()
        : null;

      if (intentArg !== null) {
        // Intents aren't poolable into an edits[] call — never count toward
        // the one-shot batching hint.
        singleEditForHint = false;
        if (Array.isArray(args["edits"])) {
          return toolStructuredError({
            ok: false,
            reason: "intent-incompatible-with-batch",
            detail: "remove intent and keep edits[] for an ordinary batch, or remove edits[] and pass one top-level handle for the special intent",
          });
        }
        // Intents require a handle to scope the operation.
        if (!handleId) {
          return toolStructuredError({
            ok: false,
            reason: "intent-requires-handle",
            detail: `read the target file to mint a handle, then retry the ${intentArg} intent with that handle`,
          });
        }

        const intentHandle = handleTable.get(handleId)!; // already validated above
        // Prefer explicit symbol arg over the handle's symbol (allows caller to pass
        // a symbol name alongside a file handle for intents like append-union-member).
        const intentSymbol = handleSymbol
          ?? (typeof args["symbol"] === "string" && args["symbol"].trim() !== "" ? args["symbol"].trim() : undefined);
        const intentResult = await applyIntent(
          intentArg,
          {
            path: filePath,
            range: intentHandle.range,
            symbol: intentSymbol,
            target: typeof args["target"] === "string" ? args["target"] : undefined,
            precondition: typeof args["precondition"] === "string" ? args["precondition"] : undefined,
            lang: typeof args["lang"] === "string" ? args["lang"] : undefined,
            handle: intentHandle,
            handleId,
            allowWrite: ALLOW_WRITE,
            sessionId: SESSION_ID,
          },
          workspace,
        );

        if (!intentResult.ok) {
          return toolOk(intentResult);
        }

        // Success: augment with handle + post-edit sha, then closure-check.
        const augmented = await withHandleAugment(intentResult as Record<string, unknown>);
        return toolOk(await finishEdit(augmented));
      }

      if (args["mode"] === "rename") {
        // Rename isn't poolable into an edits[] call — never count toward
        // the one-shot batching hint.
        singleEditForHint = false;
        // Preconditions for rename branch.
        const preCheckRename = await enforcePreconditions(args, effectivePath, workspace, readFileSafeOpt);
        if (!preCheckRename.ok) {
          return toolStructuredError(preCheckRename.failure as unknown as Record<string, unknown>);
        }

        const lang = parseMcpLang(args["lang"]);
        const result = await renameSymbol(
          {
            from: String(args["from"] ?? ""),
            to: String(args["to"] ?? ""),
            ...(filePath ? { path: filePath } : {}),
            ...(args["includeComments"] !== undefined ? { includeComments: Boolean(args["includeComments"]) } : {}),
            ...(lang ? { lang } : {}),
          },
          workspace,
          ALLOW_WRITE,
          SESSION_ID,
        );
        return toolOk(await finishEdit(withReview(await withHandleAugment(result as unknown as Record<string, unknown>))));
      }

      if (args["edits"] != null) {
        // Suppress the one-shot batching hint permanently: this session has
        // now demonstrated it knows the edits[] form (any batch size,
        // success or failure counts — see recordEditsBatchUsed doc).
        recordEditsBatchUsed(workspace);
        singleEditForHint = false;
        // AUDIT (argument-combination matrix, 2026-07-12): `edits` is checked
        // BEFORE `create` below, so create:true silently loses to edits[] —
        // empirically confirmed live: tl_edit_file({create:true, path:"new.ts",
        // content:"...", edits:[{path:"new.ts", search, replace}]}) never
        // created the file; it instead failed with the applyEditsMulti
        // per-item "File not found: new.ts" error, with no indication that
        // `create` was ignored because `edits` took precedence — a caller
        // reading that error has no reason to suspect create:true was ever
        // relevant. (When the edits[] target already exists, create:true is
        // silently dropped but harmless — the edit just applies normally —
        // which is its own "ok:true with an ignored argument" instance.)
        // Refuse the combination outright in both cases: edits[] cannot
        // create files (applyEditsMulti's own empty-search branch says so
        // explicitly), so the two are fundamentally incompatible in one call.
        if (args["create"] === true) {
          return toolError(
            "create and edits[] cannot be combined — edits[] only modifies existing files; call tl_edit_file with create:true separately (no edits[]) to create the file, then batch further edits in a follow-up edits[] call",
            { code: "invalid-input" },
          );
        }
        // Preconditions for a multi-edit batch are resolved per item. An
        // item-level value wins; otherwise the call-level value is inherited.
        // unique-match is enforced by applyEditsMulti against the current
        // in-memory file state, including sequential edits sharing a path.
        // expected-hash, scope-handle, and references-reviewed are checked
        // against each item's resolved path before any mutation, preserving
        // all-or-nothing semantics. This closes the former safety bypass where
        // only a top-level path/handle was checked while another item mutated.
        const edits = args["edits"];
        if (!Array.isArray(edits)) return toolError("edits must be an array", { code: "invalid-input" });

        // F-V13-2 (2026-08-30): a batch create item has no `handle` — the
        // single tl_edit_file `create:true` path's OWN cwd-less carve-out
        // (`createDispatchRequested` above, which explicitly excludes
        // `edits[]`) requires an explicit cwd OR an existing handle
        // capability to pin the new file's workspace, and refuses
        // (`cwd-required-for-create`) otherwise rather than silently
        // guessing the server's default/pinned root. A batch whose ONLY
        // items are creates, with no cwd and no OTHER handle-bearing item to
        // adopt a root from, would otherwise fall through the B1 pre-pass's
        // "no handles at all" branch (`resolveHandleWorkspace` -> {kind:
        // "keep"}) with `workspace` silently left at its default — the exact
        // hazard the single-create path's own guard exists to prevent.
        // Checked up front, before B1 runs, so the whole batch refuses
        // before any write (all-or-nothing, like every other pre-pass guard
        // here). A batch mixing a create with a handle-bearing edit item is
        // UNAFFECTED — that handle already pins a root for B1 below.
        if (!cwdExplicit) {
          const hasBatchCreate = (edits as unknown[]).some(
            (e) => (e as Record<string, unknown>)["create"] === true,
          );
          const anyHandleBearing = (edits as unknown[]).some(
            (e) => typeof (e as Record<string, unknown>)["handle"] === "string",
          );
          batchCreateUsesServerDefault = hasBatchCreate
            && !anyHandleBearing
            && singleRootDefaultAvailable;
          if (hasBatchCreate && !anyHandleBearing && !batchCreateUsesServerDefault) {
            return toolStructuredError({
              ok: false,
              reason: "cwd-required-for-create",
              code: "cwd-required-for-create",
              applied: false,
              detail: "a batch create item names a new path with no handle to pin its workspace, so it cannot be inferred from the server default; pass cwd explicitly",
              recovery_detail: "retry the same edits[] batch with an explicit top-level cwd",
            });
          }
        }

        // B1 batch pre-pass: all handle-bearing items in one edits[] call must
        // share ONE workspaceRoot. When cwd was omitted, adopt that single
        // root (the handles ARE the workspace pin); when the batch spans more
        // than one root, refuse the whole batch up front — never plumb
        // per-item workspaces through applyEditsMulti. Unknown handles are
        // left for the per-item loop below (same error there as today).
        // When cwd was explicit, defer to the per-item mismatch check below
        // (unchanged shape, just B2-enriched).
        if (!cwdExplicit) {
          const candidateRoots: string[] = [];
          let anyItemLacksHandle = false;
          for (const e of edits as unknown[]) {
            const entryHandleId = typeof (e as Record<string, unknown>)["handle"] === "string"
              ? (e as Record<string, unknown>)["handle"] as string
              : undefined;
            if (!entryHandleId) {
              anyItemLacksHandle = true;
              continue;
            }
            const hEntry = handleTable.get(entryHandleId);
            if (!hEntry) continue; // handle-unknown surfaces in the per-item loop below.
            candidateRoots.push(hEntry.workspaceRoot);
          }
          const res = resolveHandleWorkspace(candidateRoots, cwdExplicit, workspace);
          if (res.kind === "multi") {
            return toolStructuredError({
              ok: false,
              reason: "handle-workspace-mismatch",
              handleWorkspaces: res.roots,
              // Roots ride the detail: the v1 advisory allowlist drops
              // handleWorkspaces (2026-08-09 guard class, see read-side twin).
              detail: `all handles in one batch must share a workspace (got: ${res.roots.join(", ")}); omit cwd or pass a single cwd`,
            });
          }
          if (res.kind === "missing") {
            return toolStructuredError({
              ok: false,
              reason: "handle-workspace-missing",
              handleWorkspace: res.handleWorkspace,
              detail: handleWorkspaceMissingDetail(res.handleWorkspace),
            });
          }
          if (res.kind === "adopt") {
            // H1: a mixed batch (some items handle-bearing, some path-only)
            // that ADOPTS a root DIFFERENT from the pinned root would apply the
            // path-only items against the adopted root — a silent cross-tree
            // write the old code refused. Refuse the whole batch instead of
            // guessing which tree the path-only edits meant.
            if (anyItemLacksHandle && res.workspace !== workspace) {
              return toolStructuredError({
                ok: false,
                reason: "mixed-batch-workspace-ambiguous",
                adoptedWorkspace: res.workspace,
                detail: `pass cwd=${res.workspace} explicitly, or give every edit a handle`,
              });
            }
            workspace = adoptGuardedWorkspaceRoot(res.workspace, workspace);
          }
        }

        // A7: resolve {handle, search, replace} / {handle, content} items to
        // {path[, range], search, replace|content} before delegating to
        // applyEditsMulti — same handle-resolution failure modes as the
        // single-edit handle path (handle-unknown / handle-workspace-mismatch),
        // checked for ALL items before any write (all-or-nothing).
        // item 10: refuse the whole batch (all-or-nothing) if ANY item's
        // agent-supplied content/replace text carries an elision marker.
        // P0: same destructive search+content / bare-search shape guard as
        // the single-edit path above, applied per-entry so the WHOLE batch
        // refuses before any item mutates (all-or-nothing, same as the
        // elision guard just above — see SEARCH_CONTENT_CONFLICT_MSG /
        // SEARCH_NEEDS_REPLACE_MSG doc comment earlier in this case).
        for (const [index, e] of (edits as unknown[]).entries()) {
          const entry = e as Record<string, unknown>;
          const entryElisionField: ElisionMarkerField | undefined =
            contentHasElisionMarker(entry["content"]) ? "content"
              : contentHasElisionMarker(entry["replace"]) ? "replace"
                : contentHasElisionMarker(entry["search"]) ? "search"
                  : undefined;
          if (entryElisionField !== undefined) {
            const entryHandle = typeof entry["handle"] === "string" ? handleTable.get(entry["handle"]) : undefined;
            const entryPath = String(entryHandle?.path ?? entry["path"] ?? "");
            // FX-OH F4, per item — same rule as the single-edit path above.
            const resolvedEntryAnchor = entryElisionField === "search" || entryElisionField === "replace"
              ? await applyElidedEditAnchor(entry, entryPath, workspace)
              : false;
            if (!resolvedEntryAnchor) {
              return toolStructuredError(elidedContentRefusal({
                field: entryElisionField,
                path: entryPath || undefined,
                range: entryHandle?.range ?? (typeof entry["range"] === "string" ? entry["range"] : undefined),
                failedItem: index,
              }));
            }
          }
          // D10 (2026-08-14): `TL_REFUSAL_PROGRESS` is deleted; these refusals
          // always carry the structured `applied:false` + `failed_item` shape.
          if (entry["search"] !== undefined && entry["content"] !== undefined) {
            return toolStructuredError({
              ok: false,
              code: "edits-item-shape",
              error: SEARCH_CONTENT_CONFLICT_MSG,
              applied: false,
              failed_item: { index: (edits as unknown[]).indexOf(e) },
            });
          }
          if (entry["search"] !== undefined && entry["replace"] === undefined && entry["content"] === undefined) {
            return toolStructuredError({
              ok: false,
              code: "edits-item-shape",
              error: SEARCH_NEEDS_REPLACE_MSG,
              applied: false,
              failed_item: { index: (edits as unknown[]).indexOf(e) },
            });
          }
        }

        // P4.1 (2026-08-02 T13 rep1-a idx 52/54/56/58): edits[] items that
        // carry NEITHER handle nor path. The batch branch never consults the
        // call's own TOP-LEVEL handle, so each such entry was coerced to
        // path:"" and refused with a bare {error:"path is required", path:""}.
        // Four consecutive turns burned before the solver worked out on its
        // own that the handle belongs on each entry — while the handle sat
        // resolvable in the registry this dispatch already reads.
        //
        // ACCEPTANCE IS UNCHANGED: this call still fails, nothing is inferred
        // or substituted, and the echoed path is explicitly `applied:false`.
        // Runs in the same all-or-nothing pre-pass as the guards above, before
        // applyEditsMulti is ever called.
        // D10 (2026-08-14): unconditional — `TL_REFUSAL_PROGRESS` is deleted.
        {
          const targetless = (edits as unknown[])
            .map((entry, index) => ({ index, entry: entry as Record<string, unknown> }))
            .filter(({ entry }) => typeof entry["handle"] !== "string" && typeof entry["path"] !== "string");
          if (targetless.length > 0) {
            const topHandle = typeof args["handle"] === "string" ? args["handle"] : undefined;
            const topEntry = topHandle !== undefined ? handleTable.get(topHandle) : undefined;
            const candidatePath = topEntry?.workspaceRoot === workspace ? topEntry.path : undefined;
            // 2026-08-02 review blocker D. Inference is SOUND only for a single
            // targetless item against an unambiguous top-level handle. With two
            // or more, stamping the one handle onto all of them fabricates a
            // multi-edit against a single file that the caller never expressed
            // — worse than no suggestion. And the template must carry EVERY
            // original item, in order: this batch is all-or-nothing, so a
            // template that keeps only the broken items would silently drop the
            // caller's well-formed edits when run.
            const soundInference = targetless.length === 1 && candidatePath !== undefined && candidatePath !== "";
            const expectedShapes = [
              { handle: "<a handle from a read of the file this item edits>", search: "<exact text>", replace: "<its replacement>" },
              { path: "<workspace-relative path>", search: "<exact text>", replace: "<its replacement>" },
            ];
            const repairedEdits = (edits as unknown[]).map((raw, index) => {
              const original = { ...(raw as Record<string, unknown>) };
              return targetless.length === 1 && targetless[0]!.index === index
                ? { handle: topHandle, ...original }
                : original;
            });
            return toolStructuredError({
              ok: false,
              error: "path is required",
              code: "edits-item-missing-target",
              reason: "edits-item-missing-target",
              applied: false,
              failed_items: targetless.map(({ index }) => ({ index })),
              note: "edits[] items do not inherit the call's top-level handle — put the handle (or path) on each item",
              expected_shapes: expectedShapes,
              ...(soundInference
                ? {
                    candidate: {
                      source: "top-level-handle",
                      handle: topHandle,
                      path: candidatePath,
                      applied: false,
                    },
                    next_call: {
                      tool: "tl_edit_file",
                      arguments: {
                        edits: repairedEdits,
                        ...(typeof args["cwd"] === "string" ? { cwd: args["cwd"] } : {}),
                      },
                    },
                  }
                : {}),
            });
          }
        }

        const typedEdits: Array<{
          path: string;
          search: string;
          replace: string;
          range?: string;
          content?: string;
          uniqueMatch?: boolean;
          anchorSha?: string;
          anchorShaRange?: string;
          create?: boolean;
          // v0.14.1 defect 2 fix (2026-09-07): explicit "replace every exact occurrence" —
          // forwarded only from a path-based item or a handle item with no
          // range; a range-bearing item already replaces every match within
          // its range unconditionally and does not consult this field.
          target?: "all";
          // R29-FIX (2026-09-05, D2): see the blastAcknowledged comment at its
          // single-item-batch computation site below.
          blastAcknowledged?: boolean;
        }> = [];
        for (const [index, e] of (edits as unknown[]).entries()) {
          const entry = e as Record<string, unknown>;

          // F-V13-2 (2026-08-30 fix): a create:true item never targets an
          // EXISTING file, so it is diverted here FIRST — before even the
          // unique-match precondition check just below, which is
          // nonsensical for a path that does not exist yet (entry.search is
          // always undefined on a create item and would otherwise
          // misreport "precondition-unsupported-for-batch") — and before
          // entryHandleId/the handle- and bare-path branches further down,
          // both of which assume "this path already exists on disk" and
          // silently dropped entry.content/entry.create before this fix
          // (the exact F-V13-2 bug: the item fell to the bare-path fallback,
          // which pushed {path, search:"", replace:""}, and
          // applyEditsMulti's Phase 1 hit a plain fs.statSync ENOENT on a
          // target that was NEVER created — the generic "File not found"
          // refusal, no indication create:true was ever relevant).
          //
          // v1 SCOPE: a batch create item supports only {path, create:true,
          // content} or {path, create:true, from} — the plain shapes
          // CANONICAL_EDIT_ITEM's schema already advertises for edits[]
          // (`{required:["create","content"]}` / `{required:["create",
          // "from"], not:{required:["content"]}}`). `directoryHandle` and a
          // create sharing its path with another edits[] item are refused
          // outright rather than silently ignored or given undefined
          // behavior — the single-item create path (server.ts's
          // args["create"]===true branch above, reached via the edits.length
          // ===1 unwrap in normalizeCanonicalRequest) already supports both;
          // a caller that needs them issues the create as its own call.
          if (entry["create"] === true) {
            if (entry["directoryHandle"] !== undefined) {
              return toolStructuredError({
                ok: false,
                code: "invalid-input",
                reason: "batch-create-directory-handle-unsupported",
                applied: false,
                failed_item: { index },
                detail: "directoryHandle is not supported on a batch edits[] create item — issue this create as its own single tl_edit_file call (create:true, no edits[]), or resolve the directory to a plain path first",
              });
            }
            const createTargetPath = String(entry["path"] ?? "");
            const samePathConflict = createTargetPath !== "" && (edits as unknown[]).some((other, otherIndex) => {
              if (otherIndex === index) return false;
              return String((other as Record<string, unknown>)["path"] ?? "") === createTargetPath;
            });
            if (samePathConflict) {
              return toolStructuredError({
                ok: false,
                code: "invalid-input",
                reason: "batch-create-edit-same-path",
                applied: false,
                failed_item: { index, path: createTargetPath },
                detail: `${createTargetPath} appears in more than one edits[] item alongside a create:true entry — create it in its own call first, then edit it in a follow-up batch`,
              });
            }
            let createBody: string;
            if (entry["content"] !== undefined) {
              createBody = String(entry["content"]);
            } else if (typeof entry["from"] === "string") {
              const resolved = await resolveCreateSourceContent(entry["from"], workspace, cwdExplicit);
              if (!resolved.ok) {
                if (resolved.reason === "workspace-conflict") {
                  return toolStructuredError({
                    ok: false,
                    reason: "handle-workspace-mismatch",
                    handle: String(entry["from"]),
                    handleWorkspace: resolved.entry.workspaceRoot,
                    detail: `retry with cwd=${resolved.entry.workspaceRoot} or omit cwd`,
                    failed_item: { index },
                  });
                }
                if (resolved.reason === "workspace-missing") {
                  return toolStructuredError({
                    ok: false,
                    reason: "handle-workspace-missing",
                    handle: String(entry["from"]),
                    handleWorkspace: resolved.entry.workspaceRoot,
                    detail: handleWorkspaceMissingDetail(resolved.entry.workspaceRoot),
                    failed_item: { index },
                  });
                }
                return toolStructuredError({
                  ok: false,
                  code: "invalid-input",
                  reason: "batch-create-source-unreadable",
                  applied: false,
                  failed_item: { index, path: createTargetPath },
                  detail: `from=${String(entry["from"])} did not resolve to a readable handle or path — supply content instead, or fix the from= source`,
                });
              }
              createBody = resolved.content;
              workspace = adoptGuardedWorkspaceRoot(resolved.workspace, workspace);
            } else {
              return toolStructuredError({
                ok: false,
                code: "invalid-input",
                reason: "batch-create-missing-body",
                applied: false,
                failed_item: { index, path: createTargetPath },
                detail: "a batch create item needs content or from=",
              });
            }
            // INV-I-3 (FX-P2): same 32 KiB ceiling as the single-edit create
            // dispatch, enforced here in Phase 1 — before typedEdits ever
            // reaches applyEditsMulti — so an oversized create item refuses
            // the WHOLE batch with disk untouched (no item, including ones
            // earlier in the array, has been written yet at this point).
            if (Buffer.byteLength(createBody, "utf8") > MAX_CREATE_CONTENT_BYTES) {
              return toolStructuredError(createContentTooLargeRefusal(
                createBody,
                `edits[${index}].content`,
                { index, path: createTargetPath },
              ));
            }
            typedEdits.push({ path: createTargetPath, search: "", replace: "", create: true, content: createBody });
            continue;
          }

          const entryPrecondition = entry["precondition"] ?? args["precondition"];
          const uniqueMatchBatch = entryPrecondition === "unique-match";
          if (
            uniqueMatchBatch
            && (typeof entry["search"] !== "string" || entry["search"] === "")
          ) {
            // 2026-10-19 (v016 decision 6t-3, T05c rep2 #14): the corrected
            // call exists — this item without its precondition — so the
            // refusal names it instead of sending the caller back to a whole
            // new task pack (31.2 KB measured) and a re-sent batch.
            const repaired = repairedEditBatchCall(
              args,
              Array.isArray(sentEditArgs["edits"]) ? sentEditArgs["edits"] as unknown[] : undefined,
              index,
            );
            return toolStructuredError({
              ok: false,
              reason: "precondition-unsupported-for-batch",
              precondition: "unique-match",
              failed_item: { index },
              detail: repaired === undefined
                ? "unique-match requires a non-empty search on the affected edits[] item"
                : "unique-match requires a non-empty search on the affected edits[] item; nothing was written — next re-issues this call without that precondition, so the item replaces what it names",
              ...(repaired !== undefined ? { field: `edits[${index}].precondition`, retry: "call", next: repaired } : {}),
            });
          }
          // v0.14.1 defect 2 fix (2026-09-07): target:"all" (replace EVERY occurrence) and
          // precondition:"unique-match" (require EXACTLY one occurrence) are
          // a direct contradiction. Refuse before ANY item in the batch is
          // touched (Phase 1 validation, all-or-nothing), naming the exact
          // item and field so the caller can drop one of the two and retry
          // in one call — same field-qualified, retry:"call" convention the
          // write-intent-ambiguous refusal below uses.
          if (entry["target"] === "all" && uniqueMatchBatch) {
            return toolStructuredError({
              ok: false,
              code: "invalid-input",
              error: `edits[${index}] carries both target:"all" (replace every occurrence) and precondition:"unique-match" (require exactly one) — these are contradictory; drop one and retry`,
              field: `edits[${index}].precondition`,
              retry: "call",
              failed_item: { index },
            });
          }
          const entryHandleId = typeof entry["handle"] === "string" ? entry["handle"] : undefined;

          if (entryHandleId) {
            const hEntry = handleTable.get(entryHandleId);
            if (!hEntry) {
              return toolStructuredError(unknownEditItemHandleRefusal(args, sentEditArgs, index));
            }
            if (hEntry.workspaceRoot !== workspace) {
              // B2: explicit conflicting cwd (the pre-pass above already
              // adopted a shared root when cwd was omitted, so reaching here
              // with cwdExplicit=false would mean a per-item root outside the
              // adopted set — not expected, but enrich defensively either way).
              return toolStructuredError({
                ok: false,
                reason: "handle-workspace-mismatch",
                handle: entryHandleId,
                handleWorkspace: hEntry.workspaceRoot,
                detail: `retry with cwd=${hEntry.workspaceRoot} or omit cwd`,
              });
            }
            if (!hEntry.path) {
              return toolStructuredError(unknownEditItemHandleRefusal(args, sentEditArgs, index));
            }
            const guardArgs = batchItemGuardArgs(args, entry, entryPrecondition);
            if (batchItemNeedsPreconditionCheck(entryPrecondition, guardArgs)) {
              const preCheck = await enforcePreconditions(
                guardArgs,
                hEntry.path,
                workspace,
                readFileSafeOpt,
              );
              if (!preCheck.ok) {
                return toolStructuredError({
                  ...(preCheck.failure as unknown as Record<string, unknown>),
                  failed_item: { index },
                });
              }
            }
            // R29-FIX (2026-09-05, D2): a per-item precondition:"expected-hash"
            // that just passed the check above IS the same acknowledgment the
            // top-level {handle,content} path already honors (this file's
            // single-edit branches above gate their own blast-radius check on
            // exactly `args["precondition"] !== "expected-hash"`) -- measured:
            // this edits[] shape was refused blast-radius TWICE, byte-
            // identically, because the acknowledgment never reached
            // applyEditStep's own blast-radius check (applyEditsMulti.ts),
            // which has no visibility into this dispatch-level precondition
            // pass at all. Scoped to a SINGLE-item batch only -- symmetry with
            // the top-level single-edit call the refusal's own hint tells the
            // caller to make; a multi-item batch keeps refusing exactly as
            // before, unchanged.
            const blastAcknowledged =
              entryPrecondition === "expected-hash" && (edits as unknown[]).length === 1;
            const entryContent = entry["content"];
            // ANCHOR EDITS: an item may address its target by served
            // handle + its OWN explicit `range` instead of restating the
            // served bytes in a long verbatim `search` — the search string
            // duplicates bytes this server already sent, and batched edit
            // args are a measured chunk of solver output cost. A caller
            // range takes precedence over the handle's own stored range (a
            // whole-file kind:"file" handle has none, which is exactly the
            // case that previously had no way to name a span at all).
            //
            // Because an anchor edit carries no served bytes, it also carries
            // no proof its coordinates are still valid, so it — and ONLY it —
            // is CAS-checked in applyEditsMulti against the sha the handle
            // recorded when it was served. `anchorShaRange` tells that check
            // what the sha covers: a slice handle's sha is over its own range,
            // a kind:"file" handle's is over the whole file. Items WITHOUT an
            // explicit range keep their historical no-CAS behavior (see
            // EditEntry.anchorSha's doc comment for the two shipped tests that
            // depend on reusing a handle across successive edits).
            const entryRange = typeof entry["range"] === "string" ? entry["range"] : undefined;
            const effectiveRange = entryRange ?? hEntry.range;
            const anchorCas =
              entryRange !== undefined && hEntry.sha !== undefined
                ? {
                    anchorSha: hEntry.sha,
                    ...(hEntry.range !== undefined ? { anchorShaRange: hEntry.range } : {}),
                  }
                : {};
            // AUDIT (argument-combination matrix, 2026-07-12): a range-bearing
            // handle whose entry supplies NEITHER `content` NOR a non-empty
            // `search` (e.g. {handle} alone, or {handle, replace:"text"} —
            // the natural mistake of using `replace` the way the single-edit
            // form's bottom fallback does, without realizing a RANGE handle
            // needs `content` instead) used to fall into the "else if
            // (hEntry.range)" branch below with search coerced to "" via
            // `?? ""` — indistinguishable from the {handle, content} shape at
            // applyEditStep, which then reads the (never-set) `content` field
            // as "" and WIPES the whole range, silently discarding any
            // `replace` text the caller gave. Empirically confirmed live:
            // edits:[{handle:<h for lines 1-3>, replace:"<new body>"}]
            // returned ok:true, delta "+0/-3", and deleted the 3 lines outright.
            // Refuse loudly instead — the single-edit (non-batch) path already
            // refuses this exact shape (falls through to searchReplaceEdit's
            // "empty-search" error); this closes the SAME gap for edits[].
            if (effectiveRange !== undefined && entryContent === undefined && (entry["search"] === undefined || entry["search"] === "")) {
              // P4.3 (2026-08-02): this is also the response to the server's
              // OWN pre-C4 prescribed next_call (bare {handle} entries), which
              // is where T05c rep0 abandoned TL. The message stays BYTE-
              // IDENTICAL (shipped tests match on it); the entry index, its
              // resolved target and both accepted shapes are additive.
              const shapeError =
                'a range-scoped edits[] entry needs either content (range replacement) or search+replace (range-scoped replace-all) — got neither (replace alone with no search is ambiguous); did you mean content:"..."?';
              return toolStructuredError({
                ok: false,
                code: "edits-item-shape",
                applied: false,
                reason: "edits-item-shape",
                error: shapeError,
                failed_item: {
                  index: (edits as unknown[]).indexOf(e),
                  handle: entryHandleId,
                  path: hEntry.path,
                  range: effectiveRange,
                },
                expected_shapes: [
                  { content: "<replacement text for the WHOLE range>" },
                  { search: "<exact text inside the range>", replace: "<its replacement>" },
                ],
                next_call: {
                  tool: "tl_edit_file",
                  arguments: {
                    edits: [{ handle: entryHandleId, content: "<replacement text for the WHOLE range>" }],
                    ...(typeof args["cwd"] === "string" ? { cwd: args["cwd"] } : {}),
                  },
                },
              });
            }
            if (effectiveRange !== undefined && entryContent !== undefined && entry["search"] === undefined && entry["replace"] === undefined) {
              // {handle, range, content} (anchor) / {handle, content} (range
              // handle): range-content replacement.
              typedEdits.push({
                path: hEntry.path,
                search: "",
                replace: "",
                range: effectiveRange,
                content: String(entryContent),
                ...anchorCas,
                ...(blastAcknowledged ? { blastAcknowledged: true } : {}),
              });
            } else if (effectiveRange !== undefined) {
              // {handle[, range], search, replace}: range-scoped replace-all.
              // No CAS here — a search string IS its own content proof, so this
              // shape never depended on line coordinates alone.
              typedEdits.push({
                path: hEntry.path,
                search: String(entry["search"] ?? ""),
                replace: String(entry["replace"] ?? ""),
                range: effectiveRange,
                ...(uniqueMatchBatch ? { uniqueMatch: true } : {}),
              });
            } else if (hEntry.kind === "file" && entryContent !== undefined && entry["search"] === undefined && entry["replace"] === undefined) {
              // FIX A-BATCH (2026-07-12c forensics — batch mirror of the
              // single-edit FIX A branch above): {handle (kind:"file", no
              // range), content} — whole-file content replacement. This
              // shape used to fall through to the plain search/replace
              // `else` branch below, which never reads entry.content:
              // entryContent was silently DROPPED, search defaulted to "",
              // and applyEditStep's whole-file branch (applyEditsMulti.ts)
              // returned the misleading "search string is empty ... use
              // create:true" refusal even though the file exists and a real
              // whole-file body was supplied. Deliberately pushes NO `range`
              // here (unlike the range-handle branch above): the actual
              // "replace the whole file" synthesis happens INSIDE
              // applyEditsMulti's applyEditStep, against currentText at the
              // moment this edit step actually executes — a fresh per-path
              // disk read, or (for a merged multi-edit group on the same
              // path) the prior edit's output within this SAME batch — not
              // a range pre-computed here at assembly time, which could go
              // stale by execution time if an earlier grouped edit shifted
              // the file's line count first.
              typedEdits.push({
                path: hEntry.path,
                search: "",
                replace: "",
                content: String(entryContent),
                ...(blastAcknowledged ? { blastAcknowledged: true } : {}),
              });
            } else {
              // Plain file/symbol handle with no range: whole-file exact search/replace.
              typedEdits.push({
                path: hEntry.path,
                search: String(entry["search"] ?? ""),
                replace: String(entry["replace"] ?? ""),
                ...(uniqueMatchBatch ? { uniqueMatch: true } : {}),
                ...(entry["target"] === "all" ? { target: "all" as const } : {}),
              });
            }
            continue;
          }

          // FIX B (batch mirror of the single-edit FIX A.3 message above):
          // a bare {path, content} entry — no handle, no search — used to
          // have `content` silently dropped right here (this fallback only
          // ever carried search/replace into typedEdits for path-only
          // entries), so an EXISTING file hit applyEditsMulti's misleading
          // "search string is empty ... use create:true" refusal even
          // though a real whole-file body was supplied. All-or-nothing:
          // refuse the WHOLE batch before any item mutates, same
          // first-hit-wins convention as the elision / SEARCH_CONTENT_CONFLICT_MSG
          // / SEARCH_NEEDS_REPLACE_MSG guards in the pre-pass loop above. A
          // MISSING path is left untouched (falls through unchanged to
          // applyEditsMulti's own not-found handling) — mirrors FIX A.3's
          // own existence check, which only fires this message for a path
          // that actually exists. Deliberately NOT a new create/whole-file-
          // replace path: this only changes which error a bad shape gets.
          const bareEntryPath = String(entry["path"] ?? "");
          const guardArgs = batchItemGuardArgs(args, entry, entryPrecondition);
          if (batchItemNeedsPreconditionCheck(entryPrecondition, guardArgs)) {
            const preCheck = await enforcePreconditions(
              guardArgs,
              bareEntryPath,
              workspace,
              readFileSafeOpt,
            );
            if (!preCheck.ok) {
              return toolStructuredError({
                ...(preCheck.failure as unknown as Record<string, unknown>),
                failed_item: { index },
              });
            }
          }
          // R31 finding #6 (P3, 2026-09-05): mirror the handle branch's own
          // `blastAcknowledged` — a bare path-addressed single-item batch
          // whose `precondition:"expected-hash"` just passed the check above
          // is the SAME acknowledgment the handle branch honors; scoped to a
          // single-item batch only, exactly like the handle branch.
          const blastAcknowledged =
            entryPrecondition === "expected-hash" && (edits as unknown[]).length === 1;
          if (entry["content"] !== undefined && entry["search"] === undefined) {
            // served-bytes: not-served (edit precondition: existence probe for the refusal message)
            const existingCheckForBatchContentMsg = await readFileSafeOpt(bareEntryPath, workspace);
            if (existingCheckForBatchContentMsg !== null) {
              // IL-W5 (DESIGN-v0.15-sf-intent-layers.md §11.2(1)): a bare
              // {path, content} full-body edit is not actually ambiguous
              // when this LANE already holds the file's full current body
              // (a create:true mint, or a prior content:"full" serve) —
              // apply it through the SAME typedEdits shape the handle-
              // bearing kind:"file" branch above uses (search:""/replace:""
              // + content); applyEditsMulti mints and reports the resolved
              // handle in `applied[]` itself (existing field, no new one).
              if (hasFullBodyResidencyForAutoResolve(workspace, bareEntryPath, existingCheckForBatchContentMsg)) {
                typedEdits.push({
                  path: bareEntryPath,
                  search: "",
                  replace: "",
                  content: String(entry["content"]),
                  // Preserve explicit ranges, including invalid/empty ones for refusal.
                  ...(entry["range"] !== undefined ? { range: String(entry["range"]) } : {}),
                  ...(blastAcknowledged ? { blastAcknowledged: true } : {}),
                });
                continue;
              }
              // #28/#29 (C2-6 audit): well-formed item, existing file, no
              // create — "ambiguous write intent" had no A.7.1 member of its
              // own and rode `invalid-input` per the C2-6 work item's explicit
              // resolution. R5-29 (ratified 2026-08-14) minted
              // `write-intent-ambiguous` for this emitter and the single-edit
              // twin at :9335.
              //
              // IL-W5 §11.2(2)/(3): name the offending field, keep `retry`
              // sanctioned, and carry an executable canonical `next` — never
              // the legacy `alternatives:[{mode:…}]` menu (a refusal that
              // already carries `next`/`path` never reaches
              // supplyRefusalGuidance's last-resort derivation).
              return toolStructuredError({
                ok: false,
                error: FILE_EXISTS_FULL_BODY_MSG,
                code: "write-intent-ambiguous",
                field: `edits[${index}].content`,
                retry: "call",
                path: bareEntryPath,
                failed_item: { index },
                next: writeIntentAmbiguousRecoveryNext(workspace, bareEntryPath, existingCheckForBatchContentMsg),
              });
            }
          }
          typedEdits.push({
            path: bareEntryPath,
            search: String(entry["search"] ?? ""),
            replace: String(entry["replace"] ?? ""),
            ...(entry["range"] !== undefined ? { range: String(entry["range"]) } : {}),
            ...(uniqueMatchBatch ? { uniqueMatch: true } : {}),
            ...(entry["target"] === "all" ? { target: "all" as const } : {}),
          });
        }

        const result = await applyEditsMulti({ edits: typedEdits }, workspace, ALLOW_WRITE, SESSION_ID);
        // W1 for a batch (2026-10-19, decision run 6t-4, T05c rep1 arm A): the
        // single-create arm enrolls the file it wrote (recordCreatedEditAdmissibility),
        // but a batch's create items never were, so the next edit of a file
        // this task had just created was refused "edit target is outside
        // certificate frontier" and sent to a whole new task (#36 -> a 9.4 KB
        // `task:{epoch:"new"}` pack -> the same edit under that task). A landed
        // batch wrote every item (all-or-nothing), so each created file is
        // enrolled with the handle its `applied[]` row carries, exactly as W1
        // enrolls a single create.
        if (result.ok) {
          const createdPaths = new Set(typedEdits.filter((edit) => edit.create === true).map((edit) => edit.path));
          for (const file of result.files) {
            if (createdPaths.has(file.path)) recordCreatedEditAdmissibility(workspace, { handle: file.handle, path: file.path });
          }
        }
        // A unique-match item with zero matches is `not-found` since
        // 2026-11-02 (v0.16.4 field evaluation); it keeps this recovery shape.
        const uniqueMatchMiss = !result.ok && result.code === "not-found"
          && result.failed_item !== undefined && typedEdits[result.failed_item.index]?.uniqueMatch === true;
        if (!result.ok && (result.code === "search-not-unique" || uniqueMatchMiss)) {
          // Preserve the current source and failed item that Phase 1 already
          // computed. Dropping them forces a read before the corrected retry.
          return toolStructuredError({
            ...result,
            reason: result.code,
            detail: result.error,
          });
        }
        const batchResponse = result.ok && batchCreateUsesServerDefault
          ? { ...result, cwd_source: "server-default" }
          : result;
        return toolOk(await finishEdit(withReview(await withHandleAugment(batchResponse as unknown as Record<string, unknown>))));
      }

      if (args["create"] === true) {
        // create=true is explicitly excluded from the one-shot batching hint
        // (DESIGN: only plain single-edit completions count).
        singleEditForHint = false;
        // Preconditions for create branch.
        const preCheckCreate = await enforcePreconditions(args, effectivePath, workspace, readFileSafeOpt);
        if (!preCheckCreate.ok) {
          return toolStructuredError(preCheckCreate.failure as unknown as Record<string, unknown>);
        }

        // DESIGN-v0.8 B1 follow-up guard: directoryHandle adoption (below)
        // and resolveCreateSourceContent's `from`-handle adoption (further
        // below) are each independently correct in isolation — B1 made
        // exactly ONE handle's own workspaceRoot the adoption target when
        // cwd is absent. But when BOTH a directoryHandle and a `from`
        // handle are supplied together with no cwd, the directoryHandle
        // adoption runs FIRST and reassigns `workspace`; the from-handle
        // adoption then runs SECOND against that already-reassigned
        // `workspace` and can silently re-adopt AGAIN to a DIFFERENT root —
        // so the directory (worktree A) and the source content (worktree B)
        // end up written into whichever root won the LAST adoption, not
        // the tree the caller actually meant. Pre-B1 this compound case was
        // safely refused (any single mismatch refused outright); B1's two
        // independent per-site adoptions reopened it as a silent mis-target.
        // Catch it up front, before either adoption commits, by comparing
        // both handles' OWN stored workspaceRoots directly (not the
        // mutable `workspace` variable, which has not been reassigned yet
        // at this point).
        if (!cwdExplicit) {
          const dirHandleIdForGuard = typeof args["directoryHandle"] === "string" ? args["directoryHandle"] : null;
          const fromArgForGuard = typeof args["from"] === "string" ? args["from"] : null;
          if (dirHandleIdForGuard && fromArgForGuard) {
            const dirEntryForGuard = handleTable.get(dirHandleIdForGuard);
            const fromEntryForGuard = handleTable.get(fromArgForGuard);
            if (
              dirEntryForGuard &&
              fromEntryForGuard &&
              dirEntryForGuard.workspaceRoot !== fromEntryForGuard.workspaceRoot
            ) {
              return toolStructuredError({
                ok: false,
                reason: "handle-workspace-mismatch",
                directoryHandle: dirHandleIdForGuard,
                fromHandle: fromArgForGuard,
                directoryHandleWorkspace: dirEntryForGuard.workspaceRoot,
                fromHandleWorkspace: fromEntryForGuard.workspaceRoot,
                detail: `directoryHandle and from resolve to different worktrees; retry with cwd=${dirEntryForGuard.workspaceRoot} (to use the directory's tree) or cwd=${fromEntryForGuard.workspaceRoot} (to use the source's tree), or pass a directoryHandle/from pair from the same worktree`,
              });
            }
          }
        }

        // directoryHandle: resolve directory path and prepend it to args.path.
        let createPath = filePath;
        const dirHandleId = typeof args["directoryHandle"] === "string" ? args["directoryHandle"] : null;
        if (dirHandleId) {
          const dirEntry = handleTable.get(dirHandleId);
          if (!dirEntry) {
            // The dead id is NOT echoed back (the `requested_handle` precedent
            // at :4474 — "a refusal must never hand back a locator that cannot
            // be resolved"), so the recovery has to be stated in words instead
            // of implied by the echo. Handles are session-scoped; a create is
            // reachable without one via `cwd` + a relative `path`.
            return toolStructuredError({
              ok: false,
              reason: "directory-handle-unknown",
              detail: "retry create with cwd=<workspace-root> plus a relative path, or re-read the directory to mint a fresh directoryHandle",
              hint: "directory handles are session-scoped and do not survive a server restart; a create needs only cwd plus a relative path",
            });
          }
          if (dirEntry.workspaceRoot !== workspace) {
            if (!cwdExplicit) {
              // B1: cwd omitted — adopt the directory handle's own workspace.
              // H2: refuse if that worktree no longer exists.
              const res = resolveHandleWorkspace([dirEntry.workspaceRoot], cwdExplicit, workspace);
              if (res.kind === "missing") {
                return toolStructuredError({
                  ok: false,
                  reason: "handle-workspace-missing",
                  directoryHandle: dirHandleId,
                  handleWorkspace: res.handleWorkspace,
                  detail: handleWorkspaceMissingDetail(res.handleWorkspace),
                });
              }
              if (res.kind === "adopt") workspace = adoptGuardedWorkspaceRoot(res.workspace, workspace);
            } else {
              // B2: explicit conflicting cwd — refuse with an enriched payload.
              return toolStructuredError({
                ok: false,
                reason: "directory-handle-workspace-mismatch",
                directoryHandle: dirHandleId,
                handleWorkspace: dirEntry.workspaceRoot,
                detail: `retry with cwd=${dirEntry.workspaceRoot} or omit cwd`,
              });
            }
          }
          if (dirEntry.kind !== "directory") {
            return toolStructuredError({ ok: false, reason: "directory-handle-wrong-kind", kind: dirEntry.kind, directoryHandle: dirHandleId });
          }
          // Combine directory path with the filename in args.path.
          const dirPath = dirEntry.path ?? "";
          const filename = String(args["path"] ?? "");
          createPath = dirPath ? `${dirPath}/${filename}` : filename;
        }

        // B1/site-6: resolveCreateSourceContent adopts the `from` handle's own
        // workspace when cwd was omitted, and never falls through to an EMPTY
        // file on a real workspace conflict — it reports the conflict so we
        // can return a B2-enriched refusal instead of silently creating an
        // empty file (the bug this design closes).
        let sourceContent: string | null = null;
        if (args["content"] === undefined) {
          const resolved = await resolveCreateSourceContent(args["from"], workspace, cwdExplicit);
          if (!resolved.ok) {
            if (resolved.reason === "workspace-conflict") {
              return toolStructuredError({
                ok: false,
                reason: "handle-workspace-mismatch",
                handle: String(args["from"]),
                handleWorkspace: resolved.entry.workspaceRoot,
                detail: `retry with cwd=${resolved.entry.workspaceRoot} or omit cwd`,
              });
            }
            if (resolved.reason === "workspace-missing") {
              // H2: the worktree the source handle was minted in no longer exists.
              return toolStructuredError({
                ok: false,
                reason: "handle-workspace-missing",
                handle: String(args["from"]),
                handleWorkspace: resolved.entry.workspaceRoot,
                detail: handleWorkspaceMissingDetail(resolved.entry.workspaceRoot),
              });
            }
            // "no-source": no usable from= source (unset/unknown/unreadable) —
            // legitimate fall-through to args.content (today's behavior).
          } else {
            sourceContent = resolved.content;
            workspace = adoptGuardedWorkspaceRoot(resolved.workspace, workspace);
          }
        }
        // FIX 2b: a caller using the search/replace SHAPE instead of `content`
        // (tl_edit_file create:true search:"" replace:"<body>") — the same
        // contract searchReplaceEdit's own allow_create path already uses
        // (empty search on an absent file means "replace IS the body") —
        // mirrored here so create:true works identically whichever shape the
        // agent reaches for. Only applies when content was never supplied AND
        // no from= source resolved above (sourceContent still null); a
        // non-empty search alongside create:true is not this shape and falls
        // through to today's empty-body default, unchanged.
        const replaceAsBody = typeof args["replace"] === "string"
          && (args["search"] === undefined || args["search"] === "")
          ? args["replace"]
          : undefined;
        const createBody = sourceContent ?? replaceAsBody ?? String(args["content"] ?? "");
        // INV-I-3 (FX-P2): enforce the 32 KiB create:true ceiling BEFORE any
        // write — this must run ahead of createFile() regardless of which of
        // content/from/replace-as-body produced createBody.
        if (Buffer.byteLength(createBody, "utf8") > MAX_CREATE_CONTENT_BYTES) {
          return toolStructuredError(createContentTooLargeRefusal(createBody, "content"));
        }
        const result = await createFile(
          { path: createPath, content: createBody },
          workspace, ALLOW_WRITE, SESSION_ID,
        );
        const createAugmented = await withHandleAugment(result as unknown as Record<string, unknown>);
        // W1 (2026-08-07, create-frontier lifecycle): a created file used to be
        // a second-class citizen the moment it existed — the success payload
        // was {ok,path,bytes} with NO handle, and the path entered no
        // admissible set, so the very next tl_edit_file against it was refused
        // execution-typestate with a frontier that omitted the file this
        // session had just authored (2026-08-07-semantic-signal5-2: a 5-turn
        // re-read of our own fresh bytes, or 6 native-tool escapes in one
        // cell). Mint the SAME kind:"file" handle an equivalent read mints and
        // dedupes to — hashed from the bytes just written, so no re-read — and
        // enroll the path at write time. Applied AFTER withHandleAugment so a
        // create that also carried an unrelated `handle` capability still
        // answers with the handle of the file it actually created.
        let createResponse = createAugmented;
        if (result.ok) {
          const createdSha = shaOfText(createBody);
          const createdHandle = handleTable.upsert({
            kind: "file",
            path: result.path,
            workspaceRoot: workspace,
            sha: createdSha,
          });
          recordCreatedEditAdmissibility(workspace, { handle: createdHandle.id, path: result.path });
          // L3/L4 (2026-08-08, W1 follow-up): a create success used to be
          // SILENT about the file's own geometry — no total_lines, and no
          // way to answer "a compiler/test just cited <path>:<line>" without
          // a native re-read or a second TL round trip (measured: 12 escapes
          // across a 4-run sweep, 58% of them exactly this). total_lines is
          // counted off createBody already in memory — no re-read. read_back
          // is a ready-to-fire slice template over the file THIS call just
          // wrote; only the line range is unknown to the server (the file's
          // identity/location are not), so only `range` is a placeholder —
          // same next_call_is_template convention the EDIT_SEARCH_PLACEHOLDER
          // -style refusal templates use: the marker rides the object, never
          // the arguments.
          createResponse = {
            ...createAugmented,
            ...(singleRootDefaultCreate ? { cwd_source: "server-default" } : {}),
            handle: createdHandle.id,
            sha: shortSha(createdSha),
            total_lines: countLines(createBody),
            read_back: {
              // B1 (v0.12): shortened — same pointer, teaching moved to guide.
              note: "answers a cited line N — fill range",
              next_call_is_template: true,
              next_call: {
                tool: "tl_read_file",
                arguments: { mode: "slice", path: result.path, range: READ_BACK_RANGE_PLACEHOLDER, cwd: workspace },
              },
            },
          };
        } else if (result.error === "file_exists") {
          // W2: the 34-byte dead end becomes a progressive refusal that serves
          // the EXISTING file's identity (see createTargetExistsRefusal).
          createResponse = {
            ...createAugmented,
            ...(await createTargetExistsRefusal(createPath, createBody, workspace)),
          };
        }
        return toolOk(await finishEdit(withReview(createResponse)));
      }

      // Existing schema, new behavior: range handles can replace their line
      // range with content directly, avoiding a large exact search payload.
      if (handleId && handleRange && args["content"] !== undefined && args["search"] === undefined && args["replace"] === undefined) {
        const preCheckRange = await enforcePreconditions(args, effectivePath, workspace, readFileSafeOpt);
        if (!preCheckRange.ok) {
          return toolStructuredError(preCheckRange.failure as unknown as Record<string, unknown>);
        }
        // DESIGN-v0.8 B4.2: read the PRE-edit content so the orphan-tail
        // check below sees the file as it stood before this write (the tail
        // lines it flags are outside [handleRange] and therefore untouched
        // by the replace either way — reading pre- or post-edit content
        // would report the identical tail text, but pre-edit lets this run
        // in parallel with the write below rather than after it).
        // served-bytes: not-served (edit precondition: pre-edit text for the tail/range computation, never emitted)
        const preEditContentForTail = await readFileSafeOpt(filePath, workspace);
        // 2026-08-01 blast-radius precondition (write/blastRadius.ts): a
        // full-range content replacement at whole-file scale must be
        // explicitly acknowledged. precondition:"expected-hash" reaches here
        // only after enforcePreconditions above verified the hash against the
        // live file, so its presence IS the acknowledgment.
        if (args["precondition"] !== "expected-hash" && preEditContentForTail !== null) {
          const blastSpan = parseBlastRange(handleRange);
          const blast = blastSpan === null
            ? null
            : measureBlastRadius({
                fileText: preEditContentForTail,
                spanStart: blastSpan.start,
                spanEnd: blastSpan.end,
                replacementText: String(args["content"] ?? ""),
              });
          if (blast !== null) {
            return toolStructuredError(blastRadiusRefusal({
              path: filePath,
              range: handleRange,
              measure: blast,
              currentSha: shortSha(shaOfText(preEditContentForTail)),
            }));
          }
        }
        const result = replaceRangeContent(
          { path: filePath, range: handleRange, content: String(args["content"] ?? "") },
          workspace,
          ALLOW_WRITE,
          SESSION_ID,
        );
        const augmented = await withHandleAugment(result as unknown as Record<string, unknown>);
        const withOrphanTail = attachOrphanTailWarning(augmented, preEditContentForTail, handleRange);
        return toolOk(await finishEdit(withReview(withOrphanTail)));
      }

      // FIX A (2026-07-12c forensics): a kind:"file" handle (whole-file,
      // NO stored range — minted by e.g. tl_read_file mode=full) used to fall
      // through every branch above (all gated on handleRange) straight to
      // the exact-search fallback far below, where search defaults to "" and
      // hits applySingleEdit's misleading "search string is empty — for new
      // file creation use create:true" (write/textEdit.ts) even though the
      // caller supplied `content` and clearly meant a full-body replace, not
      // file creation. This synthesizes the SAME "1-N" whole-file range a
      // 1-EOF kind:"range" handle already carries (readCodeTaskPack.ts's
      // tinyFileWholeRange mint does this for task_pack candidates) from the
      // file's CURRENT on-disk line count, then reuses the identical
      // range-replace machinery the branch above uses — no new write path.
      // withHandleAugment already special-cases a range-less driving handle
      // (drivingEntry?.range === undefined) to refresh sha only, keeping the
      // handle kind:"file" post-edit, so nothing further is needed there.
      if (
        handleId &&
        !handleRange &&
        args["content"] !== undefined &&
        args["search"] === undefined &&
        args["replace"] === undefined &&
        handleTable.get(handleId)?.kind === "file"
      ) {
        const preCheckFile = await enforcePreconditions(args, effectivePath, workspace, readFileSafeOpt);
        if (!preCheckFile.ok) {
          return toolStructuredError(preCheckFile.failure as unknown as Record<string, unknown>);
        }
        // Read the CURRENT on-disk content to synthesize the whole-file
        // range. A null read (file vanished since the handle was minted)
        // falls through with a syntactically-valid placeholder range —
        // replaceRangeContent's OWN resolveExistingFile check runs BEFORE
        // its bounds check, so it reports the real not-found error itself
        // rather than this call site inventing a second one.
        // served-bytes: not-served (edit precondition: pre-edit text for the whole-file replace, never emitted)
        const preEditContentForFile = await readFileSafeOpt(filePath, workspace);
        const wholeFileRange = preEditContentForFile !== null
          ? `1-${countLines(preEditContentForFile)}`
          : "1-1";
        // 2026-08-01 blast-radius precondition — same acknowledgment contract
        // as the range-handle branch above; a kind:"file" handle + content is
        // BY CONSTRUCTION a whole-file replacement.
        if (args["precondition"] !== "expected-hash" && preEditContentForFile !== null) {
          const blast = measureBlastRadius({
            fileText: preEditContentForFile,
            spanStart: 1,
            spanEnd: countLines(preEditContentForFile),
            replacementText: String(args["content"] ?? ""),
          });
          if (blast !== null) {
            return toolStructuredError(blastRadiusRefusal({
              path: filePath,
              range: wholeFileRange,
              measure: blast,
              currentSha: shortSha(shaOfText(preEditContentForFile)),
            }));
          }
        }
        const result = replaceRangeContent(
          { path: filePath, range: wholeFileRange, content: String(args["content"] ?? "") },
          workspace,
          ALLOW_WRITE,
          SESSION_ID,
        );
        const augmented = await withHandleAugment(result as unknown as Record<string, unknown>);
        // Guaranteed no-op today (the synthesized range always covers every
        // line by construction), kept as defense-in-depth against a
        // concurrent writer growing the file between this read and the
        // write above — see the range-handle branch's identical call.
        const withOrphanTail = attachOrphanTailWarning(augmented, preEditContentForFile, wholeFileRange);
        return toolOk(await finishEdit(withReview(withOrphanTail)));
      }

      // FIX A.3 (2026-07-12c forensics): `tl_edit_file {path, content}` with
      // NO handle and NOT create:true. Every branch below this point reads
      // only args["search"]/args["replace"] (see the P0 comment above) and
      // never args["content"] — so this shape used to silently drop
      // `content`, default search to "", and fall through to the SAME
      // misleading empty-search error as the kind:"file" case above. A
      // MISSING file already gets a clear, unchanged hint from
      // searchReplaceEdit's own not-found branch ("File not found: X. Use
      // create:true to create new files.") — only the EXISTING-file message
      // changes here, to point at the two forms that actually apply.
      if (!handleId && filePath.trim() !== "" && args["content"] !== undefined && args["search"] === undefined && args["create"] !== true) {
        // served-bytes: not-served (edit precondition: existence probe for the refusal message)
        const existingCheckForContentMsg = await readFileSafeOpt(filePath, workspace);
        if (existingCheckForContentMsg !== null) {
          // IL-W5 (DESIGN-v0.15-sf-intent-layers.md §11.2(1)): same
          // auto-resolve as the batch FIX B site above — when this lane
          // already holds the file's full current body, apply through the
          // same whole-file write FIX A (above) uses for a handle-bearing
          // kind:"file" edit: mint (or adopt) the whole-file handle,
          // synthesize the "1-EOF" range, and reuse the identical
          // blast-radius + replaceRangeContent + withHandleAugment path.
          // `handleId` is reassigned here (it is a `let`) so
          // `withHandleAugment`'s closure — which reads it at call time —
          // reports the resolved handle in the response exactly as it would
          // for a caller-supplied handle (existing field, no new one).
          if (hasFullBodyResidencyForAutoResolve(workspace, filePath, existingCheckForContentMsg)) {
            const preCheckAutoResolve = await enforcePreconditions(args, effectivePath, workspace, readFileSafeOpt);
            if (!preCheckAutoResolve.ok) {
              return toolStructuredError(preCheckAutoResolve.failure as unknown as Record<string, unknown>);
            }
            const wholeFileRangeAutoResolve = args["range"] !== undefined
              ? String(args["range"])
              : `1-${countLines(existingCheckForContentMsg)}`;
            const autoResolveSpan = parseBlastRange(wholeFileRangeAutoResolve);
            if (args["precondition"] !== "expected-hash" && autoResolveSpan !== null) {
              const blast = measureBlastRadius({
                fileText: existingCheckForContentMsg,
                spanStart: autoResolveSpan.start,
                spanEnd: autoResolveSpan.end,
                replacementText: String(args["content"] ?? ""),
              });
              if (blast !== null) {
                return toolStructuredError(blastRadiusRefusal({
                  path: filePath,
                  range: wholeFileRangeAutoResolve,
                  measure: blast,
                  currentSha: shortSha(shaOfText(existingCheckForContentMsg)),
                }));
              }
            }
            handleId = handleTable.upsert({
              kind: "file",
              path: filePath,
              workspaceRoot: workspace,
              sha: shaOfText(existingCheckForContentMsg),
            }).id;
            const autoResolveResult = replaceRangeContent(
              { path: filePath, range: wholeFileRangeAutoResolve, content: String(args["content"] ?? "") },
              workspace,
              ALLOW_WRITE,
              SESSION_ID,
            );
            const autoResolveAugmented = await withHandleAugment(autoResolveResult as unknown as Record<string, unknown>);
            const autoResolveWithOrphanTail = attachOrphanTailWarning(autoResolveAugmented, existingCheckForContentMsg, wholeFileRangeAutoResolve);
            return toolOk(await finishEdit(withReview(autoResolveWithOrphanTail)));
          }
          // #28/#29 (C2-6 audit): same gap as the batch site above, closed by
          // the same R5-29 mint.
          //
          // IL-W5 §11.2(2)/(3): name the offending field, keep `retry`
          // sanctioned, and carry an executable canonical `next` — never
          // the legacy `alternatives:[{mode:…}]` menu (a refusal that
          // already carries `next`/`path` never reaches
          // supplyRefusalGuidance's last-resort derivation).
          return toolStructuredError({
            ok: false,
            error: FILE_EXISTS_FULL_BODY_MSG,
            code: "write-intent-ambiguous",
            field: "content",
            retry: "call",
            path: filePath,
            next: writeIntentAmbiguousRecoveryNext(workspace, filePath, existingCheckForContentMsg),
          });
        }
        // Missing file: fall through unchanged to searchReplaceEdit's own
        // not-found + create:true hint further below.
      }

      // Existing schema, new behavior: target="all" on a range handle applies a
      // scoped replace-all. This keeps large repetitive replacements tiny.
      if (handleId && handleRange && args["target"] === "all" && typeof args["search"] === "string") {
        const inspection = inspectRangeEditTarget(filePath, workspace, ALLOW_WRITE);
        if (!inspection.ok) {
          return toolOk(await finishEdit(withReview(await withHandleAugment(inspection as unknown as Record<string, unknown>))));
        }
        const preCheckRangeAll = await enforcePreconditions(args, effectivePath, workspace, readFileSafeOpt);
        if (!preCheckRangeAll.ok) {
          return toolStructuredError(preCheckRangeAll.failure as unknown as Record<string, unknown>);
        }
        const span = parseBlastRange(handleRange);
        if (span !== null && args["precondition"] === "unique-match") {
          const refusal = uniqueMatchRefusalInScope({
            fileText: inspection.text,
            search: args["search"],
            path: filePath,
            workspace,
            range: span,
          });
          if (refusal !== undefined) return toolStructuredError(refusal);
        }
        if (span !== null && args["precondition"] !== "expected-hash") {
          const scopedText = textForLineRange(inspection.text, span);
          const blast = measureReplaceAllBlastRadius({
            fileText: scopedText,
            search: args["search"],
            replace: String(args["replace"] ?? ""),
          });
          if (blast !== null) {
            return toolStructuredError(blastRadiusRefusal({
              path: filePath,
              range: handleRange,
              measure: blast,
              currentSha: shortSha(shaOfText(inspection.text)),
            }));
          }
        }
        const result = replaceAllInRange(
          { path: filePath, range: handleRange, search: String(args["search"]), replace: String(args["replace"] ?? "") },
          workspace,
          ALLOW_WRITE,
          SESSION_ID,
        );
        return toolOk(await finishEdit(withReview(await withHandleAugment(result as unknown as Record<string, unknown>))));
      }

      // ------------------------------------------------------------------
      // Pathless mode: path is absent/empty — delegate to workspace-scanned helpers.
      // Must be checked BEFORE the pathful symbol+search and single-file fallbacks.
      // ------------------------------------------------------------------
      // Pathless is when neither explicit path nor handle path was provided.
      const isPathless = filePath.trim() === "";

      if (isPathless) {
        // Preconditions for pathless branches.
        const preCheckPathless = await enforcePreconditions(args, effectivePath, workspace, readFileSafeOpt);
        if (!preCheckPathless.ok) {
          return toolStructuredError(preCheckPathless.failure as unknown as Record<string, unknown>);
        }

        const lang = parseMcpLang(args["lang"]);
        // In the pathless branch, the handle resolved no path, so we use only args["symbol"].
        const symbolArg = args["symbol"];
        const searchArg = args["search"];
        const replaceArg = String(args["replace"] ?? "");

        if (typeof symbolArg === "string" && symbolArg.trim() !== "" && typeof searchArg === "string") {
          const result = await pathlessSymbolEdit(workspace, ALLOW_WRITE, SESSION_ID, {
            symbol: symbolArg,
            search: searchArg,
            replace: replaceArg,
            ...(lang ? { lang } : {}),
          });
          return toolOk(await finishEdit(withReview(await withHandleAugment(result as unknown as Record<string, unknown>))));
        }

        if (typeof searchArg === "string" && searchArg.trim() !== "") {
          const result = await pathlessExactEdit(workspace, ALLOW_WRITE, SESSION_ID, {
            search: searchArg,
            replace: replaceArg,
            ...(lang ? { lang } : {}),
          });
          return toolOk(await finishEdit(withReview(await withHandleAugment(result as unknown as Record<string, unknown>))));
        }
      }

      // M1 / DESIGN-v0.14 §6: a path+search `target:"all"` is an explicit
      // request to replace every occurrence, not a unique-match fallback.
      // Reuse the range primitive over the complete validated file so the
      // handle-scoped route and this path route share write/encoding/atomic
      // behavior and report the actual replacement count.
      if (!isPathless && args["target"] === "all" && typeof args["search"] === "string") {
        const inspection = inspectRangeEditTarget(filePath, workspace, ALLOW_WRITE);
        if (!inspection.ok) {
          return toolOk(await finishEdit(withReview(await withHandleAugment(inspection as unknown as Record<string, unknown>))));
        }
        const preCheckAll = await enforcePreconditions(args, effectivePath, workspace, readFileSafeOpt);
        if (!preCheckAll.ok) return toolStructuredError(preCheckAll.failure as unknown as Record<string, unknown>);

        let editRange = { start: 1, end: Math.max(1, countLines(inspection.text)) };
        if (args["symbol"] != null) {
          const symbol = await getSymbolWithContext(inspection.text, {
            path: filePath,
            symbol: String(args["symbol"]),
          });
          if (!symbol.ok) return toolStructuredError(symbol as unknown as Record<string, unknown>);
          editRange = symbol.data.range;
        }
        const range = String(editRange.start) + "-" + String(editRange.end);
        if (args["precondition"] === "unique-match") {
          const refusal = uniqueMatchRefusalInScope({
            fileText: inspection.text,
            search: args["search"],
            path: filePath,
            workspace,
            range: editRange,
          });
          if (refusal !== undefined) return toolStructuredError(refusal);
        }
        if (args["precondition"] !== "expected-hash") {
          const scopedText = textForLineRange(inspection.text, editRange);
          const blast = measureReplaceAllBlastRadius({
            fileText: scopedText,
            search: args["search"],
            replace: String(args["replace"] ?? ""),
          });
          if (blast !== null) {
            return toolStructuredError(blastRadiusRefusal({
              path: filePath,
              range,
              measure: blast,
              currentSha: shortSha(shaOfText(inspection.text)),
            }));
          }
        }
        const result = replaceAllInRange(
          {
            path: filePath,
            range,
            search: args["search"],
            replace: String(args["replace"] ?? ""),
          },
          workspace,
          ALLOW_WRITE,
          SESSION_ID,
        );
        return toolOk(await finishEdit(withReview(await withHandleAugment(result as unknown as Record<string, unknown>))));
      }

      // symbol+search branch: only when args["symbol"] is EXPLICITLY provided by the caller.
      // handleSymbol from a handle is not enough to enter this branch — it would reroute
      // to readAndEdit which returns a different response shape.
      if (args["symbol"] != null && args["search"] != null) {
        // Preconditions for symbol+search branch.
        const preCheckSym = await enforcePreconditions(args, effectivePath, workspace, readFileSafeOpt);
        if (!preCheckSym.ok) {
          return toolStructuredError(preCheckSym.failure as unknown as Record<string, unknown>);
        }

        const result = await readAndEdit(
          {
            path: filePath,
            symbol: String(args["symbol"]),
            search: String(args["search"]),
            replace: String(args["replace"] ?? ""),
          },
          workspace, ALLOW_WRITE,
        );
        return toolOk(await finishEdit(withReview(await withHandleAugment(result as unknown as Record<string, unknown>))));
      }

      // -----------------------------------------------------------------------
      // Single-file exact edit (search/replace).
      // D.3: unique-match check for single-file exact edits.
      // Phase 4: auto-mint handle for unique matches; allowPathFallback gate.
      // -----------------------------------------------------------------------
      const search = String(args["search"] ?? "");
      const replace = String(args["replace"] ?? "");

      // Enforce preconditions (expected-hash, scope-handle) before the edit.
      const preCheckSingle = await enforcePreconditions(args, effectivePath, workspace, readFileSafeOpt);
      if (!preCheckSingle.ok) {
        return toolStructuredError(preCheckSingle.failure as unknown as Record<string, unknown>);
      }

      // D.3: unique-match check — when precondition=unique-match, verify the
      // search string occurs exactly once in the file before writing.
      if (args["precondition"] === "unique-match" && filePath && search) {
        // served-bytes: not-served (unique-match precondition: occurrence COUNTING, never emitted)
        const fileContent = await readFileSafe(filePath, workspace);
        if (fileContent !== null) {
          // Normalize line endings for matching (same as applySingleEdit).
          const normalized = fileContent.replace(/\r\n/g, "\n").replace(/\r/g, "\n").normalize("NFC");
          const normalizedSearch = search.replace(/\r\n/g, "\n").replace(/\r/g, "\n").normalize("NFC");

          let count = 0;
          let idx = normalized.indexOf(normalizedSearch);
          const matchLines: number[] = [];
          while (idx !== -1) {
            count++;
            // Compute 1-based line number of this match.
            const lineNum = normalized.slice(0, idx).split("\n").length;
            matchLines.push(lineNum);
            idx = normalized.indexOf(normalizedSearch, idx + normalizedSearch.length);
            if (count > 3) break; // cap scanning at 4
          }

          if (count === 0 || count > 1) {
            // Mint handles for up to 3 match lines.
            const matches = matchLines.slice(0, 3).map((lineNum) => {
              const h = handleTable.upsert({
                kind: "range",
                path: filePath,
                range: `${lineNum}-${lineNum}`,
                workspaceRoot: workspace,
              });
              return { handle: h.id, path: filePath, line: lineNum };
            });
            return toolStructuredError({
              ok: false,
              // 2026-11-02 (v0.16.4 field evaluation): zero matches are `not-found`.
              reason: count === 0 ? "not-found" : "search-not-unique",
              ...(count === 0 ? alreadyAppliedForensics(normalized, normalizedSearch, typeof args["replace"] === "string" ? args["replace"] : "") : {}),
              ...(matches.length > 0 ? { matches } : {}),
            });
          }
        }
      }

      // Phase 4 auto-mint: when no handle and no expectedSha are provided, check
      // if the search string is unique in the file and auto-mint a file handle.
      // This makes handle-backed writes the easy path without requiring a prior read.
      let autoMintedHandleId: string | null = null;
      if (!handleId && !args["expectedSha"] && filePath && search) {
        // served-bytes: not-served (auto-mint precondition: occurrence COUNTING, never emitted)
        const fileContent = await readFileSafe(filePath, workspace);
        if (fileContent !== null) {
          const normalized = fileContent.replace(/\r\n/g, "\n").replace(/\r/g, "\n").normalize("NFC");
          const normalizedSearch = search.replace(/\r\n/g, "\n").replace(/\r/g, "\n").normalize("NFC");
          let count = 0;
          const matchLines: number[] = [];
          let idx2 = normalized.indexOf(normalizedSearch);
          while (idx2 !== -1) {
            count++;
            matchLines.push(normalized.slice(0, idx2).split("\n").length);
            idx2 = normalized.indexOf(normalizedSearch, idx2 + normalizedSearch.length);
            if (count > 1) break;
          }

          // A file handle does not disambiguate two occurrences in the same
          // file. Mint range candidates for the matching lines, and prescribe
          // an edit only when the chosen range itself proves a unique match.
          // Otherwise the only honest executable transition is to read the
          // candidate and add context.
          const recoveryForNonUnique = (): {
            candidates: Array<{ handle: string; path: string; line?: number }>;
            next: ToolCall;
            directEdit: boolean;
          } => {
            const normalizedLines = normalized.split("\n");
            const candidateLines = matchLines.filter((line, index, lines) => lines.indexOf(line) === index).slice(0, 3);
            const rangeCandidates = candidateLines.map((line) => {
              const handle = handleTable.upsert({
                kind: "range",
                path: filePath,
                range: `${line}-${line}`,
                workspaceRoot: workspace,
              });
              return { handle: handle.id, path: filePath, line };
            });
            const candidates: Array<{ handle: string; path: string; line?: number }> = rangeCandidates.length > 0
              ? rangeCandidates
              : [handleTable.upsert({ kind: "file", path: filePath, workspaceRoot: workspace })]
                .map((handle) => ({ handle: handle.id, path: filePath }));
            const directCandidate = rangeCandidates.find(({ line }) => {
              const lineText = normalizedLines[line - 1] ?? "";
              let scopedCount = 0;
              let scopedIndex = lineText.indexOf(normalizedSearch);
              while (scopedIndex !== -1) {
                scopedCount++;
                scopedIndex = lineText.indexOf(normalizedSearch, scopedIndex + normalizedSearch.length);
                if (scopedCount > 1) break;
              }
              return scopedCount === 1;
            });
            return directCandidate !== undefined
              ? {
                  candidates,
                  next: canonicalToolCall("tl_edit_file", {
                    edits: [{
                      handle: directCandidate.handle,
                      search,
                      replace,
                      precondition: "unique-match",
                    }],
                  }),
                  directEdit: true,
                }
              : {
                  candidates,
                  next: canonicalToolCall("tl_read_file", {
                    targets: [{ handle: candidates[0]!.handle }],
                    content: "full",
                  }),
                  directEdit: false,
                };
          };

          if (count === 1) {
            // Unique match — mint a file handle before applying the write.
            const fileSha = shaOfText(fileContent);
            const minted = handleTable.upsert({ kind: "file", path: filePath, workspaceRoot: workspace, sha: fileSha });
            autoMintedHandleId = minted.id;
          } else if (args["allowPathFallback"] === false) {
            const recovery = recoveryForNonUnique();
            return toolStructuredError({
              ok: false,
              reason: "handle-required",
              path: filePath,
              candidates: recovery.candidates,
              next: recovery.next,
              detail: recovery.directEdit
                ? `retry the complete edit against range handle ${recovery.candidates[0]!.handle}`
                : `inspect candidate handle ${recovery.candidates[0]!.handle} and add surrounding context before retrying`,
            });
          } else {
            // Non-unique match, no explicit allowPathFallback=false, but adaptive session
            // control may require lockdown when the agent has demonstrated handle use but
            // keeps regressing to path edits.
            if (args["allowPathFallback"] !== true) {
              const adaptiveAdvice = getAdaptiveAdvice(workspace);
              if (adaptiveAdvice.lockdownPathEdits) {
                const recovery = recoveryForNonUnique();
                return toolStructuredError({
                  ok: false,
                  reason: "handle-required-lockdown",
                  path: filePath,
                  candidates: recovery.candidates,
                  next: recovery.next,
                  detail: recovery.directEdit
                    ? `path-edit loop detected; retry the complete edit against range handle ${recovery.candidates[0]!.handle}`
                    : `path-edit loop detected; inspect candidate handle ${recovery.candidates[0]!.handle} and add surrounding context`,
                });
              }
            }
          }
        }
      }

      const result = await searchReplaceEdit(
        // FIX 2d: create:true is tl_edit_file's ADVERTISED name for this. C-6
        // removed the silent `allow_create` legacy alias from this tool's
        // request surface (see createDispatchRequested above); `allow_create`
        // here is the ENGINE option name, fed only from the advertised
        // `create`. (In today's control flow this branch is reached only when
        // create is NOT true — the args["create"] === true branch above always
        // returns first — so this is currently a no-op; kept because the engine
        // signature still takes the option. D11 deleted the search_replace_edit
        // dispatch site this used to mirror.)
        { path: filePath, search, replace, allow_create: args["create"] === true },
        workspace, ALLOW_WRITE,
      );

      // v0.14.1 defect 2 fix (2026-09-07): the 2026-07-12 audit hint that used
      // to live here (worded in the legacy `tl_read_file mode=slice` spelling)
      // is now dead AND wrong: the top-level `args["target"] === "all"`
      // branches above already intercept every reachable `target:"all"` +
      // string `search` combination on this dispatch path before execution
      // gets here, and the edits[] batch
      // sibling (tools/applyEditsMulti.ts's applyEditStep) now honors
      // target:"all" directly for a path-based or range-less-handle item —
      // so "only replaces every occurrence when scoped to a range handle"
      // is no longer true even in the hypothetical case this line fired.
      // Removed rather than rewritten: nothing reaches it to rewrite for.

      // If auto-mint succeeded and the edit succeeded, record as handle-backed and
      // include the handle id in the response.
      if (autoMintedHandleId) {
        const r = result as { ok?: boolean };
        if (r.ok !== false) {
          recordHandleEdit(workspace);
          // DESIGN-v0.8 B3.2/B3.3: the handle above was minted BEFORE the
          // write with the PRE-edit sha (line ~9495) — stale by
          // construction the instant the write below succeeds. Refresh it
          // to the POST-edit sha via refreshSha (re-keys the canonical
          // mapping; see its doc comment) so a follow-up expected-hash
          // precondition using THIS response's sha succeeds instead of
          // bouncing off a hash-mismatch caused by the server's own stale
          // mint. This auto-mint path only ever mints a whole-file (no
          // range) handle, so there is no range to shift — sha only, same
          // as withHandleAugment's non-range case.
          // served-bytes: not-served (post-edit sha refresh only)
          const autoPostContent = await readFileSafe(filePath, workspace);
          const autoPostSha = autoPostContent !== null ? shaOfText(autoPostContent) : undefined;
          if (autoPostSha !== undefined) {
            handleTable.refreshSha(autoMintedHandleId, autoPostSha);
          }
          return toolOk(await finishEdit(withReview({
            ...(result as Record<string, unknown>),
            handle: autoMintedHandleId,
            ...(autoPostSha !== undefined ? { sha: shortSha(autoPostSha) } : {}),
            // INV-I-5 (FX-P2): additive disclosure that this applied edit
            // landed via a path fallback from a stale handle, not through
            // the handle the caller originally addressed. editFamily.ts's
            // editedRows() carries this key onto the row it builds from
            // `body.path`, so it surfaces as `AppliedEntry.path_fallback` in
            // the wire `applied[]` — never emitted when false/absent.
            ...(pathFallbackApplied ? { path_fallback: true } : {}),
          })));
        }
      }

      // Path-edit without handle: record as path/search edit.
      if (!handleId && !autoMintedHandleId) {
        const r = result as { ok?: boolean };
        if (r.ok !== false) {
          recordPathSearchEdit(workspace);
        }
      }

      // On search-not-found or ambiguous failure, mint candidate handles from
      // top-level symbols in the target file to steer the agent toward handles.
      const resultRec = result as { ok?: boolean; code?: string; candidates?: unknown[]; detail?: string };
      if (resultRec.ok === false && resultRec.code === "not-found") {
        resultRec.detail =
          "search string may come from synthetic read-response display (snippet/map/skeleton); anchor on an actual file line";
      }
      if (resultRec.ok === false && (resultRec.code === "not-found" || resultRec.code === "ambiguous")) {
        if (!resultRec.candidates && filePath) {
          // served-bytes: not-served (edit-failure candidates: skeleton -> top-level symbol NAMES, no file text)
          const candidateContent = await readFileSafe(filePath, workspace);
          if (candidateContent !== null) {
            const skelForCandidates = await getFileSkeleton(candidateContent, { path: filePath });
            const rawCandidates: Array<{ handle: string; kind: string; path: string; symbol?: string }> = [];
            if (skelForCandidates.ok && skelForCandidates.data) {
              // Extract top-level symbol names from the skeleton (up to 3).
              const skelText = typeof skelForCandidates.data === "object"
                ? (skelForCandidates.data as { skeleton?: string }).skeleton ?? ""
                : "";
              // Match TypeScript/JS/Python/Go top-level declarations.
              const symMatch = skelText.matchAll(
                /(?:^|\n)\s*(?:export\s+)?(?:function|class|interface|type|const|enum|def|func)\s+([A-Za-z_][A-Za-z0-9_]*)/g,
              );
              const seenSym = new Set<string>();
              for (const m of symMatch) {
                const sym = m[1];
                if (!sym || seenSym.has(sym)) continue;
                seenSym.add(sym);
                const h = handleTable.upsert({ kind: "symbol", path: filePath, symbol: sym, workspaceRoot: workspace });
                rawCandidates.push({ handle: h.id, kind: "symbol", path: filePath, symbol: sym });
                if (rawCandidates.length >= 3) break;
              }
            }
            // Fallback: a plain file handle if no symbols found.
            if (rawCandidates.length === 0) {
              const h = handleTable.upsert({ kind: "file", path: filePath, workspaceRoot: workspace });
              rawCandidates.push({ handle: h.id, kind: "file", path: filePath });
            }

            // Cap candidates so total response stays under 512 bytes.
            const MAX_RESPONSE_BYTES = 512;
            let candidates = rawCandidates.slice(0, 3);
            let merged = { ...resultRec, candidates };
            while (
              Buffer.byteLength(JSON.stringify(merged), "utf8") > MAX_RESPONSE_BYTES &&
              candidates.length > 1
            ) {
              candidates = candidates.slice(0, -1);
              merged = { ...resultRec, candidates };
            }
            return toolOk(merged as Record<string, unknown>);
          }
        }
      }

      // INV-I-5 (FX-P2): the auto-mint branch above returns first whenever it
      // applies; this is the fallthrough for a path-fallback edit that
      // succeeded WITHOUT going through auto-mint (e.g. `expectedSha` was
      // also supplied, which skips the Phase-4 auto-mint block entirely).
      // Same additive marker, same "only when actually applied" guard.
      const pathFallbackResult = pathFallbackApplied && (result as { ok?: boolean }).ok !== false
        ? { ...(result as Record<string, unknown>), path_fallback: true }
        : result;
      return toolOk(await finishEdit(withReview(await withHandleAugment(pathFallbackResult as unknown as Record<string, unknown>))));


}
