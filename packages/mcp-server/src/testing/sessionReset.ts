// sessionReset.ts — returns a running dev server to its just-started state, for
// the test harness only.
//
// Spec files start a fresh server for nearly every test (about 2,700 launches
// per full run, each ~0.5 s before the first request is answered). A server
// launched with TL_TEST_SESSION_RESET=1 also answers `tokenlighten/testReset`
// (mcp/transport/legacyStdio.ts), so a helper can hand the same process to
// the next test instead: the reset re-roots the server at the next test's
// workspace and clears every store a request can write. Without the variable
// the method is unknown, exactly as before, and this module is never loaded.
//
// What a reset clears: session and lane state, the handle table and its key
// ring, task contracts and prior packs, the serve log and dedupe caches, SF
// state, facet plans, ledger bindings, warm-up and trace counters, and the
// root-scoped caches that have a reset hook. What it keeps: compiled modules,
// load-once libraries (tree-sitter grammars, office readers, schema
// validators), caches keyed by absolute path or by content (each test works in
// its own fresh workspace), and everything resolved at launch from argv and
// the environment — so a harness only reuses a process for an identical
// launch.
//
// Restart and durability cases still need a real process: a reset is not a
// restart, so on-disk state is never reloaded by it.
// With TL_TEST_SESSION_CWD the harness keeps the physical cwd in a stable
// directory, avoiding Windows fixture deletion locks while activeRoot changes.
import { resetServerStateForSessionReset } from "../server.js";
import { resetAll as resetSessions, resetClockForTest } from "../state/session.js";
import { handleTable } from "../util/handles.js";
import { resetStateStoresForTests } from "../state/stateStore.js";
import { resetReadCallDispatchForTests } from "../state/readCallDispatch.js";
import {resetReadCallBatchGroupsForTests} from "../state/readCallBatchGroup.js";
import { resetPendingHandleEntriesForTests } from "../state/stateHandles.js";
import { resetHandleKeyRingForTests } from "../state/handleKeys.js";
import { resetLaneTaskHandlesForTest } from "../state/laneTaskHandles.js";
import { resetSfStateForTests } from "../task-state/sfState.js";
import { resetPackServeLogForTest } from "../util/packServeLog.js";
import { resetTaskContractStoreForTest } from "../features/task-pack/taskContractStore.js";
import { resetPriorPackStoreForTest } from "../features/task-pack/priorPackStore.js";
import { resetFacetPlansForTest } from "../features/task-pack/facetGate.js";
import { resetSfPackContextTokensForTest } from "../features/task-pack/sfSatisfaction.js";
import {
  resetArtifactSectionPrefetch,
  resetCallerExpansionEntryCountForTest,
  resetCertifiedWorkingSets,
  resetClosureExecutedCallsForTest,
  resetConcernRecoveryEntryCountForTest,
  resetFacetClosureEntryCountForTest,
  resetIdentifierGroundingScanCountForTest,
  resetManagedGuideBlockSpanCacheForTest,
  resetPackDedupeCache,
  resetPendingCandidatePaths,
  resetReceiptRepairTraceOnceForTest,
  resetRoleInventoryCache,
} from "../features/task-pack/readCodeTaskPack.js";
import { resetSfAwaitInputInvariantFallbackCountForTest } from "../features/task-pack/canonicalDecision.js";
import {
  resetClauseLocateAttemptCountForTest,
  resetSeededClauseRecoveryEntryCountForTest,
} from "../features/task-pack/concernRecovery.js";
import { resetEvidenceMemoForTest } from "../features/task-pack/evidenceResolution.js";
import { resetWebImportCaches } from "../features/task-pack/importResolveWeb.js";
import { resetPythonImportCaches } from "../features/task-pack/importResolvePython.js";
import { resetRootResolverCache } from "../features/locator/locateTaskContext.js";
import { resetJaBridgeWorkspaceVocabCacheForTest } from "../features/retrieval/jaBridgeWorkspaceVocab.js";
import { resetJaBridgeExpansionEntryCountForTest } from "../features/retrieval/queryRecoveryTerms.js";
import { resetMissingLoggedForTest } from "../graph/index.js";
import { resetHostActivationCacheForTest } from "../mcp/hostActivation.js";
import { resetV2CacheForTest } from "../protocol/codec/pipeline.js";
import { resetLedgerBindingIndexForTests } from "../protocol/ledgerCertificateBinding.js";
import { resetLexicalSegmentsCache } from "../tools/lexicalRanges.js";
import { resetGitignorePatternsCache, resetTokenlightenIgnoreCache } from "../tools/walkRepo.js";
import { resetProofCompletionLiveCounterForTest } from "../util/flags.js";
import { noteToolCallStarted, resetStartupWarmupForTest, startupWarmupSettledForTest } from "../util/startupWarmup.js";
import { resetTraceStateForTests } from "../util/trace.js";
import { resetVerificationKitDedupeForTest } from "../util/verificationPack.js";
import { resetPythonProbeCacheForTest } from "../util/pythonInterpreter.js";
import { __resetShadowGitForTests } from "../write/shadowGit.js";
import { resetNestedWorkspaceCache } from "../write/workspaceBoundary.js";

