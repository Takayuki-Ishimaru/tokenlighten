// workspace-routing — extracted implementation; imports point to the owning modules.
import * as path from "path";
import type { HandleEntry } from "../util/handles.js";
import { WORKSPACE_CANDIDATE_LIMIT } from "../workspace/candidates.js";
import { activeRoot } from "../runtime/config.js";
import { configuredAllowedParents } from "./read-admission2.js";
import { existsSync } from "node:fs";
import { handleTable } from "../util/handles.js";
import { isWorkspaceCandidateAccepted } from "../workspace/candidates.js";
import { lstatSync } from "node:fs";
import { nestedWorkspaceRoots } from "../write/workspaceBoundary.js";
import { otherActiveRoots } from "../state/session.js";
import { readdirSync } from "node:fs";
import { registeredWorktreeRoot } from "../write/resolveWorkspace.js";
import { resolveReal } from "../util/safePath.js";
import { resolveWorkspaceRoot } from "./read-admission2.js";
import { statSync } from "node:fs";

// ---------------------------------------------------------------------------
// v0.15 W-T-A — BOUNDED cwd NEAR-MISS (flag TL_CWD_NEAR_MISS, default OFF).
// Normative source: DESIGN-v0.15-sf-turn-economy.md §1.
//
// THE EVIDENCE. DESIGN-v0.14-plan.md §4's 12-cell paid transcript anatomy
// counted 20 `invalid-cwd` refusals. 18 of them were ONE worktree basename
// apart — `…_semantic_frontier-r0` typed where `…semantic-frontier-r0`
// existed, i.e. a `_`<->`-` class substitution; one was a path truncated
// mid-way; one was a path pasted twice. `nearest_existing` cannot reach any of
// them: it walks PARENTS, and a sibling's name is never on that chain.
//
// TWO POLICIES, DELIBERATELY ASYMMETRIC (§1.2). A read that lands in the wrong
// tree costs a turn; a WRITE that lands in the wrong tree is the 2026-08-09
// root-mismatch incident class. So:
//   (a) tl_read_file / tl_search_files may SILENTLY ADOPT a unique near-miss, exactly
//       as they already adopt `.claire`->`.claude` and `nearest_existing`, and
//       disclose it through the SAME `cwd_corrected` field (its `reason`
//       vocabulary is extended; no new envelope-level disclosure field).
//   (b) tl_edit_file NEVER auto-resolves. It gets `cwd_candidates` plus a unique
//       `did_you_mean` on the refusal, and re-issues the call itself.
//
// CANDIDATE SOURCES, RATIFIED (independent-review F4, 2026-09-02). Two pools,
// never conflated:
//   1. REGISTERED pool — `workspaceCandidates(fallbackRoot,
//      nestedWorkspaceRoots(fallbackRoot))` (server-default / nested-worktree
//      / active-session, capped at `WORKSPACE_CANDIDATE_LIMIT`). This is the
//      ONLY source for (b)'s wire `cwd_candidates` — on EVERY tool's
//      `invalid-cwd` refusal, tl_edit_file included — and it also seeds the (a)
//      read-path matching pool.
//   2. SIBLING-SCAN pool — an on-disk `readdirSync` of the requested path's
//      parent directory, kept ONLY for the (a) read-path auto-adopt pool
//      (`cwdNearMissCandidatePool`, consumed solely by `checkCwdWithCorrection`).
//      A scanned sibling is admitted ONLY when it is itself a worktree
//      REGISTERED by the pinned repository (`registeredWorktreeRoot` — the
//      same capability `checkCwdOrRefuse`'s own refusal `detail` text names),
//      never merely an `isWorkspaceCandidateAccepted` directory (that wider
//      class also admits `--allowed-parent` children and the pinned root
//      itself, neither of which is a "sibling typo" candidate). The scan pool
//      NEVER reaches a refusal: no `cwd_candidates` array, on any tool via any
//      path, ever enumerates a scan-sourced candidate.
//
// INVARIANTS INHERITED, NOT RE-DERIVED. Every candidate passes
// `isWorkspaceCandidateAccepted` — the ONE acceptance authority
// (`workspace/candidates.ts` -> `write/resolveWorkspace.ts`) — so an
// unregistered directory, another repository's pinned workspace, and a symlink
// whose realpath escapes the allowed boundary can never even become
// candidates. On top of that this module refuses: any `..` component in the
// supplied cwd, a candidate reached through a symlink (checked with `lstat` on
// the name itself, not merely on its realpath), a case-only difference on a
// case-insensitive filesystem whose realpaths are not identical, and ANY tie
// between two candidates. Comparison happens on realpath-resolved strings, and
// the adopted value is finally re-proved through `checkCwdOrRefuse`, so
// nothing here can widen what a live call would accept.
// ---------------------------------------------------------------------------

