/**
 * walkRepo — shared workspace walker for v0.4 explore/rename tools.
 *
 * Walks code files under a workspace root, skipping ignored dirs and
 * files larger than 1 MB. Used by findText, findReferences, renameSymbol.
 *
 * Uses createIgnoreMatcherSync from skeleton-engine so the ignore rules
 * (DEFAULT_IGNORE including bench/fixtures/_buggy/, proto/, node_modules/,
 * etc.) are shared with the skeleton builder — no more drift.
 */

import * as fs from "fs";
import * as path from "path";
import { TextDecoder } from "node:util";
import { AsyncLocalStorage } from "node:async_hooks";
import {
  createIgnoreMatcherSync,
  createPatternMatcherSync,
  DEFAULT_IGNORE,
  VIRTUALENV_NAME_PATTERNS,
  type IgnoreMatcher,
} from "@tokenlighten/skeleton-engine";
import { loadWorkspaceGitignorePatterns } from "../util/gitignorePatterns.js";
import { MCP_LANG_EXTS } from "@tokenlighten/types";
import type { McpLang } from "@tokenlighten/types";
import { looksLikeSecretFile } from "../write/secretScan.js";

export type LangKey = McpLang;

export interface FoundFile {
  /** Workspace-relative path with POSIX separators. */
  relPath: string;
  absPath: string;
  /** Language ID (e.g. "typescript", "python") or "default" for unknown. */
  language: string;
  /** Lowercased extension including the leading dot (e.g. ".ts"). */
  ext: string;
  /** Discovery lane: binary artifact or opt-in generic UTF-8 text. */
  kind?: "artifact" | "generic-text";
}

const LANG_EXTS: Record<LangKey, readonly string[]> = MCP_LANG_EXTS;

const ALL_TRACKED_EXTS = new Set<string>([
  ".ts", ".tsx", ".mts", ".cts",
  ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".pyi",
  ".go",
  ".rs",
  ".java",
  ".kt", ".kts",
  ".c", ".h", ".cc", ".cpp", ".cxx", ".hpp", ".hh", ".hxx",
  ".rb",
  ".cs",
  ".php",
]);

/**
 * Artifact (non-code data source) extensions discoverable only through the
 * explicit artifact opt-in — never walked as code, never scanned as UTF-8
 * content. The binary office/PDF set, plus text-but-tabular csv/tsv: a large
 * data CSV is a first-class artifact source (served structured via
 * mode=artifact / office/csv.ts), exactly like an xlsx, rather than code.
 */
export const ARTIFACT_EXTS = [".docx", ".xlsx", ".pptx", ".pdf", ".csv", ".tsv"] as const;
const ARTIFACT_EXT_SET: ReadonlySet<string> = new Set(ARTIFACT_EXTS);

const EXT_TO_LANG: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "typescriptreact",
  ".mts": "typescript",
  ".cts": "typescript",
  ".js": "javascript",
  ".jsx": "javascriptreact",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".py": "python",
  ".pyi": "python",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".kt": "kotlin",
  ".kts": "kotlin",
  ".c": "c",
  ".h": "c",
  ".cc": "cpp",
  ".cpp": "cpp",
  ".cxx": "cpp",
  ".hpp": "cpp",
  ".hh": "cpp",
  ".hxx": "cpp",
  ".rb": "ruby",
  ".cs": "csharp",
  ".php": "php",
};

const MAX_FILE_SIZE_BYTES = 1_000_000;
const GENERIC_TEXT_PROBE_BYTES = 8 * 1024;

/**
 * Discovery ceiling for plain text/identifier scan consumers (tl_search_files
 * find/references) that pass `sizeCapBytes` explicitly. `walkCodeFiles` is
 * shared by every product surface — task-pack candidate enumeration, role
 * derivation, rename, tree, AND find/references — but only the last two do a
 * cheap line-by-line read+regex scan; the others (symbol/role indexing) carry
 * real per-file parse cost the 1 MB default exists to bound. A plain grep
 * scan has no such cost (a 21k-line/~1 MB hand-written source file is trivial
 * to read and line-split), so gating it at the SAME 1 MB ceiling made a file
 * that both exists and matches invisible to find/references while the walk's
 * own `omitted.oversize` counter (correctly) recorded the skip — the caller
 * had no reason to doubt an `absence`/`inventory_complete:true` that was
 * silently scoped to less than the whole repo.
 *
 * 8 MB mirrors core2/walk.ts's already-validated bound (its own doc comment:
 * "the adversarial payload gate requires 1MB single-line JSON / minified JS
 * to be searchable with bounded evidence, so this sits at 8MB … above the
 * 5MB grid top") — large enough for any realistic hand-written or
 * single-line-minified source file, small enough to still exclude (and
 * disclose via `omitted.oversize`) genuinely pathological blobs. Callers that
 * only need a directory listing or symbol-index candidate (tree, task-pack,
 * rename, role derivation) do not pass `sizeCapBytes` and keep the original
 * 1 MB ceiling unchanged — `deriveFileRole` also carries its own independent
 * ROLE_SKIP_FILE_OVER_BYTES gate (findText.ts), so widening discovery here
 * never forces a >1 MB file's role to be derived.
 */
export const TEXT_SCAN_MAX_FILE_SIZE_BYTES = 8 * 1024 * 1024;

/**
 * Runtime kill switch for public generic-text discovery. It is evaluated per
 * request for tests and embedders; a new server process picks up environment
 * changes without republishing the MCP.
 */
export function genericTextDiscoveryEnabled(): boolean {
  return process.env.TL_GENERIC_TEXT_DISCOVERY !== "0";
}

