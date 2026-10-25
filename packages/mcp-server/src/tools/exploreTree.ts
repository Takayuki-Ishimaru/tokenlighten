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
import type { JsonValue, ToolCall } from "@tokenlighten/types";
import { walkCodeFiles, createWalkOmissions, type WalkOmissions } from "./walkRepo.js";
import { FIND_ACTION_EXTRA_BASENAMES, FIND_ACTION_EXTRA_EXTS } from "../features/search/find/findText.js";
import { resolveReal, isWithin } from "../util/safePath.js";
// TPB (2026-10-10): the paged tree's continuation cursor is a self-contained
// `continuation` handle — the same signed, workspace-bound, expiring token
// `findReferences.ts`'s legacy cursor uses — and its page is sized against the
// `search.tree` wire row and the funnel's tokens->bytes ratio.
import { mintContinuationHandle, resolveContinuationHandle } from "../state/stateHandles.js";
import { rememberTreeCursorRoot, treeCursorRoot } from "../state/session.js";
import { shaOfText } from "../util/handles.js";
import { budgetFor, estimateBytesFromTokens } from "../protocol/budget/wireBudget.js";

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
 *
 * C3 (2026-09-03, INV-C F3): an ABSOLUTE `subPath` is resolved against
 * `workspace` the same way `find`/`references` already correctly resolve
 * theirs elsewhere in this codebase (a bare `path.resolve(workspace, raw)`,
 * whose Node semantics return an absolute `raw` untouched, then a
 * workspace-relative form via `path.relative`) — checked on the RAW string,
 * before the backslash-to-forward-slash rewrite below, so a platform-native
 * absolute path (e.g. a Windows drive path) is still detected correctly.
 *
 * Previously EVERY leading "/" was unconditionally stripped
 * (`p.replace(/^\/+/, "")`) and the remainder treated as workspace-RELATIVE,
 * so an absolute path under the workspace — including the workspace root
 * itself — silently resolved to a path that does not exist
 * (`<workspace>/<workspace-without-its-leading-slash>`) and was refused
 * `not-found`, for a directory the very same session could freely
 * `find`/`references` a moment earlier (measured: `tl_search_files
 * {action:"tree", path:"<ws>"}` on the workspace's own absolute path).
 *
 * An absolute `subPath` that resolves OUTSIDE `workspace` entirely yields a
 * `path.relative` result starting with ".." (or, cross-drive on Windows, one
 * that is still absolute) — passed straight through, unchanged, into the
 * SAME `p.replace(/^\/+/, "")`/`containedSubPath` pipeline a relative "../x"
 * escape already goes through below, so it refuses via the EXISTING
 * `path-outside-workspace` shape rather than a new one.
 */
function normalizeSubPath(workspace: string, subPath?: string): string {
  if (!subPath) return "";
  if (path.isAbsolute(subPath)) {
    const abs = path.resolve(subPath);
    const workspaceAbs = path.resolve(workspace);
    const rel = path.relative(workspaceAbs, abs).replace(/\\/g, "/");
    return rel === "" || rel === "." ? "" : rel;
  }
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

/** Appended to the `tree` text of a page that stops short of the end of the listing. */
const TRUNC_MARKER = "\n… (truncated)";

/**
 * Accumulate rendered lines into a single string up to `capBytes` in ONE
 * forward pass (no quadratic pop-and-rejoin). Stops at the first line that
 * would push the joined result past the cap and appends a truncation marker.
 * Always keeps at least the first line, even if that single line already
 * exceeds the cap, so the result is never empty for a non-empty tree.
 *
 * TPB (2026-10-10): starts at `offset` (a continuation page resumes the same
 * listing there) and reports `end`, the first line it did NOT keep.
 */
function accumulateUntilCap(
  lines: string[],
  capBytes: number,
  offset = 0,
): { tree: string; truncated: boolean; end: number } {
  if (lines.length <= offset) return { tree: "", truncated: false, end: lines.length };
  const kept: string[] = [];
  let bytes = 0;
  let truncated = false;
  let end = offset;
  for (let i = offset; i < lines.length; i++) {
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
    end = i + 1;
  }
  const tree = truncated ? kept.join("\n") + TRUNC_MARKER : kept.join("\n");
  return { tree, truncated, end };
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
  /** "not-found": nothing at subPath. "not-a-directory": subPath exists but is a file — tl_read_file is the right tool for it, not tree. */
  reason?: "not-found" | "not-a-directory";
  /**
   * Present alongside ok:false/reason:"not-found" or "not-a-directory": the
   * nearest ancestor directory of the requested path that DOES exist, plus
   * its immediate children (names only, capped) — a guessed-wrong directory
   * name is recoverable in one more call instead of a blind retry.
   */
  did_you_mean?: { path: string; children: string[] };
  /** Present only alongside reason:"not-a-directory": the tl_read_file call that actually serves subPath. */
  next?: ToolCall;
  /**
   * TPB (2026-10-10): present only on a page `buildTreeResponse` cut short —
   * the `tl_search_files` call that serves the rest of the SAME listing from
   * the line this page stopped at (`cursor`), with the scope and the budget
   * this call declared. `protocol/searchFamily.ts`'s `projectTree` folds it
   * into `limit:{cause:"wire",next}`.
   */
  next_call?: ToolCall;
  /**
   * Present only when the requested path exists and IS a directory but is
   * empty (tree is legitimately "", as opposed to the not-found case above
   * where tree is also "" but for a different reason).
   */
  note?: string;
  /**
   * PI-08 (DESIGN-v0.10-expansion-plan-reconciliation.md §2 row PI-08 +
   * DESIGN-v0.10-expansion-plan-v1.3.md:1610-1699): additive-optional
   * per-response accounting of what the walk actually saw, so a caller
   * cannot mistake a filtered/partial listing for a complete repository
   * inventory the way a bare `tree` string invites. Present on every
   * response that actually walked the filesystem (both non-empty and
   * empty-after-filters trees); absent on the early refused / not-found /
   * not-a-directory returns above, since those never walk at all — there is
   * nothing to report scope over.
   */
  scope_report?: TreeScopeReport;
}

/** See `CompactTree.scope_report`. */
export interface TreeScopeReport {
  /**
   * "complete": every walked entry landed in `returned`, `excluded`, or
   * `errors`, AND the byte cap did not cut the rendered `tree`.
   * "partial": the byte cap truncated the rendered listing (the sibling
   * `truncated` flag) OR at least one subtree could not even be read
   * (WalkOmissions.unreadable_dirs > 0) — either way this response is a
   * SUBSET of what a full traversal would show, and a repository-wide
   * absence claim built on it would be certifying over an unknown
   * remainder (the same gate PI-04/F-A1-2 applies to `find`'s absence
   * certificate).
   */
  completeness: "complete" | "partial";
  counts: {
    /** = returned + excluded + errors, BY CONSTRUCTION — see buildScopeReport. */
    visited: number;
    /** Files that made it into the rendered tree (walkCodeFiles' FoundFile[] count). */
    returned: number;
    /** Sum of `excluded_by_reason`'s 8 values. */
    excluded: number;
    /** Subtrees the walker could not even read (WalkOmissions.unreadable_dirs). */
    errors: number;
  };
  /**
   * One key per WalkOmissions EXCLUSION reason — 8 of its fields
   * (`unreadable_dirs` is an ERROR, folded into `counts.errors` instead, and
   * `outside_workspace` never reaches this walk: `buildCompactTree`'s own
   * `containedSubPath` boundary check refuses before any walk runs — see
   * buildScopeReport's doc comment). All 8 keys are always present, even at
   * 0: an honest zero rather than an omitted key, so this object's own
   * values always sum to exactly `counts.excluded`.
   *
   * FX-R1 (2026-09-03, round-18B review finding 1): `source_only_excluded`
   * added — a walkRepo.ts `SOURCE_ONLY_EXCLUDED_*` skip (`.tokenlighten/
   * cache|index/`, `coverage/`) is a deliberate, product-code-level
   * exclusion like `ignored`, so it is disclosed the same way rather than
   * silently vanishing the way the removed `runs/` generalization did.
   */
  excluded_by_reason: {
    ignored: number;
    gitignored: number;
    tokenlighten_ignored: number;
    oversize: number;
    symlinks: number;
    non_text: number;
    secrets: number;
    source_only_excluded: number;
  };
}

/**
 * Project a WalkOmissions collector (walkRepo.ts) plus the walk's own
 * returned-file count into the lean `scope_report` PI-08 adds to
 * `search.tree`. Keeps `errors` (WalkOmissions.unreadable_dirs) OUT of
 * `excluded_by_reason` on purpose: a directory the walker could not even
 * `readdir()` was never classified into an exclusion reason at all, so
 * folding it into `excluded_by_reason` would make that object's own sum
 * stop matching `counts.excluded` — the plan's own acceptance criterion
 * ("excluded count and per-reason count sum must match",
 * DESIGN-v0.10-expansion-plan-v1.3.md:1692).
 *
 * `counts.visited` is DERIVED as `returned + excluded + errors` rather than
 * independently tracked, so the `visited = returned + excluded + errors`
 * invariant holds BY CONSTRUCTION, not by hoping two separately-maintained
 * counters stay in sync.
 *
 * ONE PRIMARY REASON PER ENTRY — verified directly against walkRepo.ts, not
 * assumed: `classifyIgnored` returns at most one of
 * ignored/gitignored/tokenlighten_ignored per entry (an `if (layer) { om[layer]
 * += 1; continue/return; }` short-circuit); `oversize`/`secrets`/`non_text`
 * are each gated on the entry having already survived every earlier check in
 * the same `if`/`else if` chain, so at most one of them fires per file;
 * `symlinks` fires only for `entry.isSymbolicLink()`, which is mutually
 * exclusive with every file/directory branch; `unreadable_dirs` fires only
 * on an early `return` from a `readdirSync` failure, before any child entry
 * (and therefore any other counter) is ever touched. No entry can land under
 * two reasons, so summing `excluded_by_reason`'s 8 values never double-counts
 * (`source_only_excluded` is likewise mutually exclusive with the rest —
 * `isSourceOnlyExcludedPath` is checked only after `classifyIgnored` already
 * declined to claim the entry, see walkRepo.ts's walkDir).
 */
function buildScopeReport(
  omissions: WalkOmissions,
  returned: number,
  truncated: boolean,
): TreeScopeReport {
  const excluded_by_reason = {
    ignored: omissions.ignored,
    gitignored: omissions.gitignored,
    tokenlighten_ignored: omissions.tokenlighten_ignored,
    oversize: omissions.oversize,
    symlinks: omissions.symlinks,
    non_text: omissions.non_text,
    secrets: omissions.secrets,
    source_only_excluded: omissions.source_only_excluded,
  };
  const excluded =
    excluded_by_reason.ignored +
    excluded_by_reason.gitignored +
    excluded_by_reason.tokenlighten_ignored +
    excluded_by_reason.oversize +
    excluded_by_reason.symlinks +
    excluded_by_reason.non_text +
    excluded_by_reason.secrets +
    excluded_by_reason.source_only_excluded;
  const errors = omissions.unreadable_dirs;
  const visited = returned + excluded + errors;
  const completeness: "complete" | "partial" = truncated || errors > 0 ? "partial" : "complete";
  return { completeness, counts: { visited, returned, excluded, errors }, excluded_by_reason };
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

/** The nesting depth a tree call renders at: the caller's, else TREE_DEFAULT_DEPTH. */
function effectiveTreeDepth(depth?: number): number {
  return typeof depth === "number" && depth >= 0 ? Math.floor(depth) : TREE_DEFAULT_DEPTH;
}

/**
 * TPB (2026-10-10): the WHOLE rendered listing of one `(root, depth)` — what
 * `buildCompactTree` caps once and `buildTreeResponse` pages through.
 */
interface TreeListing {
  /** The root as a response names it: the normalized subPath, or "." for the workspace. */
  root: string;
  /** The normalized subPath ("" for the workspace root) — what a tree cursor is bound to. */
  normalizedSub: string;
  /** The nesting depth the listing was rendered at. */
  depth: number;
  /** Every rendered line, in listing order. */
  lines: string[];
  /** The walk's own accounting, for `scope_report`. */
  omissions: WalkOmissions;
  returned: number;
  /** The root's realpath, for the empty-tree note. */
  containedAbs: string;
}

type PreparedTreeListing = { ok: true; listing: TreeListing } | { ok: false; result: CompactTree };

/** The note an EXISTING directory with an empty listing carries — see `buildCompactTree`. */
function emptyTreeNote(containedAbs: string): string {
  return directoryHasAnyEntry(containedAbs)
    ? "empty after walk filters (.tokenlightenignore, built-in defaults, or unsupported file types); tl_read_file({path}) on a known path still works"
    : "empty directory";
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
  const prepared = prepareTreeListing(workspace, subPath, depth);
  if (!prepared.ok) return prepared.result;
  const { listing } = prepared;

  const { tree, truncated } = accumulateUntilCap(listing.lines, capBytes);
  const scope_report = buildScopeReport(listing.omissions, listing.returned, truncated);

  // Existing directory, but the rendered tree is empty. Two different causes
  // read very differently to an agent, so they get different notes:
  //   - genuinely 0 entries on disk -> "empty directory" (nothing to find).
  //   - >=1 entries on disk, all filtered by the shared walk exclusions
  //     (DEFAULT_IGNORE / .tokenlightenignore) -> a distinct note, since
  //     "empty directory" would misleadingly read as "nothing here" when
  //     content exists but is merely out of walk scope.
  // scope_report is built from the SAME omissions/files/truncated triple as
  // both branches below, so a fully-filtered tree's counts (returned:0,
  // excluded>0) and its "empty after walk filters" note always agree — PI-08
  // item 4.
  if (tree === "") {
    return { root: listing.root, depth: listing.depth, tree, truncated, note: emptyTreeNote(listing.containedAbs), scope_report };
  }

  return { root: listing.root, depth: listing.depth, tree, truncated, scope_report };
}

/**
 * Validate `subPath`, walk it and render every line — everything
 * `buildCompactTree` did before its cap, unchanged. `ok:false` carries the
 * early not-found / not-a-directory / symlink-escape answer as-is.
 */
function prepareTreeListing(workspace: string, subPath?: string, depth?: number): PreparedTreeListing {
  const effectiveDepth = effectiveTreeDepth(depth);
  const normalizedSub = normalizeSubPath(workspace, subPath);

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
        ok: false,
        result: {
          root: normalizedSub,
          depth: effectiveDepth,
          tree: "",
          truncated: false,
          ok: false,
          reason: "not-found",
          did_you_mean: buildDidYouMean(workspace, requestedAbs),
        },
      };
    }
    // 2026-08-01: subPath exists but isn't a directory (a real file, most
    // often) — distinct from not-found so the caller isn't told to guess a
    // different name when the fix is simply the right tool (tl_read_file).
    if (!stat.isDirectory()) {
      return {
        ok: false,
        result: {
          root: normalizedSub,
          depth: effectiveDepth,
          tree: "",
          truncated: false,
          ok: false,
          reason: "not-a-directory",
          did_you_mean: buildDidYouMean(workspace, requestedAbs),
          next: { tool: "tl_read_file", arguments: { targets: [{ path: normalizedSub }], content: "auto" } },
        },
      };
    }
  }

  // G4: refuse a subPath whose realpath escapes the workspace (symlink escape).
  const containedAbs = containedSubPath(workspace, normalizedSub);
  if (containedAbs === undefined) {
    return { ok: false, result: { root: normalizedSub || ".", depth: effectiveDepth, tree: "", truncated: false, refused: true } };
  }

  const omissions = createWalkOmissions();
  const files = walkCodeFiles(workspace, {
    ...(normalizedSub ? { subPath: normalizedSub } : {}),
    extraExts: FIND_ACTION_EXTRA_EXTS,
    extraBasenames: FIND_ACTION_EXTRA_BASENAMES,
    includeArtifacts: true,
    // PI-08 (reconciliation doc §2 row PI-08 + F-A1 findings): honor
    // .gitignore exactly like `find` already does — every one of
    // findText.ts's walkCodeFiles call sites passes respectGitignore:true.
    // Before this, the SAME workspace answered "what's here" differently
    // depending which tool asked: a .gitignore-only-excluded path was
    // invisible to `find` but still listed by `tree`. This is a DELIBERATE
    // behavior change (recorded in the reconciliation doc, not an
    // incidental side effect of the omissions plumbing below) — a
    // .gitignore-only exclusion now counts under scope_report's
    // `gitignored` reason, same vocabulary `find`'s own `omitted.gitignored`
    // already uses.
    respectGitignore: true,
    omissions,
  });
  const treeRoot = buildTreeFromFiles(files, normalizedSub);

  const lines: string[] = [];
  renderTreeLines(treeRoot, effectiveDepth, "", lines);

  return {
    ok: true,
    listing: {
      root: normalizedSub || ".",
      normalizedSub,
      depth: effectiveDepth,
      lines,
      omissions,
      returned: files.length,
      containedAbs,
    },
  };
}

