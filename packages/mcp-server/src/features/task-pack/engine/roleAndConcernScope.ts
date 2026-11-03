import { currentNaturalEvidence } from "../naturalQueryAdapter.js";
// roleAndConcernScope — extracted implementation; imports point to the owning modules.
import * as path from "path";
import type { AnchorResolution } from "../anchorFirst.js";
import type { ImpactCandidate } from "@tokenlighten/types";
import type { ImpactSurface } from "@tokenlighten/types";
import type { NamedDeclaration } from "./roleAndConcernScope3.js";
import type { TaskPackArgs } from "../model.js";
import type { TaskPackSurface } from "../model.js";
import type { TaskProfile } from "@tokenlighten/types";
import { FileReadCache } from "./packBasics2.js";
import { MAX_SURFACES_DISTINCT } from "./packBasics2.js";
import { SURFACE_ROLE_PRIORITY } from "./partialPackBuilder.js";
import { anchorFirstEnabled } from "../anchorFlag.js";
import { classifySurface } from "../../../util/impact.js";
import { commonAncestorDir } from "./seedResolution.js";
import { hasRenameRequestMarker } from "./coverageAndContinuation3.js";
import { isEnumLikeQueryShaped } from "./roleAndConcernScope2.js";
import { isUnderAncestor } from "./seedResolution.js";
import { isWithinRoleSearchScope } from "../../locator/locateTaskContext.js";
import { parsePackLineRange } from "./packState2.js";
import { projectRootOf } from "../../locator/locateTaskContext.js";
import { queryTaskContract } from "../taskContractStore.js";
import { requestAnchorCandidates } from "./roleAndConcernScope3.js";
import { resolveRequestAnchorsForPack } from "./roleAndConcernScope3.js";
import { roleSearchScopePrefixes } from "../../locator/locateTaskContext.js";
import { surfaceInventory } from "../../../util/impact.js";
import { tokenizeForEpoch } from "../../../state/session.js";
import { walkCodeFiles } from "../../../tools/walkRepo.js";

export function mergeUnique(left: string[], right: string[]): string[] {
  return [...new Set([...left, ...right].filter((v) => v.length > 0))];
}

// ---------------------------------------------------------------------------
// A3 item 6: never require (or later report missing) a surface role that
// does not structurally exist in this workspace. A C++ firmware repo has no
// "ui"/"style" role at all — demanding those surfaces (and then telling the
// agent to burn 2-3 more task_pack calls locating them) is actively wrong
// guidance, independent of what the query happens to say.
// ---------------------------------------------------------------------------

/**
 * DESIGN-v0.8 coverage-honesty: the surface-role inventory of a workspace (or
 * one project root within it), computed from a SINGLE style-inclusive walk and
 * MEMOIZED per (workspace, root) key. This kills the double full-walk
 * requiredSurfacesForTask used to pay (two `workspaceHasRole` calls, each a
 * fresh whole-tree walk) and, when a root is supplied, scopes the "does this
 * role exist" answer to the candidates' OWN root so host-repo CSS cannot make
 * "style" look present for a firmware-fixture task.
 *
 * The cache is module-level and keyed by the exact realpath+root string; a
 * single pack build reuses one walk across every requiredSurfacesForTask /
 * workspaceHasRole call. Not test-reset-sensitive: a fixture written under a
 * fresh tmpdir has a distinct key, and role membership for a given directory
 * tree does not change within a process's lifetime in practice — but the
 * exported hook below clears it so a test that mutates a reused path in place
 * still sees fresh inventory.
 */
export const roleInventoryCache = new Map<string, ReadonlySet<ImpactSurface>>();

/** Test-only reset hook: clear the memoized per-(workspace,root) role inventory. */
export function resetRoleInventoryCache(): void {
  roleInventoryCache.clear();
}

/**
 * Role inventory for `workspace` scoped to `root` (a `projectRootOf` value, or
 * `null` for the whole workspace). One style-inclusive walk per distinct
 * (workspace, root) key, memoized. The `.css/.scss/.less` extras mirror the
 * old workspaceHasRole trick — the default code-file walk excludes them, so a
 * real stylesheet would otherwise be invisible to a "style" role check.
 */
