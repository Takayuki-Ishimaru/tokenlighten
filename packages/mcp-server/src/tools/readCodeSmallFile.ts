/**
 * readCodeSmallFile.ts — v0.7 mode=small_file one-call handler.
 *
 * Returns full content + handle + sha by default for files at or below the
 * TINY threshold. Callers can request compact handle-first responses with
 * content="outline" or content="defer". Refuses large files.
 *
 * Design ref: DESIGN-v0.7-mcp-task-closure.md §"Improvement 3".
 */

import * as fs from "fs/promises";
import { statSync } from "fs";
import * as path from "path";
import { spawnSync } from "node:child_process";
import type { RefusalCode, ToolCall } from "@tokenlighten/types";
import { handleTable, shaOfText, shortSha } from "../util/handles.js";
import {
  recordReadMode,
  recordFullExpansion,
  recordTinyFullExpansion,
  recordReadPath,
} from "../state/session.js";
import { TINY_BYTES, TINY_LINES } from "../util/fullGovernor.js";
import { elideDocCommentsForDisplay } from "../util/formatCompress.js";
import { languageForPath } from "../util/languages.js";
import { safeResolve, safeRealPath, resolveReal, isWithin, checkReadTarget } from "../util/safePath.js";
import { decodeTextBuffer } from "../util/textDecode.js";
import { isWorkspaceCandidateAccepted } from "../workspace/candidates.js";
import { getFileSkeleton } from "./getFileSkeleton.js";
import { countLines } from "../util/countLines.js";
import { genericTextDiscoveryEnabled, walkCodeFiles } from "./walkRepo.js";
import { looksLikeSecretFile } from "../write/secretScan.js";
import { buildSmallFileConcernNote } from "./readCodeModes.js";

/**
 * DESIGN-v0.8 §C4 item 2: aligned with server.ts's local SMALL_FILE_BYTES
 * (mode=auto's own small-file threshold) — kept as a separate constant here
 * rather than importing it, since server.ts is the caller of this module
 * (importing the other way would be circular).
 *
 * 2026-07-16a: raised 3000 -> 8192 (== TINY_BYTES). A turn costs far more
 * than a few extra KB of content (~$0.03 / ~100k cache-read tokens vs. well
 * under $0.01), and 30/30 outline downgrades in that bench run were
 * re-fetched as content anyway — pure round-trip waste. Set equal to
 * TINY_BYTES so this no longer carves its own 3-8KB outline band out of the
 * tiny gate: every caller that reaches chooseAutoContentMode has already
 * passed TINY_BYTES/TINY_LINES, so the comparison there is always true and
 * resolves to "full".
 */
const AUTO_FULL_THRESHOLD_BYTES = 8192;

/**
 * DESIGN-v0.8 §C8: hard char cap on the skeleton embedded in a not-tiny
 * refusal. getFileSkeleton's own MAX_RESPONSE_BYTES (8192) targets a full
 * skeleton READ response, not a compact refusal payload — this refusal must
 * stay under 1KB total including the handle/next/JSON envelope, so the
 * skeleton slice gets a much smaller budget than a dedicated skeleton call
 * would (same "cap a skeleton for a compact recovery payload" pattern as
 * getSymbolWithContext.ts's NOT_FOUND_SKELETON_CHAR_CAP).
 */
const NOT_TINY_SKELETON_CHAR_CAP = 500;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface SmallFileEditHint {
  kind: "remove-duplicate-branch" | "replace-config-constant";
  range?: string;
  line?: number;
}

export type SmallFileContentMode = "full" | "outline" | "defer" | "auto";

export interface SmallFileResult {
  mode: "small_file";
  path: string;
  handle: string;
  /**
   * A.9.2 row 16 (C2-3): renamed from `contentMode` — it was the read family's
   * only camelCase wire key and v1 has one convention (A.7.0).
   */
  content_mode?: "outline" | "defer";
  sha?: string;
  content?: string;
  bytes?: number;
  lines?: number;
  outline?: string[];
  edit_hints?: SmallFileEditHint[];
  next?: string;
  /**
   * 2026-07-16a bench forensics: present only when elideDocCommentsForDisplay
   * fell back to raw (comments-kept) content because eliding this doc-only
   * file would have served nothing. See util/formatCompress.ts.
   */
  note?: string;
  /**
   * Feature 3 (2026-07-12b2): Guard 2 sibling for an outline/defer serve —
   * present when the session's concern tokens hit somewhere in this file
   * that the outline text itself doesn't surface. See
   * readCodeModes.ts's buildSmallFileConcernNote.
   */
  concern_note?: string;
}

