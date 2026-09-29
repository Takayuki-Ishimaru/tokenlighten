// Plain data only — no meta envelope, no 'tokenlighten:meta' wrappers.
// Reason: docs/00-postmortem.md §2.2

/**
 * Ignore matcher for CI skeleton: combines .gitignore semantics with
 * .tokenlightenignore and configurable exclude patterns.
 *
 * Ported from proto/src/core/ignore.ts — VSCode coupling removed.
 * Uses the 'ignore' npm package for .gitignore semantics.
 */

import ignore from "ignore";
import { join } from "node:path";
import { readRegularFileUtf8 } from "./readGuard.js";

/**
 * The two Python dependency-directory NAME patterns that name a virtualenv's
 * own parts (round-4 evaluation finding P1-9). Exported separately — not
 * just inlined in DEFAULT_IGNORE — so `walkRepo.ts` can build a second
 * matcher that excludes exactly these two: an explicit `path=` lift into (or
 * a `pyvenv.cfg`-marker-detected) virtualenv directory must not have either
 * pattern re-fire against its OWN nested content (a real `site-packages/`
 * one level down, or a decoy nested `.venv/`), while unrelated
 * DEFAULT_IGNORE entries (`node_modules/`, `dist/`, `__pycache__/`, …)
 * nested inside that same lift still exclude normally — see walkRepo.ts's
 * `buildLayerMatchers`/`classifyIgnored` (`liftIsVirtualenv`).
 */
export const VIRTUALENV_NAME_PATTERNS: string[] = [".venv/", "site-packages/"];

/**
 * Built-in default ignore patterns used when no .tokenlightenignore is found.
 * .tokenlightenignore (if present) ADDS to these defaults, not replaces them.
 * Named DEFAULT_IGNORE for testability and named export contract.
 */
