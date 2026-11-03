// queryIntent — extracted implementation; imports point to the owning modules.
import type { ContinuationCall } from "./packBasics.js";
import type { TaskPackSurface } from "../model.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { deriveIdentifierVariantProbes } from "../../search/find/findText.js";
import { extractEnumValueTokens } from "./createAndWiringEndpoints2.js";
import { kebabTokenVariant } from "./createAndWiringEndpoints2.js";

/** Style-file extensions the default code walk excludes (mirrors locate's STYLE_EXTRA_EXTS). */
export const STYLE_EXTRA_EXTS = [".css", ".scss", ".less"];

/**
 * Item 1 (named next when no style file exists): the fallback `next` for a pack
 * that STILL lacks a style surface after augmentStyleSurface (genuinely no
 * stylesheet in the root, or the caps were full). Instead of a bare "locate the
 * style role" re-pack, point at an `explore find` for the enum value's derived
 * TOKEN STEM (the CSS custom-property / BEM member form, via findText's
 * deriveIdentifierVariantProbes on the member-derived stem) — the concrete
 * string an agent would grep for. Returns undefined when there is no style gap
 * to name (style covered, or not an enum value we can derive a stem from), so
 * the caller keeps nextHintForCoverage's own hint.
 */
export function styleNextForMissingRole(query: string, surfaces: TaskPackSurface[]): ContinuationCall | undefined {
  if (surfaces.some((s) => s.role === "style")) return undefined;
  const valueTokens = extractEnumValueTokens(query);
  if (valueTokens.length === 0) return undefined;
  // The member-derived stem: probe the CSS custom-property / kebab forms of the
  // new value (deriveIdentifierVariantProbes handles single-identifier stems).
  const probes = deriveIdentifierVariantProbes(valueTokens[0]!);
  // Prefer a "--kebab" CSS custom-property probe (the actual design-token form);
  // else the first derived stem; else the kebab of the raw token.
  const stem =
    probes.find((p) => p.startsWith("--")) ??
    probes[0] ??
    kebabTokenVariant(valueTokens[0]!) ??
    valueTokens[0]!.toLowerCase();
  return { tool: "tl_search_files", arguments: { action: "find", query: stem } };
}

// ---------------------------------------------------------------------------
// FIX-B1/B2 (2026-07-09d forensics, task_pack round-trip collapse): server-
// side fill for missing REQUIRED surface roles, attempted INSIDE the same
// pack build instead of only suggesting a `surfaceRoles=[...]` retry.
//
// FIX-B1 root cause: `args.surfaceRoles` is read by requiredSurfacesForTask
// (it becomes the explicit required-role list) but was NEVER threaded into
// the underlying candidate SEARCH — LocateInput (packages/types/src/mcp.ts)
// has no role/surface filter at all, and buildTaskPack's locateTaskContext
// call passes only query/path/symbol/lang/limit. A `surfaceRoles=["contract",
// "api"]` retry therefore re-runs the IDENTICAL pathless `query` through the
// IDENTICAL locate pipeline and gets the IDENTICAL candidate pool back — the
// only difference is which roles THIS PACK labels "required". Confirmed
// empirically in the forensics (0/2 real retries changed the missing set at
// all). This is a plumbing miss, not a mistuned knob: there was never a
// role-aware search path for a retry to invoke. Adding a role filter to the
// shared locate contract would be a cross-package change (packages/types)
// well beyond this pack layer, so the fix instead generalizes the ONE
// role-targeted mechanism that already exists here (augmentStyleSurface, for
// "style") to every OTHER required role — see augmentMissingRequiredRoleSurfaces
// below. Running it unconditionally (not only on a surfaceRoles-flagged
// retry) is FIX-B2: it collapses the round trip so the FIRST call already
// finds a role the pathless query's own wording missed, instead of forcing
// the agent through a retry that (pre-fix) was guaranteed to be a no-op.
//
// Bounded to at most 2 extra internal search passes for the WHOLE fill
// (never per-role, so a pack with several missing roles cannot balloon into
// an unbounded number of extra lookups): one combined locateTaskContext call
// biased toward every still-missing role's structural vocabulary, then one
// classify/rank scan of the dominant root that issues NO further locate call
// at all (the same walkCodeFiles + classifySurface mechanism
// augmentStyleSurface already uses, generalized to any role). Only roles
// neither pass can find stay genuinely `missing`.
// ---------------------------------------------------------------------------

/**
 * Structural vocabulary hints per role — generic architectural words (never
 * project-specific vocabulary), used to bias a role-targeted locate pass
 * toward files that plausibly classify into a still-missing role when the
 * query's own wording did not surface one. "style" is deliberately absent:
 * augmentStyleSurface already runs a more precise (member-variant-token
 * aware) search for that role before this function ever sees the pack.
 */
export const ROLE_FILL_QUERY_HINTS: Partial<Record<string, string>> = {
  contract: "type interface schema enum model definition contract",
  api: "route handler endpoint controller service repository api",
  domain: "service domain business logic rules transition state",
  data: "repository model schema migration data store seed fixture",
  ui: "component view page screen widget ui",
  test: "test spec unit",
  doc: "readme documentation guide",
  config: "config settings options",
};

/** Required roles (excluding "style", already owned by augmentStyleSurface) not yet covered by any surface. */
export function stillMissingRequiredRoles(surfaces: TaskPackSurface[], requiredRoles: string[]): string[] {
  return requiredRoles.filter((r) => r !== "style" && !surfaces.some((s) => s.role === r));
}

/** Cap on how many query-named files are force-included as surfaces (bounded, deterministic). */
export const MAX_QUERY_NAMED_FILES = 3;

/**
 * Extensions the default code walk excludes but a caller routinely NAMES —
 * a contract doc, a config/schema file, a migration. The T05c query named
 * `CONTRACT.md` alongside two C++ files, and a resolution that could only see
 * code extensions would have silently dropped exactly the file carrying the
 * requirement.
 */
export const QUERY_NAMED_EXTRA_EXTS = [
  ...STYLE_EXTRA_EXTS,
  ".md", ".markdown", ".json", ".yaml", ".yml", ".toml", ".ini", ".txt", ".sql", ".sh", ".proto",
];

/**
 * SHOULD-FIX 11 (2026-09-13, review round): the walked file list above
 * depends only on `workspace` and which walk (default vs fullRecall) is
 * being consulted — never on `query`/`anchorPaths` — yet `queryNamedWorkspaceFiles`
 * has five call sites across one answer-pack build, each of which used to pay
 * for its OWN walk. Measured (rev-probe-walkperf.mts, this repo): default
 * walk ~2171 files/81-143ms, fullRecall ~2987 files/105-135ms — a
 * path-naming answer pack was paying roughly +3 redundant walks, and (pre
 * BLOCKER 3) enumerating `dist/` on every one of them. Scoped via ALS, not a
 * bare module-level `Map`, so a cached listing never survives past the ONE
 * `buildTaskPack` call that populated it (see the `.run()` wrapping it in
 * `buildTaskPack` below) — a file an `tl_edit_file` call creates between two
 * SEPARATE `tl_read_file` calls in the same session must still be visible to
 * the next call's own resolution; a process-lifetime cache
 * (roleInventoryCache's own choice, justified there by role membership
 * rarely changing) would be the wrong tradeoff for a resolution that names
 * EXACT files. Outside a tracked build (e.g. a unit test calling
 * queryNamedWorkspaceFiles directly), `getStore()` is undefined and the walk
 * simply runs uncached — same result as before this fix, just unmemoized.
 */
export const queryNamedFilesWalkStorage = new AsyncLocalStorage<Map<string, string[]> | undefined>();
