/**
 * exploreTree.ts — compact, byte-capped directory inventory.
 *
 * Serves `explore action=tree` and task_pack's partial-pack `tree` field: a
 * one-line-per-dir file inventory that answers the native
 * `find -type f | sort` need (several bench tasks resorted to it after a
 * partial pack) WITHOUT dumping a full file list — directories beyond `depth`
 * collapse to a "(N files)" count instead of listing every file.
 *
 * Extracted from the inline copy that used to live in server.ts (A7). Two
 * bugs the inline copy carried are fixed here:
 *
 *   1. SubPath rooting: the inline walk fed walkCodeFiles a subPath but then
 *      built the tree from FULL relative paths, so the requested-subdir
 *      prefix consumed the whole depth budget (a request for `src/a/b` at
 *      depth 1 spent that one level of depth on the `src/`→`a/`→`b/` chain
 *      itself and collapsed everything actually under `b/`). Here the subPath
 *      prefix is stripped BEFORE tree construction so `depth` applies BELOW
 *      the requested directory as intended.
 *
 *   2. Cap trim: the inline copy popped the last rendered line and re-joined
 *      the ENTIRE remaining list on every over-cap iteration — O(n^2) in the
 *      number of lines for a large tree. Here lines are accumulated up to the
 *      cap in a single forward pass (accumulate-until-cap), stopping at the
 *      first line that would overflow.
 */

import * as fs from "fs";
import * as path from "path";
import { walkCodeFiles } from "./walkRepo.js";
import { FIND_ACTION_EXTRA_BASENAMES, FIND_ACTION_EXTRA_EXTS } from "../features/search/find/findText.js";
import { resolveReal, isWithin } from "../util/safePath.js";

/** Byte cap for the rendered tree line list (before the mode/root wrapper). */
export const TREE_CAP_BYTES = 2048;

/**
 * Default nesting depth when depth is omitted: 2 expands the walked root's
 * immediate children AND one level below them (their files list individually;
 * a directory nested TWO levels deeper collapses to a count). Bumped from 1 to
 * 2 (G3) — a single expanded level too often collapsed the one directory the
 * agent actually cared about (e.g. `src/services/`), forcing a follow-up call;
 * two levels answers most `find`-style needs in one shot while the byte cap
 * still bounds the payload. The advertised `depth` schema property
 * (server.ts) carries no description text of its own — this default is
 * documented only here.
 */
export const TREE_DEFAULT_DEPTH = 2;

interface TreeDirNode {
  /** POSIX relative path of this directory ("" for the walked root). */
  relPath: string;
  dirs: Map<string, TreeDirNode>;
  files: string[];
}

function newTreeDirNode(relPath: string): TreeDirNode {
  return { relPath, dirs: new Map(), files: [] };
}

/**
 * Normalize a caller-supplied subPath to a POSIX prefix with no leading "./",
 * no leading/trailing slash. Returns "" for undefined / "." / "" (whole-root).
 */
function normalizeSubPath(subPath?: string): string {
  if (!subPath) return "";
  let p = subPath.replace(/\\/g, "/");
  while (p.startsWith("./")) p = p.slice(2);
  p = p.replace(/^\/+/, "").replace(/\/+$/, "");
  return p === "." ? "" : p;
}

/**
 * Build a directory tree from walkCodeFiles' flat, sorted, exclusion-filtered
 * file list — no independent filesystem walk (reuse walkCodeFiles' ordering +
 * exclusion rules verbatim rather than hand-rolling a second one).
 *
 * `stripPrefix` (a normalized subPath, or "") is removed from each file's
 * relative path BEFORE the tree is built, so the tree is ROOTED at the
 * requested subdirectory and `depth` applies below it — not consumed by the
 * requested-directory prefix chain. A file whose path does not start with the
 * prefix is skipped (walkCodeFiles already confines to the subPath, so this
 * only guards the exact-directory-name edge).
 */