// ---------------------------------------------------------------------------
// TPB (2026-10-10 independent runtime review): `search.tree` honours
// `budget.bytes`, and a truncated tree carries an executable continuation.
//
// THE MEASURED DEFECT. `tl_search_files {action:"tree"}` ignored the caller's
// budget. Every call cut the rendered listing at TREE_CAP_BYTES (2048 B of
// text): `budget.bytes:4000`, `16000` and `64000` all returned the same
// 2.5 KB page, and a cut listing said `limit:{cause:"capped"}` with no
// `next`, so the rest of it was reachable only by guessing a subdirectory.
// Below the default page a declared budget fared no better: the wire ladder
// halved the text and named a SHALLOWER tree (not the remainder), and at
// `depth:1` it had nothing to name at all — `refusal{cap-exceeded}`, no
// `next` (`depth:1`, `budget.bytes:1000`, a 1.1 KB listing).
//
// THE FIX — one listing, paged (`buildTreeResponse`):
//  - a page is the listing's lines `[offset, end)`. With no declared budget it
//    is the legacy TREE_CAP_BYTES of text, so the default page is unchanged;
//    with `budget.bytes`/`budget.tokens` it is as many whole lines as keep the
//    RESPONSE within the tighter of the two (tokens at the funnel's own ratio)
//    and the `search.tree` wire row — the `tree` value priced as the JSON
//    string the wire carries, the envelope around it measured (`fitTreePage`,
//    `treePageEnvelopeBytes`). A budget that cannot hold one line beside the
//    envelope is refused `budget-below-minimum`, the floor named;
//  - a page that stops short carries `next_call`: the same scope, the budget
//    this call declared, and a cursor naming the line it stopped at.
//    `projectTree` (protocol/searchFamily.ts) folds it into
//    `limit:{cause:"wire",next}`;
//  - the cursor is a self-contained `continuation` handle (MAC'd, workspace-
//    bound, expiring — `state/stateHandles.ts`), bound to the root and depth it
//    was minted for and to a digest of the WHOLE listing. A resume re-walks and
//    serves the next lines only while that digest is unchanged; otherwise it is
//    refused `cursor-stale` with the restart call as its `next` — pages of one
//    listing are never mixed across a changed walk.
// `projectTree`'s [R5-9] note held that a continuation would have to name a
// SUBTREE, a choice only the caller can make. The cursor names the rest of the
// SAME listing instead, which needs no choice at all.
//
// ATP (2026-10-10): the archive-scoped tree (`tools/archiveTreePage.ts`) pages
// its member listing with the same pieces — `fitTreePage`,
// `searchTreePageEnvelopeBytes`/`searchTreePageBytes`, `declaredTreePageBytes`,
// `treeBudgetArguments`, `digest16` — so both variants of `search.tree` cut,
// price and continue a page one way (and the two G8 measurement sites below
// serve both).
// ---------------------------------------------------------------------------

