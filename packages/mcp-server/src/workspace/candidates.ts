// workspace/candidates.ts — the ONE validated-retry-candidate authority for
// PI-07 (DESIGN-v0.10-expansion-plan-reconciliation.md §2 PI-07 / §7 F-A1-5).
//
// Before this module existed, THREE independent candidate builders offered
// `cwd_candidates` (server.ts's workspaceCandidates, its create-path inline
// builder, and readCodeSmallFile.ts's requestedPathWorkspaceCandidates), and
// ONE raw ancestor walk (server.ts's since-removed nearestExistingAncestorPath)
// fed the `did_you_mean` string surfaced by protocol/refusal.ts's mapping —
// with NO shared validation step. `checkCwdWithCorrection` (server.ts, the
// read_file/search_files-only auto-correction) already re-validated a
// candidate through `checkCwdOrRefuse` before silently adopting it; nothing
// else did. Concretely: a symlink whose realpath escapes every allowed
// parent could be walked to by the raw ancestor walk (`statSync` follows
// symlinks) and offered as `did_you_mean` on a WRITE-path (edit_file)
// refusal — the caller's retry would draw the identical refusal again
// (a refusal loop, not a silent escape, but a caller that trusts the
// suggestion without re-checking gets nothing from the retry).
//
// This module is the single place that policy is expressed. Every retry
// candidate — `cwd_candidates` entries and `did_you_mean` strings alike, on
// every one of the three advertised tools — is produced or filtered through
// the functions below before it reaches a wire refusal. The acceptance
// policy itself is NOT reimplemented here: `isWorkspaceCandidateAccepted`
// composes the exact two checks `checkCwdOrRefuse` (server.ts) already
// performs to accept an explicit `cwd` override on a live call (an exact
// match on the fallback/pinned root — H3, a root outside $HOME with no
// configured `--allowed-parent` still accepts itself — or
// `isWorkspaceOverrideAccepted`'s policy: pinned-root containment, a
// registered worktree, a sealed bench cell, or a configured
// `--allowed-parent` child). `checkCwdOrRefuse` itself now calls this
// function rather than duplicating the two lines, so there is exactly ONE
// implementation of "would a real call accept this cwd?" for a live call
// and a dry-validated retry suggestion to drift apart from.

import { statSync } from "fs";
import * as path from "path";
import { isWorkspaceOverrideAccepted } from "../write/resolveWorkspace.js";
import { resolveReal } from "../util/safePath.js";

/**
 * Upper bound on how many retry candidates any producer may offer in one
 * response — the same order of magnitude as readCodeSmallFile.ts's own
 * `BASENAME_CANDIDATE_LIMIT` (kept local to that file: it also bounds an
 * unrelated same-basename file list, so it is not re-exported from here).
 * A cap applies even to producers that only ever enumerate already-known,
 * already-registered roots (server.ts's `workspaceCandidates` and its
 * create-path builder): the list is bounded in practice by how many
 * worktrees/sessions are live, but an unbounded response is still an
 * unbounded response.
 */
export const WORKSPACE_CANDIDATE_LIMIT = 3;

/**
 * The exact acceptance test a live call's workspace resolver applies to an
 * explicit `cwd` override. Mirrors `checkCwdOrRefuse`'s (server.ts) own
 * accept branch exactly, so a candidate that passes this function is
 * guaranteed to be accepted, not merely likely to be: an exact match on the
 * fallback/pinned root (the H3 shortcut — see server.ts's `checkCwdOrRefuse`
 * doc comment for why a root living outside $HOME must still accept
 * itself), or `isWorkspaceOverrideAccepted`'s policy.
 *
 * `requested` need not exist on disk or be well-formed — `resolveReal` and
 * `isWorkspaceOverrideAccepted` both tolerate that and simply reject.
 */
export function isWorkspaceCandidateAccepted(
  requested: string | undefined,
  fallbackRoot: string,
  allowedParents: readonly string[] = [],
): boolean {
  if (!requested) return false;
  if (resolveReal(requested) === resolveReal(fallbackRoot)) return true;
  return isWorkspaceOverrideAccepted(requested, allowedParents, fallbackRoot);
}