export interface SmallFileRefusal {
  ok: false;
  /**
   * A.9.2 row 12 (C2-3): the LOCAL two-value union is DELETED, not extended.
   * v1 carries read-side stops in `ReadLimitCode` and workspace-boundary stops
   * in `PathCode`, both of which are arms of the one closed `RefusalCode`
   * (A.7.1) — a second, narrower spelling of the same vocabulary is exactly the
   * drift that let `"small-file-disabled"` (since deleted with its flag by D10)
   * be emitted from outside the declared set. `"not-tiny"` and
   * `"path-outside-workspace"` are both members of `RefusalCode` already, so
   * this narrows nothing and closes the escape.
   */
  reason: RefusalCode;
  alternatives?: Array<{ mode: string; range?: string; handle?: string }>;
  field?: "path";
  retry?: "call";
  workspace?: string;
  did_you_mean?: string;
  cwd_candidates?: Array<{ cwd: string; source: "git-worktree" | "requested-git-root" }>;
  /**
   * DESIGN-v0.8 §C8: present only on a "not-tiny" refusal (a
   * "path-outside-workspace" refusal has no file to mint a handle for).
   * Mirrors the mode=full downgrade payload shape (handle + skeleton +
   * next) but kept compact (<1KB total) — a not-tiny miss should teach the
   * caller something actionable instead of costing a contentless turn.
   */
  handle?: string;
  skeleton?: string;
  next?: string | ToolCall;
}

export interface SmallFileBuildOptions {
  content?: SmallFileContentMode;
  /**
   * DESIGN-v0.8 §C4 item 3 / §C3: elideDocComments is applied to the served
   * content by default (matching every other content-bearing read_code
   * mode); pass keepComments:true to preserve comments verbatim (the same
   * comments=keep escape full/slice/symbol/auto honor).
   */
  keepComments?: boolean;
  /**
   * G1: readCodePack's explicit paths[] batch enumerates the exact files it
   * wants full — that is a one-call-complete pack, not the "load many whole
   * small files into permanent context" abuse TINY_TASK_CAP guards against.
   * When true, buildSmallFile still RECORDS the tiny-full expansion (so the
   * counter reflects reality) but never downgrades past the cap. The default
   * (false / omitted) DOES consult and enforce the cap.
   */
  governorExempt?: boolean;
  /**
   * PI-07 / F-A1-5 (2026-08-20): the server's configured `--allowed-parent`
   * roots, threaded through to `requestedPathWorkspaceCandidates` so its
   * git-probed candidates (git-worktree / requested-git-root) are validated
   * through the SAME `isWorkspaceCandidateAccepted` check every other
   * workspace-candidate producer uses, instead of only the weaker
   * `isWithin(requestedAbs, root)` this module applied on its own. Defaults
   * to `[]` when omitted — server.ts's two production call sites pass the
   * real `configuredAllowedParents(workspace)`; readCodePack.ts's
   * governor-exempt fast path over an already-vetted `paths[]` entry does
   * not (its refusal branch is not reachable in practice for that caller),
   * and an empty default only NARROWS which candidates validate, never
   * widens it.
   */
  allowedParents?: readonly string[];
}

// ---------------------------------------------------------------------------
// Exported builder
// ---------------------------------------------------------------------------

/**
 * Build a small_file response for the given workspace-relative path.
 *
 * Returns SmallFileResult on success, SmallFileRefusal when the file exceeds
 * the TINY threshold. Never throws for size violations — only for unexpected
 * I/O errors (let the caller surface those).
 */
const BASENAME_CANDIDATE_LIMIT = 3;
const GIT_PROBE_TIMEOUT_MS = 2_000;
const GIT_PROBE_MAX_BYTES = 64 * 1024;

type CwdCandidate = NonNullable<SmallFileRefusal["cwd_candidates"]>[number];