function buildTreeFromFiles(files: Array<{ relPath: string }>, stripPrefix: string): TreeDirNode {
  const root = newTreeDirNode("");
  const prefix = stripPrefix ? `${stripPrefix}/` : "";
  for (const f of files) {
    // Exclusion policy lives entirely in walkCodeFiles' shared ignore matcher
    // (DEFAULT_IGNORE + the workspace's own .tokenlightenignore) — no
    // tree-local prefix list, so a user repo's docs/ stays visible unless
    // that repo opts out itself.
    let rel = f.relPath;
    if (prefix) {
      if (!rel.startsWith(prefix)) continue;
      rel = rel.slice(prefix.length);
    }
    if (rel.length === 0) continue;
    const segments = rel.split("/");
    const fileName = segments[segments.length - 1]!;
    let cur = root;
    let curRel = "";
    for (let i = 0; i < segments.length - 1; i++) {
      const seg = segments[i]!;
      curRel = curRel === "" ? seg : `${curRel}/${seg}`;
      let child = cur.dirs.get(seg);
      if (!child) {
        child = newTreeDirNode(curRel);
        cur.dirs.set(seg, child);
      }
      cur = child;
    }
    cur.files.push(fileName);
  }
  return root;
}

/** Total file count under a directory node, recursive. */
function countFilesUnder(node: TreeDirNode): number {
  let n = node.files.length;
  for (const child of node.dirs.values()) n += countFilesUnder(child);
  return n;
}

/**
 * Render a tree node into deterministic, indented lines. Directories at
 * nesting `depth` (0-based from the walked root) collapse to a single
 * "<name>/ (N files)" line; directories nested below `depth` expand to list
 * their own children. Deterministic: TreeDirNode's dirs Map preserves
 * insertion order, which mirrors walkCodeFiles' byte-stable sort since files
 * are inserted in that order.
 */
function renderTreeLines(node: TreeDirNode, depth: number, indent: string, out: string[]): void {
  for (const [name, child] of node.dirs) {
    const fileCount = countFilesUnder(child);
    if (depth <= 0) {
      out.push(`${indent}${name}/ (${fileCount} file${fileCount === 1 ? "" : "s"})`);
    } else {
      out.push(`${indent}${name}/`);
      renderTreeLines(child, depth - 1, `${indent}  `, out);
    }
  }
  for (const file of node.files) {
    out.push(`${indent}${file}`);
  }
}

/**
 * Accumulate rendered lines into a single string up to `capBytes` in ONE
 * forward pass (no quadratic pop-and-rejoin). Stops at the first line that
 * would push the joined result past the cap and appends a truncation marker.
 * Always keeps at least the first line, even if that single line already
 * exceeds the cap, so the result is never empty for a non-empty tree.
 */
function accumulateUntilCap(lines: string[], capBytes: number): { tree: string; truncated: boolean } {
  if (lines.length === 0) return { tree: "", truncated: false };
  const TRUNC_MARKER = "\n… (truncated)";
  const kept: string[] = [];
  let bytes = 0;
  let truncated = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    // Byte cost of adding this line: the line itself plus one "\n" separator
    // for every line after the first.
    const addition = Buffer.byteLength(line, "utf8") + (kept.length > 0 ? 1 : 0);
    if (kept.length > 0 && bytes + addition > capBytes) {
      truncated = true;
      break;
    }
    kept.push(line);
    bytes += addition;
  }
  const tree = truncated ? kept.join("\n") + TRUNC_MARKER : kept.join("\n");
  return { tree, truncated };
}

export interface CompactTree {
  root: string;
  depth: number;
  tree: string;
  truncated: boolean;
  /**
   * G4: set true when the caller-supplied subPath resolved (via realpath) to a
   * location OUTSIDE the workspace — a symlink escape. The tree is empty in
   * that case (nothing under a non-contained root is inventoried).
   */
  refused?: boolean;
  /**
   * Set false when the requested subPath does not exist at all, or exists but
   * is not a directory (as opposed to existing-but-empty, or escaping the
   * workspace). Matches the codebase's existing soft-refusal idiom
   * ({ok:false, reason, ...}) so a caller that already recognizes that shape
   * recognizes this one too — this is still a SERVED response (wrapped in
   * toolOk by the caller), not a transport error.
   */
  ok?: false;
  /** "not-found": nothing at subPath. "not-a-directory": subPath exists but is a file — read_file is the right tool for it, not tree. */
  reason?: "not-found" | "not-a-directory";
  /**
   * Present alongside ok:false/reason:"not-found" or "not-a-directory": the
   * nearest ancestor directory of the requested path that DOES exist, plus
   * its immediate children (names only, capped) — a guessed-wrong directory
   * name is recoverable in one more call instead of a blind retry.
   */
  did_you_mean?: { path: string; children: string[] };
  /** Present only alongside reason:"not-a-directory": the read_file call that actually serves subPath. */
  next?: string;
  /**
   * Present only when the requested path exists and IS a directory but is
   * empty (tree is legitimately "", as opposed to the not-found case above
   * where tree is also "" but for a different reason).
   */
  note?: string;
}