/**
 * True when `p` resolves to the user's home directory ITSELF, not merely
 * somewhere inside it. A direct copy of server.ts's own `isHomeDirItself`
 * (kept local rather than imported — server.ts imports FROM this module, so
 * the reverse import would cycle; the logic is four lines of `process.env`
 * reads with nothing to duplicate policy-wise). Exists so
 * `nearestValidWorkspaceAncestor` below inherits the SAME guard
 * `checkCwdWithCorrection` already applies on the read path: an ancestor
 * walk from a bogus/sibling cwd can legitimately reach $HOME (a real,
 * existing directory, and — per that function's doc comment — one that can
 * pass containment checks in its own right), but silently offering the
 * caller's ENTIRE home directory as a retry target is not what "one
 * unambiguous root suggestion" is meant to license. Without this guard here,
 * the write path (which never runs `checkCwdWithCorrection`'s read-only
 * correction, only sees `did_you_mean`) would have inherited exactly the
 * hazard that function's own `isHomeDirItself` check exists to prevent.
 */
function isHomeDirItself(p: string): boolean {
  const home = process.env["HOME"] ?? process.env["USERPROFILE"] ?? "";
  if (!home) return false;
  return resolveReal(p) === resolveReal(home);
}

/**
 * The nearest ancestor of `requestedPath` (need not exist; absolute or
 * relative — a relative path resolves against this process's own cwd,
 * matching the removed `nearestExistingAncestorPath`'s behavior exactly)
 * that EXISTS as a directory — same existence-walk shape as that removed
 * function (`path.dirname` loop, `parent === cur` as the filesystem-root
 * termination guard) — returned ONLY if it ALSO passes
 * `isWorkspaceCandidateAccepted`; undefined otherwise (E-1: omission, never
 * a fabricated/refused-again suggestion).
 *
 * Deliberately does NOT keep walking past an existing-but-invalid ancestor
 * to look for a DIFFERENT, further-up one that might independently
 * validate — it finds the exact same candidate the removed function always
 * found, then gates it. An earlier version of this function walked past an
 * invalid ancestor, and that was empirically wrong, not merely
 * over-cautious: `checkCwdWithCorrection` (server.ts, the
 * read_file/search_files-only auto-correction) re-validates this exact
 * return value before silently adopting it, and in a test environment where
 * `TOKENLIGHTEN_ALLOWED_PARENTS` grants $HOME (F-A1-8's vitest-harness-wide
 * injection), every direct child of $HOME independently validates on its
 * own — so walking past an invalid symlink landed on the container
 * directory immediately ABOVE it (a technically-valid override, but not
 * what anyone typo'd toward, and not the value under test) and got silently
 * adopted, changing which file a read_file call served. Gating only the
 * SAME single candidate the old function found, and omitting when IT fails,
 * can only ever turn a previously-offered-but-invalid value into an
 * omission — it can never promote a DIFFERENT value into existence — so it
 * cannot introduce that class of surprise, and "preserve the read path's
 * auto-correction exactly" holds by construction.
 *
 * This IS still the PI-07 / F-A1-5 fix: the removed function returned the
 * nearest existing ancestor unconditionally — `statSync` follows symlinks,
 * so a symlink whose realpath escapes every allowed parent counted as
 * "existing" and was returned verbatim, with no re-validation on the write
 * path (`checkCwdWithCorrection` never runs for edit_file, by design).
 */
export function nearestValidWorkspaceAncestor(
  requestedPath: string,
  fallbackRoot: string,
  allowedParents: readonly string[] = [],
): string | undefined {
  if (!requestedPath) return undefined;
  let cur = path.resolve(requestedPath);
  while (true) {
    let isDirectory = false;
    try {
      isDirectory = statSync(cur).isDirectory();
    } catch {
      isDirectory = false; // does not exist (or not statable) — keep walking up.
    }
    if (isDirectory) {
      if (isHomeDirItself(cur)) return undefined;
      return isWorkspaceCandidateAccepted(cur, fallbackRoot, allowedParents) ? cur : undefined;
    }
    const parent = path.dirname(cur);
    if (parent === cur) return undefined; // hit filesystem root, nothing existed
    cur = parent;
  }
}