function runGit(cwd: string, args: readonly string[]): string | undefined {
  const result = spawnSync(
    "git",
    ["-C", cwd, ...args],
    {
      encoding: "utf8",
      shell: false,
      timeout: GIT_PROBE_TIMEOUT_MS,
      maxBuffer: GIT_PROBE_MAX_BYTES,
      stdio: ["ignore", "pipe", "ignore"],
      env: {
        ...process.env,
        GIT_OPTIONAL_LOCKS: "0",
        LC_ALL: "C",
        LANG: "C",
      },
    },
  );
  return result.status === 0 && typeof result.stdout === "string"
    ? result.stdout
    : undefined;
}

function nearestExistingDirectory(target: string): string | undefined {
  let probe = target;
  while (true) {
    try {
      return statSync(probe).isDirectory() ? probe : path.dirname(probe);
    } catch {
      const parent = path.dirname(probe);
      if (parent === probe) return undefined;
      probe = parent;
    }
  }
}

function sameBasenameCandidates(
  workspace: string,
  requestedPath: string,
  cwdCandidates: readonly CwdCandidate[],
): string[] {
  const basename = path.basename(requestedPath);
  if (basename === "" || basename === "." || basename === path.sep) return [];
  const requestedAbs = resolveReal(path.resolve(workspace, requestedPath));
  const preferredPaths = new Map(
    cwdCandidates.map(({ cwd }, index) => [
      path.relative(cwd, requestedAbs).split(path.sep).join("/"),
      index,
    ]),
  );
  return walkCodeFiles(workspace, {
    extraBasenames: [basename],
    includeArtifacts: true,
    includeGenericText: genericTextDiscoveryEnabled(),
  })
    .filter((file) => path.basename(file.relPath) === basename && !looksLikeSecretFile(file.relPath))
    .sort((a, b) => {
      const aRank = preferredPaths.get(a.relPath) ?? Number.MAX_SAFE_INTEGER;
      const bRank = preferredPaths.get(b.relPath) ?? Number.MAX_SAFE_INTEGER;
      return aRank - bRank || Buffer.compare(Buffer.from(a.relPath), Buffer.from(b.relPath));
    })
    .slice(0, BASENAME_CANDIDATE_LIMIT)
    .map((file) => file.relPath);
}

function requestedPathWorkspaceCandidates(
  workspace: string,
  requestedPath: string,
  allowedParents: readonly string[] = [],
): CwdCandidate[] {
  const requestedAbs = resolveReal(path.resolve(workspace, requestedPath));
  const roots = new Map<string, CwdCandidate["source"]>();
  const workspaceReal = resolveReal(workspace);

  const listed = runGit(workspaceReal, ["worktree", "list", "--porcelain", "-z"]);
  if (listed !== undefined) {
    for (const field of listed.split("\0")) {
      if (!field.startsWith("worktree ")) continue;
      const root = resolveReal(field.slice("worktree ".length));
      if (isWithin(requestedAbs, root)) roots.set(root, "git-worktree");
    }
  }

  const ancestor = nearestExistingDirectory(requestedAbs);
  if (ancestor !== undefined) {
    const topLevel = runGit(ancestor, ["rev-parse", "--show-toplevel"])?.trim();
    if (topLevel) {
      const root = resolveReal(topLevel);
      if (isWithin(requestedAbs, root) && !roots.has(root)) {
        roots.set(root, "requested-git-root");
      }
    }
  }

  // PI-07 / F-A1-5: both sources above were filtered ONLY by isWithin — a
  // git worktree or a probed "requested-git-root" can legitimately exist
  // without being a workspace this server's resolver would ever accept as a
  // cwd override (a sibling checkout outside every allowed parent, for
  // instance). Validate through the SAME check server.ts's checkCwdOrRefuse
  // applies to a live call before this candidate is ever offered.
  return [...roots]
    .map(([cwd, source]) => ({ cwd, source }))
    .filter((candidate) => isWorkspaceCandidateAccepted(candidate.cwd, workspaceReal, allowedParents))
    .sort((a, b) => b.cwd.length - a.cwd.length || Buffer.compare(Buffer.from(a.cwd), Buffer.from(b.cwd)))
    .slice(0, BASENAME_CANDIDATE_LIMIT);
}