/**
 * Bytes added to every measured page envelope. Over-reserving only ends a page
 * one line early; under-reserving would hand the page to the wire ladder,
 * whose tree rung trims lines and names a shallower tree instead.
 */
const TREE_PAGE_ENVELOPE_SAFETY_MARGIN_BYTES = 64;

/** A string's bytes inside the JSON the wire carries, without its two quotes. */
function jsonStringBodyBytes(text: string): number {
  return Buffer.byteLength(JSON.stringify(text), "utf8") - 2;
}

/** One "\n" between two lines of a page: two bytes once JSON-escaped. */
const TREE_LINE_SEPARATOR_JSON_BYTES = 2;

export type TreePageFit =
  | { ok: true; end: number; truncated: boolean }
  | { ok: false; requiredTextBytes: number };

/** How `fitTreePage` cuts a page; the defaults are the workspace tree's. */
export interface TreePageFitOptions {
  /**
   * JSON bytes a page that stops short appends to its text — the workspace
   * tree's TRUNC_MARKER (the default). The archive tree appends none: its
   * lines are member paths, and `limit` alone says the page stopped short.
   */
  markerBytes?: number;
  /** At most this many lines per page (the archive tree's legacy 200-member page); unbounded by default. */
  maxLines?: number;
}

/**
 * Cut a page from `offset` for a declared budget, on whole lines. The `tree`
 * value is priced as its JSON string, quotes included. `completeRoom` is the
 * room for it when the page ends the listing (no `limit` rides that page);
 * `truncatedRoom` the room when it does not (the `limit.next` envelope is
 * larger, and the text grows the truncation marker). A page that cannot take
 * even one line never ships empty — that would advance nothing and name the
 * same cursor again — and names, for the caller's `budget-below-minimum`
 * floor, the text bytes the LONGEST remaining line needs: every later page of
 * the listing carries the same envelope, so a caller who re-issues at that
 * floor pages through the rest without being refused again.
 */