export interface WalkOptions {
  /** Restrict to a single language (matches LANG_EXTS keys). */
  lang?: LangKey;
  /** Restrict to a single file or subdirectory (workspace-relative). */
  subPath?: string;
  /** Include binary office/PDF artifacts as tagged discovery-only entries. */
  includeArtifacts?: boolean;
  /**
   * Include only otherwise-untracked, strict-UTF-8 regular text files. This
   * opt-in generic lane is ignored when `lang` narrows the walk.
   */
  includeGenericText?: boolean;
  /**
   * Additional extensions (lowercase, with leading dot, e.g. ".css") to
   * include on top of the default tracked-code set. Additive only — never
   * narrows the default set, and ignored when `lang` is set (lang already
   * narrows to one language's extensions). Callers that need non-code assets
   * discoverable (e.g. explore action=find over CSS custom properties) opt
   * in explicitly; every other walkCodeFiles caller is unaffected.
   */
  extraExts?: readonly string[];
  /**
   * Additional exact, case-sensitive basenames (e.g. "Dockerfile",
   * "Makefile") to include on top of the default tracked-code set —
   * companion to `extraExts` for well-known extensionless files, matched
   * against the file's own name rather than its extension (which is empty
   * for these). Same additive-only / lang-narrows-take-precedence semantics
   * as `extraExts`; every other walkCodeFiles caller is unaffected.
   */
  extraBasenames?: readonly string[];
  /**
   * Full-recall mode for correctness-critical callers (findReferences,
   * renameSymbol) that must see EVERY reference to be correct. When true,
   * skips ONLY the build-dir noise filtering (`/dist/`, `/build/`,
   * `/generated/`, `/__generated__/`, and `looksGeneratedFile`) so
   * legitimately-named source (e.g. `src/build/utils.ts`,
   * `src/codegen/generated/schema.ts`) is not silently dropped.
   *
   * The runs-dir / .tokenlighten cache+index / coverage exclusions are NOT
   * relaxed — those are never source. Default false keeps the noise-filtering
   * used by orientation callers (task_pack / overview / find) unchanged.
   */
  fullRecall?: boolean;
  /**
   * Treat the workspace's .gitignore as a discovery-noise signal: gitignored
   * paths are skipped (and counted) on unscoped walks, while an explicit
   * `subPath` pointing INTO a gitignored area lifts the layer for that
   * subtree — ignored never means unimportant. Off by default so write-side
   * callers (checkpoint, pathlessEdit, rename) keep full visibility.
   */
  respectGitignore?: boolean;
  /** When provided, per-layer skip counts accumulate into it. */
  omissions?: WalkOmissions;
  /**
   * Override the default MAX_FILE_SIZE_BYTES oversize ceiling for this walk.
   * Pass TEXT_SCAN_MAX_FILE_SIZE_BYTES for a plain text/identifier scan
   * (find, references) — see that constant's doc comment for why a much
   * larger cap is safe there but not for every walkCodeFiles caller. Omitted
   * keeps the original 1 MB ceiling.
   */
  sizeCapBytes?: number;
}

// FX-R1 (2026-09-03, round-18B review finding 1): FX-O3's generalization of
// `bench/workflows/runs/` (a TokenLighten-repository-specific literal) to a
// bare leaf-named `runs/` at ANY depth was worse than the literal it
// replaced. `runs/` is an ordinary production directory name — a REST
// resource (`src/api/runs/`), a domain package (`internal/runs/`,
// `app/models/runs/`), an orchestration store — so the generalized rule
// hid real source in every OTHER caller repository, silently (no
// `WalkOmissions` counter fired — the call sites below were a bare
// `continue`/`return`), and BEFORE the `fullRecall` bypass, so `find`/
// `references` certified scope-complete `absence` over files they never
// scanned. REMOVED from product code entirely: a run-archive exclusion is
// repository configuration, not a general source-only rule —
// TokenLighten's own `bench/workflows/runs/` is now excluded via a
// root-anchored line in THIS repo's `.tokenlightenignore` instead (an
// ordinary, disclosed `tokenlighten_ignored` omission, ignore-layer honesty
// included).
//
// The remaining entries below (`.tokenlighten/cache|index/`, `coverage/`)
// stay — they are genuinely never source in ANY repository — but every
// call site now increments `WalkOmissions.source_only_excluded` when one of
// them fires, so they are (a) disclosed exactly like every other skip class
// via `omitted`/`scope_report.excluded_by_reason`, and (b) NEVER
// absence-certificate-compatible (`buildAbsenceExtra`/`withAbsence` withhold
// entirely while it is > 0), same treatment an oversize file or an
// unreadable directory already gets. In practice these three entries are
// already caught earlier by `classifyIgnored`'s shared `DEFAULT_IGNORE`
// layer (skeleton-engine's own `.tokenlighten/` and `coverage/` patterns),
// which discloses them as `ignored` before this function is ever reached —
// this counter is defense-in-depth for the `fullRecall` path and any future
// drift, not a live silent gap the way the removed `runs/` entry was.
const SOURCE_ONLY_EXCLUDED_PREFIXES = [
  ".tokenlighten/cache/",
  ".tokenlighten/index/",
  "coverage/",
];

const SOURCE_ONLY_EXCLUDED_SEGMENTS = [
  "/.tokenlighten/cache/",
  "/.tokenlighten/index/",
  "/coverage/",
];

/**
 * Build-dir / generated noise segments. These are correct to filter for
 * orientation modes, but can drop legitimately-named source (a package with a
 * real `src/build/` or `**\/generated/` directory), so full-recall callers
 * (findReferences / renameSymbol) opt OUT of them via WalkOptions.fullRecall.
 */
const BUILD_DIR_EXCLUDED_SEGMENTS = [
  "/dist/",
  "/build/",
  "/generated/",
  "/__generated__/",
];

/**
 * Negation ("!") patterns that re-include the build-dir / generated classes
 * excluded by skeleton-engine's shared DEFAULT_IGNORE (dist/, build/,
 * generated/, __generated__/, *.min.js, *.min.css, *.generated.*, *.pb.*,
 * *.d.ts.map, *.map). Passed as extraPatterns to createIgnoreMatcherSync only
 * on the fullRecall path so findReferences/renameSymbol see every reference.
 *
 * The never-source classes (node_modules/, proto/, coverage/,
 * bench/fixtures/_buggy/, .git/, .cache/, lockfiles, …) are intentionally NOT
 * negated — full-recall never resurrects those.
 */
const FULL_RECALL_REINCLUDE_PATTERNS = [
  "!dist/", "!dist/**",
  "!build/", "!build/**",
  "!generated/", "!generated/**",
  "!__generated__/", "!__generated__/**",
  "!out/", "!out/**",
  "!**/*.min.js",
  "!**/*.min.css",
  "!**/*.generated.*",
  "!**/*.pb.*",
];

/**
 * Cache of a workspace's `.tokenlightenignore` patterns (parsed once per
 * process per workspace root). The sync ignore matcher does NOT read disk by
 * contract (createIgnoreMatcherSync), so `.tokenlightenignore` — the repo's
 * (and any user's) additive exclusions on top of DEFAULT_IGNORE — is loaded
 * here and threaded in as extra patterns, giving every walkCodeFiles caller
 * (findText / findReferences / locate / task_pack / tree) the same
 * user-configurable exclusions the async skeleton builder already honors.
 *
 * This is where repo conventions like docs/ and reports/ now live (a
 * `.tokenlightenignore` at the repo root), instead of being hard-coded into
 * the locator's product code. Empty-string sentinel means "checked, none
 * present" so a missing file is not re-stat'd on every walk.
 */
const tokenlightenIgnoreCache = new Map<string, string[]>();

function loadTokenlightenIgnorePatterns(workspace: string): string[] {
  const key = path.resolve(workspace);
  const cached = tokenlightenIgnoreCache.get(key);
  if (cached !== undefined) return cached;
  let patterns: string[] = [];
  try {
    const text = fs.readFileSync(path.join(key, ".tokenlightenignore"), "utf8");
    patterns = text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith("#"));
  } catch {
    // No .tokenlightenignore — additive exclusions are simply empty.
  }
  tokenlightenIgnoreCache.set(key, patterns);
  return patterns;
}

