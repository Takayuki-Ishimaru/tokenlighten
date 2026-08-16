/**
 * search_replace_edit tool implementation for @tokenlighten/mcp-server v0.2.
 *
 * Applies a single exact-match search/replace to a workspace file.
 * Writes are atomic: tmp file in same directory, then retryRename with EBUSY backoff.
 * Secret file paths are rejected before any read or write.
 * 5 MB file cap is enforced before any processing.
 *
 * Output policy: plain data — no meta envelope.
 * Spec: docs/components/02-mcp-server.md §2.1
 */

import * as fs from "fs";
import * as path from "path";
import { makeTmpPath, retryRename, writeExistingFileAtomic } from "../write/atomicWrite.js";
import { looksLikeSecretFile } from "../write/secretScan.js";
import type { GuardedWorkspaceRoot } from "../write/guardedWorkspace.js";
import { applySingleEdit } from "../write/textEdit.js";
import { computeLineDelta, formatDelta, formatLines } from "../util/lineDelta.js";
import { countLines } from "../util/countLines.js";

/**
 * Resolve the realpath of an existing file (or its first existing ancestor for
 * new-file paths) and verify it stays within workspaceReal.
 * Returns the resolved real path if safe, or null if it escapes the workspace.
 */
function safeRealpathSync(absPath: string, workspaceReal: string, fileExists: boolean): string | null {
  try {
    if (fileExists) {
      const real = fs.realpathSync(absPath);
      if (real === workspaceReal || real.startsWith(workspaceReal + path.sep)) {
        return real;
      }
      return null;
    } else {
      // For new-file creation: walk up from absPath to find the first existing
      // ancestor, then realpath that.
      let cur = path.dirname(absPath);
      while (true) {
        try {
          const real = fs.realpathSync(cur);
          if (real === workspaceReal || real.startsWith(workspaceReal + path.sep)) {
            return absPath; // path is within workspace
          }
          return null; // first existing ancestor resolves outside workspace
        } catch {
          const parent = path.dirname(cur);
          if (parent === cur) {
            // Hit filesystem root — fall back to lexical check
            break;
          }
          cur = parent;
        }
      }
      // Lexical fallback: the resolved path starts with workspace
      const resolved = path.resolve(absPath);
      if (resolved === workspaceReal || resolved.startsWith(workspaceReal + path.sep)) {
        return resolved;
      }
      return null;
    }
  } catch {
    return null;
  }
}

/** 5 MB per-file cap. */
const MAX_FILE_BYTES = 5 * 1024 * 1024;

export interface SearchReplaceEditInput {
  path: string;
  search: string;
  replace: string;
  allow_create?: boolean;
}

export type SearchReplaceEditResult =
  | {
      ok: true;
      path: string;
      lines: string;
      delta: string;
      /**
       * Disclosure (2026-08-07). applySingleEdit may apply a RECOVERED
       * search/replace instead of the caller's literal bytes: when the raw
       * search misses and it carries a literal `\n`/`\t`/`\r`, the unescaped
       * variant is retried, and the replacement is unescaped too when it
       * shares an escape class. That rewrite is legitimate (it rescues a
       * double-encoded caller) but it must never be SILENT: it can change
       * the bytes that land on disk — a replacement carrying a two-backslash
       * `\\uXXXX` source literal comes out with one backslash.
       *
       * applyEditsMulti has always disclosed this as `normalized_escapes`
       * (a path list); the single-edit engine computed the same flag and
       * dropped it, so the caller could not tell an as-sent write from a
       * rewritten one. These two fields close that asymmetry. Absent on
       * every ordinary (verbatim) success.
       */
      normalized_escapes?: true;
      /** As above, for the unique full-line indentation-drift recovery. */
      normalized_whitespace?: true;
    }
  | { ok: false; error: string; code: string };

/**
 * Apply one search/replace edit to a file.
 *
 * @param input       - Tool input arguments.
 * @param workspace   - Absolute workspace root (for path resolution).
 * @param allowWrite  - Write-enable flag (must be true to write).
 */