export const DEFAULT_IGNORE: string[] = [
  // Package and build output
  "node_modules/",
  "dist/",
  "build/",
  ".next/",
  ".nuxt/",
  "out/",
  "coverage/",
  ".turbo/",
  ".claude/",
  "target/",
  "third_party/",
  "vendor/",
  // Dependency/tool-cache directories for languages other than Node.js —
  // the equivalent of node_modules/ for those ecosystems (2026-09-27, large-
  // workspace task_pack cost, item E). Same disclosed-omission treatment as
  // every other DEFAULT_IGNORE entry above: `walkRepo.ts`'s `classifyIgnored`
  // attributes a match here to `WalkOmissions.ignored` (always counted and
  // surfaced), none of these are in PROTECTED_IGNORE below, so an explicit
  // `path=` into one lifts it (see walkRepo.ts's `buildLayerMatchers`
  // liftScope) and a workspace's own `.tokenlightenignore` can override any
  // of them with a negation, exactly like `proto/`/`vendor/`/etc. above.
  // Deliberately NOT included: ambiguous bare names a real source directory
  // could plausibly be named too (`env/`, `lib/`, `packages/`) — every entry
  // below is a specific, well-known tool/build-cache convention name.
  ...VIRTUALENV_NAME_PATTERNS, // ".venv/" and "site-packages/" — see the
  // constant's own doc comment above. History below.
  //
  // Round-2 evaluation finding P2-15: a bare `venv/` (no dot) and
  // `site-packages/` lived here too, unanchored — an `ignore`-package
  // pattern with no leading/interior slash matches ANY directory of that
  // name at ANY depth. `venv/` collided with a genuinely plausible source
  // directory (`src/venv/manager.py` vanished from unscoped finds), so it
  // was dropped in favor of MARKER detection: `walkRepo.ts`'s
  // `hasVirtualenvMarkerFile` treats any directory containing `pyvenv.cfg`
  // (the file every `python -m venv` unconditionally writes at the
  // environment's root) as a Python virtualenv, WHATEVER its name.
  // `site-packages/` was ALSO dropped at that point (same unanchored-name
  // reasoning: it kept re-excluding its own content even after an explicit
  // `path=` lifted the venv it lives inside) — but round-4 evaluation
  // finding P1-9 found that going marker-only for `site-packages/` traded a
  // false positive for two false negatives: a virtualenv missing its
  // `pyvenv.cfg` (`venvNoMarker` — some creation tools omit or lose it) and
  // an in-place root virtualenv (`python -m venv .`, `rootInPlaceVenv`) both
  // leaked their `site-packages/` content, because a directory's OWN marker
  // is checked only for THAT directory, never for the workspace root (the
  // root is never a candidate for exclusion at all — seeing "." lifted would
  // hide everything). Unlike `venv/`, `site-packages/` is unambiguous: no
  // real source tree is ever named exactly that, so it is restored here as a
  // cheap, unconditional name pattern — it does not need (and cannot get
  // wrong) a marker check. `venv/` (bare, no dot) stays marker-only, since
  // `src/venv/manager.py` above is real, plausible source. The re-exclusion-
  // after-lift problem is fixed differently this time: `walkRepo.ts`'s
  // `buildLayerMatchers` now also lifts `VIRTUALENV_NAME_PATTERNS`
  // specifically (not name patterns in general) whenever the lift target
  // itself is a virtualenv — by name (this pattern) or by the `pyvenv.cfg`
  // marker AND its sibling shape (see `hasVirtualenvMarkerFile`) — so a
  // real `site-packages/` nested one or more levels inside an explicitly
  // lifted virtualenv stays visible, while unrelated DEFAULT_IGNORE entries
  // nested in the same lift (a vendored `node_modules/`, say) still exclude
  // normally. A marker with no matching sibling shape (a stray `pyvenv.cfg`
  // dropped in an ordinary source directory) is not treated as a virtualenv
  // at all any more — see `hasVirtualenvMarkerFile`'s own doc comment.
  "__pycache__/", // Python bytecode cache
  ".mypy_cache/", // mypy (Python type checker) cache
  ".pytest_cache/", // pytest cache
  ".ruff_cache/", // ruff (Python linter/formatter) cache
  ".tox/", // tox (Python test-matrix runner) environments
  ".dart_tool/", // Dart/Flutter tool cache
  ".gradle/", // Gradle (Java/Kotlin/Android) cache
  ".build/", // SwiftPM build output
  "Pods/", // CocoaPods (iOS/macOS) installed dependencies
  "DerivedData/", // Xcode build/index output
  // Generic conventional-directory defaults. These are NOT tied to any one
  // caller repository — "proto/" (legacy/generated-proto salvage),
  // "benchmark/"/"eval/" (perf or evaluation harness output), "samples/"
  // (example scaffolding), "release/"/"outputs/" (build/publish artifacts)
  // are common conventions across many codebases. Every one of them is a
  // DISCLOSED omission, never silent: walkRepo.ts's `classifyIgnored`
  // attributes any path matched here to `WalkOmissions.ignored`, which is
  // always counted and surfaced (search.tree's `excluded_by_reason.ignored`,
  // `omitted`/`scope_report`), and NONE of these six entries are in
  // PROTECTED_IGNORE below — so a workspace's own .tokenlightenignore CAN
  // override any of them with a negation (e.g. "!proto/\n!proto/**\n"),
  // unlike the PROTECTED_IGNORE entries, which no workspace file can lift.
  // Repository-specific exclusions (a particular fixture path, a particular
  // run-archive directory) do NOT belong here — see .tokenlightenignore at
  // the repo root, which is additive workspace configuration, not product
  // code (FX-T, 2026-09-03: moved "bench/fixtures/_buggy/" — a
  // TokenLighten-repo-specific literal that had been living here — out to
  // this repo's own .tokenlightenignore; see FX-R1 for the identical prior
  // move of "bench/workflows/runs/").
  "proto/",
  "benchmark/",
  "samples/",
  "eval/",
  "release/",
  "outputs/",
  // VCS and env
  ".git/",
  ".cache/",
  ".DS_Store",
  ".env",
  ".env.*",
  // TokenLighten's own cache/index output — MUST stay excluded so
  // .tokenlighten/cache/source-index.v1.json and .tokenlighten/index/
  // tl-graph.json don't get self-indexed on the NEXT loadOrBuildSourceIndex
  // run. Previously latent (no .json/.md/... extension had a recognized
  // language, so walk() skipped them regardless); became a real bug once
  // TEXT_EXTS (graph.ts) added .json as a text-bearing, enumerable
  // extension — a second index run would otherwise pick up its own
  // previous cache output as new textOnly entries, growing without bound.
  ".tokenlighten/",
  // Lockfiles
  "*.lock",
  "package-lock.json",
  "pnpm-lock.yaml",
  "*-lock.yaml",
  "yarn.lock",
  // Generated / minified
  "**/*.min.js",
  "**/*.min.css",
  "*.map",
  "*.snap",
  "generated/",
  "*.generated.*",
  "*.pb.*",
  "*.d.ts.map",
  "__generated__/",
];

/**
 * @deprecated Use DEFAULT_IGNORE instead.
 * Kept for backwards compatibility — points to the same array.
 */