/** Test hook: forget cached `.tokenlightenignore` patterns (fixtures mutate on disk). */
export function resetTokenlightenIgnoreCache(): void {
  tokenlightenIgnoreCache.clear();
}

/**
 * Per-layer skip counters for one walk. Every skip class an agent could
 * mistake for "searched and found nothing" is counted, never silent: the
 * heuristic DEFAULT_IGNORE layer, the borrowed .gitignore layer, the
 * user-authored .tokenlightenignore layer, oversize files, and unfollowed
 * symlinks.
 */
export interface WalkOmissions {
  ignored: number;
  gitignored: number;
  tokenlighten_ignored: number;
  oversize: number;
  symlinks: number;
  /** Generic-text probe rejected the file as binary or invalid UTF-8. */
  non_text: number;
  /** Secret/credential policy excluded generic candidates (names withheld). */
  secrets: number;
  /**
   * F-A1-2 (PI-04): a directory `readdirSync` could not list (e.g. EACCES).
   * Unlike every other category above, this is NOT a known, nameable
   * exclusion — the walk cannot say how many files or what they contain, so
   * a zero-match response over the rest of the tree must not certify
   * absence while this is > 0 (see findText.ts's buildAbsenceExtra gate).
   */
  unreadable_dirs: number;
  /**
   * Finding 1 (2026-09-03, INV-H): `opts.subPath` lexically escaped the
   * workspace root (an absolute path outside it, or a relative `../..`
   * climb) — the walk touched zero files, and this is NOT the same as a
   * genuinely empty or fully-ignored in-workspace directory. Counted here so
   * a caller that reaches `walkCodeFiles` directly (no prior boundary check
   * of its own) still gets an honest `omitted` disclosure instead of a
   * confidence-shaped 0-match indistinguishable from a real exhaustive scan.
   * `tl_search_files action=find` additionally hard-refuses this case before
   * ever reaching this function (`findText.ts`'s `findScopeBoundaryRefusal`),
   * so this counter fires for find's escape only via defense-in-depth (e.g.
   * a future call site that bypasses that guard); it is the FIRST and ONLY
   * disclosure for any caller that has no such guard.
   */
  outside_workspace: number;
  /**
   * FX-R1 (2026-09-03, round-18B review finding 1): a path excluded by
   * `isSourceOnlyExcludedPath` — EVERY class that function covers, not only
   * the never-source `SOURCE_ONLY_EXCLUDED_PREFIXES`/`_SEGMENTS` literals
   * (`.tokenlighten/cache|index/`, `coverage/`): on the non-fullRecall
   * (orientation) path it ALSO covers the build-dir/generated noise class
   * (`/dist/`, `/build/`, `/generated/`, `/__generated__/`, and
   * `looksGeneratedFile` — `.d.ts`, `.map`, `.min.js`, `.min.css`,
   * `.generated.*`, `.pb.*`), which `fullRecall` callers (findReferences,
   * renameSymbol) relax and therefore never hit this counter for. The
   * review's own ruling names "coverage/dist/build/out/etc." together as
   * needing the SAME treatment, and this single function already unified
   * both classes — so one counter, one gate, covers the whole ruling rather
   * than requiring a second one for the noise class.
   *
   * A DELIBERATE, policy-driven exclusion like `ignored`, but counted in its
   * own bucket rather than folded into it because these rules live in
   * product code, not `.tokenlightenignore`/`DEFAULT_IGNORE`, and because a
   * zero-match search over ANY nonzero count here must withhold its absence
   * certificate entirely (see `buildAbsenceExtra`/`withAbsence`) rather than
   * merely caveat it the way `ignored`/`gitignored` do — this is the fix for
   * the exact silent-hiding class the `runs/` generalization introduced (see
   * the doc comment above `SOURCE_ONLY_EXCLUDED_PREFIXES`).
   */
  source_only_excluded: number;
  /**
   * N7(c) (r-b2, 2026-09-21, review finding N7) — a SUBSET of `ignored`:
   * every entry counted here was ALSO counted in `ignored` (this field never
   * changes `ignored`'s own value, `search.tree`'s `excluded_by_reason`, or
   * any other existing wire count — it is additive, internal bookkeeping
   * only, never surfaced on the wire). Counts ONLY a top-level VCS metadata
   * directory (currently: a `.git` entry, DEFAULT_IGNORE's own `.git/`
   * pattern) skipped by `classifyIgnored` below. Root cause: EVERY
   * git-tracked workspace has `.ignored >= 1` purely from skipping `.git/`
   * plumbing no query could ever mean to search — readCodeTaskPack.ts's
   * request-item absence scope note (`scopeCompletenessAfterScan`) used the
   * raw `ignored` count directly, so an otherwise scope-complete scan of an
   * ordinary git checkout ALWAYS reported "N path(s) excluded from the
   * scan", even when the only exclusion was `.git` itself — never a real gap
   * in what the scan covered. This field lets that ONE caller subtract the
   * VCS-metadata slice back out; every OTHER DEFAULT_IGNORE entry sharing
   * the `ignored` bucket (`node_modules/`, `dist/`, `vendor/`, …) is
   * untouched and stays a real, disclosed omission there.
   */
  vcs_metadata: number;
}

export function createWalkOmissions(): WalkOmissions {
  return { ignored: 0, gitignored: 0, tokenlighten_ignored: 0, oversize: 0, symlinks: 0, non_text: 0, secrets: 0, unreadable_dirs: 0, outside_workspace: 0, source_only_excluded: 0, vcs_metadata: 0 };
}

export function anyWalkOmission(o: WalkOmissions): boolean {
  return o.ignored > 0 || o.gitignored > 0 || o.tokenlighten_ignored > 0 || o.oversize > 0 || o.symlinks > 0 || o.non_text > 0 || o.secrets > 0 || o.unreadable_dirs > 0 || o.outside_workspace > 0 || o.source_only_excluded > 0;
}

const gitignorePatternsCache = new Map<string, string[]>();

function loadGitignorePatternsCached(workspace: string): string[] {
  const key = path.resolve(workspace);
  const cached = gitignorePatternsCache.get(key);
  if (cached !== undefined) return cached;
  const patterns = loadWorkspaceGitignorePatterns(key);
  gitignorePatternsCache.set(key, patterns);
  return patterns;
}

/** Test hook: forget cached `.gitignore` patterns (fixtures mutate on disk). */
export function resetGitignorePatternsCache(): void {
  gitignorePatternsCache.clear();
}

/**
 * Single-path predicate: would the shared walk exclusion rules (DEFAULT_IGNORE
 * + this workspace's `.tokenlightenignore`) exclude `relPath`? Built on the
 * same (non-fullRecall) matcher walkCodeFiles uses, so a path the walk would
 * never yield here returns true. Reuses the cached `.tokenlightenignore`
 * patterns — no extra disk read beyond the existing per-workspace cache.
 *
 * This is the mechanism other product code (e.g. pathlessEdit's symbol-scoped
 * candidate filter) should call instead of hard-coding repo-specific prefixes:
 * exclusions live in DEFAULT_IGNORE / `.tokenlightenignore`, not in scattered
 * product-code constants.
 */