export function fitTreePage(
  lines: readonly string[],
  offset: number,
  completeRoom: number,
  truncatedRoom: number,
  options: TreePageFitOptions = {},
): TreePageFit {
  if (offset >= lines.length) return { ok: true, end: lines.length, truncated: false };
  const cost = (i: number): number =>
    jsonStringBodyBytes(lines[i]!) + (i > offset ? TREE_LINE_SEPARATOR_JSON_BYTES : 0);
  const pageEnd = options.maxLines === undefined ? lines.length : Math.min(lines.length, offset + options.maxLines);

  // The whole remainder as one complete page? Pricing stops the moment it
  // cannot be, so a long listing is never priced past one page's worth.
  if (pageEnd === lines.length) {
    let whole = 2;
    let next = offset;
    while (next < lines.length && whole <= completeRoom) whole += cost(next++);
    if (next === lines.length && whole <= completeRoom) return { ok: true, end: lines.length, truncated: false };
  }

  // Otherwise as many whole lines as fit beside the continuation.
  const markerBytes = options.markerBytes ?? jsonStringBodyBytes(TRUNC_MARKER);
  let used = 2 + markerBytes;
  let end = offset;
  while (end < pageEnd) {
    const lineCost = cost(end);
    if (used + lineCost > truncatedRoom) break;
    used += lineCost;
    end += 1;
  }
  if (end > offset) return { ok: true, end, truncated: end < lines.length };

  let longest = 0;
  for (let i = offset; i < lines.length; i++) longest = Math.max(longest, cost(i));
  return { ok: false, requiredTextBytes: 2 + markerBytes + longest };
}

