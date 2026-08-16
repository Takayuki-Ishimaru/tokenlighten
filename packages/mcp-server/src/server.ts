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
import * as readline from "readline";
import { randomBytes } from "crypto";
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
import { resolveWorkspaceRoot as resolveWorkspaceRootBase, isWorkspaceOverrideAccepted } from "./write/resolveWorkspace.js";
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
import { buildTaskPack, canServeCachedTaskPackReceipt, concernAnchorTokens } from "./features/task-pack/readCodeTaskPack.js";
import { walkCodeFiles } from "./tools/walkRepo.js";
import { classifySurface, deriveTokenVariants } from "./util/impact.js";
import { handleTable, runWithDeclaredWorkspace, shaOfText, shaOfBytes, shortSha, type HandleEntry } from "./util/handles.js";
import { resolveMap, resolveDigest, resolveSlice, resolveSliceRanges, extractSymbolsFromFile, READ_SYMBOL_CAP_BYTES } from "./tools/readCodeModes.js";
// office/csv.ts is pure and dependency-free (unlike office/xlsx.ts, which is
// dynamic-imported to defer exceljs), so a static import here costs nothing at
// cold start and lets the csv artifact/auto helpers below call it directly.
import { csvTable, type CsvTableResult } from "./office/csv.js";
import { prepareOfficeDocument } from "./office/decrypt.js";
import { resolveCredentialRef } from "./security/credentials.js";
import { editArtifact } from "./write/artifactEdit.js";
import { adaptiveWholeFileEnabled, decisionInvariantStrictEnabled } from "./util/flags.js";
import { deriveCanonicalTaskDecision, enforceCanonicalTaskDecisionAtExit } from "./features/task-pack/canonicalDecision.js";
import type { TaskPackResult } from "./features/task-pack/model.js";
import { projectLeanExecutionContract } from "./util/leanExecutionContract.js";
import { recordReadMode, recordHandleEdit, recordPathSearchEdit, recordSingleEditCompletion, recordEditsBatchUsed, recordSingleFindCompletion, otherActiveRoots, recordConcernTokens, recordReadPath, getReadPaths, hasUnreadSiblingNoteFired, markUnreadSiblingNoteFired, recordEditedPath, getEditedPaths, getConcernTokens, guardExecutionDiscovery, noteDiscoveryServedNoBytes, guardExecutionEdit, recordExecutionContract, recordCandidateListPack, clearCandidateListPack, recordExecutionEditResult, recordCreatedEditAdmissibility, getExecutionFence, takePreparedHandleAdvisory, runWithSessionLane, isClosureSatisfied, recordClosureReport, markClosureSatisfied, clearClosureSatisfied, wasFullyServed, unservedVerificationPaths, markVerificationPathsServed, isVerificationSurfaceServed, markVerificationSurfaceServed, recordServedRange, servedRangeReceipt, beginServeCall, artifactRangeReceipt, recordArtifactServedRange, taskQueryRef, rememberTaskQuery, resolveTaskQueryRef, clearTaskQueryRef, claimServerBuildAnnouncement, registerServerBuildId, servedRangeCoverage, unservedLineCount, recordFullServeCompleteness, CREATE_BODY_PLACEHOLDER, EDIT_REPLACE_PLACEHOLDER, EDIT_SEARCH_PLACEHOLDER, READ_BACK_RANGE_PLACEHOLDER, type ServedRangeLedgerReceipt } from "./state/session.js";
import { buildVerificationManifest, verificationBodyIdentity, verificationDependencyNote, type BodyMarker } from "./util/verificationPack.js";
import { attachClosure, computeClosureStateSafe, CLOSURE_SATISFIED_NOTE } from "./util/closureTracking.js";
import { getFunctionalValidationObligation, clearFunctionalValidationObligation, recordExecutedLocate } from "./util/packServeLog.js";
import { attachSupply } from "./util/attachSupply.js";
import { mustFetchReadBudget } from "./util/mustFetch.js";
import { getAdaptiveAdvice } from "./util/adaptive.js";
import { trace, traceCausalAttestation } from "./util/trace.js";
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
import { MCP_LANGS, type McpLang, type RefusalCode, type TaskDecision, type TaskExecutionContract, type TaskProfileRequest } from "@tokenlighten/types";
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
  declareKind,
  finalizeProtocolResponse,
  noteResolvedAction,
  noteResolvedMode,
  noteWorkspaceRoot,
  runWithProtocolCall,
} from "./protocol/envelope.js";
import { setEmittedToolCallValidator } from "./protocol/refusal.js";
import {
  packUnchangedPriorLabel,
  projectEvidence,
  projectTaskDecision,
  projectTaskRef,
  sanctionFromEvidence,
} from "./protocol/decisionWire.js";
import { assertStartupBudgetsAreSane } from "./protocol/budget/wireBudget.js";

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

let activeRoot = workspaceRootArg(argv) ?? process.env["TOKENLIGHTEN_ROOT"] ?? process.cwd();

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
const SERVER_BUILD_ID = deriveServerBuildId(import.meta.url);
const SERVER_PACKAGE_VERSION = deriveServerPackageVersion(import.meta.url);
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
const CWD_PROP = {
  cwd: { type: "string" },
} as const;

/**
 * Accepted keys of the `archive` selector, shared by read_file and
 * search_files. tools/archive.ts's selectorFromArgs (`:232-243`) accepts
 * exactly these three; before C-6 this was a bare `{type:"object"}`, which
 * made the recursive validator (§1.3.1(1)) vacuous over every archive call.
 */
const ARCHIVE_PROP = {
  archive: {
    type: "object",
    properties: {
      path: { type: "string" },
      member: { type: "string" },
      prefix: { type: "string" },
    },
  },
} as const;

const TASK_STATE_PROPS = {
  taskEpoch: { type: "string" },
  // §1.3.1(3), C-6: the challenge shape is declared IN FULL, on every tool
  // that accepts it. This is not an ergonomic extra — §2.6 abolishes
  // placeholder-bearing `next_call` templates on the ground that "a challenge
  // is agent-authored, from the request schema", and that claim is only true
  // if the request schema says what a challenge IS. The previous comment here
  // delegated the shape elsewhere ("the execution_contract and refusal payload
  // describe the certificate challenge fields contextually"), and that
  // delegation is exactly the condition that made the placeholder template at
  // state/session.ts:1376 necessary. Dispatch parses exactly these three keys
  // (state/session.ts:2106-2131, parseChallenge).
  //
  // NOT dropped from search_files (WO C-6 acceptance 8): the fence DOES
  // sanction a challenge against a search call. guardExecutionDiscovery is
  // typed `tool: "read_file" | "search_files"` (state/session.ts:3154)
  // and calls applyChallenge unconditionally for both (`:3187`); the
  // search_files dispatch reaches it at server.ts's search arm. Dropping the
  // property would hide a capability dispatch honours — the 2026-08-01
  // surfaceRoles defect exactly. The 127 B lever (§1.3.1(3)(ii)) is therefore
  // NOT available and does not offset the schema growth.
  challenge: {
    type: "object",
    properties: {
      certificate_id: { type: "string" },
      obligation_id: { type: "string" },
      expected_action_change: { type: "string" },
    },
  },
  // 2026-08-07 concurrent-agent lanes: several agents multiplexed over one
  // server process + one workspace root share a WorkspaceSession and mix
  // fences/receipts with no way to tell actors apart; `lane` is the explicit
  // cooperative partition. Advertised on all three tools so schema-validating
  // clients never drop it (the B1e surfaceRoles lesson).
  lane: { type: "string", description: "isolation key: concurrent agents on one workspace each pass their own fixed value" },
} as const;