export function isWalkIgnoredPath(workspace: string, relPath: string): boolean {
  const p = normalizeRelPath(relPath);
  if (!p) return false;
  const matcher = ignoreMatcherFor(false, workspace);
  return matcher.ignores(p);
}

/**
 * Select the ignore matcher for a walk. The default (orientation) matcher is
 * skeleton-engine's shared DEFAULT_IGNORE matcher PLUS the workspace's
 * `.tokenlightenignore` additions. The fullRecall matcher additionally applies
 * negation patterns that re-admit build-dir/generated source so
 * correctness-critical callers see every reference; the re-include negations
 * come AFTER the user patterns so a user cannot accidentally un-ignore
 * build/generated output — but a user's own `.tokenlightenignore` exclusion
 * (e.g. docs/) still applies on the fullRecall path too.
 */
function ignoreMatcherFor(fullRecall: boolean, workspace: string): IgnoreMatcher {
  const userPatterns = loadTokenlightenIgnorePatterns(workspace);
  const extra = fullRecall ? [...userPatterns, ...FULL_RECALL_REINCLUDE_PATTERNS] : userPatterns;
  return createIgnoreMatcherSync(extra.length > 0 ? extra : undefined);
}

function normalizeRelPath(relPath: string): string {
  let p = relPath.replace(/\\/g, "/");
  while (p.startsWith("./")) p = p.slice(2);
  while (p.startsWith("/")) p = p.slice(1);
  return p;
}

function looksGeneratedFile(p: string): boolean {
  return (
    p.endsWith(".d.ts") ||
    p.endsWith(".d.ts.map") ||
    p.endsWith(".map") ||
    p.includes(".generated.") ||
    p.includes(".pb.") ||
    p.endsWith(".min.js") ||
    p.endsWith(".min.css")
  );
}

function isExcludedBySourceOnlyRules(p: string, fullRecall = false): boolean {
  const withSentinel = `/${p}`;
  if (
    SOURCE_ONLY_EXCLUDED_PREFIXES.some((prefix) => p.startsWith(prefix)) ||
    SOURCE_ONLY_EXCLUDED_SEGMENTS.some((segment) => withSentinel.includes(segment))
  ) {
    return true;
  }
  // Build-dir / generated noise is only filtered in the default
  // (orientation) mode. Full-recall callers keep such source visible.
  if (fullRecall) return false;
  return (
    BUILD_DIR_EXCLUDED_SEGMENTS.some((segment) => withSentinel.includes(segment)) ||
    looksGeneratedFile(p)
  );
}

function isExplicitNoiseScope(scope: string | undefined): boolean {
  if (!scope) return false;
  const normalized = normalizeRelPath(scope);
  let end = normalized.length;
  while (end > 0 && normalized[end - 1] === "/") end--;
  const s = normalized.slice(0, end);
  return isExcludedBySourceOnlyRules(s) || isExcludedBySourceOnlyRules(`${s}/`);
}

export function isSourceOnlyExcludedPath(
  relPath: string,
  explicitSubPath?: string,
  fullRecall = false,
): boolean {
  const p = normalizeRelPath(relPath);
  if (!p) return false;
  const rawScope = explicitSubPath ? normalizeRelPath(explicitSubPath) : "";
  let scopeEnd = rawScope.length;
  while (scopeEnd > 0 && rawScope[scopeEnd - 1] === "/") scopeEnd--;
  const scope = rawScope.slice(0, scopeEnd);
  if (scope && isExplicitNoiseScope(scope) && (p === scope || p.startsWith(`${scope}/`))) {
    return false;
  }
  return isExcludedBySourceOnlyRules(p, fullRecall);
}

function extOf(name: string): string {
  return path.extname(name).toLowerCase();
}

function langForExt(ext: string): string {
  return EXT_TO_LANG[ext] ?? "default";
}

/**
 * A bounded, strict probe used only by the explicit generic lane. Streaming
 * carries multi-byte UTF-8 sequences across chunk boundaries; finalization
 * rejects a trailing incomplete sequence after the full file has been read.
 */
function isGenericTextFile(absPath: string, size: number): boolean {
  let fd: number | undefined;
  try {
    fd = fs.openSync(absPath, "r");
    const chunk = Buffer.allocUnsafe(GENERIC_TEXT_PROBE_BYTES);
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let offset = 0;
    while (offset < size) {
      const read = fs.readSync(fd, chunk, 0, Math.min(chunk.length, size - offset), offset);
      if (read === 0) return false;
      const bytes = chunk.subarray(0, read);
      if (bytes.includes(0)) return false;
      decoder.decode(bytes, { stream: true });
      offset += read;
    }
    // Finalize the stream so a trailing incomplete sequence is rejected.
    decoder.decode();
    return true;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* best effort */ }
    }
  }
}

function isWithin(child: string, base: string): boolean {
  return child === base || child.startsWith(base + path.sep);
}

/**
 * Walk the workspace and return tracked code files, byte-stable sorted.
 *
 * - opts.subPath = single file → returns [that file] if it qualifies
 * - opts.subPath = subdirectory → walks that subtree
 * - opts.subPath unset → walks the whole workspace
 * - opts.lang restricts to that language's extensions (else all tracked exts)
 */
interface LayerMatchers {
  /** DEFAULT_IGNORE + .tokenlightenignore — exactly the pre-layered decision. */
  combined: IgnoreMatcher;
  /** DEFAULT_IGNORE (with fullRecall re-inclusions) only — the heuristic layer. */
  defaultOnly: IgnoreMatcher;
  /**
   * Same as `defaultOnly` minus `VIRTUALENV_NAME_PATTERNS` (`.venv/`,
   * `site-packages/`) — round-4 finding P1-9. Used ONLY for the scoped
   * re-anchoring check inside a lift whose target is itself a virtualenv
   * (`liftIsVirtualenv`): the explicit lift already means "show me this
   * venv's contents", so its own nested `site-packages/` (or a decoy nested
   * `.venv/`) must not re-fire, while unrelated DEFAULT_IGNORE entries
   * nested in the same lift (a vendored `node_modules/`, say) still exclude
   * normally — see `classifyIgnored`.
   */
  defaultOnlyNoVirtualenv: IgnoreMatcher;
  /** User-authored .tokenlightenignore only; null when absent/empty. */
  tlOnly: IgnoreMatcher | null;
  /** Workspace .gitignore only; null unless respectGitignore found patterns. */
  gitOnly: IgnoreMatcher | null;
  /** Explicit subPath whose default/gitignore exclusion is lifted ("" = none). */
  liftScope: string;
  /**
   * True when `liftScope` itself is a virtualenv — matched by
   * `VIRTUALENV_NAME_PATTERNS` (by name, at any depth: the lift can target
   * the venv root OR reach straight into its `site-packages/`) or by the
   * `pyvenv.cfg` marker AND its sibling shape (`hasVirtualenvMarkerFile`).
   * Gates which `defaultOnly` variant the lifted branch of `classifyIgnored`
   * re-checks against, and also waives the marker+shape check itself for
   * content already inside this lift (P1-9's "name- and marker-based
   * alike"). Meaningless when `liftScope === ""`.
   */
  liftIsVirtualenv: boolean;
}

