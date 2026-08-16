import type { ImpactSurface } from "@tokenlighten/types";

export function classifySurface(relPath: string, symbol?: string): ImpactSurface {
  const lower = relPath.toLowerCase();
  const basename = lower.split("/").pop() ?? lower;

  // 1. contract
  if (
    lower.includes("/shared/") ||
    /\/enums\./.test(lower) ||
    lower.includes("/schema") ||
    lower.includes("/types/") ||
    lower.includes("/openapi") ||
    lower.includes("/proto/") ||
    basename.endsWith(".proto") ||
    (symbol !== undefined && /^[A-Z][A-Za-z0-9]*Enum$/.test(symbol))
  ) {
    return "contract";
  }

  // 2. test
  if (
    /\.(spec|test)\.[a-z]+$/.test(lower) ||
    lower.includes("/__tests__/") ||
    /\/tests?\//.test(lower) ||
    /\btest/.test(lower)
  ) {
    return "test";
  }

  // 2b. generic domain-logic directories. Project-specific subsystem names
  // are intentionally absent; relation evidence handles those repositories.
  // NOTE: these subdirectory checks run BEFORE the generic include/inc →
  // contract rule (2e below) so that a header living under a recognized
  // domain/api/config subdir (e.g. include/control/wave_shaper.hpp)
  // classifies by what it *is* (domain) rather than collapsing to
  // "contract" just because it sits under include/. A firmware multi-file
  // fix pack needs those headers spread across domain/api/config; only a
  // truly top-level public header (include/acme/config.hpp) with no
  // recognized subdir should fall through to contract.
  if (
    /\/(?:control|mode|failsafe|algorithm|solver|filter)\//.test(lower) ||
    /^src\/(?:control|mode|failsafe|algorithm|solver|filter)\//.test(lower) ||
    /(?:transition|state-machine|statemachine|lifecycle)/.test(basename)
  ) {
    return "domain";
  }

  // 2c. generic API/transport directories
  if (
    /\/(?:protocol|transport)\//.test(lower) ||
    /^src\/(?:protocol|transport)\//.test(lower)
  ) {
    return "api";
  }

  // 2d. firmware/native: HAL/driver/platform → config
  if (
    /\/(?:driver|hal|platform|rtos|bsp)\//.test(lower)
  ) {
    return "config";
  }

  // 2f. firmware/native: remaining public headers → contract. Runs AFTER the
  // domain/api/config subdir checks above so only headers NOT under a
  // recognized subdir (e.g. include/app/types.hpp, include/acme/config.hpp)
  // land here.
  if (
    /^include\//.test(lower) ||
    /\/include\//.test(lower) ||
    /^inc\//.test(lower) ||
    /\/inc\//.test(lower)
  ) {
    return "contract";
  }

  // 2e. doc surface for non-excluded markdown design notes
  if (
    /\.md$/.test(lower) &&
    !lower.startsWith("docs/") &&
    !lower.startsWith("proto/")
  ) {
    return "doc";
  }

  // 3. style
  if (
    /\.(css|scss|less)$/.test(lower) ||
    lower.includes("/tokens.css") ||
    lower.includes("/theme")
  ) {
    return "style";
  }

  // 4. ui
  if (
    /\.(tsx|jsx|vue|svelte)$/.test(lower) ||
    lower.includes("/component") ||
    lower.includes("/page") ||
    lower.includes("/web/")
  ) {
    return "ui";
  }

  // 5. config
  if (
    basename === "package.json" ||
    /^tsconfig.*\.json$/.test(basename) ||
    /\.(config\.(js|ts|mjs|cjs|json))$/.test(basename) ||
    basename === "dockerfile" ||
    basename === "makefile" ||
    lower.includes("/config/")
  ) {
    return "config";
  }

  // 6. data
  //
  // Leaf-scoped: a "/migration", "/seed", "/fixture" keyword only counts when
  // it names the file itself (basename) or its immediate parent directory —
  // NOT any ancestor segment. A whole-path substring check (the previous
  // behavior) let a `/fixtures/` ancestor anywhere in the path — e.g.
  // fixtures/someapp/api/src/routes/users.ts — swallow files
  // that live many levels below it and belong to a different, deeper role
  // (here: api, via the /route rule below). Restricting to the deepest
  // role-bearing segment (basename, else immediate parent) means the keyword
  // has to describe what the file/directory actually IS, not merely where it
  // happens to be nested. word-boundary-ish matching (segment-start anchor +
  // non-alpha-or-end boundary) also avoids a coincidental substring match
  // inside an unrelated segment name (e.g. a "parserService" file must not
  // become "data" just because some other segment's name embeds "seed").
  const segments = lower.split("/").filter((s) => s.length > 0);
  const parentSegment = segments.length >= 2 ? segments[segments.length - 2] : "";
  const dataKeyword = /(^|[^a-z])(migrations?|seeds?|fixtures?)([^a-z]|$)/;
  if (
    dataKeyword.test(basename) ||
    dataKeyword.test(parentSegment) ||
    lower.endsWith(".sql")
  ) {
    return "data";
  }

  // 7. api
  // Match both directory forms (singular "/repository/" and plural
  // "/repositories/") and filename-prefix forms (e.g. "issueRepository.ts",
  // "issue-repository.ts") — a plain "/repository" substring check misses
  // the very common plural-directory + camelCase-filename layout
  // (apps/api/src/repositories/issueRepository.ts), which previously
  // classified as "unknown" and was then dropped from the pack.
  if (
    lower.includes("/service") ||
    lower.includes("/controller") ||
    lower.includes("/route") ||
    lower.includes("/handler") ||
    lower.includes("/validator") ||
    lower.includes("/middleware") ||
    /(?:reporter|publisher|sender|receiver)[._-]/.test(basename) ||
    /\/reposit(ory|ories)\//.test(lower) ||
    /reposit(ory|ories)[._-]/.test(basename) ||
    basename.endsWith("repository.ts") ||
    basename.endsWith("repository.js") ||
    basename.endsWith("repository.py") ||
    basename.endsWith("repository.go") ||
    basename.endsWith("repository.java")
  ) {
    return "api";
  }

  // 8. domain (generic business logic). Runs LAST before "unknown" so every
  // more-specific rule above keeps winning. Two signals, both leaf-scoped
  // like the data rule: an explicit domain/model-layer directory, or a
  // computation-shaped name (engine/calculator/pricing/rating — e.g.
  // pricing/rating_engine.py, which previously classified "unknown" and was
  // therefore never credited toward a pack's required "domain" role).
  const domainKeyword = /(^|[^a-z])(engine|calculator|pricing|rating)([^a-z]|$)/;
  if (
    /\/(?:domain|models?|usecases?)\//.test(lower) ||
    domainKeyword.test(basename) ||
    domainKeyword.test(parentSegment)
  ) {
    return "domain";
  }

  return "unknown";
}

