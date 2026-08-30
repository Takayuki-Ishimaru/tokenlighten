/**
 * apply_edits_multi tool implementation for @tokenlighten/mcp-server v0.2.
 *
 * ALL-OR-NOTHING semantics:
 *   1. Pre-validate ALL edits against current file bytes.
 *   2. If ANY validation fails, return failures without writing anything.
 *   3. Only after all validations pass, write each file atomically.
 *   4. Create a single shadow-git checkpoint for the successful batch.
 *
 * 5 MB per-file cap is enforced during validation.
 * Secret file paths are rejected during validation.
 * Duplicate paths in the same batch are auto-merged into one per-file edit
 * sequence (preserving the caller's edits[] order), not rejected — see the
 * pathGroups/mergedPaths comment below.
 *
 * A7 (reports/bench/2026-07-02a "First-class batching"): edits[] items may
 * also carry a `range` (resolved server-side from a handle) to scope the
 * operation to a line range instead of the whole file — either `content`
 * (range-content replacement) or `search`/`replace` (range-scoped
 * replace-all, matching write/rangeEdit.ts semantics). The line-math here
 * intentionally mirrors write/rangeEdit.ts's private helpers rather than
 * importing them: those helpers read+write a single file immediately and
 * are not shaped for this module's pre-validate-all-then-write-all flow.
 *
 * Output policy: plain data — no meta envelope.
 * Spec: docs/components/02-mcp-server.md §2.2
 */

import * as fs from "fs";
import * as path from "path";
import { writeExistingFileAtomic } from "../write/atomicWrite.js";
import { looksLikeSecretFile } from "../write/secretScan.js";
import { validateCreateTarget, publishNewFile } from "./createFileCore.js";
import { invalidateCachedWorkspaceFiles } from "@tokenlighten/skeleton-engine";
import { detectWriteEncodingRisk, writeEncodingRefusalMessage } from "../util/textDecode.js";
import {
  applySingleEdit,
  findUniqueIndentationEquivalent,
  hasLiteralBackslashEscape,
  reindentReplacement,
  sharesLiteralEscapeClass,
  unescapeBackslashSequences,
} from "../write/textEdit.js";
import { batchCheckpoint } from "../write/checkpoint.js";
import type { GuardedWorkspaceRoot } from "../write/guardedWorkspace.js";
import { computeLineDelta, formatDelta, formatLines } from "../util/lineDelta.js";
import {
  fileHeadForensics,
  nearestMatchForensics,
  rangeMissForensics,
  refreshedRangeSlice,
  type NearestMatchInfo,
} from "../write/editForensics.js";
import { handleTable, shaOfText, shortSha } from "../util/handles.js";
import { measureBlastRadius, type BlastRadiusMeasure } from "../write/blastRadius.js";

// ---------------------------------------------------------------------------
// A7: range-scoped edit-entry line math (mirrors write/rangeEdit.ts).
// ---------------------------------------------------------------------------

function parseRangeEntry(range: string): { start: number; end: number } | null {
  // 2026-07-11c: accept comma-separated ranges ("160,195") as a synonym for
  // the dash form — mirrors readCodeModes.ts's resolveSlice leniency for the
  // same agent typo (comma instead of dash).
  const commaMatch = /^\s*(\d+)\s*,\s*(\d+)\s*$/.exec(range);
  const normalized = commaMatch ? `${commaMatch[1]}-${commaMatch[2]}` : range;
  const match = normalized.match(/^(\d+)(?:-(\d+))?$/);
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2] ?? match[1]);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) return null;
  return { start, end };
}

function detectLineEndingEntry(s: string): "\n" | "\r\n" | "\r" {
  const idx = s.indexOf("\n");
  if (idx === -1) return s.includes("\r") ? "\r" : "\n";
  return idx > 0 && s[idx - 1] === "\r" ? "\r\n" : "\n";
}

function toLfEntry(s: string): string {
  return s.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function restoreLineEndingEntry(s: string, lineEnding: "\n" | "\r\n" | "\r"): string {
  return lineEnding === "\n" ? s : s.replace(/\n/g, lineEnding);
}

function lineStartIndexEntry(text: string, line: number): number {
  if (line <= 1) return 0;
  let seen = 1;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") {
      seen++;
      if (seen === line) return i + 1;
    }
  }
  return text.length;
}

function lineEndWithNewlineIndexEntry(text: string, line: number): number {
  let seen = 1;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") {
      if (seen === line) return i + 1;
      seen++;
    }
  }
  return text.length;
}

/**
 * Byte-identical copy of util/countLines.ts's sliceLinesToText, kept local
 * for the same reason countLogicalLinesEntry below is (a same-process
 * cross-check without importing an internal helper across module boundaries
 * — see countLines.spec.ts's own "agreement" tests). Restores the source
 * text's trailing newline when [startLine,endLine] reaches its true last
 * logical line, so this CAS reconstruction stays byte-identical to
 * resolveSlice's own MINT-time reconstruction (tools/readCodeModes.ts) for a
 * whole-file-reaching range.
 *
 * T1b (v0.13, UTF-16 3-way read-parity wave): resolveSlice now restores that
 * trailing newline at mint time (see its doc comment). Without the matching
 * fix here, this VERIFY-time reconstruction would disagree with it and
 * refuse every EOF-reaching anchor edit as served-content-stale on a file
 * that never actually changed (live regression caught by
 * replayCorpus.spec.ts's efd3 case).
 */
function sliceLinesToTextEntry(raw: string, startLine: number, endLine: number): string {
  const lines = raw.split(/\r?\n/);
  const total = countLogicalLinesEntry(raw);
  const clampedEnd = Math.min(endLine, lines.length);
  const joined = lines.slice(startLine - 1, clampedEnd).join("\n");
  const reachesEnd = endLine >= total && (raw.endsWith("\n") || raw.endsWith("\r\n"));
  return reachesEnd && joined.length > 0 && !joined.endsWith("\n") ? joined + "\n" : joined;
}

/**
 * The text an addressing handle's recorded sha covers, as it stands on disk
 * NOW — used to decide whether an anchor edit's coordinates are still valid.
 *
 * `shaRange === undefined` means the handle served the WHOLE file
 * (kind:"file"), whose sha is taken over the raw file text, so the raw text is
 * returned unnormalized. A slice handle (kind:"range"/"symbol") records its sha
 * over `content.split(/\r?\n/).slice(start-1,end).join("\n")`, restoring a
 * trailing newline when the range reaches EOF — reproduced exactly here via
 * sliceLinesToTextEntry above (including the LF join, so a CRLF file does not
 * read as stale).
 *
 * A cap-truncated serve (tools/readCodeModes.ts trims a slice past
 * READ_SYMBOL_CAP_BYTES and sets truncated:true) records a sha over the
 * PREFIX it actually served, so it will not match the full slice here and the
 * anchor edit refuses as stale. That is the correct outcome, not a false
 * positive: the caller never received the tail of that range, so it cannot
 * have meant to replace it wholesale.
 */
function servedScopeTextEntry(fileText: string, shaRange: string | undefined): string {
  if (shaRange === undefined) return fileText;
  const parsed = parseRangeEntry(shaRange);
  if (!parsed) return fileText;
  return sliceLinesToTextEntry(fileText, parsed.start, parsed.end);
}