function buildLayerMatchers(
  workspace: string,
  fullRecall: boolean,
  respectGitignore: boolean,
  subPath: string | undefined,
): LayerMatchers {
  const userPatterns = loadTokenlightenIgnorePatterns(workspace);
  const combined = ignoreMatcherFor(fullRecall, workspace);
  const defaultOnly = createIgnoreMatcherSync(fullRecall ? [...FULL_RECALL_REINCLUDE_PATTERNS] : undefined);
  const defaultOnlyNoVirtualenv = createPatternMatcherSync([
    ...DEFAULT_IGNORE.filter((p) => !VIRTUALENV_NAME_PATTERNS.includes(p)),
    ...(fullRecall ? FULL_RECALL_REINCLUDE_PATTERNS : []),
  ]);
  const virtualenvNameOnly = createPatternMatcherSync(VIRTUALENV_NAME_PATTERNS);
  const tlOnly = userPatterns.length > 0 ? createPatternMatcherSync(userPatterns) : null;
  const gitPatterns = respectGitignore ? loadGitignorePatternsCached(workspace) : [];
  const gitOnly = gitPatterns.length > 0 ? createPatternMatcherSync(gitPatterns) : null;

  let liftScope = "";
  let liftIsVirtualenv = false;
  if (subPath) {
    const normalizedScope = normalizeRelPath(subPath);
    let scopeEnd = normalizedScope.length;
    while (scopeEnd > 0 && normalizedScope[scopeEnd - 1] === "/") scopeEnd--;
    let scope = normalizedScope.slice(0, scopeEnd);
    // "." (whole-workspace) and parent-escaping scopes are not liftable
    // targets, and the ignore matcher rejects them outright.
    if (scope === "." || scope === ".." || scope.startsWith("../")) scope = "";
    const scopeIgnoredBy = (m: IgnoreMatcher | null): boolean =>
      m !== null && (m.ignores(scope) || m.ignores(scope + "/"));
    // P1-9: the scope is also a virtualenv lift when it is itself named (at
    // any depth) by a virtualenv pattern, or when it is itself a directory
    // that passes the marker+shape check — never when scope === "" (the
    // workspace root is never a virtualenv lift target).
    const scopeIsVirtualenv =
      scope !== "" && (scopeIgnoredBy(virtualenvNameOnly) || hasVirtualenvMarkerFile(path.join(workspace, scope)));
    // Pointing the walk AT an area the heuristic or borrowed layer hides is
    // explicit intent — ignored never means unimportant, so those two layers
    // are waived for the subtree. The user-authored layer is never waived.
    if (scope && !scopeIgnoredBy(tlOnly) && (scopeIgnoredBy(defaultOnly) || scopeIgnoredBy(gitOnly) || scopeIsVirtualenv)) {
      liftScope = scope;
      liftIsVirtualenv = scopeIsVirtualenv;
    }
  }
  return { combined, defaultOnly, defaultOnlyNoVirtualenv, tlOnly, gitOnly, liftScope, liftIsVirtualenv };
}

function classifyIgnored(
  layers: LayerMatchers,
  relPath: string,
  isDir: boolean,
): "ignored" | "gitignored" | "tokenlighten_ignored" | null {
  const p = isDir ? relPath + "/" : relPath;
  if (layers.liftScope !== "" && (relPath === layers.liftScope || relPath.startsWith(layers.liftScope + "/"))) {
    if (layers.tlOnly?.ignores(p)) return "tokenlighten_ignored";
    // The heuristic layer is re-anchored at the lifted scope: entering dist/
    // on purpose must not also drag in the node_modules/ nested inside it.
    // A virtualenv lift re-anchors against the NO-virtualenv variant instead
    // (P1-9): its own nested site-packages/ (or a decoy nested .venv/) must
    // stay visible, while unrelated entries like node_modules/ still don't.
    const scoped = relPath.slice(layers.liftScope.length + 1);
    const reanchored = layers.liftIsVirtualenv ? layers.defaultOnlyNoVirtualenv : layers.defaultOnly;
    if (scoped !== "" && reanchored.ignores(isDir ? scoped + "/" : scoped)) return "ignored";
    return null;
  }
  if (layers.combined.ignores(p)) {
    // The user-authored layer is the binding constraint (it is never
    // lifted), so it wins attribution even when a heuristic pattern also
    // matches — the disclosure must name the rule the user can act on.
    return layers.tlOnly?.ignores(p) ? "tokenlighten_ignored" : "ignored";
  }
  if (layers.gitOnly?.ignores(p)) return "gitignored";
  return null;
}

/**
 * Round-2 evaluation finding P2-15: a Python virtualenv, WHATEVER its name —
 * `python -m venv <any-name>` (and `virtualenv`, `uv venv`, etc.) always
 * writes `pyvenv.cfg` directly at the environment's own root, never inside
 * its nested `lib/…/site-packages/`. `venv/` (bare, no dot) is a NAME
 * pattern round-3 deliberately left out of DEFAULT_IGNORE — a NAME pattern
 * with no leading/interior slash matches at any depth, which collided with
 * a genuinely plausible source directory (`src/venv/manager.py`) — so a
 * marker check recognizes it (and any other spelling) instead: it runs once
 * per candidate directory during the walk itself, and a plain
 * `src/venv/manager.py` with no `pyvenv.cfg` sibling at its directory root
 * is never touched.
 *
 * Round-4 finding P1-9 added the SHAPE requirement below: a bare
 * `pyvenv.cfg`, alone, is not enough — `markerInSrc` showed a stray marker
 * file (dropped into an ordinary source directory, no real environment
 * around it) hiding that entire directory. A real virtualenv's `pyvenv.cfg`
 * always has a `site-packages/` sibling (POSIX: `lib/python<major>.<minor>/
 * site-packages/`; Windows: `Lib/site-packages/`) and/or an `activate`
 * script (`bin/activate` POSIX, `Scripts/activate` Windows) one level below
 * it; a marker with NEITHER sibling is not treated as a virtualenv at all —
 * the directory stays visible, exactly like it would with no marker.
 * `site-packages/` itself is a separate, unconditional NAME pattern in
 * DEFAULT_IGNORE now (unambiguous, no shape check needed — see `ignore.ts`);
 * this function only decides whether the ENVIRONMENT ROOT (the directory
 * `pyvenv.cfg` lives in) is hidden as a whole, whatever it is named.
 *
 * Failure (permission denied, a symlinked/broken entry, at either the
 * marker or the shape check) reads as "not a virtualenv" — never throws.
 */
