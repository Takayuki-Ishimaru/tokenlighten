/**
 * closureTracking.ts — DESIGN-v0.8 edit_file closure tracking.
 *
 * Bench 2026-07-03a exposed false_solved cases: an agent declares the task
 * "solved" while a required cross-surface edit is still missing (two live cells:
 * a CSS design token that a task_pack check demanded was never added, so the
 * verifier fails). read_code mode=task_pack now stores structured,
 * machine-verifiable checks in the workspace session (`PackCheckRecord`). After
 * a successful edit_file write, `attachClosure` cheaply re-verifies those checks
 * against the files edited so far and attaches a compact reminder of the checks
 * that are still open — so the solver self-corrects in the SAME turn, before it
 * declares done.
 *
 * Invariants that keep this cheap and non-disruptive:
 *  - Fires ONLY when the session holds token-bearing pack checks. Non-pack
 *    workflows (the overwhelming majority, and every existing edit-response-size
 *    test) see zero added bytes.
 *  - Scans only the small, bounded set of files this session has already edited
 *    (≤16 files, ≤256KB total, individual files >128KB skipped) — never the whole
 *    repo. Reads stay inside the workspace via the same safe-path discipline used
 *    elsewhere (safeResolve + realpath containment).
 *  - Any internal error returns the edit result unchanged. Closure tracking must
 *    never break an edit_file response.
 *
 * Synchronous fs is used deliberately (matches locateTaskContext / createFile
 * style) so the whole pass stays a single synchronous step; an injectable
 * `readFile` keeps the logic unit-testable without touching disk.
 */

import * as fs from "fs";
import * as path from "path";
import { spawnSync } from "child_process";
import {
  getPackChecks,
  recordClosureReport,
  recordClosureOpenStreak,
  CLOSURE_ESCALATION_THRESHOLD,
  recordEditedPath,
  getEditedPaths,
  isVerifiableCheck,
  markClosureSatisfied,
  clearClosureSatisfied,
  type PackCheckRecord,
} from "../state/session.js";
import { languageForPath } from "./languages.js";

// Bounds on the scan set. These cap the cost of the per-edit re-verification:
// a handful of edited files is normal, and a design-token check only needs to
// see the file that was supposed to carry the token, so a wider scan buys
// nothing but latency.
const MAX_SCAN_FILES = 16;
const MAX_TOTAL_BYTES = 256 * 1024;
const MAX_FILE_BYTES = 128 * 1024;

// Response-shape bounds (keep the attached object tiny).
const MAX_OPEN_DESCS = 3;
const MAX_DESC_CHARS = 140;

// Text-file extensions the git-detected scan is willing to read. Closure
// checks only ever look for source-identifier / design-token strings, so
// binary and archive files never contribute a match; restricting to a text
// allow-list keeps the git-expansion cheap and avoids reading blobs.
const SCAN_TEXT_EXTS: ReadonlySet<string> = new Set([
  ".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".pyi", ".go", ".rs", ".java", ".kt", ".kts", ".cs",
  ".c", ".h", ".cc", ".cpp", ".cxx", ".hpp", ".hh", ".hxx",
  ".php", ".rb", ".css", ".scss", ".sass", ".less", ".html", ".htm",
  ".json", ".jsonc", ".yaml", ".yml", ".toml", ".xml", ".md", ".txt",
  ".vue", ".svelte", ".sql", ".sh", ".proto", ".gradle",
]);

function isScannableTextPath(rel: string): boolean {
  return SCAN_TEXT_EXTS.has(path.extname(rel).toLowerCase());
}

/**
 * Extracts the workspace-relative paths a successful edit_file result reports
 * writing. Covers the three success shapes:
 *  - batch (applyEditsMulti): `{ ok:true, files:[{path,...}], checkpoint }` —
 *    only entries whose own `ok` is not explicitly false (EditFileResult has no
 *    `ok` field on the happy path, so `ok !== false` keeps them all);
 *  - readAndEdit-nested: `{ ok:true, context, edit:{ path, ... } }`;
 *  - single (range/pathless/create/exact): `{ ok?, path, lines, delta }`.
 */
function extractWrittenPaths(result: Record<string, unknown>): string[] {
  const files = (result as { files?: Array<{ path?: unknown; ok?: unknown }> }).files;
  if (Array.isArray(files)) {
    const out: string[] = [];
    for (const f of files) {
      if (f && f.ok !== false && typeof f.path === "string" && f.path !== "") {
        out.push(f.path);
      }
    }
    return out;
  }

  const nested = (result as { edit?: { path?: unknown } }).edit;
  if (nested && typeof nested.path === "string" && nested.path !== "") {
    return [nested.path];
  }

  const single = (result as { path?: unknown }).path;
  if (typeof single === "string" && single !== "") {
    return [single];
  }

  return [];
}

/**
 * Glob semantics for a token-bearing check (per the seam contract):
 *  - `*.ext` → the workspace-relative path ends with `.ext`;
 *  - any other non-empty glob → plain substring match on the workspace-relative
 *    path (a path fragment like `src/styles/`);
 *  - absent glob → matches every scanned file.
 * Paths are normalized to forward slashes so a `*.css` / `styles/` glob matches
 * on Windows-style separators too.
 */
function globMatches(relPath: string, glob: string | undefined): boolean {
  if (glob === undefined || glob === "") return true;
  const normalized = relPath.replace(/\\/g, "/");
  if (glob.startsWith("*.")) {
    return normalized.endsWith(glob.slice(1)); // ".ext"
  }
  return normalized.includes(glob.replace(/\\/g, "/"));
}

/**
 * Reads an edited file's content for scanning, enforcing the per-file byte cap
 * and workspace containment. Returns undefined when the path escapes the
 * workspace, is missing/oversized, or is unreadable — such a file simply does
 * not contribute a match. The injectable `readFile` (tests) bypasses fs and the
 * size stat; it is trusted to return in-workspace content only.
 */
function readEditedFile(
  workspaceRoot: string,
  relPath: string,
  readFile: ((abs: string) => string | undefined) | undefined,
): string | undefined {
  if (readFile) {
    // Test seam: caller supplies content directly, keyed by relative path.
    return readFile(relPath);
  }

  // Guard against traversal: resolve within the root, then confirm the realpath
  // still lives inside the (realpath'd) root before reading.
  const abs = path.resolve(workspaceRoot, relPath);
  const rootReal = safeRealDir(workspaceRoot);
  if (rootReal === undefined) return undefined;
  if (!isWithin(path.resolve(abs), path.resolve(workspaceRoot))) return undefined;

  let real: string;
  try {
    real = fs.realpathSync(abs);
  } catch {
    return undefined;
  }
  if (!isWithin(real, rootReal)) return undefined;

  try {
    const size = fs.statSync(real).size;
    if (size > MAX_FILE_BYTES) return undefined;
    return fs.readFileSync(real, "utf8");
  } catch {
    return undefined;
  }
}