function countLogicalLinesEntry(text: string): number {
  if (text.length === 0) return 0;
  const normalized = toLfEntry(text);
  const trimmed = normalized.endsWith("\n") ? normalized.slice(0, -1) : normalized;
  if (trimmed.length === 0) return 0;
  return trimmed.split("\n").length;
}

/**
 * Resolve the realpath of an existing file and verify it stays within workspaceReal.
 * Returns the real path if safe, or null if it escapes the workspace.
 */
function safeRealpathSyncExisting(absPath: string, workspaceReal: string): string | null {
  try {
    const real = fs.realpathSync(absPath);
    if (real === workspaceReal || real.startsWith(workspaceReal + path.sep)) {
      return real;
    }
    return null;
  } catch {
    return null;
  }
}

/** 5 MB per-file cap. */
const MAX_FILE_BYTES = 5 * 1024 * 1024;

export interface EditEntry {
  path: string;
  search: string;
  replace: string;
  /**
   * A7: optional line range (resolved server-side from a handle). When
   * present, scopes the operation to this range instead of the whole file:
   *   - `content` set, `search` empty: range-content replacement.
   *   - `search` set: range-scoped replace-all within the range.
   * When absent, behaves exactly as before (whole-file exact search/replace,
   * search must occur exactly once).
   */
  range?: string;
  /** A7: range-content replacement payload (paired with `range`). */
  content?: string;
  /** Require this search to resolve to exactly one match in its current scope. */
  uniqueMatch?: boolean;
  /**
   * ANCHOR EDITS: sha recorded for the content the addressing handle served,
   * set by server.ts ONLY for an item that supplied its own explicit `range`
   * (the `{handle, range, content}` anchor shape). An anchor edit names lines
   * by NUMBER instead of restating the served bytes in `search`, so unlike
   * every other shape here it carries no proof that the caller's coordinates
   * still describe the file — this sha IS that proof, checked against the
   * pre-batch on-disk bytes before anything is written.
   *
   * Deliberately NOT set for the pre-existing `{handle, content}` shapes
   * (range handle, or kind:"file" whole-file body): those resolve their span
   * from the handle itself and have always been allowed to run against a file
   * the same handle already edited — see editFileKindFileHandle.spec.ts
   * ("the SAME kind:\"file\" handle can be reused for a second batch
   * whole-file replace", and the merged-same-path range-then-whole-file case),
   * both of which would become false stale-refusals under a blanket CAS.
   */
  anchorSha?: string;
  /**
   * Range the `anchorSha` covers, when the addressing handle served a SLICE
   * (kind:"range"/"symbol": sha is over
   * `content.split(/\r?\n/).slice(start-1,end).join("\n")` — see
   * tools/readCodeModes.ts resolveSlice). Omitted when the handle served the
   * WHOLE file (kind:"file": sha is over the raw file text), in which case the
   * check is a whole-file comparison.
   */
  anchorShaRange?: string;
  /**
   * F-V13-2 (2026-08-30): this item CREATES a new file at `path` instead of
   * editing an existing one — `content` (already declared above) is the
   * body to write, verbatim, no search/replace/range involved. Mutually
   * exclusive with every other shape this interface carries: a `create`
   * item must be the ONLY entry for its `path` in the batch (server.ts
   * refuses a same-path create+edit mix before this module ever sees it —
   * see the "batch create v1 scope" comment on its edits[] pre-pass).
   * Validated and published through the SAME no-replace primitives the
   * single edit_file `create:true` path uses (tools/createFileCore.ts), so
   * the two paths cannot drift apart on the CWE-59/CWE-367 no-replace
   * guarantee or the lstat-based "something already occupies this name"
   * check.
   */
  create?: boolean;
}

export interface ApplyEditsMultiInput {
  edits: EditEntry[];
}

export interface EditFileResult {
  path: string;
  /**
   * Edited SPAN, e.g. "12-15". Omitted for a create entry (`total_lines`
   * below instead) — a create has no "edited span", the whole file is new.
   * This is the SAME asymmetry the single edit_file `create:true` path's own
   * response already carries (server.ts's create dispatch reports
   * `total_lines`, never `lines`), read by both server.ts's
   * attachAppliedReadback (per-entry `typeof f.lines === "string"` decides
   * whether to echo a code slice — a create's body was already sent by the
   * caller in THIS call, so echoing it back would double the bytes for no
   * reason) and protocol/editFamily.ts's editedRows/appliedEntries, with NO
   * changes needed in either: they already special-case "lines absent,
   * total_lines a number" for the single-create response shape, and read
   * per-FILE from this same array either way.
   */
  lines?: string;
  /** Create entry's whole-file line count — see `lines`'s doc comment. */
  total_lines?: number;
  delta: string;
  /**
   * DESIGN-v0.8 B3.1: a per-file handle (kind:"file", POST-edit sha) minted
   * after this file was successfully written, so a follow-up edit in the
   * SAME turn's response has something to adopt — previously this batch
   * result carried NO handles at all, so a multi-file edits[] call left
   * every touched file handle-less until a separate read_code round trip
   * minted one. ~8 tokens/file (a short id + short sha string).
   */
  handle: string;
}

/**
 * One row of the mid-batch rollback ledger (CWE-755, strategy §6.6).
 *
 * Field names and the `state` vocabulary are lifted verbatim from the C2
 * staged-transaction ledger (core2/edit.ts's `rollback[]`) so an agent learns
 * ONE contract across both edit paths. The sha VALUES use this path's own
 * response idiom (`shortSha(shaOfText(...))` -> `sha256:<12 hex>`), matching
 * the `current_sha`/`served_sha` this same error union already emits, and
 * round-trippable straight back as an `expectedSha` precondition.
 */
export interface RollbackFileState {
  path: string;
  /**
   * F-V13-2 (2026-08-30): `"removed"` / `"remove-failed"` are the DELETION
   * counterparts of `"rolled-back"` / `"restore-failed"`, for a batch item
   * that CREATED a new file — rolling that back means the file must not
   * exist any more, not that it gets "restored" to some prior content (it
   * had none). Using `"rolled-back"` with a fabricated empty-string
   * `expected_sha` would have been a lie in both directions: the file is
   * still ON DISK (not reverted) and there is no meaningful "expected
   * content" to name. See `expected_sha`'s doc comment below.
   */
  state: "rolled-back" | "restore-failed" | "removed" | "remove-failed";
  /**
   * PRE-edit bytes the restore was trying to put back. `restore-failed`
   * only. Deliberately OMITTED on `"removed"`/`"remove-failed"`: the
   * "expected" state there is ABSENCE, which has no hash — the field's
   * absence on those two states IS the "should not exist" signal, the same
   * omit-rather-than-fabricate convention this whole union already follows
   * (`stuck_sha` omitted when unreadable, `detail` capped rather than
   * guessed).
   */
  expected_sha?: string;
  /** What is actually on disk NOW; omitted when the file could not be read. */
  stuck_sha?: string;
  /** Why the restore/remove failed (capped, mirrors this file's 160-char preview cap). */
  detail?: string;
}

/**
 * Build one `restore-failed` ledger row, reading back whatever is stuck on
 * disk so the caller can tell "still pre-edit" from "still post-edit" from
 * "gone" without a follow-up read.
 */
