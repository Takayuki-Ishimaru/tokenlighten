// Plain data only — no meta envelope, no 'tokenlighten:meta' wrappers.
// Reason: docs/00-postmortem.md §2.2

/**
 * Pure content/directory hashing module.
 * Uses Node's built-in `crypto` only (no new deps).
 */

import { createHash } from "node:crypto";
import type { IndexedFileV1, DirectoryDigestV1 } from "./indexStore.js";

// ---------------------------------------------------------------------------
// Content hashing
// ---------------------------------------------------------------------------

/**
 * Compute sha256 hex of a buffer.
 */
export function hashContent(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

/**
 * Compute a stable hash of a set of ignore patterns (sorted for determinism).
 */
export function hashIgnorePatterns(patterns: string[]): string {
  const sorted = [...patterns].sort();
  return createHash("sha256")
    .update(JSON.stringify({ patterns: sorted }))
    .digest("hex");
}

// ---------------------------------------------------------------------------
// Directory digest computation
// ---------------------------------------------------------------------------

function sha256hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/**
 * Build bottom-up directory digests from a flat list of indexed files.
 *
 * Each directory's hash = sha256 of sorted "<name>\t<childHash>\n" lines.
 * An empty directory = sha256("").
 *
 * Returns:
 *   - root: hash of the top-level directory (key "")
 *   - directories: Record keyed by directory POSIX path ("", "src", "src/core", …)
 */
export function buildDirectoryDigests(
  files: IndexedFileV1[],
): { root: string; directories: Record<string, DirectoryDigestV1> } {
  if (files.length === 0) {
    const emptyHash = sha256hex("");
    const rootDigest: DirectoryDigestV1 = { path: "", childHashes: {}, hash: emptyHash };
    return { root: emptyHash, directories: { "": rootDigest } };
  }

  // Step 1: Build a set of all directory paths that appear in the tree,
  //         and for each file, record it as a child of its parent directory.
  //
  // dirFileChildren[dirPath] = Map<childName, contentSha256>
  // (only file children — directory children added in step 2)
  const dirFileChildren = new Map<string, Map<string, string>>();

  // Ensure root always exists.
  dirFileChildren.set("", new Map());

  for (const file of files) {
    const parts = file.path.split("/");

    // Ensure all ancestor directories exist.
    for (let i = 0; i <= parts.length; i++) {
      const dirPath = parts.slice(0, i).join("/");
      if (!dirFileChildren.has(dirPath)) dirFileChildren.set(dirPath, new Map());
    }

    // Register the file as a child of its immediate parent directory.
    const parentPath = parts.slice(0, parts.length - 1).join("/");
    const fileName = parts[parts.length - 1]!;
    dirFileChildren.get(parentPath)!.set(fileName, file.contentSha256);
  }

  // Step 2: Determine which directories are children of which parent.
  //         Register each subdir as a child of its parent dir.
  //         We track this separately so we can fill in dir hashes after computation.
  // dirSubdirChildren[dirPath] = Set<childDirName>  (just names, not full paths)
  const dirSubdirChildren = new Map<string, Set<string>>();
  for (const dirPath of dirFileChildren.keys()) {
    if (!dirSubdirChildren.has(dirPath)) dirSubdirChildren.set(dirPath, new Set());
    if (dirPath === "") continue;
    const parts = dirPath.split("/");
    const parentPath = parts.slice(0, parts.length - 1).join("/");
    const dirName = parts[parts.length - 1]!;
    if (!dirSubdirChildren.has(parentPath)) dirSubdirChildren.set(parentPath, new Set());
    dirSubdirChildren.get(parentPath)!.add(dirName);
  }

  // Step 3: Compute directory hashes bottom-up (deepest first).
  // Sort by depth descending, then lexically for determinism.
  const allDirs = Array.from(dirFileChildren.keys());
  allDirs.sort((a, b) => {
    const depthA = a === "" ? 0 : a.split("/").length;
    const depthB = b === "" ? 0 : b.split("/").length;
    const depthDiff = depthB - depthA;
    if (depthDiff !== 0) return depthDiff;
    return a < b ? -1 : a > b ? 1 : 0;
  });

  const dirHashes = new Map<string, string>();

  for (const dirPath of allDirs) {
    // Collect all children: files first, then subdirectories.
    const fileChildren = dirFileChildren.get(dirPath) ?? new Map<string, string>();
    const subdirChildren = dirSubdirChildren.get(dirPath) ?? new Set<string>();

    // Build combined child entries: name → hash
    const allChildEntries: Array<[string, string]> = [];

    // File entries.
    for (const [name, sha] of fileChildren) {
      allChildEntries.push([name, sha]);
    }

    // Subdirectory entries (use computed hash from previous iteration).
    for (const subdirName of subdirChildren) {
      const childDirPath = dirPath === "" ? subdirName : `${dirPath}/${subdirName}`;
      const childHash = dirHashes.get(childDirPath) ?? sha256hex(""); // fallback shouldn't happen
      allChildEntries.push([subdirName, childHash]);
    }

    // Sort by name for determinism.
    allChildEntries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

    const hashInput = allChildEntries.map(([name, h]) => `${name}\t${h}\n`).join("");
    dirHashes.set(dirPath, sha256hex(hashInput));
  }

  // Step 4: Build output DirectoryDigestV1 records.
  const directories: Record<string, DirectoryDigestV1> = {};
  for (const dirPath of Array.from(dirFileChildren.keys()).sort()) {
    const fileChildren = dirFileChildren.get(dirPath) ?? new Map<string, string>();
    const subdirChildren = dirSubdirChildren.get(dirPath) ?? new Set<string>();

    const childHashes: Record<string, string> = {};

    for (const [name, sha] of fileChildren) {
      childHashes[name] = sha;
    }
    for (const subdirName of subdirChildren) {
      const childDirPath = dirPath === "" ? subdirName : `${dirPath}/${subdirName}`;
      childHashes[subdirName] = dirHashes.get(childDirPath)!;
    }

    // Sort childHashes by key.
    const sortedChildHashes: Record<string, string> = {};
    for (const key of Object.keys(childHashes).sort()) {
      sortedChildHashes[key] = childHashes[key]!;
    }

    directories[dirPath] = {
      path: dirPath,
      childHashes: sortedChildHashes,
      hash: dirHashes.get(dirPath)!,
    };
  }

  return { root: dirHashes.get("")!, directories };
}
