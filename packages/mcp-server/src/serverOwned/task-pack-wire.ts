// task-pack-wire — extracted implementation; imports point to the owning modules.
import type { BodyMarker } from "../util/verificationPack.js";
import type { RefusalCode } from "@tokenlighten/types";
import type { TaskContractScope } from "../features/task-pack/taskContractStore.js";
import type { TaskDecision } from "@tokenlighten/types";
import type { TaskExecutionContract } from "@tokenlighten/types";
import type { TaskPackResult } from "../features/task-pack/model.js";
import type { TaskRef } from "@tokenlighten/types";
import type { TaskVerifyObligation } from "@tokenlighten/types";
import type { ToolCall } from "@tokenlighten/types";
import { attachTaskQueryRefBinding } from "../state/session.js";
import { bindLedgerCertificate } from "../protocol/ledgerCertificateBinding.js";
import { bindTaskContractHandle } from "../features/task-pack/taskContractStore.js";
import { buildVerificationManifest } from "../util/verificationPack.js";
import { callWorkspace } from "../util/handles.js";
import { canonicalTaskBindingForHandle } from "./task-binding2.js";
import { clearCandidateListPack } from "../state/session.js";
import { currentSessionLane } from "../util/laneKey.js";
import { decisionInvariantStrictEnabled } from "../util/flags.js";
import { deriveCanonicalTaskDecision } from "../features/task-pack/canonicalDecision.js";
import { discoveryBundleNext } from "../features/task-pack/canonicalDecision.js";
import { dropServedBody } from "./verification.js";
import { editDietEnabled } from "./edit-validation.js";
import { editHunksByPath } from "./edit-review.js";
import { editKitDelta } from "./verification.js";
import { effSlimEditEnabled } from "../util/flags.js";
import { emittableToolCall } from "../protocol/refusal.js";
import { enforceCanonicalTaskDecisionAtExit } from "../features/task-pack/canonicalDecision.js";
import { getConcernTokens } from "../state/session.js";
import { getEditedPaths } from "../state/session.js";
import { getReadPaths } from "../state/session.js";
import { hasExecutedNextBoundOrUnbound } from "../util/packServeLog.js";
import { identifiersFromEditArgs } from "./edit-review.js";
import { isAuxiliaryEnumSurface } from "../features/task-pack/auxiliaryEnumContextIntegration.js";
import { isLedgerBackedCertificateId } from "../protocol/ledgerCertificateBinding.js";
import { isTraceEnabled } from "../util/trace.js";
import { labelKitBodies } from "./verification.js";
import { ledgerDigestBacksCertificateId } from "../protocol/ledgerCertificateBinding.js";
import { markVerificationPathsServed } from "../state/session.js";
import { mintTaskHandle } from "../state/stateHandles.js";
import { normalizeContractLane } from "../util/packServeLog.js";
import { noteContinuationTaskHandle } from "../protocol/envelope.js";
import { noteTaskHandleHandedOut } from "../state/session.js";
import { packUnchangedPriorLabel } from "../protocol/decisionWire.js";
import { prescribedSearchTermsOf } from "./task-binding2.js";
import { projectEvidence } from "../protocol/decisionWire.js";
import { projectLeanExecutionContract } from "../util/leanExecutionContract.js";
import { projectRootOf } from "../features/locator/locateTaskContext.js";
import { projectTaskDecision } from "../protocol/decisionWire.js";
import { projectTaskRef } from "../protocol/decisionWire.js";
import { protocolCallContext } from "../protocol/envelope.js";
import { publishTaskPackAuxiliaryEnumPool } from "../features/task-pack/engine/packTrimming3.js";
import { readFileSafe } from "../util/safePath.js";
import { recordCandidateListPack } from "../state/session.js";
import { recordCertifiedDecision } from "../state/session.js";
import { recordExecutionContract } from "../state/session.js";
import { recordLaneTaskHandle } from "../state/laneTaskHandles.js";
import { recordPrescribedSearchTerms } from "../util/packServeLog.js";
import { recordReadPath } from "../state/session.js";
import { registerExecutableNextScope } from "../features/task-pack/taskContractStore.js";
import { rekeyExecutionFenceCertificate } from "../state/session.js";
import { relocateGoReviewsToFrontier } from "../protocol/decisionWire.js";
import { repairSuppressedNextCall } from "../features/task-pack/engine/receiptProgress2.js";
import { sanctionFromEvidence } from "../protocol/decisionWire.js";
import { sessionLaneOf } from "./task-binding2.js";
import { stagePackFingerprintBinding } from "../features/task-pack/engine/packState.js";
import { statSync } from "node:fs";
import { takePreparedHandleAdvisory } from "../state/session.js";
import { taskContractDigest } from "../features/task-pack/taskContractStore.js";
import { taskContractLedgerSnapshot } from "../features/task-pack/taskContractStore.js";
import { taskDecisionWireViolations } from "../protocol/decisionWire.js";
import { taskFingerprintFor } from "./task-binding2.js";
import { trace } from "../util/trace.js";
import { unservedVerificationPaths } from "../state/session.js";
import { verificationSignalsFromEditArgs } from "./edit-review.js";
import { walkCodeFiles } from "../tools/walkRepo.js";
import { withoutLedgerClaim } from "../protocol/ledgerCertificateBinding.js";

