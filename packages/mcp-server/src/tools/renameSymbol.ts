/**
 * renameSymbol — word-boundary identifier rename across scope.
 *
 * Walks code files, replaces \bFROM\b → TO. Atomic write per file with a
 * single shadow-git checkpoint covering the batch. Lines that look like
 * line-comments are SKIPPED by default (override with includeComments:true).
 *
 * NOT AST-aware: matches inside string literals or doc comments will be
 * rewritten. Run explore action=references first to inspect what will change.
 *
 * Safety: same secret-file / symlink / workspace-escape checks as the
 * existing write tools (searchReplaceEdit / applyEditsMulti). Files that
 * fail safety checks land in `skipped` rather than failing the whole batch.
 */

import * as fs from "fs";
import * as path from "path";
import type { LangKey } from "./walkRepo.js";
import { walkCodeFiles } from "./walkRepo.js";
import { escapeRegExp } from "../features/search/find/findText.js";
import { looksLikeComment } from "./findReferences.js";
import { collectLexicalSegments, segmentKindAt } from "./lexicalRanges.js";
import { writeExistingFileAtomic } from "../write/atomicWrite.js";
import { looksLikeSecretFile } from "../write/secretScan.js";
import { batchCheckpoint } from "../write/checkpoint.js";
// The mid-batch rollback ledger is DEFINED next to the batch-edit path and
// IMPORTED here rather than mirrored: this file's Phase 2 already says it
// "mirrors applyEditsMulti's shape", and a second hand-copied ledger is
// exactly how the two default-path writers would drift out of one contract.
import {
  restoreFailedLedgerEntry,
  rollbackRecoveryHint,
  type RollbackFileState,
} from "./applyEditsMulti.js";
import { nestedWorkspaceCrossing } from "../write/workspaceBoundary.js";
import type { GuardedWorkspaceRoot } from "../write/guardedWorkspace.js";

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const IDENT_RE = /^[A-Za-z_$][\w$]*$/;

export interface RenameSymbolInput {
  from: string;
  to: string;
  /** Optional file or sub-dir to limit scope (workspace-relative). Unset = workspace-wide. */
  path?: string;
  /** Rewrite matches inside line-comments too. Default false. */
  includeComments?: boolean;
  lang?: LangKey;
}

export interface RenameFileResult {
  path: string;
  replacements: number;
}

export interface RenameSkippedFile {
  path: string;
  reason: string;
}

export type RenameSymbolResult =
  | {
      ok: true;
      from: string;
      to: string;
      changed_files: RenameFileResult[];
      total_replacements: number;
      skipped: RenameSkippedFile[];
      checkpoint: string | null;
    }
  | {
      ok: false;
      error: string;
      code: string;
      /**
       * CWE-755 (strategy §6.6): the three fields below are emitted ONLY with
       * code "rollback-failed" -- the primary write failed AND the rollback
       * could not restore every already-written file, so the tree matches
       * neither the pre-rename nor the post-rename state. A fully successful
       * rollback still returns the plain `write-error` shape without them.
       * Same vocabulary as applyEditsMulti and the C2 staged transaction.
       */
      path?: string;
      workspace_state?: "workspace-state-unknown";
      rollback?: RollbackFileState[];
      recovery?: string;
    };