export interface SessionResetResult {
  readonly reset: true;
  readonly root: string;
}

/** Test-pool framing on stderr; the following safe token ends at the newline. */
export const TEST_RESET_STDERR_PREFIX = "\u001eTL_TEST_RESET_STDERR:";

/**
 * Re-roots the server at `params.workspaceRoot` (logical cwd `params.cwd`,
 * default the root) and clears all per-session state (see the header). Physical
 * cwd remains stable when the test pool supplies TL_TEST_SESSION_CWD.
 */
export async function resetServerSessionForTests(params: unknown): Promise<SessionResetResult> {
  const { workspaceRoot, cwd, stderrBarrier } = (params ?? {}) as {
    workspaceRoot?: unknown; cwd?: unknown; stderrBarrier?: unknown;
  };
  if (typeof workspaceRoot !== "string" || workspaceRoot === "") {
    throw new Error("tokenlighten/testReset needs params.workspaceRoot (an absolute path)");
  }
  if (stderrBarrier !== undefined && (typeof stderrBarrier !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(stderrBarrier))) {
    throw new Error("tokenlighten/testReset params.stderrBarrier must be 1-80 ASCII letters, digits, underscores or hyphens");
  }
  // Re-root first: it validates the new root and throws before anything is cleared.
  const root = resetServerStateForSessionReset(workspaceRoot, typeof cwd === "string" && cwd !== "" ? cwd : workspaceRoot);

  // A scheduled or currently running warm-up belongs to the old session. Stop
  // and drain it before clearing its latch; otherwise resetting stopped=false
  // can revive the old pass and let it mutate caches after the stderr barrier.
  noteToolCallStarted();
  await startupWarmupSettledForTest();

  // Session, lane and task state.
  resetSessions();
  resetClockForTest();
  handleTable.reset();
  resetPendingHandleEntriesForTests();
  resetHandleKeyRingForTests();
  resetStateStoresForTests();
  resetReadCallDispatchForTests();
  resetReadCallBatchGroupsForTests();
  resetLaneTaskHandlesForTest();
  resetTaskContractStoreForTest();
  resetPriorPackStoreForTest();
  resetSfStateForTests();
  resetSfPackContextTokensForTest();
  resetLedgerBindingIndexForTests();

  // Serve history, dedupe and per-pack bookkeeping.
  resetPackServeLogForTest();
  resetPackDedupeCache();
  resetPendingCandidatePaths();
  resetCertifiedWorkingSets();
  resetClosureExecutedCallsForTest();
  resetFacetPlansForTest();
  resetArtifactSectionPrefetch();
  resetVerificationKitDedupeForTest();

  // Counters a fresh process starts at zero.
  resetConcernRecoveryEntryCountForTest();
  resetCallerExpansionEntryCountForTest();
  resetFacetClosureEntryCountForTest();
  resetIdentifierGroundingScanCountForTest();
  resetClauseLocateAttemptCountForTest();
  resetSeededClauseRecoveryEntryCountForTest();
  resetJaBridgeExpansionEntryCountForTest();
  resetSfAwaitInputInvariantFallbackCountForTest();
  resetProofCompletionLiveCounterForTest();
  resetTraceStateForTests();
  resetReceiptRepairTraceOnceForTest();
  resetStartupWarmupForTest();

  // Root-scoped caches with a reset hook.
  resetManagedGuideBlockSpanCacheForTest();
  resetRoleInventoryCache();
  resetEvidenceMemoForTest();
  resetWebImportCaches();
  resetPythonImportCaches();
  // Interpreter probes answer for one workspace's declared modules.
  resetPythonProbeCacheForTest();
  resetRootResolverCache();
  resetJaBridgeWorkspaceVocabCacheForTest();
  resetMissingLoggedForTest();
  resetHostActivationCacheForTest();
  resetV2CacheForTest();
  resetLexicalSegmentsCache();
  resetTokenlightenIgnoreCache();
  resetGitignorePatternsCache();
  __resetShadowGitForTests();
  resetNestedWorkspaceCache();

  // stderr and stdout are independent pipes. The pool must receive BOTH this
  // marker and the reset RPC acknowledgement before exposing the next session.
  // Writing the marker last keeps all preceding stderr in the old session.
  if (stderrBarrier !== undefined) process.stderr.write(`${TEST_RESET_STDERR_PREFIX}${stderrBarrier}\n`);
  return { reset: true, root };
}
