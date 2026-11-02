import { chmodSync, lstatSync } from "node:fs";

/**
 * Permission policy for files the CLI writes by replacing them (temp file +
 * rename).
 *
 * - `shared`: project files meant to be read by teammates, CI and containers
 *   running as another user (`.mcp.json`, `.vscode/*.json`, `.codex/config.toml`,
 *   `.github/hooks/*`). They hold no secrets of TokenLighten's own: the server
 *   entry carries launcher paths and `TOKENLIGHTEN_*` markers only. A new file
 *   gets the process default (0o666 under the umask, 0644 with the usual 022),
 *   a new directory 0o777 under the umask, exactly as `touch`/`mkdir`/git do.
 * - `private`: per-user state and files that can hold secrets (the workspace
 *   registry, user-scope host configs such as ~/.claude.json that carry other
 *   servers' tokens, ownership records, locks, backups): 0o600 / 0o700.
 *
 * Either way, replacing an EXISTING file keeps its permission bits: a rewrite
 * must neither widen a file the user locked down nor lock a file the team reads.
 * Windows has no POSIX modes; the bits are advisory there and left alone.
 */
export type FileVisibility = "shared" | "private";

export function createFileMode(visibility: FileVisibility): number {
  return visibility === "shared" ? 0o666 : 0o600;
}

export function createDirectoryMode(visibility: FileVisibility): number {
  return visibility === "shared" ? 0o777 : 0o700;
}

/** The permission bits of the regular file at `target` that a rewrite must keep; undefined when it does not exist (or off POSIX). */
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
 * Gives the freshly written temporary file `temporary` the permission bits of
 * the file it is about to replace (`previous`, from {@link existingFileMode}).
 * A chmod is needed because the creation mode is filtered through the umask.
 * Best effort: a filesystem that refuses chmod keeps the creation mode.
 */
export function keepExistingFileMode(temporary: string, previous: number | undefined): void {
  if (previous === undefined) return;
  try {
    chmodSync(temporary, previous);
  } catch {
    // Not fatal: the content is what matters; the mode stays as created.
  }
}
