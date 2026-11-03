// read-receipts — extracted implementation; imports point to the owning modules.
import type { FullReadResolution } from "./read-receipts.js";
import type { RefusalCode } from "@tokenlighten/types";
import { DOC_DISABLED } from "../runtime/config.js";
import { LARGE_BYTES } from "../util/fullGovernor.js";
import { READ_FULL_CAP_BYTES } from "./artifact-csv.js";
import { READ_FULL_CAP_BYTES_ALLOW_FULL } from "./artifact-csv.js";
import { TINY_BYTES } from "../util/fullGovernor.js";
import { TINY_LINES } from "../util/fullGovernor.js";
import { bindToResponseCeiling } from "../protocol/budget/wireBudget.js";
import { buildFullDowngradePayload } from "./read-receipts.js";
import { buildFullServePayload } from "./read-receipts.js";
import { canonicalToolCall } from "../protocol/envelope.js";
import { countLines } from "../util/countLines.js";
import { decideFullRead } from "../util/fullGovernor.js";
import { estimateBytesFromTokens } from "../protocol/budget/wireBudget.js";
import { extractOfficeText } from "../tools/extractOfficeText.js";
import { handleTable } from "../util/handles.js";
import { noteServedBytesSource } from "../protocol/envelope.js";
import { nulStrippedNoteText } from "./read-admission2.js";
import { officeOrArchiveSurfaceRefusal } from "./read-admission2.js";
import { readBytesSafe } from "../util/safePath.js";
import { servedTextForRoute } from "./read-admission2.js";
import { shaOfBytes } from "../util/handles.js";
import { shaOfText } from "../util/handles.js";
import { toolStructuredError } from "../protocol/result.js";
import { undecodableTextMessage } from "./read-admission2.js";

/**
 * Resolve read_code mode=full for exactly one path: office-file redirect
 * (unless allowFull), then the full-read governor (byte cap, per-path/
 * per-task budgets, C5 auto-allow), then the success payload. Each call is
 * fully independent — no shared state beyond the governor's own session
 * bookkeeping (decideFullRead/recordFullExpansion), which already counts a
 * paths[] batch item exactly as it would a separate single-path call, so
 * batching this way does not weaken or bypass any existing cap.
 */