function safeRealDir(p: string): string | undefined {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

function isWithin(child: string, base: string): boolean {
  return child === base || child.startsWith(base + path.sep);
}

/**
 * The workspace's path relative to the git toplevel: `""` when they are the
 * same directory, the toplevel-relative prefix (e.g. `packages/pkgA`) when the
 * workspace is a subdirectory, `undefined` when the workspace does not live
 * under the toplevel at all. Both sides are realpath'd (git prints a
 * symlink-resolved toplevel; macOS /tmp is a symlink) and the prefix uses
 * forward slashes to match porcelain output.
 */
function workspacePrefixWithin(toplevel: string, workspace: string): string | undefined {
  const topReal = safeRealDir(toplevel);
  const wsReal = safeRealDir(workspace);
  if (topReal === undefined || wsReal === undefined) return undefined;
  if (topReal === wsReal) return "";
  if (!isWithin(wsReal, topReal)) return undefined;
  return path.relative(topReal, wsReal).replace(/\\/g, "/");
}

/**
 * Git-detected workspace modifications, so closure sees files an agent edited
 * with NATIVE tools (not only through edit_file). Runs at most one git
 * invocation per call — `git status --porcelain` reports BOTH tracked
 * modifications AND untracked (new, non-ignored) files in a single command, so
 * one spawn covers what would otherwise be `git diff --name-only HEAD` +
 * `git ls-files --others --exclude-standard`. Requirements met here:
 *  - Not a git repo / git unavailable / any spawn failure → returns [] (the
 *    caller then scans the TL-edited set only — zero behavior change).
 *  - Porcelain paths are printed relative to the git TOPLEVEL; when the
 *    workspace is a subdirectory of the repo (monorepo package layout) they
 *    are re-rooted to workspace-relative before use. Only scannable text
 *    files are kept and deletions are dropped (a deleted file cannot carry a
 *    token).
 *  - Bounded: the count/size caps are enforced by the caller when it merges
 *    this list with the TL-edited set, so no cap is duplicated here.
 *
 * Mirrors the repo's synchronous child-process idiom (write/shadowGit.ts):
 * spawnSync("git", [...], { encoding:"utf8", shell:false, timeout, maxBuffer }).
 * Unlike shadowGit's shadow-repo calls, this does NOT neutralize global/system
 * git config (GIT_CONFIG_GLOBAL/SYSTEM stay untouched) — excludes/ignore
 * behavior must stay user-faithful for closure counting against the
 * WORKSPACE's own repo, not the sandboxed shadow checkpoint repo. It DOES
 * bound execution time/output and block the one command-execution vector a
 * read-only `rev-parse`/`status` can trigger on its own: core.fsmonitor may
 * be configured to an arbitrary shell command (CWE-78) that git invokes as
 * part of status-adjacent plumbing — confirmed empirically against git 2.50
 * in __tests__/shadowGitHardening.spec.ts, including a negative control that
 * reproduces the unmitigated execution.
 */

/** Matches the timeout idiom used elsewhere in this repo (write/shadowGit.ts,
 *  readCodeTaskPack.ts, skeleton-engine/indexStore.ts). */
const WORKSPACE_GIT_TIMEOUT_MS = 5000;

/** Explicit rather than relying on Node's 1 MB spawnSync default — these
 *  calls only ever emit a path or a bounded set of short porcelain lines. */
const WORKSPACE_GIT_MAX_BUFFER = 10 * 1024 * 1024;

/**
 * Env for the two workspace-repo spawns below: the inherited process env
 * with GIT_* variables stripped (a hostile parent process/shell could
 * otherwise inject e.g. GIT_CONFIG_GLOBAL to redirect config reads), then a
 * fixed minimal set restored. GIT_CONFIG_GLOBAL/SYSTEM are deliberately left
 * unset here — see this function's doc comment.
 */
function workspaceGitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("GIT_")) delete env[key];
  }
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_OPTIONAL_LOCKS = "0";
  return env;
}

/** Shared runner for the workspace-repo (read-only) git spawns: bounds
 *  (timeout/maxBuffer), the fsmonitor-command neutralization, and the env
 *  above, applied uniformly to both calls in gitModifiedPaths. */
function runWorkspaceGit(args: string[]): ReturnType<typeof spawnSync> {
  return spawnSync("git", ["-c", "core.fsmonitor=false", ...args], {
    encoding: "utf8",
    shell: false,
    timeout: WORKSPACE_GIT_TIMEOUT_MS,
    maxBuffer: WORKSPACE_GIT_MAX_BUFFER,
    env: workspaceGitEnv(),
  });
}

function gitModifiedPaths(workspace: string): string[] {
  let top: ReturnType<typeof spawnSync>;
  try {
    top = runWorkspaceGit(["-C", workspace, "rev-parse", "--show-toplevel"]);
  } catch {
    return []; // spawn failed (git missing) → TL-set only.
  }
  // A timeout/maxBuffer kill does NOT throw (verified empirically — spawnSync
  // reports it via `.error`/`.status===null`, same shape as any other
  // nonzero-exit failure), so this existing status check already degrades
  // gracefully to the "unknown" TL-edited-only fallback; the try/catch above
  // remains belt-and-suspenders for a genuine spawn-level throw.
  if (top.status !== 0 || typeof top.stdout !== "string") return [];
  const toplevel = top.stdout.trim();
  if (toplevel === "") return [];

  // Porcelain paths are relative to the REPO ROOT, which need not be the
  // workspace: in the common monorepo layout the TL workspace is a package
  // directory (<toplevel>/packages/pkgA) with .git at the repo root. Re-root
  // such paths instead of bailing — keep only entries under the workspace's
  // toplevel-relative prefix and strip it. Bail only when the workspace is
  // not under the toplevel at all (defensive; `git -C <workspace> rev-parse`
  // normally reports an ancestor), so the caller scans the TL-edited set only.
  const prefix = workspacePrefixWithin(toplevel, workspace);
  if (prefix === undefined) return [];

  let res: ReturnType<typeof spawnSync>;
  try {
    // Pathspec "." bounds the walk to the workspace subtree (paths are still
    // PRINTED toplevel-relative): a workspace nested in a large repo must not
    // pay a repo-wide status, e.g. a temp dir under a repo-backed $HOME.
    res = runWorkspaceGit(["-C", workspace, "status", "--porcelain", "--untracked-files=all", "--", "."]);
  } catch {
    return [];
  }
  if (res.status !== 0 || typeof res.stdout !== "string") return [];

  const out: string[] = [];
  for (const rawLine of res.stdout.split("\n")) {
    if (rawLine === "") continue;
    // Porcelain v1: "XY <path>" (2 status chars, a space, then the path).
    // Deletions (status contains 'D') carry no token and are dropped. Renames
    // ("R  old -> new") keep the post-arrow destination.
    const status = rawLine.slice(0, 2);
    if (status.includes("D")) continue;
    let rel = rawLine.slice(3).trim();
    const arrow = rel.indexOf(" -> ");
    if (arrow !== -1) rel = rel.slice(arrow + 4);
    // Porcelain quotes paths with special chars ("...") — skip those rather
    // than mis-parse; a token-bearing edit almost never lands in such a path.
    if (rel.startsWith('"')) continue;
    if (rel === "") continue;
    if (prefix !== "") {
      // Re-root: toplevel-relative → workspace-relative. Drop anything outside
      // the workspace (e.g. a rename whose destination left the subtree).
      if (!rel.startsWith(prefix + "/")) continue;
      rel = rel.slice(prefix.length + 1);
    }
    if (!isScannableTextPath(rel)) continue;
    out.push(rel);
  }
  return out;
}