export function roleInventoryFor(workspace: string, root: string | null): ReadonlySet<ImpactSurface> {
  const key = workspace + "|" + (root ?? "__ALL__");
  const hit = roleInventoryCache.get(key);
  if (hit !== undefined) return hit;
  const allPaths = walkCodeFiles(workspace, { extraExts: [".css", ".scss", ".less"] }).map((f) => f.relPath);
  const rootIsMarker = root !== null && allPaths.some((candidatePath) => projectRootOf(candidatePath) === root);
  const inventoryPaths = root !== null && !rootIsMarker
    ? allPaths.filter((candidatePath) => isUnderAncestor(candidatePath, root))
    : allPaths;
  const inv = surfaceInventory(
    inventoryPaths,
    projectRootOf,
    rootIsMarker ? root : null,
    (p) => classifySurface(p),
  );
  roleInventoryCache.set(key, inv);
  return inv;
}

/**
 * PREFIX-scoped role inventory — roleInventoryFor's sibling for a scope that
 * is a common-ancestor DIRECTORY rather than a marker root. rootOf-equality
 * would match nothing under an ancestor, while the prefix test also counts
 * files in NESTED sibling roots — exactly what a cross-subpackage required-
 * role fill needs (a monorepo's "contract" role usually lives in a sibling
 * package of the located surfaces). `scope === ""` is the whole workspace.
 */
export function roleInventoryUnder(workspace: string, scope: string): ReadonlySet<ImpactSurface> {
  const key = workspace + "|prefix:" + scope;
  const hit = roleInventoryCache.get(key);
  if (hit !== undefined) return hit;
  const inv = surfaceInventory(
    walkCodeFiles(workspace, { extraExts: [".css", ".scss", ".less"] })
      .map((f) => f.relPath)
      .filter((p) => isUnderAncestor(p, scope)),
    projectRootOf,
    null,
    (p) => classifySurface(p),
  );
  roleInventoryCache.set(key, inv);
  return inv;
}

/**
 * The directory scope a required-role FILL may search (09e pollution
 * hardening — see augmentMissingRequiredRoleSurfaces):
 *   - every surface in ONE root        → that root ("" = single-project
 *     workspace, where an unscoped fill is the legitimate behavior);
 *   - surfaces span SEVERAL roots      → their common-ancestor directory
 *     (the project-family root, e.g. the fixture/monorepo dir above its
 *     subpackages) — never the whole workspace;
 *   - no surfaces / no common ancestor → null: the caller must SKIP the
 *     fill, because with no anchor at all any pick is a cross-project guess.
 */
export function roleFillScope(surfaces: TaskPackSurface[]): string | null {
  if (surfaces.length === 0) return null;
  const roots = new Set(surfaces.map((s) => projectRootOf(s.path)));
  if (roots.size === 1) return [...roots][0]!;
  const ca = commonAncestorDir(surfaces.map((s) => s.path));
  return ca !== "" ? ca : null;
}

/** True when `relPath` lies inside ANY of `prefixes` (see isWithinRoleSearchScope). */
export function isUnderAnyPrefix(relPath: string, prefixes: readonly string[] | null | undefined): boolean {
  return isWithinRoleSearchScope(relPath, prefixes);
}

/**
 * B1a (2026-08-01 retrieval-scope): DIRECTORIES the query literally names.
 *
 * A request that says "packages/shared 配下の…" has told the server exactly
 * where to look, but nothing consumed that: inferQueryProjectScope matches
 * whole PROJECT-ROOT names only and its stop-token list deliberately drops
 * generic segments ("packages", "shared", "apps"), so a multi-segment directory
 * spelled in the query bound no scope at all. Any workspace directory whose
 * relative path ENDS WITH the named segment sequence resolves it, so the caller
 * may spell either the workspace-relative path or the tail they know.
 *
 * Bounded and conservative: at most MAX_QUERY_NAMED_DIR_SCOPES resolved
 * directories, only multi-segment names (a bare "src" is not a location), and —
 * when `confinement` is supplied (caller `paths`) — only directories inside it.
 */
export const MAX_QUERY_NAMED_DIR_SCOPES = 4;