/** Cap on the number of child names listed in a not-found did_you_mean payload. */
const DID_YOU_MEAN_CHILDREN_CAP = 20;

/**
 * G4: resolve a normalized workspace-relative subPath through realpath and
 * confirm the REAL location is still inside the workspace's REAL root — the
 * same symlink-escape guard readFileSafe/safeRealPath apply. walkCodeFiles
 * itself only does a LEXICAL isWithin on the joined path, which a symlinked
 * subdirectory pointing outside the tree would pass while walkDir then follows
 * the link and inventories files outside the workspace. Returns the contained
 * absolute path, or undefined when the subPath escapes / does not resolve.
 * An empty subPath ("") is the whole-workspace root — always contained.
 */
function containedSubPath(workspace: string, normalizedSub: string): string | undefined {
  if (normalizedSub === "") return resolveReal(workspace);
  const workspaceReal = resolveReal(workspace);
  const abs = path.resolve(workspace, normalizedSub);
  // Lexical pre-check (cheap, matches walkCodeFiles) before the realpath probe.
  if (!isWithin(abs, path.resolve(workspace))) return undefined;
  const real = resolveReal(abs);
  return isWithin(real, workspaceReal) ? real : undefined;
}

/**
 * Walk up from `absPath` (an absolute path that may or may not exist) to the
 * nearest ancestor directory that DOES exist, without leaving `workspaceReal`
 * — mirrors the ancestor-walk pattern already used by createFile.ts's
 * path-escape check (`path.dirname` loop, `parent === cur` as the filesystem-
 * root termination guard) and searchReplaceEdit.ts's safeRealpathSync,
 * adapted here to return the found ancestor rather than just validate one.
 * Returns the workspace root itself in the worst case (it always exists by
 * construction — buildCompactTree's caller already resolved it).
 */
function nearestExistingAncestor(absPath: string, workspaceReal: string): string {
  let cur = absPath;
  while (true) {
    try {
      const stat = fs.statSync(cur);
      if (stat.isDirectory()) return cur;
    } catch {
      // Does not exist (or not statable) — keep walking up.
    }
    if (cur === workspaceReal || !isWithin(cur, workspaceReal)) return workspaceReal;
    const parent = path.dirname(cur);
    if (parent === cur) return workspaceReal; // hit filesystem root
    cur = parent;
  }
}

/**
 * Build the did_you_mean payload for a not-found subPath: the nearest
 * existing ancestor (workspace-relative, "." for the workspace root itself)
 * plus its immediate child names (files and directories alike, capped).
 */
function buildDidYouMean(workspace: string, absPath: string): { path: string; children: string[] } {
  const workspaceReal = resolveReal(workspace);
  const ancestorAbs = nearestExistingAncestor(absPath, workspaceReal);
  const relPath = path.relative(workspaceReal, ancestorAbs);
  let children: string[] = [];
  try {
    children = fs.readdirSync(ancestorAbs).sort().slice(0, DID_YOU_MEAN_CHILDREN_CAP);
  } catch {
    children = [];
  }
  return { path: relPath === "" ? "." : relPath.replace(/\\/g, "/"), children };
}

/**
 * Cheap, bounded check for "does this directory have at least one entry on
 * disk" — opens the directory descriptor, reads a single entry, and closes
 * immediately, rather than materializing a full directory listing the way
 * fs.readdirSync would (only presence/absence is needed here). Used to tell
 * a genuinely empty directory apart from one whose entries were all filtered
 * out by the walk's exclusion rules (DEFAULT_IGNORE / .tokenlightenignore).
 */