/**
 * The bounded set of files the closure scan reads: the TL-edited paths FIRST
 * (they take priority in the cap ordering), then git-detected native
 * modifications not already covered, de-duplicated and capped at
 * MAX_SCAN_FILES. `git` is memoized to one invocation regardless of how many
 * checks are evaluated.
 *
 * `includeGit=false` skips the git scan entirely — used when a test injects a
 * `readFile` seam (its content model is keyed by relative path and would be
 * incoherent with real on-disk git state), and it also keeps the pure-unit
 * path hermetic.
 */
function closureScanPaths(workspace: string, includeGit: boolean): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  const add = (rel: string): void => {
    const norm = rel.replace(/\\/g, "/");
    if (seen.has(norm)) return;
    seen.add(norm);
    ordered.push(rel);
  };
  // TL-edited paths take priority in the cap ordering.
  for (const rel of getEditedPaths(workspace)) add(rel);
  // Native (git-detected) modifications fill the remaining budget.
  if (includeGit) {
    for (const rel of gitModifiedPaths(workspace)) {
      if (ordered.length >= MAX_SCAN_FILES) break;
      add(rel);
    }
  }
  return ordered.slice(0, MAX_SCAN_FILES);
}

/**
 * Case-insensitive, underscore-insensitive normalization used for
 * co-occurrence matching (mirrors the bench verifier's cheap normalization):
 * lowercase and strip `_`, so `Gyro::isHealthy`/`is_healthy`/`ISHEALTHY` all
 * compare equal. Kept deliberately cheap — no camelCase splitting.
 */
function normalizeForCooccur(s: string): string {
  return s.toLowerCase().replace(/_/g, "");
}

/**
 * Structural view of a wiring check's `sourceDir` field. `sourceDir` is
 * registered by readCodeTaskPack.ts's buildWiringCooccurrenceCheck
 * (workspace-relative dirname of the wiring SOURCE endpoint's resolved path)
 * but is not declared on PackCheckRecord itself (session.ts is owned by a
 * concurrent change this wave) — it survives session.ts's pass-through
 * storage (recordPackChecks/getPackChecks/_mergeCheckRecords never
 * reconstruct a record field-by-field) as an ordinary extra object property.
 * Read via this structural cast rather than widening the shared type.
 */
type WiringSourceDirCarrier = { sourceDir?: string };

/**
 * C-family module-layout directory segments dropped when computing a
 * `moduleKey` (below) — a module's public surface conventionally lives under
 * `include/<mod>/` while its implementation lives under `src/<mod>/`; both
 * trees describe the SAME module, just split by directory convention.
 */
const MODULE_KEY_DROP_SEGMENTS: ReadonlySet<string> = new Set(["include", "src"]);

/**
 * Reduce a POSIX-normalized path to a "module key": drop every path segment
 * exactly equal to "include" or "src" (all occurrences, not just a leading
 * one) and rejoin what remains, in order. `"include/dsp"` and
 * `"src/dsp/wave_shaper.cpp"` both reduce to a
 * `"dsp"`-prefixed key, so a prefix match on the reduced form treats
 * them as the same module even though their raw paths share no prefix.
 * Paths with no "include"/"src" segment anywhere pass through unchanged, so
 * non-C layouts see no behavior change from this normalization.
 */
function moduleKey(normPath: string): string {
  return normPath.split("/").filter((seg) => seg !== "" && !MODULE_KEY_DROP_SEGMENTS.has(seg)).join("/");
}

/**
 * True when `relPath` (an edited file) lies AT or UNDER the wiring source's
 * module directory `sourceDir` (workspace-relative, POSIX). Shares
 * readCodeTaskPack.ts's `isUnderAncestor` shape (that helper is private to
 * its module, so this is a local equivalent, not an import) plus a
 * `dir === "."` case for a source file that lives at the workspace root,
 * where a bare top-level relPath (no "/") must count as "inside".
 *
 * An empty `sourceDir` (no directory recorded — only possible on a
 * hand-seeded record predating this field; a freshly-registered wiring check
 * always carries one) is treated as "everything is inside", so the check can
 * never be satisfied by content alone. This is a deliberate fail-CLOSED
 * default: with no directory to exclude, "consumed outside the module"
 * cannot be proven, and staying open is the safe failure mode — a false-open
 * on malformed/legacy data is far cheaper than re-admitting the false-satisfy
 * this redesign exists to close.
 *
 * MODULE NORMALIZATION (2026-07-12c): a C-family module is often split
 * across an `include/<mod>/` (public headers) and `src/<mod>/`
 * (implementation) tree. A plain prefix match treats those as two unrelated
 * directories, so an edit landing in `src/<mod>/` — pure INTRA-module
 * plumbing — reads as "outside" a `sourceDir` of `include/<mod>/` and could
 * false-satisfy the check on module-internal wiring alone, never actually
 * reaching a consumer. `moduleKey` re-derives both sides with "include"/
 * "src" segments dropped and retries the SAME prefix match against that
 * reduced form; a file counts as under-source when EITHER the raw-path
 * match OR the module-key match holds. OR only ever WIDENS what counts as
 * under-source (a raw-path "true" is never overturned), preserving the
 * conservative direction: when in doubt, exclude from satisfying. Layouts
 * with no "include"/"src" segment anywhere reduce to their original form,
 * so non-C-family paths see no behavior change.
 */
function isUnderSourceDir(relPath: string, sourceDir: string): boolean {
  const norm = relPath.replace(/\\/g, "/");
  if (sourceDir === "") return true;
  if (sourceDir === ".") return !norm.includes("/");
  if (norm === sourceDir || norm.startsWith(sourceDir + "/")) return true;
  const srcKey = moduleKey(sourceDir);
  if (srcKey === "") return false;
  const relKey = moduleKey(norm);
  return relKey === srcKey || relKey.startsWith(srcKey + "/");
}