/**
 * Pure surface-inventory: the set of surface ROLES that structurally exist in
 * a project root, computed from a list of workspace-relative paths.
 *
 * This is the domain-agnostic core of the "never require a role that does not
 * exist here" rule (DESIGN-v0.8 §A2/§A3): a required role (contract/api/ui/
 * style/...) that the root's own files do not classify into must be dropped
 * before it can brand a pack "partial" and send the agent locating a surface
 * that cannot exist (e.g. a C++ firmware root has no ui/style role at all).
 *
 * Parameters:
 *   - `relPaths`  — the walked file list (workspace-relative POSIX).
 *   - `rootOf`    — maps a relPath to the project root it belongs to (the
 *                   caller's `projectRootOf`), so the inventory is scoped to
 *                   ONE root even when the walk spans several.
 *   - `root`      — the root to scope to; `null` means "no scoping" (every
 *                   file counts, e.g. a single-root workspace or a pre-locate
 *                   whole-workspace check).
 *   - `classify`  — maps a relPath to its surface role (the caller's
 *                   `classifySurface`), injected rather than imported so this
 *                   stays a pure, independently-unit-testable function.
 *
 * Early-exits once every role classify can emit has been seen (there is a
 * fixed, small number of ImpactSurface roles), so a huge file list does not
 * force a full pass when the first handful already cover all roles.
 */