function hasVirtualenvMarkerFile(absDirPath: string): boolean {
  try {
    if (!fs.statSync(path.join(absDirPath, "pyvenv.cfg")).isFile()) return false;
  } catch {
    return false;
  }
  return hasVirtualenvSiblingShape(absDirPath);
}

/** See `hasVirtualenvMarkerFile`'s doc comment — the sibling-shape half of the check. */
function hasVirtualenvSiblingShape(absDirPath: string): boolean {
  const isDir = (rel: string): boolean => {
    try {
      return fs.statSync(path.join(absDirPath, ...rel.split("/"))).isDirectory();
    } catch {
      return false;
    }
  };
  const isFile = (rel: string): boolean => {
    try {
      return fs.statSync(path.join(absDirPath, ...rel.split("/"))).isFile();
    } catch {
      return false;
    }
  };
  if (isDir("Lib/site-packages")) return true; // Windows layout (no python-version segment)
  if (isFile("bin/activate")) return true; // POSIX activation script
  if (isFile("Scripts/activate")) return true; // Windows activation script (POSIX-shell variant)
  try {
    const libDir = path.join(absDirPath, "lib");
    for (const entry of fs.readdirSync(libDir, { withFileTypes: true })) {
      if (entry.isDirectory() && /^python\d/i.test(entry.name) && isDir(`lib/${entry.name}/site-packages`)) return true;
    }
  } catch {
    // No lib/ (or unreadable) — fall through to false.
  }
  return false;
}

/**
 * Review-2 finding 6 (2026-09-08): the WHOLE `.tokenlighten/` namespace is
 * this server's own runtime bookkeeping, never workspace material — the
 * durable state store (`.tokenlighten/state/`, keyed on-disk so a repeated
 * search's own declared scope survives a restart) and skeleton-engine's
 * `cache/`/`index/` caches alike. An earlier revision of this predicate
 * exempted only the STATE subtree from `WalkOmissions` and let the walker
 * descend into the surrounding `.tokenlighten` root anyway (deliberately, per
 * that revision's own reasoning: "cache/index/user files still count as
 * explicit exclusions") — but that meant the identical query, run twice on an
 * unchanged workspace, could flip its own honesty qualifier from "scope
 * complete" to "N paths excluded from the scan" the moment `.tokenlighten/`
 * FIRST appeared between the two calls, purely as a side effect of this
 * server's own first write (creating `cache/`, `index/`, or `state/`). A
 * caller cannot act on that disclosure — it names no workspace file the
 * caller wrote or configured — so it is not a scan omission worth reporting
 * at all, any more than the state subtree already was not. This predicate now
 * covers the whole namespace: every server-owned artifact directory under
 * `.tokenlighten/`, present or future, is invisible to `WalkOmissions` the
 * same way it is invisible to the scan itself (both call sites below `return`
 * / `continue` on this check BEFORE any classification runs, so nothing under
 * it is walked OR counted). `.tokenlightenignore` — the user-AUTHORED
 * exclusions file — is unaffected: it lives at the workspace root, is a
 * regular file the walker classifies normally, and continues to be counted
 * via `tokenlighten_ignored` exactly as before.
 */
function isTokenlightenNamespacePath(relPath: string): boolean {
  return relPath === ".tokenlighten" || relPath.startsWith(".tokenlighten/");
}

/**
 * N7(c) (r-b2, 2026-09-21) — the VCS METADATA class `WalkOmissions.vcs_metadata`
 * counts: currently just `.git`, DEFAULT_IGNORE's own recognized entry
 * (matched by basename, at ANY depth, so a nested submodule's own `.git`
 * counts too — the same "matches at any depth" semantics DEFAULT_IGNORE's
 * bare `.git/` gitignore-style pattern already has). A worktree/submodule's
 * `.git` is sometimes a FILE (a "gitdir: …" pointer), not a directory —
 * checked by name alone here, independent of which `classifyIgnored` call
 * site (file or directory) fires, so either shape is recognized alike.
 */
function isVcsMetadataName(name: string): boolean {
  return name === ".git";
}