// ---------------------------------------------------------------------------
// Wiring-satisfaction comment stripping (2026-07-12b satisfaction redesign).
//
// formatCompress's elideDocComments is NOT reused here even though it already
// strips comments: BY DESIGN (see its own doc comment) it leaves every
// single-line `//`/`#` comment untouched — "cheap and often load-bearing" for
// served content — and a single-line/inline `/* ... */` is also kept
// verbatim; only MULTI-LINE doc-comment blocks get elided. That is exactly
// the false-satisfy vector this redesign closes (2026-07-12b wiring
// forensics: a single-line comment mentioning the source domain landed near
// the dest token and satisfied the old proximity rule). Wiring satisfaction needs EVERY comment
// gone, so this is a separate, minimal stripper, dispatched per language by
// stripCommentsForWiringScan below onto one of four scanners (2026-07-12c/d
// widened from the original c/cpp/ts/js/java/python fixture-family scope to
// every WIRING_C_STYLE_LANGS entry plus ruby; 2026-07-12e then closed the
// three residuals that widening left open — see WIRING_C_STYLE_LANGS's doc
// comment for the exact per-language routing and what genuinely narrow
// approximation remains):
//  - stripCStyleComments: flat (non-nesting) `//` + `/* */`, for the
//    WIRING_C_STYLE_LANGS entries whose real grammar does not nest block
//    comments.
//  - stripCStyleCommentsNested: identical `//` handling, but a
//    DEPTH-COUNTED `/* */` for rust/kotlin specifically, whose grammars
//    allow genuine nesting the flat scanner would stop tracking at the
//    first `*/`.
//  - stripPhpComments: a dedicated scanner for php's three comment openers
//    (`//`, `/* */`, `#`) in one shared-state scan — php is not a
//    WIRING_C_STYLE_LANGS entry for exactly this reason (see that
//    function's doc comment for the one-scan-vs-two-pass argument and the
//    `#[` attribute exception).
//  - stripPythonComments: `#` line comments with triple-quoted string
//    passthrough, so a `#` inside a docstring/string literal is not
//    mistaken for a comment opener — docstrings are STRINGS, not comments,
//    in Python. Reused verbatim for ruby, whose `#` line comments and
//    quote-in/quote-out string tracking need nothing python-specific to
//    stay correct — including a ruby `"...#{...}..."` interpolation,
//    handled by construction since the tracker never special-cases `#`.
//    Ruby ADDITIONALLY runs stripRubyBlockComments FIRST, to blank
//    `=begin`/`=end` block comments that `#`-only tracking cannot see (see
//    that function's doc comment for the two-pass composition's safety
//    argument).
//
// Any other or unrecognized language is returned UNCHANGED: no regression
// from the pre-redesign behavior for languages outside this stated scope,
// though a comment-only mention in such a file could in principle still
// satisfy — a known, documented gap, not a new one.
//
// String/char/template-literal state is tracked (with backslash-escape
// awareness) so a `//` or `/*` INSIDE a string — e.g. a `"http://…"` URL
// literal — is never mistaken for a comment opener. Comment bodies are
// replaced with spaces (newlines preserved) rather than deleted outright, so
// stripping never splices two adjacent tokens into a new one
// (`foo/*x*/bar` -> "foo    bar", not "foobar"). Pure functions: no I/O, and
// never throw — an unterminated comment/string just runs to EOF.
// ---------------------------------------------------------------------------

/**
 * C-style languages (`//` line + `/* *\/` block comments, NON-NESTING) this
 * stripper understands — routed through the flat stripCStyleComments by
 * stripCommentsForWiringScan below. Every entry here uses `//`/`/* *\/` as
 * its PRIMARY comment syntax, and none of them nest block comments in real
 * grammar. Three otherwise-C-style languages are deliberately NOT in this
 * set, each routed to a dedicated scanner instead (see
 * stripCommentsForWiringScan):
 *  - `rust` and `kotlin` DO nest `/* *\/` block comments in real grammar, so
 *    they route through stripCStyleCommentsNested instead of the flat
 *    scanner here.
 *  - `php` additionally allows a `#` line-comment opener alongside
 *    `//`/`/* *\/`, so it routes through the dedicated stripPhpComments
 *    instead.
 * `ruby` was never in this set either — it is `#`-commented like python, so
 * it routes through stripPythonComments (plus a `=begin`/`=end` pre-pass).
 *
 * Language-id strings match languageForPath's EXT_TO_LANGUAGE table exactly
 * (languages.ts) — in particular `"csharp"`, not `"c_sharp"`.
 *
 * DOCUMENTED RESIDUALS — accepted, genuinely narrow/exotic gaps, not bugs
 * this module owes a fix for (2026-07-12e closed the three less-exotic gaps
 * this list used to carry — php's `#` opener, ruby's `=begin`/`=end`, and
 * rust/kotlin nesting — see stripPhpComments, stripRubyBlockComments, and
 * stripCStyleCommentsNested). Both remaining items are possible
 * false-SATISFY-shaped risks (comment-syntax-shaped text inside what is
 * actually a STRING form this scanner does not recognize gets misread as a
 * comment and over-blanked) but resolve in the SAFE direction: over-
 * blanking can only cost a real consumption reference its match — leaving a
 * check open a field-level read would have closed — never manufacture a
 * false one. That is the same "when in doubt, stay open" default this
 * module applies everywhere else:
 *  - php's heredoc (`<<<EOT ... EOT`) and nowdoc (`<<<'EOT' ... EOT`) bodies
 *    are STRINGS (like a python triple-quoted docstring), not comments —
 *    but stripPhpComments does not recognize the `<<<` opener as a string
 *    form, so a body line that starts a `//`- or `/* *\/`-shaped run, or
 *    that contains a bare `#`, can be misread as a comment opener inside
 *    the body. Uncommon in general application code relative to plain
 *    quoted strings.
 *  - ruby's `%`-literal forms (`%q{}`, `%w[]`, `%r{}`, etc.) are strings/
 *    arrays/regexes with ARBITRARY delimiters that stripPythonComments does
 *    not recognize as string-like; a `#` inside one reads as a real line
 *    comment starting right there. Uncommon relative to `'...'`/`"..."` in
 *    idiomatic ruby.
 */
const WIRING_C_STYLE_LANGS: ReadonlySet<string> = new Set([
  "c", "cpp", "typescript", "typescriptreact", "javascript", "javascriptreact", "java",
  "go", "csharp",
]);

