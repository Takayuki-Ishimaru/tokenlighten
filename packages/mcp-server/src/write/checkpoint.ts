/**
 * checkpoint.ts — batch staging + commit shared by the write tools (edit_file's
 * range/artifact paths, create_file, rename_symbol, apply_edits_multi).
 *
 * Wraps shadowGit.createCheckpoint with batch-level concerns:
 *   - 5 MB per-file cap (files over the cap are skipped from the checkpoint)
 *   - Session ID embedding in commit messages
 *   - Structured result type for the tool response
 *
 * Output policy: plain data — no meta envelope.
 */

import * as path from "path";
import * as fs from "fs";
import { createCheckpoint, type CheckpointResult } from "./shadowGit.js";

/** 5 MB cap per file (same as the write-tool cap). */
const MAX_FILE_BYTES = 5 * 1024 * 1024;

export interface BatchCheckpointResult {
  checkpointId: string | null;
  skippedFiles: string[];
  error?: string;
}

/**
 * Create a shadow-git checkpoint for a batch of edited files.
 *
 * Files over 5 MB are silently skipped (not staged). If all files are
 * skipped the checkpoint is not created and checkpointId is null.
 *
 * @param workspace   - Absolute workspace root.
 * @param editedFiles - Workspace-relative paths of files that were written.
 * @param sessionId   - MCP session identifier (embedded in commit message).
 */
export function batchCheckpoint(
  workspace: string,
  editedFiles: string[],
  sessionId: string
): BatchCheckpointResult {
  const skippedFiles: string[] = [];
  const eligible: string[] = [];

  for (const rel of editedFiles) {
    const abs = path.join(workspace, rel);
    try {
      const stat = fs.statSync(abs);
      if (stat.size > MAX_FILE_BYTES) {
        skippedFiles.push(rel);
      } else {
        eligible.push(rel);
      }
    } catch {
      // File stat failed — skip silently.
      skippedFiles.push(rel);
    }
  }

  if (eligible.length === 0) {
    return { checkpointId: null, skippedFiles };
  }

  const message =
    `tl apply_edits_multi: ${eligible.length} file${eligible.length === 1 ? "" : "s"}` +
    ` | session=${sessionId}`;

  const result: CheckpointResult = createCheckpoint(workspace, eligible, message);

  if (!result.ok) {
    return {
      checkpointId: null,
      skippedFiles,
      error: result.error,
    };
  }

  return { checkpointId: result.checkpointId, skippedFiles };
}