function walkCodeFilesCore(workspace: string, opts: WalkOptions): FoundFile[] {
  const allowedExts: Set<string> | null = opts.lang
    ? new Set(LANG_EXTS[opts.lang] ?? [])
    : null;
  // Additive-only supplemental set (e.g. [".css"]); ignored when lang narrows
  // to one language, since an explicit lang filter takes precedence.
  const extraExts: Set<string> | null =
    !opts.lang && opts.extraExts && opts.extraExts.length > 0 ? new Set(opts.extraExts) : null;
  // Additive-only supplemental basename set (e.g. ["Dockerfile"]) — same
  // lang-narrows-take-precedence semantics as extraExts, see WalkOptions doc.
  const extraBasenames: Set<string> | null =
    !opts.lang && opts.extraBasenames && opts.extraBasenames.length > 0
      ? new Set(opts.extraBasenames)
      : null;

  // Artifacts are a separate opt-in surface. An explicit language filter wins.
  const includeArtifacts = !opts.lang && opts.includeArtifacts === true;
  // Generic discovery is an explicit, generic-only lane. It never changes a
  // language-filtered walk or duplicates files selected by the semantic lane.
  const includeGenericText = !opts.lang && opts.includeGenericText === true;
  const fullRecall = opts.fullRecall ?? false;
  const om = opts.omissions;
  const sizeCapBytes = opts.sizeCapBytes ?? MAX_FILE_SIZE_BYTES;
  const out: FoundFile[] = [];
  const workspaceResolved = path.resolve(workspace);

  // The out-of-workspace escape check runs BEFORE buildLayerMatchers, not
  // after it. buildLayerMatchers hands `subPath` straight to the `ignore`
  // matcher (to decide whether the walk is pointed AT a hidden subtree), and
  // on win32 that package REFUSES a drive-letter-absolute path outright —
  // `RangeError: path should be a \`path.relative()\`d string, but got
  // "C:/Users/..."` — so an ABSOLUTE out-of-tree subPath, which is exactly
  // the Finding 1 shape this counter exists for, CRASHED the walk instead of
  // being counted. Whether a path escapes the workspace is a property of the
  // path alone; no matcher is needed to decide it, so it belongs ahead of
  // every matcher construction rather than after one.
  const subPathAbs = opts.subPath ? path.resolve(workspace, opts.subPath) : undefined;
  if (subPathAbs !== undefined && !isWithin(subPathAbs, workspaceResolved)) {
    if (om) om.outside_workspace += 1;
    return out;
  }
  const layers = buildLayerMatchers(workspace, fullRecall, opts.respectGitignore ?? false, opts.subPath);

  if (opts.subPath) {
    const abs = subPathAbs!;
    let resolvedAbs = abs;
    let workspaceReal = workspaceResolved;
    let stat: fs.Stats;
    try {
      if (fs.lstatSync(abs).isSymbolicLink()) {
        if (om) om.symlinks += 1;
        return out;
      }
      workspaceReal = fs.realpathSync(workspaceResolved);
      resolvedAbs = fs.realpathSync(abs);
      if (!isWithin(resolvedAbs, workspaceReal)) {
        if (om) om.symlinks += 1;
        return out;
      }
      stat = fs.statSync(resolvedAbs);
    } catch { return out; }
    if (stat.isFile()) {
      const relPath = path.relative(workspaceReal, resolvedAbs).replace(/\\/g, "/");
      const layer = classifyIgnored(layers, relPath, false);
      if (layer) {
        if (om) {
          om[layer] += 1;
          if (layer === "ignored" && isVcsMetadataName(path.basename(relPath))) om.vcs_metadata += 1;
        }
        return out;
      }
      if (isSourceOnlyExcludedPath(relPath, opts.subPath, fullRecall)) {
        if (om) om.source_only_excluded += 1;
        return out;
      }
      const base = path.basename(abs);
      const ext = extOf(base);
      const artifactMatch = includeArtifacts && ARTIFACT_EXT_SET.has(ext);
      const knownMatch =
        (allowedExts ? allowedExts.has(ext) : ALL_TRACKED_EXTS.has(ext)) ||
        (extraExts?.has(ext) ?? false) ||
        (extraBasenames?.has(base) ?? false) ||
        artifactMatch;
      if (stat.size > sizeCapBytes) {
        if ((knownMatch || includeGenericText) && om) om.oversize += 1;
        return out;
      }
      const secretMatch = includeGenericText && looksLikeSecretFile(relPath);
      if (secretMatch && !knownMatch && om) om.secrets += 1;
      const genericTextMatch =
        includeGenericText && !knownMatch && !secretMatch && !ARTIFACT_EXT_SET.has(ext) && isGenericTextFile(resolvedAbs, stat.size);
      if (knownMatch || genericTextMatch) {
        out.push({
          relPath,
          absPath: resolvedAbs,
          language: langForExt(ext),
          ext,
          ...(artifactMatch ? { kind: "artifact" as const } : genericTextMatch ? { kind: "generic-text" as const } : {}),
        });
      } else if (includeGenericText && !knownMatch && !secretMatch && !ARTIFACT_EXT_SET.has(ext) && om) {
        om.non_text += 1;
      }
      return out;
    }
    if (stat.isDirectory()) {
      walkDir(workspaceReal, resolvedAbs, allowedExts, extraExts, extraBasenames, includeArtifacts, includeGenericText, layers, out, om, sizeCapBytes, opts.subPath, fullRecall);
    }
  } else {
    walkDir(workspaceResolved, workspaceResolved, allowedExts, extraExts, extraBasenames, includeArtifacts, includeGenericText, layers, out, om, sizeCapBytes, opts.subPath, fullRecall);
  }

  out.sort((a, b) => Buffer.compare(Buffer.from(a.relPath), Buffer.from(b.relPath)));
  return out;
}

// ---------------------------------------------------------------------------
// Perf (2026-09-27, large-workspace task_pack cost, item C) — per-REQUEST
// walk memoization. Measured ~16 real walkCodeFilesCore calls for ONE
// tl_read_file task_pack on an 11.6k-file workspace (locateTaskContext.ts's own
// per-call WalkCache already dedupes ITS OWN helpers, but findText.ts and
// findReferences.ts each walk independently of it and of each other, and
// several readCodeTaskPack.ts candidate-enumeration helpers do too), each
// walk costing ~1s of classifyIgnored + the `ignore` package's own matching
// over a 12k-entry tree.
//
// requestWalkScope holds one memo per REQUEST (never across requests — "no
// cross-request walk cache in this round" per this wave's brief). It is
// opened by server.ts around tl_read_file/tl_search_files dispatch ONLY, via
// runWithWalkRequestScope — NEVER around tl_edit_file: a write can change what
// the very next walk in the SAME request would see, so a write-spanning
// cache would go stale within its own request. walkCodeFiles below checks
// the scope transparently; with no scope open (every existing caller that
// invokes it directly, outside server.ts's dispatch — e.g. every spec in
// this package) it is a pure passthrough to walkCodeFilesCore, byte-for-byte
// identical to today.
// ---------------------------------------------------------------------------

interface WalkRequestCacheEntry {
  files: FoundFile[];
  /**
   * This walk's OWN contribution only — never whatever the caller's own
   * `opts.omissions` object already held before this call. Kept separate so
   * a cache hit can be REPLAYED (added) into a second caller's omissions
   * object without double-counting the first caller's own prior baggage —
   * see walkCodeFiles' cache-hit branch below.
   */
  omissions: WalkOmissions;
}

const requestWalkScope = new AsyncLocalStorage<Map<string, WalkRequestCacheEntry>>();

/**
 * Open a per-request walkCodeFiles memo for the duration of `fn`. Call this
 * around one tl_read_file/tl_search_files dispatch ONLY (see the doc comment
 * above) — never spanning more than one dispatch, and never around
 * tl_edit_file.
 */
export function runWithWalkRequestScope<T>(fn: () => T): T {
  return requestWalkScope.run(new Map(), fn);
}

/**
 * Stable, order-independent cache key covering every WalkOptions field that
 * affects walkCodeFilesCore's result (`omissions` is an out-parameter, not
 * part of the result identity, so it is deliberately excluded).
 */
function requestWalkCacheKey(workspace: string, opts: WalkOptions): string {
  return JSON.stringify({
    workspace: path.resolve(workspace),
    lang: opts.lang ?? null,
    subPath: opts.subPath ?? null,
    includeArtifacts: opts.includeArtifacts ?? false,
    includeGenericText: opts.includeGenericText ?? false,
    extraExts: opts.extraExts ? [...opts.extraExts].sort() : null,
    extraBasenames: opts.extraBasenames ? [...opts.extraBasenames].sort() : null,
    fullRecall: opts.fullRecall ?? false,
    respectGitignore: opts.respectGitignore ?? false,
    sizeCapBytes: opts.sizeCapBytes ?? null,
  });
}

/** Additive replay: `target`'s pre-existing counts are preserved, `delta`'s are added on top — see WalkRequestCacheEntry's doc comment for why this must never be an overwrite. */
function addOmissionsInto(target: WalkOmissions, delta: WalkOmissions): void {
  target.ignored += delta.ignored;
  target.gitignored += delta.gitignored;
  target.tokenlighten_ignored += delta.tokenlighten_ignored;
  target.oversize += delta.oversize;
  target.symlinks += delta.symlinks;
  target.non_text += delta.non_text;
  target.secrets += delta.secrets;
  target.unreadable_dirs += delta.unreadable_dirs;
  target.outside_workspace += delta.outside_workspace;
  target.source_only_excluded += delta.source_only_excluded;
  target.vcs_metadata += delta.vcs_metadata;
}