/**
 * The bytes a `search.tree` page carries besides its `tree` text: `{v, kind,
 * tree:"", ...fields}` — `fields` being the page's other wire members (the
 * workspace tree's `root`/`depth`/`scope_report`, the archive tree's
 * `root`/`archive`) — and, on a page that stops short, `limit:{cause, omitted,
 * next}` with the continuation's arguments as the wire will show them —
 * measured in ONE trial serialization, a Class-C pre-shed admission
 * measurement of the page being built (`wireBudgetG8Fence.spec.ts`), never of
 * an already-decided response. Includes TREE_PAGE_ENVELOPE_SAFETY_MARGIN_BYTES.
 */
export function searchTreePageEnvelopeBytes(
  fields: Readonly<Record<string, unknown>>,
  nextArguments?: Record<string, unknown>,
): number {
  const envelope: Record<string, unknown> = { v: 1, kind: "search.tree", ...fields, tree: "" };
  if (nextArguments !== undefined) {
    envelope["limit"] = {
      cause: "wire",
      omitted: ["results"],
      next: { tool: "tl_search_files", arguments: nextArguments },
    };
  }
  return Buffer.byteLength(JSON.stringify(envelope), "utf8") + TREE_PAGE_ENVELOPE_SAFETY_MARGIN_BYTES;
}