export async function resolveFullReadForPath(
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
    /**
     * BCF: opt IN `buildFullServePayload`'s caller-budget-aware chunk sizing
     * (below) — set ONLY by the SINGULAR (true single-target) `mode=full`
     * dispatch, never by the mode=full `paths[]` BATCH loop, even though that
     * loop's OWN `officeOpts` already carries the same `maxBytes`/`maxTokens`
     * for the (unrelated) Office-extraction branch above.
     *
     * THE CONFLICT THIS AVOIDS (regression, confirmed live against
     * `readRequestContinuation.spec.ts`'s "delivers every target of a
     * 3-target content:full batch under one budget too small for all three"
     * — R2's own r2-batch-coverage pin): the batch loop resolves every
     * target in PASS 1 at its natural size and lets PASS 2's admission
     * (`exceedsFresh`/`truncateResolvedItemToFit`) decide what fits — that is
     * what defers an oversized target instead of shipping it. Pre-shrinking
     * a target INSIDE pass 1's resolution (this flag, if it applied here)
     * changes `entry.bytes` before pass 2 ever judges it AND stages a read
     * request (`stageFullReadRequest`) for a target that may end up sharing
     * a `read.batch` response with siblings — `applyReadRequestContinuation`
     * (protocol/readRequestContinuation.ts) then rewrites the response
     * against that staged request's own Q, and `emit.ts`'s post-rewrite
     * safety net can shrink a `read.text`'s `evidence[]` but not a
     * `read.batch`'s `entries[]`, so a growth past budget from that rewrite
     * has no fallback and refuses `budget-below-minimum` outright (measured:
     * `required_min_bytes:1940` against a declared 1500 B budget, where the
     * pre-fix code delivered all three targets across a short hop sequence).
     * The SINGULAR dispatch never shares its response with another target's
     * resolution, so it has no such conflict — see that call site's own
     * comment.
     *
     * 2026-10-24 (read-page ceiling): ONE exception. For a client with a response
     * ceiling the batch loop sets it together with `chunkCeilingBytes` (see its
     * call site): the refusal this paragraph measured is a declared budget's, and
     * the client's ceiling is a target that never refuses, so the growth it
     * guarded against ships a few hundred bytes over the ceiling at worst. What
     * the exception buys is that a whole-file entry wider than the ceiling is
     * chunked here, where the served-range ledger is written, and not shipped
     * whole as the force-admitted last entry (which has no `range` for
     * `truncateResolvedItemToFit` to cut at).
     */
    chunkToCallerBudget?: boolean;
    /**
     * 2026-10-24 (read-page ceiling): the client profile's response ceiling,
     * set by the same SINGULAR dispatch as `chunkToCallerBudget` and read only
     * with it. It bounds the first chunk of a `content:"full"` read exactly as an
     * explicit `budget.bytes` of that size would (`bindToResponseCeiling`) --
     * deliberately a field of its own and not folded into `maxBytes`/`maxTokens`,
     * which the Office extraction branch above takes as ITS output cap and a
     * client ceiling must not narrow.
     */
    chunkCeilingBytes?: number;
  } = {},
): Promise<FullReadResolution> {
  // BCF: the SAME tighter-of-bytes/tokens conversion the cursor-resume path
  // uses (`choosePage`'s own caller, above) — `undefined` unless the caller
  // named an EXPLICIT `budget.bytes`/`budget.tokens` on THIS call (never a
  // calibrated default ceiling; see `mapCanonicalBudget`'s doc) AND opted in
  // via `chunkToCallerBudget` (see that field's own doc comment for why the
  // mode=full `paths[]` batch loop must never do so), so a plain
  // default-budget `content:"full"` read — or any batch-loop resolution —
  // reaches `buildFullServePayload` with `callerBudgetBytes: undefined` and
  // is byte-identical to before this fix.
  const callerTokenBudgetBytes = officeOpts.chunkToCallerBudget === true
    ? estimateBytesFromTokens(officeOpts.maxTokens)
    : undefined;
  const callerBudgetBytes = officeOpts.chunkToCallerBudget !== true
    ? undefined
    : bindToResponseCeiling(
      officeOpts.maxBytes !== undefined && callerTokenBudgetBytes !== undefined
        ? Math.min(officeOpts.maxBytes, callerTokenBudgetBytes)
        : officeOpts.maxBytes ?? callerTokenBudgetBytes,
      officeOpts.chunkCeilingBytes,
    );
  const ext = (filePath.toLowerCase().match(/\.([^.\\/]+)$/)?.[1]) ?? "";
  const isOffice = ext === "docx" || ext === "xlsx" || ext === "pptx" || ext === "pdf";

  if (isOffice) {
    // DESIGN-v0.15 §8.2 (R7 Part B): extension-based auto-detection reaches
    // Office handling with NO advertised full-only field in the request (a
    // plain `path:"foo.xlsx"` read) — the schema/validator filter above
    // cannot catch this, so gate it here, at the point of entry.
    const surfaceRefusal = officeOrArchiveSurfaceRefusal();
    if (surfaceRefusal !== undefined) return { ok: false, error: surfaceRefusal.error, code: surfaceRefusal.code };
    if (DOC_DISABLED) return { ok: false, error: "Document extraction is disabled.", code: "not-a-document" };

    // mode=full on office files: redirect unless allowFull is explicitly true.
    if (!allowFullRequested) {
      // served-bytes: not-served (office/PDF container bytes: extractOfficeText owns its own decode)
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
          next: canonicalToolCall("tl_read_file", {
            mode: "artifact",
            path: filePath,
            kind: ext,
            ...(ext === "xlsx" ? { as: "json" } : {}),
            ...(officeOpts.credentialRef !== undefined ? { credentialRef: officeOpts.credentialRef } : {}),
          }),
        },
      };
    }

    // mode=full with allowFull:true on an office file: extract text directly.
    // served-bytes: not-served (office/PDF container bytes: extractOfficeText owns its own decode)
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

  // AA1 (round 10): serve-side verdict, not the lenient reader — see
  // `undecodableTextMessage`. This resolution feeds BOTH `content:"full"` and
  // the `paths[]` full batch, and round 9 measured it serving a rare-NUL file's
  // raw NUL (`content:"full"` on the same file the task pack served stripped).
  // served-bytes: readServedText
  const fullVerdict = await servedTextForRoute(filePath, workspace);
  if (fullVerdict !== null && fullVerdict.kind === "undecodable") {
    return { ok: false, error: undecodableTextMessage(filePath, fullVerdict), code: "read-error" };
  }
  const content = fullVerdict === null ? null : fullVerdict.text;
  if (content === null) return { ok: false, error: `File not found or outside workspace: ${filePath}`, code: "not-found" };
  // SHOULD-FIX 57 (AB1, round 11): EVERY success arm of this resolution — the
  // plain serve, the tiny exception, the auto-allow, and all four downgrade
  // payloads — goes through `servedFull`, so a `stripped` serve cannot be
  // silent at `content:"full"` or in the `paths[]` full batch. Round 10
  // measured a 2352-character stripped body here under
  // `sha:"sha256:0c1a4c0685ce"` with no note at all. The builders own the rest
  // of the payload; the annotation is composed with any `note` they set.
  const servedFull = (data: Record<string, unknown>): FullReadResolution => {
    const strip = nulStrippedNoteText(fullVerdict);
    if (strip === undefined) return { ok: true, data };
    const existing = typeof data["note"] === "string" && data["note"] !== "" ? `${data["note"] as string}; ` : "";
    return { ok: true, data: { ...data, note: `${existing}${strip}` } };
  };

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
      return servedFull(buildFullServePayload({
        workspace,
        filePath,
        content,
        handleId: govHEntry.id,
        sha: fullSha,
        keepComments,
        allowFull: allowFullRequested,
        callerBudgetBytes,
      }));
    }
    noteServedBytesSource("post-ready-trim");
    return servedFull(await buildFullDowngradePayload({
      workspace,
      filePath,
      content,
      handleId: govHEntry.id,
      sha: fullSha,
      bytes: fullBytes,
      maxBytes: effectiveCapBytes,
      reason: "full-downgraded",
      allowFullWouldHelp: false,
      keepComments,
      skeletonOnly: true,
      hint: "Post-ready discovery is trimmed; zoom this honest skeleton by range.",
    }));
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
        keepComments,
        fileHandle: govHEntry.id,
        autoAllowUnderCeiling: true,
      });
      if (autoDecision.decision === "allow" && autoDecision.autoAllowed) {
        // Feature 1 (2026-07-12b2): successful mode=full content serve.
        // B2e: routed through the shared chunk-capped builder.
        return servedFull(buildFullServePayload({
          workspace,
          filePath,
          content,
          handleId: govHEntry.id,
          sha: fullSha,
          keepComments,
          allowFull: allowFullRequested,
          callerBudgetBytes,
          extra: { auto_allowed: autoDecision.autoAllowed },
        }));
      }
      if (autoDecision.decision === "downgrade" && autoDecision.reason === "per-task-cap-reached") {
        return servedFull(await buildFullDowngradePayload({
          workspace,
          filePath,
          content,
          handleId: govHEntry.id,
          sha: fullSha,
          bytes: fullBytes,
          maxBytes: effectiveCapBytes,
          reason: "per-task-cap-reached",
          allowFullWouldHelp: true,
          keepComments,
          alternatives: autoDecision.alternatives,
          hint: "This task has hit its full-read budget for other files.",
        }));
      }
      // Otherwise (a REPEAT read → per-path-cap-reached downgrade): fall
      // through to the byte cap-exceeded payload below.
    }

    const hint = allowFullRequested
      ? `File is ${fullBytes} bytes, over the allowFull ceiling of ${READ_FULL_CAP_BYTES_ALLOW_FULL}; allowFull cannot help further here.`
      : allowFullWouldHelp
        ? `File is ${fullBytes} bytes, over the default cap of ${READ_FULL_CAP_BYTES}.`
        : `File is ${fullBytes} bytes, over both the default cap (${READ_FULL_CAP_BYTES}) and the allowFull ceiling (${READ_FULL_CAP_BYTES_ALLOW_FULL}); allowFull cannot help here.`;
    return servedFull(await buildFullDowngradePayload({
      workspace,
      filePath,
      content,
      handleId: govHEntry.id,
      sha: fullSha,
      bytes: fullBytes,
      maxBytes: effectiveCapBytes,
      reason: "cap-exceeded",
      allowFullWouldHelp,
      keepComments,
      hint,
    }));
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
        keepComments,
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
    return servedFull(await buildFullDowngradePayload({
      workspace,
      filePath,
      content,
      handleId: govHEntry.id,
      sha: fullSha,
      bytes: fullBytes,
      maxBytes: effectiveCapBytes,
      reason: govReason,
      allowFullWouldHelp,
      keepComments,
      alternatives: govDecision.alternatives,
      hint,
    }));
  }

  // mode=full augmentation: handle + sha + fullFileExpansion:true (C.5).
  // Note: recordFullExpansion already called inside decideFullRead for "allow".
  // B2e: the payload is built by buildFullServePayload, which caps ONE serve at
  // FULL_SERVE_CHUNK_BYTES (unless allowFull) and records only what it sent.
  // Feature 1 (2026-07-12b2): successful mode=full content serve.
  return servedFull(buildFullServePayload({
    workspace,
    filePath,
    content,
    handleId: govHEntry.id,
    sha: fullSha,
    keepComments,
    allowFull: allowFullRequested,
    callerBudgetBytes,
  }));
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
 * wrong, so point at `tl_search_files action=tree` to browse the real layout
 * rather than have the caller guess again blind. Other messages from this
 * function (doc extraction disabled; an office-extraction failure reason)
 * name a terminal or non-path condition — inventing a path-recovery `next`
 * there would misdirect rather than help, so they pass through unchanged.
 */
export function fullReadRefusal(failure: { error: string; code?: RefusalCode }): ReturnType<typeof toolStructuredError> {
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
    ...(notFound ? { next: canonicalToolCall("tl_search_files", { action: "tree" }) } : {}),
  });
}