function stripCStyleComments(text: string): string {
  const n = text.length;
  const out: string[] = [];
  let i = 0;
  while (i < n) {
    const ch = text[i]!;

    // Line comment: // … to end of line.
    if (ch === "/" && text[i + 1] === "/") {
      while (i < n && text[i] !== "\n") { out.push(" "); i++; }
      continue;
    }

    // Block comment: /* … */ (may span lines; newlines preserved so line
    // structure is unaffected even though nothing here needs it).
    if (ch === "/" && text[i + 1] === "*") {
      out.push(" ", " ");
      i += 2;
      while (i < n && !(text[i] === "*" && text[i + 1] === "/")) {
        out.push(text[i] === "\n" ? "\n" : " ");
        i++;
      }
      if (i < n) { out.push(" ", " "); i += 2; } // consume closing */
      continue;
    }

    // String / char / template literal: copy verbatim — a comment marker
    // inside one is not a comment. Escapes copy their following char too so
    // an escaped quote never mis-terminates the literal early.
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      out.push(ch);
      i++;
      while (i < n) {
        const c = text[i]!;
        out.push(c);
        i++;
        if (c === "\\") {
          if (i < n) { out.push(text[i]!); i++; }
          continue;
        }
        if (c === quote) break;
        if (c === "\n" && quote !== "`") break; // unterminated '/" string — best-effort stop
      }
      continue;
    }

    out.push(ch);
    i++;
  }
  return out.join("");
}

/**
 * Like stripCStyleComments, but with a DEPTH-COUNTED `/* *\/` block comment —
 * rust and kotlin both nest block comments in real grammar (`/* /* *\/ *\/`
 * is a single comment spanning to the OUTER `*\/`), unlike every other
 * WIRING_C_STYLE_LANGS entry, which does not. `//` line comments and
 * string/char/template-literal tracking (backslash-escape awareness,
 * unterminated-at-newline/EOF handling) are IDENTICAL to stripCStyleComments
 * — copied rather than shared, so that function stays completely untouched
 * and its behavior for c/cpp/ts/js/java/go/csharp cannot regress from this
 * addition. Only the `/* *\/` branch differs: a nested `/*` opener
 * increments a depth counter instead of being read as ordinary comment-body
 * text, and only the `*\/` that brings the counter back to zero closes the
 * comment. An unterminated block comment (depth never returns to zero) runs
 * to EOF, the same best-effort behavior used everywhere else in this file.
 */
function stripCStyleCommentsNested(text: string): string {
  const n = text.length;
  const out: string[] = [];
  let i = 0;
  while (i < n) {
    const ch = text[i]!;

    // Line comment: // … to end of line.
    if (ch === "/" && text[i + 1] === "/") {
      while (i < n && text[i] !== "\n") { out.push(" "); i++; }
      continue;
    }

    // Block comment: /* … */ — NESTS: a /* found inside the comment body
    // bumps depth instead of being ordinary comment text; only the */ that
    // brings depth back to 0 closes the (outermost) comment.
    if (ch === "/" && text[i + 1] === "*") {
      let depth = 1;
      out.push(" ", " ");
      i += 2;
      while (i < n && depth > 0) {
        if (text[i] === "/" && text[i + 1] === "*") {
          out.push(" ", " ");
          i += 2;
          depth++;
          continue;
        }
        if (text[i] === "*" && text[i + 1] === "/") {
          out.push(" ", " ");
          i += 2;
          depth--;
          continue;
        }
        out.push(text[i] === "\n" ? "\n" : " ");
        i++;
      }
      continue;
    }

    // String / char / template literal: copy verbatim — a comment marker
    // inside one is not a comment. Escapes copy their following char too so
    // an escaped quote never mis-terminates the literal early.
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      out.push(ch);
      i++;
      while (i < n) {
        const c = text[i]!;
        out.push(c);
        i++;
        if (c === "\\") {
          if (i < n) { out.push(text[i]!); i++; }
          continue;
        }
        if (c === quote) break;
        if (c === "\n" && quote !== "`") break; // unterminated '/" string — best-effort stop
      }
      continue;
    }

    out.push(ch);
    i++;
  }
  return out.join("");
}

/**
 * PHP comment stripper: handles all THREE of php's comment openers — `//`,
 * `/* *\/`, and `#` — in ONE linear scan sharing a single string-tracking
 * state, rather than composing two independent passes (a C-style pass then
 * a `#`-only pass).
 *
 * Composing two passes IS safe in the direction of "can pass 2 misread pass
 * 1's OUTPUT": pass 1 (stripCStyleComments) only ever replaces a recognized
 * `//`/`/* *\/` span with spaces, and a space is never a quote character, so
 * a blanked region is inert to a second pass's string tracker. But the
 * REVERSE direction is not safe in general: pass 1 does not know about `#`,
 * so a stray single/double quote inside a real `#` comment's English prose
 * (an apostrophe, e.g. "don't") makes pass 1 open a spurious "string"
 * there. For a stray, unmatched backtick specifically (plausible in a
 * comment that quotes a snippet of inline code), that misidentified
 * "string" does not break at end-of-line the way a single/double quote does
 * (php backtick strings can span lines), so it can run past the end of that
 * comment's line and swallow a LATER, genuinely real `//`/`/* *\/` comment on
 * a subsequent line — which pass 2 (a `#`-only pass) has no way to strip
 * either, leaking it through verbatim. A single shared scan has no
 * cross-pass handoff to reason about at all — string state is tracked once,
 * correctly, for the characters as they actually are — so this failure mode
 * cannot arise. That is why php gets a bespoke function instead of the
 * two-pass composition ruby uses successfully for stripRubyBlockComments +
 * stripPythonComments (see that function's doc comment for why the two
 * situations differ: ruby's first pass blanks EVERY character of the block
 * it recognizes, leaving nothing for the second pass to misread; a
 * hypothetical two-pass php composition's first pass would only blank
 * COMMENT DELIMITERS, leaving ordinary `#`-comment prose — including any
 * stray quote characters in it — untouched for the second pass to walk
 * over).
 *
 * `#[` is NOT treated as a comment opener: PHP 8 attributes
 * (`#[Attribute]`) begin with exactly that two-character sequence, and an
 * attribute is CODE, not a comment — a source-token reference inside one
 * (e.g. `#[Route(TOKEN)]`) is a genuine consumption. The check is a
 * one-character lookahead (`text[i+1] !== "["`), not a full "statement
 * position" parse (PHP itself restricts attributes to statement position;
 * this scanner does not track position at that granularity) — but the
 * lookahead cannot misfire on a true comment: `#[` is not comment TEXT a
 * real `#` comment could mean literally, since PHP's own lexer always reads
 * `#[` as an attribute opener, never as the start of a `#`-comment whose
 * first character happens to be `[`. The lookahead can only ever
 * (correctly) let a genuine attribute through as code.
 *
 * `//` and `/* *\/` here are non-nesting, matching php's real grammar (no
 * stripCStyleCommentsNested-style depth counter needed for php). String,
 * char, and shell-exec-literal tracking (double quote, single quote,
 * backtick — with backslash-escape awareness) mirrors stripCStyleComments's
 * — copied rather than shared, same rationale as
 * stripCStyleCommentsNested's doc comment.
 */