/**
 * The exact bytes of a COMPLETE `search.tree` page `{v, kind, ...fields,
 * tree:text}` — no `limit`, no safety margin. The archive tree uses it to keep
 * its no-budget answer byte-identical to the unpaged one wherever that answer
 * fitted the wire row (`tools/archiveTreePage.ts`).
 */
export function searchTreePageBytes(fields: Readonly<Record<string, unknown>>, text: string): number {
  return searchTreePageEnvelopeBytes(fields) - TREE_PAGE_ENVELOPE_SAFETY_MARGIN_BYTES + jsonStringBodyBytes(text);
}

/** The workspace tree's page envelope — `{root, depth, scope_report}` around the text. */
function treePageEnvelopeBytes(input: {
  listing: TreeListing;
  scopeReport: TreeScopeReport;
  nextArguments?: Record<string, unknown>;
}): number {
  return searchTreePageEnvelopeBytes(
    { root: input.listing.root, depth: input.listing.depth, scope_report: input.scopeReport },
    input.nextArguments,
  );
}

/** A caller-declared tree budget — the canonical `budget.bytes`/`budget.tokens`. */
export interface TreeBudget {
  bytes?: number;
  tokens?: number;
}

/** The tighter of the two declared ceilings, tokens at the funnel's ratio; `undefined` when neither was declared. */
export function declaredTreePageBytes(budget: TreeBudget): number | undefined {
  const bytes = typeof budget.bytes === "number" && Number.isFinite(budget.bytes) && budget.bytes > 0
    ? Math.floor(budget.bytes)
    : undefined;
  const tokenBytes = estimateBytesFromTokens(budget.tokens);
  if (bytes === undefined) return tokenBytes;
  return tokenBytes === undefined ? bytes : Math.min(bytes, tokenBytes);
}

/** The `budget` a tree continuation echoes: the caller's positive `bytes`/`tokens` as declared, or `undefined`. */
export function treeBudgetArguments(budget: TreeBudget): Record<string, JsonValue> | undefined {
  const declared: Record<string, JsonValue> = {};
  if (typeof budget.bytes === "number" && budget.bytes > 0) declared["bytes"] = budget.bytes;
  if (typeof budget.tokens === "number" && budget.tokens > 0) declared["tokens"] = budget.tokens;
  return Object.keys(declared).length > 0 ? declared : undefined;
}

/** The canonical `tl_search_files` tree call for `(root, depth)` under `budget` — a continuation adds `cursor`. */
function treeCallArguments(root: string, depth: number, budget: TreeBudget): Record<string, JsonValue> {
  const declared = treeBudgetArguments(budget);
  return {
    action: "tree",
    scope: { path: root, depth },
    ...(declared !== undefined ? { budget: declared } : {}),
  };
}

/** The first 16 hex digits of a sha256 — a binding digest, not a content address. */
export function digest16(text: string): string {
  return shaOfText(text).slice("sha256:".length, "sha256:".length + 16);
}