/** The bounded relations a near-miss candidate may stand in to the supplied cwd. */
export type CwdNearMissRelation =
  | "separator-class"
  | "sibling-edit-distance"
  | "prefix-truncation"
  | "segment-duplication";

/** A unique, validated near-miss candidate. `to` is always realpath-resolved. */
export interface CwdNearMissMatch {
  to: string;
  relation: CwdNearMissRelation;
  source: string;
  edit_distance?: number;
}

/** Why nothing was adopted. Diagnostic only — never a wire field. */
export type CwdNearMissRefusal = "dot-dot" | "ambiguous" | "no-candidate" | "pool-too-large";

/**
 * The three environment facts the matcher consults, injected so the unit tests
 * can drive BOTH filesystem case modes (and the symlink branch) without
 * needing a filesystem that behaves that way.
 */
export interface CwdNearMissDeps {
  caseInsensitiveFs: boolean;
  realpath: (p: string) => string;
  isSymlink: (p: string) => boolean;
}

/**
 * Production wiring. The case-sensitivity default is the CONSERVATIVE guess
 * (darwin/win32 assumed case-insensitive): guessing "insensitive" only ever
 * adds a refusal, guessing "sensitive" would remove one.
 */
export const DEFAULT_CWD_NEAR_MISS_DEPS: CwdNearMissDeps = {
  caseInsensitiveFs: process.platform === "darwin" || process.platform === "win32",
  realpath: (p) => resolveReal(p),
  isSymlink: (p) => {
    try { return lstatSync(p).isSymbolicLink(); } catch { return false; }
  },
};

/**
 * Hard bound on how many candidates are ever REPORTED on the wire (the
 * registered pool's own `WORKSPACE_CANDIDATE_LIMIT` already sits well under
 * this). The near-miss matching machinery itself never truncates its INPUT
 * to this bound — see `CWD_NEAR_MISS_POOL_SAFETY_BOUND` for that.
 */
export const CWD_NEAR_MISS_CANDIDATE_LIMIT = 8;

/**
 * Hard bound on the sibling directory scan (a shared parent can be large) AND
 * on how many candidates `cwdNearMissMatch` will compare before refusing
 * outright (`pool-too-large`) rather than silently sampling. F2 (independent
 * review, 2026-09-02): matching must run over the FULL candidate set, never a
 * truncated prefix of it — a truncated pool can make a genuinely ambiguous
 * set of siblings look unique, which is a silent-wrong-adoption hazard on the
 * read path. This is the only place size is still allowed to matter.
 */
export const CWD_NEAR_MISS_POOL_SAFETY_BOUND = 512;

/** The `_`/`-` equivalence class — the single measured 18/20 typo shape. */
export const CWD_SEPARATOR_CLASS = new Set(["_", "-"]);

/**
 * Damerau-Levenshtein distance (optimal string alignment: substitution,
 * insertion, deletion, and ADJACENT transposition). Returns `cap + 1` as soon
 * as the distance is known to exceed `cap`, so the caller never pays for a
 * full matrix on two unrelated names.
 */
export function damerauLevenshtein(a: string, b: string, cap = 2): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  const n = a.length;
  const m = b.length;
  let prev2: number[] = new Array<number>(m + 1).fill(0);
  let prev: number[] = new Array<number>(m + 1);
  for (let j = 0; j <= m; j++) prev[j] = j;
  let cur: number[] = new Array<number>(m + 1);
  for (let i = 1; i <= n; i++) {
    cur[0] = i;
    let rowMin = cur[0]!;
    for (let j = 1; j <= m; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        v = Math.min(v, prev2[j - 2]! + 1);
      }
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > cap) return cap + 1;
    prev2 = prev;
    prev = cur;
    cur = new Array<number>(m + 1);
  }
  return prev[m]!;
}

/**
 * True when `a` and `b` differ ONLY by `_`<->`-` substitutions (one or more).
 * Allowed independently of the distance-2 bound because it is a single typo
 * CLASS, not a run of independent mistakes: the measured shape
 * `foo_semantic_frontier-r0` vs `foo-semantic-frontier-r0` is distance 2 here
 * but would be distance 3+ on a longer name, and it is no less certain.
 */
