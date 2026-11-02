import { chmodSync, lstatSync } from "node:fs";

// Permission bits for the guide files this package writes (AGENTS.md,
// CLAUDE.md, .github/copilot-instructions.md, .cursor/rules/..., the Copilot
// agent file). They are project-shared text that a team commits and CI or a
// container user reads, and they hold no secret, so they must not be forced to
// 0600 (an earlier build did: a replace-by-rename silently narrowed a 0644
// AGENTS.md to 0600). A NEW file gets the process default, 0o666 under the
// umask (0644 with the usual 022). Replacing an EXISTING file keeps its bits.
// Backups under .tokenlighten/backups/ copy arbitrary user text and stay 0600.
// Windows has no POSIX modes and is left alone.

/** Creation mode of a new shared guide file: the process default (umask applies). */
export const SHARED_FILE_MODE = 0o666;

/** The permission bits of the regular file at `target` a rewrite must keep; undefined when it does not exist (or off POSIX). */
export function existingFileMode(target: string): number | undefined {
  if (process.platform === "win32") return undefined;
  try {
    const stat = lstatSync(target);
    return stat.isFile() ? stat.mode & 0o777 : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Gives the freshly written temporary file the bits of the file it is about to
 * replace. Needed because the creation mode is filtered through the umask.
 * Best effort: a filesystem that refuses chmod keeps the creation mode.
 */
export function keepExistingFileMode(temporary: string, previous: number | undefined): void {
  if (previous === undefined) return;
  try {
    chmodSync(temporary, previous);
  } catch {
    // Not fatal: the content is what matters.
  }
}