/** What a tree cursor's authenticated (not encrypted) tail carries — no path, no content. */
interface TreeCursorPayload {
  v: 1;
  t: "tree";
  /** Digest of the normalized root the listing was rendered for. */
  r: string;
  /** The depth the listing was rendered at. */
  d: number;
  /** Digest of the whole listing. */
  s: string;
  /** The first listing line the next page serves. */
  o: number;
}

/** A tree cursor's `r`: the digest of the normalized root its listing was rendered for. */
function treeRootDigest(normalizedSub: string): string {
  return digest16(`tree-root\u0000${normalizedSub}`);
}

/** `listingDigest` is `digest16` of the whole listing, computed once per call. */
function treeCursorPayload(listing: TreeListing, listingDigest: string, offset: number): TreeCursorPayload {
  return {
    v: 1,
    t: "tree",
    r: treeRootDigest(listing.normalizedSub),
    d: listing.depth,
    s: listingDigest,
    o: offset,
  };
}

function readTreeCursorPayload(value: unknown): TreeCursorPayload | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const p = value as Record<string, unknown>;
  if (p["v"] !== 1 || p["t"] !== "tree") return undefined;
  if (typeof p["r"] !== "string" || typeof p["s"] !== "string") return undefined;
  if (typeof p["d"] !== "number" || !Number.isInteger(p["d"]) || p["d"] < 0) return undefined;
  if (typeof p["o"] !== "number" || !Number.isInteger(p["o"]) || p["o"] < 1) return undefined;
  return { v: 1, t: "tree", r: p["r"], d: p["d"], s: p["s"], o: p["o"] };
}

/** One `tl_search_files action:"tree"` call, as `server.ts`'s dispatcher resolved it. */
export interface TreeRequest {
  subPath?: string;
  depth?: number;
  /** The `cursor` this call presented — a resume of an earlier page. */
  cursor?: string;
  /** The caller's declared `budget.bytes`/`budget.tokens`. */
  budget: TreeBudget;
  /**
   * What the emitted continuation will carry besides its scope, budget and
   * cursor — `cwd` (the envelope attributes the resolved workspace root),
   * `lane`, `task.handle` — priced into the page's envelope.
   */
  echo: { cwd: string; lane?: string; taskHandle?: string };
}

export type TreeResponse =
  | { kind: "body"; body: CompactTree }
  | { kind: "refusal"; refusal: Record<string, unknown> };

/**
 * TPB: serve one `search.tree` page — a fresh call's first page, or the page a
 * `cursor` resumes. See the section header above for the paging rules.
 * `kind:"body"` also carries the early not-found / not-a-directory /
 * symlink-escape answers unchanged (the funnel turns them into refusals).
 */