/**
 * D11: `deprecated` and `renamedAlias` are DELETED. Every entry in ALL_TOOLS is
 * now an ADVERTISED tool — the set that `tools/list` returns and the set that
 * `tools/call` accepts are the same set, so "accepted but not advertised" is
 * no longer a state this type can express.
 */
interface ToolEntry {
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
  next?: string;
  /**
   * C2: the query came from a `qref`, so this call is a replay over a working
   * set the caller still holds — not a freshly-typed request.
   */
  fromRef?: true;
}

function resolveTaskPackQueryArg(
  args: Record<string, unknown>,
  workspace: string,
): TaskPackQueryResolution {
  if (args["taskEpoch"] === "new") clearTaskQueryRef(workspace);
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
        ? `read_file mode=task_pack qref=${requestedRef} paths=${JSON.stringify(pathsArg)} (drop query — keeps the certified working set)`
        : 'read_file mode=task_pack query="<restate the request verbatim>" (drop qref)',
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
          next: 'read_file mode=task_pack query="<restate the request verbatim>" — a qref is session-scoped and expires; restating the query mints a fresh one',
        }
      : { query, fromRef: true };
  }
  return { query: "" };
}

const ALL_TOOLS: ToolEntry[] = [
  // -------------------------------------------------------------------------
  // 3 consolidated tools (read_file / edit_file / search_files)
  // -------------------------------------------------------------------------
  {
    name: "read_file",
    enabled: !KILL_SWITCH,
    definition: {
      name: "read_file",
      description: "Cheapest file reader (code/docs/config/Office): exact slices+edit handles. Start: mode=task_pack query=<request>",
      // anthropic/alwaysLoad: clients that defer MCP tool schemas (Claude Code
      // tool search) load these at turn 0 instead of mid-session, which would
      // invalidate the prompt cache. All 3 schemas total ~0.7K tokens.
      //
      // §1.2 announcement point 3: the discoverable fallback for clients that
      // only ever read `tools/list` and never look at `initialize`. It rides
      // `read_file` because that is the definition already carrying `_meta`.
      _meta: { "anthropic/alwaysLoad": true, ...PROTOCOL_META },
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          credentialRef: { type: "string" },
          mode: { type: "string", enum: ["auto", "skeleton", "symbol", "full", "pack", "map", "digest", "slice", "task_pack", "small_file", "artifact", "archive", "overview", "closure"] },
          ...ARCHIVE_PROP,
          symbol: { type: "string" },
          handle: { type: "string" },
          handles: { type: "array", items: { type: "string" } },
          paths: {
            type: "array",
            // Item shape depends on mode: pack/task_pack use {path,range?,
            // symbol?,purpose?} but also accept a bare string, coerced to
            // {path} by each mode's own dispatch branch; full (1+ entries)
            // and map (multi-file signature map, MULTI_FILE_MAP_CAP_BYTES
            // total budget) use plain path strings. `type` as an array (not
            // `oneOf`) is
            // the cheapest correct JSON Schema for "string OR object" —
            // dispatch does the real per-mode coercion regardless (schema is
            // advisory, per the C9 precedent).
            //
            // FIX (2026-07-10a dispatch-gap): mode omitted (or "auto") plus a
            // non-empty paths[] ALSO promotes to task_pack — same shape as
            // pack/task_pack above, WITH or WITHOUT a query. This is the
            // recovery a partial pack's own route.reason recommends
            // ("re-scope with paths=[...]"); it used to fall through to the
            // single-path modes below (which only read the singular `path`
            // field) and hard-error "path is required".
            //
            // C-6 (§1.3.1(2)): the OBJECT form now declares its keys, so the
            // recursive validator is no longer vacuous inside a paths[] entry.
            // `properties` under a union `type` applies only when the instance
            // IS an object, so a bare string element stays legal and `oneOf`
            // stays unused (the policy above). mapTaskPackPaths (this file,
            // the task_pack argument mapper) accepts exactly these four.
            items: {
              type: ["string", "object"],
              properties: {
                path: { type: "string" },
                range: { type: "string" },
                symbol: { type: "string" },
                purpose: { type: "string" },
              },
            },
          },
          query: { type: "string" },
          qref: { type: "string", description: "replay token from a prior task_pack; re-pack with qref instead of repeating query" },
          taskProfile: { type: "string" },
          lang: { type: "string" },
          maxTokens: { type: "number" },
          allowFull: { type: "boolean" },
          content: { type: "string", enum: ["full", "outline", "defer", "auto"] },
          comments: { type: "string", enum: ["elide", "keep"] },
          includeClosure: { type: "boolean", description: "false: skip task_pack promotion; return a plain code-slice pack for the query." },
          // B1e (2026-08-01 retrieval-scope): a missing-roles pack's own
          // recovery IS `read_file mode=task_pack … surfaceRoles=[…]` and the
          // handler has always accepted it — but read_file's schema did not
          // declare it, so schema-validating clients dropped the argument and
          // the sanctioned recovery was followed 0/9 times in run
          // 2026-07-31-semantic-signal5-2. Same "a capability the server
          // instructs must not be one the schema hides" reasoning as the qref
          // re-advertisement; wording matches search_files' own property.
          surfaceRoles: { type: "array", items: { type: "string" }, description: "Preferred surface roles for closure." },
          sheet: { type: "string" },
          range: { type: "string" },
          ranges: { type: "array", items: { type: "string" }, description: "mode=slice: several N-M windows of ONE file in one call (not with range)" },
          sections: { type: "array", items: { type: "string" } },
          slides: { type: "array", items: { type: "string" } },
          pages: { type: "array", items: { type: "string" } },
          // C-6 (§1.3.1(2)) advertise-or-delete: below this line are the
          // properties dispatch has always accepted while the schema hid them.
          // Under D2 a schema-validating client drops a hidden argument and
          // silently gets a different budget/projection than it asked for —
          // the 2026-08-01 surfaceRoles defect one property at a time. Values
          // stay dispatch-validated (§1.3.1(6)); only the NAMES are declared.
          //
          // maxBytes  — the byte twin of maxTokens above; both are read at the
          //             same three sites (office / full / slice). §1.3.1(2)
          //             names this one as the defect it must close.
          // limit     — task_pack surface cap, read beside taskProfile/
          //             surfaceRoles in the same buildTaskPack option bag.
          // profile   — mode=skeleton profile (class-map|symbol-map|doc-map|
          //             full-skeleton), pinned end-to-end by
          //             schemaAdvisory.spec.ts:335.
          // kind / as / columns / rows / maxRows / maxCells — the mode=artifact
          //             xlsx+csv projection bag, parsed in five consecutive
          //             lines of the artifact branch and echoed back in the
          //             response. The server itself hands callers `read_file
          //             mode=artifact path=… as=json` as an executable next,
          //             and `alternatives:[{mode:"artifact",kind:"xlsx",
          //             as:"json"}]`, so these are instructed capabilities.
          maxBytes: { type: "number" },
          limit: { type: "number" },
          profile: { type: "string" },
          kind: { type: "string" },
          as: { type: "string" },
          columns: { type: "array", items: { type: "string" } },
          rows: { type: "array", items: { type: "number" } },
          maxRows: { type: "number" },
          maxCells: { type: "number" },
          ...TASK_STATE_PROPS,
          ...CWD_PROP,
        },
      },
    },
  },
  {
    name: "edit_file",
    enabled: !KILL_SWITCH,
    definition: {
      name: "edit_file",
      description: "Edit via prior-read handle (from read_file), exact search/replace, create, rename; batch multi-file edits[] one call.",
      _meta: { "anthropic/alwaysLoad": true },
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          credentialRef: { type: "string" },
          outputCredentialRef: { type: "string" },
          // C-6 (§1.3.1(2)): declared keys, so the recursive validator is no
          // longer vacuous inside an artifact edit. write/artifactEdit.ts's
          // parseArtifact (`:88-207`) accepts exactly this shape, one branch
          // per `kind`. `form` deliberately keeps NO declared keys and that is
          // permanent, not C-6 debt: a PDF form is a MAP whose keys are the
          // document's own field names — caller DATA, not protocol — which is
          // §1.3.1(2)'s "re-typed so that it does not need to" escape.
          artifact: {
            type: "object",
            description: "Structured xlsx/docx/pptx/pdf/zip edit.",
            properties: {
              kind: { type: "string", enum: ["xlsx", "docx", "pptx", "pdf", "zip"] },
              cells: { type: "array", items: { type: "object", properties: { sheet: { type: "string" }, cell: { type: "string" }, value: {}, formula: { type: "string" } } } },
              replacements: { type: "array", items: { type: "object", properties: { search: { type: "string" }, replace: { type: "string" }, all: { type: "boolean" } } } },
              form: { type: "object" },
              flatten: { type: "boolean" },
              members: { type: "array", items: { type: "object", properties: { action: { type: "string", enum: ["add", "replace", "delete"] }, member: { type: "string" }, content: { type: "string" }, sourcePath: { type: "string" } } } },
            },
          },
          handle: { type: "string", description: "handle id; resolves path/symbol/range" },
          search: { type: "string" },
          replace: { type: "string" },
          content: { type: "string" },
          create: { type: "boolean" },
          from: { type: "string" },
          intent: { type: "string", description: "Handle intent: remove-duplicate-branch|append-union-member|append-enum-member|rename-symbol-references; not with edits[]." },
          symbol: { type: "string", description: "Symbol name used by an edit intent." },
          lang: { type: "string", description: "Language hint used by an edit intent or rename." },
          mode: { type: "string", enum: ["rename"], description: "Special edit mode; currently rename only." },
          to: { type: "string", description: "New symbol name for mode=rename." },
          review: { type: "boolean", description: "Attach bounded review metadata to a successful edit." },
          edits: {
            type: "array",
            items: {
              type: "object",
              properties: {
                path: { type: "string" },
                handle: { type: "string" },
                // `range` + `content` is the ANCHOR shape: replace those lines
                // of the handle's file BY NUMBER, without restating them in
                // `search` (a verbatim search duplicates bytes the server
                // already served — one measured run batched 90 edit items in
                // a single call). 2026-07-30: carries a terse description —
                // the same "a capability the guide instructs must not be one
                // the schema hides" reasoning that re-advertised read_file's
                // `qref` (see schemaSize.spec.ts's qref comment) applies
                // identically here, so the earlier bare/undocumented form
                // (rationalized purely by the byte budget in place at the
                // time) does not get to become a second precedent for it.
                // See schemaSize.spec.ts's byte-budget test for the ceiling
                // this description pair raised.
                range: { type: "string", description: "1-based N-M range; with content, replaces those lines (no search needed)" },
                search: { type: "string" },
                replace: { type: "string" },
                content: { type: "string", description: "replacement text for range (or the whole file with no range)" },
                precondition: {
                  type: "string",
                  enum: ["unique-match", "expected-hash", "scope-handle", "references-reviewed"],
                },
                expectedSha: { type: "string" },
              },
            },
          },
          precondition: {
            type: "string",
            enum: ["unique-match", "expected-hash", "scope-handle", "references-reviewed"],
          },
          allowPathFallback: { type: "boolean" },
          target: { type: "string" },
          // C-6 (§1.3.1(2)) advertise-or-delete. All four were C9-trimmed from
          // the advertised schema while dispatch kept accepting them; on the
          // WRITE tool a hidden argument is the most expensive kind, because
          // dropping it changes which span is overwritten.
          //
          // expectedSha     — the server EMITS `retry with expectedSha=<sha>`
          //                   (write/preconditions.ts:82,:95, blastRadius.ts:129,
          //                   applyEditsMulti.ts:452). A schema that hides an
          //                   argument the server instructs is the 2026-08-01
          //                   surfaceRoles defect verbatim.
          // scopeHandle     — the server EMITS `precondition=scope-handle
          //                   requires scopeHandle=<scope handle id>`
          //                   (write/preconditions.ts:116-117,:131). Both are
          //                   the value half of the advertised `precondition`
          //                   enum, so hiding them made two of its four values
          //                   unusable by a schema-validating client.
          // directoryHandle — create-into-directory capability with its own
          //                   end-to-end spec (editDirectoryHandle.spec.ts).
          // includeComments — the only knob of the advertised mode:"rename"
          //                   branch; hiding it left that mode half-described.
          //
          // `allow_create` is NOT here: it is DELETED (C-6 advertise-or-delete,
          // plus the removed reads in the edit_file dispatch arm). D11 deleted
          // the search_replace_edit alias that used to advertise it on a schema
          // of its own, so `create` is now the ONLY spelling anywhere.
          expectedSha: { type: "string" },
          scopeHandle: { type: "string" },
          directoryHandle: { type: "string" },
          includeComments: { type: "boolean" },
          ...TASK_STATE_PROPS,
          ...CWD_PROP,
        },
      },
    },
  },
  {
    name: "search_files",
    enabled: !KILL_SWITCH,
    definition: {
      name: "search_files",
      description: "find/symbols/references/diff/tree over code+docs; hits carry path+line+snippet, so a match rarely needs a read.",
      _meta: { "anthropic/alwaysLoad": true },
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["find", "symbols", "references", "diff", "locate", "tree"] },
          query: { type: "string" },
          queries: { type: "array", items: { type: "string" } },
          path: { type: "string" },
          credentialRef: { type: "string" },
          ...ARCHIVE_PROP,
          depth: { type: "number" },
          lang: { type: "string" },
          limit: { type: "number" },
          cursor: { type: "string", description: "Opaque references continuation token from a prior next_call; server-issued — do not construct." },
          includeClosure: { type: "boolean", description: "true: action=locate returns a task_pack closure response." },
          surfaceRoles: { type: "array", items: { type: "string" }, description: "Preferred surface roles for closure." },
          // C-6 (§1.3.1(2)) advertise-or-delete. Note that four of these six
          // ARE advertised on read_file — the hiding was per-tool, which is
          // why the audit had to attribute every dispatch read to its own
          // switch arm; a union over the three tools makes them invisible.
          //
          // regex         — the server EMITS "retry with regex:false and one
          //                 identifier token" (findText.ts:2429, :2480).
          // symbol        — action=references reads it as the PRIMARY argument
          //                 (`args["symbol"] ?? args["query"]`), and
          //                 action=locate forwards it into the closure pack.
          // includeScores — action=symbols; schemaAdvisory.spec.ts:433.
          // taskProfile   — action=locate + includeClosure returns a task_pack,
          //                 and the guide teaches taskProfile for packs.
          // maxTokens     — diff / locate / office-backed hit budget; already
          //                 advertised on read_file.
          // maxBytes      — office-backed hit byte budget; twin of maxTokens.
          regex: { type: "boolean" },
          symbol: { type: "string" },
          includeScores: { type: "boolean" },
          taskProfile: { type: "string" },
          maxTokens: { type: "number" },
          maxBytes: { type: "number" },
          ...TASK_STATE_PROPS,
          ...CWD_PROP,
        },
        required: ["action"],
      },
    },
  },
  // -------------------------------------------------------------------------
  // D11: the 12 hidden aliases that used to live here are DELETED — the 9
  // fully-legacy ones (get_file_skeleton, get_symbol_with_context,
  // extract_office_text, search_replace_edit, apply_edits_multi, create_file,
  // read_and_edit, search_symbols, get_current_diff) and the 3 renamed ones
  // (read_code, edit_code, explore). Under D2's strict request validation an
  // accepted-but-unadvertised NAME was the last hole of the same class the
  // hidden-property closure shut: a caller could reach a code path no schema
  // describes. All 12 now take the unknown-tool refusal like any stranger.
  // -------------------------------------------------------------------------
];