function stripPhpComments(text: string): string {
  const n = text.length;
  const out: string[] = [];
  let i = 0;
  while (i < n) {
    const ch = text[i]!;

    // Line comment: // … to end of line.
    if (ch === "/" && text[i + 1] === "/") {
      while (i < n && text[i] !== "\n") { out.push(" "); i++; }
      continue;
    }

    // Block comment: /* … */ (non-nesting — matches php's real grammar).
    if (ch === "/" && text[i + 1] === "*") {
      out.push(" ", " ");
      i += 2;
      while (i < n && !(text[i] === "*" && text[i + 1] === "/")) {
        out.push(text[i] === "\n" ? "\n" : " ");
        i++;
      }
      if (i < n) { out.push(" ", " "); i += 2; } // consume closing */
      continue;
    }

    // Line comment: # … to end of line — php's alternate line-comment
    // opener, alongside //. EXCEPT `#[`, which opens a PHP 8 attribute
    // (code, not a comment) — see the doc comment above for why the
    // one-char lookahead is safe.
    if (ch === "#" && text[i + 1] !== "[") {
      while (i < n && text[i] !== "\n") { out.push(" "); i++; }
      continue;
    }

    // String / char / shell-exec literal: copy verbatim — a comment marker
    // inside one is not a comment. Escapes copy their following char too so
    // an escaped quote never mis-terminates the literal early.
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      out.push(ch);
      i++;
      while (i < n) {
        const c = text[i]!;
        out.push(c);
        i++;
        if (c === "\\") {
          if (i < n) { out.push(text[i]!); i++; }
          continue;
        }
        if (c === quote) break;
        if (c === "\n" && quote !== "`") break; // unterminated '/" string — best-effort stop
      }
      continue;
    }

    out.push(ch);
    i++;
  }
  return out.join("");
}

function stripPythonComments(text: string): string {
  const n = text.length;
  const out: string[] = [];
  let i = 0;
  while (i < n) {
    const ch = text[i]!;

    // Line comment: # … to end of line.
    if (ch === "#") {
      while (i < n && text[i] !== "\n") { out.push(" "); i++; }
      continue;
    }

    // String literal, including triple-quoted (docstrings are STRINGS, not
    // comments, in Python — passed through verbatim, never stripped).
    if (ch === '"' || ch === "'") {
      const quote = ch;
      const triple = text[i + 1] === quote && text[i + 2] === quote;
      const marker = triple ? quote.repeat(3) : quote;
      out.push(marker);
      i += marker.length;
      while (i < n) {
        if (text.startsWith(marker, i)) { out.push(marker); i += marker.length; break; }
        const c = text[i]!;
        if (!triple && c === "\\") {
          out.push(c);
          i++;
          if (i < n) { out.push(text[i]!); i++; }
          continue;
        }
        if (!triple && c === "\n") break; // unterminated single-line string — best-effort stop
        out.push(c);
        i++;
      }
      continue;
    }

    out.push(ch);
    i++;
  }
  return out.join("");
}

/**
 * Blank ruby's `=begin`/`=end` block-comment form. Both keywords are
 * recognized ONLY when they are the very first characters of a line (column
 * 0, no leading whitespace) — ruby's grammar requires exactly that
 * placement for both; a `=begin`/`=end`-shaped token anywhere else on a
 * line (mid-expression — most plausibly a chained comparison) is ordinary
 * code and is left untouched.
 *
 * Runs BEFORE stripPythonComments over the same text for ruby (see
 * stripCommentsForWiringScan) — and that two-pass composition IS provably
 * safe, unlike the hypothetical two-pass alternative rejected for php (see
 * stripPhpComments's doc comment for the contrast): every character inside
 * a recognized `=begin`...`=end` block, including any quote or `#`
 * character it happens to contain, is replaced with a space (newlines kept,
 * matching this file's general replace-with-space convention). Nothing
 * quote-like or `#`-like survives from the block into the second pass for
 * it to misread — pass 2 only ever sees, in place of a =begin/=end block, a
 * run of spaces and newlines, which cannot open or close a string and is
 * not `#`-shaped either. (Contrast php: a hypothetical first pass there
 * would blank only the COMMENT DELIMITERS' spans, leaving ordinary
 * `#`-comment prose — and any stray quote characters inside it — untouched
 * for a second pass to walk over; here pass 1 blanks the ENTIRE block
 * unconditionally, character for character, which is what makes the
 * argument airtight.)
 *
 * An unterminated block (a `=begin` with no matching `=end`) blanks to EOF,
 * the same best-effort behavior used everywhere else in this file.
 */
function stripRubyBlockComments(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let inBlock = false;
  for (const line of lines) {
    if (inBlock) {
      out.push(" ".repeat(line.length));
      if (line.startsWith("=end")) inBlock = false;
      continue;
    }
    if (line.startsWith("=begin")) {
      inBlock = true;
      out.push(" ".repeat(line.length));
      continue;
    }
    out.push(line);
  }
  return out.join("\n");
}

/**
 * Strip comments for the wiring-satisfaction scan, dispatching on `relPath`'s
 * language (see the design note above). `ruby` runs stripRubyBlockComments
 * FIRST (blanking `=begin`/`=end` blocks) and then stripPythonComments over
 * the result — see stripRubyBlockComments's doc comment for why that
 * composition is safe. `php` and rust/kotlin each get a dedicated scanner
 * (stripPhpComments; stripCStyleCommentsNested) rather than the flat
 * WIRING_C_STYLE_LANGS fallback — see their doc comments and
 * WIRING_C_STYLE_LANGS's own for why they are excluded from that set.
 * Unrecognized/unhandled languages return `text` unchanged.
 */
function stripCommentsForWiringScan(text: string, relPath: string): string {
  const lang = languageForPath(relPath);
  if (lang === "python") return stripPythonComments(text);
  if (lang === "ruby") return stripPythonComments(stripRubyBlockComments(text));
  if (lang === "php") return stripPhpComments(text);
  if (lang === "rust" || lang === "kotlin") return stripCStyleCommentsNested(text);
  if (lang !== undefined && WIRING_C_STYLE_LANGS.has(lang)) return stripCStyleComments(text);
  return text;
}

/**
 * Wiring-satisfaction rule (2026-07-12b redesign). Approximates the external
 * verifier's real requirement — "the source endpoint is CONSUMED outside its
 * own module" — textually: satisfied when some scanned file (a) does NOT lie
 * under the check's registered `sourceDir`, and (b) contains the wiring
 * SOURCE token (`tokens[0]`; case/underscore-insensitive, matching
 * buildWiringCooccurrenceCheck's normIdent via normalizeForCooccur — the same
 * normalization) in NON-COMMENT text.
 *
 * REPLACES the old both-tokens-within-N-lines-in-glob rule entirely — this is
 * not an alternative satisfier alongside it. The old rule considered ONLY the
 * pinned `glob` destination file and treated a comment mention as equally
 * good as real code, which produced both documented failure modes: false-open
 * on a correct solution that wired the source into a DIFFERENT consumer than
 * the one pinned file (the check never even looked there), and false-satisfy
 * when a comment near the dest token happened to also mention the source
 * token (2026-07-12b — same run, both directions). The destination
 * token (`tokens[1]`), `glob`, and `proximity` are no longer consulted for
 * satisfaction — all three remain on the record only as description detail
 * (see buildWiringCooccurrenceCheck's `desc` string, still built from them).
 *
 * A KNOWN, ACCEPTED ceiling (documented, not a bug this redesign owes a fix
 * for): this is a textual approximation and cannot see field-level data flow
 * — a non-comment out-of-module reference to the source token is treated as
 * consumption even if the value is not actually threaded anywhere meaningful.
 * The external verifier's field-level leg is explicitly out of scope for a
 * textual check (see the task's "Leg-2... OUT OF SCOPE" note).
 */