/**
 * Row 11 (C2-6): `mode=map`'s locate-abstain passthrough has no A.7.1
 * "still a success" shape of its own to answer through — A.7.1's
 * "OUT — locate abstains" exclusion is scoped to `tl_search_files
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
export function mapMissRefusalCode(reason: string): RefusalCode {
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
    // P1-2 (hands-on report): a task_pack producer's OWN reason can already
    // be the canonical RefusalCode string (features/task-pack/model.ts types
    // `TaskPackResult.reason` as exactly this one literal) rather than a
    // LocateAbstainData-vocabulary reason needing translation. Identity case
    // so this switch stays the single place reason-string -> RefusalCode
    // mapping happens, instead of a second ad hoc table at the call site.
    case "broad-overview-query":
      return "broad-overview-query";
    default:
      // resolveMap's own "query is required for mode=map" prose (not a
      // LocateAbstainData.reason token) lands here.
      return "invalid-input";
  }
}

/**
 * A.2.3 wire `profile`: "answer" iff the pack's own `task_profile` echo or
 * `profile_binding.selected` says so, else "generic". Shared by the two
 * places that project this field onto the wire — `recordTaskPackExecution`'s
 * ordinary dispatch exit and `projectTaskPackWire`'s archive/closure exit —
 * which carried byte-identical copies of this same three-line expression
 * (P1-2, hands-on report, 2026-09 de-duplication).
 */
/** The certificate hashes the full selected profile, before its wire answer/generic projection. */
export function taskIdentityProfile(result: Record<string, unknown>): string {
  const binding = result["profile_binding"];
  const selected = binding !== null && typeof binding === "object" && !Array.isArray(binding)
    ? (binding as Record<string, unknown>)["selected"] : undefined;
  if (typeof selected === "string" && selected.length > 0) return selected;
  const declared = result["task_profile"];
  return typeof declared === "string" && declared.length > 0 ? declared : wireTaskProfile(result);
}

export function wireTaskProfile(result: Record<string, unknown>): "answer" | "generic" {
  return result["task_profile"] === "answer"
    || (result["profile_binding"] as { selected?: unknown } | undefined)?.selected === "answer"
    ? "answer"
    : "generic";
}