export async function searchReplaceEdit(
  input: SearchReplaceEditInput,
  workspace: GuardedWorkspaceRoot,
  allowWrite: boolean
): Promise<SearchReplaceEditResult> {
  if (!allowWrite) {
    return {
      ok: false,
      error: "Write tools are disabled. Restart the server with --allow-write.",
      code: "write-not-enabled",
    };
  }

  const relPath = input.path;
  if (!relPath) {
    return { ok: false, error: "path is required", code: "invalid-input" };
  }

  // Secret file rejection.
  if (looksLikeSecretFile(relPath)) {
    return {
      ok: false,
      error: `Refusing to write to secret/credential file: ${relPath}`,
      code: "secret-file",
    };
  }

  // Resolve to absolute path within workspace.
  const absPath = path.resolve(workspace, relPath);
  // Ensure the path stays within the workspace root (lexical check first).
  const resolvedWorkspace = path.resolve(workspace);
  if (!absPath.startsWith(resolvedWorkspace + path.sep) && absPath !== resolvedWorkspace) {
    return { ok: false, error: "path escapes workspace root", code: "path-escape" };
  }

  // Compute the real (symlink-resolved) workspace root once.
  let workspaceReal: string;
  try {
    workspaceReal = fs.realpathSync(resolvedWorkspace);
  } catch {
    workspaceReal = resolvedWorkspace;
  }

  const allowCreate = input.allow_create ?? false;

  // Read existing file content.
  let existingContent: string;
  let existingMode: number | undefined;
  let fileExists = false;
  try {
    const stat = fs.statSync(absPath);
    if (stat.size > MAX_FILE_BYTES) {
      return {
        ok: false,
        error: `File exceeds 5 MB limit (${stat.size} bytes): ${relPath}`,
        code: "file-too-large",
      };
    }
    existingContent = fs.readFileSync(absPath, "utf8");
    existingMode = stat.mode;
    fileExists = true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      if (!allowCreate) {
        return {
          ok: false,
          // FIX 2c: edit_file's ADVERTISED schema has `create`, not
          // `allow_create` (that name only ever existed on the deprecated
          // search_replace_edit alias's schema) — an agent that hit this hint
          // could not see the param it named, and abandoned the tool. Point
          // at the name the caller can actually see; this function's own
          // `allow_create` field survives as an engine-internal option, fed
          // ONLY from the advertised `create` now — server.ts's edit_file
          // dispatch computes `allow_create: args["create"] === true`; the
          // caller-facing `allow_create` alias itself was deleted.
          error: `File not found: ${relPath}. Use create:true to create new files.`,
          code: "not-found",
        };
      }
      existingContent = "";
      fileExists = false;
    } else {
      return {
        ok: false,
        error: `Cannot read file: ${(err as Error).message}`,
        code: "read-error",
      };
    }
  }

  // Realpath escape check — defend against symlinks pointing outside workspace.
  const safeReal = safeRealpathSync(absPath, workspaceReal, fileExists);
  if (safeReal === null) {
    return { ok: false, error: "path escapes workspace root (symlink)", code: "path-escape" };
  }

  // Handle new file creation.
  if (!fileExists && allowCreate) {
    if (input.search !== "") {
      return {
        ok: false,
        // FIX 2c: see the not-found hint above — same rename, same reason.
        error: "When creating a new file (create:true, file absent), search must be empty string.",
        code: "invalid-input",
      };
    }
    // Create parent directories if needed.
    const parentDir = path.dirname(absPath);
    try {
      fs.mkdirSync(parentDir, { recursive: true });
    } catch (err) {
      return {
        ok: false,
        error: `Cannot create directory: ${(err as Error).message}`,
        code: "write-error",
      };
    }
    const newContent = input.replace;
    const tmpPath = makeTmpPath(absPath);
    try {
      fs.writeFileSync(tmpPath, newContent, "utf8");
      retryRename(tmpPath, absPath);
    } catch (err) {
      return {
        ok: false,
        error: `Cannot write file: ${(err as Error).message}`,
        code: "write-error",
      };
    }
    // BUG FIX: was newContent.split("\n").length, which counts a phantom
    // final segment for trailing-newline content — reported "lines"/"delta"
    // on a brand-new file overstated its line count by one.
    const lineCount = countLines(newContent);
    return {
      ok: true,
      path: relPath,
      lines: formatLines(1, lineCount),
      delta: formatDelta(lineCount, 0),
    };
  }

  // Apply the search/replace edit.
  const editResult = applySingleEdit(existingContent, input.search, input.replace);
  if (!editResult.ok) {
    return {
      ok: false,
      error: editResult.error ?? "edit failed",
      code: editResult.code ?? "edit-error",
    };
  }

  const newContent = editResult.text!;

  // Atomic write — preserves the original file's mode (see
  // writeExistingFileAtomic's doc comment; 2026-08-07 chmod-reset incident).
  try {
    writeExistingFileAtomic(absPath, newContent, existingMode);
  } catch (err) {
    return {
      ok: false,
      error: `Cannot write file: ${(err as Error).message}`,
      code: "write-error",
    };
  }

  // The reported line range/delta must describe the edit that ACTUALLY
  // happened. When a recovery path fired, the caller's raw search never
  // matched this text, so feeding it to computeLineDelta measures an edit
  // that did not occur (observed: a recovered 2-line edit reported lines:"1",
  // delta:"+1/-1"). usedSearch/usedReplace are the strings applySingleEdit
  // really matched and really applied; they are absent on the verbatim path,
  // where the caller's own strings are already the right answer.
  const ld = computeLineDelta(
    existingContent,
    editResult.usedSearch ?? input.search,
    editResult.usedReplace ?? input.replace,
  );
  return {
    ok: true,
    path: relPath,
    lines: formatLines(ld.startLine, ld.endLine),
    delta: formatDelta(ld.added, ld.removed),
    ...(editResult.normalizedEscapes ? { normalized_escapes: true as const } : {}),
    ...(editResult.normalizedWhitespace ? { normalized_whitespace: true as const } : {}),
  };
}