function pathOutsideWorkspaceRefusal(
  workspace: string,
  requestedPath: string,
  allowedParents: readonly string[] = [],
): SmallFileRefusal {
  const workspaceReal = resolveReal(workspace);
  const cwdCandidates = requestedPathWorkspaceCandidates(workspaceReal, requestedPath, allowedParents);
  const didYouMean = sameBasenameCandidates(workspaceReal, requestedPath, cwdCandidates)[0];
  return {
    ok: false,
    reason: "path-outside-workspace",
    field: "path",
    retry: "call",
    workspace: workspaceReal,
    ...(didYouMean !== undefined
      ? {
          did_you_mean: didYouMean,
          next: {
            tool: "read_file",
            arguments: {
              mode: "small_file",
              path: didYouMean,
              cwd: workspaceReal,
            },
          },
        }
      : {}),
    ...(cwdCandidates.length > 0 ? { cwd_candidates: cwdCandidates } : {}),
  };
}

export async function buildSmallFile(
  workspace: string,
  resolvedPath: string,
  _cwd?: string,
  options: SmallFileBuildOptions = {},
): Promise<SmallFileResult | SmallFileRefusal> {
  // Resolve the absolute path safely within the workspace.
  const abs = safeResolve(resolvedPath, workspace);
  if (!abs) return pathOutsideWorkspaceRefusal(workspace, resolvedPath, options.allowedParents);
  const real = await safeRealPath(abs, resolveReal(workspace));
  if (!real) return pathOutsideWorkspaceRefusal(workspace, resolvedPath, options.allowedParents);

  // Read the file. This module resolves containment itself instead of going
  // through readBytesSafe (it needs to tell "outside workspace" apart from
  // "unreadable"), so it also has to carry the shared read-path cap itself:
  // an unguarded fs.readFile here HANGS on a workspace FIFO and goes resident
  // on an arbitrarily large file. Refusal throws, matching this function's
  // documented contract that unexpected I/O errors surface to the caller —
  // and matching what a directory target already does today (EISDIR). The
  // TINY refusal below is unaffected.
  const target = await checkReadTarget(real, workspace);
  if (!target.ok) {
    throw new Error(
      target.reason === "too-large"
        ? `file too large to read: ${resolvedPath} (${target.sizeBytes} bytes > ${target.maxBytes})`
        : `not a readable regular file: ${resolvedPath}`,
    );
  }
  const rawBuf = await fs.readFile(real);
  const byteSize = rawBuf.byteLength;
  // T1 (v0.13 review-fix wave, UTF-16 read parity): same
  // decodeTextBuffer(...) ?? raw-utf8-fallback rule as util/safePath.ts's
  // readFileSafe (see that function's comment) -- BOM-aware for UTF-16LE/BE
  // and UTF-8, ONE shared implementation with find/references/task-pack
  // (util/textDecode.ts), never a second decoder. byteSize above stays the
  // RAW file byte count on purpose (matches this file's existing
  // TINY_BYTES/governor accounting and core2's own size_bytes convention);
  // only the served `content` string -- and therefore its sha
  // (shaOfText(content) below) -- changes basis to the DECODED text. See
  // this wave's B-REPORT addendum for why that pairing was chosen.
  const content = decodeTextBuffer(rawBuf) ?? rawBuf.toString("utf8");
  // BUG FIX: was content.split(/\r?\n/).length — feeds the isTiny threshold
  // gate AND the suggested "1-<N>" slice ranges below (a phantom-inflated
  // count previously suggested a range one line past a real short file's end).
  const lineCount = countLines(content);

  const isTiny = byteSize <= TINY_BYTES && lineCount <= TINY_LINES;

  if (!isTiny) {
    // DESIGN-v0.8 §C8: mirror the mode=full downgrade payload shape
    // (handle + skeleton + next) instead of a bare contentless refusal — a
    // not-tiny miss should still teach the caller something actionable in
    // the same turn. Mint the handle from the file's OWN sha (same as the
    // tiny success path below), so a follow-up mode=slice on this handle is
    // pinned to the exact content the caller just learned about, and a
    // subsequent edit_code precondition check is meaningful.
    const notTinySha = shaOfText(content);
    const notTinyHandle = handleTable.upsert({
      kind: "file",
      path: resolvedPath,
      workspaceRoot: resolveReal(workspace),
      sha: notTinySha,
    });
    const rangeEnd = Math.max(1, Math.min(lineCount, 50));
    const nextStr = `read_file mode=slice handle=${notTinyHandle.id} range=1-${rangeEnd}`;

    // Compact skeleton — best-effort; a skeleton failure (unsupported
    // language, parse error) must not turn an already-informative refusal
    // into a thrown exception, so this degrades to omitting `skeleton`
    // rather than failing the whole call.
    let skeleton: string | undefined;
    try {
      const skeletonResult = await getFileSkeleton(content, { path: resolvedPath });
      if (skeletonResult.ok) {
        const raw = skeletonResult.data.signatures;
        skeleton = raw.length > NOT_TINY_SKELETON_CHAR_CAP
          ? raw.slice(0, NOT_TINY_SKELETON_CHAR_CAP) + "\n/* <truncated> */"
          : raw;
      }
    } catch {
      skeleton = undefined;
    }

    return {
      ok: false,
      reason: "not-tiny",
      handle: notTinyHandle.id,
      ...(skeleton ? { skeleton } : {}),
      next: nextStr,
      alternatives: [
        { mode: "slice", range: "1-50", handle: notTinyHandle.id },
        { mode: "skeleton", handle: notTinyHandle.id },
        { mode: "task_pack" },
      ],
    };
  }

  // Compute sha and mint handle.
  const sha = shaOfText(content);
  const hEntry = handleTable.upsert({
    kind: "file",
    path: resolvedPath,
    workspaceRoot: resolveReal(workspace),
    sha,
  });

  // Record mode for session telemetry.
  recordReadMode(workspace, "small_file");

  // Derive deterministic edit hints.
  const edit_hints = deriveEditHints(content);

  // DESIGN-v0.8 §C4 item 2: default changed from "full" to "auto" — an
  // explicit content="full" request still always returns full (unchanged
  // behavior for callers that ask for it); the DEFAULT (no content arg) now
  // routes through chooseAutoContentMode so a 3-8KB tiny file returns
  // outline+handle instead of unconditionally loading its whole body.
  const requestedContent = options.content ?? "auto";
  const contentMode = requestedContent === "auto" ? chooseAutoContentMode(byteSize, lineCount) : requestedContent;
  if (contentMode !== "full") {
    return finishOutlineServe(
      workspace,
      resolvedPath,
      content,
      buildOutlineResult(resolvedPath, hEntry.id, contentMode, byteSize, lineCount, content, edit_hints),
    );
  }

  // G1: this path serves FULL content of a tiny file — the same tiny-file full
  // expansion the mode=full/mode=auto governor already meters via
  // TINY_TASK_CAP. mode=small_file (and mode=auto's tiny route into it) records
  // the tiny counter here so that budget reflects reality.
  //
  // turn-economy wave 2 (W1, 2026-07-24): TINY_TASK_CAP is a runaway backstop
  // against the many-whole-small-files slurp, NOT a per-response byte throttle.
  // A tiny file is by definition <= GOVERNED_FULL_SERVE_BYTES, so a downgrade
  // here could only ever manufacture a second API turn for a file's worth of
  // content the caller was going to fetch anyway (~$0.03 in cache-read context
  // vs <$0.01 of extra bytes). Past the cap we therefore STILL serve the full
  // body — the counters keep ticking (telemetry and the slurp-backstop math are
  // unchanged; governorExempt still routes to the separate exempt counter) but
  // the caller is never handed a contentless outline+next it must redeem.
  //
  // governorExempt callers (readCodePack's explicit paths[] enumeration) record
  // into a SEPARATE exempt counter (FIX-3a, session.ts's recordTinyFullExpansion
  // `exempt` argument) so their one-call-complete packs never erode the budget
  // an agent's own later tiny reads draw down.
  // D10 (2026-08-14): unconditional — `TL_FULL_GOVERNOR` is deleted.
  recordFullExpansion(workspace, resolvedPath, sha);
  recordTinyFullExpansion(workspace, options.governorExempt);

  // DESIGN-v0.8 §C4 item 3: elideDocComments applied to the served content
  // by default; sha above is already computed from the RAW content, so it
  // stays a valid content pin regardless of elision (same pattern as every
  // other content-bearing read_code mode — see server.ts's DESIGN-v0.8 §C3
  // wiring).
  // item 11: small_file serves the WHOLE tiny file, so its first line IS file
  // line 1 — pass startLine=1 explicitly (the default) for clarity.
  // 2026-07-16a bench forensics: elideDocCommentsForDisplay falls back to raw
  // content + a note when elision would empty a doc-only file — see its doc
  // comment in util/formatCompress.ts.
  const { content: displayContent, note: elisionNote } = elideDocCommentsForDisplay(
    content,
    languageForPath(resolvedPath),
    options.keepComments === true,
    1,
  );

  // Feature 1 (2026-07-12b2): full content IS the whole file — record the
  // read (no concern_note needed here, mirroring buildConcernNote's slice
  // path: a full-file serve has nothing left "unseen" to warn about).
  recordReadPath(workspace, resolvedPath);

  return {
    mode: "small_file",
    path: resolvedPath,
    handle: hEntry.id,
    // C10.1: short display sha (response only) — the handle above (hEntry) was
    // minted on the FULL sha; this only shortens the value in the JSON body.
    sha: shortSha(sha),
    content: displayContent,
    edit_hints,
    ...(elisionNote ? { note: elisionNote } : {}),
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Build the outline/defer (no-full-content) SmallFileResult. Shared by the
 * ordinary outline/defer path AND the G1 tiny-task-cap downgrade, so the
 * downgrade payload is byte-for-byte the same handle+outline shape a caller
 * already handles.
 */
function buildOutlineResult(
  resolvedPath: string,
  handleId: string,
  contentMode: "outline" | "defer",
  byteSize: number,
  lineCount: number,
  content: string,
  edit_hints: SmallFileEditHint[],
): SmallFileResult {
  const rangeEnd = Math.max(1, Math.min(lineCount, 50));
  const result: SmallFileResult = {
    mode: "small_file",
    path: resolvedPath,
    handle: handleId,
    content_mode: contentMode,
    bytes: byteSize,
    lines: lineCount,
    next: `read_file mode=slice handle=${handleId} range=1-${rangeEnd}`,
  };
  if (contentMode === "outline") {
    result.outline = deriveOutline(content);
  }
  if (edit_hints.length > 0) {
    result.edit_hints = edit_hints;
  }
  return result;
}

/**
 * Feature 1 + Feature 3 (2026-07-12b2): shared tail for both outline-
 * producing return paths in buildSmallFile (the ordinary outline/defer
 * branch and the tiny-task-cap downgrade) — records the read (Feature 1, so
 * the unread-sibling note never flags a file the agent already got an
 * outline of) and attaches a concern_note when the outline text hides a
 * session concern-token hit (Feature 3, reuses readCodeModes.ts's
 * buildSmallFileConcernNote instead of duplicating its logic).
 */
function finishOutlineServe(
  workspace: string,
  resolvedPath: string,
  content: string,
  result: SmallFileResult,
): SmallFileResult {
  recordReadPath(workspace, resolvedPath);
  const outlineText = (result.outline ?? []).join("\n");
  const note = buildSmallFileConcernNote(workspace, resolvedPath, content, outlineText);
  if (note !== undefined) result.concern_note = note;
  return result;
}

/**
 * DESIGN-v0.8 §C4 item 2: raised from 512B/12 lines to AUTO_FULL_THRESHOLD_BYTES
 * / TINY_LINES.
 *
 * 2026-07-16a: AUTO_FULL_THRESHOLD_BYTES == TINY_BYTES now (was ~3KB), and
 * this function is only ever called after the caller's own TINY_BYTES/
 * TINY_LINES gate already passed — so for every real call site this now
 * always evaluates to "full" (the outline branch is dead for in-gate
 * callers). The comparison is kept, rather than hard-coding "full", because
 * a future change to either gate should not silently desync this threshold,
 * and because the byte/line split still documents which axis is binding.
 */
function chooseAutoContentMode(byteSize: number, lineCount: number): "full" | "outline" {
  return byteSize <= AUTO_FULL_THRESHOLD_BYTES && lineCount <= TINY_LINES ? "full" : "outline";
}

function deriveOutline(content: string): string[] {
  const outline: string[] = [];
  const lines = content.split(/\r?\n/);
  let importCount = 0;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i]!.trim();
    if (!trimmed) continue;
    if (/^import\b/.test(trimmed)) {
      importCount++;
      continue;
    }
    const entry = outlineEntry(trimmed, i + 1);
    if (entry) outline.push(entry);
    if (outline.length >= 24) break;
  }

  if (importCount > 0) {
    outline.unshift(`imports:${importCount}`);
  }
  return outline;
}