/**
 * P1-2 (hands-on report, 2026-09): `buildTaskPackCore`'s
 * `shouldRedirectToOverview` early return ships `{ok:false,
 * reason:"broad-overview-query", next:{...}}` with no `execution_contract`/
 * typestate. `projectTaskDecision` (protocol/decisionWire.ts) is
 * contract-driven by construction (`canonicalKind === undefined || contract
 * === undefined` short-circuits to `undefined`), so this producer shape used
 * to reach the wire with NO `decision` at all — exactly the "read.task_pack
 * with no decision" shape the hands-on report observed served silently in
 * production, and which the strict wire invariant (ambient under vitest)
 * catches as a thrown error instead of a malformed response.
 *
 * Mirrors the SAME `familyDecision` fallback pattern the archive family
 * already uses (`archiveTaskDecision`, fed into `projectTaskPackWire`'s own
 * `familyDecision` parameter): an EMITTER-layer projection for a producer
 * shape the canonical projector cannot read, never a change to the canonical
 * projector itself.
 *
 * The stub's own `next` is the legacy `{mode:"overview"}` dialect
 * (AGENTS.md: "never emit" that dialect) — canonicalized here via the same
 * `emittableToolCall` helper every other legacy-shaped internal call
 * description in this protocol goes through (confirmed against
 * readCodeModes.spec.ts's own "emits a canonical object continuation" case:
 * `{tool:"tl_read_file", arguments:{content:"outline"}}` is the established
 * canonical spelling for a pathless repo-overview read). `discover` requires
 * a non-optional `next` (packages/types/src/mcp/decision.ts, D-1); the
 * `await_input` fallback only matters if canonicalization somehow fails
 * (unreached today — the stub always sets a well-formed `next`), and reuses
 * the SAME token `projectTaskDecision`'s own discover branch falls back to
 * when it cannot name a call.
 *
 * Review-2 finding 7: this `await_input` is built INLINE rather than through
 * `protocol/decisionWire.ts`'s shared `awaitInput(...)` builder (the one every
 * OTHER `await_input` emission site in `projectTaskDecision` goes through).
 * That is deliberate, not an oversight: `awaitInput` takes a non-optional
 * `contract: TaskExecutionContract`, and every one of its `unresolved[]`
 * sources reads either that contract (`evidence_model`, `capability_gaps`) or
 * fields this stub's `result` never carries (`profile_binding`, `coverage`,
 * `checks`, `missing*`) — `shouldRedirectToOverview`'s early return ships
 * exactly `{ok:false, reason:"broad-overview-query", next:{...}}`, nothing
 * else. Threading a fabricated/empty contract through just to reach the
 * shared builder would derive `unresolved` from facts that do not exist
 * rather than from ones this response discloses, which is the exact
 * falsification `projectUnresolved`'s own doc comment forbids ("WRONG BY
 * OMISSION" — an omission is spelled by omitting the key, never by inventing
 * a source to fill it). An absent `unresolved` here is the honest shape: this
 * producer has nothing to name — and this whole arm is unreached today
 * regardless (see above), so no live response's caller-visible behavior turns
 * on this choice.
 */
export function overviewRedirectFamilyDecision(result: Record<string, unknown>): TaskDecision | undefined {
  if ((result as { ok?: boolean }).ok !== false || result["reason"] !== "broad-overview-query") {
    return undefined;
  }
  const next = emittableToolCall(result["next"]);
  return next !== undefined
    ? { kind: "discover", next }
    : { kind: "await_input", code: "no-grounded-call-remains" };
}

/**
 * C2-6: `resolveTaskPackQueryArg`'s two failure messages need different
 * A.7.1 codes and (for the stale-qref case) a machine-readable detail —
 * resolved here, at each of its two call sites, rather than changing the
 * function's own return shape underneath its other caller.
 */