// ---------------------------------------------------------------------------
// 2026-08-01 measured incident (this repo's findReferences.ts, 788 → 57
// lines, recovered from .tokenlighten/checkpoints): a caller passed TOP-LEVEL
// {handle, range:"676-788", content} — but edit_file has no top-level `range`
// (range+content is an edits[] ITEM shape). The unknown key was silently
// dropped and the {handle, content} branch below replaced the handle's OWN
// 1-788 range: a whole-file overwrite the call never expressed. On the WRITE
// tool an unrecognized argument can silently change WHICH span is destroyed,
// so edit_file fails CLOSED on unknown arguments. 2026-08-13 (P1 / D2 /
// ORCHESTRATOR CONDITION ②) generalised that stance: the read-only tools no
// longer keep their tolerant parsing either, because D2 adjudicated requests
// as STRICT and a schema that is merely advisory cannot be frozen. C-6
// (advertise-or-delete, §1.3.1(2)) then closed the third state: the C9-trimmed
// params dispatch used to accept without advertising (expectedSha,
// scopeHandle, directoryHandle, includeComments) are now DECLARED above, and
// the one silent alias among them — allow_create — was DELETED from this
// tool's request surface. So the known-argument set is now exactly the
// advertised schema object itself (single source of truth, cannot drift), and
// EDIT_FILE_ADVISORY_ARGS is an empty residue kept only so the union below
// keeps its shape if a future advisory name ever has to be re-introduced.
// ---------------------------------------------------------------------------
const EDIT_FILE_ADVISORY_ARGS: readonly string[] = PENDING_C6_ADJUDICATION["edit_file"] ?? [];