function safeRealpathExisting(absPath: string, workspaceReal: string): string | null {
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

export async function renameSymbol(
  input: RenameSymbolInput,
  workspace: GuardedWorkspaceRoot,
  allowWrite: boolean,
  sessionId: string,
): Promise<RenameSymbolResult> {
  if (!allowWrite) {
    return {
      ok: false,
      error: "Write tools are disabled. Restart the server with --allow-write.",
      code: "write-not-enabled",
    };
  }
  if (!input.from || !input.to) {
    return { ok: false, error: "from and to are required for mode=rename", code: "invalid-input" };
  }
  if (!IDENT_RE.test(input.from)) {
    return { ok: false, error: `from must be a valid identifier: ${input.from}`, code: "invalid-input" };
  }
  if (!IDENT_RE.test(input.to)) {
    return { ok: false, error: `to must be a valid identifier: ${input.to}`, code: "invalid-input" };
  }
  if (input.from === input.to) {
    return { ok: false, error: "from and to are identical — no rename needed", code: "invalid-input" };
  }

  const resolvedWorkspace = path.resolve(workspace);
  let workspaceReal: string;
  try {
    workspaceReal = fs.realpathSync(resolvedWorkspace);
  } catch {
    workspaceReal = resolvedWorkspace;
  }

  const includeComments = input.includeComments ?? false;
  const probe = new RegExp(`\\b${escapeRegExp(input.from)}\\b`);

  // Full-recall: renameSymbol must rewrite EVERY reference to be correct, so
  // it opts out of build-dir/generated noise filtering (a real `src/build/` or
  // `**/generated/` source file must not be silently skipped). The
  // bench-runs/cache/coverage exclusions still apply — those are never source.
  const files = walkCodeFiles(workspace, {
    ...(input.lang ? { lang: input.lang } : {}),
    ...(input.path ? { subPath: input.path } : {}),
    fullRecall: true,
  });

  interface Prepared {
    rel: string;
    abs: string;
    newContent: string;
    existingContent: string;
    replacements: number;
    mode: number | undefined;
  }
  const prepared: Prepared[] = [];
  const skipped: RenameSkippedFile[] = [];

  for (const f of files) {
    if (looksLikeSecretFile(f.relPath)) {
      skipped.push({ path: f.relPath, reason: "secret-file" });
      continue;
    }
    let stat: fs.Stats;
    try { stat = fs.statSync(f.absPath); } catch { continue; }
    if (stat.size > MAX_FILE_BYTES) {
      skipped.push({ path: f.relPath, reason: "file-too-large" });
      continue;
    }
    if (safeRealpathExisting(f.absPath, workspaceReal) === null) {
      skipped.push({ path: f.relPath, reason: "path-escape" });
      continue;
    }
    // Root-mismatch guard (2026-08-09): a rename's targets are DISCOVERED, not
    // named, so the dispatch-level workspace-boundary refusal (which inspects
    // named paths) cannot see them. A linked worktree nested inside this root
    // is a different workspace on its own branch; rewriting its files from
    // here is contamination, not a rename. `.claude/worktrees/` is already
    // outside the walk via DEFAULT_IGNORE — this covers every OTHER nesting
    // location, and reports the skip rather than silently narrowing recall.
    const foreign = nestedWorkspaceCrossing(f.absPath, workspaceReal);
    if (foreign !== undefined) {
      skipped.push({ path: f.relPath, reason: "other-workspace" });
      continue;
    }
    let raw: string;
    try { raw = fs.readFileSync(f.absPath, "utf8"); } catch { continue; }
    if (!probe.test(raw)) continue;

    const lexicalSegments = await collectLexicalSegments(raw, f.language);

    // Per-line replace so we can skip comments/strings without losing line numbers.
    // A fresh global regex per file avoids lastIndex bookkeeping across files.
    const lineReplacer = new RegExp(`\\b${escapeRegExp(input.from)}\\b`, "g");
    const lines = raw.split(/\r?\n/);
    let count = 0;
    const newLines = lines.map((line, lineIndex) => {
      if (!includeComments && looksLikeComment(line, f.language)) return line;
      lineReplacer.lastIndex = 0;
      let out = "";
      let cursor = 0;
      let match: RegExpExecArray | null;
      while ((match = lineReplacer.exec(line)) !== null) {
        const kind = segmentKindAt(lexicalSegments, lineIndex + 1, match.index);
        const inSkippedComment = kind === "comment" && !includeComments;
        const inString = kind === "string";
        out += line.slice(cursor, match.index);
        if (inSkippedComment || inString) {
          out += match[0];
        } else {
          out += input.to;
          count++;
        }
        cursor = match.index + match[0].length;
      }
      return out + line.slice(cursor);
    });

    if (count === 0) continue;  // every match was in a skipped comment

    const usesCRLF = raw.includes("\r\n");
    const newContent = newLines.join(usesCRLF ? "\r\n" : "\n");

    prepared.push({
      rel: f.relPath,
      abs: f.absPath,
      newContent,
      existingContent: raw,
      replacements: count,
      mode: stat.mode,
    });
  }

  if (prepared.length === 0) {
    return {
      ok: true,
      from: input.from,
      to: input.to,
      changed_files: [],
      total_replacements: 0,
      skipped,
      checkpoint: null,
    };
  }

  // Phase 2: write each file atomically. On mid-batch failure, roll back the
  // already-written files and REPORT the outcome of that rollback. Mirrors
  // applyEditsMulti's shape, ledger included.
  const writtenRel: string[] = [];
  const originals = new Map<string, { content: string; mode: number | undefined; rel: string }>();
  for (const item of prepared) {
    originals.set(item.abs, { content: item.existingContent, mode: item.mode, rel: item.rel });
    try {
      // Mode preservation: see writeExistingFileAtomic's doc comment
      // (2026-08-07 chmod-reset incident) — covers both this primary write
      // and the mid-batch rollback restore below.
      writeExistingFileAtomic(item.abs, item.newContent, item.mode, { root: workspace, relPath: item.rel });
      writtenRel.push(item.rel);
    } catch (err) {
      // CWE-755 (strategy §6.6): a rollback restore that ITSELF fails is
      // surfaced, not swallowed by `catch { /* best-effort */ }` — a rename
      // half-applied across the workspace is precisely the state a caller
      // cannot reconstruct from a bare "write-error". Same ledger, same
      // `workspace-state-unknown`, same `rollback-failed` code as the
      // batch-edit path and the C2 staged transaction.
      const rollback: RollbackFileState[] = [];
      let rollbackFailed = false;
      for (const [abs, orig] of originals.entries()) {
        if (abs === item.abs) continue;
        try {
          writeExistingFileAtomic(abs, orig.content, orig.mode, { root: workspace, relPath: orig.rel });
          rollback.push({ path: orig.rel, state: "rolled-back" });
        } catch (rollbackErr) {
          rollbackFailed = true;
          rollback.push(restoreFailedLedgerEntry(orig.rel, abs, orig.content, rollbackErr));
        }
      }

      const writeError = `Cannot write file ${item.rel}: ${(err as Error).message}`;
      if (!rollbackFailed) {
        // REVIEWED CHANGE (user-adjudicated 2026-08-14), IN LOCKSTEP WITH
        // `applyEditsMulti`: a clean rollback reports its ledger, per
        // protocol-v1 A.5.13. See that file's branch for the full rationale —
        // this path speaks the same vocabulary by design (same `RollbackFileState`,
        // same `rollback-failed`, same `workspace-state-unknown`), and a
        // divergence here would give an agent two contracts for one fact.
        // Omitted rather than emitted empty when the FIRST write failed and
        // nothing was restored (A.8 rule E-1); that case is a refusal, and
        // truthfully so.
        return {
          ok: false,
          error: writeError,
          code: "write-error",
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

  let checkpoint: string | null = null;
  try {
    const cp = batchCheckpoint(workspace, writtenRel, sessionId);
    checkpoint = cp.checkpointId;
  } catch {
    checkpoint = null;
  }

  return {
    ok: true,
    from: input.from,
    to: input.to,
    changed_files: prepared.map((p) => ({ path: p.rel, replacements: p.replacements })),
    total_replacements: prepared.reduce((acc, p) => acc + p.replacements, 0),
    skipped,
    checkpoint,
  };
}
