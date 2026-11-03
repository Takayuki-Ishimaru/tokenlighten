import type { ToolCallResult } from "../../protocol/result.js";
import { requestShapeRefusal } from "../../validation/requestShape.js";
import { toolStructuredError, toolOk, toolError } from "../../protocol/result.js";
import { noteResolvedAction, notePostReadyDiscovery, noteEpochNewRoot, noteServedBytesSource, canonicalToolCall, declareKind } from "../../protocol/envelope.js";
import { guardCwd } from "../../write/guardedWorkspace.js";
import { activeRoot, ALLOW_WRITE, DOC_DISABLED } from "../../runtime/config.js";
import { resolveCredentialRef } from "../../security/credentials.js";
import { getExecutionFence, guardExecutionDiscovery, recordConcernTokens, recordSingleFindCompletion, recordReadMode } from "../../state/session.js";
import { selectorFromArgs, splitArchiveVirtualPath, isSupportedArchivePath, archiveTreeListing, findInArchive } from "../../tools/archive.js";
import { type ArchiveTreeRequest, type ArchiveTreeAdmission, admitArchiveTreeCursor, buildArchiveTreePage } from "../../tools/archiveTreePage.js";
import { currentSessionLane } from "../../util/laneKey.js";
import { readBytesSafe } from "../../util/safePath.js";
import { effWideFindEnabled, findSmallBodiesEnabled } from "../../util/flags.js";
import { filterConcernQueryEntries, concernHarvestText } from "../../features/task-pack/engine/roleAndConcernScope2.js";
import { concernAnchorTokens } from "../../features/task-pack/engine/roleAndConcernScope3.js";
import { buildTaskPack } from "../../features/task-pack/engine/taskPackEntry.js";
import { resolveCallerByteCeiling } from "../../tools/readCodeModes.js";
import { buildFindResponseForQueries, attachSmallFileContexts, buildFindResponse } from "../../features/search/find/findText.js";
import { hasPendingExecutableNext, consumeExecutableNextScope, recordAuthoritativeAbsentConcerns, recordServedConcernEvidence } from "../../features/task-pack/taskContractStore.js";
import { maybeAttachMemberSweepToFindResponse } from "../../features/search/find/memberSweep.js";
import { maybeAttachRelatedLookups } from "../../features/search/find/relatedLookups.js";
import { recordExecutedSearch, type ExecutedSearchHit, clearFunctionalValidationObligation, recordExecutedLocate } from "../../util/packServeLog.js";
import { parseHandlePurposeFromPrefix } from "@tokenlighten/types";
import { findReferences } from "../../tools/findReferences.js";
import { searchSymbols } from "../../tools/searchSymbols.js";
import { getCurrentDiff } from "../../tools/getCurrentDiff.js";
import { inheritedTaskProfileArgs } from "../../runtime/requestState.js";
import { attachSupply } from "../../util/attachSupply.js";
import { locateTaskContext } from "../../features/locator/locateTaskContext.js";
import { buildTreeResponse } from "../../tools/exploreTree.js";
import { extractOfficeText } from "../../tools/extractOfficeText.js";
import { SEARCH_FILES_CANONICAL_ACTIONS } from "../../protocol/searchFamily.js";
import { dispatchPropertiesFor } from "../../serverOwned/tool-schema.js";
import { withPublicRecoveryKeys } from "../../serverOwned/edit-validation.js";
import { resolveWorkspaceRoot, parseMcpLang, officeOrArchiveSurfaceRefusal, parseTaskProfile } from "../../serverOwned/read-admission2.js";
import { recoverAuthFailedTaskHandle, dropDeadTaskHandleForNewEpoch, serveSearchCursorPage, annotateServedFindHits, stageSearchRequestForFind, serveSymbolCursorPage, symbolSearchBudget, symbolPageItems, stageSymbolSearchPage } from "../../serverOwned/search-support.js";
import { taskHandleRefusal } from "../../serverOwned/search-support2.js";
import { discoveryScopeClass } from "../../serverOwned/canonical-input4.js";
import { noteReadFamilySerialSingleTargetCall, FIND_HINT_TEXT } from "../../serverOwned/workspace-routing.js";
import { addressServedReceipt } from "../../serverOwned/read-receipts.js";
import { EFF_TOLERANT_QUERY_CAP } from "../../serverOwned/verification2.js";
import { provenFindAbsence, sessionLaneOf, termSearchWasPrescribed, findResponseHits, recordTermSearchResult, canonicalTaskBindingOf } from "../../serverOwned/task-binding2.js";
import { taskPackAdmission } from "../../serverOwned/read-admission.js";
import { SMALL_WINDOW_RESERVE_FORCE } from "../../serverOwned/canonical-input.js";
import { recordTaskPackSurfaceReads, projectTaskPackWire } from "../../serverOwned/task-pack-wire.js";