export function isSeparatorClassSubstitution(a: string, b: string): boolean {
  if (a.length !== b.length || a === b) return false;
  let diffs = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (x === y) continue;
    if (!CWD_SEPARATOR_CLASS.has(x) || !CWD_SEPARATOR_CLASS.has(y)) return false;
    diffs += 1;
  }
  return diffs > 0;
}

/**
 * The spelling two cwd paths must be compared IN. On POSIX this returns its
 * input unchanged, so every comparison in this module stays byte-for-byte
 * what it was.
 *
 * Win32 needs a normalization the other platforms do not, because the two
 * sides of these comparisons come from different producers: `requested` is a
 * raw wire string a client may spell with forward slashes and either
 * drive-letter case (`c:/w/wt_a` is a perfectly legal Windows path), while a
 * candidate arrives from `realpathSync`, which returns native backslashes and
 * PRESERVES whatever drive-letter case it was handed. Two spellings of ONE
 * directory then failed every identity / `path.dirname` / `startsWith` test
 * below, and the matcher answered `no-candidate` for a cwd it should have
 * corrected — while `isSegmentDuplicationOf`, which splits on `path.sep`,
 * saw a forward-slash path as a single unsplittable segment.
 *
 * ONLY the separator class and the drive letter are canonicalized. Name case
 * is deliberately left alone: `deps.caseInsensitiveFs` is this module's one
 * authority on how NAMES compare, and folding case here would silently turn a
 * case-only difference into distance 0 behind that flag's back.
 */