/** Advertised `properties` of a tool, straight off the ALL_TOOLS source of truth. */
function advertisedPropertiesFor(tool: string): Record<string, SchemaNode> {
  const definition = ALL_TOOLS.find((entry) => entry.name === tool)!.definition;
  const inputSchema = definition["inputSchema"] as { properties: Record<string, SchemaNode> };
  return inputSchema.properties;
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
  return requestShapeRefusal(
    call.tool,
    advertisedPropertiesFor(call.tool),
    call.arguments as Record<string, unknown>,
  ) === null;
});

function editFileAdvertisedProperties(): Record<string, unknown> {
  return advertisedPropertiesFor("edit_file") as Record<string, unknown>;
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
  const violations = findUnknownProperties("edit_file", advertisedPropertiesFor("edit_file"), args);
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
  // §1.3.1(4)(5) + CONDITION ②. `keys` is weighed against the bytes THIS
  // payload actually emits, not the shared renderer's shorter body.
  const shape = unknownPropertyRefusal("edit_file", violations)!;
  const pathQualified = {
    field: shape.field,
    ...(shape.did_you_mean !== undefined ? { did_you_mean: shape.did_you_mean } : {}),
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
      "edit_file refuses arguments outside its advertised schema instead of dropping them — on a write tool a dropped argument can silently change which span is overwritten (a dropped top-level `range` once turned a 113-line replacement into a whole-file overwrite)",
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
      ? "read_file mode=slice path=" + path + " range=" + range + " comments=keep"
      : "read_file mode=full path=" + path + " comments=keep"
    : "read_file mode=task_pack query=\"re-read the affected source with comments kept\"";

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
 * Walk up from `requestedPath` (absolute or relative; need not exist) to the
 * nearest ancestor directory that DOES exist on disk — same ancestor-walk
 * shape as createFile.ts's path-escape check (`path.dirname` loop, `parent
 * === cur` as the filesystem-root termination guard), but with no workspace
 * containment bound: this is diagnosing an already-invalid cwd, not scoping a
 * workspace operation, so it may legitimately walk outside any workspace.
 * Returns undefined if nothing along the chain exists as a directory (e.g. an
 * empty string, or every ancestor down to "/" is missing — practically only
 * possible on a broken filesystem).
 */
function nearestExistingAncestorPath(requestedPath: string): string | undefined {
  if (!requestedPath) return undefined;
  let cur = path.resolve(requestedPath);
  while (true) {
    try {
      if (statSync(cur).isDirectory()) return cur;
    } catch {
      // Does not exist (or not statable) — keep walking up.
    }
    const parent = path.dirname(cur);
    if (parent === cur) return undefined; // hit filesystem root, nothing existed
    cur = parent;
  }
}

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
  // won't match — it falls through to the refusal below).
  if (resolveReal(requested) === resolveReal(fallbackRoot)) return null;
  const allowedParents = configuredAllowedParents(fallbackRoot);
  if (isWorkspaceOverrideAccepted(requested, allowedParents, fallbackRoot)) {
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
  const nearestExisting = nearestExistingAncestorPath(requested);
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
 * checkCwdWithCorrection below: nearestExistingAncestorPath walking a
 * bogus/sibling cwd (e.g. `<pinnedRoot>/../typo'd-name`, a real fixture
 * shape — pinnedRoot's own parent is $HOME) legitimately lands on $HOME
 * itself, which PASSES isWorkspaceOverrideAccepted's containment check
 * ($HOME is "within" itself) — but silently adopting the caller's ENTIRE
 * home directory as a read/search workspace is not what "one unambiguous
 * root suggestion" is meant to license: confirmed live, search_files
 * action=find over a real $HOME can scan gigabytes and hang the call. A
 * `.claire`->`.claude` correction never hits this (it substitutes one
 * segment; it never walks upward), so only the nearest_existing fallback
 * needs this check.
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
  // well-formed but not-quite-real ABSOLUTE path. nearestExistingAncestorPath
  // resolves a RELATIVE requested string against path.resolve (i.e. this
  // SERVER PROCESS's own launch cwd, not anything reflecting caller intent)
  // before walking up — for ANY nonexistent relative path that walk always
  // eventually reaches the server's own cwd, which routinely exists and
  // routinely passes validation, so without this gate a merely-relative cwd
  // (a real caller mistake `checkCwdOrRefuse` is right to reject) would
  // silently "correct" to a directory that has nothing to do with the call.
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

/** Server root + live nested workspaces + other active roots, deduplicated. */
function workspaceCandidates(
  workspace: string,
  nested: readonly string[],
): Array<{ cwd: string; source: string }> {
  return [
    { cwd: workspace, source: "server-default" },
    ...nested.map((cwd) => ({ cwd, source: "nested-worktree" })),
    ...otherActiveRoots(workspace).map((cwd) => ({ cwd, source: "active-session" })),
  ].filter((candidate, index, all) =>
    all.findIndex((other) => other.cwd === candidate.cwd) === index);
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
}): Record<string, unknown> {
  const { mode, path: filePath, handle, sha, range, symbol, ledger, extra } = args;
  // F3: a receipt that cannot be checked is indistinguishable from a false
  // one — name the call that put these bytes on the wire (~30 B).
  const servedBy = args.servedBy ?? ledger.served_by;
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
      summary: (() => {
        const coverage = servedRangeCoverage(workspace, filePath, sha, countLines(content));
        if (coverage === undefined) {
          return { served: [`1-${countLines(content)}`], complete: true };
        }
        return {
          served: coverage.served.map(([start, end]) => `${start}-${end}`),
          ...(coverage.unserved.length > 0 ? { unserved: coverage.unserved } : {}),
          complete: coverage.complete,
        };
      })(),
      note: SERVED_CONTENT_RECEIPT_NOTE,
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
  // Deliberately NOT applied to "candidate-pack-full-repeat": T05c rep0's
  // recovery depended on that path still serving content, and the candidate-flow
  // work (B1c) landed this same wave. Every other reason keeps the W1 head.
  if (reason === "per-task-cap-reached") {
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
      ...(largestUnserved !== undefined
        ? { next: `read_file mode=slice handle=${handleId} ranges=${JSON.stringify([largestUnserved])}` }
        : {}),
      note: "per-task whole-file budget spent on other files; zoom this handle by range"
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
          next: `read_file mode=artifact path=${filePath}${ext === "xlsx" ? " as=json" : ""}${
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
  // the per-path cap (fullGovernor.ts). Each paths[] item hits this SAME
  // governor call as a single-path call would — no cap is weakened or
  // bypassed by batching.
  const govDecision = decideFullRead({
    workspace,
    path: filePath,
    byteSize: fullBytes,
    lineCount: fullLineCount,
    sha: fullSha,
    allowFull: allowFullRequested,
    fileHandle: govHEntry.id,
  });
  if (govDecision.decision !== "allow") {
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
function taskPackQueryErrorPayload(resolution: { error?: string; next?: string }): Record<string, unknown> {
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
    detail: message,
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
async function buildUnreadSiblingNote(workspace: string, editedPaths: readonly string[]): Promise<string | undefined> {
  const anchor = editedPaths[0];
  if (anchor === undefined) return undefined;
  const concernTokens = getConcernTokens(workspace);
  if (concernTokens.length === 0) return undefined;

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
  for (const surface of surfaces) {
    if (
      surface &&
      typeof surface.path === "string" &&
      surface.code !== undefined
    ) {
      recordReadPath(workspace, surface.path);
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
  });

  // A.2.3: identity and replay token are two things, so two fields. `id` falls
  // back to the same `task-<sha16(profile\0query)>` derivation the certificate
  // uses (readCodeTaskPack.ts's `deterministicCertificate`), so a pack with no
  // certificate still reports the identity a later certified re-pack will
  // report — which is what makes "survives re-packs of the same task" true.
  const profile = result["task_profile"] === "answer"
    || (result["profile_binding"] as { selected?: unknown } | undefined)?.selected === "answer"
    ? "answer"
    : "generic";
  const task = projectTaskRef(
    result,
    effectiveContract,
    `task-${shaOfText(`${profile}\u0000${query}`).replace(/^sha256:/, "").slice(0, 16)}`,
  );

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
  result["task"] = projectTaskRef(
    result,
    contract,
    `task-${shaOfText(`${profile}\u0000${query}`).replace(/^sha256:/, "").slice(0, 16)}`,
  );
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
  const edited = getEditedPaths(workspace);
  if (edited.length === 0) return undefined;
  if (unservedVerificationPaths(workspace, edited).length === 0) return undefined;
  // K2 threading (2026-08-01 verify-kit-diet): when the edit args are in hand,
  // mine the search/replace hunk text for the PRECISE identifiers this edit
  // touched — sharper than the manifest's edited-file-content proxy — so the
  // relevance gate drops zero-overlap kit surfaces (the measured T09
  // createApp.ts fetch) without guessing from whole-file tokens.
  const changedIdentifiers = editArgs !== undefined ? identifiersFromEditArgs(editArgs) : [];
  const manifest = buildVerificationManifest(workspace, edited, {
    // K3a: the edit-attachment path is where consecutive identical kits were
    // measured riding back-to-back responses — dedupe applies HERE only.
    dedupeConsecutive: true,
    ...(changedIdentifiers.length > 0 ? { changedIdentifiers } : {}),
  });
  // Mark the CURRENT set covered either way — a later edit adding a new file
  // re-qualifies via the unserved check above.
  markVerificationPathsServed(workspace, edited);
  if (manifest === undefined) return undefined;
  // Pass 1 — session-once inlining, path-keyed in the shared served-surface
  // ledger (all three namespaces are workspace-relative file paths, and a body
  // served under any role is served). A body dropped here loses only `code`;
  // labelKitBodies below states WHY it is body-less, from that same ledger
  // AFTER every family has been walked — which is exactly why the labelling
  // cannot run per-family: one path can ride both as a role-mock surface
  // (body-less by design) and as a mock header served in this same response.
  const surfaces = manifest.surfaces.map((s) => dropServedBody(workspace, s));
  const linkSet = manifest.link_set.map((entry) => dropServedBody(workspace, entry));
  const harness = manifest.harness === undefined
    ? undefined
    : {
      ...manifest.harness,
      ...(manifest.harness.mock_headers !== undefined
        ? { mock_headers: manifest.harness.mock_headers.map((entry) => dropServedBody(workspace, entry)) }
        : {}),
    };
  return labelKitBodies(workspace, {
    ...manifest,
    surfaces,
    link_set: linkSet,
    ...(harness !== undefined ? { harness } : {}),
  });
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

function attachVerification(result: Record<string, unknown>, workspace: string, editArgs?: Record<string, unknown>): Record<string, unknown> {
  try {
    if ((result as { ok?: boolean }).ok === false) return result;
    const manifest = buildVerificationBody(workspace, editArgs);
    if (manifest === undefined) return result;
    return attachVerificationAdvisory(result, manifest);
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
 */
function identifiersFromEditArgs(args: Record<string, unknown>): string[] {
  const out = new Set<string>();
  for (const hunks of editHunksByPath(args).values()) {
    for (const hunk of hunks) {
      for (const text of [hunk.search, hunk.replace]) {
        if (typeof text !== "string") continue;
        for (const m of text.matchAll(/[A-Za-z_$][A-Za-z0-9_$]{2,}/g)) out.add(m[0]);
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
      ? [{ path: (result as { path: string }).path, lines: (result as { lines?: unknown }).lines }]
      : [];
    const files = Array.isArray((result as { files?: unknown }).files)
      ? ((result as { files: Array<{ path?: unknown; lines?: unknown }> }).files)
      : single;
    if (files.length === 0) return result;
    const hunks = editHunksByPath(args);
    const distinctPaths = new Set(files.map((f) => f.path));
    const applied: Array<Record<string, unknown>> = [];
    let total = 0;
    const contentCache = new Map<string, string[] | null>();
    for (const f of files.slice(0, APPLIED_MAX_ENTRIES)) {
      if (typeof f.path !== "string" || typeof f.lines !== "string") continue;
      const m = f.lines.match(/^(\d+)(?:-(\d+))?$/);
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
      let from = Math.max(1, start - APPLIED_CONTEXT_LINES);
      let to = Math.min(lines.length, end + APPLIED_CONTEXT_LINES);
      if (to < from) continue;
      // Enclosing-symbol upgrade (2026-07-26 run-A T13 relapse): a hunk inside
      // a function larger than the ±8 window forced a native sed of the whole
      // function body. Serve the smallest enclosing symbol instead when it
      // fits the entry cap; when it does not, NAME it with its range so one
      // handle re-slice replaces the native read.
      let enclosing: { symbol: string; range: string } | undefined;
      try {
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
      applied_note: "post-edit disk state (whole enclosing symbol when it fits, else ±8 lines) — no follow-up read needed; brace_delta 0 = hunk preserves brace balance; enclosing_symbol names the full construct when larger — one handle re-slice serves it",
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
async function dispatchTool(canonical: string, args: Record<string, unknown>): Promise<ToolCallResult> {
  switch (canonical) {
    case "read_file": {
      // P1 / D2 / ORCHESTRATOR CONDITION ② (§1.3.1(1)): strict recursive NAME
      // validation, before any cwd/handle/credential resolution or
      // session-state mutation — the same position edit_file's own guard has
      // held since 2026-08-01. Value validation is untouched (§1.3.1(6)):
      // `lang` is still a bare string checked by parseMcpLang below.
      const unknownArgsRefusalRead = requestShapeRefusal("read_file", advertisedPropertiesFor("read_file"), args);
      if (unknownArgsRefusalRead !== null) return toolStructuredError(unknownArgsRefusalRead);
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
      const forceContentServe = args["content"] === "full" || args["allowFull"] === true;

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
      const rangesArg = Array.isArray(args["ranges"])
        ? (args["ranges"] as unknown[]).map((entry) => String(entry).trim()).filter((entry) => entry.length > 0)
        : undefined;
      const hasRangesBatch = rangesArg !== undefined && rangesArg.length > 0;
      if (hasRangesBatch && callerSuppliedRange) {
        return toolStructuredError({
          ok: false,
          error: "range and ranges[] are mutually exclusive — pass one window in `range`, or several in `ranges`",
          code: "invalid-input",
          next: `read_file mode=slice ranges=${JSON.stringify([resolvedRange, ...rangesArg])}`,
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
            hint: "handles are session-scoped and do not survive a server restart; re-reading by path re-mints one",
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
      const exactPreparedTaskPackReceipt = mode === "task_pack"
        && canServeCachedTaskPackReceipt(workspace, args as Parameters<typeof canServeCachedTaskPackReceipt>[1]);
      /** This call resolved to nothing, so it put no file bytes on the wire. */
      const noteZeroByteServe = (): void =>
        noteDiscoveryServedNoBytes(discoveryGuardWorkspace, "read_file", discoveryGuardArgs);
      const executionGuard = guardExecutionDiscovery(
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
        return "servedReceipt" in executionGuard
          ? toolOk(addressServedReceipt(executionGuard.servedReceipt, workspace))
          : toolStructuredError(executionGuard.refusal);
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
        // A.5.4: a multi-target serve reporting per-item completeness is
        // `read.batch` whatever `mode` says — this branch runs BEFORE any mode
        // branch, so the member is a function of `handles[]`, not of `mode`.
        declareKind("read.batch");
        const requested = (args["handles"] as unknown[]).map(String);

        // B1 batch pre-pass: all handles in one handles=[] call must share ONE
        // workspaceRoot. When cwd was omitted, adopt that single root (the
        // handles ARE the workspace pin); when the batch spans more than one
        // root, refuse the whole batch up front. Unknown handles are left for
        // the per-item loop below (same omitted[] shape as today). When cwd
        // was explicit, defer to the per-item mismatch check below (unchanged
        // shape — still omitted[] with reason handle-workspace-mismatch).
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

        recordReadMode(workspace, "handles");
        const items: Array<{ handle: string; path: string; range: string; content: string; truncated: boolean; sha: string; note?: string; concern_note?: string; downgraded_from?: "symbol"; remaining_ranges?: string[]; next?: string }> = [];
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

        for (const hId of requested) {
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
          const hRange = hEntry.range
            ?? (hEntry.symbol === undefined ? `1-${Math.max(1, countLines(hContent))}` : undefined);
          const sliceResult = await resolveSlice(workspace, hPath, hContent, hEntry.symbol, hRange);
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
          });
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
        const queryResolution = resolveTaskPackQueryArg(args, workspace);
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
        ? resolveTaskPackQueryArg(args, workspace)
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
          const result = await buildTaskPack(
            {
              ...taskCredential,
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
            },
            workspace,
          );
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
          recordTaskPackExecution(workspace, queryArg, supplied);
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
        const result = await buildTaskPack(
          {
            ...taskCredential,
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
          },
          workspace,
        );
        // Feature 1 (2026-07-12b2): task_pack surfaces with embedded code count as read.
        recordTaskPackSurfaceReads(workspace, result);
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
        if (requestedMarkdownSections.length > 3) {
          return toolError("Markdown sections accepts at most 3 headings per call", { code: "invalid-input" });
        }
        const markdown = await readFileSafe(resolvedPath, workspace);
        if (markdown === null) return toolError(`File not found or outside workspace: ${resolvedPath}`, { code: "not-found" });
        const headings = parseMarkdownHeadings(markdown);
        const sectionQueries = markdownSymbolSection !== undefined
          ? [markdownSymbolSection]
          : requestedMarkdownSections;
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
        const continuation = omitted.length > 0 && firstCandidate
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
          completeness: omitted.length === 0 ? "complete" : "partial",
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
        if (!slicePath) return toolError("path (or handle) is required for mode=slice", { code: "invalid-input" });
        const content = await readFileSafe(slicePath, workspace);
        if (content === null) return toolError(`File not found or outside workspace: ${slicePath}`, { code: "not-found" });

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
          if (
            batchData.segments.length > 0
            && alreadyHeld.size === batchData.segments.length
            && batchLedger !== undefined
            && batchData.remaining_ranges === undefined
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
          const batchNext = batchRemaining !== undefined && batchRemaining.length > 0
            ? `read_file mode=slice handle=${batchData.handle} ranges=${JSON.stringify(batchRemaining)}`
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
          if (rangeLedger !== undefined && addedLines === 0 && !forceContentServe) {
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
              query: String(args["query"]),
              ...(parseTaskProfile(args["taskProfile"]) ? { taskProfile: parseTaskProfile(args["taskProfile"]) } : {}),
              ...(resolvedPath ? { path: resolvedPath } : {}),
              ...(resolvedSymbol ? { symbol: resolvedSymbol } : {}),
              ...(promoteLang ? { lang: promoteLang } : {}),
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
          const sfResult = await buildSmallFile(workspace, sfPath, String(args["cwd"] ?? ""), { content: smallFileContent.value, keepComments });
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
        };

        const items: Record<string, unknown>[] = [];
        const omitted: Array<{ path: string; reason: string }> = [];
        for (const p of requestedPaths) {
          if (!p) {
            omitted.push({ path: p, reason: "path is required" });
            continue;
          }
          const fr = await resolveFullReadForPath(workspace, p, allowFullRequested, keepComments, officeOpts);
          if (fr.ok) {
            // Each item carries the same fields a single-path mode=full
            // response would (content + fullFileExpansion:true on success, or
            // a downgraded skeleton/artifact-redirect shape carrying its own
            // path/reason/handle) — request order preserved.
            items.push({ path: p, ...fr.data });
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
      if (!filePath) return toolError("path is required", { code: "invalid-input" });
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
        if (
          !forceContentServe
          && !wasFullyServed(workspace, filePath, fullSha)
        ) {
          const fullTotalLines = countLines(content);
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
            }), workspace));
          }
        }
        const fr = await resolveFullReadForPath(workspace, filePath, args["allowFull"] === true, keepComments);
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
            const sfRes = await buildSmallFile(workspace, filePath, String(args["cwd"] ?? ""), { content: smallFileContent.value, keepComments });
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
      if (unknownArgsRefusalEdit !== null) return toolStructuredError(unknownArgsRefusalEdit);
      // B5.1: fail loud on an invalid/nonexistent cwd instead of silently
      // resolving against the pinned root (see checkCwdOrRefuse doc comment).
      // Stage 1 of the guard stack (write/guardedWorkspace.ts): its pass token
      // is what stage 2 below requires, and stage 2's token is what mints the
      // `GuardedWorkspaceRoot` every write entry point demands.
      const cwdGuardEdit = guardCwd(args, activeRoot);
      if (!cwdGuardEdit.ok) return toolStructuredError(cwdGuardEdit.refusal);
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
        const cwdCandidates = [
          { cwd: activeRoot, source: "server-default" },
          ...otherActiveRoots(activeRoot).map((cwd) => ({ cwd, source: "active-session" })),
          ...createCapabilityEntries.map(({ id, entry }) => ({
            cwd: entry.workspaceRoot,
            source: "handle",
            handle: id,
          })),
        ].filter((candidate, index, all) =>
          all.findIndex((other) => other.cwd === candidate.cwd) === index);
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
              unreadNote = await buildUnreadSiblingNote(workspace, editedNow);
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
        }> = [];
        for (const [index, e] of (edits as unknown[]).entries()) {
          const entry = e as Record<string, unknown>;
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
              note: "a compiler/test error citing this file's line N is answered here — fill the range",
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
      const unknownArgsRefusalSearch = requestShapeRefusal("search_files", advertisedPropertiesFor("search_files"), args);
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
      const executionGuard = guardExecutionDiscovery(workspace, "search_files", args);
      if (!executionGuard.allowed) {
        return "servedReceipt" in executionGuard
          ? toolOk(addressServedReceipt(executionGuard.servedReceipt, workspace))
          : toolStructuredError(executionGuard.refusal);
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
            const head = (rawQueries as unknown[]).slice(0, 5).map(String);
            return toolError(`queries accepts at most 5 entries, got ${rawQueries.length}`, {
              code: "invalid-input",
              next: `search_files action=find queries=${JSON.stringify(head)}`,
              hint: `queries is OR-matched and capped at 5 per call — run the suggested call, then a second find for the remaining ${rawQueries.length - 5} token(s)`,
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
          recordConcernTokens(workspace, queries);
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
        recordConcernTokens(workspace, concernAnchorTokens(queryStr));

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
      if (action === "locate") {
        // includeClosure=true routes to buildTaskPack for closure-pack shape.
        if (args["includeClosure"] === true) {
          recordReadMode(workspace, "task_pack");
          const result = await buildTaskPack(
            {
              ...searchTaskCredential,
              query: args["query"] ? String(args["query"]) : undefined,
              ...(parseTaskProfile(args["taskProfile"]) ? { taskProfile: parseTaskProfile(args["taskProfile"]) } : {}),
              ...(args["symbol"] !== undefined ? { symbol: String(args["symbol"]) } : {}),
              ...(args["path"] !== undefined ? { path: String(args["path"]) } : {}),
              ...(lang ? { lang } : {}),
              ...(typeof args["limit"] === "number" ? { limit: args["limit"] } : {}),
              ...(Array.isArray(args["surfaceRoles"]) ? { surfaceRoles: (args["surfaceRoles"] as unknown[]).map(String) } : {}),
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
  return runWithProtocolCall({ tool: canonical, args }, async () =>
    finalizeProtocolResponse(canonical, await dispatchWithWorkspaceNotes(canonical, args)),
  );
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
  const result = await runWithDeclaredWorkspace(
    declaredWorkspaceForCall(args),
    () => dispatchTool(canonical, args),
  );

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
  });
  return usageRecorder;
}

function readBaselineTokens(
  canonical: string,
  args: Readonly<Record<string, unknown>>,
): number | null {
  if (canonical !== "read_file") return null;
  let workspace: string;
  try {
    workspace = resolveWorkspaceRoot(
      typeof args["cwd"] === "string" ? args["cwd"] : undefined,
      activeRoot,
    );
  } catch {
    return null;
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
  let bytes = 0;
  let measured = 0;
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
      if (stat.isFile()) {
        bytes += stat.size;
        measured++;
      }
    } catch {
      // Missing and virtual/archive paths simply have no measurable baseline.
    }
  }
  return measured > 0 ? estimateTokensFromBytes(bytes) : null;
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

/** Bytes of the payload an MCP client hands to the model: content[*].text only. */
export function modelVisibleBytes(result: { content: Array<{ text: string }> }): number {
  let bytes = 0;
  for (const item of result.content) bytes += Buffer.byteLength(item.text, "utf8");
  return bytes;
}

/**
 * Public tool boundary. Usage recording is best-effort and deliberately sees
 * only derived counts; raw arguments and result content are never handed to
 * the recorder.
 */
export async function callTool(name: string, args: Record<string, unknown>) {
  const canonical = name;
  try {
    const cwd = typeof args["cwd"] === "string" ? args["cwd"] : undefined;
    traceCausalAttestation(resolveWorkspaceRoot(cwd, activeRoot));
  } catch {
    // Attestation is observability only and must never alter an MCP outcome.
  }
  const startedAt = performance.now();
  const baselineTokens = readBaselineTokens(canonical, args);
  try {
    // 2026-08-07 concurrent-agent lanes: both transports funnel through this
    // function, so binding the async context here scopes EVERY session lookup
    // of the call — dispatch, features, guards — to the caller's lane. The
    // refusal flows through the recorder below like any other result.
    const laneRefusal = sessionLaneRefusal(args);
    const result = laneRefusal
      // protocol v1: the lane refusal short-circuits BEFORE the dispatch funnel,
      // so it needs its own envelope. D1 admits no exceptions — a refusal a
      // client cannot version-identify is the class §1.2 exists to remove.
      ? runWithProtocolCall({ tool: canonical, kind: "refusal" }, () =>
          finalizeProtocolResponse(canonical, laneRefusal))
      : await runWithSessionLane(sessionLaneOf(args), () => callToolUninstrumented(name, args));
    try {
      if (
        canonical === "read_file"
        || canonical === "search_files"
        || canonical === "edit_file"
      ) {
        recorder().record({
          tool: canonical,
          outcome:
            "isError" in result && result.isError === true ? "error" : "ok",
          durationMs: performance.now() - startedAt,
          responseBytes: modelVisibleBytes(result),
          baselineTokens,
          baselineMethod: baselineTokens === null ? null : "file-bytes",
          writeEnabled: ALLOW_WRITE,
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
        });
      }
    } catch {
      // Preserve the original failure.
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

function makeError(id: string | number | null, code: number, message: string): RpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

async function handleRequest(req: RpcRequest): Promise<RpcResponse | null> {
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
            _meta: { ...PROTOCOL_META },
          },
          // W3 (2026-07-30, dist build-id echo): initialize is inherently
          // one-shot per connection, so no session-state gating is needed
          // here (contrast the per-workspace claimServerBuildAnnouncement
          // gate attachServerBuildOnce uses for the first task_pack response).
          ...(SERVER_BUILD_ID !== undefined ? { server_build: SERVER_BUILD_ID } : {}),
          ...(degraded.length > 0
            ? { instructions: `Degraded: ${degraded.join(", ")}` }
            : {}),
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
        const result = await callTool(toolName, toolArgs);
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
// SDK-first stdio transport
// ---------------------------------------------------------------------------

async function tryRunWithSdk(): Promise<boolean> {
  try {
    const { Server } = await import("@modelcontextprotocol/sdk/server/index.js");
    const { StdioServerTransport } = await import(
      "@modelcontextprotocol/sdk/server/stdio.js"
    );

    const server = new Server(
      // §1.2 point 2 on the SDK path: the SDK builds `initialize` itself and
      // echoes `serverInfo` verbatim, so the announcement rides there.
      // The SDK's `Implementation` type predates `_meta` on serverInfo; the
      // schema itself passes unknown keys through, so the cast is the narrow
      // way to reach the wire without widening the SDK's own contract.
      { name: "@tokenlighten/mcp-server", version: SERVER_PACKAGE_VERSION, _meta: { ...PROTOCOL_META } } as unknown as { name: string; version: string },
      { capabilities: { tools: {} } },
    );

    // Register tools/list handler.
    server.setRequestHandler(
      { method: "tools/list" } as Parameters<typeof server.setRequestHandler>[0],
      async () => ({ tools: advertisedTools() }),
    );

    // Register tools/call handler.
    server.setRequestHandler(
      { method: "tools/call" } as Parameters<typeof server.setRequestHandler>[0],
      async (req: unknown) => {
        const r = req as { params: { name: string; arguments?: Record<string, unknown> } };
        const toolName = r.params.name;
        const toolArgs = r.params.arguments ?? {};
        const toolDef = ALL_TOOLS.find((t) => t.name === toolName);
        // D11: same advertised-or-refused gate as the non-SDK transport.
        if (!toolDef || !toolDef.enabled) {
          throw new Error(`Tool not found: ${toolName}`);
        }
        return callTool(toolName, toolArgs);
      },
    );

    const transport = new StdioServerTransport();
    await server.connect(transport);
    process.stderr.write(`[tl-mcp] stdio transport (MCP SDK)\n`);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Hand-rolled stdio fallback
// ---------------------------------------------------------------------------

// SECURITY (TL-SECURITY-REVIEW-2026-08-15 finding 7, CWE-400): this legacy
// path only runs when the SDK transport (tryRunWithSdk, above) is
// unavailable — it used to buffer+JSON.parse any readline "line" of any
// size and fire every handleRequest() concurrently with zero backpressure.
// 16 MB matches this server's existing 16 MB-class per-unit ceiling family
// (office/zipPreflight.ts ZIP_LIMITS.maxPartUncompressedBytes, tools/archive
// .ts ARCHIVE_LIMITS.maxMemberBytes/maxScanBytes) — comfortably above any
// legitimate single JSON-RPC request this server accepts (a create:true
// file body alone is capped at 32 KiB per AGENTS.md; a large batched
// edits[] call stays orders of magnitude under this), while still being a
// hard, known ceiling rather than "whatever fits in memory".
const MAX_FALLBACK_LINE_BYTES = 16 * 1024 * 1024;

/**
 * `input`/`output`/`handler` are TEST-ONLY injection points (mirrors this
 * codebase's established quota-override-seam convention — see office/pdf.ts's
 * PdfExtractionQuotaOverrides) so a regression test can drive this transport
 * with in-memory streams and a controllable-latency handler instead of real
 * stdio and the full tool dispatch. Production always calls this with zero
 * arguments (see run(), below), so the defaults are the only path that ever
 * executes outside tests.
 */
export function runStdioFallback(
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
  handler: (req: RpcRequest) => Promise<RpcResponse | null> = handleRequest,
  maxLineBytes: number = MAX_FALLBACK_LINE_BYTES,
): void {
  process.stderr.write(`[tl-mcp] stdio transport (hand-rolled JSON-RPC 2.0)\n`);
  process.stderr.write(`[tl-mcp] workspace root: ${activeRoot}\n`);

  const rl = readline.createInterface({ input });
  // In-flight requests are fully serialized (a queued line always gets its
  // turn, in order) rather than firing unboundedly — this fallback is a
  // degraded/legacy path, not the primary SDK transport, so trading away
  // concurrency for a hard resource bound is the right tradeoff here.
  let queueTail: Promise<void> = Promise.resolve();
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    if (Buffer.byteLength(trimmed, "utf8") > maxLineBytes) {
      // Ignored + warned, matching the (pre-existing, just below) convention
      // for a line this transport cannot otherwise process: invalid JSON is
      // also silently dropped rather than answered, since a request id
      // cannot be trusted from an input we refuse to parse.
      process.stderr.write(
        `[tl-mcp] fallback transport: dropped oversized request line (> ${maxLineBytes} bytes)\n`,
      );
      return;
    }
    let msg: unknown;
    try { msg = JSON.parse(trimmed); } catch { return; }
    if (!msg || typeof msg !== "object") return;

    const req = msg as RpcRequest;
    queueTail = queueTail.then(() => handler(req)).then((res) => {
      if (res) output.write(JSON.stringify(res) + "\n");
    }).catch(() => {
      const id = (req as RpcRequest).id ?? null;
      output.write(
        JSON.stringify(makeError(id, -32603, "Internal error")) + "\n",
      );
    });
  });
}

// ---------------------------------------------------------------------------
// Public entry
// ---------------------------------------------------------------------------

export async function run(): Promise<void> {
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

  // Try SDK first; fall back to hand-rolled if SDK unavailable.
  const sdkOk = await tryRunWithSdk();
  if (!sdkOk) {
    runStdioFallback();
  }
}