export function surfaceInventory(
  relPaths: ReadonlyArray<string>,
  rootOf: (relPath: string) => string,
  root: string | null,
  classify: (relPath: string) => ImpactSurface,
): ReadonlySet<ImpactSurface> {
  // Every distinct role classify can return — used only for the early-exit
  // ceiling, so an incomplete list simply means the pass never short-circuits
  // (still correct, just not early). "unknown" is excluded: it is not a real
  // role a required-surface check would ever demand, so seeing it must not
  // count toward the "all roles found" ceiling.
  const ALL_ROLES: ReadonlyArray<ImpactSurface> = [
    "contract", "api", "domain", "data", "ui", "style", "test", "config", "doc",
  ];
  const seen = new Set<ImpactSurface>();
  for (const relPath of relPaths) {
    if (root !== null && rootOf(relPath) !== root) continue;
    const role = classify(relPath);
    if (role !== "unknown") seen.add(role);
    if (seen.size >= ALL_ROLES.length) break;
  }
  return seen;
}

/**
 * Derive generic case/separator variants of an identifier-like token so
 * literal-text search (findText) and family-stem CSS/BEM scans can find a
 * value regardless of the naming convention used at the usage site.
 *
 * Deliberately domain-agnostic: earlier versions hard-coded specific
 * project vocabulary (e.g. "TicketPriority.", "chip--level-") which only
 * matched one benchmark fixture's naming scheme and produced false negatives
 * (and wasted search budget) on every other repo. The variants below are
 * derived purely from the token's own casing/shape, not assumed domain
 * words, so they generalize to any codebase.
 */
export function deriveTokenVariants(token: string): string[] {
  const result: string[] = [];
  const seen = new Set<string>();

  function add(v: string): void {
    const trimmed = v.trim();
    if (trimmed.length > 0 && !seen.has(trimmed)) {
      seen.add(trimmed);
      result.push(trimmed);
    }
  }

  add(token);

  const lower = token.toLowerCase();
  add(lower);

  const capitalized = lower.charAt(0).toUpperCase() + lower.slice(1);
  add(capitalized);

  const isAllCaps = /^[A-Z][A-Z0-9_]{1,}$/.test(token);

  if (isAllCaps) {
    // Generic separator-style variants derived from the token's own
    // characters — kebab-case and snake_case forms of the same value, which
    // is how enum-like constants commonly appear in CSS custom properties,
    // BEM class names, and URL/query params across languages.
    const kebab = lower.replace(/_/g, "-");
    const snake = lower.replace(/-/g, "_");
    add(kebab);
    add(snake);
    // Common generic wrapper shapes for a bare enum value used as a
    // CSS custom property or BEM modifier: "--<value>" / "<prefix>--<value>".
    // These are structural (any "--kebab" suffix), not tied to one project's
    // vocabulary; callers still need a real occurrence to match.
    add(`-${kebab}`);
    add(`--${kebab}`);
  } else {
    // camelCase split: split on capital letters that follow a lowercase letter
    const camelParts = token.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase();
    if (camelParts !== lower) {
      add(camelParts);
    }
    // snake_case / kebab-case cross-variant (identifiers that already use a
    // separator commonly appear with the other separator style too).
    if (token.includes("_")) add(token.toLowerCase().replace(/_/g, "-"));
    if (token.includes("-")) add(token.toLowerCase().replace(/-/g, "_"));
  }

  return result;
}

export function coverage(
  candidateSurfaces: ReadonlySet<ImpactSurface>,
  requiredSurfaces: ReadonlyArray<ImpactSurface>,
): { covered: ImpactSurface[]; missing: ImpactSurface[] } {
  const covered: ImpactSurface[] = [];
  const missing: ImpactSurface[] = [];
  for (const surface of requiredSurfaces) {
    if (candidateSurfaces.has(surface)) {
      covered.push(surface);
    } else {
      missing.push(surface);
    }
  }
  return { covered, missing };
}
