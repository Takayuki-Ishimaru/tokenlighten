// MCP server transport for @tokenlighten/mcp-server.
//
// Tries @modelcontextprotocol/sdk first; falls back to hand-rolled stdio
// JSON-RPC 2.0 framing if the SDK is unavailable.
//
// Tool responses are PLAIN data: no meta envelope, no 'tokenlighten:meta' wrappers.
// Reason: docs/00-postmortem.md §2.2 — meta envelope dominated cache_write cost.
//
// Write tools are registered in v0.2. They are advertised in ListTools but calls
// return 'write-not-enabled' unless --allow-write is passed at startup.
// kill-switch: TL_KILL_SWITCH=1 causes tools/list to return empty.

import { existsSync, statSync, readFileSync, readdirSync } from "node:fs";
import * as path from "path";
import { createHash, randomBytes } from "crypto";
import { deriveServerBuildId, deriveServerPackageVersion } from "./util/serverBuild.js";

import { getFileSkeleton, isSkeletonizableLanguage } from "./tools/getFileSkeleton.js";
import { getSymbolWithContext } from "./tools/getSymbolWithContext.js";
import { selectQueryEvidence } from "./tools/queryEvidence.js";
import { extractOfficeText } from "./tools/extractOfficeText.js";
import { searchReplaceEdit } from "./tools/searchReplaceEdit.js";
import { applyEditsMulti } from "./tools/applyEditsMulti.js";
import { searchSymbols } from "./tools/searchSymbols.js";
import { getCurrentDiff } from "./tools/getCurrentDiff.js";
import { createFile } from "./tools/createFile.js";
import { readAndEdit } from "./tools/readAndEdit.js";
import { findText, buildFindResponse, buildFindResponseForQueries } from "./features/search/find/findText.js";
import { applyServedFindProtocol, type ServedFindOutcome } from "./features/search/find/servedFindEscalation.js";
import { maybeAttachMemberSweepToFindResponse } from "./features/search/find/memberSweep.js";
import { maybeAttachRelatedLookups } from "./features/search/find/relatedLookups.js";
import { findReferences } from "./tools/findReferences.js";
import { attachSearchHop1 } from "./util/searchHopClosure.js";
import { renameSymbol } from "./tools/renameSymbol.js";
import { locateTaskContext, projectRootOf } from "./features/locator/locateTaskContext.js";
import { pathlessExactEdit, pathlessSymbolEdit } from "./write/pathlessEdit.js";
import { resolveWorkspaceRoot as resolveWorkspaceRootBase } from "./write/resolveWorkspace.js";
import { isWorkspaceCandidateAccepted, nearestValidWorkspaceAncestor, WORKSPACE_CANDIDATE_LIMIT } from "./workspace/candidates.js";
import { nestedWorkspaceCrossing, nestedWorkspaceRoots } from "./write/workspaceBoundary.js";
import {
  adoptGuardedWorkspaceRoot,
  guardCwd,
  guardWriteRouting,
  installWorkspaceGuardStack,
  resolveGuardedWorkspaceRoot,
  type GuardedWorkspaceRoot,
} from "./write/guardedWorkspace.js";
import { enforcePreconditions } from "./write/preconditions.js";
import { blastRadiusRefusal, measureBlastRadius, parseBlastRange } from "./write/blastRadius.js";
import { replaceAllInRange, replaceRangeContent } from "./write/rangeEdit.js";
import { compressFormat, elideDocComments, elideDocCommentsForDisplay, ELISION_MARKER_RE, TL_SYNTHETIC_MARKER_RE, servedSpansOfDisplayedText } from "./util/formatCompress.js";
import { languageForPath } from "./util/languages.js";
import { readCodePack } from "./tools/readCodePack.js";
import { buildCompactTree } from "./tools/exploreTree.js";
import {
  archivePathFromTaskPaths,
  archiveTaskDecision,
  archiveTree,
  buildArchiveManifest,
  buildArchiveTaskPack,
  findInArchive,
  isSupportedArchivePath,
  readArchiveMember,
  selectorFromArgs,
  splitArchiveVirtualPath,
  virtualArchivePath,
} from "./tools/archive.js";
import { buildTaskPack, canServeCachedTaskPackReceipt, clearPackDedupeForWorkspace, concernAnchorTokens, concernHarvestText, filterConcernQueryEntries, repairSuppressedNextCall } from "./features/task-pack/readCodeTaskPack.js";
import {
  bindTaskContractHandle,
  consumeExecutableNextScope,
  recordAuthoritativeAbsentConcerns,
  recordServedConcernEvidence,
  registerExecutableNextScope,
  runWithTaskContractScope,
  taskContractDigest,
  type TaskContractScope,
} from "./features/task-pack/taskContractStore.js";
import { walkCodeFiles } from "./tools/walkRepo.js";
import { classifySurface, deriveTokenVariants } from "./util/impact.js";
import { callWorkspace, handleTable, runWithCallWorkspace, runWithDeclaredWorkspace, setHandlePersistence, shaOfText, shaOfBytes, shortSha, type HandleEntry } from "./util/handles.js";
// PI-09 (v0.10 alpha.2) explicit state: purpose-bound handles over the
// per-workspace persistent store. See state/stateHandles.ts's header for the
// three namespaces and why `context` issuance is deliberately absent.
import {
  flushHandleEntries,
  mintTaskHandle,
  recordHandleEntry,
  rehydrateHandleEntry,
  resolveTaskHandle,
} from "./state/stateHandles.js";
// PI-09 close-out: the `operation_id` dedup table the store already keeps
// (`rememberOperation` / `lookupOperation`). Imported here rather than behind
// a stateHandles re-export because the idempotency wrapper is a DISPATCH
// concern, not a handle one — it never mints or validates a token.
import { stateStoreFor } from "./state/stateStore.js";
// PI-03 attestation tier (default OFF behind TL_CONTEXT_ATTESTATION). See
// state/contextAttestation.ts for the channel, the verification order, and the
// generation-rotation triggers.
import {
  mintContextHandle,
  runWithVerifiedContext,
  verifyContextAttestation,
  type VerifiedContextAttestation,
} from "./state/contextAttestation.js";
import { CONTEXT_STATE_META_KEY } from "@tokenlighten/types";
import { resolveMap, resolveDigest, resolveSlice, resolveSliceRanges, extractSymbolsFromFile, READ_SYMBOL_CAP_BYTES, resolveCallerByteCeiling } from "./tools/readCodeModes.js";
import { resolveClientProfile, resolveDefaultResponseByteCeiling } from "./protocol/codec/clientProfile.js";
// office/csv.ts is pure and dependency-free (unlike office/xlsx.ts, which is
// dynamic-imported to defer exceljs), so a static import here costs nothing at
// cold start and lets the csv artifact/auto helpers below call it directly.
import { csvTable, type CsvTableResult } from "./office/csv.js";
import { prepareOfficeDocument } from "./office/decrypt.js";
import { resolveCredentialRef } from "./security/credentials.js";
import { editArtifact } from "./write/artifactEdit.js";
import { adaptiveWholeFileEnabled, decisionInvariantStrictEnabled, deltaContextEnabled, overlapTrimEnabled, postReadyTrimEnabled, reasoningIrV2Enabled, schemaDefsEnabled } from "./util/flags.js";
// V11-04: the ONE advisory Task Reasoning IR v2 seam (trace-only; see its module header).
// A1-pre (2026-08-27): recordReasoningIrV2ClosureFromEdit is the edit-side
// half (DESIGN-v0.12-plan.md §2) — see its call site in augmentEdit, below.
// `deriveIrTaskRef` recomputes the SAME taskRef identity the pack seam used —
// see that call site's comment for why this, and not `taskQueryRef`, is correct.
import { deriveIrTaskRef, recordReasoningIrV2ClosureFromEdit, recordReasoningIrV2FromPack } from "./task-state/irDispatchSeam.js";
import { deriveCanonicalTaskDecision, enforceCanonicalTaskDecisionAtExit } from "./features/task-pack/canonicalDecision.js";
import type { TaskPackResult } from "./features/task-pack/model.js";
import { projectLeanExecutionContract } from "./util/leanExecutionContract.js";
import { recordReadMode, recordHandleEdit, recordPathSearchEdit, recordSingleEditCompletion, recordEditsBatchUsed, recordSingleFindCompletion, otherActiveRoots, recordConcernTokens, recordReadPath, getReadPaths, hasUnreadSiblingNoteFired, markUnreadSiblingNoteFired, recordEditedPath, getEditedPaths, getConcernTokens, guardExecutionDiscovery, noteDiscoveryServedNoBytes, guardExecutionEdit, recordExecutionContract, recordCandidateListPack, clearCandidateListPack, recordExecutionEditResult, recordCreatedEditAdmissibility, getExecutionFence, takePreparedHandleAdvisory, rekeyExecutionFenceCertificate, runWithSessionLane, isClosureSatisfied, recordClosureReport, markClosureSatisfied, clearClosureSatisfied, wasFullyServed, unservedVerificationPaths, markVerificationPathsServed, isVerificationSurfaceServed, markVerificationSurfaceServed, recordServedRange, servedRangeReceipt, beginServeCall, repeatedEditRefusalAdvisory, artifactRangeReceipt, recordArtifactServedRange, taskQueryRef, rememberTaskQuery, resolveTaskQueryRef, clearTaskQueryRef, claimServerBuildAnnouncement, registerServerBuildId, servedRangeCoverage, deltaLedgerStatus, unservedLineCount, recordFullServeCompleteness, CREATE_BODY_PLACEHOLDER, EDIT_REPLACE_PLACEHOLDER, EDIT_SEARCH_PLACEHOLDER, READ_BACK_RANGE_PLACEHOLDER, type ServedRangeLedgerReceipt } from "./state/session.js";
import { buildVerificationManifest, verificationBodyIdentity, verificationDependencyNote, identifierTokens, type BodyMarker } from "./util/verificationPack.js";
import { attachClosure, computeClosureStateSafe, CLOSURE_SATISFIED_NOTE } from "./util/closureTracking.js";
import { getFunctionalValidationObligation, clearFunctionalValidationObligation, forgetExecutedNext, hasExecutedNext, normalizeContractLane, recordExecutedLocate, recordExecutedNext, recordExecutedSearch, recordServedBytes } from "./util/packServeLog.js";
import { attachSupply } from "./util/attachSupply.js";
import { mustFetchReadBudget } from "./util/mustFetch.js";
import { getAdaptiveAdvice } from "./util/adaptive.js";
import { trace, traceCausalAttestation, runWithTraceCall, setTraceContext, isTraceEnabled } from "./util/trace.js";
import { classifyRoute } from "./routing/classifier.js";
import { decideFullRead, TINY_BYTES, TINY_LINES, LARGE_BYTES, LARGE_LINES, GOVERNED_FULL_SERVE_BYTES } from "./util/fullGovernor.js";
import { buildSmallFile, type SmallFileContentMode } from "./tools/readCodeSmallFile.js";
import { buildOverview } from "./tools/readCodeOverview.js";
import { applyIntent } from "./intents/index.js";
import { resolveReal, readFileSafe, readBytesSafe, safeResolve } from "./util/safePath.js";
import { countLines } from "./util/countLines.js";
import {
  isMarkdownPath,
  parseMarkdownHeadings,
  selectMarkdownSections,
  buildMarkdownHeadingIndex,
  similarHeadingTexts,
  MARKDOWN_SECTIONS_HINT,
} from "./util/markdownSections.js";
// P1 / D2 / ORCHESTRATOR CONDITION ② — strict recursive request-shape
// validation (DESIGN-v0.10-protocol-v1-contract-freeze.md §1.3.1). The module
// is pure and takes the advertised schema as an argument, so the single source
// of truth stays ALL_TOOLS below and there is no import cycle.
import {
  PENDING_C6_ADJUDICATION,
  findUnknownProperties,
  requestShapeRefusal,
  unknownPropertyRefusal,
  withinRefusalBudget,
  type SchemaNode,
} from "./validation/requestShape.js";
import { MCP_LANGS, type McpLang, type RefusalCode, type TaskDecision, type TaskExecutionContract, type TaskProfileRequest, type TaskRef } from "@tokenlighten/types";
import {
  createUsageRecorder,
  estimateTokensFromBytes,
  type UsageRecorder,
} from "@tokenlighten/usage";
import {
  toolError,
  toolStructuredError,
  toolOk,
  type ToolCallResult,
} from "./protocol/result.js";

export { toolError, toolStructuredError, toolOk } from "./protocol/result.js";

// protocol v1 (C2-2). The envelope spine: `v` + `kind` on every response (D1/D4),
// body `ok` deleted (D6), the one `Refusal` shape (§2.6), and the single
// decision (§2.1) with its §3.4.1 sanctioned-zoom re-anchor.
import {
  PROTOCOL_META,
  canonicalToolCall,
  declareKind,
  finalizeProtocolResponse,
  noteCodecTraceWorkspace,
  notePostReadyDiscovery,
  noteResolvedAction,
  noteResolvedMode,
  noteServedBytesSource,
  noteWorkspaceRoot,
  runWithProtocolCall,
} from "./protocol/envelope.js";
import { setEmittedToolCallValidator } from "./protocol/refusal.js";
import { markReplayed } from "./protocol/editFamily.js";
import {
  bindLedgerCertificate,
  isLedgerBackedCertificateId,
  ledgerDigestBacksCertificateId,
  withoutLedgerClaim,
} from "./protocol/ledgerCertificateBinding.js";
import { taskContractLedgerSnapshot } from "./features/task-pack/taskContractStore.js";
// issue #4 (host routing/discovery): the server-level `instructions` string
// announced on every `initialize` result across all three transport legs.
// Re-exported so the hand-rolled leg's own tests can import it from here.
import { SERVER_INSTRUCTIONS } from "./protocol/serverInstructions.js";
export { SERVER_INSTRUCTIONS } from "./protocol/serverInstructions.js";
import {
  packUnchangedPriorLabel,
  projectEvidence,
  projectTaskDecision,
  projectTaskRef,
  sanctionFromEvidence,
  taskDecisionWireViolations,
} from "./protocol/decisionWire.js";
import { assertStartupBudgetsAreSane } from "./protocol/budget/wireBudget.js";
// v0.10 alpha.1 dual-era transport (DESIGN-v0.10-expansion-plan-v1.3.md §4.5).
// The transport modules import back from this file (advertisedTools, callTool,
// handleRequest, ...); the cycle is safe because every one of those bindings is
// read inside a function body at call time, never at module evaluation.
import { runTransport, runHttpTransport } from "./mcp/transport/index.js";

// ---------------------------------------------------------------------------
// Workspace root resolution
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);

function workspaceRootArg(args: readonly string[]): string | undefined {
  let named: string | undefined;
  let positional: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--workspace") {
      named = args[++i];
      continue;
    }
    if (arg === "--allowed-root" || arg === "--allowed-parent") {
      i++;
      continue;
    }
    if (!arg.startsWith("--") && positional === undefined) positional = arg;
  }
  return named ?? positional;
}

// Exported as a live binding for ./mcp/transport/* (v0.10 alpha.1 transport
// extraction); assigned exactly once, here.
export let activeRoot = workspaceRootArg(argv) ?? process.env["TOKENLIGHTEN_ROOT"] ?? process.cwd();

// F-A7 (v0.11 wave C): the client identity `initialize`'s clientInfo declares,
// captured once per connection below (the only leg where our own code ever
// sees clientInfo — the SDK-backed legs resolve initialize internally and
// never surface it here); threaded into ProtocolCallContext.clientId by
// callToolUninstrumented via resolvedClientId() just below.
export let capturedClientId: string | undefined;

/** Test-only reset for {@link capturedClientId}. */
export function resetCapturedClientIdForTest(): void {
  capturedClientId = undefined;
}

/**
 * F-A7: TOKENLIGHTEN_CLIENT_ID overrides/supplies clientId for a leg that
 * never populates capturedClientId (every leg but the hand-rolled fallback);
 * an explicit override wins. Undefined resolves to the conservative "unknown"
 * client profile (protocol/codec/clientProfile.ts) — the designed fallback.
 */
function resolvedClientId(): string | undefined {
  const override = process.env["TOKENLIGHTEN_CLIENT_ID"];
  return override !== undefined && override !== "" ? override : capturedClientId;
}

function configuredAllowedParents(_fallbackRoot: string): readonly string[] {
  // The public protocol still honors explicit parent grants, without loading
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

function resolveWorkspaceRoot(cwd: string | undefined, fallbackRoot: string): string {
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
setHandlePersistence({ record: recordHandleEntry, rehydrate: rehydrateHandleEntry });

// Read helpers (readFileSafe, readBytesSafe, resolveReal) are imported from
// util/safePath.ts. Each call site passes an explicit workspace root — worktree-
// isolated callers pass their worktree path so reads come from THEIR tree, not the
// main checkout. See write/resolveWorkspace.ts.
//
// enforcePreconditions expects a callback with an optional root arg; bind activeRoot.
function readFileSafeOpt(rel: string, root?: string): Promise<string | null> {
  return readFileSafe(rel, root ?? activeRoot);
}

// ---------------------------------------------------------------------------
// Kill switch, feature flags, and write mode
// ---------------------------------------------------------------------------

const KILL_SWITCH = /^(1|true|yes|on)$/i.test(process.env["TL_KILL_SWITCH"] ?? "");

// ---------------------------------------------------------------------------
// W3 (2026-07-30, dist build-id echo): filesystem-only identity for the
// dispatch/schema logic THIS process loaded (see util/serverBuild.ts), so a
// stale MCP child still serving pre-fix dist/ bytes is detectable from the
// outside instead of every response looking identical regardless of which
// build produced it. Computed once at module load (ES module top-level code
// runs exactly once) — never re-derived per call/response.
// ---------------------------------------------------------------------------
export const SERVER_BUILD_ID = deriveServerBuildId(import.meta.url);
// Exported for ./mcp/transport/* — derived from THIS module's URL, so the
// transport legs must import it rather than re-derive it from their own depth.
export const SERVER_PACKAGE_VERSION = deriveServerPackageVersion(import.meta.url);
// Published to the session layer so responses IT builds — the prepared-stop
// receipt in particular — can carry the same identity without re-deriving it
// from a module that is a poor proxy for "did the server's behavior change".
registerServerBuildId(SERVER_BUILD_ID);

/** Attaches `server_build` to the FIRST task_pack response of a session only — byte economy (see claimServerBuildAnnouncement). */
function attachServerBuildOnce(result: Record<string, unknown>, workspace: string): Record<string, unknown> {
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
const DOC_DISABLED = /^(0|false|no|off)$/i.test(process.env["TOKENLIGHTEN_DOCUMENT_EXTRACTION"] ?? "");

/** --allow-write flag: write tools are registered and callable only when true. */
export const ALLOW_WRITE = argv.includes("--allow-write");

/**
 * Per-process session ID: embedded in shadow-git checkpoint commit messages.
 * Generated once at startup so all checkpoints in a session share the same ID.
 * Uses randomBytes for uniqueness; NOT Date.now (see BYTE_DETERMINISM rule).
 */
export const SESSION_ID: string = randomBytes(6).toString("hex");

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
function capEnvelopeArray<T>(entries: readonly T[], maxEntries: number, maxBytes: number): T[] {
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
const DOC_HEADLESS_SLICE_LINES = 200;

/**
 * Stamp `headings` / `headings_truncated` / `headings_total` /
 * `sections_hint` onto a markdown response. `focus` (the served window) is
 * what the index keeps first when the cap bites, so a truncated index still
 * describes where the solver actually is. No-ops for a doc with no headings
 * — an empty index is pure overhead.
 */
function attachMarkdownHeadingIndex(
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
 * shared refusal-guidance fallback derived `next: read_file path=<doc>` — a
 * whole 1500-line file, strictly worse than the 50-line native slice the
 * solver reached for instead. The miss now answers the question the caller
 * was really asking ("where is this in the doc?") with the heading index and
 * a concrete sections call; a doc over DOC_FULL_HINT_FORBIDDEN_BYTES never
 * gets a whole-file hint in any branch.
 */
function markdownSymbolMissPayload(args: {
  path: string;
  symbol: string;
  content: string;
}): Record<string, unknown> {
  const headings = parseMarkdownHeadings(args.content);
  const similar = similarHeadingTexts(headings, args.symbol, 3);
  const bytes = Buffer.byteLength(args.content, "utf8");
  const next = similar.length > 0
    ? `read_file path=${args.path} sections=${JSON.stringify(similar)}`
    : bytes <= DOC_FULL_HINT_MAX_BYTES
      ? `read_file mode=full path=${args.path}`
      : `read_file mode=slice path=${args.path} range=1-${Math.min(countLines(args.content), DOC_HEADLESS_SLICE_LINES)}`;
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
function handleWorkspaceMissingNext(handleWorkspace: string): string {
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
// schemas; WS6 (DESIGN-v0.9 §10) re-advertises edit_file.lang in that compact
// form. parseMcpLang below still validates against the full MCP_LANGS list at
// dispatch time, so an invalid lang value is rejected exactly as before —
// only the ADVERTISED schema lost the enum, not the acceptance behavior.
function parseMcpLang(value: unknown): McpLang | undefined {
  return typeof value === "string" && (MCP_LANGS as readonly string[]).includes(value)
    ? (value as McpLang)
    : undefined;
}

const TASK_PROFILE_REQUESTS: readonly TaskProfileRequest[] = [
  "auto", "generic", "answer", "change_propagation", "multi_concern", "artifact_build", "wiring",
];

function parseTaskProfile(value: unknown): TaskProfileRequest | undefined {
  return typeof value === "string" && (TASK_PROFILE_REQUESTS as readonly string[]).includes(value)
    ? (value as TaskProfileRequest)
    : undefined;
}

/**
 * Maps a read_file `paths[]` argument (bare strings or {path,range?,symbol?,
 * purpose?} objects) to buildTaskPack's TaskPackArgs["paths"] entry shape.
 * FIX (2026-07-10a dispatch-gap forensics): shared by every read_file
 * dispatch branch that feeds paths[] into buildTaskPack — the explicit
 * mode="task_pack" dispatch and the mode-unspecified/"auto" promotion — so
 * the mapping cannot drift between call sites the way task_pack's and
 * mode=pack's separate inline copies once did (2026-07-09e forensics: a
 * bare-string entry has no `.path` and used to collapse to path:"" before
 * buildTaskPack's own normalizer ever saw the original string).
 */
function mapTaskPackPaths(paths: unknown[]): Array<{ path: string; range?: string; symbol?: string; purpose?: string }> {
  return paths.map((p) => {
    if (typeof p !== "object" || p === null) return { path: String(p) };
    const e = p as Record<string, unknown>;
    return {
      path: String(e["path"] ?? ""),
      ...(e["range"] !== undefined ? { range: String(e["range"]) } : {}),
      ...(e["symbol"] !== undefined ? { symbol: String(e["symbol"]) } : {}),
      ...(e["purpose"] !== undefined ? { purpose: String(e["purpose"]) } : {}),
    };
  });
}

interface TaskPackQueryResolution {
  query: string;
  error?: string;
  /** Concrete recovery for `error`, forwarded to toolError by the call sites. */
  next?: string | Record<string, unknown>;
  /** Human rationale retained beside a structured executable recovery. */
  detail?: string;
  /**
   * C2: the query came from a `qref`, so this call is a replay over a working
   * set the caller still holds — not a freshly-typed request.
   */
  fromRef?: true;
}

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
function taskPackReceiptPreflightArgs(
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
  return {
    ...base,
    ...(resolution.query.length > 0 ? { query: resolution.query } : {}),
    ...(resolution.fromRef === true ? { taskQueryRefReplay: true } : {}),
  };
}

function resolveTaskPackQueryArg(
  args: Record<string, unknown>,
  workspace: string,
): TaskPackQueryResolution {
  if (args["taskEpoch"] === "new") {
    clearTaskQueryRef(workspace);
    // 2026-08-21 smoke-gate forensics: an explicit new-epoch declaration must
    // sever the pack-dedupe ledger too, or a workspace path reused by a
    // later, unrelated task (e.g. a bench harness cell resealed across
    // separate runs) can have its genuinely-first-served surfaces silently
    // stripped to a false "— see prior pack" pointer. See
    // clearPackDedupeForWorkspace's doc comment for the full incident.
    clearPackDedupeForWorkspace(workspace, sessionLaneOf(args));
  }
  const explicit = typeof args["query"] === "string" ? args["query"].trim() : "";
  const requestedRef = typeof args["qref"] === "string" ? args["qref"].trim() : "";
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
    return {
      query: "",
      error: "query and qref are mutually exclusive for task_pack",
      next: hasPaths
        ? canonicalToolCall("read_file", { mode: "task_pack", qref: requestedRef, paths: pathsArg })
        : canonicalToolCall("read_file", { mode: "task_pack", query: "<restate the request verbatim>" }),
      ...(hasPaths
        ? { detail: `query and qref are mutually exclusive for task_pack; drop query and keep the certified working set qref=${requestedRef} paths=${JSON.stringify(pathsArg)}` }
        : {}),
    };
  }
  if (explicit.length > 0) {
    return { query: explicit };
  }
  if (requestedRef.length > 0) {
    const query = resolveTaskQueryRef(workspace, requestedRef);
    // A qref is session-scoped and single-epoch: it expires on taskEpoch=new,
    // on a server restart, and when a newer query supersedes it. The recovery
    // is the FRESH-PACK RECIPE (2026-07-30 refusal-economy pass) — this used to
    // refuse with nothing but the dead ref echoed back, which is a pure-loss
    // turn for a caller that still holds the original request text.
    return query === undefined
      ? {
          query: "",
          error: `unknown-or-stale-qref: ${requestedRef}`,
          next: canonicalToolCall("read_file", { mode: "task_pack", query: "<restate the request verbatim>" }),
        }
      : { query, fromRef: true };
  }
  return { query: "" };
}

// Exported for ./mcp/transport/* (the advertised-or-refused gate, D11); the
// single source of truth for the advertised surface stays right here.
//
// v0.13 wave-3 (Track D, W3-1) restoration: wave-2's `propertyNames()`
// stripped every advertised property down to a bare `{}` — no `type`, no
// `description` — across all 151 property sites in this file, in exchange
// for a smaller minified byte count. That is the exact defect class
// `guideSchemaParity.spec.ts` and the 2026-08-01 guard-resurrection wave
// exist to catch on the OTHER axis (a capability the guide/server instructs
// but the schema hides): a schema-valid caller with no other source of
// truth (no guide loaded, a host that only reads `tools/list`) cannot tell
// what a bare `{}` property is FOR, what values it takes, or that it exists
// at all beyond its bare name. Every property below is restored with a
// short (<=120 char), imperative description; `propertyNames()` is deleted
// so a future edit cannot silently reintroduce the bare-`{}` shape by
// reaching for the old helper. See schemaSize.spec.ts's byte-budget test
// for the measured cost this restoration accepts (ledger comment there
// records the before/after).
const closed = (properties: Record<string, unknown>) => ({
  additionalProperties: false,
  properties,
});

const CANONICAL_ARCHIVE = closed({
  path: { type: "string", description: "Archive path (.zip)." },
  member: { type: "string", description: "Member path in the archive." },
  prefix: { type: "string", description: "Only members under this prefix." },
});
const CANONICAL_TASK = {
  ...closed({
    handle: { type: "string", description: "Resumes a prior task_pack." },
    epoch: { type: "string", description: "\"new\": resets task-pack state." },
    profile: { type: "string", description: "answer=read-only, generic=change." },
    expected_state_version: { type: "number", description: "CAS guard vs stale state." },
    challenge: { type: "object", description: "Re-authorizes a decision." },
    force_serve: { type: "boolean", description: "Re-serves already-served bodies." },
    pull: { enum: ["closure"], description: "Returns the closure report." },
  }),
  dependentRequired: { expected_state_version: ["handle"] },
};
const CANONICAL_SCOPE = {
  // W2-1(c): `mapCanonicalScope` (below) has always read `scope.symbol` and
  // copied it onto the legacy `symbol` dispatch argument — it was reachable
  // through dispatch but never advertised, so a caller composing
  // `search_files` references/find against a specific symbol via the
  // canonical `scope` carrier got an unknown-arguments refusal for a field
  // the server already implements. This is the same class of defect the
  // guard-resurrection wave fixed for other hidden-capability cases: an
  // unadvertised accepted field is not a private implementation detail, it
  // is a capability the caller cannot reach without already knowing the
  // server's internals.
  ...closed({
    path: { type: "string", description: "Root path to search under." },
    credentialRef: { type: "string", description: "Credential ref; never raw." },
    lang: { type: "string", description: "Language hint." },
    regex: { type: "boolean", description: "Regex mode (find only)." },
    depth: { type: "number", description: "Max tree depth." },
    includeClosure: { type: "boolean", description: "Returns the task_pack closure." },
    surfaceRoles: { type: "array", items: { type: "string" }, description: "Surface roles for closure." },
    includeScores: { type: "boolean", description: "Match-confidence scores." },
    symbol: { type: "string", description: "Symbol to address/search." },
    archive: { ...CANONICAL_ARCHIVE, description: "Archive: path/member/prefix." },
    kind: { enum: ["text", "symbol"], description: "text or a resolved symbol." },
  }),
};
// W3-4(b): search_files delivers only the byte/token/item dimensions — it has
// no Office table concept (rows/cells) and no full-read escalation
// (allowFull) for a search RESULT the way a file read does. Before this
// split, CANONICAL_BUDGET was one object shared verbatim across read_file
// and search_files, so search_files ADVERTISED all six budget members while
// `LEGACY_DISPATCH_PROPERTIES.search_files` recognizes none of
// rows/cells/allowFull — a schema-valid `search_files` call using any of the
// three was refused `unknown-arguments` by the very next gate
// (canonicalSurface.spec.ts's D-5 property test found and documented this
// live). Splitting the advertised shape per tool closes the gap by
// narrowing the AD, not by widening dispatch to accept table/full-read
// concepts a search result does not have.
const CANONICAL_BUDGET_DIMENSIONS = {
  bytes: { type: "number", description: "Byte cap." },
  tokens: { type: "number", description: "Token cap." },
  items: { type: "number", description: "Item cap." },
} as const;
const CANONICAL_BUDGET = {
  ...closed({
    ...CANONICAL_BUDGET_DIMENSIONS,
    rows: { type: "number", description: "Row cap (Office)." },
    cells: { type: "number", description: "Cell cap (Office)." },
    allowFull: { type: "boolean", description: "Higher full-read cap." },
  }),
};
const CANONICAL_SEARCH_BUDGET = {
  ...closed({ ...CANONICAL_BUDGET_DIMENSIONS }),
};
const CANONICAL_TARGET = {
  ...closed({
    path: { type: "string", description: "File path to read." },
    handle: { type: "string", description: "Handle; resolves path/symbol/range." },
    credentialRef: { type: "string", description: "Credential ref; never raw." },
    range: { type: "string", description: "1-based N-M line window." },
    ranges: { type: "array", items: { type: "string" }, description: "Several N-M windows, one target." },
    symbol: { type: "string", description: "Symbol in this target." },
    purpose: { type: "string", description: "Why this target is needed." },
    profile: { type: "string", description: "Skeleton rendering profile." },
    lang: { type: "string", description: "Language hint." },
    archive: { ...CANONICAL_ARCHIVE, description: "Archive: path/member/prefix." },
  }),
  oneOf: [{ required: ["path"] }, { required: ["handle"] }],
};
const CANONICAL_SELECT = {
  ...closed({
    kind: { type: "string", description: "xlsx/pptx/pdf/zip kind." },
    format: { type: "string", description: "Output format (text/json)." },
    comments: { enum: ["elide", "keep"], description: "elide (default) or keep." },
    sheet: { type: "string", description: "Worksheet name (xlsx)." },
    rows: { type: "array", items: { type: "number" }, description: "Row selector (xlsx)." },
    columns: { type: "array", items: { type: "string" }, description: "Column selector (xlsx)." },
    sections: { type: "array", items: { type: "string" }, description: "Headings to serve (max 8)." },
    slides: { type: "array", items: { type: "string" }, description: "Slide numbers (pptx)." },
    pages: { type: "array", items: { type: "string" }, description: "Page numbers/ranges (pdf)." },
  }),
};

// W2-2: the subset of `select`'s fields that address a specific ARTIFACT
// sub-resource (a workbook sheet/rows/columns, a slide, a page, an explicit
// `kind`/`format`) and therefore mean "serve this target through the
// artifact reader". `comments` and `sections` are also `select` fields but
// are NOT artifact addressing — `comments` rides the ordinary read path
// (the long-standing `comments:"keep"` argument) and `sections` has its own
// dedicated markdown-heading route (`args.sections`, server.ts's "Markdown
// section read" block) that runs independently of `mode`. Naming this list
// once, here, is what `mapCanonicalSelect` below tests against; it used to
// treat "any select field present" as "route to artifact", which sent a
// bare `select:{sections:[...]}` or `select:{comments:"keep"}` canonical
// call into artifact serving — a reader that cannot answer either request.
export const ARTIFACT_SELECT_KEYS: readonly string[] =
  ["kind", "format", "sheet", "rows", "columns", "slides", "pages"];
const CANONICAL_EDIT_ITEM = {
  ...closed({
    path: { type: "string", description: "File path to edit." },
    from: { type: "string", description: "Source path/handle for create-by-copy." },
    handle: { type: "string", description: "Handle; resolves path/symbol/range." },
    range: { type: "string", description: "1-based N-M range." },
    search: { type: "string", description: "Text to find (with replace)." },
    replace: { type: "string", description: "Text (pair with search)." },
    content: { type: "string", description: "Text for range, or whole file." },
    create: { type: "boolean", description: "true: creates a new file." },
    expectedSha: { type: "string", description: "Content hash (expected-hash)." },
    // W3-1(b): the enum this property carries is not decoration — it is the
    // only advertised list of the four legal `precondition` values, and a
    // schema-diet pass that reduced this to a bare `{}` deleted that list
    // outright rather than merely omitting its description.
    precondition: {
      type: "string",
      enum: ["unique-match", "expected-hash", "scope-handle", "references-reviewed"],
      description: "Write guard for this edit; see enum.",
    },
    allowPathFallback: { type: "boolean", description: "Fallback to path if handle fails." },
    target: { type: "string", description: "\"all\": replace every match." },
    scopeHandle: { type: "string", description: "For precondition=scope-handle." },
    directoryHandle: { type: "string", description: "Create-into-directory address." },
    review: { type: "boolean", description: "Attach review metadata." },
    intent: {
      ...closed({
        from: { type: "string", description: "Rename source symbol name." },
        to: { type: "string", description: "Symbol name (rename/append-*)." },
        symbol: { type: "string", description: "Symbol for this intent." },
        lang: { type: "string", description: "Language hint." },
        includeComments: { type: "boolean", description: "Also update matching comments." },
        kind: {
          enum: ["rename", "remove-duplicate-branch", "append-union-member", "append-enum-member", "rename-symbol-references"],
          description: "Structural intent to run.",
        },
      }),
      description: "Rename/append/dedupe a member.",
    },
  }),
  // W2-1(b): the three original branches left two dispatch-accepted item
  // shapes schema-INVALID (protocol-v1-snapshot.json carries two frozen
  // emits of exactly this kind, self-rejected by their own advertised
  // schema before this fix): an INTENT edit (`{path|handle, intent:{...}}`,
  // no search/replace/range/content of its own — `normalizeCanonicalRequest`
  // has always unpacked `intent` into the legacy mode/from/to/symbol
  // dispatch shape) and a WHOLE-FILE REPLACE (`{handle|path, content}`, no
  // `range` — the top-level `{handle,content}` form documented in
  // AGENTS.md's edit protocol section). The whole-file-replace branch
  // excludes range/create/search so it cannot double-match branches 2/3, or
  // silently accept a truncated search+replace/range+content/create+content
  // shape that is missing its required partner field.
  oneOf: [
    { required: ["search", "replace"] },
    { required: ["range", "content"] },
    { required: ["create", "content"] },
    { required: ["create", "from"], not: { required: ["content"] } },
    { required: ["intent"] },
    {
      required: ["content"],
      not: { anyOf: [{ required: ["range"] }, { required: ["create"] }, { required: ["search"] }] },
    },
  ],
};

// D-2 advertised-only input surface. Legacy spellings are normalized at the
// dispatch boundary for the v0.13.x compatibility window.
export const ALL_TOOLS: ToolEntry[] = [
  {
    name: "read_file",
    enabled: !KILL_SWITCH,
    definition: {
      name: "read_file",
      description: "Read via query/qref or targets[].",
      _meta: { "anthropic/alwaysLoad": true, ...PROTOCOL_META },
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object",
        ...closed({
          query: { type: "string", description: "Task-pack intent, verbatim." },
          qref: { type: "string", description: "Replay token; re-pack with it." },
          targets: { items: CANONICAL_TARGET, description: "Files/handles to read." },
          content: { enum: ["auto", "outline", "full"], description: "auto/outline/full hint." },
          select: { ...CANONICAL_SELECT, description: "Artifact/projection selector." },
          budget: { ...CANONICAL_BUDGET, description: "Serving budget caps." },
          task: { ...CANONICAL_TASK, description: "Task/closure control." },
          lane: { type: "string", description: "Concurrency isolation key." },
          cwd: { type: "string", description: "Worktree root for this call." },
          scope: { ...CANONICAL_SCOPE, description: "Read scope fields." },
        }),
        oneOf: [
          { required: ["query"], not: { required: ["targets"] } },
          { required: ["targets"], not: { required: ["query"] } },
          { required: ["query", "targets"] },
          { required: ["task"], not: { anyOf: [{ required: ["query"] }, { required: ["targets"] }] } },
          // W3-4(a) (wave-2 handoff): a BARE `qref` (no query/targets/task) is
          // the sanctioned replay shape AGENTS.md documents verbatim ("Re-pack
          // with the returned `qref`, no `query`"), and the legacy dispatch
          // path (resolveTaskPackQueryArg, further down this file) has always
          // resolved it correctly on its own — `qref` needs no canonical ->
          // legacy translation because it is already the same top-level
          // spelling both ways. Only the ADVERTISED schema was missing this
          // branch (capabilityReachability.spec.ts's "read.qref-only" case,
          // filed there as a wave-3 finding rather than fixed in wave 2).
          { required: ["qref"], not: { anyOf: [{ required: ["query"] }, { required: ["targets"] }, { required: ["task"] }] } },
        ],
      },
    },
  },
  {
    name: "edit_file",
    enabled: !KILL_SWITCH,
    definition: {
      name: "edit_file",
      description: "Edit via edits[] or artifact.",
      _meta: { "anthropic/alwaysLoad": true },
      // W3-4(d) (wave-2 handoff, cross-audit P2): edit_file deliberately has
      // NO top-level `scope`. The D-REPORT census approved exactly 7
      // top-level fields for this tool (edits, artifact, operation_id, task,
      // lane, cwd, credentials); an 8th, `scope`, was live on this schema
      // between waves 1 and 3, reusing the same CANONICAL_SCOPE object
      // read_file/search_files advertise. Live probing confirmed this was an
      // ACTIVE DEFECT, not merely unused surface: `normalizeCanonicalRequest`'s
      // shared preamble runs `mapCanonicalScope` for every tool alike, so
      // `scope.regex` / `scope.includeClosure` / `scope.archive` /
      // `scope.depth` / `scope.surfaceRoles` / `scope.includeScores` were
      // schema-VALID per this file's own advertised shape yet refused
      // `unknown-arguments` at dispatch (none of those legacy-mapped names
      // are in `LEGACY_DISPATCH_PROPERTIES.edit_file`) — an advertised
      // capability the server could never actually honour, the mirror image
      // of the capability-reachability class W2-1 fixed. The remaining
      // fields that DID happen to pass through (`scope.path`,
      // `scope.credentialRef`, `scope.lang`, `scope.symbol`, because those
      // spellings are ALSO legacy edit_file properties for unrelated
      // reasons) are duplicate-authority shadows of edit_file's own
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
        type: "object",
        ...closed({
          edits: { items: CANONICAL_EDIT_ITEM, description: "Batch independent edits, ONE call." },
          artifact: {
            ...closed({
              kind: { type: "string", enum: ["xlsx", "docx", "pptx", "pdf", "zip"], description: "Artifact format." },
              cells: {
                type: "array",
                description: "Sheet/cell/value/formula writes.",
                items: {
                  type: "object",
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
                  type: "object",
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
                  type: "object",
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
        // (`edit_file artifact={kind:"zip",members:[...]}`, AGENTS.md's own
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
    name: "search_files",
    enabled: !KILL_SWITCH,
    definition: {
      name: "search_files",
      description: "Find/reference/diff/tree via queries[].",
      _meta: { "anthropic/alwaysLoad": true },
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object",
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

const SCHEMA_DEFS_ENABLED = schemaDefsEnabled();

/**
 * F-1 opt-in structural sharing. The default remains the expanded schema
 * (fail-closed) until the three real-client compatibility checks pass.
 */
function enableSchemaDefs(): void {
  if (!SCHEMA_DEFS_ENABLED) return;
  const read = ALL_TOOLS.find((entry) => entry.name === "read_file")?.definition;
  const edit = ALL_TOOLS.find((entry) => entry.name === "edit_file")?.definition;
  const search = ALL_TOOLS.find((entry) => entry.name === "search_files")?.definition;
  if (!read || !edit || !search) return;

  const ref = (name: string): SchemaNode => ({ $ref: `#/$defs/${name}` } as unknown as SchemaNode);
  const replace = (schema: Record<string, unknown>, defs: Record<string, unknown>, keyRefs: Array<[string, string]>) => {
    schema.$defs = defs;
    const props = schema.properties as Record<string, SchemaNode>;
    for (const [key, name] of keyRefs) {
      const prior = props[key];
      props[key] = { ...ref(name), ...(prior && "description" in prior ? { description: prior.description } : {}) };
    }
  };

  const readSchema = read.inputSchema as Record<string, unknown>;
  const readProps = readSchema.properties as Record<string, SchemaNode>;
  const readTarget = structuredClone((readProps.targets as Record<string, unknown>).items);
  replace(readSchema, {
    taskControl: structuredClone(CANONICAL_TASK),
    readScope: structuredClone(CANONICAL_SCOPE),
    readBudget: structuredClone(CANONICAL_BUDGET),
    readTarget,
    readSelect: structuredClone(CANONICAL_SELECT),
  }, [["task", "taskControl"], ["scope", "readScope"], ["budget", "readBudget"], ["select", "readSelect"]]);
  (readSchema.properties as Record<string, Record<string, unknown>>).targets.items = ref("readTarget");

  const editSchema = edit.inputSchema as Record<string, unknown>;
  const editProps = editSchema.properties as Record<string, SchemaNode>;
  const editItem = structuredClone((editProps.edits as Record<string, unknown>).items);
  const artifact = structuredClone(editProps.artifact);
  const credentials = structuredClone(editProps.credentials);
  replace(editSchema, {
    taskControl: structuredClone(CANONICAL_TASK),
    editItem,
    artifact,
    credentials,
  }, [["task", "taskControl"], ["artifact", "artifact"], ["credentials", "credentials"]]);
  (editSchema.properties as Record<string, Record<string, unknown>>).edits.items = ref("editItem");

  const searchSchema = search.inputSchema as Record<string, unknown>;
  replace(searchSchema, {
    taskControl: structuredClone(CANONICAL_TASK),
    searchScope: structuredClone(CANONICAL_SCOPE),
    searchBudget: structuredClone(CANONICAL_SEARCH_BUDGET),
  }, [["task", "taskControl"], ["scope", "searchScope"], ["budget", "searchBudget"]]);
}

enableSchemaDefs();

const EDIT_FILE_ADVISORY_ARGS: readonly string[] = PENDING_C6_ADJUDICATION["edit_file"] ?? [];

function legacyProperties(names: readonly string[]): Record<string, SchemaNode> {
  return Object.fromEntries(names.map((name) => [name, {}])) as Record<string, SchemaNode>;
}

const LEGACY_CHALLENGE_SCHEMA: SchemaNode = {
  type: "object",
  properties: legacyProperties(["certificate_id", "obligation_id", "expected_action_change"]),
};
const LEGACY_ARCHIVE_SCHEMA: SchemaNode = {
  type: "object",
  properties: legacyProperties(["path", "member", "prefix"]),
};
const LEGACY_ARTIFACT_SCHEMA: SchemaNode = {
  type: "object",
  properties: {
    ...legacyProperties(["kind", "flatten"]),
    cells: {
      type: "array",
      items: { type: "object", properties: legacyProperties(["sheet", "cell", "value", "formula"]) },
    },
    replacements: {
      type: "array",
      items: { type: "object", properties: legacyProperties(["search", "replace", "all"]) },
    },
    form: { type: "object" },
    members: {
      type: "array",
      items: { type: "object", properties: legacyProperties(["action", "member", "content", "sourcePath"]) },
    },
  },
};
const LEGACY_EDIT_ITEM_SCHEMA: SchemaNode = {
  type: "object",
  properties: {
    ...legacyProperties([
      "path", "handle", "range", "search", "replace", "content", "create", "from", "expectedSha", "precondition",
      "allowPathFallback", "target", "scopeHandle", "directoryHandle", "review",
    ]),
    intent: {
      type: "object",
      properties: legacyProperties(["kind", "from", "to", "symbol", "lang", "includeComments"]),
    },
  },
};
const LEGACY_PATHS_SCHEMA: SchemaNode = {
  type: "array",
  items: {
    type: ["string", "object"],
    properties: legacyProperties(["path", "purpose", "range", "symbol"]),
  },
};

const LEGACY_DISPATCH_PROPERTIES: Record<string, Record<string, SchemaNode>> = {
  read_file: {
    ...legacyProperties([
    "path", "credentialRef", "mode", "symbol", "handle", "handles", "query", "qref",
    "taskProfile", "lang", "maxTokens", "allowFull", "content", "comments", "includeClosure", "surfaceRoles",
    "sheet", "range", "ranges", "sections", "slides", "pages", "maxBytes", "limit", "profile", "kind", "as",
    "columns", "rows", "maxRows", "maxCells", "taskEpoch", "task_handle", "lane",
    "expected_state_version", "force_serve", "cwd",
    ]),
    archive: LEGACY_ARCHIVE_SCHEMA,
    challenge: LEGACY_CHALLENGE_SCHEMA,
    paths: LEGACY_PATHS_SCHEMA,
  },
  edit_file: {
    ...legacyProperties([
      "path", "credentialRef", "outputCredentialRef", "handle", "search", "replace", "content",
      "create", "from", "intent", "symbol", "lang", "mode", "to", "review", "operation_id", "precondition",
      "allowPathFallback", "target", "expectedSha", "scopeHandle", "directoryHandle", "includeComments",
      "taskEpoch", "task_handle", "lane", "expected_state_version", "force_serve", "cwd",
    ]),
    artifact: LEGACY_ARTIFACT_SCHEMA,
    challenge: LEGACY_CHALLENGE_SCHEMA,
    edits: { type: "array", items: LEGACY_EDIT_ITEM_SCHEMA },
  },
  search_files: {
    ...legacyProperties([
    "action", "query", "queries", "path", "credentialRef", "depth", "lang", "limit", "cursor",
    "includeClosure", "surfaceRoles", "regex", "symbol", "includeScores", "taskProfile", "maxTokens",
    "maxBytes", "taskEpoch", "task_handle", "lane", "expected_state_version", "force_serve", "cwd",
    ]),
    archive: LEGACY_ARCHIVE_SCHEMA,
    challenge: LEGACY_CHALLENGE_SCHEMA,
  },
};

function advertisedPropertiesFor(tool: string): Record<string, SchemaNode> {
  const definition = ALL_TOOLS.find((entry) => entry.name === tool)!.definition;
  const inputSchema = definition["inputSchema"] as { properties: Record<string, SchemaNode> };
  return inputSchema.properties;
}

function dispatchPropertiesFor(tool: string): Record<string, SchemaNode> {
  return LEGACY_DISPATCH_PROPERTIES[tool] ?? advertisedPropertiesFor(tool);
}

/** Test-only readback of the post-normalizer validation surface. */
export function dispatchPropertiesForTest(tool: string): Record<string, SchemaNode> {
  return structuredClone(dispatchPropertiesFor(tool));
}

// ---------------------------------------------------------------------------
// TC-2 (A.9.4): every EMITTED `ToolCall` passes the server's own inbound
// request-shape validator. `ToolCall.arguments` is open at the TYPE level —
// A.9.4 says so, because the advertised schema is the authority and duplicating
// it into TypeScript would create a second one — and it is CLOSED at runtime by
// this registration plus the TC-2 spec. A call this server would refuse if the
// caller sent it is never a call this server tells the caller to send.
// ---------------------------------------------------------------------------
setEmittedToolCallValidator((call) => {
  const definition = ALL_TOOLS.find((entry) => entry.name === call.tool);
  if (definition === undefined) return false;
  const argumentsRecord = call.arguments as Record<string, unknown>;
  // Producers are migrated independently: older ones reach this pre-wire gate
  // in the accepted dispatch spelling, while newer ones already author the
  // canonical public spelling. The finalizer canonicalizes both immediately
  // afterwards. Mirror inbound acceptance here so neither valid generation is
  // discarded before it can reach that projection, while an unknown field is
  // still rejected by both closed schemas.
  return requestShapeRefusal(call.tool, dispatchPropertiesFor(call.tool), argumentsRecord) === null
    || requestShapeRefusal(call.tool, advertisedPropertiesFor(call.tool), argumentsRecord) === null;
});

function editFileAdvertisedProperties(): Record<string, unknown> {
  return dispatchPropertiesFor("edit_file") as Record<string, unknown>;
}

/**
 * Exported so refusal payloads can be checked against the very schema this
 * dispatch enforces: the server must never PRESCRIBE a call its own dispatch
 * refuses (2026-08-02 T05c rep0 idx 155→156 — the prescribed next_call was
 * rejected by the edits[] mapping loop and the cell abandoned TL on the next
 * turn). Pinned by executionTypestate.spec.ts R5.1/R5.3 and the rdl replay
 * group.
 */
export const EDIT_FILE_KNOWN_ARGS: ReadonlySet<string> = new Set([
  ...Object.keys(editFileAdvertisedProperties()),
  ...EDIT_FILE_ADVISORY_ARGS,
]);

export const EDIT_FILE_KNOWN_EDITS_ITEM_ARGS: ReadonlySet<string> = new Set(
  Object.keys(
    (editFileAdvertisedProperties()["edits"] as { items: { properties: Record<string, unknown> } }).items.properties,
  ),
);

// ---------------------------------------------------------------------------
// F-R8 (W8-C, 2026-08-22): measured in bench/workflows/runs/
// 2026-08-22-v011-decision-6t-1 (T05c rep0 arm A) — a solver placed `review`
// (then, on retry, `replace_all`) inside three `edits[]` items. Both are
// unknown-arguments refusals by construction (correct — a write tool must
// fail closed), but neither refusal told the caller anything about WHERE the
// key it used actually lives:
//
//  - `review`/`operation_id`/`cwd`/`lane`/… ARE real edit_file arguments —
//    just top-level ones. `keys` on a per-item violation only ever lists the
//    PER-ITEM advertised set (content/expectedSha/handle/path/precondition/
//    range/replace/search), so a caller who typed a real name saw no
//    evidence it was real anywhere on the wire.
//  - `replace_all` is not advertised at EITHER nesting depth. It is the
//    native Edit tool's vocabulary; edit_file's equivalent is
//    `precondition:"unique-match"` for a single site, or one `edits[]` item
//    per site.
//
// Both cost the caller a full round trip in the measured transcript. This
// section only ADDS explanatory text (`detail` and, for the top-level-arg
// case, `did_you_mean`) to an already-correct refusal — it never changes
// whether edit_file refuses.
// ---------------------------------------------------------------------------
const EDIT_FILE_TOP_LEVEL_ONLY_ARGS: ReadonlySet<string> = new Set(
  [...EDIT_FILE_KNOWN_ARGS].filter(
    (key) => key !== "edits" && !EDIT_FILE_KNOWN_EDITS_ITEM_ARGS.has(key),
  ),
);

/** The extra guidance for one unknown per-item key, or undefined if neither shape applies. */
function editFileMisnestedArgHint(key: string): string | undefined {
  if (key === "replace_all") {
    return "per-item `replace_all` is not advertised; use `precondition:\"unique-match\"` for a single site or one edit item per site / `edits[]`";
  }
  if (EDIT_FILE_TOP_LEVEL_ONLY_ARGS.has(key)) {
    return `\`${key}\` is a top-level edit_file argument, not a per-edit key — move it up`;
  }
  return undefined;
}

function editFileUnknownArgumentRefusal(args: Record<string, unknown>): Record<string, unknown> | null {
  // §1.3.1(1) wants ONE recursive engine, so the detection lives in
  // validation/requestShape.ts and this function keeps only the RENDERING.
  // The fields the 2026-08-01 incident specs pin (`unknown_arguments`,
  // `unknown_edits_item_arguments`, the corrective `next_call`) are unchanged
  // and in the same places; §1.3.1's `field` / `did_you_mean` / `keys` /
  // `retry` ride alongside them. Over edit_file's schema the shared walk
  // produces MORE than the two groups the old hand-rolled filter handled:
  // top-level keys, keys inside `edits[]` items — AND, since C-6 gave
  // `artifact`/`challenge` their own declared keys, keys nested inside
  // THOSE two as well (`edits.items` is no longer the only declared nested
  // shape). Row 18 (C2-6): a violation whose `parentPath` is neither
  // exactly "edit_file" nor an `edits[N]` match — e.g. `artifact.bogus_key`
  // — used to fail BOTH grouping branches below and vanish from every named
  // field list; `fields` (below) now names every violation unconditionally,
  // regardless of which bucket (or no bucket) it also sorts into.
  const violations = findUnknownProperties("edit_file", dispatchPropertiesFor("edit_file"), args);
  if (violations.length === 0) return null;
  const unknownTop: string[] = [];
  const unknownItems: Array<{ index: number; arguments: string[] }> = [];
  for (const violation of violations) {
    if (violation.parentPath === "edit_file") {
      unknownTop.push(violation.field);
      continue;
    }
    const nested = /^edits\[(\d+)\]\.([\s\S]+)$/.exec(violation.field);
    if (nested === null) continue;
    const index = Number(nested[1]);
    const existing = unknownItems.find((entry) => entry.index === index);
    if (existing !== undefined) existing.arguments.push(nested[2]!);
    else unknownItems.push({ index, arguments: [nested[2]!] });
  }
  // F-R8: a per-item key that is really one of edit_file's TOP-LEVEL
  // arguments is a real capability one nesting level too deep, not noise —
  // say so, and surface it via the existing `did_you_mean` near-miss slot
  // even though it is a nesting error rather than a spelling one. Keyed off
  // `violations[0]` because that is the one violation `did_you_mean` (below)
  // already speaks for.
  const first = violations[0]!;
  const firstNested = /^edits\[(\d+)\]\.([\s\S]+)$/.exec(first.field);
  const firstBareKey = firstNested !== null ? firstNested[2] : first.field;
  const misnestedDidYouMean =
    firstBareKey !== undefined && EDIT_FILE_TOP_LEVEL_ONLY_ARGS.has(firstBareKey) ? firstBareKey : undefined;
  const misnestedHints: string[] = [];
  for (const key of [...unknownTop, ...unknownItems.flatMap((item) => item.arguments)]) {
    const hint = editFileMisnestedArgHint(key);
    if (hint !== undefined && !misnestedHints.includes(hint)) misnestedHints.push(hint);
  }
  // §1.3.1(4)(5) + CONDITION ②. `keys` is weighed against the bytes THIS
  // payload actually emits, not the shared renderer's shorter body.
  const shape = unknownPropertyRefusal("edit_file", violations)!;
  const pathQualified = {
    field: shape.field,
    ...((shape.did_you_mean ?? misnestedDidYouMean) !== undefined
      ? { did_you_mean: (shape.did_you_mean ?? misnestedDidYouMean)! }
      : {}),
    retry: shape.retry,
  };

  // The measured incident shape maps 1:1 onto an edits[] anchor item — hand
  // back the runnable corrected call. `content` stays a placeholder: the
  // caller already holds their own bytes, echoing them back is pure cost.
  const incidentShape =
    unknownItems.length === 0
    && unknownTop.length === 1
    && unknownTop[0] === "range"
    && typeof args["range"] === "string"
    && args["content"] !== undefined
    && (typeof args["handle"] === "string" || typeof args["path"] === "string");
  const refusal = {
    ok: false,
    reason: "unknown-arguments",
    code: "unknown-arguments",
    ...pathQualified,
    // Row 18 (C2-6): the COMPLETE path-qualified violation set, unconditionally
    // — not just whichever of unknownTop/unknownItems a violation sorted into.
    fields: violations.map((v) => v.field),
    ...(unknownTop.length > 0 ? { unknown_arguments: unknownTop } : {}),
    ...(unknownItems.length > 0 ? { unknown_edits_item_arguments: unknownItems } : {}),
    error:
      "edit_file refuses arguments outside its advertised schema instead of dropping them — on a write tool a dropped argument can silently change which span is overwritten (a dropped top-level `range` once turned a 113-line replacement into a whole-file overwrite)"
      + (misnestedHints.length > 0 ? ` — ${misnestedHints.join("; ")}` : ""),
    ...(incidentShape
      ? {
          note: "top-level {handle, content} always replaces the handle's ENTIRE range; a line-range replacement is an edits[] item: edits:[{handle, range, content}]",
          next_call: {
            tool: "edit_file",
            arguments: {
              edits: [
                {
                  ...(typeof args["handle"] === "string"
                    ? { handle: args["handle"] }
                    : { path: String(args["path"]) }),
                  range: String(args["range"]),
                  content: "<replacement text for exactly those lines>",
                },
              ],
            },
          },
        }
      : {
          next: "re-issue with only advertised edit_file arguments; a line-range replacement is edits:[{handle, range, content}]",
        }),
  };
  const withKeys = { ...refusal, keys: [...(shape.keys ?? [])] };
  return shape.keys !== undefined && withinRefusalBudget(withKeys) ? withKeys : refusal;
}

export function advertisedTools() {
  if (KILL_SWITCH) return [];
  // Deep-copy each definition. ALL_TOOLS holds the single source-of-truth
  // schema objects; handing out the live references let any caller (a test
  // that inspects+mutates the schema, or a future in-process consumer) mutate
  // them in place, and that mutation would leak into every later
  // advertisedTools() call in the same process — corrupting an unrelated
  // caller's tools/list AND cross-contaminating tests that assert on the
  // schema (e.g. a nested `description` length). structuredClone severs that
  // sharing so each caller gets an independent tree.
  // D11: no `deprecated` filter — ALL_TOOLS holds only advertised tools now,
  // so advertised == accepted by construction rather than by agreement.
  return ALL_TOOLS.filter((t) => t.enabled).map((t) => structuredClone(t.definition));
}

function extractRangeText(content: string, range: string): string | null {
  const match = range.match(/^(\d+)(?:-(\d+))?$/);
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2] ?? match[1]);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) return null;
  const lines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  return lines.slice(start - 1, end).join("\n") + "\n";
}

/**
 * H4: hash the "start-end" line slice of `content` the SAME way resolveSlice
 * (readCodeModes.ts) mints a range handle's sha — split on /\r?\n/, take
 * lines[start-1 .. end] inclusive, join with "\n", shaOfText. Used to refresh
 * a range/symbol handle's stored sha to its POST-edit SLICE content (not the
 * whole file) so a follow-up re-read dedupes to the same handle id. Returns
 * undefined for a malformed range (caller falls back to the whole-file sha).
 */
function sliceShaForRange(content: string, range: string): string | undefined {
  const m = range.match(/^(\d+)(?:-(\d+))?$/);
  if (!m) return undefined;
  const start = Number(m[1]);
  const end = Number(m[2] ?? m[1]);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) return undefined;
  const lines = content.split(/\r?\n/);
  const slice = lines.slice(start - 1, end).join("\n");
  return shaOfText(slice);
}

function contentHasElisionMarker(value: unknown): boolean {
  return typeof value === "string"
    && (ELISION_MARKER_RE.test(value) || TL_SYNTHETIC_MARKER_RE.test(value));
}

type ElisionMarkerField = "content" | "replace" | "search" | "target";

interface ElisionMarkerRefusalOptions {
  field: ElisionMarkerField;
  path?: string;
  range?: string;
  failedItem?: number;
}

function elidedContentRefusal({
  field,
  path,
  range,
  failedItem,
}: ElisionMarkerRefusalOptions): Record<string, unknown> {
  const validRange = typeof range === "string" && /^\d+(?:-\d+)?$/.test(range);
  const reread = path
    ? validRange
      ? canonicalToolCall("read_file", { mode: "slice", path, range, comments: "keep" })
      : canonicalToolCall("read_file", { mode: "full", path, comments: "keep" })
    : canonicalToolCall("read_file", { mode: "task_pack", query: "re-read the affected source with comments kept" });

  return {
    ok: false,
    reason: "elided-content",
    code: "elided-content",
    ...(path ? { path } : {}),
    ...(failedItem !== undefined ? { failed_item: { index: failedItem } } : {}),
    hint: field === "search"
      ? "search is a placeholder from a compressed read, not file text; re-read with comments=\"keep\" or anchor on an actual file line"
      : "the replacement text contains an elision marker from a compressed read; re-read with comments=\"keep\" and resend real source text",
    next: reread,
  };
}

function artifactReplacementElisionField(value: unknown): ElisionMarkerField | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const artifact = value as Record<string, unknown>;
  const inspect = (fields: ReadonlyArray<readonly [ElisionMarkerField, unknown]>): ElisionMarkerField | undefined => {
    for (const [field, candidate] of fields) {
      if (contentHasElisionMarker(candidate)) return field;
    }
    return undefined;
  };

  const replacements = artifact["replacements"];
  if (Array.isArray(replacements)) {
    for (const replacement of replacements) {
      if (replacement === null || typeof replacement !== "object" || Array.isArray(replacement)) continue;
      const row = replacement as Record<string, unknown>;
      const found = inspect([
        ["search", row["search"]],
        ["replace", row["replace"]],
      ]);
      if (found !== undefined) return found;
    }
  }

  const members = artifact["members"];
  if (Array.isArray(members)) {
    for (const member of members) {
      if (member === null || typeof member !== "object" || Array.isArray(member)) continue;
      const found = inspect([["content", (member as Record<string, unknown>)["content"]]]);
      if (found !== undefined) return found;
    }
  }

  const cells = artifact["cells"];
  if (Array.isArray(cells)) {
    for (const cell of cells) {
      if (cell === null || typeof cell !== "object" || Array.isArray(cell)) continue;
      const row = cell as Record<string, unknown>;
      const found = inspect([
        ["content", row["value"]],
        ["content", row["formula"]],
      ]);
      if (found !== undefined) return found;
    }
  }

  const form = artifact["form"];
  if (form !== null && typeof form === "object" && !Array.isArray(form)) {
    for (const field of Object.values(form as Record<string, unknown>)) {
      const values = Array.isArray(field) ? field : [field];
      const found = inspect(values.map((item) => ["content", item] as const));
      if (found !== undefined) return found;
    }
  }

  // sourcePath names already-existing bytes to copy into a ZIP member. It is
  // deliberately not text content, so binary payloads remain supported.
  return undefined;
}

const DISALLOWED_TEXT_CONTROL_CHARACTER_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/u;

interface TextControlCharacterField {
  field: string;
  character: string;
  failedItem?: number;
}

function firstDisallowedTextControlCharacter(
  fields: ReadonlyArray<readonly [string, unknown]>,
  failedItem?: number,
): TextControlCharacterField | undefined {
  for (const [field, value] of fields) {
    if (typeof value !== "string") continue;
    const match = DISALLOWED_TEXT_CONTROL_CHARACTER_RE.exec(value);
    if (match === null) continue;
    const codePoint = match[0]!.codePointAt(0)!;
    return {
      field,
      character: `U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}`,
      ...(failedItem !== undefined ? { failedItem } : {}),
    };
  }
  return undefined;
}

function artifactTextControlCharacterField(value: unknown): TextControlCharacterField | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const artifact = value as Record<string, unknown>;
  const inspect = (fields: ReadonlyArray<readonly [string, unknown]>): TextControlCharacterField | undefined =>
    firstDisallowedTextControlCharacter(fields);

  const replacements = artifact["replacements"];
  if (Array.isArray(replacements)) {
    for (const [index, replacement] of replacements.entries()) {
      if (replacement === null || typeof replacement !== "object" || Array.isArray(replacement)) continue;
      const row = replacement as Record<string, unknown>;
      const found = inspect([
        [`artifact.replacements[${index}].search`, row["search"]],
        [`artifact.replacements[${index}].replace`, row["replace"]],
      ]);
      if (found !== undefined) return found;
    }
  }

  const members = artifact["members"];
  if (Array.isArray(members)) {
    for (const [index, member] of members.entries()) {
      if (member === null || typeof member !== "object" || Array.isArray(member)) continue;
      const found = inspect([[`artifact.members[${index}].content`, (member as Record<string, unknown>)["content"]]]);
      if (found !== undefined) return found;
    }
  }

  const cells = artifact["cells"];
  if (Array.isArray(cells)) {
    for (const [index, cell] of cells.entries()) {
      if (cell === null || typeof cell !== "object" || Array.isArray(cell)) continue;
      const row = cell as Record<string, unknown>;
      const found = inspect([
        [`artifact.cells[${index}].value`, row["value"]],
        [`artifact.cells[${index}].formula`, row["formula"]],
      ]);
      if (found !== undefined) return found;
    }
  }

  const form = artifact["form"];
  if (form !== null && typeof form === "object" && !Array.isArray(form)) {
    for (const [name, field] of Object.entries(form as Record<string, unknown>)) {
      const values = Array.isArray(field) ? field : [field];
      for (const [index, item] of values.entries()) {
        const found = inspect([[`artifact.form.${name}${Array.isArray(field) ? `[${index}]` : ""}`, item]]);
        if (found !== undefined) return found;
      }
    }
  }

  // sourcePath names already-existing bytes to copy into a ZIP member. It is
  // deliberately not text content, so binary payloads remain supported.
  return undefined;
}

function textControlCharacterRefusal({
  field,
  character,
  failedItem,
}: TextControlCharacterField): Record<string, unknown> {
  return {
    ok: false,
    reason: "invalid-input",
    code: "invalid-input",
    field,
    ...(failedItem !== undefined ? { failed_item: { index: failedItem } } : {}),
    error: `${field} contains disallowed control character ${character}; text write arguments allow only LF (U+000A), TAB (U+0009), and CR (U+000D) control characters`,
    next: "remove the control character and re-issue the edit_file call",
  };
}

/**
 * item 11: parse the 1-based file START line from a "start-end" (or bare
 * "start") range string, for passing to elideDocComments so a slice's elision
 * markers carry TRUE file line numbers. Returns 1 for a malformed range (the
 * safe default — slice-relative, i.e. unchanged from before).
 */
function rangeStartLine(range: string | undefined): number {
  if (!range) return 1;
  const m = range.match(/^(\d+)(?:-\d+)?$/);
  if (!m) return 1;
  const start = Number(m[1]);
  return Number.isInteger(start) && start >= 1 ? start : 1;
}

/** 1-based inclusive logical line count — a trailing "\n" does not count as
 * an extra empty final line (mirrors applyEditsMulti.ts's countLogicalLinesEntry).
 * Thin alias kept for call-site readability at its one remaining call below;
 * the implementation now lives in util/countLines.ts, shared with every other
 * mint/bounds site that needs this exact trailing-newline-aware count. */
function countLogicalLinesForTail(content: string): number {
  return countLines(content);
}

/**
 * DESIGN-v0.8 B4.2: a `{handle, content}` range-replace only touches
 * [handleRange]; if the handle's range did not cover the WHOLE tiny file
 * (a live case: a handle minted as 1-11 of a 13-line stub), lines after the
 * replaced range are left completely untouched — including, in that case,
 * a docstring's own closing delimiter that the replace's incoming content
 * assumed it was also replacing. Rather than let that syntax error surface
 * only on the NEXT turn (a build/test failure several calls later), surface
 * the leftover tail lines inline in THIS success response so the model can
 * repair it in the same turn.
 *
 * Scoped narrowly to avoid false positives on ordinary partial-file edits:
 * only fires when (a) the edit succeeded, (b) the file is at/below the TINY
 * threshold (large files routinely have a range-scoped edit with an
 * intentionally untouched tail — that is normal, not an orphan), and (c) the
 * tail is 1-3 lines (a longer remainder is far more likely to be
 * deliberately out of scope than an accidentally-orphaned fragment).
 */
function attachOrphanTailWarning(
  result: Record<string, unknown>,
  preEditContent: string | null,
  handleRange: string,
): Record<string, unknown> {
  if ((result as { ok?: boolean }).ok === false) return result;
  if (preEditContent === null) return result;

  const m = handleRange.match(/^(\d+)(?:-(\d+))?$/);
  if (!m) return result;
  const rangeEnd = Number(m[2] ?? m[1]);
  if (!Number.isInteger(rangeEnd)) return result;

  const preEditBytes = Buffer.byteLength(preEditContent, "utf8");
  const totalLines = countLogicalLinesForTail(preEditContent);
  const isTiny = preEditBytes <= TINY_BYTES && totalLines <= TINY_LINES;
  if (!isTiny) return result;

  const tailCount = totalLines - rangeEnd;
  if (tailCount <= 0 || tailCount > 3) return result;

  const normalized = preEditContent.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const trimmed = normalized.endsWith("\n") ? normalized.slice(0, -1) : normalized;
  const allLines = trimmed.split("\n");
  const leftoverLines = allLines.slice(rangeEnd);

  return {
    ...result,
    warning: `${tailCount} line(s) after the replaced range (${handleRange}) were left unchanged — verify they still form valid content.`,
    leftoverLines,
  };
}

/**
 * B1/site-6: resolving `create=true from=<source>` used to silently return
 * null on a handle/workspace mismatch, and the create branch then fell back
 * to `String(args["content"] ?? "")` — creating the file with EMPTY content.
 * This discriminated result lets the caller tell "no usable source" (fall
 * back to args.content, today's legitimate no-op path) apart from "a real
 * source handle exists but conflicts under an explicit cwd" (must refuse,
 * never silently create an empty file). When `from` names a handle and no
 * explicit cwd was supplied, the handle's own workspaceRoot is adopted and
 * returned so the caller can create the file in the SAME tree the source
 * handle was minted from.
 */
type CreateSourceResolution =
  | { ok: true; content: string; workspace: string }
  | { ok: false; reason: "no-source" }
  | { ok: false; reason: "workspace-conflict"; entry: HandleEntry }
  | { ok: false; reason: "workspace-missing"; entry: HandleEntry };

/**
 * W2 (2026-08-07, create-frontier lifecycle): the progressive refusal that
 * replaces the bare `{"ok":false,"error":"file_exists"}` — 34 bytes, no
 * reason, no terminal flag, no unlock, no next_call, no handle — createFile.ts
 * returns when the target path already exists.
 *
 * Measured consequence of the bare shape (2026-08-07-semantic-signal5-2): the
 * caller had no served affordance at all, so it ran `rm -f <path>` and
 * re-created the file — a destructive five-turn repair of a file the same
 * session had authored four turns earlier.
 *
 * `terminal:true` is the honest verdict: createFile never overwrites, so a
 * verbatim retry can never succeed. Per the TL_REFUSAL_PROGRESS conventions a
 * terminal refusal therefore carries an `unlock`, and the way forward here is
 * the EXISTING file's identity: a kind:"file" handle minted from its current
 * on-disk bytes (the same handle an equivalent read mints and dedupes to), its
 * byte length and sha, plus `content_identical` so a caller whose create was
 * already a no-op can stop instead of editing.
 *
 * Deliberately does NOT enroll the path in the admissible edit union. Unlike a
 * SUCCESSFUL create (W1, recordCreatedEditAdmissibility), a create that
 * bounced off an existing file proves nothing about that file's content —
 * enrolling it would turn `create:true` into a blind-edit bypass of the
 * certificate frontier for any path in the tree. A path THIS session created
 * is already enrolled by W1, which is exactly the observed
 * create → frontier-refusal → file_exists → rm -f cascade this pair collapses.
 *
 * Returned through toolOk (not toolStructuredError) so the transport shape of
 * a file_exists answer is byte-for-byte the one every existing consumer sees:
 * a non-isError result whose body carries `ok:false` and the historical
 * `error:"file_exists"` token.
 */
async function createTargetExistsRefusal(
  relPath: string,
  requestedContent: string,
  workspace: string,
): Promise<Record<string, unknown>> {
  const existing = await readFileSafe(relPath, workspace);
  const cwd = { cwd: workspace };
  const identical = existing !== null && existing === requestedContent;
  const entry = existing !== null
    ? handleTable.upsert({
        kind: "file",
        path: relPath,
        workspaceRoot: workspace,
        sha: shaOfText(existing),
      })
    : undefined;
  const identity = existing !== null && entry !== undefined
    ? {
        handle: entry.id,
        bytes: Buffer.byteLength(existing, "utf8"),
        sha: shortSha(shaOfText(existing)),
        content_identical: identical,
      }
    : {};
  const unlock = entry === undefined
    ? {
        accepted_transitions: [`read_file path=${relPath}`],
        note: "the path exists but its bytes are not readable as text (a directory, or a binary/unreadable file) — inspect it before writing",
      }
    : identical
      ? {
          accepted_transitions: ["read_file mode=closure"],
          note: "the file already holds byte-identical content, so this create was a no-op — there is nothing to write; verify and finish",
        }
      : {
          accepted_transitions: [`edit_file handle=${entry.id}`, `read_file mode=full handle=${entry.id}`],
          note: "create:true never overwrites — edit the existing file through the handle served here, or read it first if you need its current body",
        };
  // S3 (C2-9), adjudicated 2026-08-14 — THE PRESCRIPTION MUST BE EXECUTABLE.
  //
  // The non-identical branch used to prescribe an edit_file carrying
  // `EDIT_SEARCH_PLACEHOLDER` / `EDIT_REPLACE_PLACEHOLDER`, which §2.6 forbids
  // outright ("a fully substituted `ToolCall`, never a placeholder template")
  // and `emittableToolCall` therefore REJECTS — so the v1 refusal shipped with
  // no `next` at all. A refusal that withholds and names no way forward is the
  // dead-end class F5/[R5-10] exist to remove, and here it was avoidable: the
  // server is holding the caller's own `requestedContent` and a `kind:"file"`
  // handle for the existing file, which is precisely the whole-file replace
  // shape (`edit_file {handle, content}`) that dispatch already accepts.
  //
  // The content is echoed back only when it FITS: a create whose body is a
  // megabyte would otherwise pay for itself twice in one refusal. Past the
  // budget the prescription degrades to reading the existing file through the
  // same handle — still fully substituted, still executable, and the second of
  // the two transitions the note already names. Neither branch is a template.
  const CREATE_RECOVERY_CONTENT_BUDGET_BYTES = 8192;
  const contentFits = Buffer.byteLength(requestedContent, "utf8") <= CREATE_RECOVERY_CONTENT_BUDGET_BYTES;
  const nextCall = entry === undefined
    ? { tool: "read_file", arguments: { path: relPath, ...cwd } }
    : identical
      ? { tool: "read_file", arguments: { mode: "closure", ...cwd } }
      : contentFits
        ? {
            tool: "edit_file",
            arguments: {
              handle: entry.id,
              content: requestedContent,
              ...cwd,
            },
          }
        : {
            tool: "read_file",
            arguments: {
              mode: "full",
              handle: entry.id,
              ...cwd,
            },
          };
  return {
    ok: false,
    // Unchanged wire fact: `error` keeps the historical machine token so the
    // remaining consumer (argMatrix's create-over-a-handle pin) keeps reading
    // the same value. The deprecated create_file tool that also read it is
    // deleted (D11).
    error: "file_exists",
    reason: "create-target-exists",
    applied: false,
    path: relPath,
    terminal: true,
    terminal_reason: "create-target-exists",
    retry_same_call: false,
    detail: `${relPath} already exists; create:true never overwrites an existing path`,
    ...identity,
    unlock,
    ...(nextCall.tool === "edit_file" ? { next_call_is_template: true } : {}),
    next_call: nextCall,
  };
}

async function resolveCreateSourceContent(
  from: unknown,
  workspace: string,
  cwdExplicit: boolean,
): Promise<CreateSourceResolution> {
  if (typeof from !== "string" || from.trim() === "") return { ok: false, reason: "no-source" };
  const source = from.trim();
  const entry = handleTable.get(source);
  if (entry) {
    let effectiveWorkspace = workspace;
    if (entry.workspaceRoot !== workspace) {
      if (cwdExplicit) return { ok: false, reason: "workspace-conflict", entry };
      // B1: adopt the source handle's own workspace — it was validated at mint
      // time. H2: but refuse if that worktree no longer exists.
      const res = resolveHandleWorkspace([entry.workspaceRoot], cwdExplicit, workspace);
      if (res.kind === "missing") return { ok: false, reason: "workspace-missing", entry };
      effectiveWorkspace = res.kind === "adopt" ? res.workspace : entry.workspaceRoot;
    }
    if (!entry.path) return { ok: false, reason: "no-source" };
    const content = await readFileSafe(entry.path, effectiveWorkspace);
    if (content === null) return { ok: false, reason: "no-source" };
    const resolved = entry.range ? extractRangeText(content, entry.range) : content;
    if (resolved === null) return { ok: false, reason: "no-source" };
    return { ok: true, content: resolved, workspace: effectiveWorkspace };
  }
  const plain = await readFileSafe(source, workspace);
  if (plain === null) return { ok: false, reason: "no-source" };
  return { ok: true, content: plain, workspace };
}

function parseSmallFileContent(value: unknown): { ok: true; value: SmallFileContentMode | undefined } | { ok: false } {
  if (value === undefined) return { ok: true, value: undefined };
  if (value === "full" || value === "outline" || value === "defer" || value === "auto") {
    return { ok: true, value };
  }
  return { ok: false };
}

/**
 * DESIGN-v0.8 §C3: `comments` escape for read_code full/slice/symbol/auto.
 * Default (undefined or "elide") collapses multi-line doc/comment blocks via
 * elideDocComments; "keep" serves the content unelided. Any other value is
 * rejected (mirrors parseSmallFileContent's strict-enum shape) rather than
 * silently defaulting, so a typo'd value surfaces instead of silently
 * changing behavior.
 */
function parseCommentsMode(value: unknown): { ok: true; keep: boolean } | { ok: false } {
  if (value === undefined || value === "elide") return { ok: true, keep: false };
  if (value === "keep") return { ok: true, keep: true };
  return { ok: false };
}

// ---------------------------------------------------------------------------
// Tool dispatch
// ---------------------------------------------------------------------------

interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

// Hard read caps for body-returning paths (Phase 4).
// 2026-07-16a: raised 12288 -> 81920 so a ~70KB single-class file (live
// bench evidence) serves in ONE mode=full call instead of five 8KB slices — an
// extra API turn costs far more (~$0.03, ~100k cache-read tokens) than
// serving tens of KB more content (well under $0.01) ever does.
// READ_SYMBOL_CAP_BYTES now lives in readCodeModes.ts (imported above) — no
// longer duplicated here.
//
// NOTE: this briefly exceeded READ_FULL_CAP_BYTES_ALLOW_FULL before the same
// wave raised that constant below (see its own comment). Independently, this
// value also makes the C5 auto-allow-under-LARGE_BYTES window further down
// structurally unreachable, since LARGE_BYTES=24576 < 81920 — any file that
// still exceeds the new default cap also exceeds LARGE_BYTES.
const READ_FULL_CAP_BYTES = 81920;
// A6 (reports/bench/2026-07-02a): mode=full allowFull:true previously hit
// READ_FULL_CAP_BYTES before decideFullRead (the only place allowFull is
// honored) ever ran, so allowFull could never help — an agent retrying the
// identical call got an identical refusal. allowFull:true now raises the
// effective byte ceiling to this higher bound; the governor's per-path/
// per-task anti-abuse caps still apply on top of it (allowFull bypasses only
// the per-task cap, per fullGovernor.ts — one full read per unchanged path
// remains enforced). Kept STRICTLY ABOVE READ_FULL_CAP_BYTES so allowFull
// always raises the ceiling — 81920 briefly exceeded the old 65536, which
// inverted the invariant for 64-80KB files (2026-07-16a wave review).
const READ_FULL_CAP_BYTES_ALLOW_FULL = 131072;

// ---------------------------------------------------------------------------
// CSV / TSV artifact response helpers (shared by mode=artifact's csv branch
// and the size-gated auto/skeleton/symbol csv route). Mirrors the xlsx artifact
// response shape (handle + short sha + columns/rows/range/truncated), plus the
// csv-specific total_rows/total_columns/dialect and honest-truncation `note`.
// ---------------------------------------------------------------------------

/** Project a csvTable success into the mode=artifact kind:"csv" wire shape. */
function csvArtifactShape(
  table: CsvTableResult,
  identity: { path: string; handle: string; sha: string },
): Record<string, unknown> {
  return {
    mode: "artifact",
    kind: "csv",
    path: identity.path,
    handle: identity.handle,
    sha: shortSha(identity.sha), // C10.1: short display prefix; handle minted on the FULL sha.
    range: table.range,
    columns: table.columns,
    rows: table.rows,
    truncated: table.truncated,
    total_rows: table.total_rows,
    total_columns: table.total_columns,
    dialect: table.dialect,
    warnings: table.warnings,
    ...(table.note ? { note: table.note } : {}),
  };
}

/**
 * No-selector bounded csv head: serve the full bounded table when it fits the
 * SAME inline budget the xlsx no-`sheet` artifact path uses
 * (mustFetchReadBudget(READ_SYMBOL_CAP_BYTES)); else a head preview (20 rows);
 * else a columns-only head with the honest total_rows + range= note. Returns
 * undefined only if csvTable itself fails (caller decides the fallback).
 */
function serveBoundedCsvArtifact(
  bytes: Uint8Array,
  ext: string,
  identity: { path: string; handle: string; sha: string },
): Record<string, unknown> | undefined {
  const budget = mustFetchReadBudget(READ_SYMBOL_CAP_BYTES);
  const full = csvTable(bytes, { ext });
  if (!full.ok) return undefined;
  const fullOut = csvArtifactShape(full, identity);
  if (Buffer.byteLength(JSON.stringify(fullOut), "utf8") <= budget) return fullOut;
  // Attempt 2: bounded head preview — never loosens the budget check above.
  const head = csvTable(bytes, { ext, maxRows: 20, maxCells: 2000 });
  if (head.ok) {
    const headOut = csvArtifactShape(head, identity);
    if (Buffer.byteLength(JSON.stringify(headOut), "utf8") <= budget) return headOut;
  }
  // Final fallback: columns + totals + honest note, no rows (always small).
  const minimal = csvTable(bytes, { ext, maxRows: 0 });
  return minimal.ok ? csvArtifactShape(minimal, identity) : undefined;
}

/**
 * One-shot edits[] batching hint text (see recordSingleEditCompletion in
 * util/session.ts) — echoes the "Batch independent edits" guardrail bullet in
 * packages/agents-md/templates/AGENTS.md.tmpl so the server-side nudge and
 * the onboarded prompt guidance stay consistent.
 *
 * 2026-07-24 (bench task T09 forensics): the ORIGINAL 4th-call fire point
 * was too late — both observed sessions had already made 5 sequential
 * single-file edit_file calls apiece, ignoring the hint entirely (it landed
 * only after most of the batchable work was already done one-shot). The
 * fire point is now the 2nd single-edit call (BATCH_HINT_THRESHOLD in
 * util/session.ts) and the wording is more actionable: it names the
 * multi-FILE + per-item-precondition shape of edits[] explicitly, not just
 * "batch independent edits".
 */
export const BATCH_HINT_TEXT =
  "2nd single-edit call this session — edits[] batches MULTIPLE FILES in one call, each with its own precondition; batch remaining known edit sites into ONE edits[] call now.";

/**
 * One-shot find-batching hint text (Fix B, 2026-07-12c single-query-find-loop forensics —
 * see recordSingleFindCompletion in util/session.ts) — sibling of
 * BATCH_HINT_TEXT above but for search_files action=find: nudges an agent
 * making repeated single-token find calls toward the queries:[...] OR-batch
 * form. L2 (2026-07-30 T11 forensics): threshold lowered 4 -> 2 (see
 * FIND_HINT_THRESHOLD's doc comment) — text/mechanism otherwise unchanged,
 * still one-shot per session (see findHintFired).
 */
export const FIND_HINT_TEXT =
  "2nd single-token find call this session — batch related tokens into ONE queries:[...] call (<=5, OR-matched)";

/**
 * A1 (2026-08-04 review): collapse body-bearing arguments to the shared
 * prescription placeholders before echoing a caller's own call shape back in a
 * `next_call` template.
 *
 * A template names the SHAPE the caller should re-issue; the caller already
 * holds the payload, so repeating it is pure cost — the convention session.ts
 * states next to those placeholder constants, and which W1's
 * `cwd-required-for-create` refusal was the one violation of. Measured before
 * this: a 24,024-byte create drew a 24,555-byte refusal, then the caller
 * re-sent the same body on the corrective retry, billing it three times for
 * one create. DESIGN-v0.10-write-capability-RFC.md §9 budgets ~320 B.
 *
 * `search` is compacted only when non-empty: `search:""` is the deprecated
 * sink's create SPELLING (shape, not payload) and must survive verbatim, or
 * the prescribed retry would stop being a create.
 */
function compactTemplateArgs(args: Record<string, unknown>): Record<string, unknown> {
  const compacted: Record<string, unknown> = { ...args };
  if (compacted["content"] !== undefined) compacted["content"] = CREATE_BODY_PLACEHOLDER;
  if (compacted["replace"] !== undefined) compacted["replace"] = EDIT_REPLACE_PLACEHOLDER;
  if (typeof compacted["search"] === "string" && compacted["search"].length > 0) {
    compacted["search"] = EDIT_SEARCH_PLACEHOLDER;
  }
  return compacted;
}

/**
 * L1 (2026-08-07): the same evidence shape a task_pack create route already
 * publishes as `create_target.directory_evidence` (readCodeTaskPack.ts's
 * resolveExplicitArtifactCreateTarget) -- up to three files that already live
 * in the created file's own directory, read from the filesystem the write
 * actually landed on. Mirrored onto the self-authorized create so a create
 * admitted by its own workspace pin is as auditable as a pack-grounded one:
 * the response states, in server-observed facts rather than caller text, what
 * the chosen placement sits next to. An empty list is the honest answer for a
 * directory this create itself brought into being, and is reported as such.
 */
function createDirectoryEvidence(workspace: string, relPath: string): string[] {
  const normalized = relPath.split(path.sep).join("/");
  const dir = path.posix.dirname(normalized);
  const base = path.posix.basename(normalized);
  try {
    return readdirSync(path.resolve(workspace, dir === "." ? "" : dir), { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name !== base)
      .map((entry) => (dir === "." ? entry.name : `${dir}/${entry.name}`))
      .sort()
      .slice(0, 3);
  } catch {
    return [];
  }
}

/**
 * B5.1: `resolveWorkspaceRoot` (write/resolveWorkspace.ts) silently falls
 * back to the server's pinned root when `cwd` is invalid/nonexistent — that
 * fallback is intentional and stays in place there (single-root callers that
 * never pass cwd must be unaffected, and it is the right behavior for the
 * PURE resolver function itself; see cwdRouting.spec.ts's direct
 * resolveWorkspaceRoot unit tests, which are unchanged by this). The bug was
 * that dispatch had NO way to tell "cwd was omitted" apart from "cwd was
 * supplied but garbage" — a typo'd cwd (e.g. `.claire`) silently served
 * results from the pinned root, which "worked" only because the pinned root
 * happened to be usable, not because the caller's intended tree was read.
 *
 * This pre-check runs BEFORE resolveWorkspaceRoot in the read_file/edit_file/
 * search_files dispatch: when the caller supplied a non-empty `cwd` that
 * isWorkspaceOverrideAccepted rejects, return a structured refusal instead of
 * silently resolving against the pinned root. `next` carries both the
 * requested path and the root a call OMITTING cwd would resolve to, so the
 * caller can immediately retry correctly either way.
 *
 * Returns null when there is nothing to refuse (cwd omitted, or cwd is
 * present and valid) — the caller proceeds to resolveWorkspaceRoot as today.
 */
function checkCwdOrRefuse(
  rawCwd: unknown,
  fallbackRoot: string,
): { ok: false; reason: "invalid-cwd"; requested: string; resolved: string; next: string; nearest_existing?: string } | null {
  if (rawCwd === undefined) return null; // cwd omitted — nothing to validate.
  const requested = String(rawCwd);
  if (requested.trim() === "") return null; // treat empty string like omitted.
  // H3: accept a cwd that resolves to the pinned fallback root itself, even
  // when that root lives OUTSIDE $HOME (CI/tmp deployments where the checkout
  // is not under the user's home dir). Without an explicit allowed parent,
  // isWorkspaceOverrideAccepted rejects such a path, so a cwd-echoing call
  // that simply repeats the pinned root — legitimate, and exactly what the
  // adoption sites treat as "no override" — used to draw an invalid-cwd refusal
  // on every call. Compare via realpath (resolveReal tolerates a missing path
  // by falling back to path.resolve, so a nonexistent requested cwd simply
  // won't match — it falls through to the refusal below). PI-07 (2026-08-20):
  // this accept check now lives in workspace/candidates.ts's
  // isWorkspaceCandidateAccepted, which the new candidate/did_you_mean
  // validators reuse verbatim rather than re-deriving the policy — this call
  // site is unchanged in effect, only in where the two lines live.
  const allowedParents = configuredAllowedParents(fallbackRoot);
  if (isWorkspaceCandidateAccepted(requested, fallbackRoot, allowedParents)) {
    return null; // valid — proceed normally.
  }
  // "resolved": what a call OMITTING cwd resolves to today (the pinned
  // root) — reuses resolveWorkspaceRoot itself rather than re-deriving the
  // fallback path, so this never drifts from the real fallback behavior.
  const resolved = resolveWorkspaceRoot(undefined, fallbackRoot);
  // "nearest_existing": cheap, best-effort ancestor walk-up — cheap because a
  // typo'd cwd (e.g. ".claire/..." instead of ".claude/...") is USUALLY only
  // one or two segments removed from a real directory, so an agent that reads
  // this can often just fix the last segment and retry rather than guessing
  // blind. Omitted (not present) when nothing existed along the chain.
  // PI-07 / F-A1-5 fix: nearestValidWorkspaceAncestor (workspace/candidates.ts)
  // validates every candidate ancestor through the SAME check above before
  // returning it, so this value is always safe to surface as `did_you_mean`
  // on ANY tool's refusal (protocol/refusal.ts's mapping) — not just the
  // read-path tools that re-validate again before silently adopting it
  // (checkCwdWithCorrection below).
  const nearestExisting = nearestValidWorkspaceAncestor(requested, fallbackRoot, allowedParents);
  return {
    ok: false,
    reason: "invalid-cwd",
    requested,
    resolved,
    next: `cwd must be the pinned workspace, a worktree registered by the pinned repository, or one direct-child worktree under a configured --allowed-parent; retry with a valid cwd, or omit cwd to use ${resolved}`,
    ...(nearestExisting !== undefined ? { nearest_existing: nearestExisting } : {}),
  };
}

/**
 * Fix 3 (2026-07 follow-up): `.claire` is a recurring model typo for
 * `.claude` — every invalid-cwd refusal it drew cost a full agent turn, even
 * in transcripts that otherwise won the bench cell. Substitutes ONLY an
 * exact `.claire` PATH SEGMENT (never a prefix match like `.clairevoyant`),
 * segment-by-segment, so a `.claire` anywhere in the path — not just a
 * trailing one — is corrected. Returns null when no `.claire` segment is
 * present; the caller must not treat null as "already valid", only as "no
 * candidate from this rule".
 */
function correctClaireSegment(requestedPath: string): string | null {
  if (!requestedPath.includes(".claire")) return null;
  let changed = false;
  const corrected = requestedPath.split(path.sep).map((segment) => {
    if (segment === ".claire") {
      changed = true;
      return ".claude";
    }
    return segment;
  });
  return changed ? corrected.join(path.sep) : null;
}

/** A cwd correction silently adopted in place of a hallucinated one — see checkCwdWithCorrection. */
interface CwdCorrection {
  from: string;
  to: string;
}

/**
 * True when `p` resolves to the user's home directory ITSELF, not merely
 * somewhere inside it. Guards the nearest_existing branch of
 * checkCwdWithCorrection below: the ancestor walk (now
 * workspace/candidates.ts's nearestValidWorkspaceAncestor) can, from a
 * bogus/sibling cwd (e.g. `<pinnedRoot>/../typo'd-name`, a real fixture
 * shape — pinnedRoot's own parent is $HOME), legitimately reach $HOME
 * itself, which PASSES isWorkspaceOverrideAccepted's containment check
 * ($HOME is "within" itself) — but silently adopting the caller's ENTIRE
 * home directory as a read/search workspace is not what "one unambiguous
 * root suggestion" is meant to license: confirmed live, search_files
 * action=find over a real $HOME can scan gigabytes and hang the call. A
 * `.claire`->`.claude` correction never hits this (it substitutes one
 * segment; it never walks upward), so only the nearest_existing fallback
 * needs this check. PI-07 (2026-08-20): nearestValidWorkspaceAncestor now
 * carries its OWN copy of this exact guard too (so the write path, which
 * never runs checkCwdWithCorrection, inherits the same protection on
 * `did_you_mean`); this copy stays here unchanged for the read-path
 * re-validation below.
 */
function isHomeDirItself(p: string): boolean {
  const home = process.env["HOME"] ?? process.env["USERPROFILE"] ?? "";
  if (!home) return false;
  return resolveReal(p) === resolveReal(home);
}

/**
 * read_file/search_files-ONLY wrapper around checkCwdOrRefuse. A cwd that
 * fails validation gets up to two cheap, bounded correction attempts before
 * this actually refuses — each candidate is re-validated through
 * checkCwdOrRefuse ITSELF (the exact same realpath/$HOME-containment checks
 * a user-supplied cwd faces), so this only widens which STRING reaches that
 * boundary, never what the boundary accepts:
 *   1. an exact `.claire` path segment substituted for `.claude`
 *      (correctClaireSegment above).
 *   2. checkCwdOrRefuse's own `nearest_existing` ancestor suggestion, when
 *      present and not just $HOME itself (isHomeDirItself) — by
 *      construction there is at most one, so "adopt it" is never a guess
 *      among several candidates.
 * Order matters: `.claire` is tried first, since it is the specific, common
 * mistake this fix targets; `nearest_existing` is the generic fallback.
 *
 * edit_file and every write path must keep calling checkCwdOrRefuse
 * directly instead of this — see that call site's B5.1 comment and the
 * DESIGN-v0.8 B1 mis-target hazard on the create branch. A wrong READ/SEARCH
 * target costs a turn; a wrong WRITE target is not something a silent
 * correction should ever risk.
 */
function checkCwdWithCorrection(
  rawCwd: unknown,
  fallbackRoot: string,
): { refusal: ReturnType<typeof checkCwdOrRefuse>; correction?: CwdCorrection } {
  const refusal = checkCwdOrRefuse(rawCwd, fallbackRoot);
  if (refusal === null) return { refusal: null };

  const requested = refusal.requested;

  const claireCandidate = correctClaireSegment(requested);
  if (claireCandidate !== null && checkCwdOrRefuse(claireCandidate, fallbackRoot) === null) {
    return { refusal: null, correction: { from: requested, to: claireCandidate } };
  }

  // nearest_existing only ever makes sense as a correction for an otherwise
  // well-formed but not-quite-real ABSOLUTE path. nearestValidWorkspaceAncestor
  // (workspace/candidates.ts) resolves a RELATIVE requested string against
  // path.resolve (i.e. this SERVER PROCESS's own launch cwd, not anything
  // reflecting caller intent) before walking up — for ANY nonexistent
  // relative path that walk always eventually reaches the server's own cwd,
  // which routinely exists and (when the server was launched from its own
  // pinned root, the common case) routinely passes validation, so without
  // this gate a merely-relative cwd (a real caller mistake `checkCwdOrRefuse`
  // is right to reject) would silently "correct" to a directory that has
  // nothing to do with the call.
  if (
    path.isAbsolute(requested) &&
    refusal.nearest_existing !== undefined &&
    !isHomeDirItself(refusal.nearest_existing) &&
    checkCwdOrRefuse(refusal.nearest_existing, fallbackRoot) === null
  ) {
    return { refusal: null, correction: { from: requested, to: refusal.nearest_existing } };
  }

  return { refusal };
}

/**
 * H3: `cwd` is "explicit" only when it is a present, non-blank string.
 * checkCwdOrRefuse already treats `cwd:""` (and whitespace-only) as OMITTED,
 * but the adoption sites used `args["cwd"] !== undefined` — so an empty-string
 * cwd was "explicit" there and drew a handle-workspace-mismatch REFUSAL where
 * an omitted cwd would have ADOPTED the handle's own root. Unify on this
 * predicate everywhere so `cwd:""`/`"   "` behaves identically to an omitted
 * cwd on both paths.
 */
function isCwdExplicit(rawCwd: unknown): boolean {
  return typeof rawCwd === "string" && rawCwd.trim() !== "";
}

/**
 * H2: a handle records the absolute workspaceRoot it was minted in. When cwd
 * is omitted, the dispatch ADOPTS that root (the handle IS the workspace pin).
 * But nothing verified the adopted root still EXISTS — a handle minted in a
 * git worktree that was since removed would adopt a now-deleted directory and
 * then fail obscurely deep in file I/O. This shared helper is the single
 * adopt-or-refuse decision used by every adoption site (single-handle read,
 * handles[] batch, single edit, edits[] batch, directoryHandle,
 * resolveCreateSourceContent); each site formats its own response shape from
 * the discriminated result (read batches soft-omit an item; edits hard-refuse
 * the call), but the missing-root and mismatch checks live here, once.
 *
 * `candidateRoots` is the DISTINCT set of workspaceRoots of the caller's
 * handle(s) (unknown handles are excluded by the caller — they surface as
 * handle-unknown separately). Returns:
 *   - {kind:"keep"}     — cwd explicit, OR no candidate roots: leave the
 *                         caller's already-resolved pinned workspace; per-item
 *                         mismatch checks (if any) run at the call site.
 *   - {kind:"adopt", workspace} — exactly one candidate root, cwd omitted, and
 *                         the root exists as a directory → adopt it.
 *   - {kind:"missing", handleWorkspace} — the single root to adopt no longer
 *                         exists / is not a directory → caller refuses with
 *                         reason:"handle-workspace-missing".
 *   - {kind:"multi", roots} — the batch spans >1 root → caller refuses with its
 *                         own handle-workspace-mismatch shape.
 */
type HandleWorkspaceResolution =
  | { kind: "keep" }
  | { kind: "adopt"; workspace: string }
  | { kind: "missing"; handleWorkspace: string }
  | { kind: "multi"; roots: string[] };

function resolveHandleWorkspace(
  candidateRoots: string[],
  cwdExplicit: boolean,
  pinnedWorkspace: string,
): HandleWorkspaceResolution {
  if (cwdExplicit) return { kind: "keep" };
  const distinct = [...new Set(candidateRoots)];
  if (distinct.length === 0) return { kind: "keep" };
  if (distinct.length > 1) return { kind: "multi", roots: distinct.sort() };
  const root = distinct[0]!;
  // Already the pinned root — nothing to adopt, and no need to stat (the pinned
  // root's validity is the server's own startup concern, not a handle's).
  if (root === pinnedWorkspace) return { kind: "adopt", workspace: root };
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    return { kind: "missing", handleWorkspace: root };
  }
  return { kind: "adopt", workspace: root };
}

// ---------------------------------------------------------------------------
// Root-mismatch guard (2026-08-09 incident)
//
// checkCwdOrRefuse + resolveHandleWorkspace form a DIFFERENTIAL check: they
// compare what this call declared against what a handle captured. Forensics
// proved the check is exactly as strong as its premise — when NO call in a
// chain ever declares a cwd (a cwd-less mint silently captures the pinned
// launch root, a cwd-less edit adopts it straight back), there is nothing to
// disagree with and a four-file write landed in the shared checkout with
// `ok:true` and no root named anywhere in the response.
//
// Two additions close it, both gated on one physical fact — the effective
// workspace CONTAINS another live workspace (`workspaceIsAmbiguous`):
//   F1  a write whose workspace nobody ever declared is refused progressively
//       (`cwd-required-for-edit`, the sibling of `cwd-required-for-create`).
//   F3  a write whose target lands inside a nested worktree that is not the
//       effective workspace is refused (`workspace-boundary`) — the hazard a
//       purely lexical containment check cannot see, and the one a correctly
//       declared cwd does not protect against.
// Outside that fact both are inert, so a single-root deployment (and every
// bench cell) keeps a byte-identical response profile.
// ---------------------------------------------------------------------------

/** Every handle id a call carries, in a stable order, deduplicated. */
function involvedHandleIds(args: Record<string, unknown>): string[] {
  const ids: string[] = [];
  const push = (value: unknown): void => {
    if (typeof value === "string" && value !== "" && !ids.includes(value)) ids.push(value);
  };
  push(args["handle"]);
  push(args["directoryHandle"]);
  // `from` is overloaded on the create branch: a handle id when the table
  // knows it, otherwise a source PATH (handled by writeTargetPaths).
  if (typeof args["from"] === "string" && handleTable.get(args["from"]) !== undefined) {
    push(args["from"]);
  }
  const handles = args["handles"];
  if (Array.isArray(handles)) for (const id of handles) push(id);
  const edits = args["edits"];
  if (Array.isArray(edits)) {
    for (const edit of edits) {
      if (edit && typeof edit === "object") push((edit as Record<string, unknown>)["handle"]);
    }
  }
  return ids;
}

/** The live entries behind involvedHandleIds; unknown ids simply drop out. */
function involvedHandleEntries(args: Record<string, unknown>): HandleEntry[] {
  return involvedHandleIds(args).flatMap((id) => {
    const entry = handleTable.get(id);
    return entry ? [entry] : [];
  });
}

/**
 * The workspace this call actually resolves against, adoption included.
 * Mirrors the dispatch's own order (explicit cwd wins; otherwise a single
 * agreed handle root is adopted; otherwise the pinned root), so the guard and
 * the write it guards can never disagree about which tree is in play.
 */
function effectiveCallWorkspace(args: Record<string, unknown>): string {
  const pinned = resolveWorkspaceRoot(args["cwd"] as string | undefined, activeRoot);
  if (isCwdExplicit(args["cwd"])) return pinned;
  const roots = [...new Set(involvedHandleEntries(args).map((entry) => entry.workspaceRoot))];
  return roots.length === 1 ? roots[0]! : pinned;
}

/**
 * The root THIS call declares, for the handle table's declaration scope: an
 * explicit cwd, or — when the call rides handles the caller already declared —
 * the single root it adopts from them. That second clause is what makes the
 * declaration transitive, so `cwd` on the mint keeps a whole multi-hop chain
 * (slice → edit → post-edit handle → edit) working cwd-lessly.
 */
function declaredWorkspaceForCall(args: Record<string, unknown>): string | undefined {
  if (isCwdExplicit(args["cwd"])) return resolveWorkspaceRoot(args["cwd"] as string, activeRoot);
  const roots = [...new Set(
    involvedHandleEntries(args)
      .filter((entry) => entry.workspaceDeclared === true)
      .map((entry) => entry.workspaceRoot),
  )];
  return roots.length === 1 ? roots[0]! : undefined;
}

/** Workspace-relative (or absolute) paths a write call can land bytes on. */
function writeTargetPaths(args: Record<string, unknown>): string[] {
  const paths: string[] = [];
  const push = (value: unknown): void => {
    if (typeof value === "string" && value !== "" && !paths.includes(value)) paths.push(value);
  };
  push(args["path"]);
  // `from` names a source file only when it is not a known handle id.
  if (typeof args["from"] === "string" && handleTable.get(args["from"]) === undefined) {
    push(args["from"]);
  }
  const edits = args["edits"];
  if (Array.isArray(edits)) {
    for (const edit of edits) {
      if (edit && typeof edit === "object") push((edit as Record<string, unknown>)["path"]);
    }
  }
  for (const entry of involvedHandleEntries(args)) push(entry.path);
  return paths;
}

/** Paths a READ call names, including `paths[]`'s string and object forms. */
function readTargetPaths(args: Record<string, unknown>): string[] {
  const paths: string[] = [];
  const push = (value: unknown): void => {
    if (typeof value === "string" && value !== "" && !paths.includes(value)) paths.push(value);
  };
  push(args["path"]);
  const list = args["paths"];
  if (Array.isArray(list)) {
    for (const item of list) {
      if (typeof item === "string") push(item);
      else if (item && typeof item === "object") push((item as Record<string, unknown>)["path"]);
    }
  }
  for (const entry of involvedHandleEntries(args)) push(entry.path);
  return paths;
}

/**
 * Server root + live nested workspaces + other active roots, deduplicated,
 * validated, and capped. PI-07 / F-A1-5 unification: every entry here is
 * ALREADY a known, already-registered root (not a similarity guess), so
 * validation is normally a no-op — but routing it through the same
 * `isWorkspaceCandidateAccepted` check every other producer uses means a
 * stale/deleted root can never survive into a wire refusal just because it
 * was still present in an in-memory registry.
 */
function workspaceCandidates(
  workspace: string,
  nested: readonly string[],
): Array<{ cwd: string; source: string }> {
  const allowedParents = configuredAllowedParents(workspace);
  return [
    { cwd: workspace, source: "server-default" },
    ...nested.map((cwd) => ({ cwd, source: "nested-worktree" })),
    ...otherActiveRoots(workspace).map((cwd) => ({ cwd, source: "active-session" })),
  ]
    .filter((candidate, index, all) =>
      all.findIndex((other) => other.cwd === candidate.cwd) === index)
    .filter((candidate) => isWorkspaceCandidateAccepted(candidate.cwd, workspace, allowedParents))
    .slice(0, WORKSPACE_CANDIDATE_LIMIT);
}

/**
 * F1 + F3, in that order: a workspace nobody declared cannot be reasoned about
 * at all, so "name your tree" precedes "that target is in someone else's
 * tree". Returns null — with at most one cached stat — for every unambiguous
 * workspace, which is what keeps this off the hot path.
 */
function workspaceRoutingRefusal(
  toolName: string,
  args: Record<string, unknown>,
): Record<string, unknown> | null {
  const workspace = effectiveCallWorkspace(args);
  const nested = nestedWorkspaceRoots(workspace);
  if (nested.length === 0) return null;

  const cwdExplicit = isCwdExplicit(args["cwd"]);
  if (
    !cwdExplicit
    && !involvedHandleEntries(args).some((entry) => entry.workspaceDeclared === true)
  ) {
    return {
      ok: false,
      reason: "cwd-required-for-edit",
      code: "cwd-required-for-edit",
      applied: false,
      terminal: false,
      detail: `${path.basename(workspace)} contains ${nested.length} other live workspace(s), so a write that names no cwd cannot be routed: neither this call nor the handles it carries ever declared which tree to edit`,
      workspace,
      cwd_candidates: workspaceCandidates(workspace, nested),
      next_call_is_template: true,
      next_call: {
        tool: toolName,
        arguments: { ...compactTemplateArgs(args), cwd: "<absolute intended workspace cwd>" },
      },
    };
  }

  const crossings = writeTargetPaths(args)
    .map((target) => ({ path: target, workspace: nestedWorkspaceCrossing(target, workspace) }))
    .filter((item): item is { path: string; workspace: string } => item.workspace !== undefined);
  if (crossings.length === 0) return null;

  const foreign = crossings[0]!.workspace;
  const single = crossings.length === 1
    && typeof args["path"] === "string"
    && args["path"] === crossings[0]!.path
    && involvedHandleIds(args).length === 0
    && !Array.isArray(args["edits"]);
  return {
    ok: false,
    reason: "workspace-boundary",
    code: "workspace-boundary",
    applied: false,
    terminal: false,
    workspace,
    nested_workspace: foreign,
    paths: crossings.slice(0, 3).map((item) => item.path),
    detail: `the target lives in ${path.basename(foreign)}, a linked worktree nested inside ${path.basename(workspace)} — a different workspace on its own branch, not a subdirectory of this one`,
    next: `re-issue with cwd=${foreign} and a path relative to it`,
    ...(single
      ? {
          next_call: {
            tool: toolName,
            arguments: {
              ...compactTemplateArgs(args),
              cwd: foreign,
              path: path.relative(foreign, path.resolve(workspace, crossings[0]!.path)),
            },
          },
        }
      : {}),
  };
}

/**
 * The process's single guard stack, handed to write/guardedWorkspace.ts once,
 * here, at module init (function declarations are hoisted, so this runs after
 * nothing that matters and before any dispatch). From this point on the ONLY
 * way a dispatch case can obtain a `GuardedWorkspaceRoot` — and therefore the
 * only way it can reach `createFile`/`applyEditsMulti`/`searchReplaceEdit`/
 * `readAndEdit`/`renameSymbol`/`editArtifact`/the pathless edits/`applyIntent`
 * — is by running these two guards in order. A second install throws, so a
 * future case cannot quietly substitute permissive guards of its own.
 *
 * The lambdas are pass-throughs on purpose: no adapter logic means nothing
 * that can drift from what dispatch used to call directly. `writesEnabled` is
 * a thunk so it reads ALLOW_WRITE at call time, matching the `if (ALLOW_WRITE)`
 * gate the write cases used to spell out themselves.
 */
installWorkspaceGuardStack({
  checkCwd: (rawCwd, fallbackRoot) => checkCwdOrRefuse(rawCwd, fallbackRoot),
  routing: (toolName, args) => workspaceRoutingRefusal(toolName, args),
  resolve: (cwd, fallbackRoot) => resolveWorkspaceRoot(cwd, fallbackRoot),
  writesEnabled: () => ALLOW_WRITE,
});

/**
 * turn-economy wave 2 (W1): the file head a GOVERNED full downgrade serves.
 * Returns the leading logical lines of `content` whose cumulative UTF-8 size
 * fits `budgetBytes`, plus the file's total logical line count (countLines
 * semantics). When the whole file fits, `head === content` and
 * `servedLines === totalLines` — the caller serves it untruncated with no
 * remainder `next`.
 *
 * Line boundaries are EXACT against the original file (no elision, no
 * whitespace collapse) so the remainder range `(servedLines+1)-totalLines` a
 * truncated serve returns as `next` always lines up with what a subsequent
 * mode=slice returns. Degenerate single-long-line case (the first logical line
 * alone exceeds the budget): a byte-bounded, code-point-aligned prefix of that
 * line is served with servedLines:0, so the remainder `next` re-fetches from
 * line 1 (mode=slice clamps and continues) rather than dropping its tail.
 */
export function serveGovernedFullHead(
  content: string,
  budgetBytes: number,
): { head: string; servedLines: number; totalLines: number } {
  const totalLines = countLines(content);
  if (totalLines === 0) return { head: content, servedLines: 0, totalLines: 0 };
  if (Buffer.byteLength(content, "utf8") <= budgetBytes) {
    return { head: content, servedLines: totalLines, totalLines };
  }
  const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const body = normalized.endsWith("\n") ? normalized.slice(0, -1) : normalized;
  const lines = body.split("\n"); // exactly totalLines elements (countLines semantics)
  let acc = "";
  let served = 0;
  for (let i = 0; i < lines.length; i++) {
    const candidate = i === 0 ? lines[0]! : `${acc}\n${lines[i]!}`;
    if (Buffer.byteLength(candidate, "utf8") > budgetBytes) break;
    acc = candidate;
    served = i + 1;
  }
  if (served === 0) {
    // First logical line alone overflows the budget: serve a code-point-aligned
    // prefix (never split a multi-byte char), servedLines:0 → remainder starts
    // at line 1.
    let prefix = "";
    let usedBytes = 0;
    for (const ch of lines[0]!) {
      const chBytes = Buffer.byteLength(ch, "utf8");
      if (usedBytes + chBytes > budgetBytes) break;
      prefix += ch;
      usedBytes += chBytes;
    }
    return { head: prefix, servedLines: 0, totalLines };
  }
  return { head: acc, servedLines: served, totalLines };
}


/**
 * The escape hatch, stated on the receipt itself. A caller whose context was
 * compacted away no longer HAS the bytes the ledger says it was served, so the
 * force-serve path must be first-class and self-documenting — never something
 * the caller has to already know.
 */
export const SERVED_CONTENT_RECEIPT_NOTE =
  'served earlier this session and unchanged; pass content:"full" (or allowFull:true) to force the bytes';

/**
 * Compact receipt for a read whose payload the SAME session already served for
 * the SAME file sha (state/session.ts's servedRangeReceipt decides that;
 * qualification is deliberately conservative — exact re-serves and fully
 * subsumed ranges only). Content-EQUIVALENT to a re-serve, in the same sense
 * as task_pack's `pack_unchanged` and a surface's `code_unchanged`: the caller
 * already holds these bytes, so charging for them again buys nothing.
 *
 * `summary` carries the receipt's actual payload — precisely WHICH line ranges
 * of the file the caller holds and whether any remain unserved (same `summary`
 * convention mode=closure uses for "what this session already did"). Without
 * it the response would be a bare pointer, which is exactly the zero-content
 * shape the turn-economy work exists to eliminate.
 */
function servedContentReceipt(args: {
  mode: string;
  path: string;
  handle: string;
  sha: string;
  range?: string;
  symbol?: string;
  ledger: ServedRangeLedgerReceipt;
  /**
   * F3 (2026-08-02 serve-honesty) override for the one caller whose `ledger`
   * is a RECORD result rather than a probe (mode=slice decides by
   * added_lines===0), so it has to carry the provenance it probed separately.
   */
  servedBy?: string;
  extra?: Record<string, unknown>;
  /** V10-02: the workspace this receipt is for, so this one function can
   *  trace repeated_range for every mode that funnels through it. Optional
   *  and additive — omitted callers simply do not emit the event. */
  workspace?: string;
}): Record<string, unknown> {
  const { mode, path: filePath, handle, sha, range, symbol, ledger, extra } = args;
  // F3: a receipt that cannot be checked is indistinguishable from a false
  // one — name the call that put these bytes on the wire (~30 B).
  const servedBy = args.servedBy ?? ledger.served_by;
  // V10-02: repeated_range — a served-range ledger hit answered as a
  // receipt/prior instead of fresh bytes. This function IS the shared
  // receipt builder every servedContentReceipt call site already funnels
  // through, so one trace() call here covers all of them.
  if (args.workspace !== undefined) {
    trace("repeated_range", {
      mode,
      path: filePath,
      ...(range !== undefined ? { range } : {}),
      ...(symbol !== undefined ? { symbol } : {}),
      complete: ledger.complete,
      clusters: ledger.clusters,
    }, args.workspace);
  }
  return {
    mode,
    path: filePath,
    handle,
    ...(range !== undefined ? { range } : {}),
    ...(symbol !== undefined ? { symbol } : {}),
    sha,
    // A.4 (C2-3): the `receipt` TAG is the discriminator; `code_unchanged`
    // survives as the in-process signal several read guards still read, and
    // `protocol/readFamily.ts` deletes it from the wire.
    receipt: "code-unchanged",
    code_unchanged: true,
    ...(servedBy !== undefined ? { served_by: servedBy } : {}),
    summary: {
      served: ledger.served,
      ...(ledger.unserved.length > 0 ? { unserved: ledger.unserved } : {}),
      complete: ledger.complete,
    },
    note: SERVED_CONTENT_RECEIPT_NOTE,
    // A partial ledger receipt must point straight at the exact windows it did
    // not establish. This is a fresh slice, not a task re-pack or a replay of
    // the already-served range above.
    // FX-1 (v0.13 wave-3 review fix): canonical `targets=[...]` prose, not the
    // legacy `mode=slice handle=… ranges=…` dialect — `canonicalizeEmittedToolCalls`
    // (protocol/envelope.ts) only rewrites OBJECT-shaped embedded tool calls, so a
    // raw STRING `next` here was a blind spot that reached the wire unconverted.
    ...(ledger.unserved.length > 0
      ? { next: `read_file targets=${JSON.stringify([{ handle, ranges: ledger.unserved }])}` }
      : {}),
    ...(extra ?? {}),
  };
}

/**
 * §3.3 addressing, applied to the fence's served receipts (C2-3).
 *
 * `state/session.ts`'s `heldSelfMaterialReceipt` proves residency of N windows
 * of ONE file, and it has no handle to name them by — the session layer holds a
 * `resolveHandlePath` callback, never the handle table. Under A.2.7 every
 * `Evidence` entry is addressed by a handle, so a receipt with only a path
 * cannot be projected without inventing one.
 *
 * The dispatcher is the layer that CAN name it, so it does: one upsert on the
 * path the receipt is already about, which mints nothing new when the file was
 * served before (that is what `upsert` means). This adds addressing to a claim
 * that was already being made; it does not widen the claim.
 */
function addressServedReceipt(
  receipt: Record<string, unknown>,
  workspace: string,
): Record<string, unknown> {
  if (typeof receipt["handle"] === "string" && receipt["handle"] !== "") return receipt;
  const path = receipt["path"];
  if (typeof path !== "string" || path === "") return receipt;
  return {
    ...receipt,
    handle: handleTable.upsert({ kind: "file", path, workspaceRoot: workspace }).id,
  };
}

/**
 * A6 (reports/bench/2026-07-02a §3.4): every mode=full refusal — whether the
 * byte cap (even the raised allowFull ceiling) or the governor's per-path/
 * per-task cap — used to return a bare {ok:false,error} with no content. That
 * turned every refusal into a pure-loss turn (live: identical retry, then 11
 * native reads). A-2/C10.4 then made it a SUCCESS-shaped mode=skeleton payload
 * (skeleton signatures + symbol ranges + handle + a slice `next`).
 *
 * turn-economy wave 2 (W1, 2026-07-24): even that skeleton payload was the
 * WRONG mechanism. Live forensics (run 2026-07-24-semantic-signal5-2): after
 * the first ~6 non-tiny fulls, EVERY subsequent mode=full of an ordinary
 * source file was downgraded to a mode:"skeleton" response with ZERO content
 * bytes and a `next:"read_file mode=slice …"` — and the model dutifully spent
 * a manufactured second API turn (~$0.03–0.05, ~100–170K cache-read context)
 * to fetch content the caller was always going to fetch anyway, ~17 times in
 * one task. An extra turn is always worse than serving a few extra KB (<$0.01).
 *
 * So a governed downgrade now SERVES the file head up to GOVERNED_FULL_SERVE_BYTES
 * with `truncated` + handle + (only if genuinely partial) a remainder `next` —
 * the caps bound bytes-per-response, they never force a second call. The one
 * exception is content-EQUIVALENT, not a breadcrumb: a governed REPEAT read of
 * the SAME path whose sha is unchanged since the earlier FULL serve returns a
 * compact `{code_unchanged:true, handle, sha}` — the caller already holds those
 * exact bytes (see session.wasFullyServed). No skeleton, no zero-content
 * pointer, ever, on this path.
 */
async function buildFullDowngradePayload(args: {
  workspace: string;
  filePath: string;
  content: string;
  handleId: string;
  sha: string;
  bytes: number;
  maxBytes: number;
  /**
   * A-2: the PRECISE cause, carried through verbatim so bench can attribute
   * the downgrade. Governor reasons ("per-path-cap-reached" etc.) are passed
   * straight through instead of being collapsed to "full-downgraded"; the byte
   * cap keeps "cap-exceeded" and a governor deny keeps "full-denied".
   */
  reason:
    | "cap-exceeded"
    | "full-denied"
    | "per-path-cap-reached"
    | "per-task-cap-reached"
    | "tiny-task-cap-reached"
    | "tiny-skeleton-cap-reached"
    | "allowfull-task-cap-reached"
    | "candidate-pack-full-repeat"
    | "full-downgraded";
  allowFullWouldHelp: boolean;
  /**
   * W1: retained on the signature so the three existing call sites still
   * compile unchanged, but no longer rendered — a content-bearing serve is not
   * a refusal, so it needs neither an `alternatives` menu nor a prose `hint`.
   */
  alternatives?: unknown[];
  hint?: string;
  /** Internal W5 selector; keeps the existing skeleton wire shape. */
  skeletonOnly?: boolean;
}): Promise<Record<string, unknown>> {
  const { workspace, filePath, content, handleId, sha, bytes, reason, allowFullWouldHelp } = args;

  // W1 exception (content-EQUIVALENT, not a breadcrumb): a governed REPEAT read
  // of the SAME path whose sha is unchanged since the earlier FULL serve. A
  // governor downgrade never records an expansion (only an "allow" does), so
  // wasFullyServed is true only for a genuine prior full serve of this exact
  // sha — the caller already holds these bytes. Return a compact pointer, not a
  // re-serve of what it has, and never a zero-content skeleton.
  if (wasFullyServed(workspace, filePath, sha)) {
    recordReadPath(workspace, filePath);
    // V10-02: repeated_range — a wasFullyServed ledger hit answered as a
    // code-unchanged receipt instead of a re-serve. This function is the
    // single builder all three governed-downgrade call sites already share.
    trace("repeated_range", { mode: "full", path: filePath, reason, complete: true }, workspace);
    const totalLines = countLines(content);
    const coverage = servedRangeCoverage(workspace, filePath, sha, totalLines);
    const servedBy = coverage?.served[0] === undefined
      ? undefined
      : servedRangeReceipt(
          workspace,
          filePath,
          sha,
          coverage.served[0][0],
          coverage.served[0][1],
          totalLines,
        )?.served_by;
    return {
      mode: "full",
      downgraded_from: "full",
      reason,
      path: filePath,
      handle: handleId,
      sha: shortSha(sha), // C10.1: short display sha; handleId was minted on the full sha.
      bytes,
      // A.4 (C2-3): the `receipt` tag discriminates this repeat-read pointer as
      // a `code-unchanged` receipt. Harmless inside a `mode=full` BATCH item —
      // `readFamily.ts`'s `file-downgraded` arm does not carry it — and it is
      // the discriminator when this payload IS the whole response.
      receipt: "code-unchanged",
      code_unchanged: true,
      // W1: state WHAT the caller already holds and how to force the bytes
      // back — the same receipt payload the served-range receipts carry, so no
      // read path answers with a bare pointer.
      //
      // F1 wave 2 (2026-08-02 serve-honesty): this used to hardcode
      // `served:[1-N], complete:true` because wasFullyServed proves a COMPLETE
      // prior serve. That conflated two different ledgers. wasFullyServed
      // answers "did a whole-file serve happen for this (path,sha)?" — still
      // true, still the right gate for THIS receipt (a repeat mode=full would
      // return the identical elided body the caller already has). But a
      // whole-file serve does not put a file's elided comment blocks on the
      // wire, so the COVERAGE summary must come from the range ledger, which
      // now books only what shipped. Fall back to the old shape only when the
      // range ledger has nothing for this sha (e.g. TL_SERVED_RANGE_LEDGER=0).
      ...(servedBy !== undefined ? { served_by: servedBy } : {}),
      summary: coverage === undefined
        ? { served: [`1-${totalLines}`], complete: true }
        : {
            served: coverage.served.map(([start, end]) => `${start}-${end}`),
            ...(coverage.unserved.length > 0 ? { unserved: coverage.unserved } : {}),
            complete: coverage.complete,
          },
      note: SERVED_CONTENT_RECEIPT_NOTE,
      // FX-1: canonical `targets=[...]` prose (see the sibling receipt above).
      ...(coverage !== undefined && coverage.unserved.length > 0
        ? { next: `read_file targets=${JSON.stringify([{ handle: handleId, ranges: coverage.unserved }])}` }
        : {}),
      ...(allowFullWouldHelp ? { allow_full_would_help: true } : {}),
    };
  }

  // B2c (2026-08-01 serving-completeness): the PER-TASK cap converts, the other
  // governor reasons do not.
  //
  // Live evidence (2026-07-31-semantic-signal5-2, T13): the per-task cap fired
  // at full-read #8/#10 and the W1 head-serve above answered every one of them.
  // Serving 12KB of head bytes read as ACCEPTANCE — the solver kept issuing
  // mode=full and never once zoomed, so the cap bounded bytes-per-response
  // while doing nothing at all about the read shape it exists to correct.
  // A per-task cap means "this task has already spent its whole-file budget on
  // OTHER files"; the honest answer is the file's structure plus the exact
  // slice call that gets the part actually wanted, not another head.
  //
  // Non-tiny candidate-pack repeats deliberately keep the W1 content path:
  // T05c recovery depended on that path still serving content. Tiny files are
  // the exception because their governed head would resend the whole body.
  const tinyShapeDowngrade = bytes <= TINY_BYTES && countLines(content) <= TINY_LINES;
  if (args.skeletonOnly === true || reason === "per-task-cap-reached" || reason === "tiny-skeleton-cap-reached" || tinyShapeDowngrade) {
    const totalLines = countLines(content);
    // F1 wave 2 note: with honest recording, `unserved` can now include a gap
    // that is purely an elided comment block. Naming it is not wrong — those
    // lines genuinely never shipped, and comments:"keep" is the way to get
    // them — but a zoom target picked here may point at documentation rather
    // than code. Left as-is deliberately: filtering would need comment
    // awareness that does not belong in the downgrade payload, and this branch
    // is only reachable when the file was NOT fully served.
    const coverage = servedRangeCoverage(workspace, filePath, sha, totalLines);
    const remainingRanges = coverage !== undefined && coverage.unserved.length > 0
      ? coverage.unserved
      : coverage !== undefined && coverage.complete
        ? []
        : [`1-${totalLines}`];
    const widthOf = (range: string): number => {
      const parsed = range.match(/^(\d+)-(\d+)$/);
      if (parsed === null) return 0;
      return parseInt(parsed[2]!, 10) - parseInt(parsed[1]!, 10) + 1;
    };
    const largestUnserved = [...remainingRanges].sort((a, b) => widthOf(b) - widthOf(a))[0];
    // The outline IS the payload here: signatures + exact line ranges, so the
    // zoom below is a targeted pick rather than a blind re-request.
    const symbols = await extractSymbolsFromFile(content, filePath, 48);
    recordReadPath(workspace, filePath);
    return {
      mode: "skeleton",
      downgraded_from: "full",
      reason,
      path: filePath,
      handle: handleId,
      sha: shortSha(sha),
      bytes,
      total_lines: totalLines,
      skeleton: symbols,
      ...(remainingRanges.length > 0 ? { remaining_ranges: remainingRanges } : {}),
      ...(allowFullWouldHelp ? { allow_full_would_help: true } : {}),
      // PRE-FILLED zoom: same handle, the largest span this session has not
      // served yet. A cap that names the next call is a redirect; one that only
      // says "no" is the pure-loss turn W1 removed.
      // FX-1: canonical `targets=[...]` prose (see the sibling receipts above).
      ...(largestUnserved !== undefined
        ? { next: `read_file targets=${JSON.stringify([{ handle: handleId, ranges: [largestUnserved] }])}` }
        : {}),
      note: args.skeletonOnly === true
        ? "post-ready discovery trimmed; zoom this handle by range (the pre-filled `next` names the largest span you have not been served)"
        : "per-task whole-file budget spent on other files; zoom this handle by range"
          + " (the pre-filled `next` names the largest span you have not been served)",
    };
  }

  // W1 default: SERVE the file head (never a zero-content skeleton + breadcrumb).
  // The cap bounds bytes-per-response, so the caller gets real content THIS turn
  // and — only when the head is genuinely partial — a remainder `next` whose
  // range is byte-exact against the original file (serveGovernedFullHead keeps
  // line boundaries intact, no elision/whitespace collapse). A subsequent
  // mode=slice on that range clamps and chains its own remainder, so the whole
  // body is reachable without a single contentless turn. `next` stays
  // slice-shaped even when allowFull would serve the full body — re-reading full
  // would resend the head we just served; allow_full_would_help signals the
  // option without routing the caller back through a redundant full read.
  const { head, servedLines, totalLines } = serveGovernedFullHead(content, GOVERNED_FULL_SERVE_BYTES);
  const truncated = servedLines < totalLines;
  recordReadPath(workspace, filePath);
  return {
    mode: "full",
    downgraded_from: "full",
    reason,
    path: filePath,
    handle: handleId,
    sha: shortSha(sha),
    bytes,
    content: head,
    truncated,
    ...(allowFullWouldHelp ? { allow_full_would_help: true } : {}),
    ...(truncated
      ? { next: `read_file mode=slice handle=${handleId} range=${servedLines + 1}-${totalLines}` }
      : {}),
  };
}

/**
 * FIX C (2026-07-12c forensics): mode=symbol's cap-exceeded refusal used
 * to fire for a symbol body even trivially over READ_SYMBOL_CAP_BYTES (live:
 * a single method body was 8378B against an 8192B cap,
 * 2.3% over) — the caller got zero content and had to immediately re-fetch
 * via mode=slice, the exact pure-loss-turn class buildFullDowngradePayload
 * above already closed for mode=full. Mirrors that precedent for mode=symbol:
 * serve a head-of-body TRIMMED to fit, `downgraded_from:"symbol"`, and a
 * `next` pointing at `mode=slice` over the symbol's full line RANGE — not
 * `symbol=` — since resolveSlice's RANGE branch (readCodeModes.ts) already
 * truncates-and-continues on its own cap instead of refusing, so the
 * caller's remainder fetch always succeeds without hitting the sibling
 * refusal in resolveSlice's OWN symbol branch.
 *
 * Bake-into-cap (the findText.ts / resolveMap / resolveDigest convention —
 * see e.g. tools/findText.ts's "baked into every trial's byte count, not
 * spliced on after" comments, and resolveMap/resolveDigest's serialize-
 * measure-trim loops above in readCodeModes.ts): every field in the final
 * payload — handle/sha/path/symbol/range/downgraded_from/reason/bytes/
 * maxBytes/next, not just `code` — is measured as part of the SAME
 * serialized trial the code budget is computed against, and re-trimmed if
 * JSON-escaping ever pushes the total back over maxBytes. Nothing is ever
 * spliced on after a content-only truncation.
 *
 * Returns undefined only for the pathological case where the non-code
 * envelope fields alone already meet/exceed maxBytes — the caller keeps its
 * existing hard refusal for that case.
 */
function buildSymbolDowngradePayload(args: {
  filePath: string;
  symbolName: string;
  language: string;
  range: { start: number; end: number };
  /** Raw full-file content; used to map the served head to exact source lines. */
  sourceContent: string;
  keepComments: boolean;
  handleId: string;
  /** Short display sha (already shortSha'd by the caller — C10.1 convention). */
  sha: string;
  /** The ORIGINAL (pre-trim) byte count — same number the legacy refusal reported. */
  bytes: number;
  maxBytes: number;
}): Record<string, unknown> | undefined {
  const { filePath, symbolName, language, range, sourceContent, keepComments, handleId, sha, bytes, maxBytes } = args;
  const sourceLines = sourceContent.split(/\r?\n/);
  const bodyEnd = Math.min(range.end, sourceLines.length);
  const bodyLines = sourceLines.slice(range.start - 1, bodyEnd);
  if (bodyLines.length === 0) return undefined;

  // With the experiment enabled, spend the deterministic must-fetch tier on
  // this same response. Otherwise this is exactly the legacy 8K wire cap.
  const wireCap = mustFetchReadBudget(maxBytes);
  const envelope = (bodyCode: string, servedEnd: number): Record<string, unknown> => {
    const wasTrimmed = servedEnd < bodyEnd;
    const next = wasTrimmed
      ? `read_file mode=slice handle=${handleId} range=${servedEnd + 1}-${bodyEnd}`
      : undefined;
    return {
      code: bodyCode,
      language,
      range,
      served_range: `${range.start}-${servedEnd}`,
      handle: handleId,
      sha,
      path: filePath,
      symbol: symbolName,
      downgraded_from: "symbol",
      reason: "symbol-cap-reached",
      truncated: wasTrimmed,
      bytes,
      maxBytes: wireCap,
      ...(next !== undefined ? { next } : {}),
    };
  };

  // Select the largest whole-source-line prefix whose COMPLETE serialized
  // envelope fits. Mapping the head to raw lines makes the continuation start
  // strictly after what was served; the former assembled-view continuation
  // restarted at range.start and duplicated the entire head.
  let low = 1;
  let high = bodyLines.length;
  let best: Record<string, unknown> | undefined;
  while (low <= high) {
    const count = Math.floor((low + high) / 2);
    const rawBody = bodyLines.slice(0, count).join("\n");
    const bodyCode = keepComments
      ? rawBody
      : elideDocComments(rawBody, language, range.start);
    const candidate = envelope(bodyCode, range.start + count - 1);
    if (bodyCode.trim() !== "" && Buffer.byteLength(JSON.stringify(candidate), "utf8") <= wireCap) {
      best = candidate;
      low = count + 1;
    } else {
      high = count - 1;
    }
  }

  return best;
}

/**
 * DESIGN-v0.9 §4.6a: compute the ONE inline continuation window for a
 * cap-truncated RANGE slice. `servedHead` is the raw content resolveSlice
 * actually served (its line count fixes where the head ended); the window is
 * the next whole-line span from there, bounded so head+window fits the §4.8
 * must-fetch budget for reads (16384 with the flag on; 8192 — i.e. no room —
 * with it off). Returns the window (comment-elided per keepComments) plus the
 * `next` string ADVANCED past it (undefined once the window reaches the
 * requested end). Returns undefined when nothing is left, the budget leaves no
 * room, or the window trims to empty — never fabricates a window past EOF.
 */
function computeSliceContinuation(
  fileContent: string,
  servedRange: string,
  servedHead: string,
  handle: string,
  keepComments: boolean,
  language: string | undefined,
): { continued: { range: string; content: string }; next?: string } | undefined {
  const m = servedRange.match(/^(\d+)-(\d+)$/);
  if (!m) return undefined;
  const startLine = parseInt(m[1]!, 10);
  const endLine = parseInt(m[2]!, 10);
  if (!Number.isFinite(startLine) || !Number.isFinite(endLine) || startLine < 1 || endLine < startLine) return undefined;

  const servedLines = servedHead === "" ? 0 : servedHead.split("\n").length;
  const contStart = startLine + servedLines; // first line AFTER the served head
  if (contStart > endLine) return undefined; // head already reached the requested end

  const budget = mustFetchReadBudget(READ_SYMBOL_CAP_BYTES);
  // §4.8: with the flag OFF the budget is unchanged, and the head already owns
  // the whole base cap — reserving the head's own cap for the head means there
  // is no room for a continuation, so §4.6a is a no-op (the `next` continuation
  // still points the agent at the remainder). Only the flag-on EXPANSION funds
  // an inline window; the head may have trimmed a little short of the base cap,
  // so the window gets that slack PLUS the expansion.
  if (budget <= READ_SYMBOL_CAP_BYTES) return undefined;
  const remaining = budget - Buffer.byteLength(servedHead, "utf8");
  if (remaining <= 0) return undefined;

  const lines = fileContent.split(/\r?\n/);
  const clampedEnd = Math.min(endLine, lines.length);
  if (contStart > clampedEnd) return undefined;

  let windowText = lines.slice(contStart - 1, clampedEnd).join("\n");
  if (Buffer.byteLength(windowText, "utf8") > remaining) {
    windowText = Buffer.from(windowText, "utf8").slice(0, remaining).toString("utf8");
    const lastNl = windowText.lastIndexOf("\n");
    if (lastNl > 0) windowText = windowText.slice(0, lastNl);
  }
  if (windowText === "" || windowText.trim() === "") return undefined;

  const windowLineCount = windowText.split("\n").length;
  const contEnd = contStart + windowLineCount - 1;
  const displayed = keepComments ? windowText : elideDocComments(windowText, language, contStart);
  const continued = { range: `${contStart}-${contEnd}`, content: displayed };
  const next = contEnd < endLine
    ? `read_file mode=slice handle=${handle} range=${contEnd + 1}-${endLine}`
    : undefined;
  return { continued, ...(next !== undefined ? { next } : {}) };
}

/**
 * Result of resolving mode=full for ONE path — extracted from the inline
 * single-path mode=full handler so both the original single-path call site
 * and the new paths[] batch (below) share IDENTICAL governor/office/cap
 * behavior instead of two copies drifting apart. `ok:true.data` is exactly
 * the object the single-path caller used to pass to toolOk(...); `ok:false`
 * carries exactly the string the single-path caller used to pass to
 * toolError(...) — so `resolveFullReadForPathSingle` below reproduces the
 * pre-extraction behavior byte-for-byte, and the batch caller can fold a
 * per-path failure into an `omitted` entry instead of aborting the batch.
 */
type FullReadResolution = { ok: true; data: Record<string, unknown> } | { ok: false; error: string; code?: RefusalCode };

/**
 * B2e (2026-08-01 serving-completeness): per-response ceiling for ONE mode=full
 * serve, matching the slice batch's own response cap.
 *
 * Live defect (2026-07-31-semantic-signal5-2, T05c): a mode=full of a 50.5KB
 * source file produced a single ~52KB JSON tool result that the CLIENT harness
 * clamped — the model never received the body — while TL recorded the file as
 * FULLY served. Every later slice of that file then answered with a
 * `code_unchanged` receipt for bytes the model had never seen, and it took two
 * allowFull retries to recover. Bounding a single serve keeps the response
 * inside what clients actually deliver; `remaining_ranges` + a same-handle
 * continuation `next` make the rest reachable without a contentless turn.
 *
 * allowFull:true remains the documented uncapped escape hatch (it already
 * raises the byte ceiling to READ_FULL_CAP_BYTES_ALLOW_FULL) — but even then
 * only what was actually sent is recorded.
 */
export const FULL_SERVE_CHUNK_BYTES = 24576;

/**
 * B2e: build the mode=full success payload, chunked to FULL_SERVE_CHUNK_BYTES
 * unless `allowFull` was explicitly requested.
 *
 * Elision is applied to the WHOLE file first: a comment-heavy file that fits
 * the chunk cap after elision is still served complete (today's behavior). Only
 * when even the elided body overflows does the serve chunk, and then the chunk
 * is cut on RAW file line boundaries (serveGovernedFullHead) so
 * `remaining_ranges`/`next` line up byte-exactly with a follow-up mode=slice.
 */
function buildFullServePayload(args: {
  workspace: string;
  filePath: string;
  content: string;
  handleId: string;
  sha: string;
  keepComments: boolean;
  allowFull: boolean;
  extra?: Record<string, unknown>;
}): Record<string, unknown> {
  const { workspace, filePath, content, handleId, sha, keepComments, allowFull, extra } = args;
  const language = languageForPath(filePath);
  // 2026-07-16a bench forensics: fall back to raw content + a note instead of
  // serving an elided-empty doc-only file — see elideDocCommentsForDisplay.
  const whole = elideDocCommentsForDisplay(content, language, keepComments);
  const wholeFits =
    allowFull || Buffer.byteLength(whole.content, "utf8") <= FULL_SERVE_CHUNK_BYTES;

  recordReadPath(workspace, filePath);

  if (wholeFits) {
    recordFullServeCompleteness(workspace, filePath, sha, true);
    return {
      mode: "full",
      handle: handleId,
      path: filePath,
      content: compressFormat(whole.content),
      truncated: false,
      sha: shortSha(sha),
      fullFileExpansion: true as const,
      language: filePath.split(".").pop() ?? "unknown",
      ...(whole.note ? { note: whole.note } : {}),
      ...(extra ?? {}),
    };
  }

  const { head, servedLines, totalLines } = serveGovernedFullHead(content, FULL_SERVE_CHUNK_BYTES);
  const chunk = elideDocCommentsForDisplay(head, language, keepComments);
  const remainingRange = `${servedLines + 1}-${totalLines}`;
  // Record ONLY what actually went on the wire. A chunked serve must never let
  // wasFullyServed / the served-range ledger claim the whole file.
  recordFullServeCompleteness(workspace, filePath, sha, false);
  if (servedLines >= 1) {
    // F1 (2026-08-02 serve-honesty): "what went on the wire" also excludes any
    // comment block the head's OWN display collapsed to a `doc elided` marker.
    // Book the surviving spans of `chunk.content`, not the flat 1..servedLines
    // the head was cut at.
    const headCall = beginServeCall(workspace);
    for (const [spanStart, spanEnd] of servedSpansOfDisplayedText(1, chunk.content, servedLines)) {
      recordServedRange(workspace, filePath, sha, spanStart, spanEnd, totalLines, {
        mode: "full-head",
        range: `1-${servedLines}`,
        call: headCall,
      });
    }
  }
  const composedNote = [
    chunk.note,
    `served the first ${servedLines} of ${totalLines} lines (single-serve cap ${FULL_SERVE_CHUNK_BYTES}B);`
    + " remaining_ranges names the rest on this same handle — pass allowFull:true to force one uncapped serve",
  ].filter(Boolean).join("; ");
  return {
    mode: "full",
    handle: handleId,
    path: filePath,
    content: compressFormat(chunk.content),
    truncated: true,
    range: `1-${servedLines}`,
    total_lines: totalLines,
    remaining_ranges: [remainingRange],
    sha: shortSha(sha),
    language: filePath.split(".").pop() ?? "unknown",
    next: `read_file mode=slice handle=${handleId} range=${remainingRange}`,
    note: composedNote,
    ...(extra ?? {}),
  };
}

/**
 * A partial task-pack/slice makes some file lines resident, but a later
 * whole-file request must still serve every line the caller does not hold.
 * Return mixed per-window evidence so the v1 projector can preserve both facts:
 * fresh gaps carry code and resident gaps carry code_unchanged provenance.
 */
function buildLedgerDifferenceFullPayload(args: {
  workspace: string;
  filePath: string;
  content: string;
  handleId: string;
  sha: string;
  keepComments: boolean;
  mode: "full" | "auto" | "symbol";
  /** Optional requested file-line window; omitted means the whole file. */
  range?: readonly [number, number];
  /** Coverage observed before a helper resolves a full expansion. */
  priorCoverage?: ReturnType<typeof servedRangeCoverage>;
}): Record<string, unknown> | undefined {
  const totalLines = countLines(args.content);
  const coverage = args.priorCoverage ?? servedRangeCoverage(args.workspace, args.filePath, args.sha, totalLines);
  if (coverage === undefined || coverage.complete) return undefined;

  const requestedStart = args.range?.[0] ?? 1;
  const requestedEnd = args.range?.[1] ?? totalLines;
  const lines = args.content.split(/\r?\n/);
  const segments: Array<Record<string, unknown>> = [];
  const notes: string[] = [];
  const serveCall = beginServeCall(args.workspace);

  const appendFresh = (start: number, end: number): void => {
    const raw = lines.slice(start - 1, end).join("\n");
    const display = args.keepComments
      ? { content: raw, note: undefined as string | undefined }
      : elideDocCommentsForDisplay(raw, languageForPath(args.filePath), false, start);
    segments.push({ range: `${start}-${end}`, code: display.content });
    if (display.note !== undefined) notes.push(`${start}-${end}: ${display.note}`);
    for (const [spanStart, spanEnd] of servedSpansOfDisplayedText(start, display.content, end)) {
      recordServedRange(
        args.workspace,
        args.filePath,
        args.sha,
        spanStart,
        spanEnd,
        totalLines,
        { mode: args.mode, range: `${start}-${end}`, call: serveCall },
      );
    }
  };

  let cursor = requestedStart;
  for (const [servedStartRaw, servedEndRaw] of coverage.served) {
    const servedStart = Math.max(requestedStart, servedStartRaw);
    const servedEnd = Math.min(requestedEnd, servedEndRaw);
    if (servedEnd < cursor || servedStart > requestedEnd) continue;
    if (cursor < servedStart) appendFresh(cursor, servedStart - 1);
    const priorStart = Math.max(cursor, servedStart);
    const receipt = servedRangeReceipt(
      args.workspace,
      args.filePath,
      args.sha,
      priorStart,
      servedEnd,
      totalLines,
    );
    segments.push({
      range: `${priorStart}-${servedEnd}`,
      code_unchanged: true,
      ...(receipt?.served_by !== undefined ? { served_by: receipt.served_by } : {}),
    });
    cursor = servedEnd + 1;
  }
  if (cursor <= requestedEnd) appendFresh(cursor, requestedEnd);

  if (!segments.some((segment) => typeof segment["code"] === "string")) return undefined;
  return {
    mode: args.mode,
    path: args.filePath,
    handle: args.handleId,
    sha: shortSha(args.sha),
    total_lines: totalLines,
    segments,
    ...(notes.length > 0 ? { note: notes.join("; ") } : {}),
  };
}

// ---------------------------------------------------------------------------
// B2 / V12-02 — delta context: the READ side (TL_DELTA_CONTEXT, default OFF)
// ---------------------------------------------------------------------------

/**
 * Bytes a `prior` segment costs once `readFamily.ts`'s `textEvidence` has
 * projected it: `{"handle":…,"path":…,"range":"120-480","prior":"slice 1-500
 * (call #2)"}`. Deliberately GENEROUS — the size guard's job is to prefer the
 * plain body whenever the delta win is marginal, so over-estimating the
 * projection's own overhead fails in the safe direction.
 */
const DELTA_PRIOR_SEGMENT_BYTES = 140;
/** Extra bytes a fresh segment costs over the single-body serve it replaces. */
const DELTA_FRESH_SEGMENT_BYTES = 90;

/** Raw byte size of file lines [start,end] of `lines` (newlines included). */
function lineWindowBytes(lines: readonly string[], start: number, end: number): number {
  let bytes = 0;
  for (let i = start; i <= end && i <= lines.length; i += 1) {
    bytes += Buffer.byteLength(lines[i - 1] ?? "", "utf8") + 1;
  }
  return bytes;
}

/**
 * B2 / V12-02: should this read serve a delta projection instead of the plain
 * body, and is the ledger entry behind it still valid?
 *
 * THREE GATES, IN ORDER, ALL OF WHICH MUST PASS:
 *  1. `TL_DELTA_CONTEXT` is on. Off, this returns `undefined` before touching
 *     any state, which is what makes an edit-then-read sequence byte-identical
 *     to the pre-B2 tree.
 *  2. `deltaLedgerStatus` says `"carried"` — the entry survived an edit THIS
 *     server applied AND still describes the bytes on disk. A `"dropped"`
 *     answer is the base-mismatch fallback (an external write): the entry is
 *     gone and the caller serves the full body.
 *  3. THE SIZE GUARD (plan acceptance "delta>full なら自動 full"): the held
 *     windows must be worth more than the per-segment overhead they cost.
 *     Measured on the RAW line bytes of both sides — the elider shrinks held
 *     and fresh windows alike, so comparing pre-elision bytes keeps the
 *     decision monotone without running the elider twice.
 *
 * SIDE-EFFECT FREE ON A LOSS. It never builds the projection, so nothing is
 * booked into the served-range ledger for a delta the caller does not receive
 * — `buildLedgerDifferenceFullPayload` records as it goes, and calling it
 * speculatively would claim bytes that never reached the wire.
 */
function deltaContextDecision(args: {
  workspace: string;
  filePath: string;
  content: string;
  sha: string;
  totalLines: number;
  /** Requested file-line window; omitted means the whole file. */
  range?: readonly [number, number];
}):
  | { decision: "delta"; coverage: NonNullable<ReturnType<typeof servedRangeCoverage>> }
  | { decision: "full" }
  | undefined {
  if (!deltaContextEnabled()) return undefined;
  const status = deltaLedgerStatus(args.workspace, args.filePath, args.sha);
  if (status === undefined) return undefined;
  // The entry was delta-derived and an external write invalidated it: the
  // caller must serve the plain body, and must NOT fall through to a coverage
  // check that a differently-shaped stale entry could still satisfy.
  if (status === "dropped") {
    trace("delta_context", {
      phase: "base-mismatch",
      path: args.filePath,
      outcome: "full-fallback",
    }, args.workspace);
    return { decision: "full" };
  }
  const coverage = servedRangeCoverage(args.workspace, args.filePath, args.sha, args.totalLines);
  if (coverage === undefined || coverage.complete) return undefined;

  const requestedStart = args.range?.[0] ?? 1;
  const requestedEnd = args.range?.[1] ?? args.totalLines;
  const lines = args.content.split(/\r?\n/);
  let heldBytes = 0;
  let priorSegments = 0;
  let freshSegments = 0;
  let cursor = requestedStart;
  for (const [servedStartRaw, servedEndRaw] of coverage.served) {
    const servedStart = Math.max(requestedStart, servedStartRaw);
    const servedEnd = Math.min(requestedEnd, servedEndRaw);
    if (servedEnd < cursor || servedStart > requestedEnd) continue;
    if (cursor < servedStart) freshSegments += 1;
    const priorStart = Math.max(cursor, servedStart);
    heldBytes += lineWindowBytes(lines, priorStart, servedEnd);
    priorSegments += 1;
    cursor = servedEnd + 1;
  }
  if (cursor <= requestedEnd) freshSegments += 1;
  // Nothing of this request is held: there is no delta to serve, and no reason
  // to override whatever the caller's ordinary path would have done.
  if (priorSegments === 0) return undefined;

  const projectionOverhead = priorSegments * DELTA_PRIOR_SEGMENT_BYTES
    + freshSegments * DELTA_FRESH_SEGMENT_BYTES;
  if (heldBytes <= projectionOverhead) {
    trace("delta_context", {
      phase: "guard",
      path: args.filePath,
      outcome: "full-cheaper",
      held_bytes: heldBytes,
      projection_overhead: projectionOverhead,
    }, args.workspace);
    return { decision: "full" };
  }
  trace("delta_context", {
    phase: "serve",
    path: args.filePath,
    range: `${requestedStart}-${requestedEnd}`,
    prior_segments: priorSegments,
    fresh_segments: freshSegments,
    held_bytes: heldBytes,
    projection_overhead: projectionOverhead,
  }, args.workspace);
  return { decision: "delta", coverage };
}

/**
 * Resolve read_code mode=full for exactly one path: office-file redirect
 * (unless allowFull), then the full-read governor (byte cap, per-path/
 * per-task budgets, C5 auto-allow), then the success payload. Each call is
 * fully independent — no shared state beyond the governor's own session
 * bookkeeping (decideFullRead/recordFullExpansion), which already counts a
 * paths[] batch item exactly as it would a separate single-path call, so
 * batching this way does not weaken or bypass any existing cap.
 */
async function resolveFullReadForPath(
  workspace: string,
  filePath: string,
  allowFullRequested: boolean,
  keepComments: boolean,
  officeOpts: {
    maxBytes?: number;
    maxTokens?: number;
    credentialRef?: string;
    credentialPassword?: string;
    forceServe?: boolean;
    /** W5: make this post-ready full read an honest skeleton downgrade. */
    postReadyTrim?: boolean;
  } = {},
): Promise<FullReadResolution> {
  const ext = (filePath.toLowerCase().match(/\.([^.\\/]+)$/)?.[1]) ?? "";
  const isOffice = ext === "docx" || ext === "xlsx" || ext === "pptx" || ext === "pdf";

  if (isOffice) {
    if (DOC_DISABLED) return { ok: false, error: "Document extraction is disabled.", code: "not-a-document" };

    // mode=full on office files: redirect unless allowFull is explicitly true.
    if (!allowFullRequested) {
      const offBytes = await readBytesSafe(filePath, workspace);
      if (offBytes === null) return { ok: false, error: `File not found or outside workspace: ${filePath}`, code: "not-found" };
      // B5.2: full-content hash, not a first-48-bytes truncation.
      const offSha = shaOfBytes(offBytes);
      handleTable.upsert({ kind: "file", path: filePath, workspaceRoot: workspace, sha: offSha });

      // Office (docx/xlsx/pptx/pdf): redirect to mode=artifact, which now
      // has a real extraction branch for every one of these kinds (pdf's
      // artifact branch used to be a dead end — an honest refusal with
      // nowhere further to steer — so this redirect used to short-circuit
      // pdf specifically to avoid a next=artifact loop; that special case is
      // gone now that mode=artifact kind=pdf does real extraction).
      return {
        ok: true,
        data: {
          ok: false,
          reason: "artifact-full-downgraded",
          path: filePath,
          alternatives: [
            { mode: "artifact", kind: ext, view: "roster" },
            ...(ext === "xlsx" ? [{ mode: "artifact", kind: "xlsx", as: "json" }] : []),
            ...(ext === "docx" ? [{ mode: "artifact", kind: "docx" }] : []),
            ...(ext === "pdf" ? [{ mode: "artifact", kind: "pdf" }] : []),
          ],
          next: `read_file mode=artifact path=${filePath} kind=${ext}${ext === "xlsx" ? " as=json" : ""}${
            officeOpts.credentialRef !== undefined
              ? ` credentialRef=${JSON.stringify(officeOpts.credentialRef)}`
              : ""
          }`,
        },
      };
    }

    // mode=full with allowFull:true on an office file: extract text directly.
    const bytes = await readBytesSafe(filePath, workspace);
    if (bytes === null) return { ok: false, error: `File not found or outside workspace: ${filePath}`, code: "not-found" };
    const result = await extractOfficeText(
      bytes,
      {
        path: filePath,
        ...(officeOpts.credentialRef !== undefined
          ? { credentialRef: officeOpts.credentialRef }
          : {}),
        ...(officeOpts.maxBytes !== undefined ? { maxBytes: officeOpts.maxBytes } : {}),
        ...(officeOpts.maxTokens !== undefined ? { maxTokens: officeOpts.maxTokens } : {}),
      },
      officeOpts.credentialPassword,
    );
    // #72 (C2-6 audit): forward extractOfficeText's own typed code instead
    // of collapsing to a bare `.error` string. extractOfficeText's own
    // McpToolResult failure widens `code` to plain `string` (packages/types'
    // generic result wrapper isn't RefusalCode-literal-typed); every actual
    // value it assigns (not-a-document/too-large/corrupt/pdf-*) IS a real
    // A.7.1 member, so the cast documents an already-true fact rather than
    // asserting a new one.
    if (!result.ok) return { ok: false, error: result.error, code: result.code as RefusalCode };
    return { ok: true, data: result.data as unknown as Record<string, unknown> };
  }

  const content = await readFileSafe(filePath, workspace);
  if (content === null) return { ok: false, error: `File not found or outside workspace: ${filePath}`, code: "not-found" };

  const fullBytes = Buffer.byteLength(content, "utf8");
  // BUG FIX: was content.split(/\r?\n/).length — feeds decideFullRead's
  // isTiny threshold check and buildAlternatives' suggested slice range.
  const fullLineCount = countLines(content);
  const fullSha = shaOfText(content);

  // Mint the file handle up front so every downgrade/deny payload below
  // (byte cap or governor) can reference it directly.
  const govHEntry = handleTable.upsert({ kind: "file", path: filePath, workspaceRoot: workspace, sha: fullSha });

  // A6: allowFull is consulted for the byte cap itself now, not just the
  // governor. Without allowFull the ceiling stays READ_FULL_CAP_BYTES
  // (unchanged behavior); allowFull:true raises it to the higher
  // READ_FULL_CAP_BYTES_ALLOW_FULL bound.
  const effectiveCapBytes = allowFullRequested ? READ_FULL_CAP_BYTES_ALLOW_FULL : READ_FULL_CAP_BYTES;

  // W5: a post-ready full read is still a NEW request. Reuse the established
  // full-read skeleton downgrade instead of fabricating a code-unchanged or
  // decision-unchanged receipt. The payload names every unserved range and a
  // same-handle slice continuation; no new wire kind or field is introduced.
  if (officeOpts.postReadyTrim === true && officeOpts.forceServe !== true) {
    // Tiny files are already cheaper to serve whole than to project into a
    // skeleton. Returning the full body here keeps the trim marker honest: no
    // discovery was actually trimmed when the tiny exception applies.
    if (fullBytes <= TINY_BYTES && fullLineCount <= TINY_LINES) {
      return {
        ok: true,
        data: buildFullServePayload({
          workspace,
          filePath,
          content,
          handleId: govHEntry.id,
          sha: fullSha,
          keepComments,
          allowFull: allowFullRequested,
        }),
      };
    }
    noteServedBytesSource("post-ready-trim");
    return {
      ok: true,
      data: await buildFullDowngradePayload({
        workspace,
        filePath,
        content,
        handleId: govHEntry.id,
        sha: fullSha,
        bytes: fullBytes,
        maxBytes: effectiveCapBytes,
        reason: "full-downgraded",
        allowFullWouldHelp: false,
        skeletonOnly: true,
        hint: "Post-ready discovery is trimmed; zoom this honest skeleton by range.",
      }),
    };
  }
  if (fullBytes > effectiveCapBytes) {
    const allowFullWouldHelp = !allowFullRequested && fullBytes <= READ_FULL_CAP_BYTES_ALLOW_FULL;

    // C5/G2: first-read auto-allow — see decideFullRead's autoAllowUnderCeiling
    // doc comment (fullGovernor.ts). Serves the file directly on a genuine
    // first read with per-task budget left, skipping the wasted
    // downgrade-then-retry-with-allowFull turn.
    if (allowFullWouldHelp && fullBytes <= LARGE_BYTES) {
      const autoDecision = decideFullRead({
        workspace,
        path: filePath,
        byteSize: fullBytes,
        lineCount: fullLineCount,
        sha: fullSha,
        allowFull: false,
        fileHandle: govHEntry.id,
        autoAllowUnderCeiling: true,
      });
      if (autoDecision.decision === "allow" && autoDecision.autoAllowed) {
        // Feature 1 (2026-07-12b2): successful mode=full content serve.
        // B2e: routed through the shared chunk-capped builder.
        return {
          ok: true,
          data: buildFullServePayload({
            workspace,
            filePath,
            content,
            handleId: govHEntry.id,
            sha: fullSha,
            keepComments,
            allowFull: allowFullRequested,
            extra: { auto_allowed: autoDecision.autoAllowed },
          }),
        };
      }
      if (autoDecision.decision === "downgrade" && autoDecision.reason === "per-task-cap-reached") {
        return {
          ok: true,
          data: await buildFullDowngradePayload({
            workspace,
            filePath,
            content,
            handleId: govHEntry.id,
            sha: fullSha,
            bytes: fullBytes,
            maxBytes: effectiveCapBytes,
            reason: "per-task-cap-reached",
            allowFullWouldHelp: true,
            alternatives: autoDecision.alternatives,
            hint: "This task has hit its full-read budget for other files.",
          }),
        };
      }
      // Otherwise (a REPEAT read → per-path-cap-reached downgrade): fall
      // through to the byte cap-exceeded payload below.
    }

    const hint = allowFullRequested
      ? `File is ${fullBytes} bytes, over the allowFull ceiling of ${READ_FULL_CAP_BYTES_ALLOW_FULL}; allowFull cannot help further here.`
      : allowFullWouldHelp
        ? `File is ${fullBytes} bytes, over the default cap of ${READ_FULL_CAP_BYTES}.`
        : `File is ${fullBytes} bytes, over both the default cap (${READ_FULL_CAP_BYTES}) and the allowFull ceiling (${READ_FULL_CAP_BYTES_ALLOW_FULL}); allowFull cannot help here.`;
    return {
      ok: true,
      data: await buildFullDowngradePayload({
        workspace,
        filePath,
        content,
        handleId: govHEntry.id,
        sha: fullSha,
        bytes: fullBytes,
        maxBytes: effectiveCapBytes,
        reason: "cap-exceeded",
        allowFullWouldHelp,
        hint,
      }),
    };
  }

  // Governor check: consult decideFullRead before expanding. Preserves
  // anti-abuse intent (PER_PATH_FULL_CAP, PER_TASK_FULL_CAP, adaptive
  // per-task tightening) — allowFull bypasses only the per-task cap, never
  // the per-path cap (fullGovernor.ts). `force_serve` is narrower: it bypasses
  // repeat-read receipts/governor state only after the byte cap above has
  // accepted the payload, so it re-sends a cap-fitting body without raising
  // either content ceiling. Each paths[] item otherwise hits this SAME
  // governor call as a single-path call would.
  const govDecision = officeOpts.forceServe === true
    ? undefined
    : decideFullRead({
        workspace,
        path: filePath,
        byteSize: fullBytes,
        lineCount: fullLineCount,
        sha: fullSha,
        allowFull: allowFullRequested,
        fileHandle: govHEntry.id,
      });
  if (govDecision !== undefined && govDecision.decision !== "allow") {
    const allowFullWouldHelp = !allowFullRequested && govDecision.reason === "per-task-cap-reached";
    const hint = govDecision.reason === "candidate-pack-full-repeat"
      ? "A candidate-list task pack is pending: its served candidate handles already carry the disambiguation bodies — choose among them instead of further full reads. Pass taskEpoch:\"new\" only for a genuinely different task."
      : allowFullRequested
        ? "allowFull was already applied; this file already had its one full read for the current content (per-path cap)."
        : allowFullWouldHelp
          ? "This task has hit its full-read budget for other files."
          : "This file already had its one full read for the current content (per-path cap); allowFull cannot bypass that.";
    const govReason: Parameters<typeof buildFullDowngradePayload>[0]["reason"] =
      govDecision.decision === "deny"
        ? "full-denied"
        : (govDecision.reason === "per-path-cap-reached"
            || govDecision.reason === "per-task-cap-reached"
            || govDecision.reason === "tiny-task-cap-reached"
            || govDecision.reason === "tiny-skeleton-cap-reached"
            || govDecision.reason === "allowfull-task-cap-reached"
            || govDecision.reason === "candidate-pack-full-repeat")
          ? govDecision.reason
          : "full-downgraded";
    return {
      ok: true,
      data: await buildFullDowngradePayload({
        workspace,
        filePath,
        content,
        handleId: govHEntry.id,
        sha: fullSha,
        bytes: fullBytes,
        maxBytes: effectiveCapBytes,
        reason: govReason,
        allowFullWouldHelp,
        alternatives: govDecision.alternatives,
        hint,
      }),
    };
  }

  // mode=full augmentation: handle + sha + fullFileExpansion:true (C.5).
  // Note: recordFullExpansion already called inside decideFullRead for "allow".
  // B2e: the payload is built by buildFullServePayload, which caps ONE serve at
  // FULL_SERVE_CHUNK_BYTES (unless allowFull) and records only what it sent.
  // Feature 1 (2026-07-12b2): successful mode=full content serve.
  return {
    ok: true,
    data: buildFullServePayload({
      workspace,
      filePath,
      content,
      handleId: govHEntry.id,
      sha: fullSha,
      keepComments,
      allowFull: allowFullRequested,
    }),
  };
}

/**
 * WS-P3 (DESIGN-v0.9 §6, refusal-path audit) fallback for
 * resolveFullReadForPath's OUTER `{ok:false, error}` shape — a genuinely
 * bare `{ok:false, error:message}` once it reaches toolError(), with no
 * content, handle, or next. Only the two SINGLE-path mode=full callers route
 * through this (the paths[] batch below builds its own richer `omitted[]`
 * entries directly from `fr`, re-stating a directory-specific reason when
 * `fr.ok===false` — see its "is a directory" re-stat comment — so it must
 * keep observing that outer ok:false discriminator unchanged; this helper is
 * intentionally NOT wired into resolveFullReadForPath itself).
 *
 * "File not found or outside workspace: <path>" is the one message shape
 * with an obvious, cheap, always-correct next step: the path itself was
 * wrong, so point at `search_files action=tree` to browse the real layout
 * rather than have the caller guess again blind. Other messages from this
 * function (doc extraction disabled; an office-extraction failure reason)
 * name a terminal or non-path condition — inventing a path-recovery `next`
 * there would misdirect rather than help, so they pass through unchanged.
 */
function fullReadRefusal(failure: { error: string; code?: RefusalCode }): ReturnType<typeof toolStructuredError> {
  const notFound = failure.error.startsWith("File not found or outside workspace");
  // #72 (C2-6 audit): resolveFullReadForPath now forwards a typed `code`
  // when it has one (extractOfficeText's own failure code, in particular —
  // this used to collapse to a bare `.error` string here, losing e.g. the
  // pdf-encrypted/pdf-no-text-layer distinction). No typed code falls back
  // to the same not-found/invalid-input split the retired message-regex
  // fallback used to produce.
  return toolStructuredError({
    ok: false,
    code: failure.code ?? (notFound ? "not-found" : "invalid-input"),
    error: failure.error,
    ...(notFound ? { next: "search_files action=tree" } : {}),
  });
}

/**
 * Row 11 (C2-6): `mode=map`'s locate-abstain passthrough has no A.7.1
 * "still a success" shape of its own to answer through — A.7.1's
 * "OUT — locate abstains" exclusion is scoped to `search_files
 * action=locate`'s `search.matches` family (§4.3), which HAS a documented
 * `hit:false` success shape; `read.map` has none, so the SAME abstain
 * reason must become a genuine REFUSAL here instead of the made-up
 * `toolOk({mode:"map", hit:false, reason})` shape this replaces. Only
 * "ambiguous"/"not-found" are exact A.7.1 members; the rest are the
 * nearest honest existing code (an A.7.1 gap, filed for R5 — see the
 * C2-6 report).
 *
 * R5-29 STATUS (ratified 2026-08-14): this is the FOURTH gap, the one the
 * row itself never named. It is RECORDED, NOT CLOSED — the two minted
 * codes went to the directory-target and ambiguous-write-intent emitters
 * only. Closing this one is a separate decision, because unlike those two
 * it is a whole REASON VOCABULARY (`locateAbstainReason`) mapped onto
 * A.7.1, not a single situation missing a single member.
 */
function mapMissRefusalCode(reason: string): RefusalCode {
  switch (reason) {
    case "ambiguous":
    case "multi-surface":
      return "ambiguous";
    case "not-found":
    case "ignored-path":
    case "missing-surface":
      return "not-found";
    case "snippet-too-large":
      return "cap-exceeded";
    case "broad-query":
      return "broad-overview-query";
    default:
      // resolveMap's own "query is required for mode=map" prose (not a
      // LocateAbstainData.reason token) lands here.
      return "invalid-input";
  }
}

/**
 * C2-6: `resolveTaskPackQueryArg`'s two failure messages need different
 * A.7.1 codes and (for the stale-qref case) a machine-readable detail —
 * resolved here, at each of its two call sites, rather than changing the
 * function's own return shape underneath its other caller.
 */
function taskPackQueryErrorPayload(resolution: { error?: string; next?: string | Record<string, unknown>; detail?: string }): Record<string, unknown> {
  // Callers only reach here after their own `if (resolution.error)` guard,
  // but that narrows the ACCESSED property, not this parameter's wider
  // `TaskPackQueryResolution` source type — so `error` stays optional here
  // and is defaulted, never actually empty in practice.
  const message = resolution.error ?? "";
  const staleQref = /^unknown-or-stale-qref: /u.test(message);
  return {
    ok: false,
    // A qref is an opaque, session-scoped SERVER reference token, same as a
    // handle — "handle-unknown" is the nearest honest A.7.1 member for one
    // that is unrecognized or has expired (no dedicated qref code exists;
    // A.7.1 gap, filed for R5 — see the C2-6 report). The mutual-exclusion
    // message is a plain argument-shape mistake.
    code: staleQref ? "handle-unknown" : "invalid-input",
    error: message,
    detail: resolution.detail ?? message,
    ...(resolution.next !== undefined ? { next: resolution.next } : {}),
  };
}

/**
 * C2-6: `xlsxTable`/`xlsxRoster` carry no typed failure code of their own
 * (see the C2-6 audit) — classified here by message content instead of
 * inventing a new A.7.1 member. "Sheet ... not found" has an EXACT enum
 * member (xlsx-sheet-not-found); a hidden default sheet needs the caller to
 * name one explicitly (invalid-input); anything else (a load/parse
 * exception, or "Workbook has no sheets") means the workbook itself could
 * not be read (corrupt).
 */
function xlsxTableFailureCode(message: string): RefusalCode {
  if (/not found\. Available:/u.test(message)) return "xlsx-sheet-not-found";
  if (/is hidden\. Specify sheet name explicitly\.$/u.test(message)) return "invalid-input";
  return "corrupt";
}

// ---------------------------------------------------------------------------
// Feature 1 (2026-07-12b2 "never-read decoy" forensics): the
// one-shot unread-sibling concern note. Session read-side guards
// (concern_note, Guard 2) only cover files the agent PARTIALLY read — a file
// never opened at all is invisible to them. The last cheap redirect point is
// the session's FIRST successful edit_code completion: scan the edited
// file's project family for a sibling that carries >= 2 of the session's
// concern tokens but was never read, and warn before the agent concludes.
// ---------------------------------------------------------------------------

/** Bounds for buildUnreadSiblingNote's family scan — see its doc comment. */
const UNREAD_SCAN_MAX_FILES = 400;
const UNREAD_SCAN_MAX_FILE_BYTES = 256 * 1024;
const UNREAD_NOTE_MAX_CHARS = 170;

/** Small single-file edits at or below this hunk size skip the lexical sibling note by default. */
export const UNREAD_NOTE_MAX_HUNK_LINES = 40;

function unreadNoteSpecificityEnabled(): boolean {
  return (process.env["TL_UNREAD_NOTE_SPECIFICITY"] ?? "").trim().toLowerCase() !== "off";
}

function unreadNoteMaxHunkLines(): number {
  const raw = (process.env["TL_UNREAD_NOTE_MAX_HUNK_LINES"] ?? "").trim();
  if (!/^\d+$/.test(raw)) return UNREAD_NOTE_MAX_HUNK_LINES;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) ? parsed : UNREAD_NOTE_MAX_HUNK_LINES;
}

/** Sum of each search/replace item's larger side; non-hunk edit shapes stay unknown. */
export function editHunkLineCount(args: Record<string, unknown>): number | undefined {
  const count = (value: string | undefined): number =>
    value === undefined || value.length === 0 ? 0 : value.split(/\r?\n/).length;
  let total = 0;
  let sawHunk = false;
  for (const hunks of editHunksByPath(args).values()) {
    for (const hunk of hunks) {
      if (hunk.search === undefined && hunk.replace === undefined) continue;
      sawHunk = true;
      total += Math.max(count(hunk.search), count(hunk.replace));
    }
  }
  return sawHunk ? total : undefined;
}

/** Rule B: keep only code-shaped hunk identifiers, not ordinary shared domain prose. */
function specificIdentifiersFromEditArgs(args: Record<string, unknown>): string[] {
  return identifiersFromEditArgs(args).filter(
    (token) => /[a-z][A-Z]/.test(token) || token.includes("_") || /^[A-Z0-9]{3,}$/.test(token),
  );
}

/**
 * Extracts the workspace-relative path(s) a (successful) edit_code result
 * touched. Mirrors withReview's isBatch/touchedPaths split (applyEditsMulti
 * returns `files: EditFileResult[]`, no per-item `ok` on the happy path —
 * ok!==false is success), renameSymbol's own `changed_files:
 * RenameFileResult[]` shape (renameSymbol.ts's RenameSymbolResult — a rename
 * is workspace-wide by default, so its result never carries a top-level
 * `path`), and withHandleAugment's nested-edit fallback (readAndEdit's
 * pathless shape nests the touched path under `edit.path`). `fallbackPath`
 * covers a single-edit result that omits `path` entirely.
 */
function editedPathsOf(result: Record<string, unknown>, fallbackPath: string): string[] {
  type BatchEntry = { ok?: boolean; path?: string };
  const batchR = result as { files?: BatchEntry[]; results?: BatchEntry[]; changed_files?: BatchEntry[] };
  const batchEntries = batchR.files ?? batchR.results ?? batchR.changed_files;
  if (Array.isArray(batchEntries)) {
    const paths = batchEntries.filter((r) => r.ok !== false && r.path).map((r) => r.path as string);
    return [...new Set(paths)];
  }
  const nestedEdit = (result as { edit?: { path?: string } }).edit;
  const singlePath = nestedEdit?.path ?? (result as { path?: string }).path ?? fallbackPath;
  return singlePath ? [singlePath] : [];
}

/** Workspace-relative POSIX top-level directory segment of `relPath` — fallback family scope, see buildUnreadSiblingNote. */
function topDirOf(relPath: string): string {
  const norm = relPath.replace(/\\/g, "/").replace(/^\/+/, "");
  const idx = norm.indexOf("/");
  return idx === -1 ? "" : norm.slice(0, idx);
}

/**
 * Scans `editedPaths[0]`'s project family for the best-scoring UNREAD
 * sibling — a file carrying >= 2 distinct session concern tokens that was
 * never served content this session (see util/session.ts's readPaths) — and
 * returns a bounded note naming it, or undefined when none qualifies (or the
 * session has no concern tokens at all).
 *
 * Family scope: projectRootOf(anchor, workspace) — the same marker/VCS-root
 * discipline util/projectRoot.ts's RootResolver already provides for
 * cross-project scoping (see locateTaskContext.ts). Falls back to the
 * workspace-relative TOP directory segment of the anchor path when
 * projectRootOf resolves ambiguously (the "" workspace-root sentinel) —
 * scanning the whole workspace would be both too broad and too costly for a
 * per-edit check.
 *
 * Bounded: skips files over UNREAD_SCAN_MAX_FILE_BYTES, opens at most
 * UNREAD_SCAN_MAX_FILES, and stops as soon as a file matches EVERY one of
 * the session's concern tokens (no later candidate could score higher).
 */
async function buildUnreadSiblingNote(
  workspace: string,
  editedPaths: readonly string[],
  hunkArgs: Record<string, unknown>,
): Promise<string | undefined> {
  const anchor = editedPaths[0];
  if (anchor === undefined) return undefined;
  const concernTokens = getConcernTokens(workspace);
  if (concernTokens.length === 0) return undefined;

  const hunkLines = editHunkLineCount(hunkArgs);
  const smallSingleFile = unreadNoteSpecificityEnabled()
    && editedPaths.length === 1
    && hunkLines !== undefined
    && hunkLines <= unreadNoteMaxHunkLines();
  const hunkIdentifiers = smallSingleFile ? specificIdentifiersFromEditArgs(hunkArgs) : [];
  // No identifier can satisfy rule B, so avoid paying for the family scan.
  if (smallSingleFile && hunkIdentifiers.length === 0) return undefined;

  const detectedRoot = projectRootOf(anchor, workspace);
  const familyRoot = detectedRoot !== "" ? detectedRoot : topDirOf(anchor);

  let candidates: ReturnType<typeof walkCodeFiles>;
  try {
    candidates = walkCodeFiles(workspace, familyRoot ? { subPath: familyRoot } : {});
  } catch {
    return undefined;
  }

  const alreadyRead = new Set(getReadPaths(workspace));
  for (const p of editedPaths) alreadyRead.add(p);

  let best: { path: string; count: number; tokens: string[] } | undefined;
  let scanned = 0;
  for (const file of candidates) {
    if (scanned >= UNREAD_SCAN_MAX_FILES) break;
    if (alreadyRead.has(file.relPath)) continue;

    let size: number;
    try {
      size = statSync(file.absPath).size;
    } catch {
      continue;
    }
    if (size > UNREAD_SCAN_MAX_FILE_BYTES) continue;
    scanned++;

    const text = await readFileSafe(file.relPath, workspace);
    if (text === null) continue;
    const lower = text.toLowerCase();
    const hitTokens = concernTokens.filter((t) => lower.includes(t));
    if (hitTokens.length < 2) continue;
    // Rule C suppresses a small single-file hunk unless rule B proves that
    // an identifier from that actual hunk also occurs in this flagged target.
    if (smallSingleFile && !hunkIdentifiers.some((token) => lower.includes(token.toLowerCase()))) continue;

    if (
      best === undefined ||
      hitTokens.length > best.count ||
      (hitTokens.length === best.count && file.relPath.length < best.path.length)
    ) {
      best = { path: file.relPath, count: hitTokens.length, tokens: hitTokens };
    }
    if (hitTokens.length === concernTokens.length) break; // can't score higher — stop early.
  }
  if (best === undefined) return undefined;

  const tokensPart = best.tokens.slice(0, 3);
  let note = `concern tokens (${tokensPart.join(", ")}) also hit UNREAD ${best.path} — check it before concluding`;
  if (note.length > UNREAD_NOTE_MAX_CHARS) note = note.slice(0, UNREAD_NOTE_MAX_CHARS - 1) + "…";
  return note;
}

// ---------------------------------------------------------------------------
// Feature 1: task_pack surfaces count as "read" too — a freshly-computed
// pack embeds real file content in each surface's `code` (omitted on a
// compact pack_unchanged response — see ReadCodeTaskPackSurface's doc
// comment in @tokenlighten/types), which IS a content-bearing read exactly
// like slice/full/skeleton/symbol/small_file/auto.
// ---------------------------------------------------------------------------
export function recordTaskPackSurfaceReads(workspace: string, result: unknown): void {
  type ReadSurface = { path?: string; code?: unknown };
  const pack = result as {
    surfaces?: ReadSurface[];
    concerns?: Array<{ evidence?: ReadSurface[] }>;
  } | undefined;
  const surfaces = [
    ...(Array.isArray(pack?.surfaces) ? pack.surfaces : []),
    ...(Array.isArray(pack?.concerns)
      ? pack.concerns.flatMap((concern) =>
          Array.isArray(concern.evidence) ? concern.evidence : [])
      : []),
  ];
  // V10-02: post_edit_readback — narrowest existing seam every task_pack
  // read-exit already funnels through (4 call sites, one function). Gated on
  // isTraceEnabled() so the getEditedPaths() lookup itself — not just the
  // eventual trace() call — costs nothing when TL_TRACE is off.
  const editedPaths = isTraceEnabled() ? new Set(getEditedPaths(workspace)) : undefined;
  for (const surface of surfaces) {
    if (
      surface &&
      typeof surface.path === "string" &&
      surface.code !== undefined
    ) {
      recordReadPath(workspace, surface.path);
      if (editedPaths?.has(surface.path)) {
        trace("post_edit_readback", { path: surface.path }, workspace);
      }
    }
  }
}

/**
 * Shared task-pack dispatcher post-processing: runtime fence registration,
 * candidate-list bookkeeping, the post-challenge revocation rewrite, the P0a
 * §6.1 canonical-decision fence, and the lean wire projection — in that order.
 *
 * Exported so a regression can drive the EXACT dispatcher exit (this is the
 * site where a `done`-phase contract restored from a captured pack used to
 * reach projectLeanExecutionContract and throw `unsupported task-pack
 * execution phase`).
 */
export function recordTaskPackExecution(
  workspace: string,
  query: string,
  result: Record<string, unknown>,
  contractScope?: TaskContractScope,
): void {
  const contractValue = result["execution_contract"];
  const contract = contractValue && typeof contractValue === "object"
    ? contractValue as TaskExecutionContract
    : undefined;
  // Runtime guards always receive the rich proof before the response is
  // projected. Lean mode changes wire residency, not server-side authority.
  const route = result["route"];

  // -------------------------------------------------------------------------
  // ORCHESTRATOR CONDITION ① (§3.4.1) — the sanctioned-zoom affordance,
  // RE-ANCHORED onto what this response actually emits.
  //
  // WHAT THIS REPLACES. Both former inputs are §3.4 E4 deletions:
  //   (1) `route.max_additional_tl_calls` — the budget. Deleted with `route`.
  //   (2) `surfaces[].remaining_ranges` — the handle set. `surfaces[]` itself
  //       collapses into `evidence[]` below, and `remaining_ranges` becomes
  //       `evidence[].remaining`.
  // Keeping either would leave the fence reading a field the wire no longer
  // carries, which §3.4.1 names precisely: it "restores the pack-advertises /
  // fence-refuses contradiction under new field names, with the 2026-08-13
  // forensics to redo".
  //
  // THE RULE, verbatim: "the set of calls a response sanctions is a function of
  // that response's own emitted affordances." So the sanction is computed from
  // `emittedEvidence` — the SAME array object this response ships below — and
  // from nothing else. `sanctionFromEvidence` takes no budget parameter,
  // because a separately-computed number is exactly what no longer exists.
  //
  // THE EXACT-SIGNATURE SANCTION IS GONE, and that loses no affordance. It only
  // ever fired when a surface shipped a CONFORMING `next_call` and the caller
  // replayed it byte-for-byte — a strict subset of "a window-shaped zoom
  // against a handle this response left partial", which is what Defect G added
  // the broader sanction for in the first place. One affordance, one sanction.
  // -------------------------------------------------------------------------
  // The compact `pack-unchanged` re-serve's surfaces are prior-held by
  // construction and say so nowhere; `packUnchangedPriorLabel` states it, which
  // is what keeps §2.1.1's answer floor and A.8's E-8 true on this response.
  const emittedEvidence = projectEvidence(
    result["surfaces"],
    packUnchangedPriorLabel(result),
  );
  const sanctionedZoom = sanctionFromEvidence(emittedEvidence);
  const disposition = recordExecutionContract(
    workspace,
    query,
    contract,
    undefined,
    sanctionedZoom,
  );
  const preparedHandleAdvisory = takePreparedHandleAdvisory(workspace);
  if (preparedHandleAdvisory !== undefined) result["advisory"] = preparedHandleAdvisory;
  if (disposition === "revoked" && contract !== undefined) {
    const terminalAction = contract.next_action === "answer" ? "answer" : "edit";
    // P0a §6.1 (2026-08-13): the rewrite below downgrades the CONTRACT to
    // discovery-with-sanctioned-budget. Before this wave it left `route`
    // untouched, so a revoked answer pack shipped route.action=
    // answer_from_handles alongside phase=discovery — the exact
    // route/contract contradiction §6.1 forbids. Make the re-scope call the
    // contract's own executable next_call (the prose already named it) and
    // project the route onto that same decision.
    const rescopeCall = {
      tool: "read_file" as const,
      arguments: {
        mode: "task_pack",
        query,
        taskEpoch: "new",
      },
    };
    // 2026-07-25 T13 forensics: this rewrite used to say "request-user-input"
    // / phase "awaiting-input" — a dead end that pushed the solver fully
    // native even though the revoked fence had actually UNGATED edits. Tell
    // the truth instead: after a challenge revocation the gate is open —
    // proceed with the intended terminal action directly, or re-scope with a
    // fresh task_pack (taskEpoch:"new").
    result["execution_contract"] = {
      version: 1,
      state: "needs-followup",
      readiness: "needs-followup",
      discovery_complete: false,
      next_action: terminalAction,
      max_additional_discovery_calls: 1,
      reason: "the readiness certificate was revoked by your challenge and the edit gate is now open; apply the intended change directly (edit_file with this pack's handles), or start a fresh task_pack with taskEpoch:\"new\" to re-scope",
      typestate: {
        phase: "discovery",
        allowed_actions: [terminalAction, "read", "search"],
        challenge_required_for: [],
      },
      next_call: rescopeCall,
      call_budget: {
        version: 2,
        policy: "expected-decision-change",
        normalized_turn_cost: contract.call_budget?.normalized_turn_cost ?? 0.18,
        expected_decision_change: 1,
        expected_value: 1,
        decision_threshold: contract.call_budget?.decision_threshold ?? 0.18,
        discovery_allowed: true,
        terminal_action: terminalAction,
        candidate_call: rescopeCall,
        reason: "the challenged proof was revoked; the terminal action is ungated and one re-scope discovery call is sanctioned",
      },
    } satisfies TaskExecutionContract;
    // The route is a projection of the SAME decision, never an independent
    // claim: a discovery-phase contract may not ship an answer/edit-from-
    // handles route. `inspect_handles` mirrors what the canonical normalizer
    // derives for a read_file next_call.
    if (route !== null && typeof route === "object") {
      const previousAction = (route as { action?: unknown }).action;
      if (previousAction === "answer_from_handles" || previousAction === "edit_from_handles") {
        result["route"] = {
          action: "inspect_handles",
          reason: "the readiness certificate was revoked by your challenge; act on the held handles or re-scope with taskEpoch:\"new\"",
          max_additional_tl_calls: 1,
        };
      }
    }
  }
  // 2026-07-19a candidate-pack brake: arm the tightened full-read budget while
  // this pack's candidate choice is pending; any other pack shape releases it.
  const routeAction = route && typeof route === "object"
    ? (route as { action?: unknown }).action
    : undefined;
  if (routeAction === "confirm_candidates" || result["coverage_reason"] === "candidate-list") {
    recordCandidateListPack(workspace);
  } else {
    clearCandidateListPack(workspace);
  }
  // -------------------------------------------------------------------------
  // P0a §6.1 SINGLE FENCE (2026-08-13).
  //
  // Every task-pack-shaped response leaves through here — initial packs, qref
  // re-packs, `pack_unchanged` / semantic-duplicate receipts, the byte-budget
  // fallback, AND the revocation rewrite immediately above — so this is the
  // one place that can guarantee route/execution_contract/continuation are
  // projections of ONE canonical decision. The in-build applications inside
  // dedupeTrimAndPersist stay: this fence is idempotent, so a coherent
  // response passes through byte-identical.
  // -------------------------------------------------------------------------
  const fence = enforceCanonicalTaskDecisionAtExit(result as unknown as TaskPackResult);
  if (fence.violations.length > 0) {
    trace("decision_invariant_repair", {
      violations: fence.violations,
      residual: fence.residual,
      route: (result["route"] as { action?: unknown } | undefined)?.action,
      phase: (result["execution_contract"] as TaskExecutionContract | undefined)?.typestate?.phase,
    }, workspace);
  }
  if (fence.residual.length > 0 && decisionInvariantStrictEnabled()) {
    throw new Error(
      `task-pack decision invariant survived repair: ${fence.residual.join(", ")}`,
    );
  }

  const effectiveContractValue = result["execution_contract"];
  const effectiveContract = effectiveContractValue && typeof effectiveContractValue === "object"
    ? effectiveContractValue as TaskExecutionContract
    : undefined;
  const alreadyExecuted = effectiveContract?.next_call;
  if (
    effectiveContract !== undefined
    && alreadyExecuted !== undefined
    && hasExecutedNext(
      workspace,
      normalizeContractLane(contractScope?.lane),
      alreadyExecuted.tool,
      alreadyExecuted.arguments as Record<string, unknown>,
    )
  ) {
    // The builder's early gate can be superseded by its later canonical
    // projection. Re-apply the exact consumed-result rule at the shared
    // producer exit so a successful next cannot reappear on the wire.
    //
    // A-F2 (2026-08-28): this used to be a THIRD hand-rolled copy of the
    // rewrite — one that tried no alternative axis, disclosed no gap, and then
    // FILTERED the suppressed call's query out of `missing[]`, deleting the
    // very obligation the pack had just lost the ability to discharge.
    // Requirements are monotone (§A-6(2)): the disclosure is permanent, and
    // suppression must yield progress or an explicit gap, never silence.
    repairSuppressedNextCall(
      workspace,
      normalizeContractLane(contractScope?.lane),
      result as unknown as TaskPackResult,
      query,
      alreadyExecuted,
    );
  }

  // -------------------------------------------------------------------------
  // protocol v1 §2.1 / D7: THE SINGLE DECISION, EMITTED ONCE.
  //
  // Derived HERE — after the fence has converged the projection and before the
  // lean contract is written — because this is the only point at which the
  // canonical verdict is final AND the full contract (certificate, obligations,
  // workspace marker, gaps) is still present. `deriveCanonicalTaskDecision` is
  // pure, and `enforceCanonicalTaskDecisionAtExit` above guarantees the result
  // it reads is coherent, so re-deriving here returns the verdict the fence
  // just settled on rather than a second opinion.
  //
  // No semantics move (§0.2): the same five verdicts, the same fence, the same
  // 15-rule oracle. What changes is that the wire carries the verdict ONCE
  // instead of projecting it into `route` + `next` + `continuation` +
  // `execution_contract.next_action` + `.readiness` + `.discovery_complete` +
  // `required_action` and then running an oracle to keep the seven agreeing.
  // The seven wire copies are deleted in `protocol/envelope.ts`.
  // -------------------------------------------------------------------------
  const canonical = effectiveContract !== undefined
    ? deriveCanonicalTaskDecision(result as unknown as TaskPackResult)
    : undefined;
  const decision = projectTaskDecision({
    result,
    contract: effectiveContract,
    canonicalKind: canonical?.kind,
    evidence: emittedEvidence,
    // R1: the SAME predicate the two no-repeat gates above ask, handed to the
    // one place `decision.next` is minted. The gates can only inspect and
    // repair `execution_contract.next_call`; the bundle re-pack, the
    // continuation's first call, a gap's named recovery and the served-evidence
    // zoom reach the wire without passing either of them, and a bundle next
    // outranks the repaired `next_call`. Binding it here is what makes the
    // consumed-fingerprint rule govern every carrier without a second gate.
    consumed: (call) => hasExecutedNext(
      workspace,
      normalizeContractLane(contractScope?.lane),
      call.tool,
      (call.arguments ?? {}) as Record<string, unknown>,
    ),
  });
  // -------------------------------------------------------------------------
  // DECISION-WIRE CONFORMANCE, at the same fence and on the same terms as the
  // canonical repair above (2026-08-20).
  //
  // `projectTaskDecision` now makes the one rule below STRUCTURALLY true — it
  // degrades a candidate-less `choose-candidate` rather than emitting it — so
  // this is a residual check in exactly the sense `fence.residual` is: it
  // should never fire, and its whole value is that CI hears about it if it
  // ever does. Strict mode is on under vitest and off in production, so a live
  // agent can never be handed an RPC error by a fence (`flags.ts`'s own
  // rationale for `TL_DECISION_INVARIANT_STRICT`), while a regression that
  // reopens the class fails the suite loudly.
  //
  // `projectTaskPackWire`'s second projector call is deliberately NOT fenced
  // here: its contract is "WIRE ONLY" — it registers no fence, arms no brake
  // and runs no repair, and adding one would be the §0.2 semantics change that
  // comment forbids. It calls the same projector, so it inherits the
  // structural guarantee regardless; only the CI alarm is scoped to this site.
  // -------------------------------------------------------------------------
  const decisionViolations = taskDecisionWireViolations(decision);
  if (decisionViolations.length > 0) {
    trace("decision_wire_conformance", {
      violations: decisionViolations,
      code: (decision as { code?: unknown } | undefined)?.code,
      coverage_reason: result["coverage_reason"],
      route: (result["route"] as { action?: unknown } | undefined)?.action,
      evidence: emittedEvidence.length,
    }, workspace);
    if (decisionInvariantStrictEnabled()) {
      throw new Error(`task-pack decision wire conformance: ${decisionViolations.join(", ")}`);
    }
  }

  // A.2.3: identity and replay token are two things, so two fields. `id` falls
  // back to the same `task-<sha16(profile\0query)>` derivation the certificate
  // uses (readCodeTaskPack.ts's `deterministicCertificate`), so a pack with no
  // certificate still reports the identity a later certified re-pack will
  // report — which is what makes "survives re-packs of the same task" true.
  const profile = result["task_profile"] === "answer"
    || (result["profile_binding"] as { selected?: unknown } | undefined)?.selected === "answer"
    ? "answer"
    : "generic";
  const task = withTaskHandle(projectTaskRef(
    result,
    effectiveContract,
    `task-${shaOfText(`${profile}\u0000${query}`).replace(/^sha256:/, "").slice(0, 16)}`,
  ), contractScope);
  const resolvedScope = contractScope === undefined
    ? undefined
    : bindTaskContractHandle(workspace, contractScope, task.id);

  // D10 (2026-08-14): `TL_LEAN_CONTRACT` is deleted. The lean projection is the
  // ONLY execution-contract shape that reaches the wire — the full internal
  // `TaskExecutionContract` is recorded and enforced in-process, never emitted.
  if (effectiveContract) {
    result["execution_contract"] = projectLeanExecutionContract(effectiveContract);
  }

  // A.5.1: `surfaces[]` collapses into `evidence[]`. The SAME array the
  // sanction above was computed from is the array that ships, so CONDITION ①'s
  // "a function of the response's own emitted affordances" is literally true
  // rather than merely intended.
  result["task"] = task;
  result["profile"] = profile;
  if (decision !== undefined) result["decision"] = decision;
  // P2(d) (2026-08-28 review-fix wave): was `decision?.kind === "discover" ?
  // decision.next : undefined` — registration only ever fired for a
  // `discover`-kind wire decision. `TaskDecision`'s own D-1 invariant
  // (packages/types/src/mcp/decision.ts) makes `next` representable ONLY on
  // `discover`, so that restriction was never a choice to relax on the WIRE
  // shape. But `effectiveContract.next_call` is a SEPARATE, internal field
  // that can be set regardless of what the wire decision ends up being —
  // an `await_input` pack can still carry a sanctioned zoom/re-scope call
  // internally (AGENTS.md: "await_input=>run a carried next first"), and an
  // `act.edit` pack's own sanctioned-zoom affordance is the same shape one
  // level down. Reading the internal contract field directly (never
  // `decision.next`, so D-1 is untouched) lets the executable-next scope
  // registry track those prescriptions too, so a later execution of them
  // still attributes its absence/hit proof back to the task that prescribed
  // it (P1-d), instead of resolving to `undefined` and recording nothing.
  const next = effectiveContract?.next_call as { tool?: unknown; arguments?: unknown } | undefined;
  if (
    resolvedScope !== undefined
    && typeof next?.tool === "string"
    && next.arguments !== null
    && typeof next.arguments === "object"
    && !Array.isArray(next.arguments)
  ) {
    registerExecutableNextScope(workspace, resolvedScope, {
      tool: next.tool,
      arguments: next.arguments as Record<string, unknown>,
    });
  }
  if ((decision?.kind === "act.answer" || decision?.kind === "act.edit")
    && effectiveContract?.readiness_certificate !== undefined) {
    const certificateId = effectiveContract.readiness_certificate.id;
    const ledgerSnapshot = taskContractLedgerSnapshot(workspace, resolvedScope);
    // -----------------------------------------------------------------------
    // A-F3: `discharged` WAS A LITERAL `true`.
    //
    // The emit funnel's entire ledger check rests on this field —
    // `isAuthenticatedProducerBinding` and `ledgerCertificateBindingValid` both
    // begin by reading it — and the producer simply asserted it while handing
    // over a snapshot it never inspected. Any act with a ledger of ANY shape,
    // undischarged obligations included, self-certified past the funnel. It is
    // computed from the snapshot now, which is the only thing that makes the
    // downstream check a check.
    //
    // A-7 puts DEMOTION in the producer layer, and it is already there: an
    // undischarged ledger fails `ledgerEstablished` in buildTaskExecutionContract,
    // so a well-formed producer never reaches this branch undischarged.
    // Withholding the binding is the fence for the case where it does — the
    // funnel then replaces the response with a refusal, the one sanctioned
    // funnel-side intervention, rather than shipping an unverifiable act.
    // -----------------------------------------------------------------------
    const discharged = ledgerSnapshot !== undefined
      && ledgerSnapshot.obligations.length > 0
      && ledgerSnapshot.obligations.every((obligation) => obligation.proof !== undefined);
    // -----------------------------------------------------------------------
    // F1 (2026-08-29, review-fix wave ①): A-F3's SECOND MISSING PREMISE.
    //
    // `discharged` above made the producer inspect the snapshot's PROOFS. It
    // still never asked the only other question the funnel asks: does this
    // snapshot BACK THIS certificate's ledger claim? `taskContractLedgerSnapshot`
    // is scope-keyed only — unlike `taskContractDischargeCertificate`, the
    // MINT-side read, which is additionally epoch-checked (`_sameTask`) — so the
    // ledger it returns can belong to a different epoch than the digest baked
    // into the id that was minted from it. The epoch reset inside
    // `recordTaskContract`, the pre-existing destination record
    // `bindTaskContractHandle` declines to overwrite, and a concurrent writer on
    // the same workspace all yield a fully-proved snapshot with a DIFFERENT
    // digest. The producer bound it blind, and `ledgerCertificateBindingValid`'s
    // closing `startsWith` then rejected the response.
    //
    // E-1's widened promotion is what made that reachable on real traffic (the
    // T07 `read_file mode=task_pack paths=["bench/fixtures/ledgerd"]` shape):
    // more packs reach `act.*`, so more packs carry a ledger-backed identity
    // into this branch. Under `TL_DECISION_INVARIANT_STRICT` it throws; in
    // production it became an unexplained `invalid-input` / `retry:"none"` dead
    // end — a refusal with nothing the caller can do about it.
    //
    // THE FENCE IS DEMOTION, NEVER A RELAXED CHECK. The A-7 funnel guard is
    // correct and is untouched. What changes is that the producer no longer
    // ASSERTS a ledger it cannot hand over: an id whose claim cannot be backed
    // loses the claim and ships as the legacy single-segment `ready-<proof16>`
    // identity — the same shape a non-proof-completion pack emits, which makes
    // no ledger assertion at all. The act itself was legitimately adjudicated
    // and still reaches the caller.
    //
    // Every carrier of that identity moves together, because they are compared
    // against each other downstream: `decisionWire.ts`'s `projectCertificate`
    // drops the certificate outright when `readiness_certificate.id` and
    // `typestate.certificate_id` disagree, and `session.ts`'s
    // `challengeCertificate` matches the caller-supplied `certificate_id`
    // against the installed fence's key — hence `rekeyExecutionFenceCertificate`,
    // since `recordExecutionContract` installed that fence far above, before the
    // task handle had resolved the ledger scope this check needs.
    // -----------------------------------------------------------------------
    const backsCertificate = ledgerSnapshot !== undefined
      && ledgerDigestBacksCertificateId(certificateId, ledgerSnapshot.digest);
    if (ledgerSnapshot !== undefined && discharged && backsCertificate) {
      bindLedgerCertificate(result, {
        certificateId,
        ledgerDigest: ledgerSnapshot.digest,
        ledgerSnapshot,
        discharged,
        lane: resolvedScope?.lane,
        taskHandle: task.id,
      });
    } else if (isLedgerBackedCertificateId(certificateId)) {
      const honestId = withoutLedgerClaim(certificateId);
      effectiveContract.readiness_certificate.id = honestId;
      if (effectiveContract.typestate.certificate_id === certificateId) {
        effectiveContract.typestate.certificate_id = honestId;
      }
      if (effectiveContract.semantic_closure?.closure_id === certificateId) {
        effectiveContract.semantic_closure.closure_id = honestId;
      }
      const lean = result["execution_contract"];
      if (lean !== null && typeof lean === "object"
        && (lean as { certificate?: unknown }).certificate === certificateId) {
        (lean as { certificate: string }).certificate = honestId;
      }
      decision.certificate.id = honestId;
      rekeyExecutionFenceCertificate(workspace, certificateId, honestId);
      trace("ledger_certificate_demoted", {
        from: certificateId,
        to: honestId,
        reason: ledgerSnapshot === undefined
          ? "no-ledger-at-scope"
          : discharged ? "digest-does-not-back-certificate" : "ledger-undischarged",
        lane: resolvedScope?.lane,
      }, workspace);
    }
  }
  result["evidence"] = emittedEvidence;
  delete result["surfaces"];
}

/**
 * A.5.1's required set, applied to the two task-pack-shaped responses that do
 * NOT go through `recordTaskPackExecution` (C2-3).
 *
 * WHICH TWO, AND WHY THEY ARE READ FAMILY. `buildArchiveTaskPack` (an archive
 * pack) and `search_files action=locate includeClosure:true` (which routes to
 * `buildTaskPack`) both emit a task pack. `Kind` names the PAYLOAD's family,
 * not the tool that was called — the same rule `envelope.ts` already applies to
 * a receipt served on a `search_files` call — so both are `read.task_pack` and
 * both owe A.5.1's `task` + `profile` + `decision` + `evidence`. Before this
 * they shipped `surfaces[]` and no decision at all.
 *
 * WIRE ONLY, DELIBERATELY. This does not register a fence, arm the candidate
 * brake, or run the canonical-decision repair — those are `recordTaskPackExecution`'s
 * runtime duties and neither of these two paths performed them before, so
 * adding them here would be a semantics change (§0.2) smuggled in behind a
 * shape fix. `projectTaskDecision` returns `undefined` without a contract, so a
 * pack that carries none reports no decision rather than a fabricated one.
 *
 * `familyDecision` (S2b) is that last sentence's remaining half. "No decision"
 * is honest against a FABRICATED one, but §4.3 requires the field and
 * `ReadTaskPackResult` types it non-optional, so a pack whose contract this
 * projector cannot read must supply the verdict its OWN builder derived rather
 * than omitting the member's discriminator. Only the archive path does — see
 * `archiveTaskDecision`, which projects it from the same `prepared` boolean
 * `route` and `execution_contract` come from. It is a FALLBACK, never an
 * override: a contract this projector CAN read still wins, so the canonical
 * projection remains the only source of truth wherever one exists.
 */
/**
 * PI-09 / deviation D-2: `task_handle` RIDES `TaskRef.id` rather than becoming a
 * top-level `CommonStateOutput` field, so the identity the agent already sees
 * is the identity it can hand back — no new response surface, no per-response
 * fixed cost, no second spelling of task identity to keep in sync.
 *
 * The projected fingerprint becomes the STORED identity and the opaque handle
 * becomes the WIRE identity. When no durable store is available (read-only
 * workspace, `TOKENLIGHTEN_STATE_STORE=off`, a call with no resolved
 * workspace), the fingerprint ships exactly as it did in v0.9 — degradation is
 * a smaller guarantee, never a wrong one.
 */
function withTaskHandle(task: TaskRef, contractScope?: TaskContractScope): TaskRef {
  const workspace = callWorkspace();
  if (workspace === undefined) return task;
  const handle = mintTaskHandle(workspace, {
    taskFingerprint: task.id,
    ...(task.replay !== undefined ? { replay: task.replay } : {}),
    coverage: task.coverage,
    ...(taskContractDigest(workspace, contractScope) !== undefined ? { ledgerDigest: taskContractDigest(workspace, contractScope) } : {}),
    mintedAtMs: Date.now(),
  });
  return handle === undefined ? task : { ...task, id: handle };
}

function projectTaskPackWire(
  result: Record<string, unknown>,
  query: string,
  familyDecision?: TaskDecision,
): void {
  const contractValue = result["execution_contract"];
  const contract = contractValue && typeof contractValue === "object"
    ? contractValue as TaskExecutionContract
    : undefined;
  const evidence = projectEvidence(result["surfaces"], packUnchangedPriorLabel(result));
  // `deriveCanonicalTaskDecision` reads `contract.typestate.phase` unguarded,
  // and an ARCHIVE pack's `execution_contract` is a different, typestate-less
  // shape. A pack with no typestate has no canonical verdict to project, which
  // is the honest answer as well as the safe one: `projectTaskDecision` then
  // emits no `decision` rather than a fabricated one.
  const canonical = contract !== undefined
      && contract.typestate !== null && typeof contract.typestate === "object"
    ? deriveCanonicalTaskDecision(result as unknown as TaskPackResult)
    : undefined;
  const decision = projectTaskDecision({
    result,
    contract,
    canonicalKind: canonical?.kind,
    evidence,
  }) ?? familyDecision;
  const profile = result["task_profile"] === "answer"
    || (result["profile_binding"] as { selected?: unknown } | undefined)?.selected === "answer"
    ? "answer"
    : "generic";
  result["task"] = withTaskHandle(projectTaskRef(
    result,
    contract,
    `task-${shaOfText(`${profile}\u0000${query}`).replace(/^sha256:/, "").slice(0, 16)}`,
  ));
  result["profile"] = profile;
  if (decision !== undefined) result["decision"] = decision;
  result["evidence"] = evidence;
  delete result["surfaces"];
}

/**
 * Verification manifest attachment (2026-07-25 harness-desertion forensics):
 * on fix tasks solvers hand-build verification harnesses and escape TL for
 * the test/mock working set. Delivery is PER EDITED FILE (2026-07-26: the
 * session one-shot starved files 2..n of a multi-file fix pack — measured
 * live on T05c, 2 of 3 edited files never saw their compile facts): the
 * manifest re-attaches whenever the edited set gains a file it has not
 * covered yet; surface BODIES still inline only once per session.
 * The section is entirely absent when nothing references the edited files.
 */
function buildVerificationBody(workspace: string, editArgs?: Record<string, unknown>): Record<string, unknown> | undefined {
  return buildVerificationBodyDetailed(workspace, editArgs).manifest;
}

/**
 * W9 (2026-08-22 create-terminal-proof): buildVerificationBody used to
 * collapse two different "nothing rides this response" reasons into the
 * same `undefined` — genuinely nothing computable (no test/mock/compile-fact
 * anywhere references the edited file(s), most commonly a brand-new file)
 * versus merely "already served this session, staying quiet" (the
 * unservedVerificationPaths dedup just below). Only the FIRST is something
 * the caller should be told about explicitly; the second is intentional
 * silence, not a gap. This split lets attachVerification attach an honest
 * `verification: {status:"not-applicable", reason}` on the first case only,
 * so an agent that just created a file (or edited one with no referencing
 * test) gets a definite "nothing to verify against" instead of inferring it
 * from the mere absence of a `verification` key — indistinguishable, from
 * the wire alone, from every other reason the key can be missing (dedup,
 * kit_unchanged, budget-omitted bodies all leave the key ABSENT or PRESENT
 * for unrelated reasons; see attachVerification's own comment).
 */
function buildVerificationBodyDetailed(
  workspace: string,
  editArgs?: Record<string, unknown>,
): { manifest: Record<string, unknown> | undefined; notApplicable: boolean } {
  const edited = getEditedPaths(workspace);
  if (edited.length === 0) return { manifest: undefined, notApplicable: false };
  // PI-09 close-out: `force_serve:true` re-serves the verification kit in
  // full. All three suppressions below — the per-path already-covered gate,
  // the consecutive `kit_unchanged` receipt, and the session-once body
  // inlining — are ledger claims about the caller's context, and the caller
  // has just said that context is gone. The kit is exactly the material an
  // agent needs to finish a verify step after a compaction, so withholding it
  // here is the most expensive place to be wrong.
  const forceServe = editArgs?.["force_serve"] === true;
  // Already served this exact edited set this session — stay silent. This is
  // NOT "not-applicable": a kit exists, the caller already has it.
  if (!forceServe && unservedVerificationPaths(workspace, edited).length === 0) {
    return { manifest: undefined, notApplicable: false };
  }
  // K2 threading (2026-08-01 verify-kit-diet): when the edit args are in hand,
  // mine the search/replace hunk text for the PRECISE identifiers this edit
  // touched — sharper than the manifest's edited-file-content proxy — so the
  // relevance gate drops zero-overlap kit surfaces (the measured T09
  // createApp.ts fetch) without guessing from whole-file tokens.
  const changedIdentifiers = editArgs !== undefined ? identifiersFromEditArgs(editArgs) : [];
  const manifest = buildVerificationManifest(workspace, edited, {
    // K3a: the edit-attachment path is where consecutive identical kits were
    // measured riding back-to-back responses — dedupe applies HERE only.
    dedupeConsecutive: !forceServe,
    ...(changedIdentifiers.length > 0 ? { changedIdentifiers } : {}),
  });
  // Mark the CURRENT set covered either way — a later edit adding a new file
  // re-qualifies via the unserved check above.
  markVerificationPathsServed(workspace, edited);
  // Genuinely nothing computable — no test/mock/compile-fact anywhere
  // references the edited file(s). Distinct from every dedup/budget reason
  // above and below: those all return a DEFINED manifest (kit_unchanged,
  // omitted-body surfaces); this is the one case with no manifest at all.
  if (manifest === undefined) return { manifest: undefined, notApplicable: true };
  // Pass 1 — session-once inlining, path-keyed in the shared served-surface
  // ledger (all three namespaces are workspace-relative file paths, and a body
  // served under any role is served). A body dropped here loses only `code`;
  // labelKitBodies below states WHY it is body-less, from that same ledger
  // AFTER every family has been walked — which is exactly why the labelling
  // cannot run per-family: one path can ride both as a role-mock surface
  // (body-less by design) and as a mock header served in this same response.
  const keepBody = <T extends { path: string; code?: string; body?: BodyMarker; content_completeness?: "partial" }>(
    entry: T,
  ): T | Omit<T, "code"> => (forceServe ? entry : dropServedBody(workspace, entry));
  const surfaces = manifest.surfaces.map(keepBody);
  const linkSet = manifest.link_set.map(keepBody);
  const harness = manifest.harness === undefined
    ? undefined
    : {
      ...manifest.harness,
      ...(manifest.harness.mock_headers !== undefined
        ? { mock_headers: manifest.harness.mock_headers.map(keepBody) }
        : {}),
    };
  return {
    manifest: labelKitBodies(workspace, {
      ...manifest,
      surfaces,
      link_set: linkSet,
      ...(harness !== undefined ? { harness } : {}),
    }),
    notApplicable: false,
  };
}

/**
 * Session-once body inlining for one kit entry: an already-served body loses
 * its `code` here (labelKitBodies re-labels the now-body-less entry).
 *
 * S1 (2026-08-07 kit-entry-dedupe) made the ledger CONTENT-keyed. Two things
 * follow. A file whose bytes changed since its serve is served again — the
 * path-only ledger used to label it "served-earlier" for bytes that had never
 * gone out. And a PARTIAL body (the harness-entry head) never enters the
 * ledger at all: a 50-line head is not the file, so it can never license a
 * whole-file "already in your context" claim on a later response.
 */
function dropServedBody<T extends { path: string; code?: string; body?: BodyMarker; content_completeness?: "partial" }>(
  workspace: string,
  entry: T,
): T | Omit<T, "code"> {
  if (entry.code === undefined) return entry;
  if (entry.content_completeness === "partial") return entry;
  // The UNION check, not just this kit's own ledger: a link-set source the
  // caller already read in full is held just as surely as one a kit inlined,
  // and link_set was 34.5% of measured verification bytes precisely because
  // its members are the paired sources the change's own reads already served.
  if (verificationBodyHeld(workspace, entry.path, entry.code) !== undefined) {
    const { code: _code, ...rest } = entry;
    return rest;
  }
  markVerificationSurfaceServed(workspace, entry.path, shaOfText(entry.code));
  return entry;
}

/**
 * S1: does the caller ALREADY hold this path's current whole-file bytes, and
 * which call put them there? One question, two ledgers, each recording only
 * bytes that genuinely left this server:
 *   - `verificationSurfacesServed` — what a verification kit inlined, and
 *   - `servedRangeLedger` — what a task_pack / slice / full / batched-handles
 *     read served (including the kit's own `verification.next_call`).
 * The range ledger is content-sha bound and books only the spans actually
 * displayed (elided comment blocks land in `unserved`), so full coverage of
 * [1..lines] means every byte is really held. An unhashable file (missing,
 * or past the scan cap) answers `undefined`: serve it, never claim it.
 */
function verificationBodyHeld(
  workspace: string,
  rel: string,
  knownContent?: string,
): { by?: string } | undefined {
  // `knownContent` is the exact body this kit would serve — identity taken from
  // it rather than from a re-read, so the question asked is always "do you
  // already hold THESE bytes?".
  const identity = knownContent !== undefined
    ? { sha: shaOfText(knownContent), lines: countLines(knownContent) }
    : verificationBodyIdentity(workspace, rel);
  if (identity === undefined) return undefined;
  if (isVerificationSurfaceServed(workspace, rel, identity.sha)) return {};
  if (identity.lines < 1) return undefined;
  const receipt = servedRangeReceipt(workspace, rel, identity.sha, 1, identity.lines, identity.lines);
  if (receipt === undefined) return undefined;
  // V10-02: repeated_range — a served-range ledger hit suppressed this
  // verification-kit body. Distinct seam from servedContentReceipt (a
  // different response shape) but the SAME underlying ledger-hit concept.
  trace("repeated_range", { mode: "verification", path: rel, complete: receipt.complete }, workspace);
  return receipt.served_by !== undefined ? { by: receipt.served_by } : {};
}

/**
 * One batched follow-up carries at most this many handles. The kit's own family
 * caps are 6 surfaces / 8 link_set / 6 mock headers, so a fully-omitted kit is
 * bounded well above this — the cap keeps the ONE call cheap and, because the
 * handles are emitted in kit spend priority, a truncated batch still fetches
 * the most expensive misses first.
 */
const VERIFICATION_NEXT_CALL_MAX_HANDLES = 8;

/**
 * S8: how many named-but-unserved paths may earn a handle on one kit. Small on
 * purpose — this list exists to close an escape, not to become a second kit.
 * The need order in `namedKitPaths` puts the build system first, so a truncated
 * list still carries the path an agent would otherwise shell out to find.
 */
const VERIFICATION_NAMED_PATHS_MAX = 4;

/**
 * S8 (2026-08-07): every kit field that NAMES a repo path but carries neither
 * a body nor a handle, in need order. Named-but-unserved was 20 of 31 measured
 * arm-A native-IO escapes (2026-07-31): a file the kit says matters, with no
 * served way to open it, is a `cat`. compile_facts.missing_includes got handles
 * in that wave; these are the remaining path-naming fields.
 */
function namedKitPaths(kit: Record<string, unknown>): Array<{ path: string; named_by: string }> {
  const out: Array<{ path: string; named_by: string }> = [];
  const push = (value: unknown, named_by: string): void => {
    if (typeof value !== "string") return;
    // recipe refs are spelled `path:line` and `path:line#SYMBOL`.
    const rel = value.replace(/\\/g, "/").split("#")[0]!.replace(/:\d+$/, "").trim();
    // A command ("npm test", "clang++ -std=c++17 ...") is not a path. Anything
    // that survives still has to resolve to a readable file before it earns a
    // handle — the caller checks that against the workspace.
    if (rel.length === 0 || /\s/.test(rel)) return;
    out.push({ path: rel, named_by });
  };
  const toolchain = kit["toolchain"];
  if (toolchain !== null && typeof toolchain === "object") {
    push((toolchain as Record<string, unknown>)["build_entry"], "toolchain.build_entry");
  }
  const harness = kit["harness"];
  if (harness !== null && typeof harness === "object") {
    const command = (harness as Record<string, unknown>)["build_command"];
    if (command !== null && typeof command === "object") {
      push((command as Record<string, unknown>)["source"], "harness.build_command.source");
    }
  }
  const recipe = kit["recipe"];
  if (recipe !== null && typeof recipe === "object") {
    const fields = recipe as Record<string, unknown>;
    for (const field of ["compile_targets", "assertion_refs", "contract_refs", "mock_controls"] as const) {
      for (const value of Array.isArray(fields[field]) ? (fields[field] as unknown[]) : []) {
        push(value, `recipe.${field}`);
      }
    }
  }
  return out;
}

/**
 * Label one body-less kit entry from the served ledger, collecting the handles
 * of the never-served ones.
 */
function labelKitEntry(
  workspace: string,
  raw: unknown,
  collect: (handle: string) => void,
): unknown {
  if (raw === null || typeof raw !== "object") return raw;
  const entry = raw as Record<string, unknown>;
  if (typeof entry["code"] === "string") return entry;
  const rel = entry["path"];
  if (typeof rel !== "string") return entry;
  // Served earlier: the body IS in the agent's context. Saying "omitted" here
  // (the pre-2026-07-31 behavior) meant the exact OPPOSITE of the truth.
  const held = verificationBodyHeld(workspace, rel);
  if (held !== undefined) {
    return {
      ...entry,
      body: "served-earlier" satisfies BodyMarker,
      // Provenance, not a new read: name the call that put the bytes on the
      // wire so "already in your context" is checkable rather than asserted.
      ...(held.by !== undefined ? { served_by: held.by } : {}),
    };
  }
  const handle = entry["handle"];
  if (typeof handle === "string") collect(handle);
  return { ...entry, body: "omitted" satisfies BodyMarker };
}

/**
 * State WHY each body-less kit entry has no body, and — the 2026-07-31
 * verify-kit-gap fix — attach the machine-executable call that closes the gap.
 *
 * 20 of 31 arm-A native-IO escapes in the 2026-07-31 run were post-edit harness
 * building: the kit rode 6 times, and every file the solver then `cat`ed was
 * one whose body was `"omitted"` (hal_mock.h 9848 B, test_mavlink.cpp 11784 B,
 * os_mutex.c 7223 B, quat.cpp 6108 B). The note ALREADY said "slice it via its
 * handle" and not one solver did — passive prose does not convert, while every
 * response that carried a concrete `next_call` kept solvers on rails. So the
 * fetch is emitted as a call, not as advice, and batched into ONE turn.
 */
function labelKitBodies(workspace: string, kit: Record<string, unknown>): Record<string, unknown> {
  const mockHandles: string[] = [];
  const linkHandles: string[] = [];
  const surfaceHandles: string[] = [];
  const mapFamily = (raw: unknown, sink: string[]): unknown[] =>
    (Array.isArray(raw) ? raw : []).map((entry) => labelKitEntry(workspace, entry, (h) => sink.push(h)));

  const out: Record<string, unknown> = { ...kit };
  out["surfaces"] = mapFamily(kit["surfaces"], surfaceHandles);
  out["link_set"] = mapFamily(kit["link_set"], linkHandles);
  // compile_facts.missing_includes were plain path strings — named but
  // unreachable by any single call, so solvers spliced exactly those headers
  // natively (2026-07-31 escapefix-3, T05c). Mint a handle per never-served
  // path and let the SAME batched next_call serve them.
  const includeHandles: string[] = [];
  if (Array.isArray(kit["compile_facts"])) {
    out["compile_facts"] = (kit["compile_facts"] as unknown[]).map((raw) => {
      if (raw === null || typeof raw !== "object") return raw;
      const fact = raw as Record<string, unknown>;
      const missing = Array.isArray(fact["missing_includes"]) ? fact["missing_includes"] : [];
      const decorated: Array<{ path: string; handle: string }> = [];
      for (const rel of missing) {
        if (typeof rel !== "string" || rel.length === 0) continue;
        // S1: the union check — a header whose bytes the caller already holds
        // (kit inline OR an earlier read) needs no handle and no next_call slot.
        if (verificationBodyHeld(workspace, rel) !== undefined) continue;
        const handle = handleTable.upsert({ kind: "file", path: rel, workspaceRoot: workspace }).id;
        decorated.push({ path: rel, handle });
        includeHandles.push(handle);
      }
      return decorated.length > 0 ? { ...fact, missing_include_handles: decorated } : fact;
    });
  }
  const harness = kit["harness"];
  if (harness !== null && typeof harness === "object") {
    const withMocks = { ...(harness as Record<string, unknown>) };
    if (Array.isArray(withMocks["mock_headers"])) {
      withMocks["mock_headers"] = mapFamily(withMocks["mock_headers"], mockHandles);
    }
    out["harness"] = withMocks;
  }

  // S8: mint a handle for every path this kit merely NAMES, and route it into
  // the SAME batched next_call. Runs after every body-bearing family so a path
  // that already rides one is never duplicated here.
  const namedHandles: string[] = [];
  const reachable = new Set<string>();
  for (const family of [out["surfaces"], out["link_set"], out["compile_facts"], (out["harness"] as Record<string, unknown> | undefined)?.["mock_headers"]]) {
    for (const raw of Array.isArray(family) ? family : []) {
      const named = (raw as Record<string, unknown> | null)?.["path"];
      if (typeof named === "string") reachable.add(named);
    }
  }
  const namedPaths: Array<{ path: string; handle: string; named_by: string }> = [];
  for (const candidate of namedKitPaths(kit)) {
    if (namedPaths.length >= VERIFICATION_NAMED_PATHS_MAX) break;
    if (reachable.has(candidate.path)) continue;
    reachable.add(candidate.path);
    // Not a readable workspace file ("synthesized", a directory, a stale ref)
    // => no handle: a handle that resolves to nothing is worse than silence.
    if (verificationBodyIdentity(workspace, candidate.path) === undefined) continue;
    // Already in the caller's context => naming it is enough; do not spend a
    // next_call slot re-serving bytes it holds.
    if (verificationBodyHeld(workspace, candidate.path) !== undefined) continue;
    const handle = handleTable.upsert({ kind: "file", path: candidate.path, workspaceRoot: workspace }).id;
    namedPaths.push({ path: candidate.path, handle, named_by: candidate.named_by });
    namedHandles.push(handle);
  }
  if (namedPaths.length > 0) out["named_paths"] = namedPaths;

  // Kit SPEND priority is the batch order: mock headers (no cheaper source),
  // then link_set (already sources-before-paired-headers), then the
  // missing-include headers a standalone compile needs, then surfaces.
  // Dedup keeps the highest-priority occurrence of a shared handle.
  const batched: string[] = [];
  for (const handle of [...mockHandles, ...linkHandles, ...includeHandles, ...namedHandles, ...surfaceHandles]) {
    if (batched.includes(handle)) continue;
    batched.push(handle);
    if (batched.length >= VERIFICATION_NEXT_CALL_MAX_HANDLES) break;
  }
  if (batched.length > 0) {
    out["next_call"] = {
      tool: "read_file",
      arguments: { handles: batched },
      note: "one call serves every body-less entry below",
    };
  }
  return out;
}

export function attachVerificationAdvisory(
  result: Record<string, unknown>,
  manifest: { toolchain?: { deps_installed?: boolean; verify_note?: string } },
): Record<string, unknown> {
  const verifyNote = verificationDependencyNote(manifest);
  return {
    ...result,
    verification: manifest,
    ...(verifyNote !== undefined ? { verify_note: verifyNote } : {}),
  };
}

/**
 * W9 (2026-08-22 create-terminal-proof): true only for a successful CREATE
 * dispatch response — `read_back` and numeric `total_lines` are set
 * unconditionally together, exactly once, by server.ts's create branch
 * (createFile dispatch) and nowhere else. Used only to word the
 * not-applicable reason below; attachAppliedReadback's own total_lines
 * fallback does not depend on this helper.
 */
function isCreateDispatchResult(result: Record<string, unknown>): boolean {
  return result["read_back"] !== undefined && typeof result["total_lines"] === "number";
}

function verificationNotApplicableReason(result: Record<string, unknown>): string {
  return isCreateDispatchResult(result)
    ? "new file — no test/mock references it"
    : "no referencing test, mock, or compile fact";
}

function attachVerification(result: Record<string, unknown>, workspace: string, editArgs?: Record<string, unknown>): Record<string, unknown> {
  try {
    if ((result as { ok?: boolean }).ok === false) return result;
    const { manifest, notApplicable } = buildVerificationBodyDetailed(workspace, editArgs);
    if (manifest !== undefined) return attachVerificationAdvisory(result, manifest);
    // W9: fires ONLY when neither a verification kit NOR a closure check
    // landed on this response. attachClosure always runs before this
    // (finishEdit calls it first), so result["closure"] already tells us
    // whether it had something to say — never overridden here. Never fires
    // on dedup/budget silence: notApplicable is false in both of those.
    if (notApplicable && result["closure"] === undefined) {
      return {
        ...result,
        verification: { status: "not-applicable" as const, reason: verificationNotApplicableReason(result) },
      };
    }
    return result;
  } catch {
    return result;
  }
}

/** mode=closure variant: first call serves bodies, later calls handles-only. */
function withVerificationSection(body: Record<string, unknown>, workspace: string): Record<string, unknown> {
  try {
    const fresh = buildVerificationBody(workspace);
    if (fresh !== undefined) return { ...body, verification: fresh };
    const manifest = buildVerificationManifest(workspace, getEditedPaths(workspace));
    if (manifest === undefined) return body;
    // No body rides a re-serve: keep every handle, drop every body, and let
    // labelKitBodies say which of the two body-less MEANINGS applies from the
    // served ledger. Marking the whole kit body:"omitted" here (the old
    // behavior) told the agent nothing had been served when in fact most of it
    // already sat in its context — and hid the entries that truly never were.
    const stripBody = <T extends { code?: string }>(entry: T): Omit<T, "code"> => {
      const { code: _code, ...rest } = entry;
      return rest;
    };
    const reserved: Record<string, unknown> = {
      ...manifest,
      surfaces: manifest.surfaces.map(stripBody),
      link_set: manifest.link_set.map(stripBody),
      ...(manifest.harness !== undefined
        ? {
          harness: {
            ...manifest.harness,
            ...(manifest.harness.mock_headers !== undefined
              ? { mock_headers: manifest.harness.mock_headers.map(stripBody) }
              : {}),
          },
        }
        : {}),
      note: "verification working set — no body rides this response; every entry carries a handle and next_call fetches the omitted ones in one call",
    };
    return { ...body, verification: labelKitBodies(workspace, reserved) };
  } catch {
    return body;
  }
}

const APPLIED_CONTEXT_LINES = 8;
const APPLIED_ENTRY_CAP_BYTES = 2048;
const APPLIED_TOTAL_CAP_BYTES = 8192;
const APPLIED_MAX_ENTRIES = 6;

function braceDelta(search: string, replace: string): number {
  const opens = (s: string) => (s.match(/{/g) ?? []).length;
  const closes = (s: string) => (s.match(/}/g) ?? []).length;
  return (opens(replace) - opens(search)) - (closes(replace) - closes(search));
}

/** Hunks keyed by explicit entry path; path-less (handle-scoped) hunks key "". */
/**
 * K2 threading (2026-08-01 verify-kit-diet): identifier tokens mined from the
 * edit call's own search/replace hunk text — the exact code this edit touched.
 * Feeds buildVerificationManifest's relevance gate (options.changedIdentifiers).
 *
 * K2 tokenizer alignment (2026-08-22): reuses verificationPack.ts's own
 * identifierTokens instead of a separate ad-hoc regex (length>=3, no
 * stopwords). The two tokenizers disagreeing meant a hunk touching only
 * short/stopword text (e.g. a 3-char method name plus its `public`/`return`
 * scaffolding) could mine a set that activated the relevance gate with
 * tokens the kit side's OWN content scanner can never produce — guaranteeing
 * zero overlap and dropping a real referencing test regardless of how
 * plainly it exercised the edit. Reusing identifierTokens closes the
 * mismatch by construction. Exported for verificationPack.spec.ts, which
 * reproduces the asymmetry directly against this function feeding
 * buildVerificationManifest's changedIdentifiers.
 */
export function identifiersFromEditArgs(args: Record<string, unknown>): string[] {
  const out = new Set<string>();
  for (const hunks of editHunksByPath(args).values()) {
    for (const hunk of hunks) {
      for (const text of [hunk.search, hunk.replace]) {
        if (typeof text !== "string") continue;
        for (const tok of identifierTokens(text)) out.add(tok);
      }
    }
  }
  return [...out];
}

function editHunksByPath(args: Record<string, unknown>): Map<string, Array<{ search?: string; replace?: string }>> {
  const map = new Map<string, Array<{ search?: string; replace?: string }>>();
  const push = (p: string, h: { search?: string; replace?: string }) => {
    const list = map.get(p);
    if (list === undefined) map.set(p, [h]);
    else list.push(h);
  };
  const edits = args["edits"];
  if (Array.isArray(edits)) {
    for (const e of edits) {
      if (e === null || typeof e !== "object") continue;
      const entry = e as { path?: unknown; search?: unknown; replace?: unknown };
      push(typeof entry.path === "string" ? entry.path : "", {
        ...(typeof entry.search === "string" ? { search: entry.search } : {}),
        ...(typeof entry.replace === "string" ? { replace: entry.replace } : {}),
      });
    }
  } else if (typeof args["search"] === "string" && typeof args["replace"] === "string") {
    push("", { search: args["search"] as string, replace: args["replace"] as string });
  }
  return map;
}

/**
 * G1 read-back (2026-07-26 desertion forensics): 25 "read back what I just
 * changed" native escapes + 11 grep-brace-count turns happened because an
 * edit success carried zero post-edit evidence. Serve the applied region
 * (±8 lines, from disk — the authoritative post-write state) and the hunk
 * brace budget on the success response itself.
 */
async function attachAppliedReadback(
  result: Record<string, unknown>,
  args: Record<string, unknown>,
  workspace: string,
): Promise<Record<string, unknown>> {
  try {
    const single = typeof (result as { path?: unknown }).path === "string"
      ? [{
          path: (result as { path: string }).path,
          lines: (result as { lines?: unknown }).lines,
          total_lines: (result as { total_lines?: unknown }).total_lines,
        }]
      : [];
    const files = Array.isArray((result as { files?: unknown }).files)
      ? ((result as { files: Array<{ path?: unknown; lines?: unknown; total_lines?: unknown }> }).files)
      : single;
    if (files.length === 0) return result;
    const hunks = editHunksByPath(args);
    const distinctPaths = new Set(files.map((f) => f.path));
    const applied: Array<Record<string, unknown>> = [];
    let total = 0;
    const contentCache = new Map<string, string[] | null>();
    let wholeFileEntries = 0;
    for (const f of files.slice(0, APPLIED_MAX_ENTRIES)) {
      if (typeof f.path !== "string") continue;
      // Terminal proof for create (2026-08-22): a create carries no edited
      // span — the whole file is new, so createFile's dispatch reports
      // `total_lines` instead of `lines` (editFamily.ts's editedRows already
      // normalizes this same asymmetry for the wire `range`). Treat it the
      // same way here so a create earns the SAME slice_sha/head/applied_note
      // terminal proof a search/replace edit already gets, instead of the
      // caller re-reading its own just-written bytes to confirm them.
      const linesSpec = typeof f.lines === "string"
        ? f.lines
        : typeof f.total_lines === "number"
          ? `1-${Math.max(1, f.total_lines)}`
          : undefined;
      if (linesSpec === undefined) continue;
      const m = linesSpec.match(/^(\d+)(?:-(\d+))?$/);
      if (m === null) continue;
      const start = parseInt(m[1]!, 10);
      const end = m[2] !== undefined ? parseInt(m[2], 10) : start;
      let lines = contentCache.get(f.path);
      if (lines === undefined) {
        try {
          lines = readFileSync(path.join(workspace, f.path), "utf8").split("\n");
        } catch {
          lines = null;
        }
        contentCache.set(f.path, lines);
      }
      if (lines === null) continue;
      // A create (total_lines, no `lines` span) IS the whole file: no ±context
      // and no enclosing-symbol upgrade apply, and the window must not run
      // past total_lines onto the phantom "" that `.split("\n")` yields after
      // a final newline (editFamily.spec A.5.11 pins `range:"1-1"` for a
      // one-line create; the old synthesized entry already said so).
      const wholeFile = typeof f.lines !== "string";
      let from = wholeFile ? 1 : Math.max(1, start - APPLIED_CONTEXT_LINES);
      let to = wholeFile ? Math.min(lines.length, end) : Math.min(lines.length, end + APPLIED_CONTEXT_LINES);
      if (to < from) continue;
      // Enclosing-symbol upgrade (2026-07-26 run-A T13 relapse): a hunk inside
      // a function larger than the ±8 window forced a native sed of the whole
      // function body. Serve the smallest enclosing symbol instead when it
      // fits the entry cap; when it does not, NAME it with its range so one
      // handle re-slice replaces the native read.
      let enclosing: { symbol: string; range: string } | undefined;
      try {
        if (wholeFile) throw new Error("whole-file entry: no enclosing-symbol upgrade");
        const symbols = await extractSymbolsFromFile(lines.join("\n"), f.path, 256);
        let best: { name: string; s: number; e: number } | undefined;
        for (const sym of symbols) {
          const sm = sym.range.match(/^(\d+)-(\d+)$/);
          if (sm === null) continue;
          const s = parseInt(sm[1]!, 10);
          const e = parseInt(sm[2]!, 10);
          if (s <= start && end <= e && (best === undefined || e - s < best.e - best.s)) {
            best = { name: sym.name, s, e };
          }
        }
        if (best !== undefined && (best.s < from || best.e > to)) {
          const symBytes = Buffer.byteLength(lines.slice(best.s - 1, best.e).join("\n"), "utf8");
          if (symBytes <= APPLIED_ENTRY_CAP_BYTES) {
            from = best.s;
            to = best.e;
          } else {
            enclosing = { symbol: best.name, range: `${best.s}-${best.e}` };
          }
        }
      } catch {
        // regex scan failed — the ±8 window still serves.
      }
      const window = lines.slice(from - 1, to);
      const kept: string[] = [];
      let bytes = 0;
      for (const ln of window) {
        bytes += Buffer.byteLength(ln, "utf8") + 1;
        if (bytes > APPLIED_ENTRY_CAP_BYTES) break;
        kept.push(ln);
      }
      const code = kept.join("\n");
      const entryBytes = Buffer.byteLength(code, "utf8");
      if (entryBytes === 0 || total + entryBytes > APPLIED_TOTAL_CAP_BYTES) continue;
      total += entryBytes;
      const ownHunks = [
        ...(hunks.get(f.path) ?? []),
        ...(distinctPaths.size === 1 ? hunks.get("") ?? [] : []),
      ];
      const deltaKnown = ownHunks.length > 0
        && ownHunks.every((h) => typeof h.search === "string" && typeof h.replace === "string");
      const delta = deltaKnown
        ? ownHunks.reduce((s, h) => s + braceDelta(h.search!, h.replace!), 0)
        : undefined;
      if (wholeFile) {
        // A create's content is what the caller just sent: the top-level
        // sha/bytes/total_lines already prove it, so the entry carries no
        // slice echo (no code → editFamily adds no slice_sha/head) — the
        // terminal signal is the applied_note below (Phase 5 compactness:
        // writeResponseSize.spec CREATE_CORE_CAP).
        wholeFileEntries += 1;
        applied.push({ path: f.path, range: `${from}-${to}` });
        continue;
      }
      applied.push({
        path: f.path,
        range: `${from}-${to}`,
        code,
        ...(delta !== undefined ? { brace_delta: delta } : {}),
        ...(enclosing !== undefined ? { enclosing_symbol: enclosing } : {}),
      });
    }
    if (applied.length === 0) return result;
    return {
      ...result,
      applied,
      // B1 (v0.12, compact edit receipt): shortened to a minimal honest
      // pointer — the mechanics these used to spell out (context-window
      // choice, brace_delta/enclosing_symbol interpretation) move to the
      // guide (residency amplification 8.578x makes every response byte
      // expensive across the rest of the session). Emission condition and
      // field identity are unchanged; only the prose shrank.
      applied_note: wholeFileEntries === applied.length
        ? "post-edit disk state = content sent — no follow-up read needed"
        : "post-edit disk state — no follow-up read needed",
    };
  } catch {
    return result;
  }
}


/**
 * Elision-marker disambiguation (2026-07-25 T03 forensics): a solver read the
 * inline "doc elided L..-.." markers as TRUNCATION and re-fetched the same
 * range twice chasing "missing" content. Say explicitly that markers replace
 * comments only.
 */
function elisionMarkerNote(content: string): string | undefined {
  const count = (content.match(/(?:\/\*|#)\s*doc elided L\d+/g) ?? []).length;
  if (count === 0) return undefined;
  return `${count} 'doc elided' marker(s) replace COMMENT blocks only — code lines are complete, nothing is truncated; pass comments:"keep" to see them`;
}

/**
 * Served-hit annotation (2026-07-25 T03 forensics): a solver ran four
 * searches for tokens inside a file whose FULL text it had been served two
 * calls earlier. Mark hits in already-served files so the next probe is a
 * context check, not a re-read.
 *
 * L2 (2026-08-08 find-honesty): the annotation alone was measured to be
 * ignored 6/6 in one cell, so the whole decision — annotate, note, or escalate
 * a REPEATED all-served find into the terminal-style protocol — now lives in
 * features/search/find/servedFindEscalation.ts. See that module's doc for the
 * state machine and for why this is not a second discovery brake. This wrapper
 * keeps the historical call shape at the two find dispatch sites.
 */
function annotateServedFindHits(
  response: object,
  workspace: string,
  args: Record<string, unknown>,
): ServedFindOutcome {
  // PI-09 close-out: `force_serve` is honoured INSIDE applyServedFindProtocol,
  // not here — that module owns the whole annotate/note/escalate decision, and
  // a bypass in this wrapper would be one case of it made where the module's
  // own tests cannot see it.
  return applyServedFindProtocol(
    response,
    workspace,
    args,
    getExecutionFence(workspace)?.certificateId,
  );
}

/**
 * WS-P3 (DESIGN-v0.9 §6, "zero-content turns") checkless-`mode=closure`
 * content: a compact session-activity summary substituted for the old bare
 * ceremony response whenever there is nothing open to report (no pack ever
 * registered a check, or every registered check is now satisfied — see the
 * `mode === "closure"` dispatch above).
 *
 * Built ONLY from data the session/closure ledger already tracks — no new
 * counter is introduced for this. `getEditedPaths` is the SAME ledger
 * attachClosure/closureTracking.ts's own TL-edited-paths scan reads (a
 * successful edit_code write records its path there regardless of whether a
 * pack/check was ever active), so it is the one existing signal that answers
 * "what did this session actually edit" without touching session.ts.
 *
 * `edits` is the FULL edited-file count (not capped); `files` is the same
 * list capped to 8 entries for display — mirrors the ≤8/≤140ch caps
 * closureTracking.ts's own `open` listing already uses. NOTE (known, bounded
 * gap — see closureMode.spec.ts's "counts native (git-detected) edits"
 * scenario): a check satisfied purely via a NATIVE (non-edit_code) write that
 * `computeClosureState`'s git-detected scan sees is never recorded into this
 * ledger, so `edits`/`files` can under-report relative to `checksClosed` in
 * that case — `checksClosed` itself is unaffected (it comes from the
 * verified check count, not this ledger).
 */
function closureSessionSummary(workspace: string, checksClosed: number): Record<string, unknown> {
  const editedPaths = getEditedPaths(workspace);
  return {
    edits: editedPaths.length,
    files: editedPaths.slice(0, 8),
    checks_closed: checksClosed,
    checks_open: 0,
  };
}

// ---------------------------------------------------------------------------
// explore action=tree — compact file inventory. The implementation now lives
// in tools/exploreTree.ts (buildCompactTree); the inline copy that used to sit
// here — buildTreeFromFiles/renderTreeLines/buildExploreTree plus its inline
// TREE_CAP_BYTES/TREE_DEFAULT_DEPTH and the O(n^2) pop-and-rejoin cap trim —
// was removed (G3). Dispatch goes straight through buildCompactTree.
// ---------------------------------------------------------------------------

// D11: the CANON rewrite table (read_code -> read_file, edit_code ->
// edit_file, explore -> search_files) is DELETED along with the three renamed
// alias entries it served. Nothing is folded before the switch any more, so
// `canonical` is simply the caller's raw name and those three names reach the
// same unknown-tool refusal as any other stranger.

/**
 * The original callTool body, unchanged: canonical tool name in, wire result
 * out. Split out so callTool (below) can wrap it with the Fix 3 cwd
 * auto-correction pre/post-processing without touching a single line of this
 * switch — every case here is exactly as it was before that fix.
 */
/**
 * PI-09: validate the optional explicit-state REQUEST arguments —
 * `task_handle`, its `expected_state_version` CAS guard, and `force_serve`.
 *
 * Returns null when the argument is absent (the overwhelmingly common case —
 * every legacy caller, and every first call of a task) or when the handle is
 * authentic, in-lifetime, in-workspace and still backed by live state. Anything
 * else is a structured refusal with an EXECUTABLE recovery, because the one
 * outcome PI-09 forbids outright is silently continuing against the wrong
 * state ("暗黙のprocess memoryから「たぶん同じtask」と推測しない", item 12).
 *
 * REFUSAL CODE REUSE, deliberately. `Refusal.code` is a CLOSED enum frozen by
 * Protocol v1 §A.7.1, and this wave adds no wire kinds and no codes — so the
 * six distinct causes the store layer separates (`invalid`, `wrong-purpose`,
 * `expired`, `stale`, `unknown`, `store-unavailable`) all ride the existing
 * `handle-unknown`, and `wrong-workspace` rides the existing
 * `handle-workspace-mismatch`. The CAUSE is never lost: it is named in `hint`,
 * which is what the agent reads. Promoting any of them to its own code is a
 * snapshot + classifier change for a later wave, not a silent one here.
 */
function taskHandleRefusal(args: Record<string, unknown>, workspace: string): Record<string, unknown> | null {
  // PI-09 close-out: `force_serve` is a BOOLEAN, and a non-boolean spelling is
  // refused rather than coerced. Coercion here has a specific hazard: every
  // non-`true` value would read as "withhold", i.e. a caller that mis-typed
  // the argument it sent BECAUSE it lost its context would silently be denied
  // the bytes it asked for. Loud is the only safe direction.
  const forceServeArg = args["force_serve"];
  if (forceServeArg !== undefined && typeof forceServeArg !== "boolean") {
    return {
      ok: false,
      reason: "invalid-input",
      field: "force_serve",
      detail: "force_serve must be true or false — it is the explicit \"I lost my context, send the bodies again\" switch",
      next: "re-issue this exact call with force_serve:true, or omit it",
    };
  }
  const token = args["task_handle"];
  if (token === undefined) {
    // PI-09 close-out: `expected_state_version` is a PRECONDITION on the state
    // a `task_handle` names. Alone it names nothing, and an ignored
    // precondition is worse than an absent one — the caller believes a guard
    // ran. Refused, never dropped (§1.3.1's own words: "a dropped argument
    // changes what the call does").
    if (args["expected_state_version"] !== undefined) {
      return {
        ok: false,
        reason: "invalid-input",
        field: "expected_state_version",
        detail: "expected_state_version guards a task_handle's state and is meaningless without one — send both, or neither",
        next: canonicalToolCall("read_file", { mode: "task_pack", query: "<restate the request verbatim>", taskEpoch: "new" }),
      };
    }
    return null;
  }
  if (typeof token !== "string" || token === "") {
    return {
      ok: false,
      reason: "invalid-input",
      field: "task_handle",
      detail: "task_handle must be the opaque string a prior task_pack returned as task.id",
      next: canonicalToolCall("read_file", { mode: "task_pack", query: "<restate the request verbatim>", taskEpoch: "new" }),
    };
  }
  const freshPack = canonicalToolCall("read_file", { mode: "task_pack", query: "<restate the request verbatim>", taskEpoch: "new" });

  const resolved = resolveTaskHandle(token, workspace);
  if (resolved.ok) {
    // PI-09 close-out: the CAS guard, checked only once the handle itself is
    // proven authentic/in-workspace/live — so a mismatch report can never leak
    // the current version of state the caller was not entitled to name.
    const expected = args["expected_state_version"];
    if (expected !== undefined) {
      if (typeof expected !== "number" || !Number.isInteger(expected) || expected < 0) {
        return {
          ok: false,
          reason: "invalid-input",
          field: "expected_state_version",
          detail: "expected_state_version must be a non-negative integer — the state version a prior call reported for this task_handle",
          next: freshPack,
        };
      }
      if (expected !== resolved.stateVersion) {
        // FAIL CLOSED. The handle is live, but the state it names has moved
        // past the version the caller is reasoning about: proceeding would be
        // exactly the "silently continue against the wrong state" outcome
        // PI-09 forbids. `retry:"new-task"` is declared explicitly so the
        // sanctioned transition is the re-pack family, not a bare re-issue of
        // the same (now provably stale) precondition.
        //
        // CODE REUSE, deliberate — same reasoning as the handle causes above:
        // A.7.1 is a closed enum and this wave mints no codes, so the coarse
        // `invalid-input` carries the cause in `detail`.
        //
        // `actual` rather than a fresh `actual_state_version`: the A.8 advisory
        // allowlist (`protocol/refusal.ts` REFUSAL_ADVISORY_KEYS) is a CLOSURE,
        // not a filter, so a new key would be silently dropped by the funnel —
        // and `actual` is already declared there for exactly this shape ("what
        // the value actually is"). The EXPECTED half deliberately does not
        // ride: the caller sent it, so it is caller-recoverable, and the
        // `detail` names both numbers either way.
        //
        // This refusal is also the ONLY disclosure path for the current version
        // — D-2 forbids a `CommonStateOutput` block, so no success-path field
        // carries it. Recorded as a known gap rather than papered over.
        return {
          ok: false,
          reason: "invalid-input",
          field: "expected_state_version",
          detail: `task state is at version ${resolved.stateVersion}; this call expected ${expected} — the task advanced under you, so nothing was done`,
          requested_handle: token,
          actual: resolved.stateVersion,
          retry: "new-task",
          next: freshPack,
          alternatives: [{ mode: "task_pack" }],
        };
      }
    }
    return null;
  }

  const hint =
    resolved.outcome === "wrong-purpose"
      ? "this is not a task handle — task_handle takes the `task.id` of a prior task_pack, never a continuation cursor or a context handle"
      : resolved.outcome === "expired"
        ? "this task handle has expired; re-pack to open a fresh task"
        : resolved.outcome === "invalid"
          ? "this task handle failed authentication (edited, truncated, or minted by another installation)"
          : resolved.outcome === "wrong-subject"
            ? "this task handle was minted by a different TokenLighten installation"
            : resolved.outcome === "stale"
              ? "the state store was rebuilt, so this task handle names a generation that no longer exists"
              : resolved.outcome === "store-unavailable"
                ? "no durable state store is available for this workspace, so no task handle can be honoured here"
                : "the state store no longer holds this task's state";

  if (resolved.outcome === "wrong-workspace") {
    return {
      ok: false,
      reason: "handle-workspace-mismatch",
      requested_handle: token,
      hint: "this task handle belongs to a different workspace; a task handle is bound to the workspace it was minted in",
      next: freshPack,
      alternatives: [{ mode: "task_pack" }],
    };
  }
  return {
    ok: false,
    reason: "handle-unknown",
    requested_handle: token,
    hint,
    next: freshPack,
    alternatives: [{ mode: "task_pack" }],
  };
}

// ---------------------------------------------------------------------------
// PI-09 close-out — `operation_id` idempotency (edit_file only)
// ---------------------------------------------------------------------------

/** Longest `operation_id` accepted. A key, not a payload. */
const OPERATION_ID_MAX_CHARS = 128;

/**
 * Largest recorded outcome an idempotent replay will store, in bytes.
 *
 * Sized against the store's own durability arithmetic, not against taste:
 * `stateStore.ts` compacts at 512 journal lines and REFUSES to load a journal
 * over 8 MB (a refusal that resets the whole generation and invalidates every
 * outstanding handle). 512 x 16 KiB = 8 MB is exactly that boundary, so this
 * cap is the largest value that cannot turn a busy idempotent workload into a
 * store reset. The measured `edit.applied` wire sizes it must cover
 * (protocol/budget/wireBudget.ts's table) are 420 B at 1 path and 10 KB at 64
 * typical paths, so real edits fit with room; a 256-path adversarial batch
 * does not, and takes the honest non-replaying refusal below.
 */
const OPERATION_REPLAY_MAX_BYTES = 16 * 1024;

/**
 * Marker recorded when the outcome was real but too large to replay.
 *
 * Unambiguous against a recorded payload by construction: the only other value
 * this table ever holds is `JSON.stringify({v:1,…})`, which always begins `{`.
 */
const OPERATION_OVERSIZE_MARKER = "!oversize";
// Compatibility marker: legacy v1 parsers must reject this record as an
// unsupported replay, never treat it as absent and re-apply the edit.
const OPERATION_REPLAY_V2_MARKER = "structured-v2";

/**
 * B-F1 downgrade fix. The legacy `op:${operationId}` key is the ONLY key an
 * old (pre-v:2) server ever reads, and its frozen dispatch order is:
 * exact-match oversize marker -> refuse (safe halt); else parse v1 JSON;
 * unreadable is treated as absent -> run() (a SECOND disk apply). See
 * `git show 23a023e0:packages/mcp-server/src/server.ts`
 * (`parseRecordedOperation`, `runEditWithOperationId`) for the exact frozen
 * logic this must satisfy — that build cannot parse a v:2 record, so it
 * would silently re-apply the edit unless the legacy key it reads is
 * unconditionally the oversize marker. The real structured-v2 record is
 * written to a SIBLING key under this prefix instead, in a namespace that
 * provably never collides with a legacy key for any caller-chosen
 * operation_id: `"op:"` and this prefix diverge at character index 2
 * (':' vs 'v'), so `` `op:${a}` `` cannot equal
 * `` `${OPERATION_V2_KEY_PREFIX}${b}` `` for ANY strings a, b —
 * `operation_id` has no charset restriction, so this must hold
 * structurally, not just empirically. The server always checks the v2 key
 * FIRST and falls back to the legacy key only when no v2 sibling exists (an
 * outcome recorded by an old server, or before this fix).
 */
const OPERATION_V2_KEY_PREFIX = "opv2:";

/** Test-only: the v2 sibling-key namespace, exposed so specs can assert dual-write placement without duplicating the naming scheme. */
export const __testOnlyOperationV2KeyPrefix = OPERATION_V2_KEY_PREFIX;

/**
 * In-process claim set: `${workspace}\u0000${operationId}` for every operation
 * currently executing. The store's dedup table is INSERT-ONLY and is written
 * after the edit lands, so it cannot by itself stop two overlapping calls with
 * one key from both applying. This closes that window for the case that can
 * actually occur here — two calls interleaved at an `await` inside one server
 * process — and is cleared in a `finally` so a throw cannot strand a key.
 * Cross-PROCESS overlap is out of scope and disclosed in the report.
 */
const _operationsInFlight = new Set<string>();

/** Serialized replay payload for a recorded operation. */
interface RecordedOperationOutcomeV2 {
  v: 2;
  kind: "edit.applied";
  replay_format: typeof OPERATION_REPLAY_V2_MARKER;
  counts?: unknown;
  paths?: unknown;
  sha?: unknown;
  checkpoint?: unknown;
  outcome_hash: string;
  read_back?: unknown;
  applied?: unknown;
  core?: unknown;
  applied_note?: unknown;
  delta?: unknown;
  handle?: unknown;
  lines?: unknown;
  path?: unknown;
  verification?: unknown;
  isError?: true;
}

type ParsedRecordedOperation = { text: string; isError?: true };

function parseRecordedOperation(raw: string): ParsedRecordedOperation | undefined {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const record = parsed as Record<string, unknown>;
    if (record["v"] === 1 && typeof record["text"] === "string") {
      return { text: record["text"], ...(record["isError"] === true ? { isError: true as const } : {}) };
    }
    if (record["v"] !== 2
      || record["kind"] !== "edit.applied"
      || record["replay_format"] !== OPERATION_REPLAY_V2_MARKER
      || typeof record["outcome_hash"] !== "string") return undefined;
    const body: Record<string, unknown> = { v: 1, kind: "edit.applied" };
    for (const key of ["counts", "paths", "sha", "checkpoint", "read_back", "applied", "core", "applied_note", "delta", "handle", "lines", "path", "verification"]) {
      if (record[key] !== undefined) body[key] = record[key];
    }
    return { text: JSON.stringify(body) };
  } catch {
    return undefined;
  }
}

function structuredOperationRecord(text: string): string {
  let body: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
  } catch {
    // Keep a valid compact record even when an upstream emitter returned opaque text.
  }
  const applied = Array.isArray(body["applied"]) ? body["applied"] : [];
  const compactApplied = applied.flatMap((entry) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return [];
    const appliedEntry = entry as Record<string, unknown>;
    const entryPath = appliedEntry["path"];
    const entryRange = appliedEntry["range"];
    return typeof entryPath === "string" && typeof entryRange === "string"
      ? [{ path: entryPath, range: entryRange }]
      : [];
  });
  const record: RecordedOperationOutcomeV2 = {
    v: 2,
    kind: "edit.applied",
    replay_format: OPERATION_REPLAY_V2_MARKER,
    outcome_hash: createHash("sha256").update(text, "utf8").digest("hex").slice(0, 32),
    // The v2 replay projection is deliberately the smallest required-set
    // subset: address-only applied entries. `outcome_hash` stays in the
    // journal for record validation but is intentionally not sent on replay;
    // the first edit.applied response remains the source for counts, read_back,
    // verification, handles and other explanatory payloads.
    ...(compactApplied.length > 0 ? { applied: compactApplied } : {}),
  };
  return JSON.stringify(record);
}

/**
 * PI-09 close-out: run one `edit_file` call under its `operation_id`.
 *
 * POSITION MATTERS, and it is OUTSIDE the protocol funnel
 * (`runWithProtocolCall` -> `finalizeProtocolResponse`), for two reasons the
 * inner position got wrong when it was tried first:
 *   - `isError` is stamped by the funnel (§2.5: every refusal carries it), so
 *     inside the funnel a refusal is indistinguishable from an apply and a
 *     failed attempt would claim the key forever;
 *   - the recorded text is then the FINAL wire text, so a replay is
 *     byte-identical rather than a second projection of the same body through
 *     a workspace marker that has moved since (the edit itself moves it).
 *
 * The contract, in order:
 *  1. a repeat whose operation ALREADY APPLIED replays the recorded outcome
 *     and performs no second disk apply;
 *  2. an overlapping call with the same key is refused, not raced;
 *  3. a first (or previously refused) call runs normally, and its outcome is
 *     recorded only when something actually landed.
 *
 * WHAT IS DELIBERATELY NOT RECORDED. A refusal — including `edit.rolled_back`
 * and `edit.state_unknown`, which are `isError` — leaves the key unclaimed, so
 * the caller may retry after acting on the refusal's own recovery. Recording a
 * refusal would turn "nothing was applied" into a permanent answer for that
 * key, which is the opposite of what an idempotency key is for.
 *
 * KNOWN WINDOW, disclosed rather than hidden: the record is written AFTER the
 * apply, so a crash between the two leaves the operation unrecorded and a
 * retry re-applies. Closing it needs a two-phase write the append-journal
 * store does not offer (D-4), and a pre-claim would instead risk recording an
 * apply that never happened — the strictly worse failure.
 */
async function runEditWithOperationId(
  args: Record<string, unknown>,
  run: () => Promise<ToolCallResult>,
): Promise<ToolCallResult> {
  // This wrapper short-circuits BEFORE the dispatch funnel, so every refusal it
  // mints needs its own envelope — the same reason and the same shape as the
  // lane refusal in `callTool`. D1 admits no exceptions: a refusal a client
  // cannot version-identify is the class §1.2 exists to remove.
  const refuse = (body: Record<string, unknown>): ToolCallResult =>
    runWithProtocolCall({ tool: "edit_file", kind: "refusal" }, () =>
      finalizeProtocolResponse("edit_file", toolStructuredError(body)));

  const raw = args["operation_id"];
  if (raw === undefined) return run();
  if (typeof raw !== "string" || raw === "" || raw.length > OPERATION_ID_MAX_CHARS) {
    return refuse({
      ok: false,
      reason: "invalid-input",
      field: "operation_id",
      detail: `operation_id must be a non-empty string of at most ${OPERATION_ID_MAX_CHARS} characters — one caller-chosen key per intended change`,
      next: "re-issue this exact call with a valid operation_id, or omit it",
    });
  }

  let workspace: string;
  try {
    workspace = resolveWorkspaceRoot(args["cwd"] as string | undefined, activeRoot);
  } catch {
    // An unresolvable cwd is refused by the guard inside `run()` with a far
    // better message than anything this wrapper could invent.
    return run();
  }
  const store = stateStoreFor(workspace);
  if (store === undefined || !store.available) {
    // No durable store: honest degradation to today's behavior. Refusing the
    // edit instead would make `operation_id` a way to LOSE a write, and the
    // caller can still verify what landed.
    return run();
  }

  const key = `op:${raw}`;
  const claim = `${workspace}\u0000${key}`;

  // Dual-read (B-F1): a v:2 sibling record — written only by a server that
  // has this fix — always wins when present, so THIS server's own writes
  // always round-trip through the compact v2 projection below. Its absence
  // means either an old server wrote the legacy key (a real v1 record or a
  // real oversize marker), or nothing was recorded yet; the legacy-key read
  // below covers both.
  const v2Key = `${OPERATION_V2_KEY_PREFIX}${raw}`;
  const recordedV2 = store.lookupOperation(v2Key);
  const recorded = recordedV2 !== undefined ? recordedV2 : store.lookupOperation(key);
  if (recorded !== undefined) {
    if (recorded === OPERATION_OVERSIZE_MARKER) {
      return refuse({
        ok: false,
        reason: "invalid-input",
        field: "operation_id",
        detail: "this operation_id already applied; its recorded outcome was too large to replay, so it cannot be re-served — nothing was applied a second time",
        operation_id: raw,
        retry: "none",
        next: "search_files action=diff — the change is already on disk; verify it instead of re-sending the edit",
      });
    }
    const replay = parseRecordedOperation(recorded);
    if (replay !== undefined) {
      // THE IDEMPOTENT REPLAY. No dispatch, so no second disk apply.
      // v2 records carry only the side-effect identity and required replay
      // fields; the original response body is never re-read from the journal.
      const replayText = markReplayed(replay.text);
      recordServedBytes({
        workspaceRoot: workspace,
        epoch: typeof args["taskEpoch"] === "string" ? args["taskEpoch"] : undefined,
        lane: typeof args["lane"] === "string" ? args["lane"] : undefined,
        bytes: Buffer.byteLength(replayText, "utf8"),
        digest: createHash("sha256").update(replayText, "utf8").digest("hex"),
        source: "replay",
        forceServe: args["force_serve"] === true,
      });
      return { content: [{ type: "text", text: replayText }], ...(replay.isError === true ? { isError: true as const } : {}) };
    }
    // A recorded but unreadable v2 line must fail closed: treating it as
    // absent would let an older/newer parser apply the edit a second time.
    return refuse({
      ok: false,
      reason: "invalid-input",
      field: "operation_id",
      detail: "this operation_id already has a recorded outcome that cannot be replayed safely; nothing was applied a second time",
      operation_id: raw,
      retry: "none",
      next: "search_files action=diff — verify the existing change instead of re-sending the edit",
    });
  }

  if (_operationsInFlight.has(claim)) {
    return refuse({
      ok: false,
      reason: "invalid-input",
      field: "operation_id",
      detail: "another call with this operation_id is still running in this server — nothing was applied, so this request cannot be told whether the first one landed",
      operation_id: raw,
      next: "wait for the first call to answer, then re-issue this exact call — the recorded outcome will be replayed",
    });
  }
  _operationsInFlight.add(claim);
  let result: ToolCallResult;
  try {
    result = await run();
  } finally {
    _operationsInFlight.delete(claim);
  }

  const isError = "isError" in result && result.isError === true;
  if (!isError) {
    const text = result.content.map((item) => item.text).join("");
    const payload = structuredOperationRecord(text);
    const v2Value = Buffer.byteLength(payload, "utf8") <= OPERATION_REPLAY_MAX_BYTES ? payload : OPERATION_OVERSIZE_MARKER;
    // Dual-write (B-F1). The legacy key is UNCONDITIONALLY the oversize
    // marker — never the real record — so an old server's exact-match
    // oversize check always catches it and fails closed instead of falling
    // through to "unreadable = absent -> run()" (a second disk apply). The
    // real structured-v2 record (or its own oversize marker) lives at the
    // collision-safe v2Key instead; see OPERATION_V2_KEY_PREFIX. Order
    // matters only for the crash window between the two appends: writing
    // the legacy marker first means a crash before the second write still
    // leaves an old OR new reader fail-closed (never a reapply), matching
    // this wrapper's existing disclosed "known window" contract.
    // The compact structured-v2 journal is intentionally only exposed when
    // this operation is replayed, so callers can verify that replay reduced
    // wire bytes.
    store.rememberOperation(key, OPERATION_OVERSIZE_MARKER);
    store.rememberOperation(v2Key, v2Value);
  }
  return result;
}

/**
 * Normalize harmless, observed wire spellings before the strict schema fence.
 * This is deliberately the one boundary for all consumers of task-pack
 * arguments: downstream code may rely on `paths` being an array.
 */
function asCanonicalObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function mapCanonicalTask(value: unknown, args: Record<string, unknown>): void {
  const task = asCanonicalObject(value);
  if (task === undefined) return;
  const names: ReadonlyArray<[string, string]> = [
    ["handle", "task_handle"],
    ["epoch", "taskEpoch"],
    ["profile", "taskProfile"],
    ["expected_state_version", "expected_state_version"],
    ["challenge", "challenge"],
    ["force_serve", "force_serve"],
  ];
  for (const [from, to] of names) {
    if (task[from] !== undefined) args[to] = task[from];
  }
  // This is deliberately not a general operation discriminator.
  if (task["pull"] === "closure") args["mode"] = "closure";
}

function mapCanonicalBudget(value: unknown, args: Record<string, unknown>): void {
  const budget = asCanonicalObject(value);
  if (budget === undefined) return;
  const names: ReadonlyArray<[string, string]> = [
    ["bytes", "maxBytes"],
    ["tokens", "maxTokens"],
    ["items", "limit"],
    ["rows", "maxRows"],
    ["cells", "maxCells"],
    ["allowFull", "allowFull"],
  ];
  for (const [from, to] of names) if (budget[from] !== undefined) args[to] = budget[from];
}

function mapCanonicalScope(value: unknown, args: Record<string, unknown>): Record<string, unknown> | undefined {
  const scope = asCanonicalObject(value);
  if (scope === undefined) return undefined;
  for (const name of [
    "path", "archive", "credentialRef", "lang", "regex", "depth",
    "includeClosure", "surfaceRoles", "includeScores", "symbol",
  ]) {
    if (scope[name] !== undefined) args[name] = scope[name];
  }
  return scope;
}

function mapCanonicalSelect(value: unknown, args: Record<string, unknown>): boolean {
  const select = asCanonicalObject(value);
  if (select === undefined) return false;
  const names: ReadonlyArray<[string, string]> = [
    ["kind", "kind"],
    ["format", "as"],
    ["comments", "comments"],
    ["sheet", "sheet"],
    ["rows", "rows"],
    ["columns", "columns"],
    ["sections", "sections"],
    ["slides", "slides"],
    ["pages", "pages"],
  ];
  // Every present field is still copied onto `args` unconditionally — a
  // `comments`/`sections` selector must reach the ordinary read dispatcher
  // exactly as before. Only the RETURN VALUE narrows to ARTIFACT_SELECT_KEYS,
  // because that value alone decides `mode="artifact"` at the call site.
  let selectsArtifact = false;
  for (const [from, to] of names) {
    if (select[from] !== undefined) {
      args[to] = select[from];
      if (ARTIFACT_SELECT_KEYS.includes(from)) selectsArtifact = true;
    }
  }
  return selectsArtifact;
}

function legacyPathTarget(target: Record<string, unknown>): string | Record<string, unknown> {
  if (typeof target["path"] === "string"
    && target["range"] === undefined
    && target["symbol"] === undefined
    && target["purpose"] === undefined) {
    return target["path"];
  }
  const mapped: Record<string, unknown> = {};
  for (const name of ["path", "range", "symbol", "purpose"]) {
    if (target[name] !== undefined) mapped[name] = target[name];
  }
  return mapped;
}

// D-3 router bridge: canonical inputs become the existing serving arguments.
// Wire callers cannot forge this module-private symbol. It survives the one
// internal spread between canonical projection and legacy dispatch, proving
// that create-by-copy came from the advertised edits[] carrier.
const CANONICAL_CREATE_COPY_INPUT = Symbol("tokenlighten.canonical-create-copy-input");

// F-V13-1 Fix B (DESIGN-v0.13-plan.md:167, 2026-08-30 triage): per-target
// range/symbol overrides for a multi-HANDLE read_file batch. A Symbol key for
// the exact same reason as CANONICAL_CREATE_COPY_INPUT above — it must never
// be reachable as an advertised/wire property (requestShape.ts's
// findUnknownProperties walks `Object.keys`/`Object.entries` only, so a
// Symbol-keyed property is structurally invisible to it and to a caller
// forging a plain string `"handleOverrides"` key). Unlike
// CANONICAL_CREATE_COPY_INPUT, this is NOT deleted inside normalizeWireArgs —
// it has to survive all the way to the A7 handles=[] batch loop deep inside
// dispatchTool's read_file case, and `args` is passed by reference (plus one
// more object-spread in normalizeWireArgs, which — like the canonical
// projection's own `{...input}` — copies own ENUMERABLE properties including
// symbol keys) the whole way there.
const HANDLE_OVERRIDES_INPUT = Symbol("tokenlighten.read-file-handle-overrides");

// I-5 fix (v0.13.1 forensics, DESIGN-v0.13-plan.md §6 2026-08-30 entry;
// bench/workflows/experiments/2026-08-30-v0131-forensics/{REPORT.md,terra/
// report.md}): a multi-target read_file call that mixes an archive selector
// (or a call-level artifact `select`) with another target cannot be
// projected onto the legacy paths[]/mode dispatcher below without either an
// order-dependent refusal or a SILENT PARTIAL SERVE. legacyPathTarget above
// keeps only path/range/symbol/purpose, so an archive-carrying target riding
// alongside a plain sibling loses its selector the moment it is mapped —
// and depending on which sibling `first` (the mode-inference target) turns
// out to be, the call either never resolves mode="archive"/"artifact" at
// all (the archive/artifact target becomes a bare `{}` inside paths[],
// silently served as nothing — the correctness defect) or resolves it while
// paths[] still carries more than one entry, which the archive/artifact
// dispatcher refuses "path is required" — order-dependent either way.
// Spawned-stdio-confirmed for all three shapes (terra/i5-i6-spawned-
// results.json): archive-first+plain -> invalid-input; plain+archive-second
// -> read.batch serving ONLY the plain target with no error at all; two
// paths+artifact select -> invalid-input.
//
// F5 extension (opus pre-release review, 2026-08-30): a DIFFERENT silent-drop
// shape shares this exact gate. `mapCanonicalScope` copies `scope.archive`
// onto the legacy top-level `args["archive"]` field regardless of `targets`,
// and `selectorFromArgs(args)` (tools/archive.ts) reads that top-level field
// UNCONDITIONALLY a few hundred lines below in the read_file dispatch
// (`archiveSelector`), computing `resolvedPath` from it before `mode` is even
// resolved — so a `targets:[...]` batch riding alongside `scope.archive`
// never reaches the legacy `paths[]`/multi-target machinery at all: the
// single archive-derived `resolvedPath` silently wins and every target is
// dropped, with no error, regardless of target count or whether `query` also
// rode along. Gated on `scope.archive` being present AND at least one target
// lacking its own per-target `archive` (a target that DOES carry its own
// `archive` is unambiguous and already handled above) — this also covers a
// SINGLE plain target, unlike the multi-target-only condition above, because
// the silent-drop mechanism here does not require a second target to bite.
//
// Same module-private Symbol pattern as HANDLE_OVERRIDES_INPUT immediately
// above — unforgeable from the wire (findUnknownProperties walks
// Object.keys/Object.entries only) and, like that constant, survives the
// `{...input}` spread inside normalizeWireArgs all the way to dispatchTool's
// read_file case. Read back and returned there BEFORE declareKind — the
// exact F-V13-1 Fix B / B1 ordering constraint documented at this file's A7
// handles=[] block (a refusal returned after declareKind is misclassified as
// a successful, empty read.batch).
//
// Reuses the existing `invalid-input` RefusalCode (A.7.1) rather than
// minting a new one: the immediately-adjacent F-V13-1 Fix B / B1 refusals a
// few hundred lines below this one refuse the SAME class of problem — "this
// multi-target batch shape cannot be dispatched" — with `code:"invalid-
// input"` plus a descriptive `field`/`error`, never a dedicated code. A new
// code would be free to mint (refusalCodeParity.spec.ts's own doc: additive
// minting is a floor, not a pin) but would still need a matching
// `RequestShapeCode` entry in packages/types/src/mcp/protocol.ts for
// refusalCodeOf to recognize it at all — extra surface with no behavioral
// upside here, since `code`+`field`+`detail`+`next` already fully describe
// the recovery and no caller-side branch depends on a more specific token.
const MULTI_TARGET_SELECTOR_REFUSAL_INPUT = Symbol("tokenlighten.read-file-multi-target-selector-refusal");

// ---------------------------------------------------------------------------
// FX-2 (v0.13 wave-3 review fix): string-to-structure leniency.
//
// Review probe evidence (session transcript, 2026-08-29): Claude Code 2.1.211
// has been observed sending a top-level canonical object/array parameter
// JSON-STRINGIFIED rather than as a native object/array — `typeof
// input.edits === "string"` holding `JSON.stringify(...)` of the caller's
// intended array. Codex CLI, sending native objects, does not hit this.
//
// Every existing consumer below is silently string-blind: `asCanonicalObject`
// (this file) returns `undefined` for a string and callers no-op on
// `undefined`, so a stringified `task` does not refuse — it vanishes. The
// caller's `task.epoch`/`task.id`/`task.challenge`/`task.force_serve` binding
// is silently dropped, the session stays on whatever state it already held,
// and the NEXT typestate-fence refusal has nothing to do with serialization —
// a strong root cause of the repeated execution-typestate refusal loops this
// client was observed producing. A stringified `edits` fares better only by
// accident: edit_file's own `Array.isArray(edits)` guard (~L11114) already
// refuses "edits must be an array" — but only once the call clears every
// earlier gate, and only for `edits` specifically.
//
// D-5 (acceptance-first: intent is unambiguous): a string is accepted IN
// PLACE of its declared object/array shape ONLY when (a) it parses as JSON,
// (b) the parsed value's top-level shape (object vs array) matches what the
// field declares, AND (c) the parsed value passes the EXACT SAME recursive
// property-name validation (`findUnknownProperties`) a natively-sent value
// would receive against the REAL advertised schema (`advertisedPropertiesFor`
// — the same map `emittedToolCallShape.spec.ts` validates outbound calls
// against). A parse failure or a validation failure changes NOTHING: the
// original string rides through untouched, so every existing refusal path
// (`asCanonicalObject` no-op, "edits must be an array", unknown-arguments)
// still fires exactly as it does today for anything this does not rescue —
// this function only ever WIDENS acceptance, never narrows or hides a
// genuine shape defect.
//
// Nested one-level rescue: an array field that already arrived as a native
// array, but whose OWN elements are individually stringified objects
// (`edits[0]` a JSON string while `edits` itself is a real array), gets the
// identical treatment for each element — once, not recursively, so a caller
// cannot bury an arbitrarily-deep stringified structure and have all of it
// silently unwrapped. Scoped to fields whose declared item shape is itself an
// object (`targets`, `edits`) — `queries`' items are plain strings by
// design, so a literal string that happens to parse as JSON (e.g. a search
// for the text `["x"]`) must never be reinterpreted as structure.
// ---------------------------------------------------------------------------

const CANONICAL_OBJECT_FIELDS: readonly string[] = ["task", "scope", "select", "budget", "artifact", "credentials"];
const CANONICAL_ARRAY_FIELDS: readonly string[] = ["targets", "queries", "edits"];

/**
 * `JSON.parse` a string that at least LOOKS like an object/array — never
 * attempted on an ordinary string value (a real path, a real query token),
 * so a legitimate string is never even candidate-parsed, let alone coerced.
 */
function jsonParseIfStructureLike(value: unknown): { parsed: unknown } | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed === "" || !(trimmed.startsWith("{") || trimmed.startsWith("["))) return undefined;
  try {
    return { parsed: JSON.parse(trimmed) as unknown };
  } catch {
    return undefined;
  }
}

/** True iff `value`'s top-level shape is the one `expected` names. */
function matchesTopLevelShape(value: unknown, expected: "object" | "array"): boolean {
  return expected === "array" ? Array.isArray(value) : asCanonicalObject(value) !== undefined;
}

/**
 * Re-validate a rescued (parsed) value against the SAME recursive
 * property-name schema (`findUnknownProperties`'s walk) the field would
 * receive if it had arrived natively, scoped to just this one field — so a
 * stringified `task` that invents an unadvertised sub-property is refused
 * exactly as a native one would be, never silently smuggled in. Reads the
 * REAL, LIVE advertised schema (`advertisedPropertiesFor`), never a
 * hand-maintained mirror of it.
 */
function rescuedValuePassesSchema(canonical: string, field: string, value: unknown): boolean {
  const schema = advertisedPropertiesFor(canonical)[field];
  if (schema === undefined) return false;
  return findUnknownProperties(canonical, { [field]: schema }, { [field]: value }).length === 0;
}

/** Declared item shape for an array field, or undefined if none is declared. */
function arrayFieldItemSchema(canonical: string, field: string): SchemaNode | undefined {
  return advertisedPropertiesFor(canonical)[field]?.items;
}

function rescueStringifiedCanonicalFields(canonical: string, input: Record<string, unknown>): Record<string, unknown> {
  // Lazily cloned, and ONLY on an actual successful rescue — never merely on
  // a candidate string being present. `normalizeCanonicalRequest`'s existing
  // no-canonical-shape fast path returns its `input` argument BY REFERENCE
  // (canonicalSurface.spec.ts's "keeps legacy find batches on their shared
  // search carrier" pins this with `.toBe`), and this function must preserve
  // that identity whenever nothing here actually changes.
  let out: Record<string, unknown> | undefined;
  const target = (): Record<string, unknown> => (out ??= { ...input });

  for (const field of CANONICAL_OBJECT_FIELDS) {
    const rescued = jsonParseIfStructureLike(input[field]);
    if (rescued === undefined) continue;
    if (matchesTopLevelShape(rescued.parsed, "object") && rescuedValuePassesSchema(canonical, field, rescued.parsed)) {
      target()[field] = rescued.parsed;
    }
  }

  for (const field of CANONICAL_ARRAY_FIELDS) {
    let arrayValue = input[field];
    const topLevelRescue = jsonParseIfStructureLike(arrayValue);
    if (
      topLevelRescue !== undefined
      && matchesTopLevelShape(topLevelRescue.parsed, "array")
      && rescuedValuePassesSchema(canonical, field, topLevelRescue.parsed)
    ) {
      arrayValue = topLevelRescue.parsed;
      target()[field] = arrayValue;
    }

    // One-level nested rescue, object-shaped items only (see header doc) —
    // reads `arrayValue` (the just-rescued array when the top-level rescue
    // above fired, otherwise the original), never re-reads `out[field]`.
    const itemSchema = arrayFieldItemSchema(canonical, field);
    if (Array.isArray(arrayValue) && itemSchema?.properties !== undefined && arrayValue.some((item) => typeof item === "string")) {
      const rescuedItems = arrayValue.map((item) => {
        const itemRescue = jsonParseIfStructureLike(item);
        return itemRescue !== undefined && matchesTopLevelShape(itemRescue.parsed, "object") ? itemRescue.parsed : item;
      });
      // Re-validate the WHOLE rescued array so a partially-rescued array (one
      // element still an un-parseable or invalid string) never ships an
      // unvalidated item under cover of its now-valid siblings.
      if (rescuedItems.some((item, index) => item !== arrayValue[index]) && rescuedValuePassesSchema(canonical, field, rescuedItems)) {
        target()[field] = rescuedItems;
      }
    }
  }

  return out ?? input;
}

export function normalizeCanonicalRequest(canonical: string, input: Record<string, unknown>): Record<string, unknown> {
  // FX-2: rescue JSON-stringified canonical fields BEFORE `hasCanonicalShape`
  // (below) or anything else inspects them — `hasCanonicalShape` itself is
  // one of the string-blind checks this rescues (`Array.isArray(input["edits"])`
  // is false for a stringified batch with no OTHER canonical key present,
  // which used to make this whole function a no-op for that call).
  input = rescueStringifiedCanonicalFields(canonical, input);
  // `queries` is the shared legacy/canonical find carrier. A bare legacy
  // find batch must reach the dispatcher unchanged, including its content-first
  // did_you_mean session state. Non-find canonical search actions use queries
  // as their canonical home and still need projection to legacy `query`.
  const hasCanonicalShape = ["targets", "select", "budget", "task", "scope", "credentials"]
    .some((key) => input[key] !== undefined)
    || (canonical === "edit_file" && Array.isArray(input["edits"]))
    || (canonical === "search_files" && input["action"] !== "find" && Array.isArray(input["queries"]));
  if (!hasCanonicalShape) return input;

  const args: Record<string, unknown> = { ...input };
  const task = args["task"];
  const scope = args["scope"];
  const budget = args["budget"];
  const select = args["select"];
  delete args["task"];
  delete args["scope"];
  delete args["budget"];
  delete args["select"];

  mapCanonicalTask(task, args);
  mapCanonicalBudget(budget, args);
  const scopeValue = mapCanonicalScope(scope, args);

  if (canonical === "read_file") {
    const rawTargets = Array.isArray(args["targets"]) ? args["targets"] : [];
    delete args["targets"];
    const targets = rawTargets
      .map(asCanonicalObject)
      .filter((target): target is Record<string, unknown> => target !== undefined);
    const selectsArtifact = mapCanonicalSelect(select, args);

    // I-5 fix: fail closed, before ANY legacy projection below, on a
    // multi-target call that mixes an archive selector or a call-level
    // artifact `select` with another target — see
    // MULTI_TARGET_SELECTOR_REFUSAL_INPUT's own doc comment for the exact
    // silent-drop/order-dependence this replaces. `targets` here is still
    // the RAW per-target canonical objects (path/handle/archive/...), pre-
    // legacyPathTarget, so `next` below can re-issue the caller's own first
    // target byte-for-byte.
    const targetsMixArchiveOrArtifactSelect = targets.length > 1
      && (targets.some((target) => target["archive"] !== undefined) || selectsArtifact);
    // F5 extension (opus pre-release review, 2026-08-30): see
    // MULTI_TARGET_SELECTOR_REFUSAL_INPUT's own doc comment for the
    // DIFFERENT silent-drop mechanism this closes (selectorFromArgs/
    // resolvedPath hijacking the whole call from scope.archive, independent
    // of legacyPathTarget). Deliberately allows targets.length === 1 — a
    // lone plain target riding alongside scope.archive is dropped by that
    // SAME mechanism, so it does not need a second target to be ambiguous.
    // A target that already carries its own `archive` is unaffected: the
    // `.some(... === undefined)` check is false when EVERY target is
    // self-sufficient, so a redundant scope.archive alongside only
    // self-sufficient targets is not itself grounds for refusal here.
    const scopeArchiveWithBareTarget = scopeValue?.["archive"] !== undefined
      && targets.length >= 1
      && targets.some((target) => target["archive"] === undefined);
    if (targetsMixArchiveOrArtifactSelect || scopeArchiveWithBareTarget) {
      const firstTarget = targets[0]!;
      const selectObject = asCanonicalObject(select);
      // F4 fix (same review): the recovery `next` used to drop the caller's
      // own query/qref and task (epoch/handle/profile/challenge/
      // force_serve/expected_state_version) — re-issuing only the first
      // target lost whatever task_pack discovery or re-pack context the
      // original call carried, forcing a caller to reconstruct it from
      // scratch. `task` mirrors `select`'s existing asCanonicalObject
      // convention; `query`/`qref` are read straight off `args`, which
      // nothing above this point mutates. A key absent on the original call
      // is never fabricated here.
      const taskObject = asCanonicalObject(task);
      Object.defineProperty(args, MULTI_TARGET_SELECTOR_REFUSAL_INPUT, {
        value: {
          ok: false,
          code: "invalid-input",
          field: "targets",
          error: scopeArchiveWithBareTarget && !targetsMixArchiveOrArtifactSelect
            ? "scope.archive cannot be combined with a target that has no archive selector of its own; re-issue one call per target (next re-issues the first)"
            : "multiple targets cannot mix an archive/artifact selector with another target in one call; re-issue one call per target (next re-issues the first)",
          next: canonicalToolCall("read_file", {
            cwd: args["cwd"],
            targets: [firstTarget],
            ...(args["query"] !== undefined ? { query: args["query"] } : {}),
            ...(args["qref"] !== undefined ? { qref: args["qref"] } : {}),
            ...(selectObject !== undefined ? { select: selectObject } : {}),
            ...(args["content"] !== undefined ? { content: args["content"] } : {}),
            ...(taskObject !== undefined ? { task: taskObject } : {}),
          }),
        },
        enumerable: true,
        configurable: true,
      });
    }

    if (targets.length > 0) {
      if (args["query"] !== undefined || args["qref"] !== undefined) {
        args["paths"] = targets.map(legacyPathTarget);
        args["mode"] = "task_pack";
      } else {
        const first = targets[0]!;
        // A multi-handle continuation is a batch: do not promote the first
        // target's selector to call scope, where it would override content.
        if (targets.length === 1) {
          for (const name of ["path", "handle", "archive", "credentialRef", "range", "ranges", "symbol", "profile", "lang"]) {
            if (first[name] !== undefined) args[name] = first[name];
          }
        }
        if (targets.length > 1) {
          const handles = targets.map((target) => target["handle"]);
          if (handles.every((handle): handle is string => typeof handle === "string")) {
            args["handles"] = handles;
            // F-V13-1 Fix B: the A7 handles=[] batch loop used to resolve
            // every item from the handle's own STORED range/symbol only, so
            // a caller asking for two different windows of the same file via
            // targets:[{handle,range:"1-28"},{handle,range:"144-401"}] had
            // both requested ranges silently discarded in favor of whatever
            // the handle(s) were minted with (2026-08-29 forensics: two
            // already-served handle+range targets returned the SAME stale
            // stored range twice — served-content misdelivery, not a
            // refusal). Only synthesized when at least one target actually
            // carries an override, so an ordinary handles-only continuation
            // (ranges[] `remaining` chains, verification-kit reads, ...)
            // projects byte-identically to before this fix.
            if (targets.some((t) => t["range"] !== undefined || t["ranges"] !== undefined || t["symbol"] !== undefined)) {
              const overrides = targets.map((t) => {
                const ov: Record<string, unknown> = {};
                if (t["range"] !== undefined) ov["range"] = t["range"];
                // `ranges` (plural, multi-window) is carried through so the
                // A7 loop can refuse that one target explicitly rather than
                // silently falling back to the stored range — see the A7
                // handleOverrides read site for why this is not treated the
                // same as a singular `range` override.
                if (t["ranges"] !== undefined) ov["ranges"] = t["ranges"];
                if (t["symbol"] !== undefined) ov["symbol"] = t["symbol"];
                return ov;
              });
              Object.defineProperty(args, HANDLE_OVERRIDES_INPUT, { value: overrides, enumerable: true, configurable: true });
            }
          }
          else args["paths"] = targets.map(legacyPathTarget);
        }
        if (first["archive"] !== undefined) args["mode"] = "archive";
        else if (selectsArtifact) args["mode"] = "artifact";
        // F-V13-1 Fix A (DESIGN-v0.13-plan.md:167): this promotion is only
        // unambiguous for a SINGLE target. Before this gate, a multi-target
        // read_file call whose FIRST entry (or any entry, via `first`) merely
        // happened to carry a range forced the WHOLE call to mode="slice" —
        // and normalizeWireArgs's own mode=slice guard refuses outright the
        // moment more than one path rides along ("mode=slice accepts one
        // path; multiple paths are discovery scope"), so a caller who sent an
        // ordinary canonical `targets:[{path},{path,range}]` discovery/serve
        // request was hit with a legacy-dialect refusal it never asked for.
        // Leaving `mode` unset for targets.length > 1 lets the request fall
        // through to the existing mode-unspecified task_pack promotion gate
        // below (`modeUnspecifiedOrAuto` / `pathlessExploratoryPaths`),
        // which already handles a paths[] batch correctly — including
        // honoring each entry's own explicit range as a zoom window
        // (buildSeededTaskPack's `explicitSeedStart`). The all-handle branch
        // above is unaffected: A7's handles=[] batch dispatch fires before
        // any mode branch regardless of what `mode` resolves to here.
        else if (targets.length === 1 && (first["ranges"] !== undefined || first["range"] !== undefined)) args["mode"] = "slice";
        else if (first["symbol"] !== undefined) args["mode"] = "symbol";
        else if (args["content"] === "full") args["mode"] = "full";
        else if (args["content"] === "outline") args["mode"] = "skeleton";
        else if (args["content"] === "defer") args["mode"] = "small_file";
      }
    }
    // scope is the single home for closure selection on every tool.
    if (scopeValue?.["includeClosure"] !== undefined) args["includeClosure"] = scopeValue["includeClosure"];
    if (scopeValue?.["surfaceRoles"] !== undefined) args["surfaceRoles"] = scopeValue["surfaceRoles"];
    // `content` selects the legacy mode above; do not leak it into the
    // legacy dispatcher, whose served-ledger accounting is mode-based.
    delete args["content"];
  } else if (canonical === "edit_file") {
    const credentials = asCanonicalObject(args["credentials"]);
    delete args["credentials"];
    if (credentials?.["in"] !== undefined) args["credentialRef"] = credentials["in"];
    if (credentials?.["out"] !== undefined) args["outputCredentialRef"] = credentials["out"];
    if (Array.isArray(args["edits"])) {
      const edits = args["edits"].map((value) => {
        const item = asCanonicalObject(value);
        if (item === undefined) return value;
        const copy = { ...item };
        const intent = asCanonicalObject(copy["intent"]);
        delete copy["intent"];
        if (intent !== undefined) {
          for (const name of ["from", "to", "symbol", "lang", "includeComments"]) {
            if (intent[name] !== undefined) copy[name] = intent[name];
          }
          if (intent["kind"] === "rename") copy["mode"] = "rename";
          else if (intent["kind"] !== undefined) copy["intent"] = intent["kind"];
        }
        return copy;
      });
      if (edits.length === 1) {
        const only = asCanonicalObject(edits[0]);
        const canonicalCreateCopy = only?.["create"] === true && typeof only["from"] === "string";
        if (only?.["create"] === true || only?.["mode"] !== undefined || only?.["intent"] !== undefined) {
          delete args["edits"];
          for (const [key, value] of Object.entries(only)) args[key] = value;
          if (canonicalCreateCopy) {
            Object.defineProperty(args, CANONICAL_CREATE_COPY_INPUT, { value: true, enumerable: true });
          }
        } else {
          args["edits"] = edits;
        }
      } else {
        args["edits"] = edits;
      }
    }
  } else if (canonical === "search_files") {
    const queries = Array.isArray(args["queries"]) ? args["queries"] : [];
    delete args["queries"];
    // Canonical search uses `queries` for every action; legacy references and
    // symbol dispatch still read the first query from their singular slot.
    if (args["action"] === "find" && scopeValue?.["kind"] !== "symbol") {
      // Legacy and canonical find both accept the batched queries carrier.
      // Keep it: dropping it turns a valid sfh6 search into a no-query refusal.
      args["queries"] = queries;
    } else if (args["query"] === undefined && typeof queries[0] === "string") {
      // Legacy references and symbols dispatch through their singular query.
      args["query"] = queries[0];
    }
    if (scopeValue?.["kind"] === "symbol" && args["action"] === "find") {
      args["action"] = "symbols";
      delete args["queries"];
      if (typeof queries[0] === "string") args["query"] = queries[0];
    }
    // `locate` remains accepted only as a compatibility spelling.  Its one
    // canonical execution route is closure-bearing tree discovery.
    if (args["action"] === "locate") {
      args["action"] = "tree";
      args["includeClosure"] = true;
    }
  }

  return args;
}

function normalizeWireArgs(
  canonical: string,
  input: Record<string, unknown>,
): { args: Record<string, unknown> } | { refusal: Record<string, unknown> } {
  const args = { ...input };
  const internalArgs = args as Record<PropertyKey, unknown>;
  const canonicalCreateCopy = internalArgs[CANONICAL_CREATE_COPY_INPUT] === true;
  delete internalArgs[CANONICAL_CREATE_COPY_INPUT];
  if (canonical === "edit_file" && args["create"] === true && typeof args["from"] === "string" && args["mode"] !== "rename" && args["intent"] === undefined && !Array.isArray(args["edits"]) && !canonicalCreateCopy) {
    return { refusal: { ok: false, code: "invalid-input", field: "from", error: "top-level create-by-copy is removed; use edits:[{create:true,from,...}]", retry: "call" } };
  }
  if (canonical === "read_file") {
    if (typeof args["paths"] === "string") {
      // FX-2 (2026-08-29, pre-launch canary): a schema-blind/legacy caller
      // that does not know `paths` is array-typed can serialize a structured
      // paths[] value (object entries with range/symbol, or a plain string
      // array) as ITS OWN JSON TEXT rather than a parsed array. Left
      // untreated, the whole JSON string was wrapped as ONE bogus bare path
      // (`[args["paths"]]`) — mode=pack's own per-entry coercion then
      // serialized it unchanged via `path: String(p)`, producing a
      // not-found item, an empty `read.batch` `entries:[]`, and a `next`
      // whose canonicalized `targets[].path` carried the raw JSON text
      // verbatim (mode=task_pack silently loses the seed path the same
      // way). Try JSON.parse first, accepting only an ARRAY result — a real
      // bare-path string (e.g. paths="src/foo.ts") is never valid JSON
      // array syntax, so it falls through to the unchanged single-element
      // wrap below untouched.
      const rawPathsString = args["paths"] as string;
      let parsedPathsArray: unknown[] | undefined;
      if (rawPathsString.trim().startsWith("[")) {
        try {
          const parsed: unknown = JSON.parse(rawPathsString);
          if (Array.isArray(parsed)) parsedPathsArray = parsed;
        } catch {
          // Not JSON — fall through to the bare-path wrap.
        }
      }
      args["paths"] = parsedPathsArray ?? [rawPathsString];
    }
    else if (args["paths"] !== undefined && !Array.isArray(args["paths"])) {
      return { refusal: { ok: false, code: "invalid-input", field: "paths", error: "paths must be an array (or one path string)", next: "read_file mode=task_pack paths=[\"path/to/file\"]" } };
    }
    if (args["mode"] === "slice" && Array.isArray(args["paths"]) && args["paths"].length > 1) {
      // F-V13-1 Fix C (DESIGN-v0.13-plan.md:167): this is a LEGACY-dialect
      // refusal site — a caller (or a stale/direct `mode=slice` call that
      // predates Fix A's promotion gating) landed here with an explicit
      // mode=slice over more than one path. It used to hand back a raw
      // STRING `next` built by hand: that skips BOTH the emitted-tool-call
      // canonicalizer (canonicalizeEmittedToolCalls only rewrites
      // OBJECT-shaped `arguments`, never a bare string) and the refusal's own
      // guidance-attachment pass (supplyRefusalGuidance's "already has a
      // next" guard treats a present-but-wrong string as done), so `cwd` —
      // required to re-issue this call against the SAME workspace — was
      // silently dropped from the recovery. Building the `next` through
      // canonicalToolCall the way every other executable recovery in this
      // file does fixes both: it is a real advertised-shape object next
      // (`{tool, arguments}`) and it carries `cwd` when the caller supplied
      // one. The prose `error` text keeps its legacy `mode=slice` vocabulary
      // on purpose — it is describing why this LEGACY spelling was refused,
      // not prescribing the recovery's own shape.
      return {
        refusal: {
          ok: false,
          code: "invalid-input",
          field: "paths",
          error: "mode=slice accepts one path; multiple paths are discovery scope",
          next: canonicalToolCall("read_file", {
            mode: "task_pack",
            paths: args["paths"],
            ...(args["cwd"] !== undefined ? { cwd: args["cwd"] } : {}),
          }),
        },
      };
    }
    if (typeof args["handles"] === "string") {
      args["handles"] = args["handles"].split(",").map((value) => value.trim()).filter(Boolean);
    }
    if (args["lines"] !== undefined) {
      if (args["range"] === undefined) args["range"] = String(args["lines"]);
      delete args["lines"];
    }
    if (args["start"] !== undefined && args["end"] !== undefined) {
      if (args["range"] === undefined) args["range"] = `${args["start"]}-${args["end"]}`;
      delete args["start"];
      delete args["end"];
    }
    if (typeof args["range"] === "string") {
      const range = args["range"].trim();
      const colon = /^(\d+)\s*:\s*(\d+)$/.exec(range);
      const eof = /^(\d+)\s*-$/.exec(range);
      if (colon) args["range"] = `${colon[1]}-${colon[2]}`;
      else if (eof) args["range"] = `${eof[1]}-${Number.MAX_SAFE_INTEGER}`;
    }
  }
  if (canonical === "search_files") {
    const aliases: Record<string, string> = {
      grep: "find", search: "find", list: "tree", def: "symbols",
      definitions: "symbols", usages: "references", callers: "references",
    };
    if (typeof args["action"] === "string") args["action"] = aliases[args["action"].toLowerCase()] ?? args["action"];
    if (args["action"] === undefined && (args["query"] !== undefined || args["queries"] !== undefined || args["symbol"] !== undefined)) args["action"] = "find";
    if (args["action"] === "find" && args["query"] === undefined && typeof args["symbol"] === "string") {
      args["query"] = args["symbol"];
      delete args["symbol"];
    }
    if (typeof args["queries"] === "string") args["queries"] = [args["queries"]];
    if (Array.isArray(args["query"])) {
      if (args["queries"] === undefined) args["queries"] = args["query"];
      delete args["query"];
    }
  }
  for (const field of ["limit", "maxTokens", "maxBytes", "depth"]) {
    if (typeof args[field] === "string" && /^\d+$/.test(args[field].trim())) args[field] = Number(args[field]);
  }
  if (typeof args["regex"] === "string") {
    args["regex"] = !["false", "0", "no", ""].includes(args["regex"].trim().toLowerCase());
  }
  return { args };
}

/**
 * I-7 (2026-08-30 forensics attribution wave): a BOUNDED shape classifier for
 * `post_ready_followup`'s `scope_class` -- never the raw path/query itself,
 * only which addressing family this call used. Checked handle first (names
 * exact already-served material), then path/paths/targets (names a
 * location), then query/queries/qref (open text) -- the same precedence a
 * caller's own intent would resolve to when a call names more than one.
 */
function discoveryScopeClass(args: Record<string, unknown>): "handle" | "path" | "query" | "none" {
  if (
    typeof args["handle"] === "string"
    || (Array.isArray(args["handles"]) && args["handles"].length > 0)
  ) {
    return "handle";
  }
  if (
    typeof args["path"] === "string"
    || (Array.isArray(args["paths"]) && args["paths"].length > 0)
    || (Array.isArray(args["targets"]) && args["targets"].length > 0)
  ) {
    return "path";
  }
  if (
    typeof args["query"] === "string"
    || typeof args["qref"] === "string"
    || (Array.isArray(args["queries"]) && args["queries"].length > 0)
  ) {
    return "query";
  }
  return "none";
}

async function dispatchTool(canonical: string, rawArgs: Record<string, unknown>): Promise<ToolCallResult> {
  const normalized = normalizeWireArgs(canonical, rawArgs);
  if ("refusal" in normalized) return toolStructuredError(normalized.refusal);
  const args = normalized.args;
  // T1/T2/T3 (2026-08-27 field-eval): resolve the DEFAULT response byte
  // ceiling once per dispatch -- explicit per-call maxBytes/maxTokens (read
  // at each serve site below) always override this; this is only the
  // fallback consulted when the caller supplies neither. Cheap (an env read
  // plus a Map lookup) and harmless to compute unconditionally even for a
  // tool call that never consults it (edit_file, mode=slice, ...). See
  // clientProfile.ts's resolveDefaultResponseByteCeiling for the
  // env/profile precedence.
  const defaultResponseByteCeiling = resolveDefaultResponseByteCeiling(
    resolveClientProfile(resolvedClientId()),
    process.env["TOKENLIGHTEN_TASK_PACK_MAX_BYTES"],
  );
  switch (canonical) {
    case "read_file": {
      // P1 / D2 / ORCHESTRATOR CONDITION ② (§1.3.1(1)): strict recursive NAME
      // validation, before any cwd/handle/credential resolution or
      // session-state mutation — the same position edit_file's own guard has
      // held since 2026-08-01. Value validation is untouched (§1.3.1(6)):
      // `lang` is still a bare string checked by parseMcpLang below.
      const unknownArgsRefusalRead = requestShapeRefusal("read_file", dispatchPropertiesFor("read_file"), args);
      if (unknownArgsRefusalRead !== null) return toolStructuredError(unknownArgsRefusalRead);
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
      // PI-09: a presented task_handle is validated against THIS workspace
      // before any read runs, so a wrong-purpose/stale/foreign handle can never
      // ride along as a silent no-op.
      const taskHandleRefusalRead = taskHandleRefusal(args, workspace);
      if (taskHandleRefusalRead !== null) return toolStructuredError(taskHandleRefusalRead);
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
      const keepComments = commentsMode.keep;

      // W1 served-content receipts: an EXPLICIT request for bytes always wins
      // over "you already have this". A caller that lost its context to
      // compaction genuinely does not hold what the session ledger says it was
      // served, so `content:"full"` / `allowFull:true` force a normal body
      // serve on every receipt-eligible read path (the receipt's own `note`
      // states this — see SERVED_CONTENT_RECEIPT_NOTE).
      //
      // PI-09 close-out: `force_serve:true` is the EXPLICIT spelling of that
      // same request. `content:"full"`/`allowFull:true` mean "serve the whole
      // file" and force a serve only as a side effect; `force_serve` says the
      // thing itself, at any mode and any range, and is the recovery a
      // context-compacted caller can execute without also changing WHAT it
      // asked for. Folded into the one existing lever so every receipt-
      // eligible read path honours it by construction rather than by a list.
      const forceContentServe = args["content"] === "full"
        || args["allowFull"] === true
        || args["force_serve"] === true;

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
          next: `read_file targets=${JSON.stringify([{ ...locator, ranges: [resolvedRange, ...rangesArg] }])}`,
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
          next: `read_file mode=slice archive={"path":"${archiveSelector.path}","member":"${archiveSelector.member}"} range=${rangesArg[0]}`,
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
            next: 'read_file path=<the file this handle pointed at> — or start fresh: read_file mode=task_pack query="<restate the request verbatim>"',
            // PI-09: this used to say "handles are session-scoped and do not
            // survive a server restart". They now do, when the workspace has a
            // durable state store — so the honest statement is the narrower
            // one: THIS handle is not resolvable here, and a path re-read
            // always re-mints. Overstating the loss taught agents to abandon
            // live handles.
            hint: "this handle is not resolvable in this workspace (expired, evicted, or minted elsewhere); re-reading by path re-mints one",
            alternatives: [{ mode: "task_pack" }],
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
                next: handleWorkspaceMissingNext(res.handleWorkspace),
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
              next: `retry with cwd=${hEntry.workspaceRoot} or omit cwd`,
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
        noteDiscoveryServedNoBytes(discoveryGuardWorkspace, "read_file", discoveryGuardArgs);
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
      const executionGuard = args["force_serve"] === true
        || (mode !== "full" && forceContentServe && !postReadyTrimEnabled())
        ? { allowed: true as const }
        : guardExecutionDiscovery(
            workspace,
            "read_file",
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
          );
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
        // range-per-item shape. Refuse the WHOLE batch with a concrete
        // task_pack recovery instead of silently falling back to that
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
            next: canonicalToolCall("read_file", { mode: "task_pack", paths: recoveryPaths }),
          });
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
              // The conflicting roots ride the prose because the v1 advisory
              // allowlist drops handleWorkspaces: without them the caller
              // cannot know WHICH workspaces collided (2026-08-09 guard class).
              next: `all handles in one batch must share a workspace (got: ${res.roots.join(", ")}); omit cwd or pass a single cwd`,
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
              next: handleWorkspaceMissingNext(res.handleWorkspace),
            });
          }
          if (res.kind === "adopt") workspace = res.workspace;
        }

        // A.5.4: a multi-target serve reporting per-item completeness is
        // `read.batch` whatever `mode` says — this branch runs BEFORE any mode
        // branch, so the member is a function of `handles[]`, not of `mode`.
        declareKind("read.batch");

        recordReadMode(workspace, "handles");
        const items: Array<{ handle: string; path: string; range: string; content: string; truncated: boolean; sha: string; note?: string; concern_note?: string; downgraded_from?: "symbol"; remaining_ranges?: string[]; next?: string; synthesized_range?: boolean }> = [];
        // D1: reason stays the stable enum every existing caller matches on;
        // code/candidates/skeleton are additive fields carried ONLY for a
        // symbol-not-found miss from resolveSlice, so unrelated omitted
        // shapes (handle-unknown, handle-workspace-mismatch, cap-exceeded)
        // are untouched.
        const omitted: Array<{
          handle: string;
          reason: "handle-unknown" | "handle-workspace-mismatch" | "not-found" | "cap-exceeded";
          code?: "not-found" | "range-invalid";
          candidates?: string[];
          skeleton?: string;
          next?: string;
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
        const handlesBatchCeiling = resolveCallerByteCeiling(
          typeof args["maxBytes"] === "number" ? args["maxBytes"] : undefined,
          typeof args["maxTokens"] === "number" ? args["maxTokens"] : undefined,
          defaultResponseByteCeiling,
        );
        let handlesBatchBytesSoFar = 0;
        let handlesBatchCapHit = false;

        for (let hIdx = 0; hIdx < requested.length; hIdx++) {
          const hId = requested[hIdx]!;
          if (handlesBatchCapHit) {
            omitted.push({ handle: hId, reason: "cap-exceeded" });
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
          if (virtual) {
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
              hContent = memberResult.ok ? memberResult.data.content : null;
            }
          } else {
            hContent = await readFileSafe(hPath, workspace);
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
          const override = handleOverrides?.[hIdx];
          const overrideRange = typeof override?.["range"] === "string" ? override["range"] : undefined;
          const overrideSymbol = typeof override?.["symbol"] === "string" ? override["symbol"] : undefined;
          const effectiveRange = overrideRange ?? hEntry.range;
          const effectiveSymbol = overrideSymbol ?? (overrideRange === undefined ? hEntry.symbol : undefined);
          const isSynthesizedFileRange = effectiveRange === undefined && effectiveSymbol === undefined;
          const hRange = effectiveRange
            ?? (effectiveSymbol === undefined ? `1-${Math.max(1, countLines(hContent))}` : undefined);
          const sliceResult = await resolveSlice(workspace, hPath, hContent, effectiveSymbol, hRange);
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
          const itemDisplay = keepComments
            ? { content: sliceResult.data.content, note: undefined as string | undefined }
            : elideDocCommentsForDisplay(
                sliceResult.data.content,
                languageForPath(hPath),
                false,
                sliceResult.data.assembled ? 1 : rangeStartLine(sliceResult.data.range),
              );
          const itemNote = [sliceResult.data.note, itemDisplay.note].filter(Boolean).join("; ") || undefined;
          // S1 (2026-08-07): BOOK WHAT THIS BATCH ACTUALLY SERVES. This path
          // put bodies on the wire and recorded nothing, so every later
          // consumer of the served-range ledger — code_unchanged receipts, the
          // full governor, and now the verification kit's per-entry collapse —
          // still believed those bytes were unserved. The kit's own
          // `verification.next_call` IS this call, so an omitted body the
          // caller fetched came back inlined again on the next edit: the exact
          // repeat S1 exists to remove. Booked through
          // servedSpansOfDisplayedText like every other serve path, so elided
          // comment blocks stay in `unserved` and no span is claimed that the
          // wire did not carry (2026-08-02 serve-honesty).
          if (!sliceResult.data.assembled && !virtual) {
            const itemStart = rangeStartLine(sliceResult.data.range);
            const itemTotalLines = countLines(hContent);
            const itemEnd = Math.min(
              itemTotalLines,
              itemStart + countLines(sliceResult.data.content) - 1,
            );
            const itemCall = beginServeCall(workspace);
            for (const [spanStart, spanEnd] of servedSpansOfDisplayedText(itemStart, itemDisplay.content, itemEnd)) {
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
          // T2: account AFTER commit, never before -- an item that itself
          // crosses the ceiling still ships whole (see the doc comment above
          // handlesBatchCeiling); only ITEMS AFTER IT are deferred.
          if (handlesBatchCeiling !== undefined) {
            handlesBatchBytesSoFar += Buffer.byteLength(itemDisplay.content, "utf8");
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
      if (
        outerArchivePath &&
        isSupportedArchivePath(outerArchivePath) &&
        (mode === "archive" || mode === "auto")
      ) {
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
        // `content`, `warnings`) and a bare-string `next`, instead of the
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
          next: `read_file mode=archive path=${outerArchivePath}`,
        });
      }

      // -----------------------------------------------------------------------
      // Pathless query entry: a caller asking "find/read context for this task"
      // without a path is exploring, not requesting a file auto-read. Route the
      // natural read_file({ query }) shape to task_pack instead of falling
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
          declareKind("read.task_pack");
          const promoteLang = parseMcpLang(args["lang"]);
          const taskContractScope = taskContractScopeOf(args);
          const result = await runWithTaskContractScope(taskContractScope, () => buildTaskPack(
            ({
              ...taskCredential,
              // Internal-only: the producer's no-repeat gate needs the same
              // normalized lane that records successful next execution.
              lane: normalizeContractLane(taskContractScope.lane),
              ...(typeof args["taskEpoch"] === "string" ? { taskEpoch: args["taskEpoch"] } : {}),
              // PI-09 close-out: the explicit "I lost my context" switch.
              ...(args["force_serve"] === true ? { forceServe: true as const } : {}),
              ...(queryArg.length > 0
                ? {
                    query: queryArg,
                    evidenceShadowQref: taskQueryRef(workspace, queryArg),
                  }
                : {}),
              // C2: a qref replay is a call over a working set the caller still
              // holds, so a context-only addition must not re-derive coverage.
              ...(taskPackQuery.fromRef === true ? { taskQueryRefReplay: true as const } : {}),
              ...(parseTaskProfile(args["taskProfile"]) ? { taskProfile: parseTaskProfile(args["taskProfile"]) } : {}),
              ...(promoteLang ? { lang: promoteLang } : {}),
              ...(typeof args["limit"] === "number" ? { limit: args["limit"] } : {}),
              ...(Array.isArray(args["surfaceRoles"]) ? { surfaceRoles: (args["surfaceRoles"] as unknown[]).map(String) } : {}),
              ...(hasPathList ? { paths: mapTaskPackPaths(args["paths"] as unknown[]) } : {}),
              ...(typeof args["maxBytes"] === "number" ? { maxBytes: args["maxBytes"] } : {}),
              ...(typeof args["maxTokens"] === "number" ? { maxTokens: args["maxTokens"] } : {}),
              ...(defaultResponseByteCeiling !== undefined ? { clientDefaultByteCeilingHint: defaultResponseByteCeiling } : {}),
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
            ? rememberTaskQuery(workspace, taskPackQuery.query)
            : undefined;
          const supplied = issuedRef !== undefined
            ? { ...suppliedBase, qref: issuedRef }
            : suppliedBase;
          recordTaskPackExecution(workspace, queryArg, supplied, taskContractScope);
          return toolOk(attachServerBuildOnce(supplied, workspace));
        }
      }

      // -----------------------------------------------------------------------
      // mode=task_pack — v0.7 task closure pack.
      // -----------------------------------------------------------------------
      if (mode === "task_pack") {
        const taskPackStartedAt = Date.now();
        trace("task_pack_start", {
          query_chars: taskPackQuery.query.length,
          task_profile: args["taskProfile"] ?? null,
        }, workspace);
        recordReadMode(workspace, "task_pack");
        // D10 (2026-08-14): `TL_TASK_PACK` is deleted; the flagship pack is
        // unconditional, so the `task-pack-disabled` refusal is unreachable and
        // is gone with it.
        const tpLang = parseMcpLang(args["lang"]);
        const tpHasPaths = Array.isArray(args["paths"]) && (args["paths"] as unknown[]).length > 0;
        // 11a parity for the pack path (2026-07-30): a caller-supplied range
        // must actually reach the pack builder. It was dropped here entirely,
        // so a remaining_ranges zoom (task_pack handle+range) rebuilt the
        // handle's SYMBOL view and re-served the same head — remaining_ranges
        // never advanced (live loop, run 2026-07-30-semantic-signal5-2 T03).
        const tpZoomPaths = !tpHasPaths && resolvedPath !== undefined && resolvedRange !== undefined
          ? [{ path: resolvedPath, range: resolvedRange }]
          : undefined;
        const taskContractScope = taskContractScopeOf(args);
        const result = await runWithTaskContractScope(taskContractScope, () => buildTaskPack(
          ({
            ...taskCredential,
            // Internal-only execution identity; never projected to the wire.
            lane: normalizeContractLane(taskContractScope.lane),
            ...(typeof args["taskEpoch"] === "string" ? { taskEpoch: args["taskEpoch"] } : {}),
            // PI-09 close-out: the explicit "I lost my context" switch.
            ...(args["force_serve"] === true ? { forceServe: true as const } : {}),
            query: taskPackQuery.query.length > 0 ? taskPackQuery.query : undefined,
            ...(taskPackQuery.query.length > 0
              ? {
                  evidenceShadowQref: taskQueryRef(workspace, taskPackQuery.query),
                }
              : {}),
            // C2: see the sibling promotion branch above.
            ...(taskPackQuery.fromRef === true ? { taskQueryRefReplay: true as const } : {}),
            ...(parseTaskProfile(args["taskProfile"]) ? { taskProfile: parseTaskProfile(args["taskProfile"]) } : {}),
            ...(resolvedPath && tpZoomPaths === undefined ? { path: resolvedPath } : {}),
            ...(resolvedSymbol ? { symbol: resolvedSymbol } : {}),
            ...(tpLang ? { lang: tpLang } : {}),
            ...(typeof args["limit"] === "number" ? { limit: args["limit"] } : {}),
            ...(Array.isArray(args["surfaceRoles"]) ? { surfaceRoles: (args["surfaceRoles"] as unknown[]).map(String) } : {}),
            // A1: paths[] was advertised in the schema but silently dropped
            // here — an agent handing task_pack the exact correct files got
            // 0 of them back and escaped to native reads. Same shape-map as
            // mode=pack (below) so both entry points parse identically.
            // FIX (2026-07-09e forensics): a bare-string entry has no .path,
            // so the object-shaped mapping used to coerce it straight to
            // path:"" before buildTaskPack's own bare-string normalizer
            // (readCodeTaskPack.ts's normalizePathEntry) ever saw the
            // original string — mirror mode=full's paths[] coercion (~:6871)
            // so a bare string becomes {path: String(p)} instead. Factored
            // into mapTaskPackPaths (2026-07-10a) so the mode-unspecified/
            // "auto" promotion above shares the identical mapping.
            ...(tpHasPaths
              ? { paths: mapTaskPackPaths(args["paths"] as unknown[]) }
              : tpZoomPaths !== undefined
                ? { paths: tpZoomPaths }
                : {}),
            ...(typeof args["maxBytes"] === "number" ? { maxBytes: args["maxBytes"] } : {}),
            ...(typeof args["maxTokens"] === "number" ? { maxTokens: args["maxTokens"] } : {}),
            ...(defaultResponseByteCeiling !== undefined ? { clientDefaultByteCeilingHint: defaultResponseByteCeiling } : {}),
          }) as unknown as Parameters<typeof buildTaskPack>[0],
          workspace,
        ));
        // Feature 1 (2026-07-12b2): task_pack surfaces with embedded code count as read.
        recordTaskPackSurfaceReads(workspace, result);
        // V11-04 (TL_REASONING_IR_V2, class (B), default OFF): the ONE advisory
        // Task Reasoning IR v2 seam. It reads the finished pack BEFORE protocol
        // projection, persists IR state, and emits trace-only shadow Stop
        // candidates. It returns void and cannot touch `result`: with the flag
        // unset this branch is not entered, and with it set the helper is
        // try/catch-total, so an IR failure traces `reasoning_ir_error` and the
        // response bytes are unchanged either way. No wire field, no new kind.
        if (reasoningIrV2Enabled()) {
          recordReasoningIrV2FromPack({
            result,
            workspaceRoot: workspace,
            lane: sessionLaneOf(args as Record<string, unknown>),
            ...(taskPackQuery.query.length > 0 ? { query: taskPackQuery.query } : {}),
          });
        }
        // DESIGN-v0.9 §4.7: shared read-side post-processor (see the sibling
        // pack sites) — continuation/inlined normalization + FORBIDDEN_KEYS.
        const suppliedBase = attachSupply(result as unknown as Record<string, unknown>, workspace);
        // W2 (2026-07-30): see the sibling pathless-exploratory branch above —
        // re-issue on any non-empty resolved query (fresh OR qref-replay) so a
        // qref never reads as expired after a single use.
        const issuedRef = taskPackQuery.query.length > 0
          ? rememberTaskQuery(workspace, taskPackQuery.query)
          : undefined;
        const supplied = issuedRef !== undefined
          ? { ...suppliedBase, qref: issuedRef }
          : suppliedBase;
        recordTaskPackExecution(
          workspace,
          taskPackQuery.query,
          supplied,
          taskContractScope,
        );
        trace("task_pack_end", {
          elapsed_ms: Date.now() - taskPackStartedAt,
          bytes: Buffer.byteLength(JSON.stringify(supplied), "utf8"),
          coverage: result.coverage,
          surfaces: result.surfaces.length,
        }, workspace);
        return toolOk(attachServerBuildOnce(supplied, workspace));
      }

      // -----------------------------------------------------------------------
      // mode=map — R0: surface map (no code body).
      // -----------------------------------------------------------------------
      if (mode === "map") {
        recordReadMode(workspace, "map");
        // mode=map paths=[...] — multi-file signature map. 2026-07-16 skc2
        // microbench Q1: paths[] was ignored entirely here (map required a
        // query and answered through the 1024-byte surface locator), so the
        // product's only 64KB-capped multi-file map (skeleton-engine's
        // buildSkeleton/renderSkeleton) was unreachable from the MCP tool
        // surface — and nothing enforced ANY total budget on a multi-file
        // map-shaped serve. This branch serves one per-file signature block
        // per requested file (each block already capped by getFileSkeleton's
        // own MAX_RESPONSE_BYTES) and enforces MULTI_FILE_MAP_CAP_BYTES over
        // the serialized files[] section with 5b252d24's trim semantics:
        // deterministic FILE-BOUNDARY trim — request order, whole blocks
        // dropped from the tail once the budget is exhausted, never a
        // mid-block cut — plus the explicit 'tokenlighten:skeleton-truncated'
        // indicator skeleton-engine's footer uses. The singular
        // query/path/symbol surface-locator map below is unchanged.
        const mapPathsRaw = Array.isArray(args["paths"]) ? (args["paths"] as unknown[]) : [];
        if (mapPathsRaw.length > 0) {
          if (typeof args["query"] === "string" && (args["query"] as string).trim().length > 0) {
            return toolError("paths[] and query are mutually exclusive for mode=map", { code: "invalid-input" });
          }
          // Same bare-string/object coercion as mode=full's batch below;
          // duplicates collapse to the first occurrence so the tail trim
          // stays order-deterministic.
          const mapPaths = [...new Set(mapPathsRaw.map((p) =>
            typeof p === "object" && p !== null ? String((p as Record<string, unknown>)["path"] ?? "") : String(p),
          ))];
          const mapFiles: Record<string, unknown>[] = [];
          const mapOmitted: Array<{ path: string; reason: string }> = [];
          let mapServedBytes = 0;
          let mapCapReached = false;
          for (const p of mapPaths) {
            if (!p) { mapOmitted.push({ path: p, reason: "path is required" }); continue; }
            if (mapCapReached) { mapOmitted.push({ path: p, reason: "map-byte-cap" }); continue; }
            const mapContent = await readFileSafe(p, workspace);
            if (mapContent === null) {
              const mapAbs = safeResolve(p, workspace);
              const mapIsDir = mapAbs !== undefined && existsSync(mapAbs) && statSync(mapAbs).isDirectory();
              mapOmitted.push({
                path: p,
                reason: mapIsDir
                  ? "is a directory — pass file paths; for inventory use search_files action=tree"
                  : `File not found or outside workspace: ${p}`,
              });
              continue;
            }
            const blockResult = await getFileSkeleton(mapContent, { path: p });
            if (!blockResult.ok) { mapOmitted.push({ path: p, reason: blockResult.error }); continue; }
            const entry: Record<string, unknown> = {
              path: p,
              language: blockResult.data.language,
              handle: handleTable.upsert({ kind: "file", path: p, workspaceRoot: workspace }).id,
              signatures: blockResult.data.signatures,
              truncated: blockResult.data.truncated,
            };
            // Serialized-entry accounting (+1 for the array separator): the
            // budget covers path/handle overhead, not just signature text, so
            // the files[] section as a whole can never exceed the cap.
            const entryBytes = Buffer.byteLength(JSON.stringify(entry), "utf8") + 1;
            if (mapServedBytes + entryBytes > MULTI_FILE_MAP_CAP_BYTES) {
              mapCapReached = true;
              mapOmitted.push({ path: p, reason: "map-byte-cap" });
              continue;
            }
            mapServedBytes += entryBytes;
            mapFiles.push(entry);
            recordReadPath(workspace, p);
          }
          const mapTrimmed = mapOmitted.filter((o) => o.reason === "map-byte-cap");
          return toolOk({
            mode: "map",
            files: mapFiles,
            omitted: mapOmitted,
            completeness: mapOmitted.length === 0 ? "complete" : mapFiles.length === 0 ? "empty" : "partial",
            truncated: mapTrimmed.length > 0,
            ...(mapTrimmed.length > 0
              ? {
                  map_cap_bytes: MULTI_FILE_MAP_CAP_BYTES,
                  note: `${mapTrimmed.length} file block(s) omitted to fit map_cap_bytes — tokenlighten:skeleton-truncated; re-scope with fewer paths[]`,
                  next: `read_file mode=map paths=${JSON.stringify(mapTrimmed.slice(0, 3).map((o) => o.path))}`,
                }
              : {}),
          });
        }
        const mapResult = await resolveMap(workspace, {
          query: args["query"] ? String(args["query"]) : resolvedPath ?? resolvedSymbol ?? "",
          ...(resolvedPath ? { path: resolvedPath } : {}),
          ...(resolvedSymbol ? { symbol: resolvedSymbol } : {}),
          ...(args["lang"] ? { lang: String(args["lang"]) } : {}),
        });
        if (!mapResult.ok) {
          // Row 11 (C2-6): a genuine refusal, not a made-up hit:false success
          // shape — see mapMissRefusalCode's doc comment.
          return toolStructuredError({
            ok: false,
            code: mapMissRefusalCode(mapResult.reason),
            detail: mapResult.reason,
          });
        }
        return toolOk(mapResult.data);
      }

      // -----------------------------------------------------------------------
      // mode=overview — broad repo/package map for "what is this system?" tasks.
      // -----------------------------------------------------------------------
      if (mode === "overview") {
        recordReadMode(workspace, "map");
        if (resolvedPath && isMarkdownPath(resolvedPath)) {
          const markdown = await readFileSafe(resolvedPath, workspace);
          if (markdown === null) return toolError(`File not found or outside workspace: ${resolvedPath}`, { code: "not-found" });
          const headings = parseMarkdownHeadings(markdown);
          const fullSha = shaOfText(markdown);
          const fileHandle = handleTable.upsert({
            kind: "file",
            path: resolvedPath,
            workspaceRoot: workspace,
            sha: fullSha,
          });
          const summary = markdown
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter((line) => line && !/^#{1,6}\s/.test(line) && !/^(```|---$|<!--)/.test(line))
            .slice(0, 3)
            .join(" ")
            .slice(0, 600);
          // Entry cap alone is not enough (see DOC_HEADINGS_CAP_* — the
          // md_4800kb envelope regression): pathological generated headings
          // can still bloat a fixed entry count, so the serialized sections
          // list shares the outline byte cap.
          const sections = capEnvelopeArray(
            headings.slice(0, DOC_HEADINGS_CAP_ENTRIES).map((heading) => ({
              heading: heading.text,
              section: heading.path,
              level: heading.level,
              range: `${heading.line}-${heading.endLine}`,
            })),
            DOC_HEADINGS_CAP_ENTRIES,
            DOC_HEADINGS_CAP_BYTES,
          );
          const firstSection = sections.find((section) => section.level > 1) ?? sections[0];
          return toolOk({
            mode: "overview",
            kind: "markdown",
            path: resolvedPath,
            handle: fileHandle.id,
            sha: shortSha(fullSha),
            ...(headings[0] ? { title: headings[0].text } : {}),
            ...(summary ? { summary } : {}),
            sections,
            truncated: headings.length > sections.length,
            ...(headings.length > sections.length ? { sections_total: headings.length } : {}),
            ...(firstSection ? {
              next_call: { tool: "read_file", arguments: { path: resolvedPath, sections: [firstSection.section] } },
            } : {}),
          });
        }
        return toolOk(buildOverview(workspace, {
          ...(args["maxTokens"] !== undefined ? { maxTokens: Number(args["maxTokens"]) } : {}),
          ...(Array.isArray(args["sections"]) ? { sections: (args["sections"] as unknown[]).map(String) } : {}),
          ...(resolvedPath ? { path: resolvedPath } : {}),
        }));
      }

      // Markdown section read: the existing sections[] field provides a
      // direct heading -> range-handle route for ordinary repository docs.
      // The returned handle is the same exact range handle edit_file accepts
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
      if (
        (mode === "auto" || mode === "slice" || mode === "symbol") &&
        resolvedPath &&
        isMarkdownPath(resolvedPath) &&
        (requestedMarkdownSections.length > 0 || markdownSymbolSection !== undefined)
      ) {
        // A capped section list is a partial serve, never a refusal: callers
        // already supplied the remaining headings, so the server can return a
        // literal continuation without making them reconstruct the request.
        const markdownSectionCap = 8;
        const cappedMarkdownSections = requestedMarkdownSections.slice(0, markdownSectionCap);
        const remainingMarkdownSections = requestedMarkdownSections.slice(markdownSectionCap);
        const markdown = await readFileSafe(resolvedPath, workspace);
        if (markdown === null) return toolError(`File not found or outside workspace: ${resolvedPath}`, { code: "not-found" });
        const headings = parseMarkdownHeadings(markdown);
        const sectionQueries = markdownSymbolSection !== undefined
          ? [markdownSymbolSection]
          : cappedMarkdownSections;
        const selected = selectMarkdownSections(headings, sectionQueries);
        const ambiguityCandidates = selected.ambiguous
          .flatMap((entry) => entry.candidates.map((heading) => ({
            query: entry.query,
            heading: heading.text,
            section: heading.path,
            range: String(heading.line) + "-" + String(heading.endLine),
          })))
          .slice(0, 6);
        const firstCandidate = ambiguityCandidates[0];

        if (selected.matches.length === 0) {
          // ND-1: the requested sections/symbol resolved to no heading, so
          // this call serves no file bytes — a later identical repeat must get
          // this same self-healing miss, never a residency claim minted from
          // the file-level served-range ledger.
          noteZeroByteServe();
          // R1: a doc symbol-miss answers with the heading map + a concrete
          // sections call, never the old whole-file redirect.
          if (markdownSymbolSection !== undefined) {
            return toolStructuredError(markdownSymbolMissPayload({
              path: resolvedPath,
              symbol: markdownSymbolSection,
              content: markdown,
            }));
          }
          const missPayload: Record<string, unknown> = {
            ok: false,
            code: selected.ambiguous.length > 0 ? "markdown-section-ambiguous" : "markdown-section-not-found",
            path: resolvedPath,
            ...(selected.missing.length > 0 ? { missing: selected.missing } : {}),
            ...(ambiguityCandidates.length > 0 ? { candidates: ambiguityCandidates } : {}),
          };
          // headings[] supersedes the old flat `outline` (same names, plus
          // level + the section range mode=slice needs) — one vocabulary, and
          // strictly fewer bytes than carrying both.
          attachMarkdownHeadingIndex(missPayload, markdown);
          // A missed section name is still a lexical signal: propose the
          // closest headings instead of "re-read the whole doc" (the live R1
          // hint, which cost more than the native slice it competed with).
          const missSimilar = similarHeadingTexts(headings, selected.missing[0] ?? sectionQueries[0] ?? "", 3);
          missPayload["next"] = firstCandidate
            ? `read_file path=${JSON.stringify(resolvedPath)} sections=${JSON.stringify([firstCandidate.section])}`
            : missSimilar.length > 0
              ? `read_file path=${JSON.stringify(resolvedPath)} sections=${JSON.stringify(missSimilar)}`
              : `read_file mode=overview path=${JSON.stringify(resolvedPath)}`;
          return toolStructuredError(missPayload);
        }

        const items: Record<string, unknown>[] = [];
        for (const heading of selected.matches) {
          const range = String(heading.line) + "-" + String(heading.endLine);
          const sliceResult = await resolveSlice(workspace, resolvedPath, markdown, undefined, range);
          if (!sliceResult.ok) {
            return toolStructuredError({
              ok: false,
              code: "markdown-section-read-failed",
              path: resolvedPath,
              section: heading.path,
              error: sliceResult.error,
            });
          }
          const data = sliceResult.data;
          items.push({
            heading: heading.text,
            section: heading.path,
            level: heading.level,
            style: heading.style,
            range: data.range,
            handle: data.handle,
            sha: shortSha(data.sha),
            content: keepComments
              ? data.content
              : elideDocComments(data.content, "markdown", rangeStartLine(data.range)),
            truncated: data.truncated,
            ...(data.truncated ? { note: "section truncated; follow next before handle+content replacement" } : {}),
            ...(data.next ? { next: data.next } : {}),
          });
        }

        const omitted = [
          ...selected.missing.map((section) => ({ section, reason: "not-found" })),
          ...selected.ambiguous.map((entry) => ({
            section: entry.query,
            reason: "ambiguous",
            candidates: entry.candidates.slice(0, 3).map((heading) => heading.path),
          })),
        ];
        const continuation = remainingMarkdownSections.length > 0
          ? `read_file path=${JSON.stringify(resolvedPath)} sections=${JSON.stringify(remainingMarkdownSections)}`
          : omitted.length > 0 && firstCandidate
          ? `read_file path=${JSON.stringify(resolvedPath)} sections=${JSON.stringify([firstCandidate.section])}`
          : undefined;

        // A section serve is a PARTIAL surface unless the matched sections
        // happen to cover the file: carry the heading index so the next hop
        // is another sections call instead of a native grep for line numbers.
        const servedLines = selected.matches.reduce((sum, heading) => sum + (heading.endLine - heading.line + 1), 0);
        const partialServe = servedLines < countLines(markdown);
        const focus = {
          start: Math.min(...selected.matches.map((heading) => heading.line)),
          end: Math.max(...selected.matches.map((heading) => heading.endLine)),
        };

        if (sectionQueries.length === 1 && items.length === 1 && omitted.length === 0) {
          const single: Record<string, unknown> = {
            mode: "markdown-section",
            path: resolvedPath,
            ...items[0],
          };
          if (partialServe) attachMarkdownHeadingIndex(single, markdown, focus);
          return toolOk(single);
        }
        const multi: Record<string, unknown> = {
          mode: "markdown-sections",
          path: resolvedPath,
          items,
          omitted,
          // The v1 read-text projector carries continuation values through
          // Evidence.remaining.  Section names are the addressable values for
          // this surface (rather than line windows), but retain the familiar
          // carrier so the continuation survives projection.
          ...(remainingMarkdownSections.length > 0 ? { remaining_ranges: remainingMarkdownSections } : {}),
          completeness: omitted.length === 0 && remainingMarkdownSections.length === 0 ? "complete" : "partial",
          ...(continuation ? { next: continuation } : {}),
        };
        if (partialServe) attachMarkdownHeadingIndex(multi, markdown, focus);
        return toolOk(multi);
      }

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
      if (mode === "closure") {
        recordReadMode(workspace, "closure");
        const computed = computeClosureStateSafe(workspace);
        // W5 (2026-07-25 T10 verify-fail forensics): an artifact-backed
        // executable create/edit carries a functional-validation obligation.
        // It is DISCLOSED here as an open item — never a refusal — and is
        // discharged by a diff review (search_files action=diff), the only
        // verification-evidence event this server can observe directly.
        const w5Obligation = getFunctionalValidationObligation(workspace, []);
        const w5OpenItem = w5Obligation === undefined
          ? undefined
          : `${w5Obligation.targetPath}: ${w5Obligation.note}`.slice(0, 140);
        if (computed === undefined || computed.total === 0) {
          return toolOk(withVerificationSection({
            mode: "closure", open: w5OpenItem === undefined ? [] : [w5OpenItem], done: 0, total: 0, complete: false,
            // 2026-08-01: names the gate's applicability instead of leaving
            // "complete:false" to read as "task incomplete" on read-only
            // sessions. Deliberately NOT an affirmative completion signal —
            // FIX-1's hollow-completion fence (complete:false) stays.
            applicability: "no-registered-checks",
            note: "no closure checks were registered for this session — completeness NOT verified; verify with git diff / tests (this call is only needed after an edit response carried a closure field)",
            summary: closureSessionSummary(workspace, 0),
          }, workspace));
        }
        const open = computed.open
          .slice(0, 8)
          .map((c) => (c.desc.length > 140 ? c.desc.slice(0, 140) : c.desc));
        if (w5OpenItem !== undefined && open.length < 8) open.push(w5OpenItem);
        const closureIsComplete = computed.open.length === 0 && w5Obligation === undefined;

        // 2026-07-16a re-read-loop forensics: sibling of attachClosure's own flag-sync (see
        // closureTracking.ts) — this read path recomputes the SAME
        // closureSatisfied flag on every mode=closure call so a stale
        // edit-path evaluation can never leave the flag out of sync with
        // what the agent was just told here.
        if (closureIsComplete) {
          markClosureSatisfied(workspace);
        } else {
          clearClosureSatisfied(workspace);
        }

        // A closure evaluation that reaches the same open set adds no evidence
        // and must not re-emit the same descriptions.  `attachClosure` records
        // the edit response's open/closed state through this same ledger, so a
        // ceremonial closure immediately after that response also converges to
        // a receipt.  The functional-validation item is part of the identity:
        // its presence is an open capability gap even though it is not a pack
        // check record.
        const closureIds = [
          ...computed.open.map((check) => check.id),
          ...(w5Obligation === undefined ? [] : [`functional:${w5Obligation.targetPath}`]),
        ];
        const previousClosureIds = recordClosureReport(workspace, closureIds);
        const unchangedClosure = previousClosureIds.length === closureIds.length
          && previousClosureIds.every((id, index) => id === closureIds[index]);
        if (unchangedClosure) {
          // D3(a) (C2-3): `closure-unchanged` IS NOT A RECEIPT FORM in v1 and
          // its name is not even reserved — "a freeze must not invent wire
          // vocabulary". The two real cases it conflated separate:
          //
          //  - everything closed  -> the A.4 `closure-complete` receipt, which
          //    is exactly "all registered checks closed" with its counts;
          //  - still open, same set -> a plain `read.closure` (A.5.7). The
          //    economy this branch exists for is preserved by reporting the
          //    OBLIGATION IDS rather than re-sending the descriptions — and
          //    A.5.7's `open` is documented as "obligation ids still open", so
          //    the ids are the field's own semantics, not a downgrade. Emitting
          //    `open: []` here (the old shape carried no `open` at all) would
          //    have asserted completeness under A.5.7's `open.length === 0`
          //    rule, which is precisely the false claim §4.4 forbids.
          return toolOk(withVerificationSection(closureIsComplete
            ? {
                mode: "closure",
                receipt: "closure-complete",
                done: computed.done,
                total: computed.total,
                closure_complete: true,
              }
            : {
                mode: "closure",
                open: closureIds.slice(0, 8),
                done: computed.done,
                total: computed.total,
                note: "same open set as the last closure report — ids only, descriptions were served earlier",
              }, workspace));
        }

        return toolOk(withVerificationSection(closureIsComplete
          ? {
              // A.5.7 is explicit: "the `closure_complete: true` case is NOT
              // this member — it is the `closure-complete` receipt (A.4)".
              mode: "closure",
              receipt: "closure-complete",
              done: computed.done,
              total: computed.total,
              closure_complete: true,
              summary: closureSessionSummary(workspace, computed.done),
              note: CLOSURE_SATISFIED_NOTE,
            }
          : {
              mode: "closure",
              open,
              done: computed.done,
              total: computed.total,
            }, workspace));
      }

      // -----------------------------------------------------------------------
      // mode=digest — R1: file/symbol digest.
      // -----------------------------------------------------------------------
      if (mode === "digest") {
        const digestPath = resolvedPath ?? "";
        if (!digestPath) return toolError("path (or handle) is required for mode=digest", { code: "invalid-input" });
        const content = await readFileSafe(digestPath, workspace);
        if (content === null) return toolError(`File not found or outside workspace: ${digestPath}`, { code: "not-found" });
        const digestResult = await resolveDigest(workspace, digestPath, content, resolvedSymbol);
        // dead at HEAD (see C2-6 audit): resolveDigest has no ok:false
        // return path; coded honestly for the day it does.
        if (!digestResult.ok) return toolError(digestResult.error, { code: "invalid-input" });
        return toolOk(digestResult.data);
      }

      // -----------------------------------------------------------------------
      // mode=slice — R2: exact symbol/range slice with handle + sha.
      // -----------------------------------------------------------------------
      if (mode === "slice") {
        const slicePath = resolvedPath ?? "";
        if (!slicePath) {
          // FIELD DEFECT (2026-08-27 field-eval T1): explicit mode="slice"
          // with paths=[...] (no singular path/handle) used to fall straight
          // to the bare "path (or handle) is required" refusal below with no
          // `next` at all — the pathless-promotion net a few hundred lines up
          // (`promotionEligible`) only fires when mode is unspecified/"auto",
          // so an EXPLICIT slice bypasses it entirely and a caller reaching
          // for the batched-read idiom every other mode accepts got no
          // guidance back to the one form slice actually takes.
          const rawPaths = args["paths"];
          if (Array.isArray(rawPaths) && rawPaths.length > 0) {
            const pathList = rawPaths.map((entry) => String(entry));
            // FX-1: a target-object FRAGMENT (merged into the canonical
            // `targets=[...]` prose below), not a pre-joined `key=value` string —
            // a raw-string `next` is a blind spot for `canonicalizeEmittedToolCalls`,
            // which only rewrites OBJECT-shaped embedded tool calls.
            const preserved: Record<string, unknown> = hasRangesBatch
              ? { ranges: rangesArg }
              : resolvedRange !== undefined
                ? { range: resolvedRange }
                : {};
            if (pathList.length === 1) {
              return toolError(
                "mode=slice takes a singular path, not paths[] — did you mean the single path below?",
                {
                  code: "invalid-input",
                  next: `read_file targets=${JSON.stringify([{ path: pathList[0], ...preserved }])}`,
                  hint: "slice reads exactly one file; ranges[] windows several spans of THAT file, not several files",
                },
              );
            }
            // NOTE: `normalizeWireArgs` (this file, ~L5545) already intercepts
            // mode=slice + paths.length>1 EARLIER in the pipeline, before this
            // deep-dispatch branch runs, with its own next:"mode=task_pack"
            // recovery ("mode=slice accepts one path; multiple paths are
            // discovery scope") — so in practice this arm is defense-in-depth
            // for any call shape that reaches dispatch without going through
            // that normalizer. Matches its next verbatim (task_pack, not
            // mode=full) so the two producers of the same refusal never teach
            // a caller two different recoveries for one situation.
            return toolError(
              `mode=slice takes a singular path, not paths[] (got ${pathList.length})`,
              {
                code: "invalid-input",
                next: `read_file mode=task_pack paths=${JSON.stringify(pathList)}`,
                hint: "slice is single-file; multiple paths[] is discovery scope, not a bigger slice — task_pack handles a large set too",
              },
            );
          }
          return toolError("path (or handle) is required for mode=slice", { code: "invalid-input" });
        }
        const content = await readFileSafe(slicePath, workspace);
        if (content === null) return toolError(`File not found or outside workspace: ${slicePath}`, { code: "not-found" });

        // W7: when explicitly enabled, split a partially-held single range
        // into alternating held/new windows and reuse the established ranges[]
        // path. Its projector already renders held windows as `prior` and only
        // puts residual windows on the wire. Fully-held asks keep the ordinary
        // code-unchanged receipt below; force_serve bypasses this partition.
        if (
          overlapTrimEnabled()
          && !forceContentServe
          && !hasRangesBatch
          && resolvedRange !== undefined
        ) {
          const requested = resolvedRange.trim().match(/^L?(\d+)\s*-\s*L?(\d+)$/i);
          if (requested !== null) {
            const totalLines = countLines(content);
            const start = Math.max(1, Math.min(totalLines, Number.parseInt(requested[1]!, 10)));
            const end = Math.max(start, Math.min(totalLines, Number.parseInt(requested[2]!, 10)));
            const coverage = servedRangeCoverage(workspace, slicePath, shaOfText(content), totalLines);
            if (coverage !== undefined) {
              const parts: string[] = [];
              let cursor = start;
              let hasPrior = false;
              let hasResidual = false;
              for (const [servedStartRaw, servedEndRaw] of coverage.served) {
                const servedStart = Math.max(start, servedStartRaw);
                const servedEnd = Math.min(end, servedEndRaw);
                if (servedEnd < cursor || servedStart > end) continue;
                if (servedStart > cursor) {
                  parts.push(`${cursor}-${servedStart - 1}`);
                  hasResidual = true;
                }
                const priorStart = Math.max(cursor, servedStart);
                if (priorStart <= servedEnd) {
                  parts.push(`${priorStart}-${servedEnd}`);
                  hasPrior = true;
                  cursor = servedEnd + 1;
                }
              }
              if (cursor <= end) {
                parts.push(`${cursor}-${end}`);
                hasResidual = true;
              }
              if (hasPrior && hasResidual) {
                rangesArg = parts;
                hasRangesBatch = true;
              }
            }
          }
        }

        // ---------------------------------------------------------------------
        // A2 ranges[] batching: serve every requested window of THIS file in one
        // response. Shares this branch (not a mode of its own) so path/handle
        // resolution, the workspace guard, the doc-comment display helper and
        // the served-range ledger are the same code the single-range serve uses.
        // ---------------------------------------------------------------------
        if (hasRangesBatch) {
          // B2d (2026-08-01 serving-completeness): ZOOM PROGRESS GUARANTEE.
          //
          // resolveSliceRanges fills its response cap in CALLER order, so a
          // cap-clipped multi-range request served whatever came first and
          // deferred the rest. Live (2026-07-31-semantic-signal5-2, T03):
          // ranges:["45-105","271-1552"] served the ALREADY-HELD 45-105 and
          // re-deferred 271-1552 — a whole turn spent on 61 duplicate lines with
          // zero progress. Re-order the request by (unserved-lines DESC) against
          // the served-range ledger before the byte budget is applied, so the
          // window carrying the most NEW content always rides.
          const zoomFileSha = shaOfText(content);
          const zoomTotalLines = countLines(content);
          const parseRequested = (raw: string): { start: number; end: number } | undefined => {
            const one = raw.trim().match(/^L?(\d+)$/i);
            if (one !== null) {
              const line = parseInt(one[1]!, 10);
              return { start: line, end: line };
            }
            const span = raw.trim().match(/^L?(\d+)\s*-\s*L?(\d+)$/i);
            if (span === null) return undefined;
            return { start: parseInt(span[1]!, 10), end: parseInt(span[2]!, 10) };
          };
          const orderedRanges = !forceContentServe
            ? rangesArg
              .map((raw, index) => {
                const parsed = parseRequested(String(raw));
                // Unparseable entries keep their caller position (resolveSlice
                // owns the refusal/invalid_ranges shape for them) and are
                // treated as fully-unserved so they are never pushed behind a
                // held window.
                const unserved = parsed === undefined
                  ? Number.MAX_SAFE_INTEGER
                  : unservedLineCount(
                      workspace, slicePath, zoomFileSha, parsed.start, parsed.end, zoomTotalLines,
                    );
                return { raw: String(raw), index, unserved };
              })
              // Stable: more-unserved first, caller order breaks ties. A fully
              // held window (unserved === 0) always sorts LAST, so it can never
              // consume budget an unserved window needed.
              .sort((left, right) => right.unserved - left.unserved || left.index - right.index)
              .map((entry) => entry.raw)
            : rangesArg;
          const batch = await resolveSliceRanges(workspace, slicePath, content, orderedRanges);
          if (!batch.ok) {
            return toolStructuredError({
              ok: false,
              error: batch.error,
              path: slicePath,
              handle: handleTable.upsert({
                kind: "file",
                path: slicePath,
                workspaceRoot: workspace,
                sha: shaOfText(content),
              }).id,
              ...(batch.code ? { code: batch.code } : {}),
              ...(batch.total_lines !== undefined ? { total_lines: batch.total_lines } : {}),
              ...(batch.next !== undefined ? { next: batch.next } : {}),
            });
          }
          const batchData = batch.data;
          const rawFileSha = zoomFileSha;
          const fileTotalLines = zoomTotalLines;
          // D10 (2026-08-14): `TL_SERVED_RANGE_LEDGER` is deleted; the ledger is
          // unconditional, so the former `ledgerOn` gate is gone.

          // W1 served-content receipts, per segment. PROBE every segment against
          // the ledger BEFORE recording any of them: recording first would make a
          // later segment that merely overlaps an EARLIER SEGMENT OF THIS SAME
          // CALL look already-served, and a receipt pointing at bytes the caller
          // is receiving in this very response is not a receipt, it is a hole.
          const alreadyHeld = new Set<string>();
          // F3 (2026-08-02 serve-honesty): the probe already computes the
          // provenance — keep it, so every held segment names the call that
          // actually served it instead of asserting it uncheckably.
          const alreadyHeldBy = new Map<string, string>();
          if (!forceContentServe) {
            for (const segment of batchData.segments) {
              // W2A-1 (2026-08-21 serve-honesty): a TRUNCATED segment's
              // [segStart,segEnd] below is only the CLAMPED prefix
              // resolveSlice fit under the cap, not the caller's whole
              // requested window — `servedRangeReceipt` would correctly
              // confirm that clamped prefix alone was already held, but
              // marking the SEGMENT already-held then displays it as a bare
              // `code_unchanged` placeholder (no code) with no signal that
              // the segment itself never covered the rest of the request.
              // Never eligible for the elision, same reasoning as the
              // single-range branch's `sliceData.remaining_ranges` guard.
              if (segment.truncated === true) continue;
              const segStart = rangeStartLine(segment.range);
              const segEnd = Math.min(fileTotalLines, segStart + countLines(segment.code) - 1);
              const heldReceipt = servedRangeReceipt(
                workspace, slicePath, rawFileSha, segStart, segEnd, fileTotalLines,
              );
              if (heldReceipt !== undefined) {
                alreadyHeld.add(segment.range);
                if (heldReceipt.served_by !== undefined) {
                  alreadyHeldBy.set(segment.range, heldReceipt.served_by);
                }
              }
            }
          }
          // F1 (2026-08-02 serve-honesty): compose the DISPLAY text BEFORE
          // recording. `segment.code` is raw; the wire carries it with every
          // multi-line comment block collapsed to a `doc elided L<a>-<b>`
          // marker, so booking segStart..segStart+countLines(raw)-1 claimed
          // lines the caller never received and receipted them on the next
          // read. The alreadyHeld probe above still runs FIRST (unchanged) —
          // its ordering guarantee is what stops a segment of THIS response
          // from receipting a sibling segment of the same response.
          const segmentDisplays = new Map<string, { content: string; note?: string }>();
          for (const segment of batchData.segments) {
            if (alreadyHeld.has(segment.range)) continue;
            segmentDisplays.set(
              segment.range,
              keepComments
                ? { content: segment.code, note: undefined as string | undefined }
                : elideDocCommentsForDisplay(
                    segment.code,
                    languageForPath(slicePath),
                    false,
                    rangeStartLine(segment.range),
                  ),
            );
          }
          let batchLedger: ServedRangeLedgerReceipt | undefined;
          {
            const batchCall = beginServeCall(workspace);
            for (const segment of batchData.segments) {
              const segStart = rangeStartLine(segment.range);
              const segEnd = Math.min(fileTotalLines, segStart + countLines(segment.code) - 1);
              const display = segmentDisplays.get(segment.range);
              // An already-held segment is answered with a receipt, not bytes:
              // re-affirming its raw span adds nothing (it is subsumed by
              // definition) and keeps batchLedger defined for the all-held
              // collapse below.
              const spans = display === undefined
                ? [[segStart, segEnd] as [number, number]]
                : servedSpansOfDisplayedText(segStart, display.content, segEnd);
              for (const [spanStart, spanEnd] of spans) {
                batchLedger = recordServedRange(
                  workspace, slicePath, rawFileSha, spanStart, spanEnd, fileTotalLines,
                  { mode: "slice", range: segment.range, call: batchCall },
                );
              }
            }
          }

          // Every requested window is already held at this exact file sha — the
          // whole response collapses to the one shared receipt shape.
          //
          // W2A-1 (2026-08-21 serve-honesty): `batchData.remaining_ranges`
          // only names WHOLE requested ranges resolveSliceRanges never
          // attempted (overflow / total-byte-cap deferrals) — it says nothing
          // about a single held segment that was itself clamped short of what
          // it was asked for (e.g. `ranges=["587-8119"]` on a 21k-line file,
          // internally capped to 587-1104). `batchData.truncated` is the field
          // that already ORs in that per-segment signal
          // (`segments.some(s => s.truncated)`, see resolveSliceRanges); the
          // fast-path collapse must not fire while it holds, or the returned
          // receipt claims full coverage of the caller's request while the
          // clamped tail was never served OR disclosed (same defect and fix
          // as the single-range branch below, servedContentReceipt call #2).
          if (
            batchData.segments.length > 0
            && alreadyHeld.size === batchData.segments.length
            && batchLedger !== undefined
            && batchData.remaining_ranges === undefined
            && batchData.truncated !== true
          ) {
            const heldLabels = [...new Set(alreadyHeldBy.values())];
            const batchServedBy = heldLabels.length === 0
              ? undefined
              : heldLabels.length <= 2
                ? heldLabels.join(" + ")
                : `${heldLabels[0]!} +${heldLabels.length - 1} more`;
            return toolOk(attachSupply(servedContentReceipt({
              mode: "slice",
              handle: batchData.handle,
              path: slicePath,
              range: batchData.segments.map((segment) => segment.range).join(","),
              sha: shortSha(rawFileSha),
              ledger: batchLedger,
              ...(batchServedBy !== undefined ? { servedBy: batchServedBy } : {}),
              extra: { served_range_ledger: batchLedger },
              workspace,
            }), workspace));
          }

          const segmentNotes: string[] = [];
          const servedSegments = batchData.segments.map((segment) => {
            if (alreadyHeld.has(segment.range)) {
              // Content-equivalent, not a breadcrumb: the caller was served these
              // exact lines at this exact sha earlier in the session.
              return {
                range: segment.range,
                sha: shortSha(segment.sha),
                code_unchanged: true as const,
                ...(alreadyHeldBy.has(segment.range)
                  ? { served_by: alreadyHeldBy.get(segment.range)! }
                  : {}),
              };
            }
            // Composed above (F1) so the ledger could be fed from the wire
            // text; the fallback keeps this map total for any segment the
            // probe loop classified as held after the displays were built.
            const display = segmentDisplays.get(segment.range) ?? (keepComments
              ? { content: segment.code, note: undefined as string | undefined }
              : elideDocCommentsForDisplay(
                  segment.code,
                  languageForPath(slicePath),
                  false,
                  rangeStartLine(segment.range),
                ));
            const composed = [segment.note, display.note, elisionMarkerNote(display.content)]
              .filter(Boolean).join("; ") || undefined;
            if (composed !== undefined) segmentNotes.push(`${segment.range}: ${composed}`);
            return {
              range: segment.range,
              code: display.content,
              sha: shortSha(segment.sha),
              ...(segment.truncated === true ? { truncated: true as const } : {}),
              ...(composed !== undefined ? { note: composed } : {}),
            };
          });

          // B2d: a requested window the cap pushed into remaining_ranges that
          // the ledger already covers must NOT be re-requested — telling the
          // caller to fetch bytes it already holds is the duplicate-turn the
          // reordering above exists to remove. Answer it as a compact receipt
          // here and drop it from remaining_ranges/next.
          const deferredHeld: Array<{
            range: string; sha: string; code_unchanged: true; served_by?: string;
          }> = [];
          let batchRemaining = batchData.remaining_ranges;
          if (!forceContentServe && batchRemaining !== undefined) {
            const stillMissing: string[] = [];
            for (const raw of batchRemaining) {
              const parsed = parseRequested(String(raw));
              const receipt = parsed === undefined
                ? undefined
                : servedRangeReceipt(
                    workspace, slicePath, rawFileSha, parsed.start, parsed.end, fileTotalLines,
                  );
              if (receipt === undefined) {
                stillMissing.push(String(raw));
                continue;
              }
              // Pinned by the FILE sha (these lines were never re-sliced this
              // call, so there is no per-slice body to hash) — the same sha the
              // served_range_ledger below reports. F2 re-audit (2026-08-02):
              // that pin stays correct because servedRangeReceipt only consults
              // an entry whose `fileSha` equals this exact sha, and F2 only ever
              // NARROWED which windows qualify (coverage now comes from the
              // unmerged per-serve spans) — a window whose lines were only ever
              // elided no longer receipts here, it stays in remaining_ranges.
              deferredHeld.push({
                range: String(raw),
                sha: shortSha(rawFileSha),
                code_unchanged: true as const,
                ...(receipt.served_by !== undefined ? { served_by: receipt.served_by } : {}),
              });
            }
            batchRemaining = stillMissing.length > 0 ? stillMissing : undefined;
          }
          // B2d: the reordering above is a BUDGET decision, not a presentation
          // one. Segments go back on the wire in the order the caller asked for
          // them (rangesBatch/replay-corpus pin that), with any deferred-but-held
          // window slotted at its own requested position.
          const requestedOrder = new Map<number, number>();
          rangesArg.forEach((raw, index) => {
            const parsed = parseRequested(String(raw));
            // FIRST occurrence wins, matching resolveSliceRanges' own dedupe:
            // ["L10-L12","10-12"] collapse to one window at position 0.
            if (parsed !== undefined && !requestedOrder.has(parsed.start)) {
              requestedOrder.set(parsed.start, index);
            }
          });
          const orderKey = (range: unknown): number => {
            const parsed = parseRequested(String(range));
            if (parsed === undefined) return Number.MAX_SAFE_INTEGER;
            return requestedOrder.get(parsed.start) ?? Number.MAX_SAFE_INTEGER;
          };
          const orderedSegments = [...servedSegments, ...deferredHeld]
            .map((segment, index) => ({ segment, index }))
            .sort((left, right) =>
              orderKey(left.segment.range) - orderKey(right.segment.range)
              || left.index - right.index)
            .map((entry) => entry.segment);

          const heldCount = alreadyHeld.size + deferredHeld.length;
          // FX-1: canonical `targets=[...]` prose, not the legacy `mode=slice`
          // dialect (a raw-string `next` bypasses `canonicalizeEmittedToolCalls`,
          // which only rewrites OBJECT-shaped embedded tool calls).
          const batchNext = batchRemaining !== undefined && batchRemaining.length > 0
            ? `read_file targets=${JSON.stringify([{ handle: batchData.handle, ranges: batchRemaining }])}`
            : batchData.remaining_ranges !== undefined
              ? undefined // every deferred window was already held — nothing to fetch
              : batchData.next;

          const batchComposedNote = [
            staleHandleReresolved
              ? `handle ${staleHandleReresolved} was no longer live; re-resolved by path=${slicePath}`
              : undefined,
            batchData.note,
            heldCount > 0
              ? `${heldCount} segment(s) already served at this sha — code_unchanged receipt instead of a re-send`
              : undefined,
            deferredHeld.length > 0
              ? "response cap: unserved windows were served first (zoom progress guarantee)"
              : undefined,
          ].filter(Boolean).join("; ") || undefined;

          const batchOut: Record<string, unknown> = {
            mode: "slice",
            handle: batchData.handle,
            path: slicePath,
            total_lines: batchData.total_lines,
            segments: orderedSegments,
            ...(batchRemaining !== undefined ? { remaining_ranges: batchRemaining } : {}),
            ...(batchData.invalid_ranges ? { invalid_ranges: batchData.invalid_ranges } : {}),
            // B2d: once every deferred window turned out to be already held,
            // nothing is actually outstanding — do not keep claiming truncation.
            ...(batchData.truncated === true
              && (batchRemaining !== undefined
                || batchData.segments.some((segment) => segment.truncated === true))
              ? { truncated: true }
              : {}),
            ...(batchComposedNote ? { note: batchComposedNote } : {}),
            ...(batchNext !== undefined ? { next: batchNext } : {}),
            ...(batchData.concern_note !== undefined ? { concern_note: batchData.concern_note } : {}),
            ...(batchLedger !== undefined ? { served_range_ledger: batchLedger } : {}),
          };
          if (isMarkdownPath(slicePath) && batchData.truncated === true) {
            attachMarkdownHeadingIndex(batchOut, content);
          }
          return toolOk(attachSupply(batchOut, workspace));
        }

        const sliceResult = await resolveSlice(workspace, slicePath, content, resolvedSymbol, resolvedRange);
        if (!sliceResult.ok) {
          // ND-1: a not-found selector serves nothing. (A cap-exceeded refusal
          // is a different thing entirely — the material EXISTS and is merely
          // too large — so it is deliberately not filed as a zero-byte call.)
          if (sliceResult.code === "not-found") noteZeroByteServe();
          if (sliceResult.capExceeded) {
            // dead at HEAD (see C2-6 audit): resolveSlice no longer sets
            // capExceeded — the branch that used to was converted to a
            // trimmed-head serve instead of refusing. Coded honestly for
            // the day a genuinely un-trimmable case reintroduces it.
            return toolStructuredError({ ok: false, code: "cap-exceeded", error: "cap-exceeded", ...sliceResult.details });
          }
          // R1 (2026-07-25): a doc file has headings, not symbols — answer
          // with the heading index + a sections call rather than the generic
          // candidates/skeleton shape (both empty for markdown), whose
          // fallback `next` was a whole-file re-read.
          if (sliceResult.code === "not-found" && isMarkdownPath(slicePath) && resolvedSymbol) {
            return toolStructuredError(markdownSymbolMissPayload({
              path: slicePath,
              symbol: resolvedSymbol,
              content,
            }));
          }
          // D1: symbol-not-found recovery passthrough — candidates/skeleton
          // survive instead of a bare toolError string. `path` + a derived
          // `next` (2026-07-16a bench forensics: refusal_without_next/
          // _handle) let the caller retry in one call instead of needing to
          // remember the path it already sent.
          //
          // 2026-07-30: the file resolved — only the symbol/range did not — so
          // hand back a whole-file handle (a RESOLVABLE locator, so the retry is
          // handle-addressed) plus a derived `next`. resolveSlice's own recovery
          // (`sliceResult.next`, e.g. a valid range derived from the real line
          // count for a range-invalid refusal) wins when present. When
          // `sliceResult.code` is ALSO absent, this is resolveSlice's bare
          // "symbol or range is required" refusal (replayCorpus rn2) — neither a
          // not-found nor a range-invalid miss, so there is nothing to derive a
          // mode=symbol/mode=skeleton hint FROM; `next` is left unset and
          // toolStructuredError's own supplyRefusalGuidance derivation fills in
          // the generic known-path fallback (`read_file path=<path>`) from
          // `path` alone, exactly as it did before this handle/code/total_lines
          // enrichment existed.
          return toolStructuredError({
            ok: false,
            error: sliceResult.error,
            path: slicePath,
            handle: handleTable.upsert({
              kind: "file",
              path: slicePath,
              workspaceRoot: workspace,
              sha: shaOfText(content),
            }).id,
            ...(sliceResult.code ? { code: sliceResult.code } : {}),
            ...(sliceResult.total_lines !== undefined ? { total_lines: sliceResult.total_lines } : {}),
            ...(sliceResult.candidates ? { candidates: sliceResult.candidates } : {}),
            ...(sliceResult.skeleton ? { skeleton: sliceResult.skeleton } : {}),
            ...(sliceResult.next !== undefined
              ? { next: sliceResult.next }
              : sliceResult.code !== undefined
                ? {
                    next: sliceResult.candidates && sliceResult.candidates.length > 0
                      ? `read_file mode=symbol path=${slicePath} symbol=${sliceResult.candidates[0]}`
                      : `read_file mode=skeleton path=${slicePath}`,
                  }
                : {}),
          });
        }
        // DESIGN-v0.8 §C3: comments elided by default (comments=keep escape);
        // sliceResult.data.sha is already computed from the RAW content
        // (resolveSlice), so it stays a valid content pin regardless.
        // C10.1: shorten the response sha — the handle minted in resolveSlice
        // keeps the full sha; this only shortens the DISPLAY value.
        // item 11: true file start line for the slice's elision markers —
        // EXCEPT when resolveSlice took the symbol branch (`assembled: true`),
        // whose `content` is getSymbolWithContext's ASSEMBLED view (preamble +
        // body); `range` there is only the body's file range and does not
        // describe content's own line numbering, so markers must stay
        // code-relative (startLine 1), mirroring mode=symbol's documented
        // exception (server.ts ~:7308).
        const sliceData = sliceResult.data;
        // F1 (2026-08-02 serve-honesty): the display text is composed HERE,
        // ABOVE the ledger, because the ledger must book what the wire carries
        // and not what was asked for. This is a MOVE of the composition that
        // used to sit just below the ledger block (its rationale, C2, is kept
        // verbatim at the serve site) — not a second elision pass.
        const sliceDisplay = keepComments
          ? { content: sliceData.content, note: undefined as string | undefined }
          : elideDocCommentsForDisplay(
              sliceData.content,
              languageForPath(slicePath),
              false,
              sliceData.assembled ? 1 : rangeStartLine(sliceData.range),
            );
        // ND-4 (2026-08-08 serve honesty): this window put ZERO file lines on
        // the wire — the fully-past-EOF case L5 answers with the 253 B
        // {content:"", the FILE's real sha, total_lines, note} shape, or a
        // genuinely empty file. Either way the call serves no bytes, so a
        // later byte-identical repeat must be re-served rather than answered
        // with "its bytes are already in your context". Measured live at
        // 67da02c2: `mode=slice path=include/ctl/types.hpp range=900-950`
        // three times over produced exactly that claim, about a window that
        // never overlapped the file. The symbol branch (`assembled`) is
        // excluded — an empty symbol body is not an empty window — and it
        // files its own verdict at the not-found return above.
        if (sliceData.assembled !== true && sliceData.content.length === 0) noteZeroByteServe();
        let rangeLedger: ServedRangeLedgerReceipt | undefined;
        let rangeServedBy: string | undefined;
        if (
          sliceData.assembled !== true
          && sliceData.content.length > 0
        ) {
          const rawFileSha = shaOfText(content);
          const actualStart = rangeStartLine(sliceData.range);
          const actualEnd = Math.min(
            countLines(content),
            actualStart + countLines(sliceData.content) - 1,
          );
          // F1: an elided comment block inside this window never reaches the
          // caller, so it must not be booked. Recording LESS costs at most one
          // redundant re-serve; recording more hands out a receipt for bytes
          // nobody received.
          const servedSpans = servedSpansOfDisplayedText(
            actualStart,
            sliceDisplay.content,
            actualEnd,
          );
          // F3: probe the provenance BEFORE recording, so the label can never
          // name this very response.
          for (const [spanStart, spanEnd] of servedSpans) {
            rangeServedBy = servedRangeReceipt(
              workspace, slicePath, rawFileSha, spanStart, spanEnd, countLines(content),
            )?.served_by;
            if (rangeServedBy !== undefined) break;
          }
          const sliceCall = beginServeCall(workspace);
          let addedLines = 0;
          for (const [spanStart, spanEnd] of servedSpans) {
            rangeLedger = recordServedRange(
              workspace,
              slicePath,
              rawFileSha,
              spanStart,
              spanEnd,
              countLines(content),
              { mode: "slice", range: String(sliceData.range), call: sliceCall },
            );
            addedLines += rangeLedger.added_lines;
          }
          // A content-hash-bound range that has already been served carries no
          // new evidence. Return only the receipt instead of charging for the
          // same bytes again. The request still costs a turn; the ledger's
          // purpose is byte/churn reduction, not a claim that turns disappear.
          //
          // W1 (2026-07-30 post-ready re-read forensics): `added_lines === 0`
          // IS the qualification — recordServedRange computes it against the
          // ranges already served for THIS EXACT sha, so it means "every line
          // asked for was already served and the file has not changed since".
          // That covers both qualifying shapes (an exact-handle re-serve, and a
          // narrower range fully subsumed by an earlier wider serve) and
          // excludes partial overlap, which adds lines and serves normally.
          // The earlier gate additionally required handle= plus a caller range
          // matching the handle's stored range, which restricted the receipt to
          // the single narrowest case and left every path-addressed and
          // subsumed re-read paying full price.
          //
          // F1 note: `addedLines` is now summed over the spans the DISPLAY
          // carries, so "added nothing" means "every line this response would
          // actually put on the wire is already held" — elided lines are
          // neither claimed nor required.
          //
          // W2A-1 (2026-08-21 serve-honesty): `sliceData.range`/`.content` are
          // already CLAMPED by resolveSlice/centeredSliceForCap when the
          // caller's requested range is bigger than one serve's byte cap —
          // `sliceData.remaining_ranges` is where the uncovered TAIL of the
          // original request lives (`centeredSliceForCap`'s own doc comment:
          // "report the uncovered spans of the ORIGINAL range as
          // remaining_ranges"). `addedLines === 0` only proves the CLAMPED
          // prefix was already held; it says nothing about that tail. Live
          // repro: `range=587-8119` on a 21k-line file, clamped to 587-1104 by
          // an earlier call, addedLines 0 on the immediate re-ask — without
          // this guard the code-unchanged receipt below named `range:
          // sliceData.range` ("587-1104") but was returned FOR the caller's
          // "587-8119" ask, with no `remaining`/`next` disclosing that lines
          // 1105-8119 (the majority of the request) were never served or even
          // examined. Falling through instead re-enters the normal slice
          // response below, which already composes `remaining_ranges`/`next`
          // correctly for a truncated `sliceData` (proven by the SAME request
          // on virgin ledger state, a few lines down).
          if (
            rangeLedger !== undefined
            && addedLines === 0
            && !forceContentServe
            && sliceData.remaining_ranges === undefined
          ) {
            return toolOk(attachSupply(servedContentReceipt({
              mode: "slice",
              handle: sliceData.handle,
              path: slicePath,
              range: sliceData.range,
              sha: shortSha(sliceData.sha),
              ledger: rangeLedger,
              ...(rangeServedBy !== undefined ? { servedBy: rangeServedBy } : {}),
              extra: {
                served_range_ledger: rangeLedger,
                // B2d (2026-08-01 serving-completeness): a receipt replaces the
                // BYTES, never the guidance. The out-of-slice concern guard is
                // one-shot per (session,path) — dropping it here would silently
                // consume the only warning the caller gets. This became
                // reachable when pack-served ranges started landing in the
                // ledger (the pack may have served exactly this window).
                ...(sliceData.concern_note !== undefined
                  ? { concern_note: sliceData.concern_note }
                  : {}),
              },
              workspace,
            }), workspace));
          }
          // Nth non-contiguous range demand is evidence that another slice
          // turn is likely more expensive than one bounded whole-file serve.
          // The ordinary full governor remains authoritative.
          //
          // LOOP GUARD (2026-08-02 serve-honesty wave 2). `!complete` is now an
          // HONEST predicate: a whole-file serve never puts a file's elided
          // comment blocks on the wire, so a comment-bearing file stays
          // `complete:false` with >= 3 clusters FOREVER after one expansion —
          // which is exactly this governor's trigger. Left alone, every later
          // slice would re-expand the whole file, re-elide the same blocks, and
          // make no progress.
          //
          // The right question is not "is coverage complete?" but "has this
          // task already spent a whole-file serve on this (path,sha)?", and
          // that is a DIFFERENT ledger: recordFullServeCompleteness /
          // wasFullyServed. Deliberately not conflated with range coverage — a
          // full serve still counts against the full-read caps even though its
          // elided lines are not receipt-eligible. A CHUNKED serve leaves
          // wasFullyServed false, which is correct: the expansion below then
          // fails its own `fullFileExpansion === true` check and falls through.
          if (
            adaptiveWholeFileEnabled()
            && rangeLedger !== undefined
            && rangeLedger.clusters >= 3
            && !rangeLedger.complete
            && !wasFullyServed(workspace, slicePath, rawFileSha)
            && Buffer.byteLength(content, "utf8") <= LARGE_BYTES
            && countLines(content) <= LARGE_LINES
          ) {
            const expanded = await resolveFullReadForPath(
              workspace,
              slicePath,
              false,
              keepComments,
              { postReadyTrim: executionGuard.postReadyTrim === true },
            );
            if (
              expanded.ok
              && expanded.data["fullFileExpansion"] === true
              && expanded.data["content"] !== undefined
            ) {
              // F1 wave 2: the expansion serves
              // elideDocCommentsForDisplay(content, ...) — the same call
              // buildFullServePayload makes — so its comment blocks arrive as
              // markers. Re-run that exact elision over the file window and
              // book the surviving spans. Deriving them from the RESPONSE text
              // instead would be wrong: compressFormat collapses consecutive
              // blank lines on the way out, so its line count no longer maps to
              // file lines.
              const expandedTotal = countLines(content);
              const expandedDisplay = elideDocCommentsForDisplay(
                content, languageForPath(slicePath), keepComments,
              );
              const expandCall = beginServeCall(workspace);
              let completeLedger: ServedRangeLedgerReceipt | undefined;
              for (const [spanStart, spanEnd] of servedSpansOfDisplayedText(
                1, expandedDisplay.content, expandedTotal,
              )) {
                completeLedger = recordServedRange(
                  workspace, slicePath, rawFileSha, spanStart, spanEnd, expandedTotal,
                  { mode: "full(slice-demand)", range: `1-${expandedTotal}`, call: expandCall },
                );
              }
              return toolOk(attachSupply({
                ...expanded.data,
                expanded_from: "slice-demand",
                ...(completeLedger !== undefined
                  ? { served_range_ledger: completeLedger }
                  : {}),
              }, workspace));
            }
          }
        }
        // C2 (2026-07-24): serve the slice through elideDocCommentsForDisplay —
        // the SAME empty-elision guard mode=full and mode=small_file already
        // use — instead of the raw elideDocComments. A slice whose ENTIRE range
        // is one multi-line doc/comment block used to collapse to a lone
        // "/* doc elided L.. */" marker while claiming ok:true+truncated:false
        // (a content-free serve). The display helper falls back to RAW content
        // plus an explanatory note in exactly that case, and returns identical
        // output to elideDocComments for every non-empty slice — so the agent
        // never has to spend a comments=keep round trip to see content that was
        // already computed. resolveSlice no longer manufactures that round-trip
        // hint (readCodeModes.ts) now that the serve self-heals here.
        // (`sliceDisplay` itself is composed ABOVE the served-range ledger — see
        // the F1 note there; this comment stays with the serve it explains.)
        const sliceComposedNote = [
          // C3 self-heal note: a re-slice whose handle had expired is served
          // directly by its recovered path rather than refused (see the
          // handle-resolution block above).
          staleHandleReresolved ? `handle ${staleHandleReresolved} was no longer live; re-resolved by path=${slicePath}` : undefined,
          sliceData.note,
          sliceDisplay.note,
          elisionMarkerNote(sliceDisplay.content),
        ].filter(Boolean).join("; ") || undefined;
        const sliceOut: Record<string, unknown> = {
          ...sliceData,
          sha: shortSha(sliceData.sha),
          content: sliceDisplay.content,
          ...(sliceComposedNote ? { note: sliceComposedNote } : {}),
        };

        // DESIGN-v0.9 §4.6a same-handle slice continuation: when the RANGE
        // branch truncated at the byte cap, the follow-up is a deterministic
        // same-handle window over content already in `content` (this dispatch's
        // full-file read) — serve ONE extra window inline (bounded by the §4.8
        // must-fetch budget) and advance `next` past it, stamping
        // inlined:["slice-cont:<handle>"]. Excludes the SYMBOL-assembled branch
        // (assembled:true), whose `content` is a preamble+body view, not clean
        // file lines — its `next` re-reads the whole symbol range through THIS
        // very branch, which then continues cleanly. With TL_MUSTFETCH_EXPAND
        // off the head already fills the base cap, so nothing inlines.
        if (sliceData.assembled !== true && sliceData.truncated === true) {
          const cont = computeSliceContinuation(
            content, String(sliceData.range), sliceData.content, String(sliceData.handle),
            keepComments, languageForPath(slicePath),
          );
          if (cont) {
            sliceOut["continued"] = cont.continued;
            sliceOut["inlined"] = [`slice-cont:${sliceData.handle}`];
            if (rangeLedger !== undefined) {
              // F1 (2026-08-02 serve-honesty): `cont.continued.content` is
              // ALREADY the display text (computeSliceContinuation elides it),
              // so counting its lines as raw file lines both under-ran the
              // window's true end AND mis-attributed the lines it did claim to
              // the elided block. Book the marker-free spans instead.
              const continuedStart = rangeStartLine(cont.continued.range);
              const continuedCall = beginServeCall(workspace);
              for (const [spanStart, spanEnd] of servedSpansOfDisplayedText(
                continuedStart, cont.continued.content,
              )) {
                rangeLedger = recordServedRange(
                  workspace,
                  slicePath,
                  shaOfText(content),
                  spanStart,
                  spanEnd,
                  countLines(content),
                  { mode: "slice-cont", range: String(cont.continued.range), call: continuedCall },
                );
              }
            }
            if (cont.next !== undefined) sliceOut["next"] = cont.next;
            else delete sliceOut["next"];
          }
        }

        // R1 (2026-07-25): a markdown slice is the classic partial doc
        // surface — the solver holds lines A-B of a long doc and has no way
        // to name where anything else lives. Carry the heading index (the
        // served window first when the cap bites) plus the sections
        // instruction; skipped when the slice already covers the whole file.
        if (isMarkdownPath(slicePath)) {
          const sliceStart = rangeStartLine(String(sliceData.range));
          const sliceEnd = sliceStart + Math.max(0, countLines(String(sliceData.content)) - 1);
          if (sliceStart > 1 || sliceEnd < countLines(content) || sliceData.truncated === true) {
            attachMarkdownHeadingIndex(sliceOut, content, { start: sliceStart, end: sliceEnd });
          }
        }

        return toolOk(attachSupply(sliceOut, workspace));
      }

      // -----------------------------------------------------------------------
      // mode=pack: assemble multiple slices under a token cap.
      // Auto-promotes to task_pack when:
      //   paths is empty AND query is non-empty AND includeClosure !== false.
      // -----------------------------------------------------------------------
      if (mode === "pack") {
        const hasPaths = Array.isArray(args["paths"]) && (args["paths"] as unknown[]).length > 0;
        const hasQuery = typeof args["query"] === "string" && (args["query"] as string).length > 0;
        const includeClosureArg = args["includeClosure"];
        const shouldPromote =
          !hasPaths &&
          hasQuery &&
          includeClosureArg !== false;

        if (shouldPromote) {
          recordReadMode(workspace, "task_pack");
          // A.5.1: see the sibling mode-less promotion above. `mode=pack` maps
          // to `read.batch` by A.5.4, but a PROMOTED pack is a task pack and
          // must say so.
          declareKind("read.task_pack");
          const promoteLang = parseMcpLang(args["lang"]);
          const result = await buildTaskPack(
            {
              ...taskCredential,
              // PI-09 close-out: the explicit "I lost my context" switch.
              ...(args["force_serve"] === true ? { forceServe: true as const } : {}),
              query: String(args["query"]),
              ...(parseTaskProfile(args["taskProfile"]) ? { taskProfile: parseTaskProfile(args["taskProfile"]) } : {}),
              ...(resolvedPath ? { path: resolvedPath } : {}),
              ...(resolvedSymbol ? { symbol: resolvedSymbol } : {}),
              ...(promoteLang ? { lang: promoteLang } : {}),
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
          const supplied = attachSupply(result as unknown as Record<string, unknown>, workspace);
          recordTaskPackExecution(
            workspace,
            typeof args["query"] === "string" ? args["query"] : "",
            supplied,
          );
          return toolOk(supplied);
        }

        if (hasPaths && hasQuery) {
          return toolError("paths[] and query are mutually exclusive for mode=pack", { code: "invalid-input" });
        }
        if (!hasPaths && !hasQuery) {
          return toolError("Either paths[] or query is required for mode=pack", { code: "invalid-input" });
        }

        recordReadMode(workspace, "pack");

        const lang = parseMcpLang(args["lang"]);

        const packInput = {
          mode: "pack" as const,
          ...(hasPaths ? {
            // Same bare-string coercion as mode=task_pack's paths[] mapping
            // above (and mode=full's batch, ~:6871) — a bare string entry has
            // no .path and used to collapse to path:"", so readCodePack
            // silently read an empty path instead of the caller's file.
            paths: (args["paths"] as unknown[]).map((p) => {
              if (typeof p !== "object" || p === null) return { path: String(p) };
              const e = p as Record<string, unknown>;
              return {
                path: String(e["path"] ?? ""),
                ...(e["range"] !== undefined ? { range: String(e["range"]) } : {}),
                ...(e["symbol"] !== undefined ? { symbol: String(e["symbol"]) } : {}),
                ...(e["purpose"] !== undefined ? { purpose: String(e["purpose"]) } : {}),
              };
            }),
          } : {}),
          ...(hasQuery ? { query: String(args["query"]) } : {}),
          ...(resolvedPath !== undefined && !hasPaths ? { path: resolvedPath } : {}),
          ...(resolvedSymbol !== undefined && !hasPaths ? { symbol: resolvedSymbol } : {}),
          ...(lang ? { lang } : {}),
          ...(args["maxTokens"] !== undefined ? { maxTokens: Number(args["maxTokens"]) } : {}),
        };
        const result = await readCodePack(packInput, workspace, (rel) => readFileSafe(rel, workspace));
        return toolOk(result);
      }

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
      if (mode === "artifact") {
        const artifactPath = resolvedPath ?? "";
        if (!artifactPath) return toolError("path is required for mode=artifact", { code: "invalid-input" });
        const ext = (artifactPath.toLowerCase().match(/\.([^.\\/]+)$/)?.[1]) ?? "";
        const kind = (typeof args["kind"] === "string" ? args["kind"] : ext);

        const bytes = await readBytesSafe(artifactPath, workspace);
        if (bytes === null) return toolError(`File not found or outside workspace: ${artifactPath}`, { code: "not-found" });

        // B5.2: full-content hash, not a first-48-bytes truncation (see
        // shaOfBytes doc comment in util/handles.ts).
        const sha = shaOfBytes(bytes);
        const hEntry = handleTable.upsert({
          kind: "file",
          path: artifactPath,
          workspaceRoot: workspace,
          sha,
        });
        let artifactBytes: Uint8Array = bytes;
        if (kind === "xlsx" || kind === "docx" || kind === "pptx") {
          const prepared = await prepareOfficeDocument(bytes, credentialPassword);
          if (!prepared.ok) {
            return toolStructuredError({
              ok: false,
              kind,
              path: artifactPath,
              error: prepared.error,
              code: prepared.code,
              ...(prepared.hint ? { hint: prepared.hint } : {}),
            });
          }
          artifactBytes = prepared.bytes;

          // Mandatory zip-bomb preflight — gates EVERY OOXML consumer below
          // (visual inventory, xlsxTable/xlsxRoster, docxSections,
          // pptxSlides) with exactly one walk of the central directory, so
          // mode=artifact can no longer hand raw/decrypted bytes straight to
          // JSZip-backed parsers unchecked. See TL-V0.9-RELEASE-STRATEGY-
          // 2026-08-12.md §6.6.
          const { preflightZip } = await import("./office/zipPreflight.js");
          const artifactPreflight = await preflightZip(artifactBytes);
          if (!artifactPreflight.ok) {
            return toolStructuredError({
              ok: false,
              kind,
              path: artifactPath,
              error: `Zip preflight failed: ${artifactPreflight.detail}`,
              code: artifactPreflight.code,
            });
          }
        }

        const visualInventory = kind === "xlsx" || kind === "docx" || kind === "pptx"
          ? await (await import("./office/ooxmlVisuals.js"))
            .extractOoxmlVisualInventory(artifactBytes, kind, { preflighted: true })
          : undefined;
        const visualFields = visualInventory
          && (visualInventory.charts.length > 0 || visualInventory.media.length > 0)
          ? { visuals: visualInventory }
          : {};

        if (kind === "xlsx") {
          const { xlsxRoster, xlsxTable, pickLargestSheetByCells } = await import("./office/xlsx.js");
          const sheet = typeof args["sheet"] === "string" ? args["sheet"] : undefined;
          const range = typeof args["range"] === "string" ? args["range"] : undefined;
          const asFormat = typeof args["as"] === "string" ? args["as"] : undefined;
          const maxRows = typeof args["maxRows"] === "number" ? args["maxRows"] : undefined;
          const maxCells = typeof args["maxCells"] === "number" ? args["maxCells"] : undefined;
          const columns = Array.isArray(args["columns"]) ? (args["columns"] as unknown[]).map(String) : undefined;
          const rowRange = Array.isArray(args["rows"]) ? args["rows"] as [number, number] : undefined;

          // If no sheet/range/as specified, return roster (overview) PLUS the
          // largest data sheet's bounded content inline — the "roster tax"
          // fix (bench task T10 forensics): a bare no-`sheet` artifact call
          // used to cost >=2 round trips on every workbook (this roster, then
          // a follow-up `sheet=` call for data) even though the row data for
          // every sheet is already sitting in the SAME parsed workbook (see
          // xlsxRoster's cellCount field). Pick is general/content-based —
          // see pickLargestSheetByCells's doc comment for why not by name.
          if (!sheet && !range && !asFormat && !columns) {
            const rosterResult = await xlsxRoster(artifactBytes);
            if (!rosterResult.ok) return toolError(rosterResult.error, { code: "corrupt" });

            const baseRoster: Record<string, unknown> = {
              mode: "artifact",
              kind: "xlsx",
              path: artifactPath,
              view: "roster",
              handle: hEntry.id,
              sha: shortSha(sha), // C10.1: short display prefix; hEntry above already minted on the FULL sha.
              sheets: rosterResult.sheets,
              warnings: rosterResult.warnings,
              ...visualFields,
            };

            const isSingleSheet = rosterResult.sheets.length === 1;
            // Hidden sheets are excluded from the auto-pick, matching
            // xlsxTable's own default-sheet behavior (it also skips hidden
            // sheets unless named explicitly) — an agent that wants a hidden
            // sheet's data must still ask for it by name.
            const inlineCandidates = rosterResult.sheets.filter((s) => !s.hidden);
            const largestName = pickLargestSheetByCells(inlineCandidates);

            if (largestName) {
              // Same budget the SIBLING xlsx auto-inline flow uses in
              // mode=auto/skeleton/symbol (see the `next`/`section`
              // block below in this file) — reusing it keeps "never exceed
              // current caps" literal rather than inventing a new number.
              const inlineBudget = mustFetchReadBudget(READ_SYMBOL_CAP_BYTES);

              // Attempt 1: today's normal per-call sheet bounds (same as an
              // explicit sheet=<largestName> call would get — nothing looser).
              const tableResult = await xlsxTable(artifactBytes, { sheet: largestName });
              if (tableResult.ok) {
                const withData: Record<string, unknown> = {
                  ...baseRoster,
                  inlined_sheet: largestName,
                  range: tableResult.range,
                  columns: tableResult.columns,
                  rows: tableResult.rows,
                  truncated: tableResult.truncated,
                  note: isSingleSheet
                    ? "single-sheet workbook — this call already returned the full bounded content; no follow-up read needed"
                    : `inlined "${largestName}" (largest sheet by non-empty cells); pass sheet=<name> to read a different one`,
                };
                if (Buffer.byteLength(JSON.stringify(withData), "utf8") <= inlineBudget) {
                  return toolOk(withData);
                }
              }

              // Attempt 2: the full bounded read didn't fit (huge sheet) —
              // fall back to a small, cheap head preview before giving up.
              // Never loosens the budget check above.
              const XLSX_ROSTER_HEAD_PREVIEW_ROWS = 20;
              const XLSX_ROSTER_HEAD_PREVIEW_CELLS = 2000;
              const headResult = await xlsxTable(artifactBytes, {
                sheet: largestName,
                maxRows: XLSX_ROSTER_HEAD_PREVIEW_ROWS,
                maxCells: XLSX_ROSTER_HEAD_PREVIEW_CELLS,
              });
              if (headResult.ok) {
                const withHead: Record<string, unknown> = {
                  ...baseRoster,
                  inlined_sheet: largestName,
                  range: headResult.range,
                  columns: headResult.columns,
                  rows: headResult.rows,
                  truncated: true,
                  note: `"${largestName}" is too large to inline in full; showing a head preview (first ${XLSX_ROSTER_HEAD_PREVIEW_ROWS} rows) — pass sheet="${largestName}" for a bounded full read`,
                };
                if (Buffer.byteLength(JSON.stringify(withHead), "utf8") <= inlineBudget) {
                  return toolOk(withHead);
                }
              }
            }

            // Fallback: today's roster-only behavior, unchanged.
            return toolOk(baseRoster);
          }

          // Otherwise return table data
          const tableResult = await xlsxTable(artifactBytes, {
            sheet,
            range,
            rowRange,
            columns,
            maxRows,
            maxCells,
            as: asFormat as "json" | "markdown" | undefined,
          });
          if (!tableResult.ok) return toolStructuredError({ ok: false, code: xlsxTableFailureCode(tableResult.error), error: tableResult.error });
          if (sheet !== undefined && range !== undefined && !forceContentServe) {
            const artifactReceipt = artifactRangeReceipt(workspace, artifactPath, sheet, sha, tableResult.range);
            if (artifactReceipt !== undefined) {
              return toolOk(attachSupply({ mode: "artifact", kind: "xlsx", path: artifactPath, sheet, range, handle: hEntry.id, sha: shortSha(sha), receipt: "code-unchanged", code_unchanged: true, ...(artifactReceipt.served_by ? { served_by: artifactReceipt.served_by } : {}), summary: { served: artifactReceipt.served, complete: true }, note: SERVED_CONTENT_RECEIPT_NOTE }, workspace));
            }
          }
          let artifactServedBy: string | undefined;
          if (tableResult.columns.length > 0 && tableResult.rows.length > 0) {
            const artifactCall = beginServeCall(workspace);
            artifactServedBy = recordArtifactServedRange(workspace, artifactPath, tableResult.sheet, sha, tableResult.range, `artifact ${tableResult.range} (call #${artifactCall})`).served_by;
          }
          return toolOk({
            mode: "artifact",
            kind: "xlsx",
            path: artifactPath,
            sheet: tableResult.sheet,
            range: tableResult.range,
            handle: hEntry.id,
            sha: shortSha(sha), // C10.1: short display prefix.
            columns: tableResult.columns,
            rows: tableResult.rows,
            truncated: tableResult.truncated || visualInventory?.truncated === true,
            warnings: tableResult.warnings,
            ...(artifactServedBy ? { served_by: artifactServedBy } : {}),
            ...visualFields,
          });
        }

        if (kind === "docx") {
          const { docxSections } = await import("./office/docx.js");
          const sections = Array.isArray(args["sections"]) ? (args["sections"] as unknown[]).map(String) : undefined;
          const query = typeof args["query"] === "string" ? args["query"] : undefined;
          const result = await docxSections(artifactBytes, { sections, query });
          if (!result.ok) return toolError(result.error, { code: "corrupt" });
          return toolOk({
            mode: "artifact",
            kind: "docx",
            path: artifactPath,
            handle: hEntry.id,
            sha: shortSha(sha), // C10.1: short display prefix.
            sections: result.sections,
            truncated: result.truncated || visualInventory?.truncated === true,
            warnings: result.warnings,
            ...visualFields,
          });
        }

        if (kind === "pptx") {
          const { pptxSlides } = await import("./office/pptx.js");
          const slides = Array.isArray(args["slides"]) ? (args["slides"] as unknown[]).map(String) : undefined;
          const query = typeof args["query"] === "string" ? args["query"] : undefined;
          const result = await pptxSlides(artifactBytes, { slides, query });
          if (!result.ok) return toolError(result.error, { code: "corrupt" });
          return toolOk({
            mode: "artifact",
            kind: "pptx",
            path: artifactPath,
            handle: hEntry.id,
            sha: shortSha(sha), // C10.1: short display prefix.
            slides: result.slides,
            truncated: result.truncated || visualInventory?.truncated === true,
            warnings: visualInventory && visualInventory.charts.length > 0
              ? result.warnings.filter((warning) => !warning.startsWith("chart content not extracted"))
              : result.warnings,
            ...visualFields,
          });
        }

        if (kind === "pdf") {
          const { pdfPages } = await import("./office/pdf.js");
          const pages = Array.isArray(args["pages"]) ? (args["pages"] as unknown[]).map(String) : undefined;
          const query = typeof args["query"] === "string" ? args["query"] : undefined;
          const result = await pdfPages(bytes, {
            pages,
            query,
            ...(credentialPassword !== undefined ? { password: credentialPassword } : {}),
          });
          if (!result.ok) {
            // Structured (not bare toolError) so the failure code and the
            // native-fallback hint (pdf-encrypted/pdf-no-text-layer cases)
            // survive to the caller. Never a dangling next=artifact loop:
            // this IS mode=artifact, so the hint IS the caller's next step,
            // not a redirect back here.
            return toolStructuredError({
              ok: false,
              kind: "pdf",
              path: artifactPath,
              error: result.error,
              code: result.code,
              ...(result.hint ? { hint: result.hint } : {}),
            });
          }
          return toolOk({
            mode: "artifact",
            kind: "pdf",
            path: artifactPath,
            handle: hEntry.id,
            sha: shortSha(sha), // C10.1: short display prefix.
            pages: result.pages,
            truncated: result.truncated,
            warnings: result.warnings,
          });
        }

        if (kind === "csv" || kind === "tsv") {
          // csv/tsv is a single table (no worksheet roster), so this mirrors
          // xlsx's TABLE-view branch, not its no-`sheet` roster branch: an
          // explicit range/columns selector passes through; a bare no-selector
          // call serves the bounded head (full → head → columns-only) held to
          // the same inline budget xlsx's no-`sheet` path uses. `ext` (csv/tsv)
          // forces the tab delimiter for .tsv inside csvTable.
          const csvRange = typeof args["range"] === "string" ? args["range"] : undefined;
          const csvColumns = Array.isArray(args["columns"]) ? (args["columns"] as unknown[]).map(String) : undefined;
          const csvMaxRows = typeof args["maxRows"] === "number" ? args["maxRows"] : undefined;
          const csvMaxCells = typeof args["maxCells"] === "number" ? args["maxCells"] : undefined;
          const identity = { path: artifactPath, handle: hEntry.id, sha };

          if (csvRange !== undefined || csvColumns !== undefined || csvMaxRows !== undefined || csvMaxCells !== undefined) {
            const table = csvTable(bytes, {
              ext,
              ...(csvRange !== undefined ? { range: csvRange } : {}),
              ...(csvColumns !== undefined ? { columns: csvColumns } : {}),
              ...(csvMaxRows !== undefined ? { maxRows: csvMaxRows } : {}),
              ...(csvMaxCells !== undefined ? { maxCells: csvMaxCells } : {}),
            });
            // apparent dead code at HEAD (C2-6 audit, discovered beyond the
            // official 4-site list): csvTable's own body has no observed
            // ok:false return path either — coded honestly regardless.
            if (!table.ok) return toolError(table.error, { code: "corrupt" });
            return toolOk(csvArtifactShape(table, identity));
          }

          const csvOut = serveBoundedCsvArtifact(bytes, ext, identity);
          if (csvOut === undefined) return toolError(`Could not parse csv/tsv: ${artifactPath}`, { code: "read-error" });
          return toolOk(csvOut);
        }

        return toolError(`Artifact mode not supported for kind="${kind}". Supported: xlsx, csv, tsv, docx, pptx, pdf.`, { code: "artifact-kind-mismatch" });
      }

      // -----------------------------------------------------------------------
      // mode=skeleton paths=[...] — batch file skeletons.  This is the same
      // per-file, order-preserving batch contract as mode=full: one bad path
      // does not discard the useful skeletons already requested, and a byte
      // cap leaves an executable continuation for the remainder.
      // -----------------------------------------------------------------------
      if (mode === "skeleton" && Array.isArray(args["paths"]) && (args["paths"] as unknown[]).length >= 1) {
        declareKind("read.batch");
        const requestedPaths = (args["paths"] as unknown[]).map((entry) =>
          typeof entry === "object" && entry !== null
            ? String((entry as Record<string, unknown>)["path"] ?? "")
            : String(entry),
        );
        const items: Record<string, unknown>[] = [];
        const omitted: Array<{ path: string; reason: string }> = [];
        let servedBytes = 0;
        for (let index = 0; index < requestedPaths.length; index += 1) {
          const requestedPath = requestedPaths[index]!;
          if (!requestedPath) { omitted.push({ path: requestedPath, reason: "path is required" }); continue; }
          const content = await readFileSafe(requestedPath, workspace);
          if (content === null) { omitted.push({ path: requestedPath, reason: "File not found or outside workspace" }); continue; }
          const skeleton = await getFileSkeleton(content, { path: requestedPath });
          if (!skeleton.ok) { omitted.push({ path: requestedPath, reason: skeleton.error }); continue; }
          const entry: Record<string, unknown> = {
            path: requestedPath,
            language: skeleton.data.language,
            handle: handleTable.upsert({ kind: "file", path: requestedPath, workspaceRoot: workspace }).id,
            // `read.batch`'s established file-entry vocabulary is content,
            // not a second skeleton-only union arm. Preserve the exact
            // signature projection there so the common batch projector and
            // wire predicates retain it end to end.
            content: JSON.stringify(skeleton.data.signatures),
            signatures: skeleton.data.signatures,
            truncated: skeleton.data.truncated,
          };
          const entryBytes = Buffer.byteLength(JSON.stringify(entry), "utf8") + 1;
          if (servedBytes + entryBytes > MULTI_FILE_MAP_CAP_BYTES) {
            omitted.push({ path: requestedPath, reason: "skeleton-byte-cap" });
            for (const remainder of requestedPaths.slice(index + 1)) omitted.push({ path: remainder, reason: "skeleton-byte-cap" });
            break;
          }
          servedBytes += entryBytes;
          items.push(entry);
          recordReadPath(workspace, requestedPath);
        }
        const remaining = omitted.filter((entry) => entry.reason === "skeleton-byte-cap").map((entry) => entry.path);
        return toolOk({
          mode: "skeleton",
          items,
          omitted,
          completeness: omitted.length === 0 ? "complete" : items.length === 0 ? "empty" : "partial",
          ...(remaining.length > 0 ? { remaining, next: `read_file mode=skeleton paths=${JSON.stringify(remaining)}` } : {}),
        });
      }

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
      if (mode === "full" && Array.isArray(args["paths"]) && (args["paths"] as unknown[]).length >= 1) {
        // A.5.4: `ReadCodeFullBatchOutput` is `read.batch`, not `read.text` —
        // it carries a per-item ledger, which is exactly what splits the two.
        declareKind("read.batch");
        // Accepts either shape: a bare path string (the natural mode=full
        // form — no per-item range/symbol/purpose is meaningful here), or the
        // {path, ...} object form mode=pack/task_pack already advertise, so a
        // caller that reuses one paths[] value across modes still works.
        const requestedPaths = (args["paths"] as unknown[]).map((p) =>
          typeof p === "object" && p !== null ? String((p as Record<string, unknown>)["path"] ?? "") : String(p),
        );
        const allowFullRequested = args["allowFull"] === true;
        const officeOpts = {
          ...taskCredential,
          ...(args["maxBytes"] !== undefined ? { maxBytes: Number(args["maxBytes"]) } : {}),
          ...(args["maxTokens"] !== undefined ? { maxTokens: Number(args["maxTokens"]) } : {}),
          forceServe: args["force_serve"] === true,
          postReadyTrim: executionGuard.postReadyTrim === true,
        };

        const items: Record<string, unknown>[] = [];
        const omitted: Array<{ path: string; reason: string }> = [];
        // T2 (2026-08-27 field-eval): the same aggregate-byte backstop the
        // handles=[] batch just above got, applied here too -- T2 asks for it
        // "if the same plumbing reaches it", and it does, via the same
        // resolveCallerByteCeiling. `undefined` keeps this branch
        // byte-identical to today for every existing corpus/replay call (no
        // explicit maxBytes/maxTokens, no client-profile ceiling). Whole-entry
        // granularity: a path already through resolveFullReadForPath (whether
        // served or governor-downgraded) always ships in full; only paths NOT
        // YET resolved once the ceiling is crossed are deferred, so no
        // wasted governor-state-mutating read happens for them.
        const fullBatchCeiling = resolveCallerByteCeiling(
          typeof args["maxBytes"] === "number" ? args["maxBytes"] : undefined,
          typeof args["maxTokens"] === "number" ? args["maxTokens"] : undefined,
          defaultResponseByteCeiling,
        );
        let fullBatchBytesSoFar = 0;
        let fullBatchCapHit = false;
        for (const p of requestedPaths) {
          if (!p) {
            omitted.push({ path: p, reason: "path is required" });
            continue;
          }
          if (fullBatchCapHit) {
            omitted.push({ path: p, reason: "aggregate response byte cap reached" });
            continue;
          }
          const fr = await resolveFullReadForPath(workspace, p, allowFullRequested, keepComments, officeOpts);
          if (fr.ok) {
            // Each item carries the same fields a single-path mode=full
            // response would (content + fullFileExpansion:true on success, or
            // a downgraded skeleton/artifact-redirect shape carrying its own
            // path/reason/handle) — request order preserved.
            items.push({ path: p, ...fr.data });
            if (fullBatchCeiling !== undefined) {
              fullBatchBytesSoFar += Buffer.byteLength(JSON.stringify(fr.data), "utf8");
              if (fullBatchBytesSoFar > fullBatchCeiling) fullBatchCapHit = true;
            }
          } else {
            // A per-path hard failure (not found, escapes workspace, doc
            // extraction disabled) folds into omitted instead of aborting the
            // whole batch — matching the handles=[] batch precedent.
            // resolveFullReadForPath can't tell "missing" from "is a
            // directory" apart (readFileSafe's fs.readFile throws EISDIR,
            // caught the same as ENOENT, so both produce its generic "File
            // not found or outside workspace" wording) — batch-branch-only
            // re-stat to swap in an actionable reason when it really is a
            // directory, since that's a caller mistake worth naming rather
            // than reporting as a missing/escaped file.
            const dirAbs = safeResolve(p, workspace);
            const isDir = dirAbs !== undefined && existsSync(dirAbs) && statSync(dirAbs).isDirectory();
            omitted.push({
              path: p,
              reason: isDir
                ? "is a directory — pass file paths; for discovery use search_files action=tree or read_file query=..."
                : fr.error,
            });
          }
        }

        const completeness = omitted.length === 0 ? "complete" : items.length === 0 ? "empty" : "partial";
        return toolOk({ mode: "full", items, omitted, completeness });
      }

      // -----------------------------------------------------------------------
      // Remaining modes (auto, skeleton, symbol, full) require a file path.
      // -----------------------------------------------------------------------
      const filePath = resolvedPath ?? "";
      if (!filePath) {
        return toolError("path is required", {
          code: "invalid-input",
          ...(mode === "symbol" && resolvedSymbol
            ? { next: `search_files action=symbols query=${JSON.stringify(resolvedSymbol)}` }
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
            // alternatives, next, and path remain the executable recovery.
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
          // Left alone, a bare `read_file path=x.xlsx` claimed `read.text` and
          // `projectText` then found none of the roster's fields and shipped
          // `evidence: []`: the whole workbook silently dropped. The member is a
          // function of the payload (D4), so it is declared where the payload is
          // decided — the same fix the archive-manifest branch above carries.
          declareKind("read.artifact");
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
          const { xlsxRoster, xlsxTable, pickLargestSheetByCells } = await import("./office/xlsx.js");
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
            next: `read_file mode=artifact path=${filePath} sheet=${inlineSheetName} as=json${
              credentialRef !== undefined
                ? ` credentialRef=${JSON.stringify(credentialRef)}`
                : ""
            }`,
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
      if ((ext === "csv" || ext === "tsv") && (mode === "auto" || mode === "skeleton" || mode === "symbol")) {
        const csvBytes = await readBytesSafe(filePath, workspace);
        if (csvBytes === null) return toolError(`File not found or outside workspace: ${filePath}`, { code: "not-found" });
        if (csvBytes.length > TINY_BYTES) {
          const csvSha = shaOfBytes(csvBytes);
          const csvHEntry = handleTable.upsert({ kind: "file", path: filePath, workspaceRoot: workspace, sha: csvSha });
          const csvOut = serveBoundedCsvArtifact(csvBytes, ext, { path: filePath, handle: csvHEntry.id, sha: csvSha });
          if (csvOut !== undefined) {
            // Third implicit-artifact route (see the xlsx roster branch): a
            // size-gated csv/tsv serves `columns`/`rows`, an A.5.5 `csv`
            // content form, on a request whose mode is still `auto`.
            declareKind("read.artifact");
            recordReadPath(workspace, filePath);
            return toolOk(attachSupply(csvOut, workspace));
          }
          // csvTable failed unexpectedly (should not happen for text) — fall
          // through to the generic text pipeline rather than hard-erroring.
        }
        // small csv/tsv (<= TINY_BYTES): fall through to today's text behavior.
      }

      const content = await readFileSafe(filePath, workspace);
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
            `"${filePath}" is a directory — use read_file query="..." paths=["${filePath}"] (task pack) or search_files action=tree path="${filePath}"`,
            { code: "is-a-directory" },
          );
        }
        return toolError(`File not found or outside workspace: ${filePath}`, { code: "not-found" });
      }

      // Explicit mode=symbol, OR auto-mode with a symbol arg → symbol extraction
      if (mode === "symbol" || (mode === "auto" && symbolArg)) {
        if (!symbolArg) return toolError("symbol is required for mode=symbol", { code: "invalid-input" });
        const result = await getSymbolWithContext(content, { path: filePath, symbol: symbolArg });
        if (!result.ok) {
          // ND-1 (2026-08-08 serve honesty): the symbol does not exist, so this
          // call put no file bytes on the wire. Measured live at 67da02c2
          // without this verdict: calls 1 and 2 answered with the 395 B
          // not-found (candidates + skeleton + next), and the 3rd IDENTICAL
          // call was answered from the FILE-level ledger with a 408 B
          // {ok:true, reason:"already-served", windows:[{range:"1-41"}]} — a
          // receipt asserting that a symbol that does not exist is already in
          // the caller's context, and one that cost MORE than re-serving the
          // miss it replaced.
          noteZeroByteServe();
          // R1 (2026-07-25): doc backstop. The markdown route above normally
          // catches this call first; this covers the paths it deliberately
          // does not claim (e.g. symbol + explicit range on a .md) so a doc
          // symbol-miss can never fall back to the whole-file `next` again.
          if (isMarkdownPath(filePath)) {
            return toolStructuredError(markdownSymbolMissPayload({
              path: filePath,
              symbol: symbolArg,
              content,
            }));
          }
          // D1: symbol-not-found recovery passthrough — candidates/skeleton
          // survive instead of a bare toolError string. `path` + a derived
          // `next` (2026-07-16a bench forensics: refusal_without_next/
          // _handle) let the caller retry in one call instead of needing to
          // remember the path it already sent.
          //
          // 2026-07-30: the file itself resolved fine — only the symbol name
          // missed — so mint a whole-file handle and hand it back. That makes
          // the refusal HANDLE-CARRYING: the retry addresses the file by handle
          // instead of re-sending a path, and `next` is now unconditional (a
          // miss with no lexical candidates falls back to the skeleton, which
          // names every symbol the file actually has).
          return toolStructuredError({
            ok: false,
            error: result.error,
            code: result.code,
            path: filePath,
            handle: handleTable.upsert({
              kind: "file",
              path: filePath,
              workspaceRoot: workspace,
              sha: shaOfText(content),
            }).id,
            ...(result.candidates ? { candidates: result.candidates } : {}),
            ...(result.skeleton ? { skeleton: result.skeleton } : {}),
            next: result.candidates && result.candidates.length > 0
              ? `read_file mode=symbol path=${filePath} symbol=${result.candidates[0]}`
              : `read_file mode=skeleton path=${filePath}`,
          });
        }
        // W1 served-content receipt: this session already served every file
        // line this symbol spans, at this exact sha. Re-assembling the same
        // window buys the caller nothing it does not already hold — answer with
        // the compact receipt (content:"full"/allowFull:true force the bytes).
        if (!forceContentServe) {
          const symFileSha = shaOfText(content);
          const symTotalLines = countLines(content);
          const symLedger = servedRangeReceipt(
            workspace,
            filePath,
            symFileSha,
            result.data.range.start,
            result.data.range.end,
            symTotalLines,
          );
          if (symLedger !== undefined) {
            const symRangeStr = `${result.data.range.start}-${result.data.range.end}`;
            const symHandle = handleTable.upsert({
              kind: "symbol",
              path: filePath,
              range: symRangeStr,
              symbol: symbolArg,
              workspaceRoot: workspace,
              sha: shaOfText(result.data.code),
            });
            recordReadPath(workspace, filePath);
            return toolOk(attachSupply(servedContentReceipt({
              mode: "symbol",
              path: filePath,
              handle: symHandle.id,
              sha: shortSha(symFileSha),
              range: symRangeStr,
              symbol: symbolArg,
              ledger: symLedger,
              workspace,
            }), workspace));
          }
        }
        const symbolBytes = Buffer.byteLength(result.data.code, "utf8");
        // Augment with handle + sha (C.6). DESIGN-v0.8 §C3: sha/handle are
        // minted from the RAW (unelided) code — elision only ever changes
        // the display `code` field below, never the content a handle pins
        // or an edit precondition re-reads from disk.
        //
        // DESIGN-v0.8 B4.1: for a file at/below the small-file (TINY)
        // threshold, mint a WHOLE-FILE (1-EOF) handle instead of pinning just
        // the symbol's own range. A range-replace scoped to only the
        // symbol's range risks leaving an orphan tail elsewhere in a tiny
        // file untouched (a live case: a 13-line stub's handle covered only lines
        // 1-11, and a full-stub replace via that handle left a dangling
        // docstring close outside the range — a syntax error). A tiny file
        // is cheap enough that the caller should just get a handle to the
        // WHOLE file to edit against.
        //
        // kind:"range" (not kind:"file"): edit_code's {handle, content}
        // range-content-replace branch (below, further in this function)
        // only activates when the driving handle HAS a `range` field
        // (`handleId && handleRange && ...`) — a bare kind:"file" handle
        // (no range) falls through to the whole-file EXACT search/replace
        // path instead, which rejects an empty `search` on an existing file
        // (code "empty-search") and therefore can never actually be used
        // for the "replace with this whole new body" pattern this fix
        // exists to enable. A 1-N range handle is the form that is already
        // wired up end-to-end (range-content-replace, target=all,
        // B4.2's orphan-tail check, B3.3's refreshSha line-shift on a
        // follow-up edit) — literally "1-EOF" per the design text.
        //
        // The `sha` in the response always matches whatever the returned
        // `handle` is pinned to — a symbol handle's sha over
        // `result.data.code`, or (tiny-file case) a 1-EOF range handle's
        // sha over the FULL file content — so a follow-up expected-hash
        // precondition using this response's `sha` is valid for the handle
        // actually returned.
        // BUG FIX (bench transcript forensics): was
        // content.split(/\r?\n/).length, which counts a phantom final
        // segment for trailing-newline content (nearly every file) — e.g. a
        // 183-line file counted as 184, minting a "1-184" handle that
        // edit_code's bounds check (which correctly counts logical lines)
        // then rejected as out of bounds for a 183-line file. countLines()
        // is trailing-newline aware and matches that bounds check exactly
        // (see util/countLines.ts).
        const symbolFileLineCount = countLines(content);
        const symbolFileBytes = Buffer.byteLength(content, "utf8");
        const symbolFileIsTiny = symbolFileBytes <= TINY_BYTES && symbolFileLineCount <= TINY_LINES;
        const sha = symbolFileIsTiny ? shaOfText(content) : shaOfText(result.data.code);
        const hEntry = handleTable.upsert(
          symbolFileIsTiny
            ? { kind: "range", path: filePath, range: `1-${symbolFileLineCount}`, workspaceRoot: workspace, sha }
            : {
                kind: "symbol",
                path: filePath,
                range: `${result.data.range.start}-${result.data.range.end}`,
                symbol: symbolArg,
                workspaceRoot: workspace,
                sha,
              },
        );
        // C10.2: scopeHeader is dropped here — it is ALREADY the first line
        // of result.data.code (getSymbolWithContext.ts builds `code` as
        // `[scopeHeader, ...].join("\n")`), so returning it again as a
        // sibling field is pure duplication. destructure it out of the
        // spread instead of letting it ride along.
        // C10.1: sha is shortened for the response; the handle above was
        // minted on the full sha.
        const { scopeHeader: _scopeHeader, ...symbolDataWithoutScopeHeader } = result.data;
        // item 11: NO file-startLine is passed here (default 1) — unlike a
        // mode=slice/handles line slice, mode=symbol's `code` is an ASSEMBLED
        // view (scopeHeader, used-imports, enclosing/sibling signatures, a
        // `target:` marker, then the body — see getSymbolWithContext.ts), whose
        // preamble length varies, so there is no single file line offset that
        // maps `code` lines to file lines. Markers here stay code-relative.
        const symbolCode = keepComments
          ? symbolDataWithoutScopeHeader.code
          : elideDocComments(symbolDataWithoutScopeHeader.code, languageForPath(filePath));

        // FIX C (2026-07-12c forensics): a symbol body over
        // READ_SYMBOL_CAP_BYTES now serves a TRIMMED downgrade instead of a
        // bare refusal — see buildSymbolDowngradePayload's doc comment above
        // (near buildFullDowngradePayload) for the full rationale; mirrors
        // mode=full's downgraded_from:"full" precedent.
        if (symbolBytes > READ_SYMBOL_CAP_BYTES) {
          const downgraded = buildSymbolDowngradePayload({
            filePath,
            symbolName: symbolArg,
            language: symbolDataWithoutScopeHeader.language,
            range: result.data.range,
            sourceContent: content,
            keepComments,
            handleId: hEntry.id,
            sha: shortSha(sha),
            bytes: symbolBytes,
            maxBytes: READ_SYMBOL_CAP_BYTES,
          });
          if (downgraded) {
            recordReadPath(workspace, filePath);
            return toolOk(attachSupply(downgraded, workspace));
          }
          // Pathological: even a minimally-trimmed serve cannot fit within
          // cap (see buildSymbolDowngradePayload's doc comment) — keep the
          // hard refusal as the last resort.
          return toolStructuredError({
            ok: false,
            code: "cap-exceeded",
            error: "cap-exceeded",
            path: filePath,
            symbol: symbolArg,
            bytes: symbolBytes,
            maxBytes: READ_SYMBOL_CAP_BYTES,
            range: result.data.range,
            suggest: "read_file mode=pack with a narrower range",
          });
        }

        // B2 / V12-02: a symbol read of a file whose ledger survived a server
        // edit takes the SAME already-shipped difference projection W7 uses.
        // The two levers stay independent by construction: W7's branch reads
        // its own flag and any coverage, the delta branch requires a
        // `deltaFromSha`-marked entry (`deltaContextDecision`) that only a
        // server-applied edit can mint, and force_serve bypasses both.
        const symbolDelta = forceContentServe || !deltaContextEnabled()
          ? undefined
          : deltaContextDecision({
              workspace,
              filePath,
              content,
              sha: shaOfText(content),
              totalLines: symbolFileLineCount,
              range: [result.data.range.start, result.data.range.end],
            });
        if (
          (overlapTrimEnabled() || symbolDelta?.decision === "delta")
          && symbolDelta?.decision !== "full"
          && !forceContentServe
        ) {
          const symbolFileSha = shaOfText(content);
          const symbolCoverage = symbolDelta?.coverage ?? servedRangeCoverage(
            workspace, filePath, symbolFileSha, symbolFileLineCount,
          );
          if (symbolCoverage !== undefined && !symbolCoverage.complete) {
            const difference = buildLedgerDifferenceFullPayload({
              workspace,
              filePath,
              content,
              handleId: hEntry.id,
              sha: symbolFileSha,
              keepComments,
              mode: "symbol",
              range: [result.data.range.start, result.data.range.end],
              priorCoverage: symbolCoverage,
            });
            if (difference !== undefined
              && (difference["segments"] as Array<Record<string, unknown>>)
                .some((segment) => segment["code_unchanged"] === true)) {
              recordReadPath(workspace, filePath);
              return toolOk(attachSupply({ ...difference, symbol: symbolArg }, workspace));
            }
          }
        }

        // Feature 1 (2026-07-12b2): successful standalone mode=symbol serve.
        recordReadPath(workspace, filePath);
        // W1: the symbol's file lines are now resident — record them so a later
        // read of the same window answers with a receipt.
        //
        // F1 (2026-08-02 serve-honesty): booking the whole symbol range was the
        // shape behind the decisive live report — a `code_unchanged` receipt for
        // score_run's 139 lines when only 4 had ever been served. mode=symbol's
        // `code` is an ASSEMBLED view (scopeHeader + imports + signatures +
        // target marker + body) whose lines do NOT map to file lines, so the
        // served file lines are modelled by running the SAME elider over the
        // symbol's own file-line window. For a doc block wholly inside the body
        // — the case that matters — the two agree exactly.
        {
          const symStart = result.data.range.start;
          const symTotalLines = countLines(content);
          const symEnd = Math.min(result.data.range.end, symTotalLines);
          const symBodyRaw = content.split(/\r?\n/).slice(symStart - 1, symEnd).join("\n");
          const symBodyDisplay = keepComments
            ? symBodyRaw
            : elideDocComments(symBodyRaw, languageForPath(filePath), symStart);
          const symSpans = servedSpansOfDisplayedText(symStart, symBodyDisplay, symEnd);
          // Degenerate guard: a body that elides down to nothing would record
          // nothing at all, and recordServedRange is also what makes this path
          // edit-admissible (A1, 2026-08-01 signal5-2). Keep the path grounded
          // with its signature line rather than dropping the record entirely.
          const symRecorded = symSpans.length > 0
            ? symSpans
            : [[symStart, symStart] as [number, number]];
          const symCall = beginServeCall(workspace);
          for (const [spanStart, spanEnd] of symRecorded) {
            recordServedRange(
              workspace,
              filePath,
              shaOfText(content),
              spanStart,
              spanEnd,
              symTotalLines,
              { mode: "symbol", range: `${symStart}-${result.data.range.end}`, call: symCall },
            );
          }
        }
        return toolOk(attachSupply({ ...symbolDataWithoutScopeHeader, code: symbolCode, handle: hEntry.id, sha: shortSha(sha) }, workspace));
      }

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
      const SMALL_FILE_BYTES = 8192;
      if (mode === "full") {
        // Routes through resolveFullReadForPath (shared with the office
        // mode=full branch above and the paths[] batch below) — byte cap,
        // governor, and success/downgrade payloads are identical to the
        // pre-extraction inline logic. Note: this re-reads the file from disk
        // (resolveFullReadForPath does its own readFileSafe) rather than
        // reusing the `content` this outer scope already loaded for the
        // shared auto/symbol/full dispatch above — one extra read for the
        // mode=full path specifically, traded for one governor/cap
        // implementation instead of two copies that could drift apart.
        // W1 served-content receipt: this session already served every line of
        // this exact sha (via an earlier full serve, or via slices that
        // cumulatively covered the file), so the caller holds these bytes
        // already. Answer with the compact receipt instead of re-charging for
        // an identical body. content:"full"/allowFull:true force the bytes.
        //
        // Deliberately does NOT fire when wasFullyServed already knows about a
        // tracked full expansion of this exact sha, nor when the full governor
        // is disabled: resolveFullReadForPath's own decideFullRead/
        // buildFullDowngradePayload pipeline already owns "repeat mode=full of
        // the same sha" — WITH the correct downgraded_from/reason, and WITH
        // TL_FULL_GOVERNOR=0's "no full-read economization at all" contract
        // (readCodeFullDowngrade spec's "repeat read"/"governor disabled"
        // cases). This standalone check exists only for what that mechanism
        // cannot see: full coverage assembled from cumulative SLICE/SYMBOL
        // serves that never went through a tracked mode=full expansion.
        const fullSha = shaOfText(content);
        // B2 / V12-02: this partial-coverage difference branch is UNFLAGGED —
        // it already serves prior+residual for coverage assembled from earlier
        // slices, and once a ledger entry survives an edit it would serve the
        // post-edit delta with no further wiring. What the delta decision adds
        // is the two rules that branch has no way to know about: the
        // base-mismatch drop (an external write after the transformation) and
        // the size guard (a projection that would cost more than the body).
        // Both answer `"full"`, which SUPPRESSES the difference; `undefined`
        // (flag off, or an entry no edit ever carried) leaves it exactly as it
        // was.
        const fullDelta = forceContentServe || !deltaContextEnabled()
          ? undefined
          : deltaContextDecision({
              workspace, filePath, content, sha: fullSha, totalLines: countLines(content),
            });
        if (
          !forceContentServe
          && !wasFullyServed(workspace, filePath, fullSha)
        ) {
          const fullTotalLines = countLines(content);
          const fullCoverage = servedRangeCoverage(workspace, filePath, fullSha, fullTotalLines);
          if (fullCoverage !== undefined && !fullCoverage.complete && fullDelta?.decision !== "full") {
            const partial = await resolveFullReadForPath(
              workspace,
              filePath,
              args["allowFull"] === true,
              keepComments,
              { postReadyTrim: executionGuard.postReadyTrim === true },
            );
            if (!partial.ok) return fullReadRefusal(partial);
            const partialHandle = partial.data["handle"];
            if (
              partial.data["fullFileExpansion"] === true
              && typeof partialHandle === "string"
            ) {
              const difference = buildLedgerDifferenceFullPayload({
                workspace,
                filePath,
                content,
                handleId: partialHandle,
                sha: fullSha,
                keepComments,
                mode: "full",
                priorCoverage: fullCoverage,
              });
              if (difference !== undefined) {
                recordReadPath(workspace, filePath);
                return toolOk(attachSupply(difference, workspace));
              }
            }
            return toolOk(attachSupply(partial.data as Record<string, unknown>, workspace));
          }

          const fullLedger = servedRangeReceipt(workspace, filePath, fullSha, 1, fullTotalLines, fullTotalLines);
          if (fullLedger !== undefined) {
            const fullHandle = handleTable.upsert({
              kind: "file",
              path: filePath,
              workspaceRoot: workspace,
              sha: fullSha,
            });
            recordReadPath(workspace, filePath);
            return toolOk(attachSupply(servedContentReceipt({
              mode: "full",
              path: filePath,
              handle: fullHandle.id,
              sha: shortSha(fullSha),
              range: `1-${fullTotalLines}`,
              ledger: fullLedger,
              workspace,
            }), workspace));
          }
        }
        const fr = await resolveFullReadForPath(
          workspace,
          filePath,
          args["allowFull"] === true,
          keepComments,
          {
            forceServe: args["force_serve"] === true,
            postReadyTrim: executionGuard.postReadyTrim === true,
          },
        );
        if (!fr.ok) return fullReadRefusal(fr);
        // A COMPLETE full serve makes every line resident — record it so a
        // later slice/full/symbol of the same sha qualifies for the receipt
        // above. Only `fullFileExpansion` (the untruncated whole-file success
        // shape) qualifies; a governed head or downgrade must not claim
        // coverage it did not serve.
        //
        // F1 wave 2 (2026-08-02 serve-honesty): "every line resident" was false
        // for any commented file. The payload is
        // compressFormat(elideDocCommentsForDisplay(content, ...)), so a
        // multi-line comment block reaches the caller as ONE marker while all of
        // its lines were being booked as served — a later slice into exactly
        // those lines then answered `code_unchanged` for bytes nobody ever
        // received (reproduced by external review, 2026-08-02). Re-run the same
        // elision over the file window and book only the surviving spans.
        // Counting the RESPONSE's own lines would be wrong: compressFormat
        // collapses consecutive blank lines, so its line count no longer maps to
        // file lines. Fail-safe stays record-less.
        if (fr.data["fullFileExpansion"] === true) {
          const servedTotal = countLines(content);
          const fullDisplay = elideDocCommentsForDisplay(
            content, languageForPath(filePath), keepComments,
          );
          const fullServeCall = beginServeCall(workspace);
          for (const [spanStart, spanEnd] of servedSpansOfDisplayedText(
            1, fullDisplay.content, servedTotal,
          )) {
            recordServedRange(
              workspace, filePath, shaOfText(content), spanStart, spanEnd, servedTotal,
              { mode: "full", range: `1-${servedTotal}`, call: fullServeCall },
            );
          }
        }
        return toolOk(attachSupply(fr.data as Record<string, unknown>, workspace));
      }
      if (mode === "auto") {
        const autoBytes = Buffer.byteLength(content, "utf8");
        // BUG FIX: was content.split(/\r?\n/).length — feeds the isTinyFile
        // threshold gate below.
        const autoLineCount = countLines(content);
        const isTinyFile = autoBytes <= TINY_BYTES && autoLineCount <= TINY_LINES;

        // auto-mode on a tiny file: always prefer small_file (D10: unconditional).
        if (isTinyFile) {
          try {
            const smallFileContent = parseSmallFileContent(args["content"]);
            if (!smallFileContent.ok) return toolError("content must be full, outline, defer, or auto");
            const sfRes = await buildSmallFile(workspace, filePath, String(args["cwd"] ?? ""), { content: smallFileContent.value, keepComments, allowedParents: configuredAllowedParents(workspace) });
            if ("mode" in sfRes) return toolOk(sfRes);
            // fallback on refusal (should not happen for tiny files, but be safe)
          } catch { /* fall through to skeleton */ }
        }

        if (content.length < SMALL_FILE_BYTES && autoBytes <= READ_FULL_CAP_BYTES) {
          // auto-mode small file: augment with handle + sha (C.6).
          const sha = shaOfText(content);
          const hEntry = handleTable.upsert({
            kind: "file",
            path: filePath,
            workspaceRoot: workspace,
            sha,
          });
          // C10.1: short display sha; hEntry above minted on the full sha.
          // DESIGN-v0.8 §C3: comments elided by default (comments=keep escape);
          // sha above is already computed from the RAW content, unaffected.
          // 2026-07-16a bench forensics: fall back to raw content + a note
          // instead of serving an elided-empty doc-only file — see
          // elideDocCommentsForDisplay's doc comment (util/formatCompress.ts).
          const { content: displayContent, note: elisionNote } = elideDocCommentsForDisplay(
            content,
            languageForPath(filePath),
            keepComments,
          );
          // B2 / V12-02: same suppression rule as the mode=full branch above —
          // this difference projection is unflagged, so the delta decision only
          // ADDS the base-mismatch drop and the size guard. `undefined` (flag
          // off, or an entry no server edit carried) leaves it untouched.
          const autoDelta = forceContentServe || !deltaContextEnabled()
            ? undefined
            : deltaContextDecision({
                workspace, filePath, content, sha, totalLines: autoLineCount,
              });
          const difference = !forceContentServe && autoDelta?.decision !== "full"
            ? buildLedgerDifferenceFullPayload({
                workspace,
                filePath,
                content,
                handleId: hEntry.id,
                sha,
                keepComments,
                mode: "auto",
              })
            : undefined;
          if (difference !== undefined) {
            recordReadPath(workspace, filePath);
            return toolOk(attachSupply(difference, workspace));
          }
          // Feature 1 (2026-07-12b2): successful mode=auto small-content serve.
          recordReadPath(workspace, filePath);
          return toolOk({
            content: compressFormat(displayContent),
            language: filePath.split(".").pop() ?? "unknown",
            handle: hEntry.id,
            sha: shortSha(sha),
            ...(elisionNote ? { note: elisionNote } : {}),
          });
        }

        // A semantic query over a large file should receive the evidence it
        // asks for, not the beginning of a skeleton/document. The file is
        // already resident in memory, so this adds no I/O and stays bounded to
        // one query-ranked window. Ambiguous/no-match queries preserve the
        // existing skeleton/prefix fallback below.
        const semanticQuery = typeof args["query"] === "string" ? args["query"].trim() : "";
        if (semanticQuery.length > 0) {
          const evidence = selectQueryEvidence(content, semanticQuery, { path: filePath });
          if (evidence !== undefined) {
            const fullSha = shaOfText(content);
            const rangeHandle = handleTable.upsert({
              kind: "range",
              path: filePath,
              range: evidence.range,
              workspaceRoot: workspace,
            });
            const evidenceStartLine = Number.parseInt(evidence.range.split("-", 1)[0] ?? String(evidence.line), 10);
            const displayContent = keepComments
              ? evidence.content
              : elideDocComments(evidence.content, languageForPath(filePath), evidenceStartLine);
            recordReadPath(workspace, filePath);
            return toolOk({
              content: compressFormat(displayContent),
              language: languageForPath(filePath) ?? (filePath.split(".").pop() ?? "unknown"),
              handle: rangeHandle.id,
              sha: shortSha(fullSha),
              range: evidence.range,
              focus: {
                kind: evidence.kind,
                matched_terms: evidence.matchedTerms,
                missing_terms: evidence.missingTerms,
                score: evidence.score,
                margin: evidence.margin,
              },
              truncated: true,
            });
          }
        }

        // S1/C1: mode=auto on a LARGE (>= SMALL_FILE_BYTES) NON-CODE file
        // (markdown/json/yaml/toml/text/log/csv/etc.) — getFileSkeleton would
        // return a useless "(no signatures detected)" header or a raw dump
        // for these. Return a capped content slice instead, same shape as
        // the small-file branch above plus truncation metadata. Explicit
        // mode=skeleton is NOT affected (falls through below unconditionally
        // for a user who actually asked for a skeleton); code files are not
        // affected either (isSkeletonizableLanguage gate).
        if (!isSkeletonizableLanguage(languageForPath(filePath))) {
          const fullSha = shaOfText(content);
          const hEntry = handleTable.upsert({
            kind: "file",
            path: filePath,
            workspaceRoot: workspace,
            sha: fullSha,
          });
          const rawBytes = Buffer.byteLength(content, "utf8");
          let capped = content;
          let truncated = false;
          let lastCoveredLine = autoLineCount;
          if (rawBytes > DOC_CONTENT_CAP_BYTES) {
            const buf = Buffer.from(content, "utf8");
            const slice = buf.subarray(0, DOC_CONTENT_CAP_BYTES).toString("utf8");
            // Truncate on a line boundary — never cut mid-line.
            const lastNewline = slice.lastIndexOf("\n");
            capped = lastNewline >= 0 ? slice.slice(0, lastNewline) : slice;
            truncated = true;
            lastCoveredLine = countLines(capped);
          }
          const displayContent = keepComments ? capped : elideDocComments(capped, languageForPath(filePath));
          const docResult: Record<string, unknown> = {
            content: compressFormat(displayContent),
            language: languageForPath(filePath) ?? (filePath.split(".").pop() ?? "unknown"),
            handle: hEntry.id,
            sha: shortSha(fullSha),
            truncated,
          };
          if (truncated) {
            const nextStart = lastCoveredLine + 1;
            const totalLines = countLines(content);
            if (nextStart <= totalLines) {
              // Remainder form, not a fixed 120-line window: the slice serve
              // clamps to its own byte cap per call, so naming the whole
              // remainder converges in ceil(bytes/cap) calls instead of a
              // window walk (2026-07-09c residual turn cost).
              docResult["next"] = `read_file mode=slice handle=${hEntry.id} range=${nextStart}-${totalLines}`;
            } else {
              // skc2 Q5 (2026-07-17): the byte cap cut inside the file's LAST
              // line (a zero-newline file cuts inside line 1), so no whole
              // line exists after the cut and a line-range continuation
              // cannot name the remainder — the old unconditional next
              // emitted an inverted, unusable range (2-1 on a one-line 32KB
              // file). Keep truncated:true + handle and point at mode=full.
              docResult["hint"] = `remainder is inside line ${lastCoveredLine} (no later line to slice); use read_file mode=full path=${filePath} for the whole file`;
            }
          }
          // OPTIONAL: markdown heading outline — extracted from the full
          // content regardless of truncation so the outline still names
          // sections beyond the capped slice. Capped by DOC_HEADINGS_CAP_*
          // (2026-07-17 spec-final rc2, cell md_4800kb: EVERY heading of a
          // generated ~4.8MB .md rode along — 22,680 entries / 3.72MB beside
          // the 4KB body); truncation is explicit, never silent.
          if (isMarkdownPath(filePath)) {
            const allHeadings = parseMarkdownHeadings(content);
            const headings = capEnvelopeArray(
              allHeadings.slice(0, DOC_HEADINGS_CAP_ENTRIES).map((heading) => ({
                level: heading.level,
                text: heading.text,
                line: heading.line,
                range: String(heading.line) + "-" + String(heading.endLine),
                section: heading.path,
                style: heading.style,
              })),
              DOC_HEADINGS_CAP_ENTRIES,
              DOC_HEADINGS_CAP_BYTES,
            );
            if (headings.length > 0) docResult["headings"] = headings;
            if (headings.length < allHeadings.length) {
              docResult["headings_truncated"] = true;
              docResult["headings_total"] = allHeadings.length;
            }
            // R1 (2026-07-25): the outline names sections but not how to ASK
            // for one — live, solvers read the heading list here and then
            // shelled out to grep/sed for line numbers. One short instruction
            // closes that gap (kept off heading-less docs, where it is noise).
            if (headings.length > 0) docResult["sections_hint"] = MARKDOWN_SECTIONS_HINT;
          }
          // Feature 1 (2026-07-12b2): successful mode=auto large-non-code serve.
          recordReadPath(workspace, filePath);
          return toolOk(docResult);
        }
      }

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

    // -----------------------------------------------------------------
    // Consolidated edit_file — rename, single edit, multi-file batch, or create
    // -----------------------------------------------------------------
    case "edit_file": {
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
      // C-6 (§1.3.1(2)): `allow_create` was DELETED from edit_file's request
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
      // D10 (2026-08-14): `TL_CREATE_REQUIRES_CWD` is deleted; a create must
      // always name its workspace or carry one unambiguous handle root.
      if (
        createDispatchRequested
        && !cwdExplicit
        && createCapabilityHandleIds.length === 0
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
            tool: "edit_file",
            arguments: { ...compactTemplateArgs(args), cwd: "<absolute intended workspace cwd>" },
          },
        });
      }

      // Root-mismatch guard (2026-08-09): runs on the shared preamble, so
      // every sub-dispatch below — single edit, edits[] batch, intent, rename,
      // artifact zip, create — inherits it without its own copy, exactly the
      // way checkCwdOrRefuse and the D.1 handle block already do. Write-mode
      // only: on a read-only server edit_file must keep reporting that writes
      // are disabled rather than a routing refusal for a write it would never
      // perform — the ALLOW_WRITE gate now lives inside guardWriteRouting, so
      // every write case inherits it identically. See workspaceRoutingRefusal.
      const routingGuardEdit = guardWriteRouting("edit_file", args, cwdGuardEdit.pass);
      if (!routingGuardEdit.ok) return toolStructuredError(routingGuardEdit.refusal);

      // L1 (2026-08-07): how THIS call named the workspace it creates into.
      // Computed from exactly the two facts W1's cwd-required-for-create
      // refusal above keys on, so the pin exists precisely when that refusal
      // does not fire: an explicit cwd, or a handle capability the call
      // already carries. Undefined for every other shape (including a
      // `create:true` riding an edits[] batch, and an artifact/intent/rename
      // dispatch) — those keep the historical frontier verdict. Consumed ONLY by
      // guardExecutionEdit's create branch; the containment checks that
      // actually bound the write live in createFile.ts and are untouched.
      const createWorkspacePin = createDispatchRequested
        ? (cwdExplicit
            ? "explicit-cwd" as const
            : createCapabilityHandleIds.length > 0
              ? "handle-capability" as const
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
      // PI-09 — see the read_file arm. Validated against the BRANDED root the
      // guard stack just minted (pre-adoption, matching the read path's
      // requested-cwd semantics), and still before any write decision, so a
      // stale/foreign handle can never contribute to one.
      const taskHandleRefusalEdit = taskHandleRefusal(args, workspace);
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
      const executionGuard = guardExecutionEdit(
        guardWorkspace,
        args,
        (handleId) => {
          const entry = handleTable.get(handleId);
          return entry !== undefined && entry.workspaceRoot === guardWorkspace && entry.path !== undefined && entry.path !== ""
            ? entry.path
            : undefined;
        },
        createWorkspacePin !== undefined ? { createWorkspacePin } : {},
      );
      if (!executionGuard.allowed) return toolStructuredError(executionGuard.refusal);
      const pendingReclassification = executionGuard.reclassified;
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

      // -----------------------------------------------------------------------
      // D.1 Handle resolution: resolve handle BEFORE any sub-dispatch.
      // When a handle is supplied, override path/symbol/range from the entry.
      // On failure, return a structured error immediately.
      // -----------------------------------------------------------------------
      const handleId = typeof args["handle"] === "string" ? args["handle"] : null;
      let handlePath: string | undefined;
      let handleSymbol: string | undefined;
      let handleRange: string | undefined;

      if (handleId) {
        const entry = handleTable.get(handleId);
        if (!entry) {
          return toolStructuredError({ ok: false, reason: "handle-unknown" });
        }
        if (entry.workspaceRoot !== workspace) {
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
                next: handleWorkspaceMissingNext(res.handleWorkspace),
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
              next: `retry with cwd=${entry.workspaceRoot} or omit cwd`,
            });
          }
        }
        handlePath = entry.path;
        handleSymbol = entry.symbol;
        handleRange = entry.range;
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

      if (splitArchiveVirtualPath(filePath) || (isSupportedArchivePath(filePath) && !isWritableZipRequest)) {
        return toolStructuredError({
          ok: false,
          reason: "archive-member-read-only",
          code: "archive-member-read-only",
          path: filePath,
          next: "archive containers and members are read-only; edit the source file outside the archive",
        });
      }
      if (isBinaryDocumentPath && !artifactRequested) {
        return toolStructuredError({
          ok: false,
          reason: "artifact-edit-required",
          code: "artifact-edit-required",
          path: filePath,
          next: "pass artifact={kind:..., ...} and credentialRef when the document is password-protected",
        });
      }
      if (Array.isArray(args["edits"])) {
        for (const rawEdit of args["edits"] as unknown[]) {
          if (!rawEdit || typeof rawEdit !== "object") continue;
          const edit = rawEdit as Record<string, unknown>;
          const editHandle = typeof edit["handle"] === "string" ? handleTable.get(edit["handle"]) : undefined;
          const editPath = String(editHandle?.path ?? edit["path"] ?? "");
          if (splitArchiveVirtualPath(editPath) || isSupportedArchivePath(editPath)) {
            return toolStructuredError({
              ok: false,
              reason: "archive-member-read-only",
              code: "archive-member-read-only",
              path: editPath,
              next: "use one top-level edit_file artifact={kind:\"zip\",members:[...]} call for a ZIP copy-on-write edit",
            });
          }
          if (/\.(docx|xlsx|pptx|pdf)$/i.test(editPath)) {
            return toolStructuredError({
              ok: false,
              reason: "artifact-edit-required",
              code: "artifact-edit-required",
              path: editPath,
              next: "binary document edits cannot be mixed into edits[]; use one top-level artifact edit",
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
        return toolStructuredError(elidedContentRefusal({
          field: topLevelElisionField,
          path: filePath || undefined,
          range: handleRange,
        }));
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
        const postContent = binaryPostPath ? null : await readFileSafe(postPath, workspace);
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
          return await augmentEdit(resolved);
        } catch {
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
        // the one thing the server can actually prove: paths edit_file just
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
        const withUnreadNote = unreadNote !== undefined
          ? { ...withReclassification, unread_note: unreadNote }
          : withReclassification;
        const withApplied = editOk ? await attachAppliedReadback(withUnreadNote, args, workspace) : withUnreadNote;
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
            next: "use one artifact object with path/handle and optional credentialRef/outputCredentialRef",
          });
        }
        if (args["precondition"] !== undefined) {
          return toolStructuredError({
            ok: false,
            reason: "artifact-precondition-unsupported",
            next: "artifact writes already verify and atomically replace the complete binary; omit the text-edit precondition",
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
            next: "remove intent and keep edits[] for an ordinary batch, or remove edits[] and pass one top-level handle for the special intent",
          });
        }
        // Intents require a handle to scope the operation.
        if (!handleId) {
          return toolStructuredError({
            ok: false,
            reason: "intent-requires-handle",
            next: `read_file path=<file> to get a handle, then edit_file handle=<id> intent=${intentArg}`,
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
        // empirically confirmed live: edit_file({create:true, path:"new.ts",
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
            "create and edits[] cannot be combined — edits[] only modifies existing files; call edit_file with create:true separately (no edits[]) to create the file, then batch further edits in a follow-up edits[] call",
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
        // single edit_file `create:true` path's OWN cwd-less carve-out
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
          if (hasBatchCreate && !anyHandleBearing) {
            return toolStructuredError({
              ok: false,
              reason: "cwd-required-for-create",
              code: "cwd-required-for-create",
              applied: false,
              detail: "a batch create item names a new path with no handle to pin its workspace, so it cannot be inferred from the server default; pass cwd explicitly",
              next: "retry the same edits[] batch with an explicit top-level cwd",
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
              // Roots ride the prose: the v1 advisory allowlist drops
              // handleWorkspaces (2026-08-09 guard class, see read-side twin).
              next: `all handles in one batch must share a workspace (got: ${res.roots.join(", ")}); omit cwd or pass a single cwd`,
            });
          }
          if (res.kind === "missing") {
            return toolStructuredError({
              ok: false,
              reason: "handle-workspace-missing",
              handleWorkspace: res.handleWorkspace,
              next: handleWorkspaceMissingNext(res.handleWorkspace),
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
                next: `pass cwd=${res.workspace} explicitly, or give every edit a handle`,
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
            return toolStructuredError(elidedContentRefusal({
              field: entryElisionField,
              path: String(entryHandle?.path ?? entry["path"] ?? "") || undefined,
              range: entryHandle?.range ?? (typeof entry["range"] === "string" ? entry["range"] : undefined),
              failedItem: index,
            }));
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
                      tool: "edit_file",
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
                next: "directoryHandle is not supported on a batch edits[] create item — issue this create as its own single edit_file call (create:true, no edits[]), or resolve the directory to a plain path first",
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
                next: `${createTargetPath} appears in more than one edits[] item alongside a create:true entry — create it in its own call first, then edit it in a follow-up batch`,
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
                    next: `retry with cwd=${resolved.entry.workspaceRoot} or omit cwd`,
                    failed_item: { index },
                  });
                }
                if (resolved.reason === "workspace-missing") {
                  return toolStructuredError({
                    ok: false,
                    reason: "handle-workspace-missing",
                    handle: String(entry["from"]),
                    handleWorkspace: resolved.entry.workspaceRoot,
                    next: handleWorkspaceMissingNext(resolved.entry.workspaceRoot),
                    failed_item: { index },
                  });
                }
                return toolStructuredError({
                  ok: false,
                  code: "invalid-input",
                  reason: "batch-create-source-unreadable",
                  applied: false,
                  failed_item: { index, path: createTargetPath },
                  next: `from=${String(entry["from"])} did not resolve to a readable handle or path — supply content instead, or fix the from= source`,
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
                next: "a batch create item needs content or from=",
              });
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
            return toolStructuredError({
              ok: false,
              reason: "precondition-unsupported-for-batch",
              precondition: "unique-match",
              failed_item: { index },
              next: "unique-match requires a non-empty search on the affected edits[] item",
            });
          }
          const entryHandleId = typeof entry["handle"] === "string" ? entry["handle"] : undefined;

          if (entryHandleId) {
            const hEntry = handleTable.get(entryHandleId);
            if (!hEntry) {
              return toolStructuredError({ ok: false, reason: "handle-unknown" });
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
                next: `retry with cwd=${hEntry.workspaceRoot} or omit cwd`,
              });
            }
            if (!hEntry.path) {
              return toolStructuredError({ ok: false, reason: "handle-unknown" });
            }
            if (entryPrecondition !== undefined && entryPrecondition !== "unique-match") {
              const preCheck = await enforcePreconditions(
                { ...args, ...entry, precondition: entryPrecondition },
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
            if (effectiveRange && entryContent === undefined && (entry["search"] === undefined || entry["search"] === "")) {
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
                  tool: "edit_file",
                  arguments: {
                    edits: [{ handle: entryHandleId, content: "<replacement text for the WHOLE range>" }],
                    ...(typeof args["cwd"] === "string" ? { cwd: args["cwd"] } : {}),
                  },
                },
              });
            }
            if (effectiveRange && entryContent !== undefined && entry["search"] === undefined && entry["replace"] === undefined) {
              // {handle, range, content} (anchor) / {handle, content} (range
              // handle): range-content replacement.
              typedEdits.push({
                path: hEntry.path,
                search: "",
                replace: "",
                range: effectiveRange,
                content: String(entryContent),
                ...anchorCas,
              });
            } else if (effectiveRange) {
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
              typedEdits.push({ path: hEntry.path, search: "", replace: "", content: String(entryContent) });
            } else {
              // Plain file/symbol handle with no range: whole-file exact search/replace.
              typedEdits.push({
                path: hEntry.path,
                search: String(entry["search"] ?? ""),
                replace: String(entry["replace"] ?? ""),
                ...(uniqueMatchBatch ? { uniqueMatch: true } : {}),
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
          if (entryPrecondition !== undefined && entryPrecondition !== "unique-match") {
            const preCheck = await enforcePreconditions(
              { ...args, ...entry, precondition: entryPrecondition },
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
          if (entry["content"] !== undefined && entry["search"] === undefined) {
            const existingCheckForBatchContentMsg = await readFileSafeOpt(bareEntryPath, workspace);
            if (existingCheckForBatchContentMsg !== null) {
              // #28/#29 (C2-6 audit): well-formed item, existing file, no
              // create — "ambiguous write intent" had no A.7.1 member of its
              // own and rode `invalid-input` per the C2-6 work item's explicit
              // resolution. R5-29 (ratified 2026-08-14) minted
              // `write-intent-ambiguous` for this emitter and the single-edit
              // twin at :9335.
              return toolError(FILE_EXISTS_FULL_BODY_MSG, { code: "write-intent-ambiguous" });
            }
          }
          typedEdits.push({
            path: bareEntryPath,
            search: String(entry["search"] ?? ""),
            replace: String(entry["replace"] ?? ""),
            ...(uniqueMatchBatch ? { uniqueMatch: true } : {}),
          });
        }

        const result = await applyEditsMulti({ edits: typedEdits }, workspace, ALLOW_WRITE, SESSION_ID);
        if (!result.ok && result.code === "search-not-unique") {
          return toolStructuredError({
            ok: false,
            reason: "search-not-unique",
            ...(result.path ? { path: result.path } : {}),
            detail: result.error,
          });
        }
        return toolOk(await finishEdit(withReview(await withHandleAugment(result as unknown as Record<string, unknown>))));
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
                next: `directoryHandle and from resolve to different worktrees; retry with cwd=${dirEntryForGuard.workspaceRoot} (to use the directory's tree) or cwd=${fromEntryForGuard.workspaceRoot} (to use the source's tree), or pass a directoryHandle/from pair from the same worktree`,
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
              next: "edit_file create=true path=<dir>/<file> cwd=<workspace root> — or re-read the directory to mint a fresh directoryHandle",
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
                  next: handleWorkspaceMissingNext(res.handleWorkspace),
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
                next: `retry with cwd=${dirEntry.workspaceRoot} or omit cwd`,
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
                next: `retry with cwd=${resolved.entry.workspaceRoot} or omit cwd`,
              });
            }
            if (resolved.reason === "workspace-missing") {
              // H2: the worktree the source handle was minted in no longer exists.
              return toolStructuredError({
                ok: false,
                reason: "handle-workspace-missing",
                handle: String(args["from"]),
                handleWorkspace: resolved.entry.workspaceRoot,
                next: handleWorkspaceMissingNext(resolved.entry.workspaceRoot),
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
        // (edit_file create:true search:"" replace:"<body>") — the same
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
        const result = await createFile(
          { path: createPath, content: createBody },
          workspace, ALLOW_WRITE, SESSION_ID,
        );
        const createAugmented = await withHandleAugment(result as unknown as Record<string, unknown>);
        // W1 (2026-08-07, create-frontier lifecycle): a created file used to be
        // a second-class citizen the moment it existed — the success payload
        // was {ok,path,bytes} with NO handle, and the path entered no
        // admissible set, so the very next edit_file against it was refused
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
            handle: createdHandle.id,
            sha: shortSha(createdSha),
            total_lines: countLines(createBody),
            read_back: {
              // B1 (v0.12): shortened — same pointer, teaching moved to guide.
              note: "answers a cited line N — fill range",
              next_call_is_template: true,
              next_call: {
                tool: "read_file",
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
      // NO stored range — minted by e.g. read_file mode=full) used to fall
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

      // FIX A.3 (2026-07-12c forensics): `edit_file {path, content}` with
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
        const existingCheckForContentMsg = await readFileSafeOpt(filePath, workspace);
        if (existingCheckForContentMsg !== null) {
          // #28/#29 (C2-6 audit): same gap as the batch site above, closed by
          // the same R5-29 mint.
          return toolError(FILE_EXISTS_FULL_BODY_MSG, { code: "write-intent-ambiguous" });
        }
        // Missing file: fall through unchanged to searchReplaceEdit's own
        // not-found + create:true hint further below.
      }

      // Existing schema, new behavior: target="all" on a range handle applies a
      // scoped replace-all. This keeps large repetitive replacements tiny.
      if (handleId && handleRange && args["target"] === "all" && typeof args["search"] === "string") {
        const preCheckRangeAll = await enforcePreconditions(args, effectivePath, workspace, readFileSafeOpt);
        if (!preCheckRangeAll.ok) {
          return toolStructuredError(preCheckRangeAll.failure as unknown as Record<string, unknown>);
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
              reason: "search-not-unique",
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
        const fileContent = await readFileSafe(filePath, workspace);
        if (fileContent !== null) {
          const normalized = fileContent.replace(/\r\n/g, "\n").replace(/\r/g, "\n").normalize("NFC");
          const normalizedSearch = search.replace(/\r\n/g, "\n").replace(/\r/g, "\n").normalize("NFC");
          let count = 0;
          let idx2 = normalized.indexOf(normalizedSearch);
          while (idx2 !== -1) {
            count++;
            idx2 = normalized.indexOf(normalizedSearch, idx2 + normalizedSearch.length);
            if (count > 1) break;
          }

          if (count === 1) {
            // Unique match — mint a file handle before applying the write.
            const fileSha = shaOfText(fileContent);
            const minted = handleTable.upsert({ kind: "file", path: filePath, workspaceRoot: workspace, sha: fileSha });
            autoMintedHandleId = minted.id;
          } else if (args["allowPathFallback"] === false) {
            // Non-unique match with allowPathFallback=false: return structured refusal.
            // Provide up to 3 candidate file handles for this path.
            const candidates = [
              handleTable.upsert({ kind: "file", path: filePath, workspaceRoot: workspace }),
            ].map((h) => ({ handle: h.id, path: filePath }));
            return toolStructuredError({
              ok: false,
              reason: "handle-required",
              path: filePath,
              candidates,
              next: `edit_file handle=${candidates[0]!.handle}`,
            });
          } else {
            // Non-unique match, no explicit allowPathFallback=false, but adaptive session
            // control may require lockdown when the agent has demonstrated handle use but
            // keeps regressing to path edits.
            if (args["allowPathFallback"] !== true) {
              const adaptiveAdvice = getAdaptiveAdvice(workspace);
              if (adaptiveAdvice.lockdownPathEdits) {
                // Lockdown: agent regressed to path edits after using handles.
                const candidates = [
                  handleTable.upsert({ kind: "file", path: filePath, workspaceRoot: workspace }),
                ].map((h) => ({ handle: h.id, path: filePath }));
                return toolStructuredError({
                  ok: false,
                  reason: "handle-required-lockdown",
                  path: filePath,
                  candidates,
                  next: `edit_file handle=${candidates[0]!.handle}  (path-edit loop detected; use handles)`,
                });
              }
            }
          }
        }
      }

      const result = await searchReplaceEdit(
        // FIX 2d: create:true is edit_file's ADVERTISED name for this. C-6
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

      // AUDIT (argument-combination matrix, 2026-07-12): `target` is read in
      // exactly ONE place in this dispatch — the handleId+handleRange+
      // target==="all" branch far above, which calls replaceAllInRange.
      // Anywhere else (this plain path+search fallback included), `target`
      // is silently unconsumed. That is usually harmless (target="all" with
      // a search that happens to match exactly once behaves identically to
      // ordinary single-match edit_file — confirmed live, still ok:true, no
      // regression here), but when the search legitimately matches more than
      // once — precisely the case target=all exists for — applySingleEdit's
      // "ambiguous" refusal reads "add more surrounding context to make it
      // unique", which directly CONTRADICTS what the caller asked for
      // (replace every match, not narrow to one). Empirically confirmed
      // live. Rather than block this call shape outright (that would also
      // reject the harmless exactly-one-match case), append the real fix as
      // a `hint` so the response, taken as a whole, is no longer misleading
      // — the original error/candidates are left completely intact.
      if (args["target"] === "all" && !(handleId && handleRange) && (result as { code?: string }).code === "ambiguous") {
        (result as Record<string, unknown>)["hint"] =
          'target="all" only replaces every occurrence when scoped to a range handle: read_file mode=slice to mint one, then edit_file handle=<id> target=all search=... replace=...; without a handle, edit_file still requires search to match exactly once';
      }

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
          const autoPostContent = await readFileSafe(filePath, workspace);
          const autoPostSha = autoPostContent !== null ? shaOfText(autoPostContent) : undefined;
          if (autoPostSha !== undefined) {
            handleTable.refreshSha(autoMintedHandleId, autoPostSha);
          }
          return toolOk(await finishEdit(withReview({
            ...(result as Record<string, unknown>),
            handle: autoMintedHandleId,
            ...(autoPostSha !== undefined ? { sha: shortSha(autoPostSha) } : {}),
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

      return toolOk(await finishEdit(withReview(await withHandleAugment(result as unknown as Record<string, unknown>))));
    }

    // -----------------------------------------------------------------
    // Consolidated search_files — find, symbols, references, diff, locate, tree, office
    // -----------------------------------------------------------------
    case "search_files": {
      // P1 / D2 / ORCHESTRATOR CONDITION ② (§1.3.1(1)) — see the read_file arm.
      const unknownArgsRefusalSearch = requestShapeRefusal("search_files", dispatchPropertiesFor("search_files"), args);
      if (unknownArgsRefusalSearch !== null) return toolStructuredError(unknownArgsRefusalSearch);
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
      // PI-09 — see the read_file arm.
      const taskHandleRefusalSearch = taskHandleRefusal(args, workspace);
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
      // I-7 (2026-08-30 forensics attribution wave): see the read_file arm's
      // own comment -- same pre-guard snapshot, same rationale.
      if (args["taskEpoch"] !== "new" && getExecutionFence(workspace)?.phase === "prepared") {
        notePostReadyDiscovery({
          forceServe: args["force_serve"] === true,
          scopeClass: discoveryScopeClass(args),
        });
      }
      const executionGuard = guardExecutionDiscovery(workspace, "search_files", args);
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
        const archiveBytes = await readBytesSafe(archiveSearchPath, workspace);
        if (archiveBytes === null) {
          return toolStructuredError({
            ok: false,
            code: "archive-not-found",
            error: `File not found or outside workspace: ${archiveSearchPath}`,
          });
        }
        if (action === "tree") {
          const treeResult = await archiveTree(
            archiveBytes,
            archiveSearchPath,
            workspace,
            archivePrefix,
            credential.password,
          );
          // D4 / A.5.10 (C2-4): the `mode:"tree"` stamp is DELETED. `kind` is
          // the sole discrimination contract, and this response's kind is
          // `search.tree`; a second, differently-spelled discriminator is the
          // probe-by-field-presence D4 exists to remove.
          return treeResult.ok
            ? toolOk({ ...treeResult.data })
            : toolStructuredError(treeResult as unknown as Record<string, unknown>);
        }
        const archiveQuery = args["query"] !== undefined
          ? String(args["query"])
          : Array.isArray(args["queries"])
            ? (args["queries"] as unknown[]).map(String).join(" ")
            : "";
        if (!archiveQuery) return toolError("search_files find: query or queries is required");
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
        const rawQueries = args["queries"];
        const hasQueries = rawQueries !== undefined;
        const queryStr = args["query"] !== undefined && args["query"] !== null ? String(args["query"]) : "";
        const hasQuery = queryStr.length > 0;

        if (hasQueries && hasQuery) {
          return toolError("search_files find: pass exactly one of query or queries, not both", { code: "invalid-input" });
        }
        if (!hasQueries && !hasQuery) {
          return toolError("search_files find: query or queries is required (queries: 1-5 literal tokens, OR-matched)", { code: "invalid-input" });
        }

        if (hasQueries) {
          if (!Array.isArray(rawQueries) || rawQueries.length === 0) {
            return toolError("queries must be a non-empty array of 1-5 literal tokens", { code: "invalid-input" });
          }
          if (rawQueries.length > 5) {
            // D4 (2026-08-01 probe sweep): the generic refusal guidance used to
            // misroute this to task_pack; the correct remedy is splitting the
            // SAME find into <=5-entry calls, so name it explicitly (an
            // explicit `next` wins over the derived default).
            //
            // FIELD DEFECT (2026-08-27 field-eval T2): `next` only ever named
            // the FIRST 5 tokens — the remaining tail was named solely in
            // `hint`'s prose (a COUNT, not the tokens themselves), so a caller
            // had to hand-slice its own original `queries[]` to build the
            // second call. `remaining_queries` carries the exact tail, in the
            // same stringified form `next`'s `head` uses, so the follow-up
            // call needs no slicing. Named distinctly from the top-level
            // `Refusal.remaining` STRING slot (A.5.15, protocol/refusal.ts's
            // `remainingOf`) it rides beside — that slot drops array values,
            // so this is a separate advisory key, allowlisted in
            // protocol/refusal.ts's `REFUSAL_ADVISORY_KEYS`.
            const head = (rawQueries as unknown[]).slice(0, 5).map(String);
            const remainingQueries = (rawQueries as unknown[]).slice(5).map(String);
            return toolStructuredError({
              ok: false,
              code: "invalid-input",
              error: `queries accepts at most 5 entries, got ${rawQueries.length}`,
              next: `search_files action=find queries=${JSON.stringify(head)}`,
              hint: `queries is OR-matched and capped at 5 per call — run the suggested call, then a second find for the remaining ${rawQueries.length - 5} token(s)`,
              remaining_queries: remainingQueries,
            });
          }
          if (!rawQueries.every((q) => typeof q === "string" && q.length > 0)) {
            return toolError("each entry in queries must be a non-empty string", { code: "invalid-input" });
          }
          const queries = rawQueries as string[];
          // Feature 2 (2026-07-12b2): harvest concern-anchor tokens from a
          // search_files find call so Guard 2 / the unread-sibling note
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
          const outcome = annotateServedFindHits(buildFindResponseForQueries(
            {
              queries,
              ...(args["regex"] !== undefined ? { regex: Boolean(args["regex"]) } : {}),
              ...(lang ? { lang } : {}),
              ...(args["path"] !== undefined ? { path: String(args["path"]) } : {}),
            },
            workspace,
          ), workspace, args);
          // L2: an escalation is a refusal body, not a result set — the hop-1
          // attachment describes files[] snippets it no longer carries.
          if (outcome.escalated) return toolOk(outcome.body);
          return toolOk(queries.length === 1
            ? attachSearchHop1(outcome.body, workspace, queries[0]!, "find")
            : outcome.body);
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
          { extraHint: findHint },
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
        // `absence` is the authoritative scope certificate object (not a
        // boolean) on the find payload. Its presence is the server's completed
        // zero-result proof; `=== true` silently discarded that proof.
        const absent = (outcome.body as { absence?: unknown }).absence !== undefined ? [queryStr] : [];
        // `next.arguments` intentionally carries no hidden task_handle. Bind
        // it internally to the unique pack that issued this exact executable
        // find. A collision in one lane resolves to undefined and proves
        // nothing rather than guessing which task's ledger to discharge.
        const nextScope = absent.length > 0 ? consumeExecutableNextScope(workspace, sessionLaneOf(args), {
          tool: "search_files",
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
            tool: "search_files",
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
        return toolOk(attachSearchHop1(outcome.body, workspace, queryStr, "find"));
      }
      if (action === "references") {
        const symbol = String(args["symbol"] ?? args["query"] ?? "");
        const response = await findReferences(
          {
            symbol,
            ...(lang ? { lang } : {}),
            ...(args["path"] !== undefined ? { path: String(args["path"]) } : {}),
            // L2 (2026-08-01 references-contract): `limit` is advertised on
            // search_files but used to be dropped on this branch alone.
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
            tool: "search_files",
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
        return toolOk(attachSearchHop1(response, workspace, symbol, "references"));
      }
      if (action === "symbols") {
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

        const limit = typeof args["limit"] === "number" ? args["limit"] : undefined;
        const includeScores = typeof args["includeScores"] === "boolean" ? args["includeScores"] : undefined;
        const symbolsResult = await searchSymbols(
          {
            query: rawQuery,
            ...(lang ? { lang } : {}),
            ...(hasSymbolPath ? { path: rawSymbolPath } : {}),
            ...(limit !== undefined ? { limit } : {}),
            ...(includeScores !== undefined ? { includeScores } : {}),
          },
          workspace,
        );
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
          recordReadMode(workspace, "task_pack");
          const result = await buildTaskPack(
            {
              ...searchTaskCredential,
              // PI-09 close-out: the explicit "I lost my context" switch.
              ...(args["force_serve"] === true ? { forceServe: true as const } : {}),
              query: args["query"] ? String(args["query"]) : undefined,
              ...(parseTaskProfile(args["taskProfile"]) ? { taskProfile: parseTaskProfile(args["taskProfile"]) } : {}),
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
          // A.5.1 (C2-3): `includeClosure:true` routes a `search_files` call to
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
        return toolOk(locateResult);
      }
      if (action === "tree") {
        // Compact file inventory — tools/exploreTree.ts buildCompactTree
        // (subdir-rooted, byte-capped, symlink-escape-guarded).
        const treePath = args["path"] !== undefined ? String(args["path"]) : undefined;
        const treeDepth = typeof args["depth"] === "number" ? args["depth"] : undefined;
        const result = buildCompactTree(workspace, treePath, treeDepth);
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
          tool: "search_files",
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
        if (DOC_DISABLED) return toolError("Document extraction is disabled.", { code: "not-a-document" });
        const officePath = String(args["path"] ?? "");
        if (!officePath) return toolError("path is required", { code: "invalid-input" });
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
        // `search_files` is a `read.artifact`; without this declaration it fell
        // through `kindForCall`'s search default and claimed `search.matches`,
        // a member whose required set it cannot satisfy and whose `matches`
        // wrapper it does not have.
        declareKind("read.artifact");
        return toolOk(officeResult.data);
      }
      return toolError(`Unknown search_files action: ${action}. Use find, symbols, references, diff, locate, or tree.`, { code: "invalid-input" });
    }

    default:
      // D11: `canonical` IS the caller's raw `name` — the CANON rewrite table
      // is deleted, so nothing is folded before this switch. Every name that is
      // not one of the three advertised tools lands here, the 12 deleted
      // aliases included.
      return toolError(`Unknown tool: ${canonical}`, { code: "invalid-input" });
  }
}

/** Guard 1 root_note hard length cap (2026-07-12b) — see dispatchWithWorkspaceNotes. */
const MAX_ROOT_NOTE_CHARS = 160;

/**
 * Canonical tool names Guard 1's root_note rides on.
 *
 * READ side (2026-07-12b): read_file/search_files.
 *
 * WRITE side (2026-08-01): every entry point that can WRITE through a
 * silently-defaulted root. A wrong-root READ costs a turn; a wrong-root
 * WRITE lands bytes in a tree the caller never named and reports plain
 * success — measured in bench 2026-08-01-semantic-signal5-2 (T13 rep2),
 * where a cwd-less `edit_file {path:"bench/fixtures/.../x.cpp",
 * create:true}` created a 4937-byte file in the server's own default
 * checkout and answered `{"ok":true,...}` with nothing naming the root.
 * The write paths must therefore self-identify at least as loudly as the
 * read paths. D11: edit_file is now the ONLY write entry point — the four
 * deprecated write aliases that used to share this seam are deleted.
 */
const ROOT_NOTE_READ_TOOLS = new Set(["read_file", "search_files"]);
const ROOT_NOTE_WRITE_TOOLS = new Set(["edit_file"]);

/**
 * True when the call pins its own workspace through a handle rather than the
 * ambient default root. A handle carries its mint root (and edit_file adopts
 * that root when cwd is omitted), so such a call is never a silent
 * default-root resolution. `edits[].handle` is the batch-write analogue of
 * `handles[]`; read paths never carry `edits`, so read behavior is unchanged.
 */
function callPinsRootViaHandle(args: Record<string, unknown>): boolean {
  if (typeof args["handle"] === "string") return true;
  const handles = args["handles"];
  if (Array.isArray(handles) && handles.length > 0) return true;
  const edits = args["edits"];
  if (Array.isArray(edits)) {
    for (const entry of edits) {
      if (
        entry
        && typeof entry === "object"
        && typeof (entry as Record<string, unknown>)["handle"] === "string"
      ) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Guard 1's note text, shared verbatim by the read and write paths so one
 * `root_note` shape (and one length cap) covers both.
 *
 * Returns undefined when no OTHER workspace is active this server lifetime:
 * with a single root there is no ambiguity to disclose, and consumers treat
 * any root_note as a hard "this response came from the wrong tree" marker,
 * so it must never fire on the unambiguous case.
 */
function rootMismatchNote(resolvedRoot: string): string | undefined {
  const others = otherActiveRoots(resolvedRoot);
  if (others.length === 0) return undefined;
  const otherNames = others.slice(0, 2).map((r) => path.basename(r)).join(", ");
  let note = `resolved against server default root ${path.basename(resolvedRoot)}; other active workspace(s): ${otherNames} — pass cwd if you meant one of those`;
  if (note.length > MAX_ROOT_NOTE_CHARS) note = note.slice(0, MAX_ROOT_NOTE_CHARS - 1) + "…";
  return note;
}

/**
 * Public dispatch entry point. Routes to the C2 lean protocol when
 * protocol v1 funnel (runWithProtocolCall / finalizeProtocolResponse) over
 * dispatchWithWorkspaceNotes, which carries Fix 3's cwd auto-correction and
 * Guard 1's root_note — see that function's own doc comment for both.
 */
async function callToolUninstrumented(name: string, args: Record<string, unknown>) {
  const canonical = name;

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
  const runThroughFunnel = (): Promise<ToolCallResult> =>
    runWithProtocolCall(
      { tool: canonical, args, ...(clientId !== undefined ? { clientId } : {}) },
      async () => finalizeProtocolResponse(canonical, await dispatchWithWorkspaceNotes(canonical, args)),
    );

  // PI-09 close-out: `operation_id` is edit-only (see its schema comment), so
  // only edit_file is wrapped; a read tool that sends it is refused by the
  // strict `unknown-arguments` fence inside dispatch. The wrapper sits OUTSIDE
  // the funnel deliberately — see `runEditWithOperationId`'s doc comment.
  if (canonical === "edit_file" && args["operation_id"] !== undefined) {
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
 * Fix 3: read_file/search_files-ONLY cwd auto-correction (a hallucinated
 * `.claire` cwd, or checkCwdOrRefuse's own single unambiguous
 * `nearest_existing` suggestion — see checkCwdWithCorrection's doc comment).
 * edit_file and every write path is unaffected: canonical is never
 * "read_file"/"search_files" for them, so dispatchTool's own
 * checkCwdOrRefuse call runs completely unmodified for writes.
 *
 * Also Guard 1 (2026-07-12b; write paths 2026-08-01): a cwd-less,
 * handle-less call that resolves against the default root while another
 * workspace is also active this session carries a root_note — on the read
 * tools and on every write entry point in ROOT_NOTE_WRITE_TOOLS, so a
 * silent wrong-root WRITE self-identifies instead of reporting bare
 * success. See the otherActiveRoots block below.
 */
async function dispatchWithWorkspaceNotes(canonical: string, args: Record<string, unknown>) {
  let cwdCorrection: CwdCorrection | undefined;
  if (canonical === "read_file" || canonical === "search_files") {
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
  // -- read_file/search_files never called `noteWorkspaceRoot` (only
  // edit_file's finishEdit does), so the codec pipeline's
  // `context.workspace !== undefined` trace gate was permanently closed for
  // the two codec-ELIGIBLE tools, and the wire_codec_shadow/
  // wire_codec_v2_cell measurement feed could never fire through real
  // dispatch (F-C2). `callWorkspaceRoot` (just above) is exactly the root
  // dispatchTool is about to run against (`runWithCallWorkspace` below), so
  // this is the SAME value, taken at dispatch entry rather than at a
  // write's completion because read_file/search_files have no post-dispatch
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
  // `noteWorkspaceRoot`'s own edit_file call site (finishEdit, below) is
  // untouched either way.
  //
  // We are still inside runWithProtocolCall's AsyncLocalStorage scope here
  // (callToolUninstrumented's runThroughFunnel wraps this whole function), so
  // the note lands in the same context finalizeProtocolResponse reads later,
  // exactly like finishEdit's own call does many frames deeper.
  if ((canonical === "read_file" || canonical === "search_files") && callWorkspaceRoot !== undefined) {
    noteCodecTraceWorkspace(callWorkspaceRoot);
  }
  const result = await runWithCallWorkspace(callWorkspaceRoot, () => runWithDeclaredWorkspace(
    declaredWorkspaceForCall(args),
    () => dispatchTool(canonical, args),
  ));
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
  // top-level payload. cwd_corrected stays SUCCESS-only — an error response
  // (handle-unknown, cap-exceeded, etc.) reports the failure it hit, not an
  // unrelated cwd fixup — while a write path's root_note also rides its
  // structured refusals, per the condition above.
  const stampRootNoteOnError =
    rootNote !== undefined && rootNoteWriteTool && result.isError === true;
  if (
    (cwdCorrection || rootNote || workspaceDisclosure)
    && (!result.isError || stampRootNoteOnError)
  ) {
    try {
      const parsed = JSON.parse(result.content[0]!.text) as Record<string, unknown>;
      const payload = {
        ...parsed,
        ...(cwdCorrection && !result.isError ? { cwd_corrected: cwdCorrection } : {}),
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

let usageRecorder: UsageRecorder | undefined;

function recorder(): UsageRecorder {
  usageRecorder ??= createUsageRecorder({
    workspaceRoot: activeRoot,
    sessionId: SESSION_ID,
    serverVersion: SERVER_PACKAGE_VERSION,
    serverBuild: SERVER_BUILD_ID,
  });
  return usageRecorder;
}

interface ReadBaselineMeasurement {
  tokens: number | null;
  uncreditedPaths: string[];
}

const creditedReadPathsByLane = new Map<string, Set<string>>();

function readBaselineMeasurement(
  canonical: string,
  args: Readonly<Record<string, unknown>>,
): ReadBaselineMeasurement {
  if (canonical !== "read_file") return { tokens: null, uncreditedPaths: [] };
  let workspace: string;
  try {
    workspace = resolveWorkspaceRoot(
      typeof args["cwd"] === "string" ? args["cwd"] : undefined,
      activeRoot,
    );
  } catch {
    return { tokens: null, uncreditedPaths: [] };
  }
  const requested: string[] = [];
  if (typeof args["path"] === "string") requested.push(args["path"]);
  if (Array.isArray(args["paths"])) {
    for (const item of args["paths"]) {
      if (typeof item === "string") requested.push(item);
      else if (
        item
        && typeof item === "object"
        && !Array.isArray(item)
        && typeof (item as Record<string, unknown>)["path"] === "string"
      ) {
        requested.push((item as Record<string, string>)["path"]!);
      }
    }
  }

  const lane = sessionLaneOf(args as Record<string, unknown>);
  const credited = creditedReadPathsByLane.get(lane) ?? new Set<string>();
  let bytes = 0;
  let measured = 0;
  const uncreditedPaths: string[] = [];
  for (const requestedPath of new Set(requested)) {
    const absolute = path.resolve(workspace, requestedPath);
    const relative = path.relative(workspace, absolute);
    if (
      relative === ".."
      || relative.startsWith(`..${path.sep}`)
      || path.isAbsolute(relative)
    ) {
      continue;
    }
    try {
      const stat = statSync(absolute);
      if (!stat.isFile()) continue;
      measured++;
      const key = process.platform === "win32"
        ? path.normalize(absolute).toLowerCase()
        : path.normalize(absolute);
      if (credited.has(key)) continue;
      bytes += stat.size;
      uncreditedPaths.push(key);
    } catch {
      // Missing and virtual/archive paths simply have no measurable baseline.
    }
  }
  return {
    tokens: measured > 0 ? estimateTokensFromBytes(bytes) : null,
    uncreditedPaths,
  };
}

function commitReadBaseline(
  measurement: ReadBaselineMeasurement,
  args: Readonly<Record<string, unknown>>,
): void {
  if (measurement.uncreditedPaths.length === 0) return;
  const lane = sessionLaneOf(args as Record<string, unknown>);
  const credited = creditedReadPathsByLane.get(lane) ?? new Set<string>();
  for (const key of measurement.uncreditedPaths) credited.add(key);
  creditedReadPathsByLane.set(lane, credited);
}

// One fixed lane value per concurrent agent; 64 chars is plenty for any
// orchestrator-assigned key and keeps composite session keys bounded.
const SESSION_LANE_MAX_CHARS = 64;

/** Structured refusal for a malformed `lane`, or null when the lane is usable. */
function sessionLaneRefusal(args: Record<string, unknown>) {
  const raw = args["lane"];
  if (raw === undefined || (typeof raw === "string" && raw.length <= SESSION_LANE_MAX_CHARS)) return null;
  // A partition key is never coerced: silently landing a call in the wrong
  // lane is the exact cross-agent mixing lanes exist to prevent.
  return toolStructuredError({
    ok: false,
    reason: "invalid-lane",
    error: `lane must be a string of at most ${SESSION_LANE_MAX_CHARS} characters — one fixed value per concurrent agent`,
    next: "re-issue this exact call with a valid lane, or omit lane to use the shared default session",
  });
}

/** The validated lane of a call; "" (the shared default session) when absent. */
function sessionLaneOf(args: Record<string, unknown>): string {
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
function contractLaneOf(args: Record<string, unknown>): string {
  return normalizeContractLane(sessionLaneOf(args));
}

/** The authenticated scope available internally for task-pack construction. */
function taskContractScopeOf(args: Record<string, unknown>): TaskContractScope {
  const taskHandle = args["task_handle"];
  return {
    lane: sessionLaneOf(args),
    ...(typeof taskHandle === "string" && taskHandle.length > 0 ? { taskHandle } : {}),
  };
}

/** Bytes of the payload an MCP client hands to the model: content[*].text only. */
export function modelVisibleBytes(result: { content: Array<{ text: string }> }): number {
  let bytes = 0;
  for (const item of result.content) bytes += Buffer.byteLength(item.text, "utf8");
  return bytes;
}

// Mirrors the `mode`/`action` enum literals advertised in the read_file/
// search_files tool input schemas above (see the `mode`/`action` `enum:`
// entries near each tool's registration) — kept as a private allowlist here,
// not a shared contract, purely so the diagnostics ring file (packages/usage's
// diagRing.ts) never carries anything but a known enum token in its `mode`
// field.
const DIAG_READ_FILE_MODES = new Set([
  "auto", "skeleton", "symbol", "full", "pack", "map", "digest",
  "slice", "task_pack", "small_file", "artifact", "archive", "overview", "closure",
]);
const DIAG_SEARCH_FILES_ACTIONS = new Set([
  "find", "symbols", "references", "diff", "locate", "tree",
]);

/** Diagnostics-only mode label for the last-call ring file — an enum value, never free user text. */
function observedCallMode(canonical: string, args: Record<string, unknown>): string | undefined {
  if (canonical === "read_file") {
    const mode = args["mode"];
    return typeof mode === "string" && DIAG_READ_FILE_MODES.has(mode) ? mode : undefined;
  }
  if (canonical === "search_files") {
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
function observedEnvelopeMeta(
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
 * from `args.query` (a fresh request) or `args.qref` (a replay) so read_file
 * and search_files both feed the trace envelope's `task_ref` without their
 * own deep dispatch internals (resolveTaskPackQueryArg et al.) changing.
 * `repeated` means this ref was ALREADY the workspace session's active qref
 * before this call — a genuine same-qref re-pack. Returns undefined when
 * neither arg names a task (edit_file; a path/handle-only read) — task_ref
 * stays a "when known" envelope field, never fabricated. Must run inside the
 * caller's OWN session lane (see the runWithSessionLane wrapper at the call
 * site below) — resolveTaskQueryRef reads lane-scoped session state.
 */
function dispatchTaskRef(
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
 * PI-03: read the trusted-client-host channel and, when it VERIFIES, bind it to
 * this call and mint the host-visible `context_handle`.
 *
 * Everything about this is fail-closed. The flag is off by default, so
 * `verifyContextAttestation` returns `disabled` and this is a single boolean
 * read; with the flag on, an absent / malformed / tampered / stale / foreign
 * attestation returns `undefined`, which is byte-identically the unattested
 * path. `try/catch` around the whole thing because an attestation channel that
 * threw would otherwise be a way to fail a tool call from outside.
 */
function verifiedContextFor(
  args: Record<string, unknown>,
  requestMeta: Record<string, unknown> | undefined,
): VerifiedContextAttestation | undefined {
  if (requestMeta === undefined) return undefined;
  try {
    const workspaceRoot = resolveWorkspaceRoot(
      typeof args["cwd"] === "string" ? args["cwd"] : undefined,
      activeRoot,
    );
    const verdict = verifyContextAttestation({ meta: requestMeta, workspaceRoot });
    if (!verdict.ok) return undefined;
    const contextHandle = mintContextHandle(workspaceRoot, verdict.attestation, verdict.generation);
    return {
      attestation: verdict.attestation,
      generation: verdict.generation,
      workspaceRoot,
      ...(contextHandle !== undefined ? { contextHandle } : {}),
    };
  } catch {
    return undefined;
  }
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
 * `requestMeta` is the `tools/call` params `_meta`, forwarded verbatim by all
 * three transport legs (legacy SDK, hand-rolled JSON-RPC fallback, modern SDK
 * v2). It is UNTRUSTED INPUT: the only thing read out of it is PI-03's
 * attestation channel, and that is authenticated before it can change
 * anything. Optional, so every existing caller — and every test — is unchanged.
 */
export async function callTool(
  name: string,
  args: Record<string, unknown>,
  requestMeta?: Record<string, unknown>,
) {
  const legacyArgs = normalizeCanonicalRequest(name, args);
  return runWithTraceCall(() => callToolTraced(name, legacyArgs, requestMeta));
}

async function callToolTraced(
  name: string,
  args: Record<string, unknown>,
  requestMeta?: Record<string, unknown>,
) {
  const canonical = name;
  // V10-04 (beta.1): advisory route classification (routing/classifier.ts) —
  // observability only, nothing below branches on it. Cheap pure string
  // classification, computed unconditionally so the trace call always has a
  // decision to record.
  const routeDecision = classifyRoute(canonical, args);
  setTraceContext({ route: routeDecision.route });
  // V13 (2026-08-30): hoisted out of the trace try-block below so the usage
  // recorder — in the SEPARATE try/catch further down, success path AND the
  // outer catch's error path — can stamp the SAME per-call task_ref onto its
  // NDJSON event. Was previously a `const` scoped entirely inside that first
  // try block, invisible to both `recorder().record()` call sites; see
  // `TokenLightenUsageEvent.taskRef`'s doc for what the recorder does with it
  // (task-grouped `summarizeUsage` accounting). Left `undefined` when the
  // trace try-block below throws before assigning it, or never runs at all —
  // exactly the "call named no task" case the recorder already treats as
  // `taskRef: null`.
  let dispatchQueryRef: { ref: string; repeated: boolean } | undefined;
  try {
    const cwd = typeof args["cwd"] === "string" ? args["cwd"] : undefined;
    const workspaceRoot = resolveWorkspaceRoot(cwd, activeRoot);
    traceCausalAttestation(workspaceRoot);
    // V10-02: resolve task_ref BEFORE route_decision fires (must run inside
    // the CALLER's session lane -- 2026-08-07 concurrent-agent lanes -- so a
    // non-default-lane caller's qref resolves against ITS OWN session, not
    // the shared default one) so route_decision, and every trace() line
    // after it, carries the fullest context this call ever resolves rather
    // than only the ones emitted after the fact.
    dispatchQueryRef = runWithSessionLane(
      sessionLaneOf(args),
      () => dispatchTaskRef(args, workspaceRoot),
    );
    if (dispatchQueryRef !== undefined) setTraceContext({ taskRef: dispatchQueryRef.ref });
    trace("route_decision", { tool: canonical, route: routeDecision.route, reason: routeDecision.reason }, workspaceRoot);
    // V10-02: forced_resend — a generic force_serve-style bypass arg, read
    // structurally off the raw request args so this has NO hard dependency
    // on the not-yet-landed PI-09 wire arg of the same name (D-8/deviation
    // register). The event simply never fires while the arg does not exist
    // in this tree, which is every call today.
    if (args["force_serve"] === true) {
      trace("forced_resend", { tool: canonical }, workspaceRoot);
    }
    if (dispatchQueryRef?.repeated === true) {
      trace("repeated_query", { task_ref: dispatchQueryRef.ref }, workspaceRoot);
    }
  } catch {
    // Attestation/route tracing is observability only and must never alter an MCP outcome.
  }
  const startedAt = performance.now();
  const baselineMeasurement = readBaselineMeasurement(canonical, args);
  const baselineTokens = baselineMeasurement.tokens;
  // R1: declared outside the try so BOTH failure exits — an `isError` result
  // and a thrown one — can withdraw the in-flight pre-record made below.
  let inFlight: { workspace: string; lane: string } | undefined;
  let inFlightWasKnown = true;
  try {
    // 2026-08-07 concurrent-agent lanes: both transports funnel through this
    // function, so binding the async context here scopes EVERY session lookup
    // of the call — dispatch, features, guards — to the caller's lane. The
    // refusal flows through the recorder below like any other result.
    const laneRefusal = sessionLaneRefusal(args);
    // PI-03: verified BEFORE dispatch so the binding covers the whole call —
    // the receipt projector that consults it runs deep inside the funnel.
    // `undefined` (the default, and every rejection) means the dispatch below
    // runs with no binding at all, which is today's behavior exactly.
    const verifiedContext = verifiedContextFor(args, requestMeta);
    // -----------------------------------------------------------------------
    // R1 (2026-08-28): THE IN-FLIGHT CALL IS CONSUMED WORK, AND ITS OWN
    // RESPONSE MUST SEE THAT.
    //
    // The executed-next ledger was written only AFTER `callToolUninstrumented`
    // returned, so the response BUILT BY a prescribed next could not observe
    // that the very call producing it had just consumed that next. Both
    // no-repeat gates (readCodeTaskPack's `suppressNonProgressingNextCall` and
    // the shared producer exit) therefore compared against a ledger exactly one
    // call stale and re-emitted the prescribed call byte-identically; only a
    // THIRD identical call finally saw it and advanced. Reproduced live on the
    // follower's f03 and Tier-3 enum-refunded shapes, where step 0 prescribes
    // `read_file mode=task_pack query=<verbatim> surfaceRoles=[…]` and step 1 —
    // that exact call — hands the same call back with the same open gaps.
    //
    // Recording at dispatch is the ledger's own rule applied at the honest
    // moment: a caller who has spent this call cannot be told to spend it
    // again, whatever the result turns out to be. `recordExecutedNext` returns
    // whether the shape was ALREADY known, so a call that ends in error
    // withdraws only a pre-record that it introduced (below), leaving a
    // genuinely earlier execution of the same shape intact. The success path
    // still records again with the result digest, which is what stamps
    // `resultDigest` — this only moves WHEN the fingerprint becomes visible.
    // -----------------------------------------------------------------------
    if (!laneRefusal && (canonical === "read_file" || canonical === "search_files")) {
      try {
        const workspace = resolveWorkspaceRoot(typeof args["cwd"] === "string" ? args["cwd"] : undefined, activeRoot);
        const lane = contractLaneOf(args);
        inFlightWasKnown = recordExecutedNext(workspace, lane, canonical, args);
        inFlight = { workspace, lane };
      } catch {
        // An unresolvable workspace is the dispatch's own problem to report;
        // the ledger simply learns nothing about this call.
      }
    }
    const result = laneRefusal
      // protocol v1: the lane refusal short-circuits BEFORE the dispatch funnel,
      // so it needs its own envelope. D1 admits no exceptions — a refusal a
      // client cannot version-identify is the class §1.2 exists to remove.
      ? runWithProtocolCall({ tool: canonical, kind: "refusal" }, () =>
          finalizeProtocolResponse(canonical, laneRefusal))
      : await runWithVerifiedContext(verifiedContext, () =>
          runWithSessionLane(sessionLaneOf(args), () => callToolUninstrumented(name, args)));
    // PI-03: the ISSUED handle rides result `_meta`, host-visible and never in
    // `content[*].text` — plan invariant 15's other half, the one that keeps a
    // context handle out of the model's reach in BOTH directions.
    if (verifiedContext?.contextHandle !== undefined) {
      (result as ToolCallResult)._meta = {
        ...(result as ToolCallResult)._meta,
        [CONTEXT_STATE_META_KEY]: {
          context_handle: verifiedContext.contextHandle,
          context_generation: verifiedContext.generation,
        },
      };
    }
    const outcomeIsError = "isError" in result && result.isError === true;
    // R1: withdraw an in-flight pre-record this call INTRODUCED when the call
    // failed — a failed call spent no work the ledger may hold a later next
    // against. A shape already present before the pre-record is left alone.
    if (outcomeIsError && inFlight !== undefined && !inFlightWasKnown) {
      forgetExecutedNext(inFlight.workspace, inFlight.lane, canonical, args);
    }
    if (!outcomeIsError && (canonical === "read_file" || canonical === "search_files")) {
      recordExecutedNext(
        resolveWorkspaceRoot(typeof args["cwd"] === "string" ? args["cwd"] : undefined, activeRoot),
        // A-F1: `?? "default"` never fired — sessionLaneOf returns "" (not
        // undefined) for a lane-less call, so every default-path write landed
        // in a partition no reader consults.
        contractLaneOf(args),
        canonical,
        args,
        shaOfText(JSON.stringify(result.content)),
      );
    }
    if (!outcomeIsError) commitReadBaseline(baselineMeasurement, args);
    try {
      if (
        canonical === "read_file"
        || canonical === "search_files"
        || canonical === "edit_file"
      ) {
        const envelopeMeta = observedEnvelopeMeta(result);
        recorder().record({
          tool: canonical,
          outcome: outcomeIsError ? "error" : "ok",
          durationMs: performance.now() - startedAt,
          responseBytes: modelVisibleBytes(result),
          baselineTokens,
          baselineMethod: baselineTokens === null ? null : "file-bytes",
          writeEnabled: ALLOW_WRITE,
          // V13: same task_ref on a query's first call and every qref
          // continuation of it — see the hoisted `dispatchQueryRef` doc above.
          taskRef: dispatchQueryRef?.ref ?? null,
          kind: envelopeMeta.kind,
          mode: observedCallMode(canonical, args),
          errorCode: outcomeIsError ? envelopeMeta.errorCode : undefined,
          retry: outcomeIsError ? envelopeMeta.retry : undefined,
          field: outcomeIsError ? envelopeMeta.field : undefined,
        });
      }
    } catch {
      // Usage measurement must never alter an MCP call outcome.
    }
    return result;
  } catch (error: unknown) {
    try {
      if (
        canonical === "read_file"
        || canonical === "search_files"
        || canonical === "edit_file"
      ) {
        recorder().record({
          tool: canonical,
          outcome: "error",
          durationMs: performance.now() - startedAt,
          responseBytes: 0,
          baselineTokens,
          baselineMethod: baselineTokens === null ? null : "file-bytes",
          writeEnabled: ALLOW_WRITE,
          // V13: the thrown-dispatch failure exit — same `dispatchQueryRef`
          // as the success-path record above, so a failed call still
          // correlates to its task_ref instead of falling out of every group.
          taskRef: dispatchQueryRef?.ref ?? null,
          mode: observedCallMode(canonical, args),
        });
      }
    } catch {
      // Preserve the original failure.
    }
    // R1: a thrown dispatch is the other failure exit — withdraw on the same
    // rule as the `isError` path above.
    if (inFlight !== undefined && !inFlightWasKnown) {
      try {
        forgetExecutedNext(inFlight.workspace, inFlight.lane, canonical, args);
      } catch {
        // Preserve the original failure.
      }
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 dispatcher (hand-rolled, used as fallback or always)
// ---------------------------------------------------------------------------

export type RpcRequest = {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: unknown;
};

export type RpcResponse = {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: JsonRpcError;
};

export function makeError(id: string | number | null, code: number, message: string): RpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

/**
 * issue #4: the `initialize` result's `instructions` string.
 * SERVER_INSTRUCTIONS always leads; when `degraded` is non-empty the existing
 * `Degraded: ...` line is preserved verbatim, appended on its own line. Split
 * out as a pure function so this shape is unit-testable directly — `degraded`
 * currently has no live producer in `handleRequest` below, so the append
 * branch has no reachable trigger through a real `initialize` call today.
 */
export function buildInitializeInstructions(degraded: readonly string[]): string {
  return degraded.length > 0
    ? `${SERVER_INSTRUCTIONS}\nDegraded: ${degraded.join(", ")}`
    : SERVER_INSTRUCTIONS;
}

export async function handleRequest(req: RpcRequest): Promise<RpcResponse | null> {
  const id = req.id ?? null;

  switch (req.method) {
    case "initialize": {
      const params = (req.params ?? {}) as Record<string, unknown>;
      const clientInfo = params["clientInfo"];
      if (clientInfo) {
        const ci = clientInfo as Record<string, unknown>;
        process.stderr.write(
          `[tl-mcp] client: ${ci["name"] ?? "?"} ${ci["version"] ?? ""}\n`,
        );
        // F-A7: capture once per connection — see capturedClientId's doc comment.
        if (typeof ci["name"] === "string" && ci["name"] !== "") capturedClientId = ci["name"];
      }
      const degraded: string[] = [];
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          // §1.2 announcement point 2: the AUTHORITATIVE point for a client
          // doing capability negotiation before its first call. Paid once per
          // connection, and it costs nothing against the advertised-schema
          // budget. `serverInfo` carries it too so the SDK transport below —
          // which builds its own `initialize` result and only passes
          // `serverInfo` through — announces the same version.
          _meta: { ...PROTOCOL_META },
          serverInfo: {
            name: "@tokenlighten/mcp-server",
            version: SERVER_PACKAGE_VERSION,
            _meta: {
              ...PROTOCOL_META,
              ...(SERVER_BUILD_ID !== undefined ? { server_build: SERVER_BUILD_ID } : {}),
            },
          },
          // W3 (2026-07-30, dist build-id echo): initialize is inherently
          // one-shot per connection, so no session-state gating is needed
          // here (contrast the per-workspace claimServerBuildAnnouncement
          // gate attachServerBuildOnce uses for the first task_pack response).
          ...(SERVER_BUILD_ID !== undefined ? { server_build: SERVER_BUILD_ID } : {}),
          // issue #4: `instructions` is now ALWAYS present (previously only
          // set when degraded) so a host that surfaces it in the system
          // prompt (e.g. Claude Code's "MCP Server Instructions") routes
          // discovery-shaped tasks to TL from turn 0.
          instructions: buildInitializeInstructions(degraded),
        },
      };
    }

    case "notifications/initialized":
      return null; // notification — no response

    case "tools/list": {
      return {
        jsonrpc: "2.0",
        id,
        result: { tools: advertisedTools() },
      };
    }

    case "tools/call": {
      const params = (req.params ?? {}) as Record<string, unknown>;
      const toolName = String(params["name"] ?? "");
      const toolArgs = (params["arguments"] ?? {}) as Record<string, unknown>;

      const toolDef = ALL_TOOLS.find((t) => t.name === toolName);
      // D11: the alias gate is gone with the aliases. Advertised-or-refused.
      if (!toolDef || !toolDef.enabled) {
        return makeError(id, -32601, `Tool not found: ${toolName}`);
      }

      try {
        // PI-03: the hand-rolled JSON-RPC leg parses `params` itself, so
        // `_meta` arrives verbatim. Same pass-through, same authentication
        // downstream — all three legs reach one verifier.
        const requestMeta = params["_meta"];
        const result = await callTool(
          toolName,
          toolArgs,
          typeof requestMeta === "object" && requestMeta !== null && !Array.isArray(requestMeta)
            ? (requestMeta as Record<string, unknown>)
            : undefined,
        );
        return { jsonrpc: "2.0", id, result };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return makeError(id, -32603, `Internal error: ${msg}`);
      }
    }

    case "resources/list":
      return { jsonrpc: "2.0", id, result: { resources: [] } };

    case "prompts/list":
      return { jsonrpc: "2.0", id, result: { prompts: [] } };

    default:
      if (req.method.startsWith("notifications/")) return null;
      return makeError(id, -32601, `Method not found: ${req.method}`);
  }
}

// ---------------------------------------------------------------------------
// Stdio transports
// ---------------------------------------------------------------------------
//
// v0.10 alpha.1 (DESIGN-v0.10-expansion-plan-reconciliation.md §4 alpha.1
// item 4 / PI-09 items 1-2): the transport tail moved to ./mcp/transport/ so
// the modern 2026-07-28 era can sit beside the legacy one behind
// TOKENLIGHTEN_PROTOCOL_ERA. `runStdioFallback` keeps its server.ts export
// site — it is an established test seam (__tests__/fallbackTransport.spec.ts).
export { runStdioFallback } from "./mcp/transport/fallbackStdio.js";

// ---------------------------------------------------------------------------
// Public entry
// ---------------------------------------------------------------------------

export async function run(): Promise<void> {
  // v0.10 PI-09 deferred cell: resolved and validated BEFORE any transport
  // is wired up, so a TOKENLIGHTEN_HTTP_PORT set alongside
  // TOKENLIGHTEN_PROTOCOL_ERA=legacy fails fast with a clear message rather
  // than leaving the stdio transport connected while this call unwinds. See
  // mcp/transport/index.ts's runHttpTransport and mcp/transport/modernHttp.ts's
  // module header for the full policy.
  await runHttpTransport();

  process.stderr.write(
    `[tl-mcp] starting v${SERVER_PACKAGE_VERSION} server, root: ${activeRoot}\n`,
  );

  if (ALLOW_WRITE) {
    process.stderr.write(`[tl-mcp] --allow-write enabled, writable workspace: ${activeRoot}\n`);
  }

  if (KILL_SWITCH) {
    process.stderr.write("[tl-mcp] TL_KILL_SWITCH=1: all tools disabled\n");
  }

  // P3a S4 / gate G9: a misconfigured budget table or reserve is a STARTUP
  // error (plan §7.4), never a wire outcome -- checked here, strictly before
  // the transport starts accepting requests. A throw propagates through this
  // function's promise to bin.ts's existing fatal catch ([tl-mcp] fatal:
  // <message>, exit 1), with zero bytes ever written to stdout.
  assertStartupBudgetsAreSane();

  // Era-selected stdio transport. Default (`legacy`, or an unset/unknown
  // TOKENLIGHTEN_PROTOCOL_ERA) is exactly the pre-v0.10 path: SDK first, then
  // the hand-rolled JSON-RPC fallback if the SDK is unavailable.
  await runTransport();
}