export function taskPackQueryErrorPayload(
  resolution: { error?: string; next?: ToolCall; detail?: string; retry?: "new-task"; remaining?: string },
): Record<string, unknown> {
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
    // G2: forwarded from `taskPackRecoveryFor` so a genuinely unrecoverable
    // qref still declares its sanctioned transition and says what to resend,
    // even with no `next` to carry (see that function's doc comment).
    ...(resolution.retry !== undefined ? { retry: resolution.retry } : {}),
    ...(resolution.remaining !== undefined ? { remaining: resolution.remaining } : {}),
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
export function xlsxTableFailureCode(message: string): RefusalCode {
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
export const UNREAD_SCAN_MAX_FILES = 400;

export const UNREAD_SCAN_MAX_FILE_BYTES = 256 * 1024;

export const UNREAD_NOTE_MAX_CHARS = 170;

/** Small single-file edits at or below this hunk size skip the lexical sibling note by default. */
export const UNREAD_NOTE_MAX_HUNK_LINES = 40;

export function unreadNoteSpecificityEnabled(): boolean {
  return (process.env["TL_UNREAD_NOTE_SPECIFICITY"] ?? "").trim().toLowerCase() !== "off";
}

export function unreadNoteMaxHunkLines(): number {
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
export function specificIdentifiersFromEditArgs(args: Record<string, unknown>): string[] {
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
export function editedPathsOf(result: Record<string, unknown>, fallbackPath: string): string[] {
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
export function topDirOf(relPath: string): string {
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
export async function buildUnreadSiblingNote(
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

    // served-bytes: not-served (concern scoring: token containment only, no body derived from it)
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
      !isAuxiliaryEnumSurface(surface) &&
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
  /**
   * G3 (2026-09-08, qref-binding fix): a caller that already recovered this
   * task's canonical binding from the request's `qref`
   * (`resolveTaskPackQueryArg`'s `taskBinding`, via `state/session.ts`'s
   * `resolveTaskQueryRefBinding`) passes it here as a FALLBACK — used only
   * when `contractScope` names no `task.handle` of its own — so the
   * wire-level no-repeat checks below partition on the SAME identity
   * `suppressNonProgressingNextCall` uses inside the builder, instead of
   * silently falling back to the unbound partition for a handleless re-pack.
   */
  recoveredTaskBinding?: string,
  originalPackResult?: object,
): void {
  // A task handle is a wire capability, not the durable task identity. The
  // executed-next ledger uses the authenticated task fingerprint so two tasks
  // in one workspace/lane cannot consume each other's continuation.
  const taskBinding = canonicalTaskBindingForHandle(workspace, contractScope?.taskHandle) ?? recoveredTaskBinding;
  const contractValue = result["execution_contract"];
  const contract = contractValue && typeof contractValue === "object"
    ? contractValue as TaskExecutionContract
    : undefined;
  // Optional source context must not become fence, readiness, frontier, or
  // sanctioned-next input merely because the wire projector sees it later.
  const auxiliarySurfaces = Array.isArray(result["surfaces"])
    ? result["surfaces"].filter(isAuxiliaryEnumSurface) : [];
  if (auxiliarySurfaces.length > 0) result["surfaces"] = (result["surfaces"] as unknown[])
    .filter(surface => !isAuxiliaryEnumSurface(surface));
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
  const changeContract = result["change_contract"];
  const changeObligations = changeContract !== null && typeof changeContract === "object" && !Array.isArray(changeContract) && (changeContract as Record<string, unknown>)["status"] === "ready" && Array.isArray((changeContract as Record<string, unknown>)["obligations"])
    ? (changeContract as Record<string, unknown>)["obligations"] as unknown[] : [];
  const batchEditTargets = changeObligations.flatMap((entry) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return [];
    const obligation = entry as Record<string, unknown>;
    if (obligation["action"] !== "edit" || obligation["status"] !== "ready" || obligation["required"] === false) return [];
    const handle = typeof obligation["handle"] === "string" ? obligation["handle"] : "";
    const path = typeof obligation["path"] === "string" ? obligation["path"] : "";
    return handle === "" && path === "" ? [] : [{ handle, path }];
  });
  // VF-5 hand-off: this pack's own `change_contract.verify_obligations` (only
  // ever attached while TL_SF_VERIFY_FIRST is on — see sfVerifyObligations.ts),
  // recorded so a LATER, kit-less `read.closure` call in the same task epoch
  // can still recover it (state/session.ts's `recordedVerifyObligations`).
  const verifyObligationsRaw = changeContract !== null && typeof changeContract === "object" && !Array.isArray(changeContract)
    ? (changeContract as Record<string, unknown>)["verify_obligations"]
    : undefined;
  const verifyObligations: readonly TaskVerifyObligation[] | undefined = Array.isArray(verifyObligationsRaw)
    ? (verifyObligationsRaw as TaskVerifyObligation[])
    : undefined;
  const disposition = recordExecutionContract(workspace, query, contract, undefined, sanctionedZoom, batchEditTargets, verifyObligations);
  const preparedHandleAdvisory = takePreparedHandleAdvisory(workspace);
  // The pack may already carry an advisory of its own (TL_EFF_MAP_ANSWER_FIRST's facts): this one joins it.
  if (preparedHandleAdvisory !== undefined) {
    const own = result["advisory"];
    result["advisory"] = typeof own === "string" && own !== "" ? `${own}; ${preparedHandleAdvisory}` : preparedHandleAdvisory;
  }
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
      tool: "tl_read_file" as const,
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
      reason: "the readiness certificate was revoked by your challenge and the edit gate is now open; apply the intended change directly (tl_edit_file with this pack's handles), or start a fresh task_pack with taskEpoch:\"new\" to re-scope",
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
    // derives for a tl_read_file next_call.
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
    && hasExecutedNextBoundOrUnbound(
      workspace,
      normalizeContractLane(contractScope?.lane),
      alreadyExecuted.tool,
      alreadyExecuted.arguments as Record<string, unknown>,
      taskBinding,
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
      undefined,
      taskBinding,
    );
  }

  // -------------------------------------------------------------------------
  // protocol v1 §2.1 / D7: THE SINGLE DECISION, EMITTED ONCE.
  //
  // `result` here is `attachSupply`'s OUTPUT (a copy of the raw pack
  // `buildTaskPack` returned) — round-22B finding 2 (DESIGN-v0.15 §0.3(j)):
  // that copy used to make the SF closure-gate arbiter invisible to
  // `deriveCanonicalTaskDecision` on every real dispatch call, because the SF
  // context lived only in a `WeakMap` keyed on the pre-copy object. Fixed in
  // `sfSatisfaction.ts` (token-on-the-object, survives the copy) — nothing
  // needs to change at this call site for the fix to take effect, but nothing
  // upstream of here may reintroduce a `structuredClone`/JSON round-trip of
  // the pack result, which WOULD drop the token again.
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
  let decision = projectTaskDecision({
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
    consumed: (call) => hasExecutedNextBoundOrUnbound(
      workspace,
      normalizeContractLane(contractScope?.lane),
      call.tool,
      (call.arguments ?? {}) as Record<string, unknown>,
      taskBinding,
    ),
  });
  // A wire-only discovery bundle is minted after the builder's no-repeat
  // choke, so its consumed result must enter the same normal repair path as a
  // consumed contract next.  Otherwise the projector can suppress it into a
  // gap-less await_input even though the pack is still partial.
  const bundle = discoveryBundleNext(result as unknown as TaskPackResult);
  if (
    decision?.kind === "await_input"
    && decision.code === "no-grounded-call-remains"
    && bundle !== undefined
    && hasExecutedNextBoundOrUnbound(
      workspace,
      normalizeContractLane(contractScope?.lane),
      bundle.tool,
      (bundle.arguments ?? {}) as Record<string, unknown>,
      taskBinding,
    )
  ) {
    repairSuppressedNextCall(
      workspace,
      normalizeContractLane(contractScope?.lane),
      result as unknown as TaskPackResult,
      query,
      bundle,
      undefined,
      taskBinding,
    );
    decision = projectTaskDecision({
      result,
      contract: effectiveContract,
      canonicalKind: effectiveContract === undefined
        ? undefined
        : deriveCanonicalTaskDecision(result as unknown as TaskPackResult)?.kind,
      evidence: emittedEvidence,
      consumed: (call) => hasExecutedNextBoundOrUnbound(
        workspace,
        normalizeContractLane(contractScope?.lane),
        call.tool,
        (call.arguments ?? {}) as Record<string, unknown>,
        taskBinding,
      ),
    });
  }
  // P1-2 (hands-on report): a decision-less ok:false pack (currently only
  // buildTaskPackCore's broad-overview-query early return) has no
  // execution_contract for projectTaskDecision to read, so `decision` is
  // still undefined here. Project the family decision the same way the
  // archive family already does via projectTaskPackWire's familyDecision
  // parameter, rather than let a decision-less task_pack reach the wire —
  // and let the strict conformance check just below validate it too.
  decision = decision ?? overviewRedirectFamilyDecision(result);
  // 2026-10-22 (codex-copilot-proxy r18 T07): the decision is final here, so a Go returned-local
  // review rides the act.edit frontier entry of its file instead of the evidence row's `why`.
  relocateGoReviewsToFrontier(decision, emittedEvidence);
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
  const profile = wireTaskProfile(result);
  // G3 (2026-09-08, qref-binding fix): captured BEFORE `withTaskHandle`
  // overwrites `.id` with the minted wire handle. This pre-mint value is
  // exactly the `taskFingerprint` `mintTaskHandle` stores under that handle,
  // so it is what `canonicalTaskBindingForHandle` will resolve back to for
  // ANY later call that presents the resulting `task.handle` — i.e. the SAME
  // canonical binding this task's executed-next records use.
  const taskRefBeforeHandle = projectTaskRef(
    result,
    effectiveContract,
    taskFingerprintFor(taskIdentityProfile(result), query),
  );
  const task = withTaskHandle(taskRefBeforeHandle, contractScope);
  const resolvedScope = contractScope === undefined
    ? undefined
    : bindTaskContractHandle(workspace, contractScope, task.id);
  // G3: stamp that same fingerprint onto the qref THIS response just
  // (re)issued, so a LATER handleless `tl_read_file {qref}` re-pack of this task
  // can recover it (`resolveTaskPackQueryArg` -> `resolveTaskQueryRefBinding`)
  // and land its own executed-next lookups in this exact partition — see
  // `state/session.ts`'s `attachTaskQueryRefBinding`. A no-op when this
  // response minted no qref (a handle-only continuation, or no durable
  // query-ref slot for this call) or when the fingerprint is empty.
  //
  // G4 (2026-09-08, qref-task-scope fix): the SAME call also stamps `task.id`
  // — the WIRE handle, not the fingerprint — onto the qref. This is what
  // `applyRecoveredTaskHandleFromQref` (below) later injects as a bare
  // `tl_read_file {qref}` re-pack's own `task_handle`, so `taskContractScopeOf`
  // resolves the exact `{lane, taskHandle}` scope `bindTaskContractHandle`
  // (just above) relocated the epoch's requirement/obligation ledger to.
  // Review-2 finding 1(a): only stamp `task.id` as the wire handle when
  // `withTaskHandle` actually minted one for THIS call — it returns `task`
  // unchanged (same `.id` as the raw fingerprint) whenever no durable store is
  // available for this workspace. Passing the raw fingerprint through as if it
  // were a mintable handle would let `applyRecoveredTaskHandleFromQref` stamp
  // a non-handle string onto a later bare-qref re-pack's `task_handle`; that
  // call's own `resolveTaskHandle(...).ok` guard would already catch it, but
  // the two guards are independent and either alone must close this — see
  // that function's own doc comment.
  const qrefForBinding = result["qref"];
  const mintedTaskHandle = task.id !== taskRefBeforeHandle.id ? task.id : undefined;
  if (originalPackResult !== undefined && mintedTaskHandle !== undefined && taskRefBeforeHandle.id !== "") {
    stagePackFingerprintBinding(workspace, originalPackResult, taskRefBeforeHandle.id, mintedTaskHandle);
  }
  if (typeof qrefForBinding === "string" && qrefForBinding !== "" && taskRefBeforeHandle.id !== "") {
    attachTaskQueryRefBinding(workspace, qrefForBinding, taskRefBeforeHandle.id, mintedTaskHandle);
    if (originalPackResult !== undefined && mintedTaskHandle !== undefined) {
      publishTaskPackAuxiliaryEnumPool(workspace, originalPackResult,
        qrefForBinding, taskRefBeforeHandle.id, mintedTaskHandle);
    }
  }

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
  // FX-L SOFT FRONTIER MARKER (user ruling 2026-09-14, review-findings-6
  // SHOULD-FIX 38): record the CERTIFIED decision this lane was just handed,
  // exactly as the caller receives it one line above. This is the only site
  // that both emits the single decision and installs the fence, so a record
  // written here can never describe a verdict the caller was not given.
  //
  // Only `act.edit` / `act.answer` are certified decisions; a `discover` /
  // `await_input` / `done` pack certifies nothing and therefore does NOT
  // retire an earlier record (see `recordCertifiedDecision`'s own doc).
  // `qref`/`task.id` are captured for the binding check and degrade to "" when
  // this pack minted neither, which is the ruling's epoch-only fallback.
  if (decision !== undefined && (decision.kind === "act.edit" || decision.kind === "act.answer")) {
    recordCertifiedDecision(workspace, {
      certificateId: decision.certificate?.id ?? "",
      kind: decision.kind,
      frontier: (decision.kind === "act.edit" ? decision.frontier ?? [] : [])
        .map((entry) => ({ path: entry.path, writable: entry.writable })),
      createTargetPath: decision.kind === "act.edit" ? decision.create_target?.path ?? "" : "",
      taskId: typeof task.id === "string" ? task.id : "",
      qref: typeof qrefForBinding === "string" ? qrefForBinding : "",
    });
  }
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
  // R1-S10a (2026-09-13 review round): record WHICH TERMS this pack asked the
  // caller to search for, so the result ledger can refuse to learn from a search
  // no pack ever requested (`termSearchWasPrescribed`).
  //
  // Read from BOTH carriers. `registerExecutableNextScope` above is fed only by
  // the internal `next_call`, and the answer-pack `discover` shape that prescribes
  // an identifier find leaves that unset while carrying the call on the wire
  // decision — which is precisely why the pending-next fences never fire on those
  // chains. A fence must be able to say YES when the pack really did ask, so this
  // reads the prescription wherever the pack actually put it.
  //
  // Lane, not task: `contractScope?.lane` is the authenticated lane of the call
  // being served (`currentSessionLane()` is the same value for an ALS-scoped
  // dispatch and the fallback when no contract scope exists), and the record is
  // deliberately UNBOUND — the caller's later search has no binding of its own to
  // match against. See `recordPrescribedSearchTerms`' doc comment for why that is
  // a necessary-not-sufficient condition.
  for (const carrier of [next, (decision as { next?: unknown } | undefined)?.next]) {
    const terms = prescribedSearchTermsOf(carrier);
    if (terms.length > 0) {
      recordPrescribedSearchTerms(workspace, contractScope?.lane ?? currentSessionLane(), terms);
    }
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
    // T07 `tl_read_file mode=task_pack paths=["bench/fixtures/ledgerd"]` shape):
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
  result["evidence"] = [...emittedEvidence, ...projectEvidence(auxiliarySurfaces)];
  delete result["surfaces"];
}

/**
 * A.5.1's required set, applied to the two task-pack-shaped responses that do
 * NOT go through `recordTaskPackExecution` (C2-3).
 *
 * WHICH TWO, AND WHY THEY ARE READ FAMILY. `buildArchiveTaskPack` (an archive
 * pack) and `tl_search_files action=locate includeClosure:true` (which routes to
 * `buildTaskPack`) both emit a task pack. `Kind` names the PAYLOAD's family,
 * not the tool that was called — the same rule `envelope.ts` already applies to
 * a receipt served on a `tl_search_files` call — so both are `read.task_pack` and
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
export function withTaskHandle(task: TaskRef, contractScope?: TaskContractScope): TaskRef {
  const workspace = callWorkspace();
  if (workspace === undefined) return task;
  const handle = mintTaskHandle(workspace, {
    taskFingerprint: task.id,
    ...(task.replay !== undefined ? { replay: task.replay } : {}),
    coverage: task.coverage,
    ...(taskContractDigest(workspace, contractScope) !== undefined ? { ledgerDigest: taskContractDigest(workspace, contractScope) } : {}),
    mintedAtMs: Date.now(),
  });
  if (handle === undefined) return task;
  noteContinuationTaskHandle(handle);
  // 2026-10-20 (decision run 6t-8): the caller now holds this request's
  // continuation, which the epoch-repeat advisory names (state/session.ts,
  // `requestTaskHandedOut`).
  noteTaskHandleHandedOut(workspace);
  // D1: remember which lane is working this handle, so a later call that sends
  // a MANGLED copy of it can be told "fix this field" instead of the false
  // "no working set survives this call". Registry only — never enumerated on
  // the wire; see `state/laneTaskHandles.ts`.
  recordLaneTaskHandle(workspace, sessionLaneOf(protocolCallContext()?.args ?? {}), handle);
  return { ...task, id: handle };
}

export function projectTaskPackWire(
  result: Record<string, unknown>,
  query: string,
  familyDecision?: TaskDecision,
): void {
  const auxiliarySurfaces = Array.isArray(result["surfaces"])
    ? result["surfaces"].filter(isAuxiliaryEnumSurface) : [];
  if (auxiliarySurfaces.length > 0) result["surfaces"] = (result["surfaces"] as unknown[])
    .filter(surface => !isAuxiliaryEnumSurface(surface));
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
  }) ?? familyDecision ?? overviewRedirectFamilyDecision(result);
  relocateGoReviewsToFrontier(decision, evidence);
  const profile = wireTaskProfile(result);
  result["task"] = withTaskHandle(projectTaskRef(
    result,
    contract,
    taskFingerprintFor(taskIdentityProfile(result), query),
  ));
  result["profile"] = profile;
  if (decision !== undefined) result["decision"] = decision;
  result["evidence"] = [...evidence, ...projectEvidence(auxiliarySurfaces)];
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
export function buildVerificationBody(workspace: string, editArgs?: Record<string, unknown>): Record<string, unknown> | undefined {
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
export function buildVerificationBodyDetailed(
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
  // 2026-10-29 (click/core.py report): only the removed and added LINES count
  // (context lines quoted on both sides are not the change), string literals
  // ride along, and a test naming one of them is a candidate even when it never
  // spells the edited module.
  const { identifiers: changedIdentifiers, literals: changedLiterals } = editArgs !== undefined
    ? verificationSignalsFromEditArgs(editArgs)
    : { identifiers: [], literals: [] };
  const manifest = buildVerificationManifest(workspace, edited, {
    // K3a: the edit-attachment path is where consecutive identical kits were
    // measured riding back-to-back responses — dedupe applies HERE only.
    dedupeConsecutive: !forceServe,
    // 2026-10-20 (window 6t-7): the interpreter a Python edit's checks need
    // when the PATH's python3 cannot run them — the edit kit only.
    pythonSyntaxCheck: true,
    ...(changedIdentifiers.length > 0 ? { changedIdentifiers } : {}),
    ...(changedLiterals.length > 0 ? { changedLiterals } : {}),
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
  // EFF (TL_EFF_SLIM_EDIT): an edit reply's kit ships no inline body. The body
  // is dropped BEFORE dropServedBody would ledger it as held, so labelKitBodies
  // labels the entry `omitted` (or `served-earlier` when the caller truly holds
  // it) and routes it into the kit's one batched next_call.
  const slimKit = effSlimEditEnabled() && editArgs !== undefined;
  const keepBody = <T extends { path: string; code?: string; body?: BodyMarker; content_completeness?: "partial" }>(
    entry: T,
  ): T | Omit<T, "code"> => {
    if (forceServe) return entry;
    if (slimKit && entry.code !== undefined) {
      const { code: _code, ...rest } = entry;
      return rest;
    }
    return dropServedBody(workspace, entry);
  };
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
  // TL_EFF_EDIT_DIET (2026-10-19): an edit reply's kit on a diet host drops its
  // batched read when it carries a harness build command (B3), and repeats no
  // entry this task's earlier edit kits already carried (B2). `force_serve`
  // re-serves the whole kit, as it does for every other kit suppression.
  const diet = editArgs !== undefined && editDietEnabled();
  const labelled = labelKitBodies(workspace, {
    ...manifest,
    surfaces,
    link_set: linkSet,
    ...(harness !== undefined ? { harness } : {}),
  }, { omitBatchedReadWithBuildCommand: diet });
  return {
    manifest: diet ? editKitDelta(workspace, labelled, forceServe) : labelled,
    notApplicable: false,
  };
}