/**
 * Walk the workspace and return tracked code files, byte-stable sorted —
 * see walkCodeFilesCore's own doc comment for the actual walk semantics
 * (unchanged). This wrapper ONLY adds the per-request memo described above;
 * with no request scope open, `result` is exactly `walkCodeFilesCore`'s own
 * return value (a fresh array each call, as always). With a scope open,
 * a REPEATED call with the identical option-set within the same request
 * returns a fresh COPY of the first call's result instead of re-walking —
 * `opts.omissions`, if the caller supplied one, still receives this walk's
 * exact contribution either way (additive replay on a cache hit, direct
 * accumulation on a miss), so a caller cannot tell the difference from the
 * omissions it observes.
 */
export function walkCodeFiles(workspace: string, opts: WalkOptions = {}): FoundFile[] {
  const store = requestWalkScope.getStore();
  if (!store) return walkCodeFilesCore(workspace, opts);

  const key = requestWalkCacheKey(workspace, opts);
  const cached = store.get(key);
  if (cached) {
    if (opts.omissions) addOmissionsInto(opts.omissions, cached.omissions);
    return cached.files.slice();
  }

  // Always walk with a FRESH delta accumulator, regardless of whether the
  // caller passed its own `opts.omissions` — see WalkRequestCacheEntry's doc
  // comment for why the cached snapshot must never include the caller's own
  // pre-existing counts.
  const delta = createWalkOmissions();
  const files = walkCodeFilesCore(workspace, { ...opts, omissions: delta });
  store.set(key, { files, omissions: delta });
  if (opts.omissions) addOmissionsInto(opts.omissions, delta);
  return files.slice();
}

function walkDir(
  workspace: string,
  dir: string,
  allowedExts: Set<string> | null,
  extraExts: Set<string> | null,
  extraBasenames: Set<string> | null,
  includeArtifacts: boolean,
  includeGenericText: boolean,
  layers: LayerMatchers,
  out: FoundFile[],
  om: WalkOmissions | undefined,
  sizeCapBytes: number,
  explicitSubPath?: string,
  fullRecall = false,
): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true }) as fs.Dirent[];
  } catch {
    // F-A1-2 (PI-04): disclose the skipped subtree instead of vanishing it —
    // an absence certificate built while this is > 0 would be certifying
    // over an unknown remainder (see findText.ts's buildAbsenceExtra gate).
    if (om) om.unreadable_dirs += 1;
    return;
  }

  entries.sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)));

  for (const entry of entries) {
    const name = entry.name;
    const absPath = path.join(dir, name);
    const relPath = path.relative(workspace, absPath).replace(/\\/g, "/");

    if (entry.isSymbolicLink()) {
      // Never followed (escape safety); counted so consumers can disclose it.
      if (om) om.symlinks += 1;
    } else if (entry.isDirectory()) {
      // Finding 6: the whole `.tokenlighten` namespace (root and every
      // descendant) is invisible to BOTH the scan and `WalkOmissions` — never
      // walked, never counted. See `isTokenlightenNamespacePath`'s own doc
      // comment for why this widened past the state-store subtree alone.
      if (isTokenlightenNamespacePath(relPath)) continue;
      const layer = classifyIgnored(layers, relPath, true);
      if (layer) {
        if (om) {
          om[layer] += 1;
          if (layer === "ignored" && isVcsMetadataName(name)) om.vcs_metadata += 1;
        }
        continue;
      }
      // P2-15/P1-9: a Python virtualenv marker+shape (`pyvenv.cfg` plus a
      // site-packages/activate sibling — see `hasVirtualenvMarkerFile`),
      // whatever this directory is named — not a name pattern, so an
      // explicit `path=` lift straight into it (walkCodeFilesCore starts the
      // walk AT the resolved subPath itself, never through this entries
      // loop for that exact directory) is unaffected. Content already
      // reached by lifting an ANCESTOR of it is unaffected too — UNLESS that
      // ancestor lift is itself a virtualenv (`liftIsVirtualenv`): P1-9's
      // "an explicitly lifted dependency directory lifts the dependency
      // patterns nested inside it (name- and marker-based alike)" means a
      // real nested venv inside an already-lifted venv must stay visible,
      // the same as its nested site-packages/ does (classifyIgnored, above).
      const insideVirtualenvLift = layers.liftIsVirtualenv && relPath.startsWith(layers.liftScope + "/");
      if (!insideVirtualenvLift && hasVirtualenvMarkerFile(absPath)) {
        if (om) om.ignored += 1;
        continue;
      }
      if (isSourceOnlyExcludedPath(relPath + "/", explicitSubPath, fullRecall)) {
        if (om) om.source_only_excluded += 1;
        continue;
      }
      walkDir(workspace, absPath, allowedExts, extraExts, extraBasenames, includeArtifacts, includeGenericText, layers, out, om, sizeCapBytes, explicitSubPath, fullRecall);
    } else if (entry.isFile()) {
      if (isTokenlightenNamespacePath(relPath)) continue;
      const layer = classifyIgnored(layers, relPath, false);
      if (layer) {
        if (om) {
          om[layer] += 1;
          if (layer === "ignored" && isVcsMetadataName(name)) om.vcs_metadata += 1;
        }
        continue;
      }
      if (isSourceOnlyExcludedPath(relPath, explicitSubPath, fullRecall)) {
        if (om) om.source_only_excluded += 1;
        continue;
      }
      const ext = extOf(name);
      const trackedByDefault = allowedExts !== null ? allowedExts.has(ext) : ALL_TRACKED_EXTS.has(ext);
      const extraExtMatch = extraExts?.has(ext) ?? false;
      const basenameMatch = extraBasenames?.has(name) ?? false;
      const artifactMatch = includeArtifacts && ARTIFACT_EXT_SET.has(ext);
      const knownMatch = trackedByDefault || extraExtMatch || basenameMatch || artifactMatch;
      let size: number;
      try { size = fs.statSync(absPath).size; } catch { continue; }
      if (size > sizeCapBytes) {
        if ((knownMatch || includeGenericText) && om) om.oversize += 1;
        continue;
      }
      const secretMatch = includeGenericText && looksLikeSecretFile(relPath);
      if (secretMatch && !knownMatch && om) om.secrets += 1;
      const genericTextMatch =
        includeGenericText && !knownMatch && !secretMatch && !ARTIFACT_EXT_SET.has(ext) && isGenericTextFile(absPath, size);
      if (!knownMatch && !genericTextMatch) {
        if (includeGenericText && !secretMatch && !ARTIFACT_EXT_SET.has(ext) && om) om.non_text += 1;
        continue;
      }

      out.push({
        relPath,
        absPath,
        language: langForExt(ext),
        ext,
        ...(artifactMatch ? { kind: "artifact" as const } : genericTextMatch ? { kind: "generic-text" as const } : {}),
      });
    }
  }
}