function wiringCheckSatisfied(
  check: PackCheckRecord,
  contents: ReadonlyArray<{ rel: string; text: string }>,
  strippedOf: (f: { rel: string; text: string }) => string,
): boolean {
  const tokens = check.tokens;
  if (!Array.isArray(tokens) || tokens.length !== 2) return false;
  const sourceToken = tokens[0];
  if (typeof sourceToken !== "string" || sourceToken === "") return false;
  const needle = normalizeForCooccur(sourceToken);
  if (needle === "") return false;
  const sourceDir = (check as PackCheckRecord & WiringSourceDirCarrier).sourceDir ?? "";

  return contents.some((f) => {
    if (isUnderSourceDir(f.rel, sourceDir)) return false;
    return normalizeForCooccur(strippedOf(f)).includes(needle);
  });
}

/**
 * Evaluate ALL verifiable pack checks against the (TL + native) scan set and
 * return the open records plus the done/total tallies. Shared by attachClosure
 * (per-edit reminder) and read_code mode=closure (final self-check) so both
 * see IDENTICAL semantics, including the native-edit expansion.
 */
export function computeClosureState(
  workspace: string,
  readFile?: (rel: string) => string | undefined,
): { open: PackCheckRecord[]; done: number; total: number } | undefined {
  const state = getPackChecks(workspace);
  if (state === undefined) return undefined;
  const verifiable = state.checks.filter(isVerifiableCheck);
  if (verifiable.length === 0) return { open: [], done: 0, total: 0 };

  // When a readFile seam is injected (tests), skip git — its content model is
  // keyed by relative path and would be incoherent with real on-disk state.
  const scanPaths = closureScanPaths(workspace, readFile === undefined);
  const contents: Array<{ rel: string; text: string }> = [];
  let totalBytes = 0;
  for (const rel of scanPaths) {
    const text = readEditedFile(workspace, rel, readFile);
    if (text === undefined) continue;
    totalBytes += Buffer.byteLength(text, "utf8");
    if (totalBytes > MAX_TOTAL_BYTES) break;
    contents.push({ rel, text });
  }

  // Comment-stripped text (wiring satisfaction only) is computed lazily and
  // cached across checks within this one call — a handful of open wiring
  // checks against the same edited file should not re-strip it repeatedly.
  const strippedCache = new Map<string, string>();
  const strippedOf = (f: { rel: string; text: string }): string => {
    let s = strippedCache.get(f.rel);
    if (s === undefined) {
      s = stripCommentsForWiringScan(f.text, f.rel);
      strippedCache.set(f.rel, s);
    }
    return s;
  };

  const open: PackCheckRecord[] = [];
  for (const check of verifiable) {
    const isStructural = Array.isArray(check.allTokens) && check.allTokens.length > 0;
    const isWiring = Array.isArray(check.tokens) && check.tokens.length === 2;
    const satisfied = isStructural
      ? contents.some((file) => {
          if (!globMatches(file.rel, check.glob)) return false;
          const normalized = normalizeForCooccur(strippedOf(file));
          return check.allTokens!.every((token) =>
            normalized.includes(normalizeForCooccur(token))
          );
        })
      : isWiring
      ? wiringCheckSatisfied(check, contents, strippedOf)
      : contents.some((f) => {
          if (!globMatches(f.rel, check.glob)) return false;
          return f.text.includes(check.token as string);
        });
    if (!satisfied) open.push(check);
  }
  return { open, done: verifiable.length - open.length, total: verifiable.length };
}

/**
 * Read-path wrapper around computeClosureState: the edit path (attachClosure)
 * already has its own try/catch, but the two READ callers — the task_pack
 * dedup fast-path and read_code mode=closure — previously called
 * computeClosureState unguarded, so a throw would surface as a raw RPC internal
 * error instead of a graceful response. Every internal fs/git op is already
 * individually guarded, so this is belt-and-suspenders; if it ever fires we
 * fail toward NOT complete — every verifiable check reported OPEN (done:0) —
 * so a "done" self-check can never claim closure it could not verify. Returns
 * undefined only for the genuine "no pack recorded" case (never on error).
 */
export function computeClosureStateSafe(
  workspace: string,
  readFile?: (rel: string) => string | undefined,
): { open: PackCheckRecord[]; done: number; total: number } | undefined {
  try {
    return computeClosureState(workspace, readFile);
  } catch {
    const state = getPackChecks(workspace);
    if (state === undefined) return undefined;
    const verifiable = state.checks.filter(isVerifiableCheck);
    return { open: [...verifiable], done: 0, total: verifiable.length };
  }
}

/**
 * Escalation note text (2026-07-12c ignored-open-check forensics), added as an
 * `escalation` field inside the SAME `closure: {...}` object literal that
 * already carries `open`/`done` (see attachClosure) — at most once per
 * session, and never spliced onto an already-returned/already-fitted result.
 * That "never post-cap splice" discipline mirrors the fix applied elsewhere
 * in this repo for the same bug CLASS (readCodeTaskPack.ts's
 * annotateSpannedRoots, findReferences.ts's fitReferencesToCap): a field
 * added AFTER a size-capped object has already been measured/returned can
 * silently escape whatever budget that measurement enforced. Here the
 * addition is a fixed, short, compile-time string (not derived from
 * unbounded data), so — unlike those two data-dependent fixes — no
 * speculative-then-shed re-check is needed; being part of the SAME literal
 * that already applies MAX_OPEN_DESCS/MAX_DESC_CHARS is sufficient.
 */
export const CLOSURE_ESCALATION_NOTE =
  `open for ${CLOSURE_ESCALATION_THRESHOLD}+ edits — resolve it or verify it is genuinely unneeded before ` +
  `concluding; a persistently open check predicts verification failure`;