export function restoreFailedLedgerEntry(
  rel: string,
  abs: string,
  originalContent: string,
  err: unknown,
): RollbackFileState {
  let stuckSha: string | undefined;
  try {
    stuckSha = shortSha(shaOfText(fs.readFileSync(abs, "utf8")));
  } catch {
    // Unreadable or gone — the ledger says so by omitting stuck_sha rather
    // than by guessing; that omission is itself the signal to go look.
    stuckSha = undefined;
  }
  return {
    path: rel,
    state: "restore-failed",
    expected_sha: shortSha(shaOfText(originalContent)),
    ...(stuckSha !== undefined ? { stuck_sha: stuckSha } : {}),
    detail: (err instanceof Error ? err.message : String(err)).slice(0, 160),
  };
}

/**
 * F-V13-2 (2026-08-30): build one `remove-failed` ledger row — the deletion
 * counterpart of `restoreFailedLedgerEntry` above, for a batch item that
 * CREATED a file whose rollback (unlink) itself failed. No `originalContent`
 * parameter: unlike an edit's rollback, there is no PRE-edit content to name
 * as `expected_sha` — the expected state is absence, which `RollbackFileState
 * .expected_sha`'s doc comment says is spelled by omitting the field, not by
 * hashing an empty string.
 */
export function removeFailedLedgerEntry(
  rel: string,
  abs: string,
  err: unknown,
): RollbackFileState {
  let stuckSha: string | undefined;
  try {
    stuckSha = shortSha(shaOfText(fs.readFileSync(abs, "utf8")));
  } catch {
    stuckSha = undefined;
  }
  return {
    path: rel,
    state: "remove-failed",
    ...(stuckSha !== undefined ? { stuck_sha: stuckSha } : {}),
    detail: (err instanceof Error ? err.message : String(err)).slice(0, 160),
  };
}

/**
 * Short, concrete repair steps for a `rollback-failed` response. Deliberately
 * NOT phrased as retry guidance (that is what `hint` means elsewhere in this
 * union): after a failed rollback the batch must not be re-run until the
 * named files are back at their `expected_sha` (restore) or gone (remove).
 *
 * F-V13-2 (2026-08-30): the ORIGINAL single paragraph below is preserved
 * BYTE-IDENTICAL as `restoreHint` for a ledger with no `remove-failed` rows
 * (every ledger this function saw before this change) — no existing caller or
 * test observes a different string for that case. A ledger that ALSO (or
 * only) carries `remove-failed` rows — a created file this batch could not
 * clean up during rollback — gets an ADDITIONAL sentence, never a rewrite of
 * the restore guidance.
 */
export function rollbackRecoveryHint(ledger: RollbackFileState[]): string {
  const stuck = ledger.filter((row) => row.state === "restore-failed").map((row) => row.path);
  const stuckRemove = ledger.filter((row) => row.state === "remove-failed").map((row) => row.path);

  const restoreHint = stuck.length === 0 ? undefined : (() => {
    const shown = stuck.slice(0, 4);
    const more = stuck.length - shown.length;
    return (
      `inspect ${shown.join(", ")}${more > 0 ? ` (+${more} more)` : ""}: each still holds POST-edit bytes ` +
      `(stuck_sha) instead of expected_sha. This batch wrote no checkpoint (checkpoints are taken only ` +
      `after a fully successful batch) - restore each file from version control or the previous ` +
      `edit_file checkpoint, confirm it hashes to expected_sha, then re-run the batch.`
    );
  })();

  const removeHint = stuckRemove.length === 0 ? undefined : (() => {
    const shown = stuckRemove.slice(0, 4);
    const more = stuckRemove.length - shown.length;
    const plural = stuckRemove.length !== 1;
    return (
      `this batch also created ${shown.join(", ")}${more > 0 ? ` (+${more} more)` : ""} but could not remove ` +
      `${plural ? "them" : "it"} during rollback — delete ${plural ? "them" : "it"} manually, confirm ` +
      `${plural ? "they no longer exist" : "it no longer exists"}, then re-run the batch.`
    );
  })();

  return [restoreHint, removeHint].filter((s): s is string => s !== undefined).join(" ");
}

export type ApplyEditsMultiResult =
  | {
      ok: true;
      files: EditFileResult[];
      checkpoint: string | null;
      /**
       * Rels that had 2+ edits[] entries auto-merged into one per-file
       * sequence, in first-occurrence order. Present only when non-empty —
       * a compact learning signal so a caller that sent duplicate paths
       * (previously a hard refusal) sees its batch succeeded and why.
       */
      merged_paths?: string[];
      /**
       * Rels where at least one edit in the batch was applied only after
       * unescaping a literal `\n`/`\t`/`\r` the caller sent in its search
       * string (and, only on shared-escape-class evidence, its replace).
       * Present only when non-empty.
       */
      normalized_escapes?: string[];
      /** Paths recovered from unique leading/trailing whitespace drift. */
      normalized_whitespace?: string[];
    }
  | ({
      ok: false;
      error: string;
      code: string;
      path?: string;
      hint?: string;
      /**
       * Machine-readable refusal tag for the shapes an agent is expected to
       * BRANCH on rather than read prose for. Additive alongside `code`, which
       * keeps its historical value for every pre-existing refusal (e.g. an
       * out-of-bounds range stays `code:"invalid-input"` while gaining
       * `reason:"range-out-of-bounds"`), so nothing that matched on `code`
       * changes meaning.
       */
      reason?: string;
      /** Anchor CAS: sha of the served scope as it stands on disk NOW. */
      current_sha?: string;
      /** Anchor CAS: sha the addressing handle recorded when it was served. */
      served_sha?: string;
      /** Out-of-bounds: logical line count of the file as it stands now. */
      file_line_count?: number;
      /** Zero-based caller edits[] item that failed during atomic validation. */
      failed_item?: {
        index: number;
        path: string;
        range?: string;
        search_preview?: string;
      };
      /**
       * CWE-755 (strategy §6.6): emitted ONLY with code "rollback-failed" --
       * the primary write failed AND the rollback could not restore every
       * already-written file, so the tree matches neither the pre-edit nor
       * the post-edit state. A fully successful rollback still returns the
       * plain `write-error` shape with none of these three fields.
       */
      workspace_state?: "workspace-state-unknown";
      /** Per-file restoration ledger: what was put back, what is stuck. */
      rollback?: RollbackFileState[];
      /** Repair steps -- NOT retry guidance; see rollbackRecoveryHint. */
      recovery?: string;
    } & NearestMatchInfo);

/**
 * Apply a batch of search/replace edits to multiple files, all-or-nothing.
 *
 * @param input      - Tool input arguments.
 * @param workspace  - Absolute workspace root.
 * @param allowWrite - Write-enable flag.
 * @param sessionId  - Session identifier for checkpoint commit message.
 */