function outlineEntry(line: string, lineNumber: number): string | undefined {
  const testMatch = line.match(/^(describe|it|test)\(\s*["'`]([^"'`]{1,80})/);
  if (testMatch) {
    return `${lineNumber}: ${testMatch[1]} ${compactOutlineText(testMatch[2]!)}`;
  }

  const symbolMatch = line.match(
    /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(function|class|interface|type|const|let|var)\s+([A-Za-z_$][\w$]*)/,
  );
  if (symbolMatch) {
    return `${lineNumber}: ${symbolMatch[1]} ${symbolMatch[2]}`;
  }

  const exportMatch = line.match(/^export\s+\{([^}]{1,80})\}/);
  if (exportMatch) {
    return `${lineNumber}: export {${compactOutlineText(exportMatch[1]!)}}`;
  }

  return undefined;
}

function compactOutlineText(value: string): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > 96 ? `${compact.slice(0, 93)}...` : compact;
}

/**
 * Derive cheap, deterministic edit hints from file content.
 *
 * Only emits hints with syntactic grounding in the content.
 * False positives are acceptable if they are syntactically grounded.
 */
function deriveEditHints(content: string): SmallFileEditHint[] {
  const hints: SmallFileEditHint[] = [];

  // Detect top-level "const FOO = <literal>" followed by "export default FOO".
  const constLiteralMatch = content.match(
    /^(?:export\s+)?const\s+([A-Z_][A-Z0-9_]*)\s*=\s*(?:['"`]|[0-9]|-[0-9]|\{|\[)/m,
  );
  if (constLiteralMatch) {
    const name = constLiteralMatch[1];
    const exportDefaultRe = new RegExp(`export\\s+default\\s+${name}\\b`);
    if (exportDefaultRe.test(content)) {
      // Find the line number of the const declaration (1-based).
      const linesBefore = content.slice(0, constLiteralMatch.index ?? 0).split(/\r?\n/);
      hints.push({ kind: "replace-config-constant", line: linesBefore.length });
    }
  }

  // Detect obvious duplicate if/else-if branches (same body text).
  const duplicateBranch = findDuplicateBranch(content);
  if (duplicateBranch) {
    hints.push({ kind: "remove-duplicate-branch", range: duplicateBranch });
  }

  return hints;
}

/**
 * Look for consecutive if/else-if blocks with identical trimmed bodies.
 * Returns a "startLine-endLine" range string for the second (duplicate) block,
 * or undefined if none found.
 *
 * Uses a simple line-by-line scan — no AST required.
 */
function findDuplicateBranch(content: string): string | undefined {
  const lines = content.split(/\r?\n/);
  // Pattern: lines matching "if (" or "} else if ("
  const branchLineRe = /^\s*(?:(?:else\s+)?if\s*\(|}\s*else\s+if\s*\()/;

  // Collect bodies between branch header lines.
  const blocks: Array<{ startLine: number; endLine: number; body: string }> = [];
  let inBlock = false;
  let blockStart = 0;
  let blockLines: string[] = [];
  let depth = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (branchLineRe.test(line)) {
      if (inBlock && blockLines.length > 0) {
        blocks.push({ startLine: blockStart + 1, endLine: i, body: blockLines.join("\n").trim() });
      }
      inBlock = true;
      blockStart = i;
      blockLines = [];
      depth = (line.match(/\{/g)?.length ?? 0) - (line.match(/\}/g)?.length ?? 0);
    } else if (inBlock) {
      depth += (line.match(/\{/g)?.length ?? 0) - (line.match(/\}/g)?.length ?? 0);
      blockLines.push(line);
      if (depth <= 0) {
        blocks.push({ startLine: blockStart + 1, endLine: i + 1, body: blockLines.join("\n").trim() });
        inBlock = false;
        blockLines = [];
        depth = 0;
      }
    }
  }

  // Look for two consecutive blocks with the same body.
  for (let i = 1; i < blocks.length; i++) {
    const prev = blocks[i - 1]!;
    const curr = blocks[i]!;
    if (prev.body !== "" && prev.body === curr.body) {
      return `${curr.startLine}-${curr.endLine}`;
    }
  }

  return undefined;
}