export interface dispatchSearchPort {
  "args": Record<string, unknown>;
  "defaultResponseByteCeiling": number | undefined;
}
export async function dispatchSearch(port: dispatchSearchPort): Promise<ToolCallResult | undefined> {
  const { args, defaultResponseByteCeiling } = port;

      // P1 / D2 / ORCHESTRATOR CONDITION ② (§1.3.1(1)) — see the tl_read_file arm.
      const unknownArgsRefusalSearch = requestShapeRefusal("tl_search_files", dispatchPropertiesFor("tl_search_files"), args);
      if (unknownArgsRefusalSearch !== null) {
        // FX-R3: strip legacy-only keys from the disclosed recovery list —
        // see `advertisedKeysForRefusal`'s doc comment.
        return toolStructuredError(withPublicRecoveryKeys("tl_search_files", unknownArgsRefusalSearch));
      }
      const action = String(args["action"] ?? "");
      // protocol v1 (D4): A.5.8-A.5.10 map the four match actions onto
      // `search.matches`, `references` onto `search.references`, and `tree`
      // onto `search.tree`.
      noteResolvedAction(action);
      // B5.1: fail loud on an invalid/nonexistent cwd instead of silently
      // resolving against the pinned root (see checkCwdOrRefuse doc comment).
      const cwdGuardExplore = guardCwd(args, activeRoot);
      if (!cwdGuardExplore.ok) return toolStructuredError(cwdGuardExplore.refusal);
      const workspace = resolveWorkspaceRoot(args["cwd"] as string | undefined, activeRoot);
      // TL_TASK_HANDLE_RECOVERY — see the tl_read_file arm /
      // recoverAuthFailedTaskHandle's own doc comment.
      recoverAuthFailedTaskHandle(args, workspace, "tl_search_files");
      dropDeadTaskHandleForNewEpoch(args, workspace, "tl_search_files");
      // PI-09 — see the tl_read_file arm.
      const taskHandleRefusalSearch = taskHandleRefusal(args, workspace, "tl_search_files");
      if (taskHandleRefusalSearch !== null) return toolStructuredError(taskHandleRefusalSearch);
      const credential = resolveCredentialRef(args["credentialRef"]);
      if (!credential.ok) {
        return toolStructuredError(credential as unknown as Record<string, unknown>);
      }
      const searchTaskCredential =
        credential.credentialRef !== undefined && credential.password !== undefined
          ? {
              credentialRef: credential.credentialRef,
              credentialPassword: credential.password,
            }
          : {};
      const lang = parseMcpLang(args["lang"]);
      // I-7 (2026-08-30 forensics attribution wave): see the tl_read_file arm's
      // own comment -- same pre-guard snapshot, same rationale.
      if (args["taskEpoch"] !== "new" && getExecutionFence(workspace)?.phase === "prepared") {
        notePostReadyDiscovery({
          forceServe: args["force_serve"] === true,
          scopeClass: discoveryScopeClass(args),
        });
      }
      const executionGuard = guardExecutionDiscovery(workspace, "tl_search_files", args);
      // 2026-10-20 (decision run 6t-8): see the tl_read_file arm's own comment.
      if (args["taskEpoch"] === "new") noteEpochNewRoot(workspace);
      // W-BATCH-HINT candidate 3: see the tl_read_file arm's own comment — same
      // unconditional recording, same rationale.
      noteReadFamilySerialSingleTargetCall(workspace, "tl_search_files", action, args);
      if (!executionGuard.allowed) {
        if ("servedReceipt" in executionGuard) {
          noteServedBytesSource("dedup");
          return toolOk(addressServedReceipt(executionGuard.servedReceipt, workspace));
        }
        return toolStructuredError(executionGuard.refusal);
      }

      const archiveSelector = selectorFromArgs(args);
      const explicitSearchPath = args["path"] !== undefined ? String(args["path"]) : undefined;
      const virtualSearch = explicitSearchPath ? splitArchiveVirtualPath(explicitSearchPath) : undefined;
      const archiveSearchPath = archiveSelector?.path
        ?? virtualSearch?.outerPath
        ?? (explicitSearchPath && isSupportedArchivePath(explicitSearchPath) ? explicitSearchPath : undefined);
      const archivePrefix = archiveSelector?.prefix ?? archiveSelector?.member ?? virtualSearch?.member;
      if (archiveSearchPath && (action === "find" || action === "tree")) {
        // DESIGN-v0.15 §8.2 (R7 Part B): searching/listing inside a zip archive
        // is archive capability — gate it here, since `archiveSearchPath` can
        // be derived purely from a plain `.zip` path extension with no
        // advertised full-only field present.
        const archiveSearchSurfaceRefusal = officeOrArchiveSurfaceRefusal();
        if (archiveSearchSurfaceRefusal !== undefined) {
          return toolStructuredError({ ok: false, code: archiveSearchSurfaceRefusal.code, error: archiveSearchSurfaceRefusal.error });
        }
        // ATP (2026-10-10): an archive-scoped tree pages its member listing to
        // the caller's `budget.bytes`/`budget.tokens` (the legacy 200-member
        // page when neither is declared) — tools/archiveTreePage.ts. A page
        // that stops short carries a cursor continuation, and a `cursor` is
        // authenticated and held to THIS call's archive path and prefix before
        // the archive is read.
        let archiveTreeRequest: ArchiveTreeRequest | undefined;
        let archiveTreeAdmission: ArchiveTreeAdmission | undefined;
        if (action === "tree") {
          const callerCwd = typeof args["cwd"] === "string" ? args["cwd"] : "";
          const treeLane = currentSessionLane();
          archiveTreeRequest = {
            outerPath: archiveSearchPath,
            ...(archivePrefix !== undefined ? { prefix: archivePrefix } : {}),
            ...(typeof args["cursor"] === "string" && args["cursor"] !== "" ? { cursor: args["cursor"] } : {}),
            budget: {
              ...(typeof args["maxBytes"] === "number" ? { bytes: args["maxBytes"] } : {}),
              ...(typeof args["maxTokens"] === "number" ? { tokens: args["maxTokens"] } : {}),
            },
            ...(credential.credentialRef !== undefined ? { credentialRef: credential.credentialRef } : {}),
            // Priced at the longer of the caller's cwd and the resolved root,
            // as the workspace tree prices it.
            echo: {
              cwd: callerCwd.length > workspace.length ? callerCwd : workspace,
              ...(treeLane !== "" ? { lane: treeLane } : {}),
              ...(typeof args["task_handle"] === "string" ? { taskHandle: args["task_handle"] } : {}),
            },
            fields: archiveSelector !== undefined
              ? {
                  path: "scope.archive.path",
                  prefix: archiveSelector.prefix === undefined && archiveSelector.member !== undefined
                    ? "scope.archive.member"
                    : "scope.archive.prefix",
                }
              : { path: "scope.path", prefix: "scope.path" },
          };
          archiveTreeAdmission = admitArchiveTreeCursor(workspace, archiveTreeRequest);
          if (!archiveTreeAdmission.ok) return toolStructuredError(archiveTreeAdmission.refusal);
        }
        // served-bytes: not-served (archive search container bytes: the member gate lives in readArchiveMember)
        const archiveBytes = await readBytesSafe(archiveSearchPath, workspace);
        if (archiveBytes === null) {
          return toolStructuredError({
            ok: false,
            code: "archive-not-found",
            error: `File not found or outside workspace: ${archiveSearchPath}`,
          });
        }
        if (archiveTreeRequest !== undefined) {
          const treeListing = await archiveTreeListing(
            archiveBytes,
            archiveSearchPath,
            workspace,
            archivePrefix,
            credential.password,
          );
          if (!treeListing.ok) return toolStructuredError(treeListing as unknown as Record<string, unknown>);
          const treePage = buildArchiveTreePage(
            workspace,
            archiveTreeRequest,
            treeListing.data,
            archiveTreeAdmission?.ok === true ? archiveTreeAdmission.resume : undefined,
          );
          // D4 / A.5.10 (C2-4): the `mode:"tree"` stamp is DELETED. `kind` is
          // the sole discrimination contract, and this response's kind is
          // `search.tree`; a second, differently-spelled discriminator is the
          // probe-by-field-presence D4 exists to remove.
          return treePage.kind === "body"
            ? toolOk({ ...treePage.body })
            : toolStructuredError(treePage.refusal);
        }
        const archiveQuery = args["query"] !== undefined
          ? String(args["query"])
          : Array.isArray(args["queries"])
            ? (args["queries"] as unknown[]).map(String).join(" ")
            : "";
        if (!archiveQuery) return toolError("tl_search_files find: query or queries is required");
        const findResult = await findInArchive(
          archiveBytes,
          archiveSearchPath,
          archiveQuery,
          workspace,
          credential.password,
        );
        return findResult.ok
          ? toolOk(findResult.data)
          : toolStructuredError(findResult as unknown as Record<string, unknown>);
      }

      // queries[] (multi-token OR search, findText.ts buildFindResponseForQueries) is find-only.
      if (args["queries"] !== undefined && action !== "find") {
        return toolError(`queries is only valid with action=find (got action=${action || "<empty>"}); drop queries or use action=find`, { code: "invalid-input" });
      }

      if (action === "find") {
        // DESIGN-v0.15 §6.1 (R3): a `find` cursor is served ENTIRELY from the
        // staged search-request snapshot — it never re-enters the ordinary
        // producers below and never builds a `tl_read_file` escalation. Checked
        // before the query/queries validation below, exactly as tl_read_file's
        // cursor is checked before its own targets/content validation.
        const rawSearchCursor = args["cursor"];
        if (typeof rawSearchCursor === "string" && rawSearchCursor !== "") {
          return await serveSearchCursorPage(rawSearchCursor, args, workspace);
        }
        const rawQueries = args["queries"];
        const hasQueries = rawQueries !== undefined;
        const queryStr = args["query"] !== undefined && args["query"] !== null ? String(args["query"]) : "";
        const hasQuery = queryStr.length > 0;

        if (hasQueries && hasQuery) {
          return toolError("tl_search_files find: pass exactly one of query or queries, not both", { code: "invalid-input" });
        }
        // EFF (TL_EFF_WIDE_FIND, default ON since 2026-10-18): the per-call cap.
        const queryCap = effWideFindEnabled() ? EFF_TOLERANT_QUERY_CAP : 5;
        if (!hasQueries && !hasQuery) {
          return toolError(`tl_search_files find: query or queries is required (queries: 1-${queryCap} literal tokens, OR-matched)`, { code: "invalid-input" });
        }

        if (hasQueries) {
          if (!Array.isArray(rawQueries) || rawQueries.length === 0) {
            return toolError(`queries must be a non-empty array of 1-${queryCap} literal tokens`, { code: "invalid-input" });
          }
          if (rawQueries.length > queryCap) {
            // D4 (2026-08-01 probe sweep): the generic refusal guidance used to
            // misroute this to task_pack; the correct remedy is splitting the
            // SAME find into calls within the cap, so name it explicitly (an
            // explicit `next` wins over the derived default).
            //
            // FIELD DEFECT (2026-08-27 field-eval T2): `next` only ever named
            // the first tokens up to the cap — the remaining tail was named solely in
            // `hint`'s prose (a COUNT, not the tokens themselves), so a caller
            // had to hand-slice its own original `queries[]` to build the
            // second call. `remaining_queries` carries the exact tail, in the
            // same stringified form `next`'s `head` uses, so the follow-up
            // call needs no slicing. Named distinctly from the top-level
            // `Refusal.remaining` STRING slot (A.5.15, protocol/refusal.ts's
            // `remainingOf`) it rides beside — that slot drops array values,
            // so this is a separate advisory key, allowlisted in
            // protocol/refusal.ts's `REFUSAL_ADVISORY_KEYS`.
            //
            // 2026-10-18 (6t-2 T03 rep0 #5 / rep2 #5): `next` also keeps the
            // caller's scope and budget. It used to carry only the queries, so
            // run as given a find scoped to one file searched the whole
            // workspace (11 files in the shopflow cell); both recorded solvers
            // re-added `scope` by hand. cwd, lane and task.handle are attributed
            // by canonicalToolCall as for every other continuation.
            const head = (rawQueries as unknown[]).slice(0, queryCap).map(String);
            const remainingQueries = (rawQueries as unknown[]).slice(queryCap).map(String);
            const carriedFindArgs: Record<string, unknown> = {};
            for (const name of ["path", "lang", "regex", "archive", "credentialRef", "includeScores", "maxBytes", "maxTokens", "limit"]) {
              if (args[name] !== undefined) carriedFindArgs[name] = args[name];
            }
            return toolStructuredError({
              ok: false,
              code: "invalid-input",
              error: `queries accepts at most ${queryCap} entries, got ${rawQueries.length}`,
              next: canonicalToolCall("tl_search_files", { ...carriedFindArgs, action: "find", queries: head }),
              hint: `queries is OR-matched and capped at ${queryCap} per call — run the suggested call, then a second find for the remaining ${rawQueries.length - queryCap} token(s)`,
              remaining_queries: remainingQueries,
            });
          }
          if (!rawQueries.every((q) => typeof q === "string" && q.length > 0)) {
            return toolError("each entry in queries must be a non-empty string", { code: "invalid-input" });
          }
          const queries = rawQueries as string[];
          // Feature 2 (2026-07-12b2): harvest concern-anchor tokens from a
          // tl_search_files find call so Guard 2 / the unread-sibling note
          // (Feature 1) can arm even in a pack-less session (buildTaskPack's
          // own concernAnchorTokens harvest never ran — see 12b2
          // forensics: zero task_packs that cell). queries[] entries are
          // already literal identifier tokens — record them directly through
          // the existing cap-24 FIFO (recordConcernTokens lowercases).
          //
          // W9 (root-leak forensics): entries are verbatim tokens, not free
          // text, so there is no span to scrub — only drop an entry that IS
          // the workspace root's own basename, or that carries a path
          // separator (a path handed to queries[] by mistake, not a literal
          // token). See concernHarvestText's module doc for the fuller story.
          recordConcernTokens(workspace, filterConcernQueryEntries(workspace, queries));
          // SPC (2026-09-29): "caller budget" is the TOP tier of
          // findResponseCapBytes()'s "caller budget > host ceiling > the flat
          // default" precedence (findText.ts's own doc comment) — resolved
          // here with the SAME resolveCallerByteCeiling helper every other
          // caller-declared-budget consumer in this file already uses, from
          // the SAME args.maxBytes/args.maxTokens normalizeCanonicalRequest's
          // mapCanonicalBudget already wrote from a canonical `budget.bytes`/
          // `budget.tokens` (or a legacy flat maxBytes/maxTokens under
          // TL_LEGACY_INPUT=accept). `undefined` (no caller budget declared)
          // changes nothing: buildFindResponseForQueries's own opts.responseByteCeiling
          // default keeps every existing call site's behavior exactly as before
          // this wiring existed.
          const findByteCeiling = resolveCallerByteCeiling(
            typeof args["maxBytes"] === "number" ? args["maxBytes"] : undefined,
            typeof args["maxTokens"] === "number" ? args["maxTokens"] : undefined,
            undefined,
          );
          const outcome = annotateServedFindHits(buildFindResponseForQueries(
            {
              queries,
              ...(args["regex"] !== undefined ? { regex: Boolean(args["regex"]) } : {}),
              ...(lang ? { lang } : {}),
              ...(args["path"] !== undefined ? { path: String(args["path"]) } : {}),
            },
            workspace,
            { responseByteCeiling: findByteCeiling },
          ), workspace, args);
          // L2: an escalation is a refusal body, not a result set — the hop-1
          // attachment describes files[] snippets it no longer carries.
          if (outcome.escalated) return toolOk(outcome.body);
          // Copilot retest r5 (2026-10-03): a whole result of a few small
          // files carries their text — findText.ts `attachSmallFileContexts`.
          if (findSmallBodiesEnabled()) {
            attachSmallFileContexts(outcome.body as Record<string, unknown>, workspace, typeof args["maxBytes"] === "number" || typeof args["maxTokens"] === "number");
          }

          // v0.14 N-1: the canonical queries[] form must advance the same
          // prescribed task ledger as the legacy single-query form below.
          // Project only conclusions the find response itself certified:
          // matched terms are served, complete per-term misses (or a complete
          // whole-set absence) are authoritative absences, and unknown terms
          // remain open. Consume the batch capability exactly once, then apply
          // all per-term proofs to that one authenticated task scope.
          const batchBody = outcome.body as {
            absence?: unknown;
            matched_terms?: unknown;
            term_results?: unknown;
          };
          const matched = new Set(
            Array.isArray(batchBody.matched_terms)
              ? batchBody.matched_terms.filter((value): value is string => typeof value === "string")
              : [],
          );
          // C12 (chip wave, 2026-09-14): a caveated or scope-narrowed whole-set
          // `absence` must not become an AUTHORITATIVE per-concern-token
          // absence any more than it may back the wire
          // `request_item_absences` certificate below — gate on the same
          // caveat-free/scope-complete proof `provenFindAbsence` already
          // computes for the executed-search result ledger, instead of
          // trusting `batchBody.absence !== undefined` alone. Hoisted here
          // (rather than duplicated) so both consumers share one proof; the
          // second declaration further down is removed.
          const batchAbsence = provenFindAbsence(args, outcome.body as Record<string, unknown>);
          const absent = new Set<string>();
          if (batchAbsence !== undefined) {
            for (const query of queries) absent.add(query);
          }
          if (Array.isArray(batchBody.term_results)) {
            for (const entry of batchBody.term_results) {
              if (entry === null || typeof entry !== "object") continue;
              const term = entry as { original?: unknown; status?: unknown; scope?: unknown };
              if (typeof term.original !== "string") continue;
              if (term.status === "matched") matched.add(term.original);
              if (
                term.status === "absent"
                && term.scope !== null
                && typeof term.scope === "object"
                && (term.scope as { completeness?: unknown }).completeness === "complete"
              ) {
                absent.add(term.original);
              }
            }
          }
          const served = queries.filter((query) => matched.has(query));
          const certifiedAbsent = queries.filter((query) => absent.has(query));
          // R1-S10a: asked BEFORE the consume below spends the capability, and
          // read-only so an unprescribed probe cannot poison the shape for a
          // pack that prescribes it later — see `termSearchWasPrescribed`.
          //
          // The WHOLE-CALL shape counts first: a pack with two uncovered
          // identifiers prescribes exactly `{action:"find", queries:[a,b]}`, so
          // running that call is running what was asked for, for both terms. A
          // batch the caller ASSEMBLED itself (the reviewer's input A: the pack
          // asked for one term, the caller added a second) resolves only
          // per-term, which is the fail-closed half — the extra term writes
          // nothing.
          const batchShapePrescribed = hasPendingExecutableNext(workspace, sessionLaneOf(args), {
            tool: "tl_search_files",
            arguments: { action: "find", queries },
          });
          const prescribedTerms = new Set(
            queries.filter((query) => batchShapePrescribed || termSearchWasPrescribed(workspace, args, query)),
          );
          if (served.length > 0 || certifiedAbsent.length > 0) {
            const batchScope = consumeExecutableNextScope(workspace, sessionLaneOf(args), {
              tool: "tl_search_files",
              arguments: { action: "find", queries },
            });
            if (batchScope !== undefined) {
              if (certifiedAbsent.length > 0) {
                recordAuthoritativeAbsentConcerns(workspace, certifiedAbsent, batchScope);
              }
              if (served.length > 0) recordServedConcernEvidence(workspace, served, batchScope);
            }
          }
          // TL142-01A/01B: the canonical `queries[]` form is the shape a pack
          // ACTUALLY proposes for an identifier obligation, and it recorded
          // nothing at all before this wave — not even the no-repeat entry the
          // single-query form below has had since P1-b. Both halves now:
          //  - HITS are attributed only for a SINGLE-term call. A multi-term
          //    `find` reports `files[]` for the whole OR-match with no per-term
          //    attribution, so claiming those paths for one term would be a
          //    guess; multi-term calls therefore record the per-term ABSENCE
          //    verdict (which `term_results[]` does attribute) and an empty hit
          //    list, which still stops a rebuild re-proposing a spent search.
          //  - ABSENCE rides `term_results[].scope.completeness === "complete"`
          //    (the same gate `certifiedAbsent` above already trusts) or, for a
          //    whole-set absence, `provenFindAbsence` (hoisted above the
          //    `absent` fill near the top of this branch — C12, chip wave).
          const batchHits = queries.length === 1
            ? findResponseHits(outcome.body as Record<string, unknown>)
            : [];
          // NOTE: no `recordExecutedSearch` here. That store is the SESSION
          // no-repeat ledger `advanceExecutedLocateNextCall`/
          // `suppressNonProgressingNextCall` consult to suppress a proposed
          // call, and the `queries[]` branch has deliberately never written to
          // it (only the single-query branch below does). Adding it changes
          // which continuations are suppressed, which is a separate contract
          // from "what did this search find" — `sequenceCorpus`'s I1/I3
          // absence-consumption cases fail on it. The RESULT ledger below is
          // read only by TL142-01A/01B's own promotion paths.
          // R1-B1 (2026-09-13 review round): AN ABSENCE MAY ONLY BE RECORDED FROM
          // THE WHOLE RESPONSE'S OWN CERTIFICATE.
          //
          // This branch used to record a term absence off
          // `term_results[].scope.completeness === "complete"`, and `findText.ts`
          // stamps that for ANY per-term absence its shared `buildAbsenceExtra`
          // issues — including one whose certificate carried a `caveat` naming
          // the paths excluded from the scan. A two-term find over a workspace
          // with a `.tokenlightenignore`d (or unreadable) file holding the term
          // therefore recorded a "scope complete" proof in the same body that
          // disclosed `omitted:{tokenlighten_ignored:1}`, and the resume
          // certified `act.answer` with `explicit-gap:request-item-absent:<term>
          // (… scope complete)` — a false certificate over a file the term IS in.
          //
          // `provenFindAbsence` is the one gate the single-query branch below has
          // always used (workspace-wide, literal, un-narrowed, caveat-free, and
          // now omission-free). Because `findText.ts` issues a whole-set
          // `absence` only on a total miss, requiring it here means exactly this:
          // an all-absent, caveat-free batch records the proof it really made,
          // and a MIXED batch (one term matched, another reported absent) records
          // none — the pack keeps proposing the single-term search, which already
          // handles that case correctly. Hits are unaffected.
          for (const query of queries) {
            recordTermSearchResult(
              workspace,
              args,
              "find",
              query,
              matched.has(query) ? batchHits : [],
              batchAbsence !== undefined && absent.has(query) && !matched.has(query)
                ? batchAbsence
                : undefined,
              prescribedTerms.has(query),
            );
          }
          // DESIGN-v0.15 §6.1 (R3): a truncated queries[] find is staged and
          // its own files[]/total_files/total_matches rebuilt from the full
          // snapshot's stable order — see `stageSearchRequestForFind`'s doc
          // comment. Runs AFTER the concern/proof recording above, which must
          // see the ORIGINAL (unstaged) body's own term_results/absence.
          const stagedQueriesFind = stageSearchRequestForFind({
            workspace,
            queries,
            regex: args["regex"] === true,
            ...(args["path"] !== undefined ? { path: String(args["path"]) } : {}),
            ...(lang !== undefined ? { lang } : {}),
            args,
            body: outcome.body as Record<string, unknown>,
          });
          return stagedQueriesFind.kind === "refusal"
            ? toolStructuredError(stagedQueriesFind.refusal)
            : toolOk(stagedQueriesFind.body);
        }

        // Feature 2 (2026-07-12b2): single-query find — filter through the
        // same concernAnchorTokens helper buildTaskPack's own harvest uses
        // (identifier-shaped extraction, not every raw query word) before
        // recording. See the queries[] branch above for the full doc.
        //
        // W9 (root-leak forensics): scrub the workspace root's own folder
        // name and any path-shaped span out of the query text BEFORE
        // tokenization — see concernHarvestText's module doc in
        // readCodeTaskPack.ts.
        recordConcernTokens(workspace, concernAnchorTokens(concernHarvestText(workspace, queryStr)));

        // Fix B (2026-07-12c single-query-find-loop forensics): one-shot find-batching
        // hint — sibling of the edits[] BATCH_HINT_TEXT nudge (see
        // recordSingleFindCompletion doc in util/session.ts). A queries[]
        // call (handled in the branch above) never reaches here, so it
        // never increments the counter.
        const findHint = recordSingleFindCompletion(workspace) ? FIND_HINT_TEXT : undefined;

        // SPC (2026-09-29): same caller-budget wiring as the queries[]
        // branch above — see that branch's own comment.
        const findByteCeiling = resolveCallerByteCeiling(
          typeof args["maxBytes"] === "number" ? args["maxBytes"] : undefined,
          typeof args["maxTokens"] === "number" ? args["maxTokens"] : undefined,
          undefined,
        );

        // A1: never-empty, grouped-by-file response — see findText.ts
        // buildFindResponse doc comment for the literal -> tokenized ->
        // did_you_mean fallback ladder.
        const rawFindResponse = buildFindResponse(
          {
            query: queryStr,
            ...(args["regex"] !== undefined ? { regex: Boolean(args["regex"]) } : {}),
            ...(lang ? { lang } : {}),
            ...(args["path"] !== undefined ? { path: String(args["path"]) } : {}),
          },
          workspace,
          { extraHint: findHint, responseByteCeiling: findByteCeiling },
        );
        // L1 (2026-07-30 T11 forensics): a single-identifier query that
        // resolves to a unique class/interface definition gets a
        // ready-to-run batched member find attached — see memberSweep.ts.
        // buildFindResponse() itself stays synchronous (see that module's
        // doc comment for why); this reads the response's own (already
        // capped) candidate files fresh, and never force-fits — it skips
        // the attachment rather than trimming files/matches to make room.
        const findResponseWithMemberSweep = await maybeAttachMemberSweepToFindResponse(rawFindResponse, {
          query: queryStr,
          isRegex: Boolean(args["regex"]),
          workspace,
          candidatePaths: rawFindResponse.files.map((f) => f.path),
        });
        // S9 (2026-08-07 native-IO-escape wave): chained AFTER member_sweep so
        // the rarer, more specific class/interface signal keeps first claim
        // on the shared byte budget — see relatedLookups.ts doc comment for
        // the full scope/rationale.
        const findResponseWithRelatedLookups = maybeAttachRelatedLookups(findResponseWithMemberSweep, {
          query: queryStr,
          isRegex: Boolean(args["regex"]),
        });
        const outcome = annotateServedFindHits(findResponseWithRelatedLookups, workspace, args);
        // L2: see the queries[] branch above — an escalation carries no files[]
        // snippets for hop-1 to describe.
        if (outcome.escalated) return toolOk(outcome.body);
        // Copilot retest r5: see the queries[] branch above.
        if (findSmallBodiesEnabled()) {
          attachSmallFileContexts(outcome.body as Record<string, unknown>, workspace, typeof args["maxBytes"] === "number" || typeof args["maxTokens"] === "number");
        }
        // R1-S10a: the fence for the RESULT ledger below, asked BEFORE either
        // consume spends this call's capability (`consumeExecutableNextScope`
        // deletes the pending-next, so asking afterwards would report "not
        // prescribed" for every prescribed find) — see
        // `termSearchWasPrescribed`.
        const singleFindPrescribed = termSearchWasPrescribed(workspace, args, queryStr);
        // `absence` is the authoritative scope certificate object (not a
        // boolean) on the find payload. Its presence is the server's completed
        // zero-result proof; `=== true` silently discarded that proof.
        const absent = (outcome.body as { absence?: unknown }).absence !== undefined ? [queryStr] : [];
        // `next.arguments` intentionally carries no hidden task_handle. Bind
        // it internally to the unique pack that issued this exact executable
        // find. A collision in one lane resolves to undefined and proves
        // nothing rather than guessing which task's ledger to discharge.
        const nextScope = absent.length > 0 ? consumeExecutableNextScope(workspace, sessionLaneOf(args), {
          tool: "tl_search_files",
          arguments: { action: "find", query: queryStr },
        }) : undefined;
        // An authoritative absence is also the explicit, durable gap witness
        // for an open-universe request. This lets the same task handle advance
        // after the prescribed find without repeating the search obligation.
        if (absent.length > 0 && nextScope !== undefined) {
          recordAuthoritativeAbsentConcerns(workspace, absent, nextScope);
        }
        // P1-d (2026-08-28): the HIT half of the same ledger-recording site.
        // A prescribed find that actually finds the token discharges the SAME
        // concern-token obligation absence would have — with a `served` proof
        // instead. `recordServedConcernEvidence` is fail-closed on its own
        // (it proves only an obligation the ledger already tracks), so a find
        // over a token this task never named as a concern is a safe no-op.
        if (absent.length === 0 && queryStr.length > 0) {
          const hitScope = consumeExecutableNextScope(workspace, sessionLaneOf(args), {
            tool: "tl_search_files",
            arguments: { action: "find", query: queryStr },
          });
          if (hitScope !== undefined) recordServedConcernEvidence(workspace, [queryStr], hitScope);
        }
        // P1-b (2026-08-28): session-level no-repeat ledger (distinct from the
        // task-contract ledger recording just above) — find/references/tree
        // never mint handles the way locate's candidateDetails do, so this
        // records an empty candidate list; advanceExecutedLocateNextCall
        // (readCodeTaskPack.ts) consults it to SUPPRESS, never advance, a
        // repeat of this exact (action,query).
        recordExecutedSearch(workspace, "find", queryStr, []);
        // TL142-01A/01B: the RESULT half of the same recording site. This is
        // what a later rebuild of the task that PRESCRIBED this find reads, so
        // it can serve what the search located (or cite what it proved absent)
        // instead of re-deriving both from scratch — see
        // `recordTermSearchResult`/`provenFindAbsence`.
        recordTermSearchResult(
          workspace,
          args,
          "find",
          queryStr,
          findResponseHits(outcome.body as Record<string, unknown>),
          provenFindAbsence(args, outcome.body as Record<string, unknown>),
          singleFindPrescribed,
        );
        // DESIGN-v0.15 §6.1 (R3): see the queries[] branch above for the full
        // doc comment — a truncated single-query find is staged and rebuilt
        // from the full snapshot's stable order the same way.
        const stagedSingleFind = stageSearchRequestForFind({
          workspace,
          queries: [queryStr],
          regex: args["regex"] === true,
          ...(args["path"] !== undefined ? { path: String(args["path"]) } : {}),
          ...(lang !== undefined ? { lang } : {}),
          args,
          body: outcome.body as Record<string, unknown>,
        });
        return stagedSingleFind.kind === "refusal"
          ? toolStructuredError(stagedSingleFind.refusal)
          : toolOk(stagedSingleFind.body);
      }
      if (action === "references") {
        // DESIGN-v0.15 §6.1 (R3): the existing position cursor
        // (`tools/findReferences.ts`'s `encodeReferencesCursor`/
        // `decodeReferencesCursor`, purpose `continuation`) keeps working
        // UNCHANGED for backward compatibility, including the frozen
        // replay-corpus case — that decoder's own undecodable-token path
        // (silently serve from the start, disclosed via `cursor_note`) is
        // untouched. But a token that DOES decode as a KNOWN, DIFFERENT
        // purpose OTHER than this wave's own `tlh_sreq_v1_` search-request
        // cursor (in particular `tlh_rreq_v1_`/`tlh_task_v1_`) is a caller
        // error, not an ordinary "start over" — refusing it explicitly is
        // what keeps a foreign cursor from ever being silently reinterpreted
        // as a fresh, unscoped references walk.
        //
        // DESIGN-v0.15 §6.1 (R3 extension, this wave): `tlh_sreq_v1_` is now
        // ALSO let through — `findReferences.ts` itself owns the deep
        // resolution (binding, `action:"references"`, source-revision
        // staleness) for that purpose, exactly like `serveSearchCursorPage`
        // does for `find`'s own search-request cursor. A `tlh_sreq_v1_`
        // token that turns out to be a `find`-opened record (wrong action)
        // is refused `cursor-invalid` by that deep resolution, not here.
        const referencesCursorToken = typeof args["cursor"] === "string" ? args["cursor"] : undefined;
        const referencesCursorForeignPurpose = referencesCursorToken !== undefined
          ? parseHandlePurposeFromPrefix(referencesCursorToken)
          : undefined;
        if (
          referencesCursorForeignPurpose !== undefined
          && referencesCursorForeignPurpose !== "continuation"
          && referencesCursorForeignPurpose !== "search-request"
        ) {
          return toolStructuredError({
            ok: false,
            code: "cursor-invalid",
            field: "cursor",
            error: "this search cursor is not usable here",
            detail: `wrong-purpose (${referencesCursorForeignPurpose}); restart the original request`,
            retry: "call",
          });
        }
        const symbol = String(args["symbol"] ?? args["query"] ?? "");
        // FX-G13 G1: the caller's own page-width ceiling — canonical
        // `budget.bytes`/`budget.tokens` both map here (mapCanonicalBudget ->
        // `maxBytes`/`maxTokens`), folded through the SAME
        // `resolveCallerByteCeiling` helper every other caller-declared-
        // budget site in this server uses (readCodeModes.ts) so a
        // `budget.tokens` request narrows findReferences' page width
        // IDENTICALLY to its byte-equivalent (wireBudgetTokens.spec.ts's FX-R3
        // parity contract) rather than only `budget.bytes` reaching it while
        // `budget.tokens` fell through to the outer wire-budget funnel alone.
        // `undefined` default: with neither declared, findReferences applies
        // its OWN default protocol-frame cap — never widened past it.
        const referencesMaxBytes = resolveCallerByteCeiling(
          typeof args["maxBytes"] === "number" ? args["maxBytes"] : undefined,
          typeof args["maxTokens"] === "number" ? args["maxTokens"] : undefined,
          undefined,
        );
        // DESIGN-v0.15 §6.1 (R3 extension): the lane/task binding a NEWLY
        // MINTED `tlh_sreq_v1_` continuation cursor is scoped to, and that an
        // incoming one is checked against — same source as `find`'s own
        // `serveSearchCursorPage` (`currentSessionLane()`/`args["task_handle"]`).
        const referencesLane = currentSessionLane();
        const referencesTaskHandle = typeof args["task_handle"] === "string" ? args["task_handle"] : undefined;
        const response = await findReferences(
          {
            symbol,
            ...(lang ? { lang } : {}),
            ...(args["path"] !== undefined ? { path: String(args["path"]) } : {}),
            // L2 (2026-08-01 references-contract): `limit` is advertised on
            // tl_search_files but used to be dropped on this branch alone.
            ...(typeof args["limit"] === "number" ? { limit: args["limit"] } : {}),
            // L4 (2026-08-01 references-cursor v2): the OPAQUE line-granular
            // continuation token off a previous response's structured
            // `next_call` — the ONLY state a follow-up page needs, so an
            // agent replaying next_call verbatim reaches every matched LINE
            // (findReferences.ts module doc contract). v1's path-granular
            // `after` skipped the unserved remainder of a limit-cut or
            // line-trimmed file and its whitespace-joined `next` string broke
            // on paths with spaces — both review findings.
            ...(typeof args["cursor"] === "string" && args["cursor"] ? { cursor: args["cursor"] } : {}),
            ...(referencesMaxBytes !== undefined ? { maxBytes: referencesMaxBytes } : {}),
            ...(referencesLane !== "" ? { lane: referencesLane } : {}),
            ...(referencesTaskHandle !== undefined ? { taskHandle: referencesTaskHandle } : {}),
          },
          workspace,
        );
        // P1-d (2026-08-28): references gets the SAME ledger-recording site
        // find already has — an authoritative absence or a hit discharges the
        // symbol's concern-token obligation, task/lane-scoped through the
        // identical fail-closed consumeExecutableNextScope discipline. The
        // canonical prescribed shape (readCodeTaskPack.ts's own next_call
        // construction) always keys the symbol as `query`, never `symbol`, so
        // the lookup below matches a server-prescribed next regardless of
        // which argument name THIS caller used to supply it.
        if (symbol.length > 0) {
          const referencesScope = consumeExecutableNextScope(workspace, sessionLaneOf(args), {
            tool: "tl_search_files",
            arguments: { action: "references", query: symbol },
          });
          if (referencesScope !== undefined) {
            if (response.absence !== undefined) {
              recordAuthoritativeAbsentConcerns(workspace, [symbol], referencesScope);
            } else if (response.total > 0) {
              recordServedConcernEvidence(workspace, [symbol], referencesScope);
            }
          }
        }
        // P1-b (2026-08-28): see the identical comment on the find branch above.
        if (symbol.length > 0) recordExecutedSearch(workspace, "references", symbol, []);
        return toolOk(response);
      }
      if (action === "symbols") {
        // A symbols cursor is served from the staged chain's authenticated
        // position, before any query/path validation — exactly like `find`'s.
        const rawSymbolCursor = args["cursor"];
        if (typeof rawSymbolCursor === "string" && rawSymbolCursor !== "") {
          return await serveSymbolCursorPage(rawSymbolCursor, args, workspace);
        }
        const rawQuery = String(args["query"] ?? "");
        const hasSymbolQuery = rawQuery.trim().length > 0;
        const rawSymbolPath = args["path"] !== undefined ? String(args["path"]) : "";
        const hasSymbolPath = rawSymbolPath.trim().length > 0;

        // Fix A (2026-07-12c empty-symbol-query forensics): an empty/omitted query with
        // NO path used to fan out repo-wide — searchIndex.ts's gate passed
        // every symbol when query==="" (symbolLower.includes("") is
        // vacuously true), burying the requested file's own symbols under
        // unrelated repo files (including this server's OWN dev sources).
        // Refuse loudly instead of silently searching everything.
        if (!hasSymbolQuery && !hasSymbolPath) {
          return toolError("action=symbols needs query (symbol name) and/or path (file to list)", { code: "invalid-input" });
        }

        const budget = symbolSearchBudget(args);
        const includeScores = typeof args["includeScores"] === "boolean" ? args["includeScores"] : undefined;
        const symbolsResult = await searchSymbols(
          {
            query: rawQuery,
            ...(lang ? { lang } : {}),
            ...(hasSymbolPath ? { path: rawSymbolPath } : {}),
            limit: symbolPageItems(budget),
            ...(includeScores !== undefined ? { includeScores } : {}),
            cursorPage: true,
          },
          workspace,
        );
        // TL142-01A: a `symbols` search answers the same "where is this term"
        // question a `find` does — and it is the shape `nextCallForUnresolved`
        // proposes for an `identifier:*` obligation — so its located
        // path/line/symbol rows go into the SAME term-keyed result ledger. No
        // absence is ever recorded here: a symbols miss proves nothing about
        // workspace CONTENT (the term may exist as a non-symbol occurrence),
        // and only `find`'s own scope certificate can carry that claim.
        const symbolsBody = symbolsResult as unknown as Record<string, unknown>;
        const symbolLocations = Array.isArray(symbolsBody["locations"]) ? symbolsBody["locations"] : [];
        const symbolHits: ExecutedSearchHit[] = [];
        for (const raw of symbolLocations) {
          if (raw === null || typeof raw !== "object") continue;
          const entry = raw as { path?: unknown; line?: unknown; symbol?: unknown };
          if (typeof entry.path !== "string" || entry.path.length === 0) continue;
          symbolHits.push({
            path: entry.path,
            ...(typeof entry.line === "number" ? { line: entry.line } : {}),
            ...(typeof entry.symbol === "string" ? { symbol: entry.symbol } : {}),
          });
        }
        if (hasSymbolQuery && symbolHits.length > 0) {
          recordTermSearchResult(
            workspace, args, "symbols", rawQuery, symbolHits, undefined,
            // R1-S10a: same fence as the find branches — nothing consumes this
            // call's capability before here, so the read-only ask is exact.
            termSearchWasPrescribed(workspace, args, rawQuery),
          );
        }
        stageSymbolSearchPage(args, symbolsResult, workspace);
        // Fix A: query empty/omitted + path provided is a LISTING, not a
        // ranked search — say so, since the caller may expect name matches.
        if (!hasSymbolQuery && hasSymbolPath) {
          return toolOk({ ...symbolsResult, note: `listing symbols under ${rawSymbolPath}; pass query to rank matches` });
        }
        return toolOk(symbolsResult);
      }
      if (action === "diff") {
        // W5: a diff review is the observable verification-evidence event —
        // it discharges any standing functional-validation obligation.
        clearFunctionalValidationObligation(workspace);
        return toolOk(await getCurrentDiff({ path: args["path"] as string | undefined, maxTokens: args["maxTokens"] as number | undefined }, workspace));
      }
      if (action === "locate" || (action === "tree" && args["includeClosure"] === true)) {
        // includeClosure=true routes to buildTaskPack for closure-pack shape.
        if (args["includeClosure"] === true) {
          const admission = taskPackAdmission(args, defaultResponseByteCeiling);
          if (admission !== undefined) return admission;
          recordReadMode(workspace, "task_pack");
          const taskBinding = canonicalTaskBindingOf(args, workspace);
          const result = await buildTaskPack(
            {
              ...searchTaskCredential,
              // DESIGN-v0.15-sf-intent-layers.md §4.1: see the sibling
              // promotion branches above.
              writeAllowed: ALLOW_WRITE,
              ...(taskBinding !== undefined ? { taskBinding } : {}),
              // PI-09 close-out: the explicit "I lost my context" switch.
              ...(args["force_serve"] === true ? { forceServe: true as const } : {}),
              ...((args as Record<PropertyKey, unknown>)[SMALL_WINDOW_RESERVE_FORCE] === true ? { forceServeCallerTargetsOnly: true as const } : {}),
              query: args["query"] ? String(args["query"]) : undefined,
              ...(parseTaskProfile(args["taskProfile"]) ? { taskProfile: parseTaskProfile(args["taskProfile"]), ...(inheritedTaskProfileArgs.has(args) ? { taskProfileInherited: true as const } : {}) } : {}),
              ...(args["symbol"] !== undefined ? { symbol: String(args["symbol"]) } : {}),
              ...(args["path"] !== undefined ? { path: String(args["path"]) } : {}),
              ...(lang ? { lang } : {}),
              ...(typeof args["limit"] === "number" ? { limit: args["limit"] } : {}),
              ...(Array.isArray(args["surfaceRoles"]) ? { surfaceRoles: (args["surfaceRoles"] as unknown[]).map(String) } : {}),
              ...(typeof args["maxBytes"] === "number" ? { maxBytes: args["maxBytes"] } : {}),
              ...(typeof args["maxTokens"] === "number" ? { maxTokens: args["maxTokens"] } : {}),
              ...(defaultResponseByteCeiling !== undefined ? { clientDefaultByteCeilingHint: defaultResponseByteCeiling } : {}),
            },
            workspace,
          );
          // Feature 1 (2026-07-12b2): task_pack surfaces with embedded code count as read.
          recordTaskPackSurfaceReads(workspace, result);
          // DESIGN-v0.9 §4.7: shared read-side post-processor stamps
          // continuation (derives next), normalizes/verifies inlined[], guards
          // FORBIDDEN_KEYS. content_completeness/inlined were already set inside
          // dedupeTrimAndPersist; this is the uniform read-side exit.
          //
          // A.5.1 (C2-3): `includeClosure:true` routes a `tl_search_files` call to
          // `buildTaskPack`, so the PAYLOAD is a task pack and `Kind` names the
          // payload's family, not the tool (`envelope.ts` applies the same rule
          // to a receipt served on a search call). Without this the response
          // claimed to be `search.matches` while carrying `surfaces[]` and no
          // decision — the probe-by-field-presence D4 exists to remove.
          declareKind("read.task_pack");
          const closurePack = attachSupply(result as unknown as Record<string, unknown>, workspace);
          projectTaskPackWire(closurePack, args["query"] ? String(args["query"]) : "");
          return toolOk(closurePack);
        }
        const locateResult = await locateTaskContext(workspace, {
          action: "locate",
          query: String(args["query"] ?? ""),
          ...(args["symbol"] !== undefined ? { symbol: String(args["symbol"]) } : {}),
          ...(args["path"] !== undefined ? { path: String(args["path"]) } : {}),
          ...(lang ? { lang } : {}),
          ...(typeof args["limit"] === "number" ? { limit: args["limit"] } : {}),
          ...(typeof args["maxTokens"] === "number" ? { maxTokens: args["maxTokens"] } : {}),
        });
        // D3 (2026-08-01): remember this locate + its candidate handles so a
        // later task-pack contract can advance PAST it (batched handle read)
        // instead of re-pointing its next_call at a call that already ran.
        const locateCandidateHandles = "candidateDetails" in locateResult && Array.isArray(locateResult.candidateDetails)
          ? locateResult.candidateDetails
              .map((detail) => detail.handle)
              .filter((handle): handle is string => typeof handle === "string")
          : [];
        recordExecutedLocate(workspace, String(args["query"] ?? ""), locateCandidateHandles);
        // TL142-01A: `locate` already had the ONLY result-carrying store in
        // this file (its candidate HANDLES). Its candidate PATHS join the
        // term-keyed ledger too, so a rebuild asking "what did the search for
        // this term find" gets one answer regardless of which of the three term
        // actions the caller happened to run.
        const locateHits: ExecutedSearchHit[] = ("candidateDetails" in locateResult && Array.isArray(locateResult.candidateDetails)
          ? locateResult.candidateDetails
          : [])
          .map((detail) => (detail as { path?: unknown; line?: unknown }))
          .filter((detail): detail is { path: string; line?: number } => typeof detail.path === "string" && detail.path.length > 0)
          .map((detail) => ({ path: detail.path, ...(typeof detail.line === "number" ? { line: detail.line } : {}) }));
        if (locateHits.length > 0) {
          const locateTerm = String(args["query"] ?? "");
          recordTermSearchResult(
            workspace, args, "locate", locateTerm, locateHits, undefined,
            // R1-S10a: see the find branch. `recordExecutedLocate` above is the
            // session no-repeat ledger and stays unfenced (it only ever
            // SUPPRESSES a repeat); this one is certificate-grade.
            termSearchWasPrescribed(workspace, args, locateTerm),
          );
        }
        return toolOk(locateResult);
      }
      if (action === "tree") {
        // Compact file inventory — tools/exploreTree.ts buildTreeResponse
        // (subdir-rooted, symlink-escape-guarded). TPB (2026-10-10): paged to
        // the caller's `budget.bytes`/`budget.tokens` (the legacy default page
        // when neither is declared); a page that stops short carries a cursor
        // continuation, and a `cursor` call resumes the same listing.
        const treePath = args["path"] !== undefined ? String(args["path"]) : undefined;
        const treeDepth = typeof args["depth"] === "number" ? args["depth"] : undefined;
        const treeCursor = typeof args["cursor"] === "string" && args["cursor"] !== "" ? args["cursor"] : undefined;
        const treeLane = currentSessionLane();
        const treeTaskHandle = typeof args["task_handle"] === "string" ? args["task_handle"] : undefined;
        const callerCwd = typeof args["cwd"] === "string" ? args["cwd"] : "";
        const treeResponse = buildTreeResponse(workspace, {
          ...(treePath !== undefined ? { subPath: treePath } : {}),
          ...(treeDepth !== undefined ? { depth: treeDepth } : {}),
          ...(treeCursor !== undefined ? { cursor: treeCursor } : {}),
          budget: {
            ...(typeof args["maxBytes"] === "number" ? { bytes: args["maxBytes"] } : {}),
            ...(typeof args["maxTokens"] === "number" ? { tokens: args["maxTokens"] } : {}),
          },
          // The envelope attributes the resolved workspace root as the
          // continuation's `cwd`; priced at the longer of it and the caller's.
          echo: {
            cwd: callerCwd.length > workspace.length ? callerCwd : workspace,
            ...(treeLane !== "" ? { lane: treeLane } : {}),
            ...(treeTaskHandle !== undefined ? { taskHandle: treeTaskHandle } : {}),
          },
        });
        if (treeResponse.kind === "refusal") return toolStructuredError(treeResponse.refusal);
        const result = treeResponse.body;
        // P1-d (2026-08-28): a directory listing carries no concern-token to
        // prove/disprove, but a tree call the server itself prescribed (the
        // alternative-progress-axis fallback, and readCodeTaskPack.ts's own
        // `{action:"tree"}`/`{action:"tree",path}` next constructions) is still
        // executed work — consuming its scope here retires the pending-next
        // entry so it cannot linger and later resolve an unrelated call's
        // scope ambiguity. Fail-closed exactly like find/references: an
        // unscoped/ambiguous tree call resolves to undefined and records
        // nothing.
        consumeExecutableNextScope(workspace, sessionLaneOf(args), {
          tool: "tl_search_files",
          arguments: { action: "tree", ...(treePath !== undefined ? { path: treePath } : {}) },
        });
        // P1-b (2026-08-28): session-level no-repeat ledger, same as find's
        // and references' recordExecutedSearch calls above — keyed on `path`.
        // I-6 fix (v0.13.1 forensics, DESIGN-v0.13-plan.md §6 2026-08-30
        // entry): record when treePath is undefined too, using the workspace
        // root as the key, instead of the pre-fix `if (treePath !== undefined)`
        // guard that left a bare-root tree with NO ledger entry at all. That
        // silence is what let readCodeTaskPack.ts's enforceNoDeadEndContract
        // fallback (and advanceExecutedLocateNextCall, via the receipt path)
        // re-propose an identical pathless `{action:"tree"}` next after this
        // exact call had already answered it (root/i6_fallback_probe.mjs:
        // repeated_identically:true).
        //
        // F1 fix (opus pre-release review, 2026-08-30): the I-6 fix above
        // recorded UNCONDITIONALLY, including on a REFUSAL. `buildCompactTree`
        // answers not-found/not-a-directory (`ok:false`) or a symlink escape
        // (`refused:true`) for a bad subPath — exactly the shape `protocol/
        // searchFamily.ts`'s `searchRefusalCodeFor` + `protocol/refusal.ts`'s
        // `isRefusalBody` (`body["ok"] === false`) classify as `kind:"refusal"`
        // on the wire below (see the `toolOk` comment). Recording a refused
        // call poisoned the ledger: `path:"<the workspace's own absolute
        // path>"` is a real, observed shape (`normalizeSubPath` strips its
        // leading slash into a bogus workspace-relative segment, so
        // `buildCompactTree` answers `ok:false, reason:"not-found"`), and
        // because the key collapses to the SAME `workspace` root either way,
        // recording it made `enforceNoDeadEndContract`'s bare-tree fallback
        // believe a successful root tree had already run when it had not —
        // a `next`-less dead end with no ledger entry left to disprove it.
        // Gating on success (`ok !== false && refused !== true` — the same
        // predicate the wire classification above applies) closes that hole
        // without reopening I-6: a GENUINE root tree still records, a refused
        // one no longer poisons the key a genuine one would use.
        //
        // F8 fix (same review): `treePath || workspace` (not `??`) maps BOTH
        // `undefined` (no `path` given) and `""` (an explicit empty path,
        // which resolves successfully to the workspace root — the only other
        // falsy value `treePath` can hold, since it is always `undefined` or
        // a `String(...)`-coerced value) onto the `workspace` key. Pre-fix,
        // `treePath ?? workspace` left `""` as the literal empty-string key,
        // which `recordExecutedSearch`'s own `if (query.length === 0) return;`
        // guard (packServeLog.ts) then silently dropped — a SUCCESSFUL
        // `path:""` tree recorded nothing at all. A caller-supplied non-empty
        // `path` is unaffected either way.
        const treeSucceeded = result.ok !== false && result.refused !== true;
        if (treeSucceeded) {
          recordExecutedSearch(workspace, "tree", treePath || workspace, []);
        }
        // D4 / A.5.10 (C2-4): see the archive-scoped tree above — the
        // `mode:"tree"` stamp is deleted, `kind:"search.tree"` is the
        // discriminator, and the not-found / not-a-directory / symlink-escape
        // branches of `buildCompactTree` leave through `Refusal` (A.9.2 row 10).
        return toolOk({ ...result });
      }
      if (action === "office") {
        // S1/C3: no doc path should end in a hard error — extract directly
        // (same primitive read_code's mode=full/extract_office_text alias
        // use: readBytesSafe + extractOfficeText) instead of refusing.
        // DESIGN-v0.15 §8.2 (R7 Part B): gate this legacy alias too.
        const actionOfficeSurfaceRefusal = officeOrArchiveSurfaceRefusal();
        if (actionOfficeSurfaceRefusal !== undefined) return toolError(actionOfficeSurfaceRefusal.error, { code: actionOfficeSurfaceRefusal.code });
        if (DOC_DISABLED) return toolError("Document extraction is disabled.", { code: "not-a-document" });
        const officePath = String(args["path"] ?? "");
        if (!officePath) return toolError("path is required", { code: "invalid-input" });
        // served-bytes: not-served (office container bytes: extractOfficeText owns the decode)
        const officeBytes = await readBytesSafe(officePath, workspace);
        if (officeBytes === null) return toolError(`File not found or outside workspace: ${officePath}`, { code: "not-found" });
        const officeResult = await extractOfficeText(
          officeBytes,
          {
            path: officePath,
            ...(credential.credentialRef !== undefined
              ? { credentialRef: credential.credentialRef }
              : {}),
            ...(typeof args["maxBytes"] === "number" ? { maxBytes: args["maxBytes"] } : {}),
            ...(typeof args["maxTokens"] === "number" ? { maxTokens: args["maxTokens"] } : {}),
          },
          credential.password,
        );
        if (!officeResult.ok) {
          return toolStructuredError(officeResult as unknown as Record<string, unknown>);
        }
        // A.5.5 (C2-4, same rule C2-3 applied to `action=locate
        // includeClosure=true`): `Kind` names the PAYLOAD's family, not the
        // tool that was called. An Office extraction served through
        // `tl_search_files` is a `read.artifact`; without this declaration it fell
        // through `kindForCall`'s search default and claimed `search.matches`,
        // a member whose required set it cannot satisfy and whose `matches`
        // wrapper it does not have.
        declareKind("read.artifact");
        return toolOk(officeResult.data);
      }
      // FX-R1 (2026-09-03, round-18B review finding 10): a bare `toolError`
      // string used to carry no `field`/`keys`, so an unrecognized `action`
      // gave the caller nothing to mechanically recover from — contrast
      // every other `unknown-arguments`/out-of-enum refusal in this file,
      // which names the offending `field` and lists the advertised `keys`
      // (§1.3.1(4)/(5)). `keys` here is `SEARCH_FILES_CANONICAL_ACTIONS`
      // (searchFamily.ts) — the six actions this dispatch chain actually
      // accepts — NOT the advertised JSON-Schema `action.enum` (still 4
      // values, `exploreOffice.spec.ts`-pinned): widening that schema enum
      // is a separate, out-of-scope change with its own pinned-wire blast
      // radius. The seven undocumented aliases (grep/search/list/def/
      // definitions/usages/callers, normalized earlier in this file's
      // argument-normalization block) stay accepted — this refusal only
      // fires once none of the canonical names OR an alias matched — but are
      // deliberately not listed in `keys`: an alias is a compatibility
      // spelling, not a value to recommend.
      return toolStructuredError({
        ok: false,
        code: "invalid-input",
        field: "action",
        keys: [...SEARCH_FILES_CANONICAL_ACTIONS],
        error: `Unknown tl_search_files action: ${action}`,
        detail: `use one of: ${SEARCH_FILES_CANONICAL_ACTIONS.join(", ")}`,
      });


}