function directoryHasAnyEntry(absDir: string): boolean {
  try {
    const dir = fs.opendirSync(absDir);
    try {
      return dir.readSync() !== null;
    } finally {
      try {
        dir.closeSync();
      } catch {
        // best-effort close — nothing to recover from here
      }
    }
  } catch {
    return false;
  }
}

/**
 * Build a compact, byte-capped file inventory rooted at `subPath` (or the
 * whole workspace when omitted). Directories beyond `depth` collapse to a
 * "(N files)" count.
 *
 * @param workspace absolute workspace root
 * @param subPath   workspace-relative subdirectory to root the tree at
 * @param depth     nesting depth below the root before dirs collapse to counts
 * @param capBytes  byte cap for the rendered tree text
 */
export function buildCompactTree(
  workspace: string,
  subPath?: string,
  depth?: number,
  capBytes: number = TREE_CAP_BYTES,
): CompactTree {
  const effectiveDepth =
    typeof depth === "number" && depth >= 0 ? Math.floor(depth) : TREE_DEFAULT_DEPTH;
  const normalizedSub = normalizeSubPath(subPath);

  // Nonexistent subPath: an agent that guessed a wrong directory name
  // previously got a silent {tree:"", truncated:false} indistinguishable from
  // a legitimately empty directory, burning a full turn re-guessing blind.
  // Checked BEFORE the symlink-escape guard below (existence is the more
  // fundamental question — a nonexistent path cannot meaningfully "escape").
  // An empty normalizedSub ("") is the workspace root itself, which the
  // caller already resolved to get here — always exists, skip the check.
  if (normalizedSub !== "") {
    const requestedAbs = path.resolve(workspace, normalizedSub);
    let stat: fs.Stats | undefined;
    try {
      stat = fs.statSync(requestedAbs);
    } catch {
      stat = undefined;
    }
    if (stat === undefined) {
      return {
        root: normalizedSub,
        depth: effectiveDepth,
        tree: "",
        truncated: false,
        ok: false,
        reason: "not-found",
        did_you_mean: buildDidYouMean(workspace, requestedAbs),
      };
    }
    // 2026-08-01: subPath exists but isn't a directory (a real file, most
    // often) — distinct from not-found so the caller isn't told to guess a
    // different name when the fix is simply the right tool (read_file).
    if (!stat.isDirectory()) {
      return {
        root: normalizedSub,
        depth: effectiveDepth,
        tree: "",
        truncated: false,
        ok: false,
        reason: "not-a-directory",
        did_you_mean: buildDidYouMean(workspace, requestedAbs),
        next: `read_file path=${normalizedSub}`,
      };
    }
  }

  // G4: refuse a subPath whose realpath escapes the workspace (symlink escape).
  const containedAbs = containedSubPath(workspace, normalizedSub);
  if (containedAbs === undefined) {
    return { root: normalizedSub || ".", depth: effectiveDepth, tree: "", truncated: false, refused: true };
  }

  const files = walkCodeFiles(workspace, {
    ...(normalizedSub ? { subPath: normalizedSub } : {}),
    extraExts: FIND_ACTION_EXTRA_EXTS,
    extraBasenames: FIND_ACTION_EXTRA_BASENAMES,
    includeArtifacts: true,
  });
  const treeRoot = buildTreeFromFiles(files, normalizedSub);

  const lines: string[] = [];
  renderTreeLines(treeRoot, effectiveDepth, "", lines);

  const { tree, truncated } = accumulateUntilCap(lines, capBytes);

  // Existing directory, but the rendered tree is empty. Two different causes
  // read very differently to an agent, so they get different notes:
  //   - genuinely 0 entries on disk -> "empty directory" (nothing to find).
  //   - >=1 entries on disk, all filtered by the shared walk exclusions
  //     (DEFAULT_IGNORE / .tokenlightenignore) -> a distinct note, since
  //     "empty directory" would misleadingly read as "nothing here" when
  //     content exists but is merely out of walk scope.
  if (tree === "") {
    const note = directoryHasAnyEntry(containedAbs)
      ? "empty after walk filters (.tokenlightenignore, built-in defaults, or unsupported file types); read_file({path}) on a known path still works"
      : "empty directory";
    return { root: normalizedSub || ".", depth: effectiveDepth, tree, truncated, note };
  }

  return { root: normalizedSub || ".", depth: effectiveDepth, tree, truncated };
}