export async function applyEditsMulti(
  input: ApplyEditsMultiInput,
  workspace: GuardedWorkspaceRoot,
  allowWrite: boolean,
  sessionId: string
): Promise<ApplyEditsMultiResult> {
  if (!allowWrite) {
    return {
      ok: false,
      error: "Write tools are disabled. Restart the server with --allow-write.",
      code: "write-not-enabled",
    };
  }

  const { edits } = input;

  if (!Array.isArray(edits) || edits.length === 0) {
    return { ok: false, error: "edits array is required and must be non-empty", code: "invalid-input" };
  }

  // Group edits targeting the same path into one per-file transaction while
  // preserving the caller's path order. Plain search/replace chains retain
  // caller order because later searches may depend on earlier output. Groups
  // made entirely from range handles are normalized separately below: exact
  // same-range chains retain order, while distinct non-overlapping ranges run
  // bottom-to-top against their shared pre-edit coordinate system.
  const pathGroups = new Map<string, EditEntry[]>();
  const orderedRels: string[] = [];
  for (const edit of edits) {
    const rel = edit.path;
    let group = pathGroups.get(rel);
    if (!group) {
      group = [];
      pathGroups.set(rel, group);
      orderedRels.push(rel);
    }
    group.push(edit);
  }
  const mergedPaths = orderedRels.filter((rel) => pathGroups.get(rel)!.length > 1);

  const resolvedWorkspace = path.resolve(workspace);

  // Compute the real (symlink-resolved) workspace root once.
  let workspaceReal: string;
  try {
    workspaceReal = fs.realpathSync(resolvedWorkspace);
  } catch {
    workspaceReal = resolvedWorkspace;
  }

  // Phase 1: Pre-validate ALL edits. Build (absPath, newContent) pairs — one
  // per DISTINCT path (a merged group folds to a single prepared entry).
  interface PreparedEdit {
    rel: string;
    abs: string;
    newContent: string;
    existingContent: string;
    mode: number | undefined;
    lines: string;
    delta: string;
    /** F-V13-2: this item CREATES `rel` rather than editing it. */
    isCreate?: boolean;
    /** F-V13-2: whole-file line count, create entries only — see EditFileResult.lines. */
    totalLines?: number;
  }
  const prepared: PreparedEdit[] = [];
  /** Rels where at least one edit needed literal-backslash-escape recovery. */
  const normalizedEscapePaths: string[] = [];
  /** Rels where a unique full-line block recovered across indentation drift. */
  const normalizedWhitespacePaths: string[] = [];

  /** Result of applying ONE edit entry against `currentText` (whatever text is
   * "current" for this path at this point in its merge chain — the original
   * disk read for the first edit, or the previous edit's output for a
   * subsequent one in the same group). */
  type StepResult =
    | { ok: true; newText: string; lines: string; added: number; removed: number; normalizedEscapes?: true; normalizedWhitespace?: true }
    | ({ ok: false; error: string; code: string; hint?: string; reason?: string; file_line_count?: number } & NearestMatchInfo);

  function applyEditStep(currentText: string, edit: EditEntry): StepResult {
    // 2026-08-01 blast-radius precondition (write/blastRadius.ts): an edits[]
    // batch structurally cannot carry precondition:"expected-hash" (server.ts
    // refuses that combination up front), so a whole-file-scale single hunk
    // is refused toward the single-call acknowledged form. All-or-nothing:
    // Phase 1 returns before any write, like every validation guard here.
    // currentText is the pre-step text, so the hinted expectedSha is only
    // valid verbatim for a first/solo step — exactly the shape being
    // redirected to a single call anyway.
    const blastStepRefusal = (blast: BlastRadiusMeasure): StepResult => ({
      ok: false,
      error: `this single hunk replaces ${blast.replacedLines} of the file's ${blast.fileLines} lines (${blast.replacedPercent}%) and would leave ${blast.resultingLines} lines — a whole-file-scale replacement must be explicitly acknowledged`,
      code: "blast-radius-precondition-required",
      hint: `issue this hunk as its own single edit_file call {handle, content, precondition:"expected-hash", expectedSha:${shortSha(shaOfText(currentText))}}, or narrow the range to the lines that actually change`,
    });
    // P0 (2026-07-12a2 forensics): defense-in-depth mirror of server.ts's
    // dispatch-level search+content guard. server.ts's edits[] entry
    // resolution should already refuse this shape before an EditEntry ever
    // reaches here, but this function is also exercised directly (see
    // applyEditsMulti.spec.ts), so the same silent-drop hole is guarded
    // here too: `content` is only ever read below when `edit.search === ""`
    // (the {handle, content} range-replacement branch a few lines down, and
    // — as of the 2026-07-12c whole-file-batch fix — the whole-file branch further
    // below too, which treats search==="" + content as a whole-file
    // replacement) — any NON-empty search paired with content would otherwise
    // ignore content and fall through to a search/replace branch, same bug
    // as server.ts's. (`replace` has no analogous guard here: EditEntry.replace
    // is a required string at this layer — server.ts already collapsed
    // "replace omitted" to "" before construction, so that distinction only
    // exists at the raw-args layer server.ts validates.)
    if (edit.search !== "" && edit.content !== undefined) {
      return {
        ok: false,
        error: "content is for create:true or handle+content range replacement; for search-based edits use replace — did you mean replace?",
        code: "invalid-input",
      };
    }
    if (edit.range !== undefined) {
      const range = parseRangeEntry(edit.range);
      if (!range) {
        return { ok: false, error: `invalid range: ${edit.range}`, code: "invalid-input" };
      }

      const lineEnding = detectLineEndingEntry(currentText);
      const normalized = toLfEntry(currentText);
      const totalLines = countLogicalLinesEntry(normalized);
      if (range.start > totalLines || range.end > totalLines) {
        // `code`/`error` are byte-identical to the historical refusal (callers
        // and rangeEdit.ts's own bounds tests match on them); `reason`,
        // `file_line_count` and the current file head are additive so an
        // ANCHOR edit — which has no served bytes in its args to diff against —
        // can re-anchor from this response instead of re-reading the file.
        return {
          ok: false,
          error: `range ${edit.range} is out of bounds (file has ${totalLines} lines)`,
          code: "invalid-input",
          reason: "range-out-of-bounds",
          file_line_count: totalLines,
          ...fileHeadForensics(normalized),
        };
      }
      const startIndex = lineStartIndexEntry(normalized, range.start);
      const endIndex = lineEndWithNewlineIndexEntry(normalized, range.end);

      // AUDIT (argument-combination matrix, 2026-07-12): defense-in-depth
      // mirror of server.ts's edits[] mapping-loop guard for the identical
      // shape (this function is also exercised directly — see
      // applyEditsMulti.spec.ts). A range-scoped entry with search==="" is
      // ALWAYS treated as the {content} range-replacement shape two lines
      // below, which reads `edit.content ?? ""` — so an entry that reaches
      // here with search==="" and content STILL undefined (server.ts's own
      // guard should already have refused this, but a caller of this
      // function directly could bypass it) would silently wipe the range to
      // empty, discarding `replace` if the caller set it instead of
      // `content`. Refuse instead of guessing.
      if (edit.search === "" && edit.content === undefined) {
        return {
          ok: false,
          error: 'a range-scoped edit needs either content (range replacement) or a non-empty search (range-scoped replace-all) — got neither; did you mean content:"..."?',
          code: "invalid-input",
        };
      }

      if (edit.search === "") {
        // Range-content replacement: {handle, content}.
        const replacement = toLfEntry(edit.content ?? "");
        const blast = measureBlastRadius({
          fileText: normalized,
          spanStart: range.start,
          spanEnd: range.end,
          replacementText: replacement,
        });
        if (blast !== null) return blastStepRefusal(blast);
        const next = normalized.slice(0, startIndex) + replacement + normalized.slice(endIndex);
        const restored = restoreLineEndingEntry(next, lineEnding);
        const added = countLogicalLinesEntry(replacement);
        const removed = range.end - range.start + 1;
        return {
          ok: true,
          newText: restored,
          lines: formatLines(range.start, Math.max(range.start, range.start + Math.max(added, 1) - 1)),
          added,
          removed,
        };
      }

      // Range-scoped replace-all: {handle, search, replace}.
      const segment = normalized.slice(startIndex, endIndex);
      let rangeSearch = toLfEntry(edit.search);
      let rangeReplace = toLfEntry(edit.replace);
      let rangeNormalizedEscapes: true | undefined;
      let rangeNormalizedWhitespace: true | undefined;
      if (!segment.includes(rangeSearch)) {
        // Same literal-backslash-escape recovery as the whole-file path
        // below (write/textEdit.ts applySingleEdit) — an agent that
        // double-escapes search/replace hits this range-scoped branch just
        // as often as the whole-file one. This branch is replace-ALL (no
        // uniqueness requirement), which is exactly why recovery must be
        // pickier here than the whole-file path's exactly-once rule: a
        // search like `\n`/`\t`/`\r\n` unescapes to a whitespace-only
        // needle that occurs at EVERY line break/tab in the range, and
        // replace-all-ing it silently rewrites the whole segment (a 4-line
        // range collapses to one line). Recovery therefore requires a
        // needle with at least one non-whitespace character; whitespace-only
        // needles refuse with a hint instead. The replace side is unescaped
        // only on shared-escape-class evidence — see sharesLiteralEscapeClass
        // (write/textEdit.ts).
        if (hasLiteralBackslashEscape(edit.search)) {
          const unescapedRangeSearch = toLfEntry(unescapeBackslashSequences(edit.search));
          if (unescapedRangeSearch.trim() === "") {
            return {
              ok: false,
              error: "search string not found in range",
              code: "not-found",
              hint: "search unescapes to whitespace-only text (\\n/\\t/\\r), and a range-scoped replace-all would rewrite every line break/tab in the range; if you meant actual whitespace, include distinctive non-whitespace context around it",
            };
          }
          if (segment.includes(unescapedRangeSearch)) {
            rangeSearch = unescapedRangeSearch;
            if (sharesLiteralEscapeClass(edit.search, edit.replace)) {
              rangeReplace = toLfEntry(unescapeBackslashSequences(edit.replace));
            }
            rangeNormalizedEscapes = true;
          } else {
            return {
              ok: false,
              error: "search string not found in range",
              code: "not-found",
              hint: "search contained a literal backslash escape sequence (\\n/\\t/\\r); if you intended an actual newline/tab, check for double-escaping",
              // P4.2: when the anchor is absent from the SEGMENT, say where in
              // the file it actually lives instead of only showing the scope head.
              ...rangeMissForensics(normalized, segment, unescapedRangeSearch, range.start, range.end),
            };
          }
        } else {
          const indentationMatch = findUniqueIndentationEquivalent(segment, rangeSearch);
          if (indentationMatch.kind === "unique") {
            rangeSearch = indentationMatch.matched;
            rangeReplace = reindentReplacement(
              toLfEntry(edit.search),
              toLfEntry(edit.replace),
              indentationMatch.matched,
            );
            rangeNormalizedWhitespace = true;
          } else if (indentationMatch.kind === "ambiguous") {
            return {
              ok: false,
              error: "search string is indentation-equivalent to multiple full-line blocks in range — add non-whitespace context to make it unique",
              code: "ambiguous",
            };
          } else {
            return {
              ok: false,
              error: "search string not found in range",
              code: "not-found",
              // P4.2: the T13 rep1-a shape — a handle bound to 199-259 whose
              // search text actually lives at L118. The scope head alone is
              // true and useless; the relocation removes a full re-read.
              ...rangeMissForensics(normalized, segment, rangeSearch, range.start, range.end),
            };
          }
        }
      }
      if (edit.uniqueMatch) {
        let count = 0;
        let index = segment.indexOf(rangeSearch);
        while (index !== -1) {
          count++;
          index = segment.indexOf(rangeSearch, index + rangeSearch.length);
          if (count > 1) break;
        }
        if (count !== 1) {
          return {
            ok: false,
            error: count === 0
              ? "search string has no match in range"
              : "search string has multiple matches in range",
            code: "search-not-unique",
          };
        }
      }
      const replacedSegment = segment.split(rangeSearch).join(rangeReplace);
      const next = normalized.slice(0, startIndex) + replacedSegment + normalized.slice(endIndex);
      const restored = restoreLineEndingEntry(next, lineEnding);
      return {
        ok: true,
        newText: restored,
        lines: formatLines(range.start, range.end),
        added: countLogicalLinesEntry(replacedSegment),
        removed: range.end - range.start + 1,
        ...(rangeNormalizedEscapes ? { normalizedEscapes: true } : {}),
        ...(rangeNormalizedWhitespace ? { normalizedWhitespace: true } : {}),
      };
    }

    // Whole-file exact search/replace (original v0.2 behavior).
    if (edit.search === "") {
      if (edit.content !== undefined) {
        // FIX A-BATCH (2026-07-12c forensics): whole-file content
        // replacement — {handle (kind:"file", no range), content}, assembled
        // by server.ts's edits[] mapping loop as {search:"", replace:"",
        // content} with NO `range`. Mirrors the range-content-replacement
        // branch above (search==="" + content means "replace this span"),
        // but the span is the WHOLE of currentText — computed HERE, against
        // whatever is "current" for this path at THIS point in its merge
        // chain (a fresh per-path disk read for the first edit, or the
        // prior edit's output for a subsequent one in the same group), at
        // the moment this step actually executes — not a range synthesized
        // ahead of time by server.ts, which could go stale by execution
        // time if an earlier edit in a merged group already shifted the
        // file's line count. No bounds check is needed (unlike the range
        // branch above): replacing the entire current text can never be
        // "out of bounds" against itself.
        const lineEnding = detectLineEndingEntry(currentText);
        const normalized = toLfEntry(currentText);
        const totalLines = countLogicalLinesEntry(normalized);
        const replacement = toLfEntry(edit.content);
        // 2026-08-01: the {kind:"file" handle, content} whole-file batch item
        // — same single-call redirect as the range-content branch above.
        const wholeFileBlast = measureBlastRadius({
          fileText: normalized,
          spanStart: 1,
          spanEnd: totalLines,
          replacementText: replacement,
        });
        if (wholeFileBlast !== null) return blastStepRefusal(wholeFileBlast);
        const restored = restoreLineEndingEntry(replacement, lineEnding);
        const added = countLogicalLinesEntry(replacement);
        return {
          ok: true,
          newText: restored,
          lines: formatLines(1, Math.max(1, added)),
          added,
          removed: totalLines,
        };
      }
      return {
        ok: false,
        error: "search string is empty — edits[] items cannot create files; use a separate edit_file call with create:true (content=... or from=...)",
        code: "empty-search",
      };
    }

    const editResult = applySingleEdit(currentText, edit.search, edit.replace);
    if (!editResult.ok) {
      return {
        ok: false,
        error: editResult.error ?? "edit validation failed",
        code: edit.uniqueMatch ? "search-not-unique" : editResult.code ?? "edit-error",
        ...(editResult.hint ? { hint: editResult.hint } : {}),
        ...(editResult.code === "not-found"
          ? nearestMatchForensics(currentText, edit.search, 1)
          : {}),
      };
    }

    // B-2: when applySingleEdit recovered via literal-backslash unescaping or
    // safe indentation equivalence, computeLineDelta must use the strings that
    // ACTUALLY touched the file. The caller's raw search is absent from
    // currentText, so using it would silently default to startLine=1.
    const ld = editResult.normalizedEscapes || editResult.normalizedWhitespace
      ? computeLineDelta(currentText, editResult.usedSearch!, editResult.usedReplace!)
      : computeLineDelta(currentText, edit.search, edit.replace);
    return {
      ok: true,
      newText: editResult.text!,
      lines: formatLines(ld.startLine, ld.endLine),
      added: ld.added,
      removed: ld.removed,
      ...(editResult.normalizedEscapes ? { normalizedEscapes: true } : {}),
      ...(editResult.normalizedWhitespace ? { normalizedWhitespace: true } : {}),
    };
  }

  for (const rel of orderedRels) {
    const group = pathGroups.get(rel)!;

    if (!rel) {
      // P4.1 (direct-invocation path — this function is also exercised
      // standalone by applyEditsMulti.spec.ts, bypassing server.ts's richer
      // targetless pre-pass). Name WHICH entry had no target instead of only
      // echoing an empty path.
      const failedIndex = edits.findIndex((entry) => (entry.path ?? "") === "");
      return {
        ok: false,
        error: "path is required",
        code: "invalid-input",
        path: rel,
        ...(failedIndex >= 0 ? { failed_item: { index: failedIndex, path: rel } } : {}),
      };
    }

    if (looksLikeSecretFile(rel)) {
      return { ok: false, error: `Refusing to write to secret/credential file: ${rel}`, code: "secret-file", path: rel };
    }

    // F-V13-2 (2026-08-30): a create:true item never targets an EXISTING
    // file, so none of the "read what's currently there" machinery below
    // (fs.statSync, the anchor-edit CAS, range clustering, applyEditStep)
    // applies to it — diverted to its own branch that validates + prepares
    // the write the SAME way tools/createFile.ts's single-item create path
    // does (tools/createFileCore.ts, shared so the two cannot drift).
    // server.ts's edits[] pre-pass already refuses a create mixed with
    // another item on this SAME path (v1 scope — see its own "batch create
    // v1 scope" comment), so `group.length` here should already be 1; still
    // defended here too since this function is also exercised directly by
    // applyEditsMulti.spec.ts, bypassing that pre-pass.
    const hasCreate = group.some((e) => e.create === true);
    if (hasCreate) {
      if (group.length > 1) {
        return {
          ok: false,
          error: `cannot combine create with another edits[] item on the same path (${rel}) — issue the create as the only edits[] entry for this path, or edit it in a follow-up batch`,
          code: "invalid-input",
          reason: "batch-create-conflict",
          path: rel,
        };
      }
      const createEntry = group[0]!;
      const validation = validateCreateTarget(rel, workspace);
      if (!validation.ok) {
        return {
          ok: false,
          error: validation.error === "file_exists"
            ? `File already exists: ${rel} — edits[] create items never overwrite an existing file; edit it instead`
            : (validation.message ?? `Cannot create ${rel}: ${validation.error}`),
          code: validation.error === "file_exists" ? "file-exists" : "invalid-input",
          path: rel,
        };
      }
      const createBody = createEntry.content ?? "";
      const bodyLines = countLogicalLinesEntry(createBody);
      prepared.push({
        rel,
        abs: validation.absPath,
        newContent: createBody,
        existingContent: "",
        mode: undefined,
        lines: formatLines(1, Math.max(1, bodyLines)),
        delta: formatDelta(bodyLines, 0),
        isCreate: true,
        totalLines: bodyLines,
      });
      continue;
    }

    const abs = path.resolve(workspace, rel);
    if (!abs.startsWith(resolvedWorkspace + path.sep) && abs !== resolvedWorkspace) {
      return { ok: false, error: "path escapes workspace root", code: "path-escape", path: rel };
    }

    // Read the file ONCE per distinct path, even when merged edits target it.
    let existingContent: string;
    let existingMode: number | undefined;
    try {
      const stat = fs.statSync(abs);
      if (stat.size > MAX_FILE_BYTES) {
        return { ok: false, error: `File exceeds 5 MB limit (${stat.size} bytes)`, code: "file-too-large", path: rel };
      }
      // 2026-08-27 (write-path fail-closed guard): sniff BEFORE trusting a
      // plain UTF-8 decode — see util/textDecode.ts's doc comment. All-or-
      // nothing: this is Phase 1 validation, so no file has been written yet.
      const buf = fs.readFileSync(abs);
      const encodingRisk = detectWriteEncodingRisk(buf);
      if (encodingRisk) {
        return { ok: false, error: writeEncodingRefusalMessage(rel, encodingRisk), code: "unsupported-encoding", path: rel };
      }
      existingContent = buf.toString("utf8");
      existingMode = stat.mode;
    } catch (err) {
      const errCode = (err as NodeJS.ErrnoException).code;
      return {
        ok: false,
        error: errCode === "ENOENT" ? `File not found: ${rel}` : `Cannot read file: ${(err as Error).message}`,
        code: errCode === "ENOENT" ? "not-found" : "read-error",
        path: rel,
      };
    }

    // Realpath escape check — defend against symlinks pointing outside workspace.
    if (safeRealpathSyncExisting(abs, workspaceReal) === null) {
      return { ok: false, error: "path escapes workspace root (symlink)", code: "path-escape", path: rel };
    }

    // ANCHOR-EDIT CAS. An anchor item ({handle, range, content}) names its
    // target by LINE NUMBER instead of restating the served bytes in `search`,
    // which is the whole point — a long verbatim search duplicates bytes the
    // server already served — but it also removes search/replace's implicit
    // proof that the caller's coordinates still describe the file. This check
    // is that proof: refuse the WHOLE batch, before Phase 2 writes anything,
    // when the content the addressing handle served is no longer what is on
    // disk. Matches the existing all-or-nothing validation contract exactly
    // (see the "all-or-nothing on validation failure" tests) — Phase 1 returns
    // on first failure and Phase 2 has not run, so no file is touched.
    //
    // Compared against existingContent — the PRE-batch on-disk bytes, read
    // once above — NOT the running currentText: every handle in this batch was
    // served against that same snapshot, so an earlier edit in a merged group
    // must not make a later sibling's handle look stale.
    for (const edit of group) {
      if (edit.anchorSha === undefined) continue;
      const currentSha = shaOfText(servedScopeTextEntry(existingContent, edit.anchorShaRange));
      if (currentSha === edit.anchorSha) continue;
      const anchorRange = parseRangeEntry(edit.range ?? "");
      return {
        ok: false,
        error:
          "served content is stale — this file changed after the handle was served, so the anchored line range may no longer be the text you meant to replace",
        code: "served-content-stale",
        reason: "served-content-stale",
        path: rel,
        current_sha: shortSha(currentSha),
        served_sha: shortSha(edit.anchorSha),
        hint: "re-anchor from nearest_match (the CURRENT bytes at your range) and retry in ONE call — no re-read needed",
        failed_item: {
          index: edits.indexOf(edit),
          path: rel,
          ...(edit.range !== undefined ? { range: edit.range } : {}),
        },
        ...(anchorRange
          ? refreshedRangeSlice(existingContent, anchorRange.start, anchorRange.end)
          : {}),
      };
    }

    // Plain search/replace chains preserve caller order because later edits
    // may intentionally depend on earlier output. A group made entirely from
    // range handles has different semantics: every range was minted against
    // the same pre-edit snapshot. Apply distinct ranges from bottom to top so
    // line-count changes cannot stale the coordinates of ranges above them.
    // Repeated edits on the exact same range remain caller-ordered and widen or
    // shrink that range by the preceding step's line delta. Partially
    // overlapping distinct ranges are ambiguous and refuse before any write.
    const rangeOnlyGroup = group.length > 1 && group.every((edit) => edit.range !== undefined);
    type RangeCluster = { start: number; end: number; edits: EditEntry[] };
    let executionClusters: RangeCluster[];

    if (rangeOnlyGroup) {
      const clustersByRange = new Map<string, RangeCluster>();
      for (const edit of group) {
        const parsed = parseRangeEntry(edit.range!);
        if (!parsed) {
          return { ok: false, error: `invalid range: ${edit.range}`, code: "invalid-input", path: rel };
        }
        const key = `${parsed.start}-${parsed.end}`;
        const existing = clustersByRange.get(key);
        if (existing) existing.edits.push(edit);
        else clustersByRange.set(key, { ...parsed, edits: [edit] });
      }

      const ascending = [...clustersByRange.values()].sort((a, b) => a.start - b.start || a.end - b.end);
      for (let index = 1; index < ascending.length; index++) {
        const previous = ascending[index - 1]!;
        const current = ascending[index]!;
        if (current.start <= previous.end) {
          return {
            ok: false,
            error: `range handles overlap (${previous.start}-${previous.end} and ${current.start}-${current.end})`,
            code: "overlapping-ranges",
            path: rel,
            hint: "re-read one non-overlapping range, or apply the overlapping edits sequentially through one handle",
          };
        }
      }
      executionClusters = ascending.sort((a, b) => b.start - a.start);
    } else {
      executionClusters = [{ start: 0, end: 0, edits: group }];
    }

    let currentText = existingContent;
    let lastLines = "";
    let totalAdded = 0;
    let totalRemoved = 0;
    let pathNormalizedEscapes = false;
    let pathNormalizedWhitespace = false;
    for (const cluster of executionClusters) {
      let clusterLineDelta = 0;
      for (const edit of cluster.edits) {
        const effectiveEdit = rangeOnlyGroup
          ? { ...edit, range: `${cluster.start}-${cluster.end + clusterLineDelta}` }
          : edit;
        const step = applyEditStep(currentText, effectiveEdit);
        if (!step.ok) {
          const rangeHint = rangeOnlyGroup
            ? `original range ${edit.range}; effective range ${effectiveEdit.range}`
            : undefined;
          const failedIndex = edits.indexOf(edit);
          return {
            ok: false,
            error: step.error,
            code: step.code,
            path: rel,
            failed_item: {
              index: failedIndex,
              path: rel,
              ...(edit.range !== undefined ? { range: edit.range } : {}),
              ...(edit.search !== "" ? { search_preview: edit.search.slice(0, 160) } : {}),
            },
            ...(step.hint ? { hint: step.hint } : rangeHint ? { hint: rangeHint } : {}),
            // Forensics fields (2026-07-26 T09 R2) survive the step→result lift.
            ...(step.nearest_match ? { nearest_match: step.nearest_match } : {}),
            ...(step.actual ? { actual: step.actual } : {}),
            ...(step.reason !== undefined ? { reason: step.reason } : {}),
            ...(step.file_line_count !== undefined ? { file_line_count: step.file_line_count } : {}),
          };
        }
        currentText = step.newText;
        lastLines = step.lines;
        totalAdded += step.added;
        totalRemoved += step.removed;
        if (rangeOnlyGroup) clusterLineDelta += step.added - step.removed;
        if (step.normalizedEscapes) pathNormalizedEscapes = true;
        if (step.normalizedWhitespace) pathNormalizedWhitespace = true;
      }
    }
    if (pathNormalizedEscapes) normalizedEscapePaths.push(rel);
    if (pathNormalizedWhitespace) normalizedWhitespacePaths.push(rel);

    prepared.push({
      rel,
      abs,
      newContent: currentText,
      existingContent,
      mode: existingMode,
      // A merged chain reports the FINAL edit's line range (where the file
      // ended up, directly re-readable) and the SUMMED added/removed across
      // the whole chain (coordinate-system-independent, unlike naively
      // min/maxing per-step ranges that were each computed against a
      // different intermediate text). A single-edit group's summary is
      // identical to the pre-merge per-edit lines/delta.
      lines: lastLines,
      delta: formatDelta(totalAdded, totalRemoved),
    });
  }

  // Phase 2: Write all files atomically. Track what was written for rollback.
  const writtenFiles: string[] = [];
  // `rel` rides along so a rollback failure can name the file the way the
  // caller addressed it, without re-deriving it from the absolute path.
  // `wasCreate` (F-V13-2): this path had NO pre-batch content — its rollback
  // is a delete, not a restore. `content`/`mode` are unused placeholders on a
  // create row (there is nothing to restore them TO).
  const originalContents = new Map<string, { content: string; mode: number | undefined; rel: string; wasCreate: boolean }>();

  for (const item of prepared) {
    originalContents.set(item.abs, { content: item.existingContent, mode: item.mode, rel: item.rel, wasCreate: item.isCreate === true });

    try {
      if (item.isCreate) {
        // F-V13-2: publish through the SAME no-replace primitive
        // tools/createFile.ts's single-item create path uses (never
        // writeExistingFileAtomic, whose rename-based publish is an
        // OVERWRITE primitive — wrong contract for "this name must be new").
        // A race that let something occupy `item.abs` between Phase 1's
        // validateCreateTarget and this call surfaces as `publish.ok===false`
        // here — thrown so it joins the SAME catch-driven rollback flow as
        // every other Phase 2 write failure below.
        const publish = publishNewFile(item.abs, item.newContent);
        if (!publish.ok) {
          throw new Error(
            publish.error === "file_exists"
              ? `File already exists: ${item.rel}`
              : (publish.message ?? `Cannot create file: ${item.rel}`),
          );
        }
        // Best-effort, mirrors createFile.ts: a brand-new path can make the
        // workspace's memoized manifest stale (it certifies "nothing
        // changed" via a whole-directory fingerprint this new file would be
        // absent from) — never fails a write that already landed on disk.
        try { invalidateCachedWorkspaceFiles(workspace, [item.rel]); } catch { /* best-effort */ }
      } else {
        // Mode preservation: see writeExistingFileAtomic's doc comment
        // (2026-08-07 chmod-reset incident) — covers both this primary write
        // and the mid-batch rollback restore below.
        writeExistingFileAtomic(item.abs, item.newContent, item.mode, { root: workspace, relPath: item.rel });
      }
      writtenFiles.push(item.rel);
    } catch (err) {
      // Write failed mid-batch — roll back the files already written.
      //
      // CWE-755 (strategy §6.6): the rollback restore used to sit inside a
      // bare `catch {}`, so a rollback that ITSELF failed was reported as a
      // plain `write-error` — the caller was told "nothing happened" about a
      // tree that now matches NEITHER the pre-edit nor the post-edit state,
      // with no way to learn which files were stranded. Surface it in the
      // vocabulary the C2 staged transaction already speaks (core2/edit.ts):
      // a per-file ledger, `workspace-state-unknown`, and a distinct
      // `rollback-failed` code so an agent repairs instead of retrying.
      const rollback: RollbackFileState[] = [];
      let rollbackFailed = false;
      for (const [abs, orig] of originalContents.entries()) {
        if (abs === item.abs) continue;
        if (orig.wasCreate) {
          // F-V13-2: this path did not exist before the batch — "rolling
          // back" a create means DELETING the file it wrote, never
          // "restoring" it to an empty string (that would leave a 0-byte
          // ghost file the caller never asked for and has no reason to
          // expect). ENOENT on the unlink means it is already gone —
          // idempotently a success, not a failure.
          try {
            fs.unlinkSync(abs);
            rollback.push({ path: orig.rel, state: "removed" });
          } catch (rmErr) {
            if ((rmErr as NodeJS.ErrnoException).code === "ENOENT") {
              rollback.push({ path: orig.rel, state: "removed" });
            } else {
              rollbackFailed = true;
              rollback.push(removeFailedLedgerEntry(orig.rel, abs, rmErr));
            }
          }
          continue;
        }
        try {
          writeExistingFileAtomic(abs, orig.content, orig.mode, { root: workspace, relPath: orig.rel });
          rollback.push({ path: orig.rel, state: "rolled-back" });
        } catch (rollbackErr) {
          rollbackFailed = true;
          rollback.push(restoreFailedLedgerEntry(orig.rel, abs, orig.content, rollbackErr));
        }
      }

      const writeError = `Cannot write file: ${(err as Error).message}`;
      if (!rollbackFailed) {
        // REVIEWED CHANGE (user-adjudicated 2026-08-14): a clean rollback now
        // REPORTS ITS LEDGER, per protocol-v1 A.5.13.
        //
        // This branch used to build the full ledger and then discard it, so a
        // caller learned only "write-error" about a batch that had ALREADY
        // written N files and put them back. Byte-compatibility with the
        // pre-CWE-755 response was the stated reason; §2.4 makes it the wrong
        // trade. `edit.rolled_back` is a distinct MEMBER precisely because
        // "edits were attempted and all were reverted" is a different fact from
        // "nothing was attempted", and the ledger is what proves which one
        // happened — and which files a caller should re-check.
        //
        // The ledger is the wire's discriminant too (`protocol/envelope.ts`'s
        // `editKindOf`): its presence is what separates this member from the
        // refusal the FIRST-write failure legitimately is, where nothing was
        // written, nothing was restored, and the array is empty. Omitted rather
        // than emitted empty, per A.8 rule E-1.
        return {
          ok: false,
          error: writeError,
          code: "write-error",
          path: item.rel,
          ...(rollback.length > 0 ? { rollback } : {}),
        };
      }

      return {
        ok: false,
        error: `${writeError}. Rollback could not restore every file — manual repair needed.`,
        code: "rollback-failed",
        path: item.rel,
        workspace_state: "workspace-state-unknown",
        rollback,
        recovery: rollbackRecoveryHint(rollback),
      };
    }
  }

  // Phase 3: Shadow-git checkpoint for the successful batch.
  let checkpoint: string | null = null;
  try {
    const cpResult = batchCheckpoint(workspace, writtenFiles, sessionId);
    checkpoint = cpResult.checkpointId;
  } catch {
    checkpoint = null;
  }

  // Build compact file-level results. lines/delta were precomputed in Phase 1
  // (whole-file exact match and range-scoped items compute them differently).
  //
  // DESIGN-v0.8 B3.1: upsert a whole-file handle per edited path, keyed on
  // the POST-edit sha (item.newContent is exactly what Phase 2 wrote to
  // disk — no re-read needed). A batch-edited file's range-scoped items
  // (edit.range set) still mint a whole-FILE handle here, not a range
  // handle: the batch item's `range` was itself resolved server-side from a
  // caller-supplied handle (server.ts's edits[] pre-pass), so a fresh
  // whole-file handle is the safer "something to adopt next" default,
  // consistent with the single-edit auto-mint path (server.ts) which is
  // also always whole-file.
  //
  // WRAPPED (protocol-v1 §4.2.1, C2-5). Everything in this block runs AFTER the
  // writes committed above, and none of it touches the disk — but `shaOfText`
  // and `handleTable.upsert` can still throw (an allocation failure on a large
  // batch, an eviction-path bug), and an exception here would propagate through
  // `callTool` to the hand-rolled JSON-RPC catch and answer a COMPLETED batch
  // with a contentless -32603. That is the §4.2.1 shearing bug exactly: byte
  // pressure — or here, a bookkeeping fault — rewriting what happened to a
  // file. The degraded path keeps every field that was computed BEFORE the
  // write (path, lines, delta, all from Phase 1) and gives up only the handle,
  // whose empty string the wire projection drops per A.8 rule E-1.
  let files: EditFileResult[];
  try {
    files = prepared.map((item) => {
      const postSha = shaOfText(item.newContent);
      const hEntry = handleTable.upsert({
        kind: "file",
        path: item.rel,
        workspaceRoot: workspaceReal,
        sha: postSha,
      });
      return {
        path: item.rel,
        // F-V13-2: a create entry reports `total_lines` (whole-file count)
        // instead of `lines` (an edited SPAN) — see EditFileResult.lines's
        // doc comment for why this is the SAME asymmetry the single-edit
        // create path's response already carries, read for free by both
        // server.ts's attachAppliedReadback and protocol/editFamily.ts.
        ...(item.isCreate ? { total_lines: item.totalLines ?? 0 } : { lines: item.lines }),
        delta: item.delta,
        handle: hEntry.id,
      };
    });
  } catch {
    const written = new Set(writtenFiles);
    files = prepared
      .filter((item) => written.has(item.rel))
      .map((item) => ({
        path: item.rel,
        ...(item.isCreate ? { total_lines: item.totalLines ?? 0 } : { lines: item.lines }),
        delta: item.delta,
        handle: "",
      }));
  }

  return {
    ok: true,
    files,
    checkpoint,
    ...(mergedPaths.length > 0 ? { merged_paths: mergedPaths } : {}),
    ...(normalizedEscapePaths.length > 0 ? { normalized_escapes: normalizedEscapePaths } : {}),
    ...(normalizedWhitespacePaths.length > 0 ? { normalized_whitespace: normalizedWhitespacePaths } : {}),
  };
}