export function buildTreeResponse(workspace: string, request: TreeRequest): TreeResponse {
  const restart = (root: string, depth: number): ToolCall => ({
    tool: "tl_search_files",
    arguments: treeCallArguments(root, depth, request.budget),
  });

  let resume: TreeCursorPayload | undefined;
  if (request.cursor !== undefined) {
    const resolved = resolveContinuationHandle<unknown>(request.cursor, workspace);
    resume = resolved.ok ? readTreeCursorPayload(resolved.payload) : undefined;
    if (resume === undefined) {
      return {
        kind: "refusal",
        refusal: {
          ok: false,
          code: "cursor-invalid",
          field: "cursor",
          error: "this tree cursor is not usable here",
          detail: `${resolved.ok ? "wrong-purpose" : resolved.outcome}; re-issue the original tree call`,
          retry: "call",
          next: restart(normalizeSubPath(workspace, request.subPath) || ".", effectiveTreeDepth(request.depth)),
        },
      };
    }
  }

  // 2026-10-19 (DESIGN-v0.14-plan.md §20.26, v016 6t-3 T05c rep2 #8/#9): a
  // cursor call's omitted scope is the cursor's own. The path comes from the
  // root this session remembered when it issued the cursor (the cursor holds
  // only its digest); the depth from the cursor, once the root is the
  // cursor's. The recorded `{action:"tree", cwd, cursor}` was read as the
  // workspace root at the default depth and refused twice; it now resumes.
  // A root this session did not issue (another session, a restart) keeps the
  // scope-change refusal below.
  let subPath = request.subPath;
  let depth = request.depth;
  if (resume !== undefined) {
    if (subPath === undefined) subPath = treeCursorRoot(workspace, resume.r);
    if (depth === undefined && treeRootDigest(normalizeSubPath(workspace, subPath)) === resume.r) depth = resume.d;
  }

  const prepared = prepareTreeListing(workspace, subPath, depth);
  if (!prepared.ok) return { kind: "body", body: prepared.result };
  const { listing } = prepared;
  const { lines } = listing;
  const listingDigest = digest16(lines.join("\n"));

  let offset = 0;
  if (resume !== undefined) {
    const current = treeCursorPayload(listing, listingDigest, resume.o);
    const changed = current.r !== resume.r ? "scope.path" : current.d !== resume.d ? "scope.depth" : undefined;
    if (changed !== undefined) {
      // 2026-10-19 (v016 6t-3 T05c rep2 #8/#9): a cursor binds only digests of
      // its scope, so it never resumes under another one; `next` serves what
      // this call asked for instead: the requested scope from its first page,
      // no cursor, this call's budget. With no `next`, the recorded solver,
      // which had sent the cursor with no scope at all, re-sent the same call.
      return {
        kind: "refusal",
        refusal: {
          ok: false,
          code: "invalid-input",
          field: changed,
          error: `tree cursor continuation cannot change '${changed}'`,
          detail: "a tree cursor continuation accepts only budget overrides; next lists the scope this call asked for from its first page (resuming the cursor needs the scope of the call that returned it)",
          retry: "call",
          next: restart(listing.root, listing.depth),
        },
      };
    }
    if (current.s !== resume.s || resume.o >= lines.length) {
      return {
        kind: "refusal",
        refusal: {
          ok: false,
          code: "cursor-stale",
          field: "cursor",
          error: "the listing under this tree cursor changed",
          detail: "pages of one tree listing are never mixed across a changed walk; restart the original tree call",
          retry: "call",
          next: restart(listing.root, listing.depth),
        },
      };
    }
    offset = resume.o;
  }

  let tree: string;
  let truncated: boolean;
  let end: number;
  const declared = declaredTreePageBytes(request.budget);
  if (declared === undefined) {
    // The default page is the legacy one: TREE_CAP_BYTES of raw text.
    ({ tree, truncated, end } = accumulateUntilCap(lines, TREE_CAP_BYTES, offset));
  } else {
    const limit = Math.min(declared, budgetFor("search.tree"));
    // A placeholder cursor at the largest offset this listing can name, so
    // the measured continuation is never shorter than the real one.
    const placeholderCursor = mintContinuationHandle(workspace, treeCursorPayload(listing, listingDigest, lines.length)) ?? "";
    const completeEnvelope = treePageEnvelopeBytes({
      listing,
      scopeReport: buildScopeReport(listing.omissions, listing.returned, false),
    });
    const truncatedEnvelope = treePageEnvelopeBytes({
      listing,
      scopeReport: buildScopeReport(listing.omissions, listing.returned, true),
      nextArguments: {
        cwd: request.echo.cwd,
        ...(request.echo.lane !== undefined && request.echo.lane !== "" ? { lane: request.echo.lane } : {}),
        ...(request.echo.taskHandle !== undefined ? { task: { handle: request.echo.taskHandle } } : {}),
        ...treeCallArguments(listing.root, listing.depth, request.budget),
        cursor: placeholderCursor,
      },
    });
    const fit = fitTreePage(lines, offset, limit - completeEnvelope, limit - truncatedEnvelope);
    if (!fit.ok) {
      return {
        kind: "refusal",
        refusal: {
          ok: false,
          code: "budget-below-minimum",
          field: "budget",
          error: `budget ${limit} B cannot hold one whole tree line plus its envelope`,
          detail: "raise budget.bytes to at least required_min_bytes (enough for every remaining page of this listing) and re-issue this tree call",
          required_min_bytes: truncatedEnvelope + fit.requiredTextBytes,
          retry: "call",
        },
      };
    }
    ({ end, truncated } = fit);
    const pageText = lines.slice(offset, end).join("\n");
    tree = truncated ? pageText + TRUNC_MARKER : pageText;
  }

  const scope_report = buildScopeReport(listing.omissions, listing.returned, truncated);
  if (tree === "") {
    return {
      kind: "body",
      body: { root: listing.root, depth: listing.depth, tree, truncated, note: emptyTreeNote(listing.containedAbs), scope_report },
    };
  }
  const body: CompactTree = { root: listing.root, depth: listing.depth, tree, truncated, scope_report };
  if (truncated) {
    const cursor = mintContinuationHandle(workspace, treeCursorPayload(listing, listingDigest, end));
    if (cursor !== undefined) {
      rememberTreeCursorRoot(workspace, treeRootDigest(listing.normalizedSub), listing.normalizedSub);
      body.next_call = {
        tool: "tl_search_files",
        arguments: { ...treeCallArguments(listing.root, listing.depth, request.budget), cursor },
      };
    }
  }
  return { kind: "body", body };
}
