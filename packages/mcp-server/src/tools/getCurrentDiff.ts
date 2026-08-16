/**
 * get_current_diff tool implementation for @tokenlighten/mcp-server v0.4.
 *
 * Returns the working-tree diff as file/hunk metadata (location-only, no patch text).
 * --no-color is MANDATORY: ANSI escape sequences waste tokens.
 *
 * Output policy: plain data — no meta envelope.
 * Spec: DESIGN-v0.4-mcp-surface-thinning.md §3 "explore Is Location-Only"
 */

import { execFile } from "child_process";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** git diff execution timeout in milliseconds. */
const GIT_TIMEOUT_MS = 10_000;

/** Hard byte cap for the serialized JSON response. */
const RESPONSE_CAP_BYTES = 2048;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GetCurrentDiffInput {
  path?: string;
  maxTokens?: number;
}

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
}

export interface DiffFile {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed";
  hunks: DiffHunk[];
}

export interface GetCurrentDiffResult {
  files: DiffFile[];
  truncated: boolean;
  totalFiles: number;
  error?: string;
}

// ---------------------------------------------------------------------------
// Diff parser
// ---------------------------------------------------------------------------

/**
 * Parse `git diff --no-color HEAD` output into file/hunk metadata.
 */
function parseDiff(raw: string): DiffFile[] {
  const files: DiffFile[] = [];
  let current: DiffFile | null = null;

  const lines = raw.split(/\r?\n/);

  for (const line of lines) {
    // New file header: diff --git a/PATH b/PATH
    const fileHeaderMatch = line.match(/^diff --git a\/.+ b\/(.+)$/);
    if (fileHeaderMatch) {
      if (current) files.push(current);
      current = {
        path: fileHeaderMatch[1]!,
        status: "modified",
        hunks: [],
      };
      continue;
    }

    if (!current) continue;

    // Status markers
    if (line.startsWith("new file mode")) {
      current.status = "added";
      continue;
    }
    if (line.startsWith("deleted file mode")) {
      current.status = "deleted";
      // For deleted files, use the a/ path (already set from header's b/ path
      // which is /dev/null for deleted; re-parse from the diff --git line).
      // The current.path from b/ side would be /dev/null — fix it.
      // We'll handle this by re-extracting a/ path from the stored line if needed.
      // Since we already set path from fileHeaderMatch[1], and for deleted files
      // b/ is "/dev/null", we need to re-extract a/ path.
      // However at this point we've already moved past that line.
      // The pattern "diff --git a/PATH b/PATH" for deleted: b/ = /dev/null.
      // We'll detect this later when we see "--- a/PATH".
      continue;
    }
    if (line.startsWith("rename from ")) {
      current.status = "renamed";
      continue;
    }
    if (line.startsWith("rename to ")) {
      // Use the "to" path as the canonical path.
      current.path = line.slice("rename to ".length).trim();
      continue;
    }

    // For deleted files, extract real path from "--- a/PATH" line.
    if (current.status === "deleted" && line.startsWith("--- a/")) {
      current.path = line.slice("--- a/".length).trim();
      continue;
    }

    // Hunk header: @@ -oldStart[,oldLines] +newStart[,newLines] @@
    const hunkMatch = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (hunkMatch) {
      current.hunks.push({
        oldStart: parseInt(hunkMatch[1]!, 10),
        oldLines: hunkMatch[2] !== undefined ? parseInt(hunkMatch[2], 10) : 1,
        newStart: parseInt(hunkMatch[3]!, 10),
        newLines: hunkMatch[4] !== undefined ? parseInt(hunkMatch[4], 10) : 1,
      });
      continue;
    }
    // Skip context lines, +/- lines, and no-newline markers.
  }

  if (current) files.push(current);
  return files;
}

// ---------------------------------------------------------------------------
// Main implementation
// ---------------------------------------------------------------------------

/**
 * Run `git diff --no-color HEAD` and return file/hunk metadata.
 *
 * @param input      - Tool input (optional path filter; maxTokens is a no-op / file cap hint).
 * @param workspace  - Absolute workspace root (used as git -C argument).
 */
export async function getCurrentDiff(
  input: GetCurrentDiffInput,
  workspace: string
): Promise<GetCurrentDiffResult> {
  // Build git diff arguments.
  const gitArgs = ["diff", "--no-color", "HEAD"];
  if (input.path) {
    gitArgs.push("--", input.path);
  }

  // Run git diff.
  let fullDiff: string;
  try {
    fullDiff = await new Promise<string>((resolve, reject) => {
      execFile(
        "git",
        ["-C", workspace, ...gitArgs],
        { timeout: GIT_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 }, // 64 MB buffer
        (err, stdout, stderr) => {
          if (err) {
            reject(new Error(stderr?.trim() || err.message));
          } else {
            resolve(stdout);
          }
        }
      );
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      files: [],
      truncated: false,
      totalFiles: 0,
      error: `git diff failed: ${msg}`,
    };
  }

  const allFiles = parseDiff(fullDiff);
  const totalFiles = allFiles.length;

  // Apply byte cap: accumulate files until serialized JSON would exceed cap.
  const files: DiffFile[] = [];
  let truncated = false;

  for (const file of allFiles) {
    const candidate = [...files, file];
    const serialized = JSON.stringify({
      files: candidate,
      truncated: false,
      totalFiles,
    });
    if (Buffer.byteLength(serialized, "utf8") > RESPONSE_CAP_BYTES) {
      truncated = true;
      break;
    }
    files.push(file);
  }

  return {
    files,
    truncated,
    totalFiles,
  };
}