export const DEFAULT_IGNORE_PATTERNS: string[] = DEFAULT_IGNORE;

const PROTECTED_IGNORE: string[] = [
  "node_modules/",
  ".git/",
  ".tokenlighten/",
  "third_party/",
  "vendor/",
  ".env",
  ".env.*",
];

export interface IgnoreMatcher {
  ignores(relPath: string): boolean;
}

/**
 * Normalize a path for the 'ignore' package:
 * - convert backslashes to forward slashes (Windows compat),
 * - strip leading "./" or "/" so path is workspace-relative.
 * Returns "" for paths that normalize to empty.
 */
/**
 * True when the `ignore` package would REFUSE `p` as non-relative rather than
 * answer false for it. Its win32 branch (activated by `process.platform` or
 * its own `IGNORE_TEST_WIN32` escape hatch, both read at module load) adds a
 * drive-letter-absolute rule on top of the leading-slash rule this module
 * already strips — so `C:/Users/x` reaches `ignores()` looking relative and
 * throws `RangeError: path should be a \`path.relative()\`d string`. The two
 * activation conditions are mirrored here so the guard is live in exactly the
 * cases the throw is.
 */
const IGNORE_REJECTS_DRIVE_ABSOLUTE =
  process.platform === "win32" || Boolean(process.env["IGNORE_TEST_WIN32"]);

function normalizePath(relPath: string): string {
  let p = relPath.replace(/\\/g, "/");
  while (p.startsWith("./")) p = p.slice(2);
  while (p.startsWith("/")) p = p.slice(1);
  // An absolute path cannot be matched by a relative ignore pattern anyway,
  // so the honest answer is "not ignored" — which every caller below reads
  // from the empty string. Returning it here turns a win32-only CRASH inside
  // a third-party matcher into the same false those callers already handle.
  // POSIX is untouched: `c:` is an ordinary relative segment there, and no
  // `ignore` version rejects it.
  if (IGNORE_REJECTS_DRIVE_ABSOLUTE && /^[a-z]:\//i.test(p)) return "";
  return p;
}

/**
 * Build an ignore matcher from default patterns plus optional extras.
 * Reads .gitignore and .tokenlightenignore from the repo root if present.
 */
export async function createIgnoreMatcher(
  root: string,
  extraPatterns?: string[],
): Promise<IgnoreMatcher> {
  const protectedDefaults = ignore().add(PROTECTED_IGNORE);
  const ig = ignore().add(DEFAULT_IGNORE);

  // Load .gitignore if present (best-effort).
  try {
    const gitignoreText = await readRegularFileUtf8(join(root, ".gitignore"));
    ig.add(gitignoreText);
  } catch {
    // No .gitignore — continue.
  }

  // Load .tokenlightenignore if present (best-effort).
  try {
    const tlignoreText = await readRegularFileUtf8(join(root, ".tokenlightenignore"));
    ig.add(tlignoreText);
  } catch {
    // No .tokenlightenignore — continue.
  }

  if (extraPatterns && extraPatterns.length > 0) {
    ig.add(extraPatterns);
  }

  return {
    ignores(relPath: string): boolean {
      const p = normalizePath(relPath);
      if (p === "") return false;
      return protectedDefaults.ignores(p) || ig.ignores(p);
    },
  };
}

/**
 * Synchronous variant for use without async context.
 * Does NOT read .gitignore or .tokenlightenignore from disk.
 */
export function createIgnoreMatcherSync(extraPatterns?: string[]): IgnoreMatcher {
  const protectedDefaults = ignore().add(PROTECTED_IGNORE);
  const ig = ignore().add(DEFAULT_IGNORE);
  if (extraPatterns && extraPatterns.length > 0) ig.add(extraPatterns);

  return {
    ignores(relPath: string): boolean {
      const p = normalizePath(relPath);
      if (p === "") return false;
      return protectedDefaults.ignores(p) || ig.ignores(p);
    },
  };
}

/**
 * Matcher over ONLY the given patterns — DEFAULT_IGNORE is not baked in.
 * Callers that must attribute an exclusion to a specific rule family
 * (heuristic defaults vs .gitignore vs user .tokenlightenignore) build one
 * matcher per layer instead of a single merged one.
 */
export function createPatternMatcherSync(patterns: string[]): IgnoreMatcher {
  const ig = ignore();
  if (patterns.length > 0) ig.add(patterns);

  return {
    ignores(relPath: string): boolean {
      const p = normalizePath(relPath);
      if (p === "") return false;
      return ig.ignores(p);
    },
  };
}
