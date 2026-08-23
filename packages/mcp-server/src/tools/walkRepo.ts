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
import { createIgnoreMatcherSync, createPatternMatcherSync, type IgnoreMatcher } from "@tokenlighten/skeleton-engine";
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
 * Discovery ceiling for plain text/identifier scan consumers (search_files
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
   * The bench-runs / .tokenlighten cache+index / coverage exclusions are NOT
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

const SOURCE_ONLY_EXCLUDED_PREFIXES = [
  "bench/workflows/runs/",
  ".tokenlighten/cache/",
  ".tokenlighten/index/",
  "coverage/",
];

const SOURCE_ONLY_EXCLUDED_SEGMENTS = [
  "/bench/workflows/runs/",
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
}

export function createWalkOmissions(): WalkOmissions {
  return { ignored: 0, gitignored: 0, tokenlighten_ignored: 0, oversize: 0, symlinks: 0, non_text: 0, secrets: 0, unreadable_dirs: 0 };
}

export function anyWalkOmission(o: WalkOmissions): boolean {
  return o.ignored > 0 || o.gitignored > 0 || o.tokenlighten_ignored > 0 || o.oversize > 0 || o.symlinks > 0 || o.non_text > 0 || o.secrets > 0 || o.unreadable_dirs > 0;
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
  const s = normalizeRelPath(scope).replace(/\/+$/, "");
  return isExcludedBySourceOnlyRules(s) || isExcludedBySourceOnlyRules(`${s}/`);
}

export function isSourceOnlyExcludedPath(
  relPath: string,
  explicitSubPath?: string,
  fullRecall = false,
): boolean {
  const p = normalizeRelPath(relPath);
  if (!p) return false;
  const scope = explicitSubPath ? normalizeRelPath(explicitSubPath).replace(/\/+$/, "") : "";
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
  /** User-authored .tokenlightenignore only; null when absent/empty. */
  tlOnly: IgnoreMatcher | null;
  /** Workspace .gitignore only; null unless respectGitignore found patterns. */
  gitOnly: IgnoreMatcher | null;
  /** Explicit subPath whose default/gitignore exclusion is lifted ("" = none). */
  liftScope: string;
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
  const tlOnly = userPatterns.length > 0 ? createPatternMatcherSync(userPatterns) : null;
  const gitPatterns = respectGitignore ? loadGitignorePatternsCached(workspace) : [];
  const gitOnly = gitPatterns.length > 0 ? createPatternMatcherSync(gitPatterns) : null;

  let liftScope = "";
  if (subPath) {
    let scope = normalizeRelPath(subPath).replace(/\/+$/, "");
    // "." (whole-workspace) and parent-escaping scopes are not liftable
    // targets, and the ignore matcher rejects them outright.
    if (scope === "." || scope === ".." || scope.startsWith("../")) scope = "";
    const scopeIgnoredBy = (m: IgnoreMatcher | null): boolean =>
      m !== null && (m.ignores(scope) || m.ignores(scope + "/"));
    // Pointing the walk AT an area the heuristic or borrowed layer hides is
    // explicit intent — ignored never means unimportant, so those two layers
    // are waived for the subtree. The user-authored layer is never waived.
    if (scope && !scopeIgnoredBy(tlOnly) && (scopeIgnoredBy(defaultOnly) || scopeIgnoredBy(gitOnly))) {
      liftScope = scope;
    }
  }
  return { combined, defaultOnly, tlOnly, gitOnly, liftScope };
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
    const scoped = relPath.slice(layers.liftScope.length + 1);
    if (scoped !== "" && layers.defaultOnly.ignores(isDir ? scoped + "/" : scoped)) return "ignored";
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

export function walkCodeFiles(workspace: string, opts: WalkOptions = {}): FoundFile[] {
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
  const layers = buildLayerMatchers(workspace, fullRecall, opts.respectGitignore ?? false, opts.subPath);
  const om = opts.omissions;
  const sizeCapBytes = opts.sizeCapBytes ?? MAX_FILE_SIZE_BYTES;
  const out: FoundFile[] = [];
  const workspaceResolved = path.resolve(workspace);

  if (opts.subPath) {
    const abs = path.resolve(workspace, opts.subPath);
    if (!isWithin(abs, workspaceResolved)) return out;
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
        if (om) om[layer] += 1;
        return out;
      }
      if (isSourceOnlyExcludedPath(relPath, opts.subPath, fullRecall)) return out;
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
      const layer = classifyIgnored(layers, relPath, true);
      if (layer) {
        if (om) om[layer] += 1;
        continue;
      }
      if (isSourceOnlyExcludedPath(relPath + "/", explicitSubPath, fullRecall)) continue;
      walkDir(workspace, absPath, allowedExts, extraExts, extraBasenames, includeArtifacts, includeGenericText, layers, out, om, sizeCapBytes, explicitSubPath, fullRecall);
    } else if (entry.isFile()) {
      const layer = classifyIgnored(layers, relPath, false);
      if (layer) {
        if (om) om[layer] += 1;
        continue;
      }
      if (isSourceOnlyExcludedPath(relPath, explicitSubPath, fullRecall)) continue;
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