/**
 * 2026-07-16a re-read-loop forensics: guidance attached to a closure payload once
 * every verifiable check is satisfied (total>0, open==[]). A 20+ turn
 * re-read loop was observed AFTER mode=closure already reported
 * complete:true — the agent kept re-opening edited files because
 * concern_note/the unread-sibling note kept naming "unread" concerns.
 * Those two nudges are now suppressed while markClosureSatisfied's flag is
 * set (see util/session.ts); this note is the positive-guidance half of the
 * same fix — it rides along on the SAME payload that trips the suppression,
 * so the caller is told directly why the nudges stopped instead of just
 * noticing their absence. Shared by both closure-payload builders:
 * attachClosure's edit-path complete transition (nested under closure.note)
 * and mode=closure's read-path complete branch (server.ts, top-level
 * note — that branch has no pre-existing note key to collide with; the
 * OTHER mode=closure branch's top-level `note` is a different, mutually
 * exclusive total==0 case).
 */
export const CLOSURE_SATISFIED_NOTE =
  "closure complete — verify with tests/git diff; re-reading edited files adds no new evidence";

/** One open closure check projected as an actionable capability gap. */
export interface ClosureCapabilityGap {
  kind: "missing-evidence";
  recoverable: true;
  reason: string;
  next_call: { tool: "search_files" | "read_file"; arguments: Record<string, unknown> };
}

/**
 * P0a §6.1/§6.5 (2026-08-13) — wire/guide convergence. The canonical agent
 * guide instructs the agent to act on `capability_gaps[].next_call` when a
 * closure signal is OPEN, and the edit rule says to "take only the supplied
 * closure or next_call". Before this wave the open branch shipped bare
 * descriptions, so that instruction had no referent on an edit response and
 * the agent had to invent a native search. Mirror the task-pack gap shape:
 * one bounded, executable, read-only call per open check, aligned index-wise
 * with `closure.open` (same slice, same truncation).
 */
function closureCapabilityGaps(open: PackCheckRecord[]): ClosureCapabilityGap[] {
  return open.slice(0, MAX_OPEN_DESCS).map((check) => {
    const reason = check.desc.length > MAX_DESC_CHARS ? check.desc.slice(0, MAX_DESC_CHARS) : check.desc;
    const probe = [check.token, check.tokens?.[0], check.allTokens?.[0]]
      .find((token): token is string => typeof token === "string" && token !== "");
    return {
      kind: "missing-evidence",
      recoverable: true,
      reason,
      next_call: probe !== undefined
        ? { tool: "search_files", arguments: { action: "find", query: probe } }
        : { tool: "read_file", arguments: { mode: "task_pack", query: reason } },
    };
  });
}

/**
 * Verifies the workspace's token-bearing pack checks against the files edited so
 * far and, when a pack is active, attaches a compact `closure` reminder to a
 * successful edit_file result. Returns the result unchanged when there is no
 * pack, no token-bearing check, the result is a failure, or on any internal
 * error. Never mutates the input.
 *
 * Attached shapes (exactly one, or nothing):
 *  - some checks still open → `closure: { open: [desc,…] (≤3, each ≤140ch), done }`
 *    — plus a one-shot `escalation` string (CLOSURE_ESCALATION_NOTE) the
 *    FIRST time the SAME check id has stayed open across
 *    CLOSURE_ESCALATION_THRESHOLD consecutive closure-bearing responses (see
 *    recordClosureOpenStreak); every session escalates at most once.
 *  - just transitioned to all-satisfied → `closure: { done, complete: true }`
 *    PLUS a top-level `closure_complete: true` sibling (DESIGN-v0.9 §3.1/§6,
 *    WS-P3 "zero-content turns"): the SAME one-shot transition (fires exactly
 *    once — detected via recordClosureReport — and NEVER on a later edit,
 *    including one made after everything was already closed) also stamps
 *    this flat, additive boolean so the agent can see "nothing left to
 *    close" without spending a whole extra `mode=closure` turn to learn it.
 *    It is a plain sibling of `closure`, not folded inside it, to match the
 *    flat top-level shape every other v0.9 response field uses (§3.1).
 *  - otherwise → nothing.
 */
export function attachClosure(
  result: Record<string, unknown>,
  workspace: string,
  readFile?: (abs: string) => string | undefined,
): Record<string, unknown> {
  try {
    if ((result as { ok?: boolean }).ok === false) return result;

    const written = extractWrittenPaths(result);
    if (written.length === 0) return result;

    for (const rel of written) recordEditedPath(workspace, rel);

    // Shared scan (TL-edited FIRST, then git-detected native edits) + shared
    // check evaluation (single-token AND 2-token wiring). undefined => no
    // pack; {total:0} => a pack with no machine-verifiable check.
    const computed = computeClosureState(workspace, readFile);
    if (computed === undefined) return result;
    if (computed.total === 0) return result;
    const { open, done: doneCount } = computed;

    // 2026-07-16a re-read-loop forensics: keep closureSatisfied in sync with THIS evaluation
    // on every closure-bearing call, independent of whether a `closure`
    // field is attached below (this function only attaches one on an open
    // check or on the open→satisfied transition — see the prevOpen branch
    // further down). buildConcernNote (readCodeModes.ts) and the
    // unread-sibling note (server.ts's finishEdit) read this flag to
    // suppress advisory re-read nudges once verification is current.
    if (open.length === 0) {
      markClosureSatisfied(workspace);
    } else {
      clearClosureSatisfied(workspace);
    }

    const openIds = open.map((c) => c.id);
    const prevOpen = recordClosureReport(workspace, openIds);

    // Escalation (2026-07-12c ignored-open-check forensics): every closure-bearing
    // evaluation reaches this point (including the empty-open case just
    // below), so the run resets exactly when a check closes — see
    // recordClosureOpenStreak's doc comment for the full continuation/reset
    // rules. `escalate` can only be true when `openIds` is non-empty (the
    // function returns false unconditionally for an empty id list), so it is
    // safe to compute unconditionally here and consult it only in the open
    // branch below.
    const escalate = recordClosureOpenStreak(workspace, openIds);

    if (open.length > 0) {
      const descs = open
        .slice(0, MAX_OPEN_DESCS)
        .map((c) => (c.desc.length > MAX_DESC_CHARS ? c.desc.slice(0, MAX_DESC_CHARS) : c.desc));
      return {
        ...result,
        closure: {
          open: descs,
          done: doneCount,
          // Actionable half of the open signal — see closureCapabilityGaps.
          capability_gaps: closureCapabilityGaps(open),
          ...(escalate ? { escalation: CLOSURE_ESCALATION_NOTE } : {}),
        },
      };
    }

    // No open checks now. Report the open→satisfied transition exactly once:
    // only when the PREVIOUS report still had open ids (so a plain edit made
    // long after everything was already closed adds nothing). closure_complete
    // rides the SAME one-shot guard as closure.complete — see this function's
    // doc comment — so it can never appear on a later, unrelated edit.
    if (prevOpen.length > 0) {
      return {
        ...result,
        closure: { done: doneCount, complete: true, note: CLOSURE_SATISFIED_NOTE },
        closure_complete: true,
      };
    }

    return result;
  } catch {
    // Closure tracking is strictly advisory — never let it break an edit.
    return result;
  }
}