export function cwdComparablePath(p: string): string {
  if (process.platform !== "win32") return p;
  const native = path.resolve(p.replace(/\//g, path.sep));
  const root = path.parse(native).root;
  // `c:\` and `C:\` are never two different volumes. A UNC root
  // (`\\server\share\`) has no drive letter to fold, and charAt(0) is its
  // leading separator, so it passes through unchanged.
  return root.length > 0
    ? root.charAt(0).toUpperCase() + root.slice(1) + native.slice(root.length)
    : native;
}

/** Path segments below the root (`path.parse().root` is preserved verbatim). */
export function cwdPathSegments(p: string): { root: string; segments: string[] } {
  const root = path.parse(p).root;
  const segments = p.slice(root.length).split(path.sep).filter((s) => s !== "");
  return { root, segments };
}

/**
 * STRUCTURAL (not distance-based) duplication detection — DESIGN §1.3's two
 * observed shapes, and nothing wider:
 *   1. consecutive repeated segments collapse onto the candidate (`/a/b/b`);
 *   2. the path was pasted twice, so the remainder after the candidate repeats
 *      the candidate's OWN trailing segments in order (`/a/b/c` -> `/a/b/c/b/c`).
 * Both are exact string identities after the fold, so neither widens the
 * false-positive surface the way another distance rule would.
 */
export function isSegmentDuplicationOf(rawRequested: string, rawCandidate: string): boolean {
  const requested = cwdComparablePath(rawRequested);
  const candidate = cwdComparablePath(rawCandidate);
  const { root, segments } = cwdPathSegments(requested);
  const collapsed: string[] = [];
  for (const segment of segments) {
    if (collapsed[collapsed.length - 1] !== segment) collapsed.push(segment);
  }
  if (collapsed.length !== segments.length && root + collapsed.join(path.sep) === candidate) {
    return true;
  }
  if (!requested.startsWith(candidate + path.sep)) return false;
  const remainder = requested.slice(candidate.length + 1).split(path.sep).filter((s) => s !== "");
  const candidateSegments = cwdPathSegments(candidate).segments;
  if (remainder.length === 0 || remainder.length > candidateSegments.length) return false;
  const tail = candidateSegments.slice(candidateSegments.length - remainder.length);
  return remainder.every((segment, i) => segment === tail[i]);
}

/**
 * The bounded relation between a resolved (but invalid) cwd and ONE validated,
 * realpath-resolved candidate — or `undefined` when they are simply unrelated.
 * Pure: every filesystem fact it needs arrives through `deps`.
 */
export function cwdNearMissRelationFor(
  rawRequestedResolved: string,
  rawCandidateReal: string,
  deps: CwdNearMissDeps = DEFAULT_CWD_NEAR_MISS_DEPS,
): { relation: CwdNearMissRelation; editDistance?: number } | undefined {
  // Both sides are compared in ONE spelling — see `cwdComparablePath`. The
  // identity of this function is unchanged on POSIX.
  const requestedResolved = cwdComparablePath(rawRequestedResolved);
  const candidateReal = cwdComparablePath(rawCandidateReal);
  if (requestedResolved === candidateReal) return undefined;
  if (isSegmentDuplicationOf(requestedResolved, candidateReal)) {
    return { relation: "segment-duplication" };
  }
  // F5 (independent review, 2026-09-02): a path-level "the caller stopped one
  // segment short" relation used to be accepted here
  // (`path.dirname(candidateReal) === requestedResolved`), but that adopts a
  // CHILD of the requested path — a violation of the sibling-parent invariant
  // every relation below enforces (each requires an IDENTICAL parent). A
  // genuinely truncated path is already covered by `nearest_existing`'s
  // ancestor walk (DESIGN-v0.15-sf-turn-economy.md §1.3), so this relation is
  // removed rather than bounded.
  //
  // Everything below is SIBLING-ONLY: identical parent directory, compared
  // after realpath. This is what structurally excludes an unrelated same-named
  // directory living under some other worktree group.
  const requestedParent = cwdComparablePath(deps.realpath(path.dirname(requestedResolved)));
  if (requestedParent !== path.dirname(candidateReal)) return undefined;

  const from = path.basename(requestedResolved);
  const to = path.basename(candidateReal);
  if (from === "" || to === "") return undefined;
  // A case-only difference on a case-insensitive filesystem is NOT a typo the
  // caller can act on: either the two names ARE the same directory (in which
  // case `checkCwdOrRefuse` already accepted the cwd and we never got here), or
  // the filesystem is lying to one of us. Refuse unless the realpaths coincide.
  if (
    deps.caseInsensitiveFs
    && from !== to
    && from.toLowerCase() === to.toLowerCase()
    && cwdComparablePath(deps.realpath(requestedResolved)) !== candidateReal
  ) {
    return undefined;
  }
  if (isSeparatorClassSubstitution(from, to)) return { relation: "separator-class" };
  // F5 (independent review, 2026-09-02): bounded to a missing SUFFIX of at
  // most 3 characters, on a last segment of at least 4. A missing suffix of 1
  // or 2 characters is already reachable via the Damerau-Levenshtein <= 2
  // rule below (a pure suffix append/delete of k characters costs exactly k),
  // so this relation's only genuinely NEW coverage is the 3-character case,
  // which the distance-2 cap cannot reach. The pre-fix unbounded
  // `to.startsWith(from)` accepted an arbitrarily long, unrelated tail (e.g.
  // "semantic" -> "semantic-frontier-r0"), which is not a plausible typo.
  const missingSuffixLength = to.length - from.length;
  if (
    from.length >= 4
    && missingSuffixLength >= 1
    && missingSuffixLength <= 3
    && to.startsWith(from)
  ) {
    return { relation: "prefix-truncation" };
  }
  const distance = damerauLevenshtein(from, to, 2);
  if (distance <= 2) return { relation: "sibling-edit-distance", editDistance: distance };
  return undefined;
}

/**
 * THE MATCHER. Returns the single near-miss candidate, or the reason there is
 * not one. Ambiguity is a refusal, never a ranked pick: two plausible worktrees
 * is exactly the state in which a silent adoption is a wrong-tree incident
 * waiting to happen.
 */
export function cwdNearMissMatch(
  requested: string,
  candidates: readonly { cwd: string; source: string }[],
  deps: CwdNearMissDeps = DEFAULT_CWD_NEAR_MISS_DEPS,
): { match?: CwdNearMissMatch; refused?: CwdNearMissRefusal } {
  // `path.resolve` COLLAPSES `..`, so a traversal would silently become a
  // different, innocent-looking string before any comparison happened. Refuse
  // on the raw spelling instead.
  if (requested.split(/[\\/]/).includes("..")) return { refused: "dot-dot" };
  // F2 (independent review, 2026-09-02): NEVER truncate the input before the
  // tie check — see CWD_NEAR_MISS_POOL_SAFETY_BOUND's doc comment. Only a
  // hard safety ceiling remains; past it we refuse outright rather than
  // sample.
  if (candidates.length > CWD_NEAR_MISS_POOL_SAFETY_BOUND) return { refused: "pool-too-large" };
  const requestedResolved = cwdComparablePath(path.resolve(requested));
  const seen = new Set<string>();
  const hits: CwdNearMissMatch[] = [];
  for (const candidate of candidates) {
    if (deps.isSymlink(candidate.cwd)) continue; // never resolve THROUGH a symlink
    const real = deps.realpath(candidate.cwd);
    // Dedupe on the COMPARABLE spelling: on win32 `c:/w/a` and `C:\w\a` name
    // one directory, and counting them twice would manufacture a tie.
    const realKey = cwdComparablePath(real);
    if (seen.has(realKey)) continue; // one directory reached twice is not a tie
    seen.add(realKey);
    const relation = cwdNearMissRelationFor(requestedResolved, real, deps);
    if (relation === undefined) continue;
    hits.push({
      to: real,
      relation: relation.relation,
      source: candidate.source,
      ...(relation.editDistance !== undefined ? { edit_distance: relation.editDistance } : {}),
    });
  }
  if (hits.length === 0) return { refused: "no-candidate" };
  if (hits.length > 1) return { refused: "ambiguous" };
  return { match: hits[0]! };
}

/**
 * The READ-PATH-ONLY candidate pool — consumed solely by
 * `checkCwdWithCorrection`'s near-miss branch, NEVER by `checkCwdOrRefuse`'s
 * wire `cwd_candidates`, and never truncated before matching (F2/F4,
 * independent review 2026-09-02):
 *   1. `registeredWorkspaceCandidates(...)` — the same registered pool every
 *      tool's `invalid-cwd` refusal reports from (server-default /
 *      nested-worktree / active-session), UNTRUNCATED (R11 A-1: the prior
 *      wiring here called the REPORTING-capped `workspaceCandidates`, so a
 *      4th-or-later registered candidate could never even reach the matcher);
 *   2. the DIRECTORY SIBLINGS of the requested path, each admitted ONLY when
 *      it is itself a worktree REGISTERED by the pinned repository
 *      (`registeredWorktreeRoot` — never the wider `isWorkspaceCandidateAccepted`
 *      class, which would also let an `--allowed-parent` child or the pinned
 *      root itself in through a silent scan). Without (2) the measured 18/20
 *      shape is unreachable on the FIRST call of a session, when the correct
 *      worktree has no live session and is not nested under the pinned root.
 *      Symlinked entries are skipped at the `Dirent` level as well as in the
 *      matcher. Entries are sorted before scanning so which subset is
 *      considered never depends on `readdirSync`'s unspecified order.
 *
 * `truncated` (R11 A-1, independent review 2026-09-03): the sibling scan
 * itself stays bounded at `CWD_NEAR_MISS_POOL_SAFETY_BOUND` raw entries for
 * cost (a shared parent directory can hold thousands) — but the OLD code
 * simply `break`-ed past that bound and returned whatever partial pool it had
 * built, which can silently drop the SECOND half of a genuinely ambiguous
 * pair past the scanned prefix, making the survivor look falsely unique.
 * `truncated:true` says the sibling half of this pool is incomplete, so the
 * caller must refuse to adopt from it rather than trust a partial answer —
 * the read-path analogue of the matcher's own `pool-too-large` refusal.
 */
export function cwdNearMissCandidatePool(
  requested: string,
  fallbackRoot: string,
): { pool: Array<{ cwd: string; source: string }>; truncated: boolean } {
  const pool: Array<{ cwd: string; source: string }> = [
    ...registeredWorkspaceCandidates(fallbackRoot, nestedWorkspaceRoots(fallbackRoot)),
  ];
  const parent = path.dirname(path.resolve(requested));
  let entries: Array<{ name: string; isDirectory(): boolean; isSymbolicLink(): boolean }> = [];
  try {
    entries = readdirSync(parent, { withFileTypes: true });
  } catch {
    entries = []; // unreadable parent — no siblings, no candidates.
  }
  // F2: sort BEFORE scanning so the subset considered under the safety bound
  // never depends on readdirSync's unspecified order.
  entries = entries.slice().sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const truncated = entries.length > CWD_NEAR_MISS_POOL_SAFETY_BOUND;
  const scanLimit = Math.min(entries.length, CWD_NEAR_MISS_POOL_SAFETY_BOUND);
  for (let i = 0; i < scanLimit; i++) {
    const entry = entries[i]!;
    if (entry.isSymbolicLink() || !entry.isDirectory()) continue;
    const cwd = path.join(parent, entry.name);
    // F4 (ratified, independent review 2026-09-02): a scanned sibling is
    // admitted ONLY when it is itself a worktree registered by the PINNED
    // repository — never merely an `isWorkspaceCandidateAccepted` directory
    // (that wider class also admits `--allowed-parent` children and the
    // pinned root itself).
    if (registeredWorktreeRoot(cwd, fallbackRoot) === undefined) continue;
    if (pool.some((existing) => existing.cwd === cwd)) continue;
    pool.push({ cwd, source: "sibling-scan" });
  }
  return { pool, truncated };
}

/** A cwd correction silently adopted in place of a hallucinated one — see checkCwdWithCorrection. */
export interface CwdCorrection {
  from: string;
  to: string;
  /**
   * v0.15 W-T-A: WHICH bounded relation licensed the adoption. Present only on
   * the near-miss branch — the two pre-existing correction classes keep
   * emitting `{from,to}` exactly as before, so `cwd_corrected` is byte-stable
   * for every path that existed before this flag. This EXTENDS the field's own
   * vocabulary rather than adding a second envelope-level disclosure.
   */
  reason?: CwdNearMissRelation;
}

/**
 * True when `p` resolves to the user's home directory ITSELF, not merely
 * somewhere inside it. Guards the nearest_existing branch of
 * checkCwdWithCorrection below: the ancestor walk (now
 * workspace/candidates.ts's nearestValidWorkspaceAncestor) can, from a
 * bogus/sibling cwd (e.g. `<pinnedRoot>/../typo'd-name`, a real fixture
 * shape — pinnedRoot's own parent is $HOME), legitimately reach $HOME
 * itself, which PASSES isWorkspaceOverrideAccepted's containment check
 * ($HOME is "within" itself) — but silently adopting the caller's ENTIRE
 * home directory as a read/search workspace is not what "one unambiguous
 * root suggestion" is meant to license: confirmed live, tl_search_files
 * action=find over a real $HOME can scan gigabytes and hang the call. A
 * `.claire`->`.claude` correction never hits this (it substitutes one
 * segment; it never walks upward), so only the nearest_existing fallback
 * needs this check. PI-07 (2026-08-20): nearestValidWorkspaceAncestor now
 * carries its OWN copy of this exact guard too (so the write path, which
 * never runs checkCwdWithCorrection, inherits the same protection on
 * `did_you_mean`); this copy stays here unchanged for the read-path
 * re-validation below.
 */
export function isHomeDirItself(p: string): boolean {
  const home = process.env["HOME"] ?? process.env["USERPROFILE"] ?? "";
  if (!home) return false;
  return resolveReal(p) === resolveReal(home);
}

/**
 * H3: `cwd` is "explicit" only when it is a present, non-blank string.
 * checkCwdOrRefuse already treats `cwd:""` (and whitespace-only) as OMITTED,
 * but the adoption sites used `args["cwd"] !== undefined` — so an empty-string
 * cwd was "explicit" there and drew a handle-workspace-mismatch REFUSAL where
 * an omitted cwd would have ADOPTED the handle's own root. Unify on this
 * predicate everywhere so `cwd:""`/`"   "` behaves identically to an omitted
 * cwd on both paths.
 */
export function isCwdExplicit(rawCwd: unknown): boolean {
  return typeof rawCwd === "string" && rawCwd.trim() !== "";
}

/**
 * H2: a handle records the absolute workspaceRoot it was minted in. When cwd
 * is omitted, the dispatch ADOPTS that root (the handle IS the workspace pin).
 * But nothing verified the adopted root still EXISTS — a handle minted in a
 * git worktree that was since removed would adopt a now-deleted directory and
 * then fail obscurely deep in file I/O. This shared helper is the single
 * adopt-or-refuse decision used by every adoption site (single-handle read,
 * handles[] batch, single edit, edits[] batch, directoryHandle,
 * resolveCreateSourceContent); each site formats its own response shape from
 * the discriminated result (read batches soft-omit an item; edits hard-refuse
 * the call), but the missing-root and mismatch checks live here, once.
 *
 * `candidateRoots` is the DISTINCT set of workspaceRoots of the caller's
 * handle(s) (unknown handles are excluded by the caller — they surface as
 * handle-unknown separately). Returns:
 *   - {kind:"keep"}     — cwd explicit, OR no candidate roots: leave the
 *                         caller's already-resolved pinned workspace; per-item
 *                         mismatch checks (if any) run at the call site.
 *   - {kind:"adopt", workspace} — exactly one candidate root, cwd omitted, and
 *                         the root exists as a directory → adopt it.
 *   - {kind:"missing", handleWorkspace} — the single root to adopt no longer
 *                         exists / is not a directory → caller refuses with
 *                         reason:"handle-workspace-missing".
 *   - {kind:"multi", roots} — the batch spans >1 root → caller refuses with its
 *                         own handle-workspace-mismatch shape.
 */
export type HandleWorkspaceResolution =
  | { kind: "keep" }
  | { kind: "adopt"; workspace: string }
  | { kind: "missing"; handleWorkspace: string }
  | { kind: "multi"; roots: string[] };

export function resolveHandleWorkspace(
  candidateRoots: string[],
  cwdExplicit: boolean,
  pinnedWorkspace: string,
): HandleWorkspaceResolution {
  if (cwdExplicit) return { kind: "keep" };
  const distinct = [...new Set(candidateRoots)];
  if (distinct.length === 0) return { kind: "keep" };
  if (distinct.length > 1) return { kind: "multi", roots: distinct.sort() };
  const root = distinct[0]!;
  // Already the pinned root — nothing to adopt, and no need to stat (the pinned
  // root's validity is the server's own startup concern, not a handle's).
  if (root === pinnedWorkspace) return { kind: "adopt", workspace: root };
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    return { kind: "missing", handleWorkspace: root };
  }
  return { kind: "adopt", workspace: root };
}

// ---------------------------------------------------------------------------
// Root-mismatch guard (2026-08-09 incident)
//
// checkCwdOrRefuse + resolveHandleWorkspace form a DIFFERENTIAL check: they
// compare what this call declared against what a handle captured. Forensics
// proved the check is exactly as strong as its premise — when NO call in a
// chain ever declares a cwd (a cwd-less mint silently captures the pinned
// launch root, a cwd-less edit adopts it straight back), there is nothing to
// disagree with and a four-file write landed in the shared checkout with
// `ok:true` and no root named anywhere in the response.
//
// Two additions close it, both gated on one physical fact — the effective
// workspace CONTAINS another live workspace (`workspaceIsAmbiguous`):
//   F1  a write whose workspace nobody ever declared is refused progressively
//       (`cwd-required-for-edit`, the sibling of `cwd-required-for-create`).
//   F3  a write whose target lands inside a nested worktree that is not the
//       effective workspace is refused (`workspace-boundary`) — the hazard a
//       purely lexical containment check cannot see, and the one a correctly
//       declared cwd does not protect against.
// Outside that fact both are inert, so a single-root deployment (and every
// bench cell) keeps a byte-identical response profile.
// ---------------------------------------------------------------------------

/** Every handle id a call carries, in a stable order, deduplicated. */
export function involvedHandleIds(args: Record<string, unknown>): string[] {
  const ids: string[] = [];
  const push = (value: unknown): void => {
    if (typeof value === "string" && value !== "" && !ids.includes(value)) ids.push(value);
  };
  push(args["handle"]);
  push(args["directoryHandle"]);
  // `from` is overloaded on the create branch: a handle id when the table
  // knows it, otherwise a source PATH (handled by writeTargetPaths).
  if (typeof args["from"] === "string" && handleTable.get(args["from"]) !== undefined) {
    push(args["from"]);
  }
  const handles = args["handles"];
  if (Array.isArray(handles)) for (const id of handles) push(id);
  const edits = args["edits"];
  if (Array.isArray(edits)) {
    for (const edit of edits) {
      if (edit && typeof edit === "object") push((edit as Record<string, unknown>)["handle"]);
    }
  }
  return ids;
}

/** The live entries behind involvedHandleIds; unknown ids simply drop out. */
export function involvedHandleEntries(args: Record<string, unknown>): HandleEntry[] {
  return involvedHandleIds(args).flatMap((id) => {
    const entry = handleTable.get(id);
    return entry ? [entry] : [];
  });
}

/**
 * The workspace this call actually resolves against, adoption included.
 * Mirrors the dispatch's own order (explicit cwd wins; otherwise a single
 * agreed handle root is adopted; otherwise the pinned root), so the guard and
 * the write it guards can never disagree about which tree is in play.
 */
export function effectiveCallWorkspace(args: Record<string, unknown>): string {
  const pinned = resolveWorkspaceRoot(args["cwd"] as string | undefined, activeRoot);
  if (isCwdExplicit(args["cwd"])) return pinned;
  const roots = [...new Set(involvedHandleEntries(args).map((entry) => entry.workspaceRoot))];
  return roots.length === 1 ? roots[0]! : pinned;
}

/**
 * The root THIS call declares, for the handle table's declaration scope: an
 * explicit cwd, or — when the call rides handles the caller already declared —
 * the single root it adopts from them. That second clause is what makes the
 * declaration transitive, so `cwd` on the mint keeps a whole multi-hop chain
 * (slice → edit → post-edit handle → edit) working cwd-lessly.
 */
export function declaredWorkspaceForCall(args: Record<string, unknown>): string | undefined {
  if (isCwdExplicit(args["cwd"])) return resolveWorkspaceRoot(args["cwd"] as string, activeRoot);
  const roots = [...new Set(
    involvedHandleEntries(args)
      .filter((entry) => entry.workspaceDeclared === true)
      .map((entry) => entry.workspaceRoot),
  )];
  return roots.length === 1 ? roots[0]! : undefined;
}

/** Workspace-relative (or absolute) paths a write call can land bytes on. */
export function writeTargetPaths(args: Record<string, unknown>): string[] {
  const paths: string[] = [];
  const push = (value: unknown): void => {
    if (typeof value === "string" && value !== "" && !paths.includes(value)) paths.push(value);
  };
  push(args["path"]);
  // `from` names a source file only when it is not a known handle id.
  if (typeof args["from"] === "string" && handleTable.get(args["from"]) === undefined) {
    push(args["from"]);
  }
  const edits = args["edits"];
  if (Array.isArray(edits)) {
    for (const edit of edits) {
      if (edit && typeof edit === "object") push((edit as Record<string, unknown>)["path"]);
    }
  }
  for (const entry of involvedHandleEntries(args)) push(entry.path);
  return paths;
}

/** Paths a READ call names, including `paths[]`'s string and object forms. */
export function readTargetPaths(args: Record<string, unknown>): string[] {
  const paths: string[] = [];
  const push = (value: unknown): void => {
    if (typeof value === "string" && value !== "" && !paths.includes(value)) paths.push(value);
  };
  push(args["path"]);
  const list = args["paths"];
  if (Array.isArray(list)) {
    for (const item of list) {
      if (typeof item === "string") push(item);
      else if (item && typeof item === "object") push((item as Record<string, unknown>)["path"]);
    }
  }
  for (const entry of involvedHandleEntries(args)) push(entry.path);
  return paths;
}

/**
 * Server root + live nested workspaces + other active roots, deduplicated and
 * validated — UNTRUNCATED. R11 A-1/A-2/A-3 (independent review, 2026-09-03):
 * this used to BE `workspaceCandidates`'s whole body, capped at
 * `WORKSPACE_CANDIDATE_LIMIT` before returning. That cap is a REPORTING bound
 * (how many candidates a wire refusal NAMES) — feeding it, already truncated,
 * into `cwdNearMissMatch` let a 4th-or-later genuinely ambiguous registered
 * candidate silently vanish before the matcher ever saw it: exactly the
 * "truncated pool makes an ambiguous set look unique" hazard
 * `CWD_NEAR_MISS_POOL_SAFETY_BOUND`'s own doc comment warns against, reached
 * here through a DIFFERENT truncation than the one that comment names.
 * MATCHING (both `checkCwdOrRefuse`'s `did_you_mean` and
 * `cwdNearMissCandidatePool`'s registered half) now consumes THIS untruncated
 * list; only `workspaceCandidates` below and `workspaceRoutingRefusal`'s
 * inline `cwd-required-for-edit` builder still cap, for wire display.
 */
export function registeredWorkspaceCandidates(
  workspace: string,
  nested: readonly string[],
): Array<{ cwd: string; source: string }> {
  const allowedParents = configuredAllowedParents(workspace);
  return [
    { cwd: workspace, source: "server-default" },
    ...nested.map((cwd) => ({ cwd, source: "nested-worktree" })),
    ...otherActiveRoots(workspace).map((cwd) => ({ cwd, source: "active-session" })),
  ]
    .filter((candidate, index, all) =>
      all.findIndex((other) => other.cwd === candidate.cwd) === index)
    .filter((candidate) => isWorkspaceCandidateAccepted(candidate.cwd, workspace, allowedParents));
}

/**
 * REPORTING-ONLY wrapper around `registeredWorkspaceCandidates`, capped at
 * `WORKSPACE_CANDIDATE_LIMIT` — for wire display (e.g. `cwd-required-for-edit`'s
 * `cwd_candidates`) where a short, bounded list is the whole point. Near-miss
 * MATCHING never goes through this cap; see `registeredWorkspaceCandidates`'s
 * doc comment.
 */
export function workspaceCandidates(
  workspace: string,
  nested: readonly string[],
): Array<{ cwd: string; source: string }> {
  return registeredWorkspaceCandidates(workspace, nested).slice(0, WORKSPACE_CANDIDATE_LIMIT);
}