export function queryNamedDirectoryScopes(
  query: string,
  workspace: string,
  confinement?: readonly string[],
): string[] {
  if (query.trim().length === 0) return [];
  const named = [...new Set(
    (query.match(/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+/g) ?? [])
      .map((token) => token.replace(/^\.\//, "").replace(/\/+$/, ""))
      .filter((token) => token.includes("/") && !/\.[A-Za-z0-9]+$/.test(token)),
  )];
  if (named.length === 0) return [];
  // Directory inventory derived from the SAME walk the rest of the pack uses,
  // so an ignored/out-of-scope tree can never be named into existence.
  const dirs = new Set<string>();
  for (const file of walkCodeFiles(workspace, {})) {
    let dir = path.posix.dirname(file.relPath);
    while (dir !== "" && dir !== ".") {
      if (dirs.has(dir)) break;
      dirs.add(dir);
      dir = path.posix.dirname(dir);
    }
  }
  const resolved: string[] = [];
  for (const token of named) {
    for (const dir of [...dirs].sort()) {
      if (dir !== token && !dir.endsWith(`/${token}`)) continue;
      if (confinement !== undefined && confinement.length > 0 && !isUnderAnyPrefix(dir, confinement)) continue;
      if (!resolved.includes(dir)) resolved.push(dir);
      if (resolved.length >= MAX_QUERY_NAMED_DIR_SCOPES) return resolved;
    }
  }
  return resolved;
}

/**
 * B1a (2026-08-01 retrieval-scope): the final role/style/test search scope —
 * the anchor cluster's own prefixes UNIONED with every directory the query
 * literally names (and, when the caller supplied paths, confined to them).
 * Returns null only when neither source yields a scope, i.e. "skip the fill".
 */
export function roleSearchScope(
  anchorPaths: readonly string[],
  query: string,
  workspace: string,
  callerScopes?: readonly string[],
): string[] | null {
  const anchorPrefixes = roleSearchScopePrefixes(anchorPaths);
  const named = queryNamedDirectoryScopes(query, workspace, callerScopes);
  const union = [...new Set([...(anchorPrefixes ?? []), ...named])];
  if (union.length === 0) return anchorPrefixes;
  // A "" prefix (single-project workspace) already covers everything; keep it
  // alone rather than pretending the named directories narrowed anything.
  if (union.includes("")) return [""];
  return union.sort();
}

/**
 * True when at least one file in the workspace classifies to `role`. Now
 * backed by the memoized whole-workspace inventory (one walk, reused) instead
 * of a fresh early-exit walk per call. Whole-workspace scope is kept for this
 * shim's callers (buildCompletionChecks' phantom-role guard) — they reason
 * about "could this role exist anywhere here", not per-root presence.
 */
export function workspaceHasRole(workspace: string, role: ImpactSurface): boolean {
  return roleInventoryFor(workspace, null).has(role);
}

/**
 * Required surface roles for a task.
 *
 * DESIGN-v0.8 coverage-honesty: ui/style are added only when they
 * STRUCTURALLY EXIST in the located candidates' own dominant project root
 * (`candidatePaths` → `projectRootOf` majority) — not merely somewhere in the
 * whole workspace, which let host-repo CSS make "style" required for a
 * firmware-fixture task. When no candidates are known yet (the pre-locate
 * abstain call), `candidatePaths` is empty and the inventory falls back to the
 * whole workspace (root=null), preserving the prior best-effort behavior.
 */
export function requiredSurfacesForTask(
  query: string,
  workspace: string,
  explicit?: string[],
  candidatePaths?: ReadonlyArray<string>,
): string[] {
  // P0 defect 2 (requirement model shrinks with the query). Requirements are
  // MONOTONE within a task epoch: every role an EARLIER pack of this same task
  // already required stays required, so a narrowed continuation cannot certify
  // `coverage:"complete"` against a universe that shrank along with its own
  // query text. Union-only — this can add a requirement, never drop one — and
  // fail-closed: with no stored contract (cold store, queryless pack, restart)
  // `carried` is empty and the two exits below are exactly today's behavior.
  // Applied to the caller-supplied `explicit` branch too: a continuation that
  // forwards `surfaceRoles=["api"]` is narrowing the ASK, not retracting what
  // the epoch already established.
  const carried = queryTaskContract(workspace, tokenizeForEpoch(query))?.requiredRoles ?? [];
  if (explicit && explicit.length > 0) return mergeUnique(explicit.map(String), [...carried]);
  // These inferred roles describe enum/rename edit propagation. An admitted
  // natural answer still retains every explicit or previously required role,
  // but explaining a priority update does not create a new edit frontier.
  if (currentNaturalEvidence()?.purpose === "answer") return [...carried];

  const required = new Set<ImpactSurface>();

  // Scope the ui/style presence check to the dominant root of the located
  // candidates when we have any; otherwise fall back to the whole workspace.
  const candidateRoots = candidatePaths && candidatePaths.length > 0
    ? [...new Set(candidatePaths.map((candidatePath) => projectRootOf(candidatePath)))]
    : [];
  const crossRootAncestor = candidatePaths && candidateRoots.length > 1
    ? commonAncestorDir(candidatePaths.map((candidatePath) => `${candidatePath}/__surface__`))
    : undefined;
  const root = candidatePaths && candidatePaths.length > 0
    ? candidateRoots.length === 1
      ? candidateRoots[0]!
      : crossRootAncestor || null
    : null;
  const inventory = roleInventoryFor(workspace, root);

  // Enum/variant-shaped tasks: a new value typically needs its contract
  // definition and the code paths that enumerate it updated. ui/style are
  // ONLY added when the root actually has presentation code — no
  // acronym/all-caps-token trigger here (that matched incidental tokens
  // like protocol/algorithm names in unrelated bug-fix queries).
  // Item 5: camelCase-robust gate (isEnumLikeQueryShaped) — a query like
  // "TicketPriority byTicket" (no word-boundary "priority") now derives the
  // same contract/api/ui/style requirements as "ticket priority".
  if (isEnumLikeQueryShaped(query)) {
    required.add("contract");
    required.add("api");
    if (inventory.has("ui")) required.add("ui");
    if (inventory.has("style")) required.add("style");
  }

  if (hasRenameRequestMarker(query)) {
    required.add("api");
    required.add("test");
  }

  // The monotone carry-forward (see `carried` above) joins the per-call
  // inference here, before the shared priority ordering, so a carried role is
  // indistinguishable downstream from one this call inferred itself.
  for (const role of carried) required.add(role as ImpactSurface);

  return [...required].sort(
    (a, b) => (SURFACE_ROLE_PRIORITY[a] ?? 9) - (SURFACE_ROLE_PRIORITY[b] ?? 9)
  );
}

/**
 * A generic first pack names an anchor the workspace defines in exactly one implementation file
 * (`chooseDefinitions` leaves out a name several declare): the pack serves that declaration's body
 * and its row leads the evidence. The selection decides everything else, exactly as it did:
 *  - a selected candidate that already covers the whole declaration stays as it is;
 *  - one that starts inside it and stops short only has its range extended to the declaration's
 *    end (its `why`, confidence and requiredness are kept);
 *  - with none, the declaration joins the END of the selection as context (no `required`), and the
 *    selection's last candidate gives way if the surface count is at its cap.
 * The row moves first only after the pack is decided (`moveNamedDeclarationFirst`): a reorder, no
 * new decision. Only a first, pathless pack of a `generic` request is touched: seeded packs,
 * replays, and every other profile are not.
 */
export async function withNamedDeclarationLead(
  selected: readonly ImpactCandidate[],
  args: TaskPackArgs,
  query: string,
  workspace: string,
  cache: FileReadCache,
  profile: TaskProfile,
): Promise<{ candidates: ImpactCandidate[]; declaration?: NamedDeclaration }> {
  const unchanged = { candidates: [...selected] };
  if (profile !== "generic" || !anchorFirstEnabled()) return unchanged;
  if ((args.paths?.length ?? 0) > 0 || args.path || args.symbol || args.taskQueryRefReplay === true) return unchanged;
  let resolution: AnchorResolution;
  try {
    resolution = await resolveRequestAnchorsForPack(args, query, workspace, cache);
  } catch {
    return unchanged;
  }
  const definition = resolution.definitions.find((entry) => entry.implementation);
  if (definition === undefined) return unchanged;
  const [lead] = requestAnchorCandidates({ definitions: [definition], literalHits: [], definedIds: [definition.id] });
  if (lead === undefined) return unchanged;
  const declaration: NamedDeclaration = { path: definition.path, startLine: definition.startLine };
  const boundsOf = (candidate: ImpactCandidate): [number, number] => {
    const bounds = parsePackLineRange(candidate.range);
    return [bounds?.[0] ?? candidate.line, bounds?.[1] ?? candidate.line];
  };
  const covering = selected.find((candidate) => {
    if (candidate.path !== definition.path) return false;
    const [from, to] = boundsOf(candidate);
    return from <= definition.startLine && to >= definition.startLine;
  });
  if (covering !== undefined) {
    const [from, to] = boundsOf(covering);
    if (to >= definition.endLine) return { candidates: [...selected], declaration };
    const extended: ImpactCandidate = { ...covering, range: `${from}-${definition.endLine}` };
    return { candidates: selected.map((candidate) => (candidate === covering ? extended : candidate)), declaration };
  }
  // The declaration is context, not a write frontier: no minted `required`.
  const { required: _mintedRequired, ...context } = lead;
  if (selected.length < MAX_SURFACES_DISTINCT) return { candidates: [...selected, context], declaration };
  // At the cap, the last candidate that is not required gives way; a selection that is all
  // required (an edit's write frontier) is left exactly as it was.
  const yieldAt = selected.map((candidate) => candidate.required === true).lastIndexOf(false);
  if (yieldAt < 0) return unchanged;
  const kept = selected.filter((_, index) => index !== yieldAt).slice(0, MAX_SURFACES_DISTINCT - 1);
  return { candidates: [...kept, context], declaration };
}
