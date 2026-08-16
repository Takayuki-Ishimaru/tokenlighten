/**
 * findText — lexical text search across code files (explore action=find).
 *
 * Line-oriented match (literal substring or regex), no AST. Cheap and broad;
 * use findReferences for symbol-aware (word-boundary) lookups, search_symbols
 * for declaration lookups.
 *
 * `findText()` is the low-level primitive: one query, flat matches, byte cap.
 * It stays backward compatible (flat `{path, line}[]`, optionally `text`) so
 * existing internal callers (locateTaskContext, server.ts's edit-review pass)
 * keep working unchanged.
 *
 * `buildFindResponse()` is the explore action=find response builder: it wraps
 * findText with A1's never-empty behavior — literal match first, then
 * tokenized AND/OR fallback, then did_you_mean path candidates — and groups
 * matches by file so full paths are not repeated per line.
 *
 * Output policy: plain data — no meta envelope.
 */

import * as fs from "fs";
import * as path from "path";
import type { FoundFile, LangKey } from "../../../tools/walkRepo.js";
import { walkCodeFiles, createWalkOmissions, anyWalkOmission, genericTextDiscoveryEnabled, type WalkOmissions } from "../../../tools/walkRepo.js";
import { deriveTokenVariants } from "../../../util/impact.js";
import { tokenizeQuery as tokenizeQueryShared } from "../../../util/queryShape.js";
import { regexSignatureLines } from "../../../skeleton/regexFallback.js";
import { languageForPath } from "../../../util/languages.js";
import { classifyCommentLines } from "../../../util/lineClassify.js";
import { handleTable } from "../../../util/handles.js";
// L3 (2026-08-08 find-honesty): recovery affordances rank by what the SERVED
// surface actually contains, and the edit-grade hint is gated on whether the
// file it names could be an edit target at all. state/session.ts imports
// nothing from this feature (only node builtins and @tokenlighten/types),
// so this direction cannot form a cycle.
import { getReadPaths, isPlausibleEditTarget } from "../../../state/session.js";
// Type-only: memberSweep.ts imports VALUES from this file (MAX_RESPONSE_BYTES/
// MAX_INVENTORY_RESPONSE_BYTES), so this direction must stay type-only to
// avoid a real runtime import cycle — erased at compile time either way.
import type { MemberSweepAttachment } from "./memberSweep.js";
// Type-only, same reason: relatedLookups.ts also imports MAX_RESPONSE_BYTES/
// MAX_INVENTORY_RESPONSE_BYTES from this file.
import type { RelatedLookups } from "./relatedLookups.js";

const MAX_MATCHES = 100;

/**
 * A9 — non-code asset extensions the findText() PRIMITIVE walks by default
 * (e.g. CSS custom properties like `--color-priority-critical`). This is the
 * narrow, backward-compatible default used by findText() itself and by
 * internal callers that go through it (locateTaskContext's text-search
 * layer, server.ts's edit-review pass) — those must keep walking the same
 * scope they always have, so widening explore action=find's own reach (see
 * FIND_ACTION_EXTRA_EXTS below) does not change locateTaskContext's
 * candidate set or ranking.
 */
const FIND_EXTRA_EXTS = [".css"] as const;

/**
 * S1/C2 — non-code, text-bearing extensions explore action=find (the
 * buildFindResponse() response-builder entrypoint only, NOT the findText()
 * primitive) should additionally discover: doc/config/log content
 * (markdown, plaintext, structured config, CSV, log files, XML), style
 * preprocessors (SCSS/Less — mirrors STYLE_EXTRA_EXTS elsewhere in this
 * package: locateTaskContext.ts, readCodeTaskPack.ts), and other common
 * non-code text formats agents search over in practice: Java .properties
 * config (live-fixture-relevant), SQL, Protobuf schemas, shell/batch/PowerShell
 * scripts, Gradle build files, GraphQL, and Terraform — so a plain-language
 * query surfaces hits living in docs, config, and build/infra files, not
 * just source. Additive only via walkCodeFiles' extraExts option: does not
 * change the default tracked-code set used by other walkCodeFiles callers
 * (findReferences, renameSymbol, locateTaskContext, etc.) — those keep
 * walking code exts only. Scoped to buildFindResponse's own scanLiteral
 * calls (and its did-you-mean path-name fallback) specifically so
 * findText()'s shared internal callers are unaffected — see FIND_EXTRA_EXTS.
 * FIND_ACTION_EXTRA_BASENAMES (below) is this same widening's companion for
 * well-known EXTENSIONLESS build/CI files (Dockerfile, Makefile, ...).
 *
 * Deliberate EXCLUSIONS (do not add without re-reviewing the rationale):
 *   - .env, .pem, .key (and other secret/credential-bearing extensions):
 *     surfacing secret values in search results would be a security
 *     regression, and the repo convention already forbids reading .env.
 *   - .min.* (minified noise): already excluded repo-wide by the generic
 *     looksGeneratedFile() filter (.min.js/.min.css specifically — see
 *     walkRepo.ts), independent of this extension list, so no new logic
 *     was needed here.
 *   - Lock files (package-lock.json, etc.): not extension-excluded — a lock
 *     file with a listed extension (e.g. .json) IS walked like any other —
 *     but an oversized one is already dropped by walkCodeFiles' pre-existing
 *     MAX_FILE_SIZE_BYTES (1 MB) per-file cap, which applies uniformly to
 *     extraExts/extraBasenames files and default tracked-code files alike.
 *     No new cap was added for this widening.
 */
export const FIND_ACTION_EXTRA_EXTS = [
  ".css",
  ".scss",
  ".less",
  ".md",
  ".markdown",
  ".txt",
  ".rst",
  ".json",
  ".jsonl",
  ".yaml",
  ".yml",
  ".toml",
  ".ini",
  ".cfg",
  ".conf",
  ".csv",
  ".log",
  ".xml",
  ".properties",
  ".sql",
  ".proto",
  ".sh",
  ".bat",
  ".ps1",
  ".gradle",
  ".graphql",
  ".gql",
  ".tf",
] as const;

/**
 * S1/C2 companion — extensionless, well-known basenames explore action=find
 * should additionally discover: build/CI entry points that carry no file
 * extension at all (`path.extname` returns "" for these, so they can never
 * match a FIND_ACTION_EXTRA_EXTS entry). Matched by EXACT, case-sensitive
 * basename via walkCodeFiles' extraBasenames option — same additive-only,
 * buildFindResponse-only scoping as FIND_ACTION_EXTRA_EXTS (see its doc
 * comment above); the findText() primitive and its internal callers never
 * pass extraBasenames, so they are unaffected.
 */
export const FIND_ACTION_EXTRA_BASENAMES = [
  "Dockerfile",
  "Makefile",
  "Jenkinsfile",
  "Gemfile",
  "Rakefile",
  "Procfile",
] as const;

// ---------------------------------------------------------------------------
// Constants — exported so budget tests (P3.3) can import them.
// ---------------------------------------------------------------------------

/** Hard byte cap for the full JSON response (matches array + query/truncated/total). */
export const MAX_RESPONSE_BYTES = 4096;

/**
 * "snippets may truncate; the inventory never lies" — hard ceiling for the
 * WHOLE buildFindResponse()/buildFindResponseForQueries() response INCLUDING
 * the match inventory attached by attachInventory() below. Distinct from
 * MAX_RESPONSE_BYTES, which continues to bound ONLY the per-file snippet
 * section (files[]/roles/matched_terms/hint) exactly as before — fitting
 * that section is unchanged. This larger ceiling is the worst-case bound for
 * that SAME fitted payload plus the always-accurate total_files/total_matches
 * and the inventory/rollup spliced on after fitting. ~24 KiB is generous
 * enough that even a pathological multi-thousand-file match count fits via
 * the per-directory rollup (with a final defensive trim as an absolute
 * backstop — see attachInventory).
 */
export const MAX_INVENTORY_RESPONSE_BYTES = 24 * 1024;

/**
 * Above this many distinct matched files, the per-file inventory collapses
 * to a per-directory rollup even if it would otherwise fit in bytes — keeps
 * the array itself from growing unboundedly long.
 */
const INVENTORY_ROLLUP_FILE_THRESHOLD = 200;

/**
 * Above this many bytes for the per-file inventory JSON alone, collapse to a
 * per-directory rollup regardless of file count.
 */
const INVENTORY_ROLLUP_BYTES_THRESHOLD = 16 * 1024;

/** Minimum number of matches to keep even when trimming for cap. */
const MIN_MATCHES = 3;

/** Below this many literal matches, A1's tokenized fallback also runs (never-empty). */
const MIN_LITERAL_MATCHES_BEFORE_FALLBACK = 1;

/**
 * Max length of the per-match trimmed line-text field.
 *
 * F1 (2026-08-01 find-diet): audited against bench forensics that measured
 * oversized find payloads (e.g. a 13.5 KB result against a native-grep
 * equivalent of 79-930 bytes) — already comfortably inside the ~110-char
 * per-hit snippet target that audit set (<=80 chars total — trimMatchText
 * reserves the ellipsis from that same budget rather than adding it on
 * top), so left unchanged here. The real
 * driver of those oversized responses was per-file LINE VOLUME and
 * many-file RESPONSE VOLUME, not this per-hit field — see
 * MAX_LINES_PER_FILE and SOFT_DEGRADE_BYTES below, which is where that
 * budget was actually being spent. Exported so specs can assert against
 * this constant instead of a magic number.
 */
export const MATCH_TEXT_MAX_CHARS = 80;

export interface FindTextInput {
  query: string;
  /** When true, query is parsed as a RegExp; otherwise it is a literal substring. */
  regex?: boolean;
  lang?: LangKey;
  /** Restrict to a file or subdirectory (workspace-relative). */
  path?: string;
  /**
   * Case sensitivity for literal (non-regex) queries.
   * Default: case-insensitive for single-token queries, case-sensitive for
   * multi-token queries (callers that want a specific behavior can override).
   */
  caseInsensitive?: boolean;
}

export interface TextMatch {
  path: string;
  line: number;
  /** Trimmed source line (<=80 chars), so a hit rarely needs a confirming read. */
  text?: string;
}

export interface FindTextResult {
  query: string;
  matches: TextMatch[];
  truncated: boolean;
  total: number;
}

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Maximum caller-supplied regular-expression length accepted by find. */
export const MAX_REGEX_QUERY_CHARS = 256;

/**
 * Conservative admission check for JavaScript regular expressions.
 *
 * Reject constructs that can make backtracking super-linear: backreferences,
 * lookarounds, repeated quantified/alternating groups, adjacent quantifiers,
 * and excessive repetition operators. False negatives are preferable to
 * blocking the single MCP event loop on an attacker-controlled expression.
 */
export function isSafeRegexQuery(query: string): boolean {
  if (query.length === 0 || query.length > MAX_REGEX_QUERY_CHARS) return false;

  type Group = { hasAlternation: boolean; hasQuantifier: boolean };
  const groups: Group[] = [{ hasAlternation: false, hasQuantifier: false }];
  const closedGroups: Group[] = [];
  let inClass = false;
  let escaped = false;
  let quantifiers = 0;
  let previousWasQuantifier = false;

  for (let i = 0; i < query.length; i++) {
    const ch = query[i]!;
    if (escaped) {
      if (!inClass && /[1-9]/.test(ch)) return false;
      escaped = false;
      previousWasQuantifier = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (inClass) {
      if (ch === "]") inClass = false;
      continue;
    }
    if (ch === "[") {
      inClass = true;
      previousWasQuantifier = false;
      continue;
    }
    if (ch === "(") {
      if (query[i + 1] === "?") {
        if (query[i + 2] !== ":") return false;
        i += 2;
      }
      groups.push({ hasAlternation: false, hasQuantifier: false });
      closedGroups.push({ hasAlternation: false, hasQuantifier: false });
      previousWasQuantifier = false;
      continue;
    }
    if (ch === ")") {
      if (groups.length <= 1) return false;
      const closed = groups.pop()!;
      closedGroups[closedGroups.length - 1] = closed;
      previousWasQuantifier = false;
      continue;
    }
    if (ch === "|") {
      groups[groups.length - 1]!.hasAlternation = true;
      previousWasQuantifier = false;
      continue;
    }

    const braceQuantifier = ch === "{" && /^\{\d+(?:,\d*)?\}/.test(query.slice(i));
    if (ch === "*" || ch === "+" || ch === "?" || braceQuantifier) {
      quantifiers += 1;
      if (quantifiers > 16 || previousWasQuantifier) return false;
      const lastClosed = query[i - 1] === ")" ? closedGroups.at(-1) : undefined;
      if (lastClosed?.hasAlternation || lastClosed?.hasQuantifier) return false;
      groups[groups.length - 1]!.hasQuantifier = true;
      previousWasQuantifier = true;
      if (braceQuantifier) {
        const match = /^\{\d+(?:,\d*)?\}/.exec(query.slice(i));
        i += (match?.[0].length ?? 1) - 1;
      }
      continue;
    }
    previousWasQuantifier = false;
  }

  return !escaped && !inClass && groups.length === 1;
}

/** True when the query has no whitespace-separated words (a single token/phrase). */
function isSingleToken(query: string): boolean {
  return query.trim().split(/\s+/).filter(Boolean).length <= 1;
}

/**
 * Chars of left context to keep before the match start when windowing
 * (C6). The remainder of MATCH_TEXT_MAX_CHARS goes to the match itself and
 * right context, so a match deep in a long line still keeps its matched
 * token in the snippet instead of being clipped by a naive first-N-chars
 * trim (the C6 bug: a match at column 100 used to vanish entirely).
 */
const MATCH_WINDOW_LEFT_CONTEXT = 20;

/**
 * Trim a source line to an ~80-char (MATCH_TEXT_MAX_CHARS) snippet CENTERED
 * on the match, not the first 80 chars of the line. `matchStart` is the
 * 0-based column of the match in the ORIGINAL (untrimmed) `line`; when
 * omitted, behaves as a left-anchored trim (back-compat for callers that
 * only have a boolean match, e.g. no-match paths).
 *
 * Windowing policy: clamp a window starting at
 * `max(0, matchStart - MATCH_WINDOW_LEFT_CONTEXT)` for up to
 * MATCH_TEXT_MAX_CHARS chars of the RAW line, prefixed with "…" when the
 * window's left edge is not the start of the (trimmed) line, and suffixed
 * with "…" when the window's right edge is not the end of the line. This
 * guarantees the matched token stays inside the returned text regardless of
 * column, while keeping the snippet within MATCH_TEXT_MAX_CHARS + ellipses.
 */
export function trimMatchText(line: string, matchStart?: number): string {
  const leadingWs = line.length - line.trimStart().length;
  const trimmedLen = line.trim().length;
  const lineEnd = leadingWs + trimmedLen; // end index of trimmed content in `line`

  if (matchStart === undefined || matchStart <= leadingWs + MATCH_WINDOW_LEFT_CONTEXT) {
    // Match is near the start (or unknown) — original left-anchored trim,
    // computed against the trimmed line so short/near-col-0 matches are
    // byte-identical to pre-C6 output (no spurious leading "…").
    const t = line.trim();
    return t.length > MATCH_TEXT_MAX_CHARS ? t.slice(0, MATCH_TEXT_MAX_CHARS - 1) + "…" : t;
  }

  // Match is deep in the line — center the window on it.
  const start = Math.max(leadingWs, matchStart - MATCH_WINDOW_LEFT_CONTEXT);
  const leftClipped = start > leadingWs;
  const budget = leftClipped ? MATCH_TEXT_MAX_CHARS - 1 : MATCH_TEXT_MAX_CHARS;
  let end = Math.min(lineEnd, start + budget);
  const rightClipped = end < lineEnd;
  if (rightClipped) end = Math.max(start, end - 1); // reserve a char for trailing "…"

  const windowed = line.slice(start, end);
  return (leftClipped ? "…" : "") + windowed + (rightClipped ? "…" : "");
}

/** Bounded per-response file-content cache: one read per file per response. */
export interface ScanContentCache {
  lines: Map<string, string[] | null>;
  bytes: number;
}

export function createScanContentCache(): ScanContentCache {
  return { lines: new Map(), bytes: 0 };
}

/**
 * Per-response record of which walked files were ACTUALLY content-scanned.
 *
 * The absence certificate (see `FindAbsence`) may only be issued over files
 * whose bytes were really read and line-matched — never over "the walk found
 * N candidates". Two classes reach scanLiteral and are then skipped without a
 * content scan, and both would silently inflate a negative claim:
 *   - `kind:"artifact"` entries (ZIP/PDF containers participate in find by
 *     FILENAME only — never UTF-8 scanned), and
 *   - files whose read failed (permissions, races, deleted mid-walk).
 * Sets (not counters) because one response runs several scanLiteral passes
 * over the SAME walked list (literal, sibling-stem, variant probes, per-term
 * tokenized) and a file must be counted once, not once per pass.
 */
export interface ScanCoverage {
  /** Workspace-relative paths whose content was read and line-scanned. */
  scanned: Set<string>;
  /** Walked paths skipped WITHOUT a content scan (unreadable / filename-only). */
  unscanned: Set<string>;
}

export function createScanCoverage(): ScanCoverage {
  return { scanned: new Set(), unscanned: new Set() };
}

/** Total bytes retained per response; larger corpora fall back to read-through. */
const SCAN_CONTENT_CACHE_MAX_BYTES = 64 * 1024 * 1024;

function readLinesCached(absPath: string, cache: ScanContentCache | undefined): string[] | null {
  const hit = cache?.lines.get(absPath);
  if (hit !== undefined) return hit;
  let raw: string;
  try {
    raw = fs.readFileSync(absPath, "utf8");
  } catch {
    cache?.lines.set(absPath, null);
    return null;
  }
  const lines = raw.split(/\r?\n/);
  if (cache && cache.bytes + raw.length <= SCAN_CONTENT_CACHE_MAX_BYTES) {
    cache.lines.set(absPath, lines);
    cache.bytes += raw.length;
  }
  return lines;
}

/**
 * Raw literal/regex line scan — no cap, no truncation bookkeeping. Shared by
 * findText() (single-query callers) and the tokenized fallback (multi-query,
 * scored) in buildFindResponse().
 *
 * `onlyFiles` (workspace-relative paths) restricts the scan to exactly those
 * files instead of walking the whole workspace — used by
 * withSiblingStemMatches, which only ever needs to widen within files that
 * already matched literally (typically 1-3 files), not re-scan every file
 * in the repo only to discard everything outside that small set.
 *
 * `extraExts` (S1/C2) overrides the default FIND_EXTRA_EXTS (.css-only) walk
 * scope — buildFindResponse's own call sites pass FIND_ACTION_EXTRA_EXTS
 * (the widened doc/config/log set) explicitly; findText() (the primitive
 * locateTaskContext and other internal callers use) omits it and keeps the
 * narrow default, so those callers' candidate sets are unaffected by C2.
 *
 * Exported only so tests can exercise `onlyFiles` directly (the mechanism
 * withSiblingStemMatches relies on to avoid a full-workspace rescan);
 * findText.ts's other exports are the actual public surface.
 */
export function scanLiteral(
  query: string,
  workspace: string,
  opts: {
    regex?: boolean;
    lang?: LangKey;
    path?: string;
    caseInsensitive?: boolean;
    onlyFiles?: Set<string>;
    /** Pre-walked file list — reuse across per-term scans in one response. */
    files?: ReadonlyArray<Pick<FoundFile, "relPath" | "absPath" | "kind">>;
    extraExts?: readonly string[];
    extraBasenames?: readonly string[];
    includeArtifacts?: boolean;
    respectGitignore?: boolean;
    /** Filled by the walk (only when this call walks; `files` skips it). */
    omissions?: WalkOmissions;
    /** Shared per-response content cache (bounded; see ScanContentCache). */
    contentCache?: ScanContentCache;
    /**
     * Accumulates which files were really content-scanned by this call — the
     * only sound basis for the absence certificate (see ScanCoverage).
     */
    coverage?: ScanCoverage;
  },
): TextMatch[] {
  let needle: RegExp;
  if (opts.regex) {
    if (!isSafeRegexQuery(query)) return [];
    try {
      needle = new RegExp(query, opts.caseInsensitive ? "i" : undefined);
    } catch {
      return [];
    }
  } else {
    needle = new RegExp(escapeRegExp(query), opts.caseInsensitive ? "i" : undefined);
  }

  const files: ReadonlyArray<Pick<FoundFile, "relPath" | "absPath" | "kind">> = opts.files
    ?? (opts.onlyFiles
      ? [...opts.onlyFiles].map((relPath) => ({ relPath, absPath: path.join(workspace, relPath) }))
      : walkCodeFiles(workspace, {
          ...(opts.lang ? { lang: opts.lang } : {}),
          ...(opts.path ? { subPath: opts.path } : {}),
          extraExts: opts.extraExts ?? FIND_EXTRA_EXTS,
          ...(opts.extraBasenames ? { extraBasenames: opts.extraBasenames } : {}),
          ...(opts.includeArtifacts ? { includeArtifacts: true } : {}),
          ...(opts.respectGitignore ? { respectGitignore: true } : {}),
          ...(opts.omissions ? { omissions: opts.omissions } : {}),
        }));

  const out: TextMatch[] = [];
  const coverage = opts.coverage;
  for (const f of files) {
    // Artifact participation in find is filename-only. Never UTF-8/regex scan
    // ZIP/PDF bytes: lossy mojibake can otherwise produce apparent matches.
    if (f.kind === "artifact") {
      coverage?.unscanned.add(f.relPath);
      continue;
    }
    const lines = readLinesCached(f.absPath, opts.contentCache);
    if (lines === null) {
      coverage?.unscanned.add(f.relPath);
      continue;
    }
    coverage?.scanned.add(f.relPath);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const m = needle.exec(line);
      if (m) {
        out.push({ path: f.relPath, line: i + 1, text: trimMatchText(line, m.index) });
      }
    }
  }
  return out;
}

export function findText(input: FindTextInput, workspace: string): FindTextResult {
  const query = input.query;
  if (!query) {
    return { query, matches: [], truncated: false, total: 0 };
  }

  const caseInsensitive = input.caseInsensitive ?? (!input.regex && isSingleToken(query));

  const all = scanLiteral(query, workspace, {
    ...(input.regex !== undefined ? { regex: input.regex } : {}),
    ...(input.lang ? { lang: input.lang } : {}),
    ...(input.path ? { path: input.path } : {}),
    caseInsensitive,
  });

  const matchTruncated = all.length > MAX_MATCHES;
  let matches = matchTruncated ? all.slice(0, MAX_MATCHES) : all;
  let truncated = matchTruncated;

  // Enforce byte cap: drop trailing matches until JSON fits, keeping MIN_MATCHES.
  function serialize(m: TextMatch[]): string {
    return JSON.stringify({ query, matches: m, truncated: true, total: all.length });
  }
  if (Buffer.byteLength(JSON.stringify({ query, matches, truncated, total: all.length }), "utf8") > MAX_RESPONSE_BYTES) {
    while (
      matches.length > MIN_MATCHES &&
      Buffer.byteLength(serialize(matches), "utf8") > MAX_RESPONSE_BYTES
    ) {
      matches = matches.slice(0, -1);
      truncated = true;
    }
    truncated = true;
  }

  return {
    query,
    matches,
    truncated,
    total: all.length,
  };
}

// ---------------------------------------------------------------------------
// A1 — never-empty, grouped explore action=find response
// ---------------------------------------------------------------------------

// FIND_STOP_WORDS: filler words dropped by this file's tokenizeQuery.
// Deliberately its own list, not merged with readCodeTaskPack.ts's
// CONCERN_STOP_WORDS (see that set's own comment) — the two callers already
// disagreed on some filler words before this consolidation, and the
// consolidation is the shared pipeline (util/queryShape.ts's
// tokenizeQuery), not the word lists.
const FIND_STOP_WORDS = new Set([
  "the", "and", "for", "not", "but", "with", "this", "that", "have", "from",
  "are", "was", "were", "has", "had", "does", "did", "can", "could", "will",
  "would", "should", "may", "might", "shall", "when", "where", "which", "what",
  "how", "who", "why", "its", "our", "their", "your", "out", "into", "add",
  "then", "than", "also", "any", "all", "some", "each", "both", "being",
  "in", "on", "of", "to", "a", "an", "is", "be", "as", "by", "or", "at",
]);

/**
 * Split a free-text query into identifier-like tokens: quoted phrases kept
 * literal, then camelCase/snake_case/kebab-case words, stop-words dropped,
 * de-duplicated, longest/most-distinctive first. Thin wrapper over the
 * shared pipeline in util/queryShape.ts ("identifier" mode) with this
 * file's own minLen/stop-word list — see that module's doc comment for the
 * full rationale for keeping two modes instead of one merged pipeline.
 */
export function tokenizeQuery(query: string): string[] {
  return tokenizeQueryShared(query, { minLen: 3, stopWords: FIND_STOP_WORDS, mode: "identifier" });
}

export interface FindFileGroup {
  path: string;
  lines: number[];
  /** Trimmed source text per line, same order as `lines` (<=80 chars each). */
  snippets?: string[];
  /**
   * F2 (2026-08-01 find-diet): count of this file's TRUE matched lines
   * beyond what `lines`/`snippets` show — present whenever either array was
   * shortened relative to the file's real hit count, whether by the
   * per-file MAX_LINES_PER_FILE preview cap or by the response-wide byte
   * budget (fitFilesToCap) trimming further. Never silently dropped: the
   * true per-file total is always recoverable as `lines.length +
   * more_lines`, and the response-level `total_matches` (always exact —
   * see FindResponse below) already includes every line this counts.
   * Absent once `lines`/`snippets` show every one of this file's matches.
   */
  more_lines?: number;
  /**
   * One-line "primary symbol + purpose" for this file, e.g.
   * "class RateLimiter — token-bucket limiter for outbound requests".
   * <=72 chars. Present only on the top ROLE_MAX_ANNOTATED_FILES files of a
   * response, and only when cheaply derivable (see deriveFileRole) — never
   * filler. See "Role annotations" section below for full rationale.
   */
  role?: string;
  /** Full hit count before the byte cap trims this file's lines. */
  match_count?: number;
  /** Edit-grade range, present only for a uniquely dominant code cluster. */
  range?: string;
  /** Range handle paired with `context`. */
  handle?: string;
  /** Bounded exact source context around a uniquely dominant repeated hit. */
  context?: string;
}

export interface FindResponse {
  query: string;
  files: FindFileGroup[];
  /**
   * Total distinct matched files. "snippets may truncate; the inventory
   * never lies" (see `inventory` below): this is ALWAYS computed from the
   * FULL match set found before any snippet-cap trimming, never from the
   * (possibly-trimmed) `files[]` this response carries, regardless of
   * `truncated`.
   */
  total_files: number;
  /** Total matched lines across every matched file. Same full-set guarantee as `total_files`. */
  total_matches: number;
  /**
   * True when `files[]`'s per-file SNIPPETS were capped relative to the full
   * match set (a file's `lines`/`snippets` shortened to fewer than its true
   * count, or — only in the rare case where even a 1-line foothold per file
   * cannot all fit — a matched file omitted from `files[]` entirely). Refers
   * to SNIPPET truncation ONLY: `total_files`/`total_matches` are always
   * complete regardless of this flag, and when true an `inventory` (below)
   * is always attached covering 100% of matches. `truncated:true` therefore
   * never means "there might be more matching files than shown" — consult
   * `inventory`/`total_files`/`total_matches` for the complete picture
   * instead of re-searching the same query.
   */
  truncated: boolean;
  /** False when the literal/regex query itself matched nothing and results
   * come from the tokenized AND/OR fallback instead. */
  literal: boolean;
  /**
   * Present when literal:false (the fallback search's actual tokens), or
   * when the request used queries[] (the subset of queries[] that matched
   * at least once), regardless of `literal`.
   */
  matched_terms?: string[];
  /** Per-layer walk skip counts (present only when non-zero; never silent). */
  omitted?: Partial<WalkOmissions>;
  /**
   * Present when the results came from the identifier-VARIANT fallback stage
   * (a naming-convention reconstruction of the query, e.g. an affix-stripped
   * stem) rather than the literal query or the loose tokenized fallback. Its
   * value is the variant probe that actually matched, so the caller sees WHICH
   * convention hit — e.g. a query "badge--priority-urgent" that missed
   * literally but whose stem "priority-urgent" matched the stylesheet's
   * "--color-priority-urgent" reports matched_variant:"priority-urgent". This
   * is what repairs a broken class-name/CSS-custom-property convention chain
   * instead of dumping the caller into the noisier token OR-fallback.
   */
  matched_variant?: string;
  /** Present only when even the tokenized fallback found nothing. */
  did_you_mean?: string[];
  /** Bounded routing/edit guidance when useful. */
  hint?: string;
  /**
   * "snippets may truncate; the inventory never lies": present only when
   * `truncated:true` — a complete listing of EVERY matched file's hit count
   * (ordered by matches desc, then path asc), so a caller whose per-file
   * snippets were capped can still trust it has seen the whole match
   * landscape without re-searching. Collapses to a per-directory
   * `FindInventoryDirEntry[]` rollup (see `inventory_complete`) when the
   * per-file list itself would be large. Omitted on a non-truncated
   * response — `files[]` already IS the complete inventory there (see
   * `inventory_complete` for that case instead).
   */
  inventory?: FindInventoryFileEntry[] | FindInventoryDirEntry[];
  /**
   * `true`: every matched file has its own `inventory` entry — or, when
   * `truncated` is false, `files[]` itself already lists every match and
   * `inventory` was omitted as redundant (small-response case). By-directory:
   * the per-file inventory would itself have been large (>200 files, or its
   * own JSON >16 KiB) so `inventory` entries are coarser per-directory
   * rollups instead — still covering 100% of matches, just grouped coarser.
   * Present whenever the response has at least one match.
   */
  inventory_complete?: true | "by-directory";
  /**
   * A short "this IS the exhaustive answer, stop searching" line. Two
   * producers, never both (they are mutually exclusive response shapes):
   * alongside `inventory` (`total_files`/`total_matches` are complete even
   * though `files[]`'s snippets are capped — re-issuing the same query will
   * not surface additional files), and alongside `absence` (the negative
   * result is authoritative over every scanned file).
   */
  note?: string;
  /**
   * ABSENCE CERTIFICATE — present ONLY on a zero-match response whose scan
   * actually covered files (`total_matches === 0`, `truncated:false`, at
   * least one file content-scanned).
   *
   * MOTIVATION (2026-07-25 bench forensics): solvers escaped to
   * `grep -rlni <token>` to establish NEGATIVE facts ("the EKF class is never
   * instantiated anywhere") because find reported matches authoritatively but
   * said nothing authoritative when there were none — a bare empty `files[]`
   * plus a "retry with another token" hint reads as "the search was weak",
   * not as "the token does not exist", so the caller paid a shell turn to
   * re-establish what the walk already knew.
   *
   * The certificate is deliberately narrow: it certifies only what was
   * SCANNED. It is withheld whenever the scan could be partial — a truncated
   * response, a scope that scanned nothing (e.g. a `.tokenlightenignore`d
   * `path`), or an uncompilable regex that never read a byte — because a
   * partial scan that certifies absence is worse than no certificate at all.
   * Whatever WAS excluded is disclosed in `caveat` (and machine-readably in
   * `omitted`), so the claim's boundary is always visible.
   */
  absence?: FindAbsence;
  /** L1 (2026-07-30 T11 forensics): present when `query` resolves to a unique class/interface definition with >=2 members — see memberSweep.ts. Attached by server.ts's find dispatch (post-buildFindResponse), not by this function. */
  member_sweep?: MemberSweepAttachment;
  /** S9 (2026-08-07 native-IO-escape wave): optional, non-required companion calls for the SAME identifier's own definition (search_files action=symbols) and call sites (action=references) — see relatedLookups.ts. Present only for a literal (non-regex) exact single-identifier hit; never on absence, a naming-variant match, or a tokenized fallback. Unlike next_call elsewhere in this server, neither entry is a required continuation. Attached by server.ts's find dispatch (post-buildFindResponse), not by this function. */
  related_lookups?: RelatedLookups;
}

/**
 * A negative result the caller can act on without re-establishing it by
 * shelling out. Bytes stay tiny by construction: counts and one sentence,
 * never a file list (`total_files`/`omitted` already carry the numbers).
 */
export interface FindAbsence {
  /**
   * Files whose CONTENT was read and line-matched for this query — NOT the
   * walk's candidate count and NOT `total_files` (which counts MATCHED files,
   * i.e. 0 on every response carrying this object). This is the population
   * the conclusion below is true over.
   */
  scanned_files: number;
  /** The exact token(s) whose absence is certified. */
  tokens: string[];
  /** Plain-language negative fact, scoped to what was actually scanned. */
  conclusion: string;
  /**
   * Present only when some paths were NOT scanned (ignore layers, oversize,
   * unfollowed symlinks, unreadable files) — names the counts and how to
   * include them, so absence is never mistaken for a whole-repo claim.
   */
  caveat?: string;
}

/** One matched file's hit count in a truncated response's exhaustive inventory. */
export interface FindInventoryFileEntry {
  path: string;
  /** True total match count for this file — never capped, even when `files[]` only shows a foothold. */
  matches: number;
}

/** Per-directory rollup entry, used instead of `FindInventoryFileEntry[]` when the per-file list would itself be large (see `inventory_complete: "by-directory"`). */
export interface FindInventoryDirEntry {
  dir: string;
  /** Distinct matched files under this directory. */
  files: number;
  /** Total matches summed across every matched file under this directory. */
  matches: number;
}

/**
 * Group matches by file, de-duplicating (path, line) pairs — required for
 * the tokenized fallback, where the SAME line can independently match
 * multiple search terms (e.g. a line containing both "priority" and
 * "status" would otherwise be counted twice). Lines within a file are
 * sorted ascending for readability; snippets stay aligned with lines.
 *
 * Policy: every distinct (path, line) match survives — there is no
 * identical-snippet-text collapse. An earlier version (C6.3) additionally
 * dropped later lines within a file whose trimmed snippet TEXT matched an
 * earlier line's (e.g. repeated `priority: "high",` lines across an
 * exhaustive multi-site edit target). That silently withheld real
 * occurrences' line numbers with no truncation indicator, which directly
 * harms exhaustive multi-site edit tasks — a caller relying on `lines`
 * to enumerate every site to change would miss the collapsed ones. Removed
 * in favor of full correctness; size is bounded by the existing
 * fitFilesToCap byte-cap machinery (which DOES mark `truncated` when it
 * drops anything), not by pretending duplicates don't exist.
 */
export function groupByFile(matches: TextMatch[]): FindFileGroup[] {
  interface Entry { line: number; text?: string }
  const byPath = new Map<string, Map<number, Entry>>();
  for (const m of matches) {
    let byLine = byPath.get(m.path);
    if (!byLine) {
      byLine = new Map();
      byPath.set(m.path, byLine);
    }
    if (!byLine.has(m.line)) {
      byLine.set(m.line, { line: m.line, text: m.text });
    }
  }
  const groups: FindFileGroup[] = [];
  for (const [p, byLine] of byPath) {
    const entries = [...byLine.values()].sort((a, b) => a.line - b.line);
    const hasAnyText = entries.some((e) => e.text !== undefined);
    groups.push({
      path: p,
      lines: entries.map((e) => e.line),
      ...(hasAnyText ? { snippets: entries.map((e) => e.text ?? "") } : {}),
    });
  }
  // Byte-stable order: path ascending.
  return groups.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

const EDIT_CONTEXT_MAX_CLUSTER_SPAN = 40;
const EDIT_CONTEXT_PADDING = 4;
const EDIT_CONTEXT_MAX_CHARS = 1600;
const EDIT_CONTEXT_MAX_FILE_BYTES = 512 * 1024;

interface EditContextCandidate {
  group: FindFileGroup;
  codeLines: number[];
  cluster: number[];
  content: string;
}

function isLikelyImplementationPath(relPath: string): boolean {
  if (/(?:^|\/)(?:__tests__|tests?|specs?)(?:\/|$)/i.test(relPath)) return false;
  return languageForPath(relPath) !== undefined
    && !/\.(?:md|markdown|json|ya?ml|toml|ini|cfg|conf|csv|log|txt|rst)$/i.test(relPath);
}

function densestLineCluster(lines: number[]): number[] {
  let best: number[] = [];
  for (let start = 0; start < lines.length; start++) {
    const cluster = lines.slice(start).filter((line) => line - lines[start]! <= EDIT_CONTEXT_MAX_CLUSTER_SPAN);
    if (cluster.length > best.length) best = cluster;
  }
  return best;
}

/**
 * Promote one uniquely dominant repeated code-hit file and bundle the exact
 * surrounding source. This spends bytes only when it can replace a follow-up
 * locate/read; broad/evenly distributed searches retain the all-file foothold
 * behavior unchanged.
 */
export function attachDominantEditContext(
  groups: FindFileGroup[],
  workspace: string,
): FindFileGroup[] {
  const candidates: EditContextCandidate[] = [];
  for (const group of groups) {
    if (group.lines.length < 2 || !isLikelyImplementationPath(group.path)) continue;
    const abs = path.join(workspace, group.path);
    let content: string;
    try {
      if (fs.statSync(abs).size > EDIT_CONTEXT_MAX_FILE_BYTES) continue;
      content = fs.readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    const flags = classifyCommentLines(content, languageForPath(group.path) ?? "default");
    const codeLines = group.lines.filter((line) => !flags[line - 1]);
    const cluster = densestLineCluster(codeLines);
    if (cluster.length < 2) continue;
    candidates.push({ group, codeLines, cluster, content });
  }
  candidates.sort((a, b) =>
    b.cluster.length - a.cluster.length
    || b.group.lines.length - a.group.lines.length
    || a.group.path.localeCompare(b.group.path)
  );
  const top = candidates[0];
  if (!top) return groups;
  const runnerUp = candidates[1];
  const uniquelyDominant = !runnerUp
    || top.cluster.length > runnerUp.cluster.length
    || top.group.lines.length >= runnerUp.group.lines.length + 3;
  if (!uniquelyDominant) return groups;

  const sourceLines = top.content.split(/\r?\n/);
  const start = Math.max(1, top.cluster[0]! - EDIT_CONTEXT_PADDING);
  const end = Math.min(sourceLines.length, top.cluster.at(-1)! + EDIT_CONTEXT_PADDING);
  let context = sourceLines.slice(start - 1, end).join("\n");
  if (context.length > EDIT_CONTEXT_MAX_CHARS) {
    context = context.slice(0, EDIT_CONTEXT_MAX_CHARS - 1) + "…";
  }
  const range = `${start}-${end}`;
  const handle = handleTable.upsert({
    kind: "range",
    path: top.group.path,
    range,
    workspaceRoot: workspace,
  }).id;
  const promoted: FindFileGroup = {
    ...top.group,
    match_count: top.group.lines.length,
    range,
    handle,
    context,
  };
  return [promoted, ...groups.filter((group) => group.path !== top.group.path)];
}

/**
 * L3(b) (2026-08-08 find-honesty) — the repeated-hit hint, gated on whether
 * the file it names could be an edit target at all.
 *
 * THE MEASURED DEFECT. attachDominantEditContext promotes whichever file holds
 * the densest cluster of hits and the hint used to say, unconditionally, "edit
 * this handle without another locate/read". Across all three T05c reps of run
 * 2026-08-08-semantic-signal5-1 that hint fired 5 times and named a file that
 * was actually edited 0/5 times (rep2: drv_motor_pwm.c, scheduler.c; rep0:
 * position_controller.cpp, pid.cpp; rep1: vehicle_state.cpp — the real edits
 * were always mixer.cpp / rate_controller.cpp / mode_manager.cpp). "Densest
 * hit cluster" is a good answer to "where does this token live" and a bad one
 * to "what should I change": a false edit lead pulls a solver toward a file
 * the certificate frontier would refuse to write anyway.
 *
 * The promotion itself — bundled exact source, range, handle — is UNCHANGED
 * and still spends its bytes to replace a follow-up read. Only the verb
 * changes: an admissible target keeps the edit wording, anything else is
 * described honestly as context to read from here. Note that find never
 * enrolls anything in the admissible union (the enrollment sites are the task
 * pack and a successful create), so this predicate cannot be satisfied by the
 * very call it gates.
 */
function repeatedHitHint(workspace: string, candidate: FindFileGroup): string {
  const where = `${candidate.path} ${candidate.range} handle=${candidate.handle}`;
  return isPlausibleEditTarget(workspace, candidate.path)
    ? `edit-grade repeated-hit candidate: ${where}; if the bundled context matches the symptom, edit this handle without another locate/read`
    : `repeated-hit cluster: ${where}; exact source bundled below — read it from here instead of another locate. Not in this session's admissible edit set, so it is context, not an established edit target`;
}

/**
 * F2 (2026-08-01 find-diet): per-file cap on how many matched lines/snippets
 * a SINGLE file entry shows, applied before any response-wide byte fitting.
 *
 * MOTIVATION (bench forensics, T09): `search_files action=find
 * query="case IssuePriority.URGENT"` measured a 13.5 KB result, and a
 * 5-identifier OR query measured 12.5 KB, against native-grep equivalents
 * of 79-930 bytes. Without this cap, a single pathologically wide match (one
 * file matching hundreds of times) could alone consume the ENTIRE
 * per-response byte budget in fitFilesToCap's widen pass below — starving
 * every sibling file's own foothold — and the trial JSON that widen pass
 * builds to even MEASURE that byte count scaled with total matches in the
 * file. Capping every file's OWN preview up front bounds both. Nothing is
 * lost: the true count survives as `more_lines` on the same file entry (see
 * FindFileGroup), and `total_matches`/`total_files` (attachInventory) are
 * always computed from the caller's UNCAPPED grouped set, never from this
 * capped preview. 8 keeps enough of a multi-line preview to see a repeated
 * pattern while bounding the worst case.
 */
export const MAX_LINES_PER_FILE = 8;

/**
 * Truncate one file's `lines`/`snippets` to MAX_LINES_PER_FILE; a no-op
 * below that. Deliberately does NOT set `more_lines` — fitFilesToCap's
 * `finalize` (below) is the single place that computes it, against
 * whatever the response ultimately shows, so it can never go stale as
 * `lines` is trimmed further downstream (footholds, drop-from-tail).
 */
function capFileGroup(group: FindFileGroup): FindFileGroup {
  if (group.lines.length <= MAX_LINES_PER_FILE) return group;
  const capped: FindFileGroup = { ...group, lines: group.lines.slice(0, MAX_LINES_PER_FILE) };
  if (group.snippets) capped.snippets = group.snippets.slice(0, MAX_LINES_PER_FILE);
  return capped;
}

function capWideFiles(groups: FindFileGroup[]): FindFileGroup[] {
  return groups.map(capFileGroup);
}

/**
 * F3 (2026-08-01 find-diet): soft response-level byte target for files[],
 * checked against the NATURAL rendering — every matched file at its own
 * (MAX_LINES_PER_FILE-capped) preview, before any cross-file byte fitting.
 * At or under this, fitFilesToCap's normal two-pass fit (footholds, then
 * widen back toward each file's own cap using the shared MAX_RESPONSE_BYTES
 * budget) runs exactly as before. Over it, footholds and the normal widened
 * fit are both measured and the smaller is served (see the widen-pass
 * comment below for why it still runs either way) — usually the
 * single-line-plus-single-snippet foothold, the same "per-file path +
 * 1 snippet" shape the inventory rendering already documents for truncated
 * responses (see INVENTORY_NOTE below) — since that extra per-file richness
 * would only be made redundant by the always-attached `inventory`
 * (attachInventory, below) once it's spliced on anyway.
 * Deliberately larger than MAX_RESPONSE_BYTES (4096) so it actually changes
 * behavior for many-file responses that would otherwise spend the whole
 * snippet budget before `inventory` is even attached — see
 * MAX_LINES_PER_FILE's doc comment above for the bench forensics this
 * responds to. Nothing is lost either way: file-level recall and exact
 * counts are untouched (total_files/total_matches) — only per-file snippet
 * verbosity is reduced, the same "truncated:true" contract "snippets may
 * truncate; the inventory never lies" already documents.
 */
export const SOFT_DEGRADE_BYTES = 6 * 1024;

/**
 * Trim a grouped file list to fit `maxBytes`, guaranteeing every matched FILE
 * appears at least once (with 1 line) before any file's line-list is
 * truncated further, and before any file is dropped entirely. This is what
 * prevents 2 KB truncation from hiding whole directories (dive_committed-TL
 * Q2): every file gets a foothold first, then remaining budget goes to
 * widening per-file line lists in original (file, first-hit) order.
 *
 * F2/F3 (2026-08-01 find-diet): `files` (the caller's full, uncapped grouped
 * set) is never mutated or shrunk in place — `finalize` below always
 * measures the true per-file count against it, so `more_lines` is accurate
 * on every return path, including the pre-existing drop/trim fallbacks.
 * Bounding the widen loop's own ceiling to MAX_LINES_PER_FILE (via `capped`)
 * also bounds its worst-case iteration count (previously up to the widest
 * file's own match count; now at most MAX_LINES_PER_FILE).
 */
function fitFilesToCap(
  files: FindFileGroup[],
  build: (fs: FindFileGroup[]) => unknown,
  maxBytes: number,
): { files: FindFileGroup[]; truncated: boolean } {
  if (files.length === 0) return { files, truncated: false };

  const trueLineCount = new Map(files.map((f) => [f.path, f.lines.length]));
  // Single source of truth for `more_lines`: recomputed fresh from CURRENT
  // shown-line counts every time, never carried/accumulated on the working
  // arrays below — so it is always accurate, on every return path.
  const finalize = (shown: FindFileGroup[]): FindFileGroup[] =>
    shown.map((f) => {
      const remaining = (trueLineCount.get(f.path) ?? f.lines.length) - f.lines.length;
      return remaining > 0 ? { ...f, more_lines: remaining } : f;
    });
  // Deliberately NOT finalize()-wrapped: every fit/drop DECISION below must
  // measure the exact same bytes as if `more_lines` did not exist, so which
  // files get dropped/widened is unchanged by adding it. `more_lines` is
  // cosmetic on the RETURNED files only (finalize() is applied once at each
  // return below) — never a factor in reaching that decision, otherwise the
  // field meant to DISCLOSE truncation would itself cause MORE files to be
  // dropped than before it existed.
  const bytesOf = (fs: FindFileGroup[]): number => Buffer.byteLength(JSON.stringify(build(fs)), "utf8");

  // F2: per-file cap FIRST — bounds a single wide file's contribution (and
  // the cost of measuring it) before any response-wide fitting runs.
  const capped = capWideFiles(files);

  // Pass 1: one line per file (foothold for every matched file).
  let footholds: FindFileGroup[] = capped.map((f) => ({
    ...f,
    lines: f.lines.slice(0, 1),
    ...(f.snippets ? { snippets: f.snippets.slice(0, 1) } : {}),
  }));
  // Only true when the cap actually forced a drop/trim below — NOT merely
  // because some file has >1 total matched line (that's resolved by the
  // Pass 2 widen loop below and must not poison the final flag).
  let filesDroppedOrTrimmed = false;

  // If even the footholds don't fit, drop whole files from the tail (kept
  // deterministic: alphabetical order already applied by groupByFile).
  while (footholds.length > 1 && bytesOf(footholds) > maxBytes) {
    footholds = footholds.slice(0, -1);
    filesDroppedOrTrimmed = true;
  }
  if (bytesOf(footholds) > maxBytes) {
    // Single file still over cap on its own — trim its lines/snippets.
    const only = footholds[0];
    if (only) {
      while (
        (only.lines.length > 0 || (only.snippets && only.snippets.length > 0)) &&
        bytesOf([only]) > maxBytes
      ) {
        only.lines = only.lines.slice(0, -1);
        if (only.snippets) only.snippets = only.snippets.slice(0, -1);
      }
    }
    return { files: finalize(footholds), truncated: true };
  }

  // F3 signal: is the natural (F2-capped) rendering large enough that the
  // widen pass below is likely spending bytes on per-file richness that
  // `inventory` (attachInventory, elsewhere in this file) makes redundant
  // once it's spliced on? See SOFT_DEGRADE_BYTES doc comment above. Checked
  // once, up front — the ACTUAL choice happens after Pass 2 runs (below):
  // F3 must never make a response bigger than a plain foothold-per-file
  // listing would have needed, so both candidates are measured and the
  // smaller one wins, never the footholds one unconditionally.
  const softDegradeSignal = bytesOf(capped) > SOFT_DEGRADE_BYTES;

  // Pass 2: widen footholds back toward full (F2-capped) per-file line
  // lists, in file order, spending remaining budget round-robin so no
  // single huge file starves the others' second/third hits. Bounded to at
  // most MAX_LINES_PER_FILE rounds by `capped`'s own ceiling (previously
  // unbounded — up to the widest file's own match count), so running this
  // unconditionally — even when softDegradeSignal is true, to have a real
  // comparison point below — stays cheap.
  const widened = footholds.map((f) => ({ ...f, lines: [...f.lines], snippets: f.snippets ? [...f.snippets] : undefined }));
  const fullByPath = new Map(capped.map((f) => [f.path, f]));
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const w of widened) {
      const full = fullByPath.get(w.path);
      if (!full) continue;
      if (w.lines.length >= full.lines.length) continue;
      const nextIdx = w.lines.length;
      const candidateLines = [...w.lines, full.lines[nextIdx]!];
      const candidateSnippets = full.snippets ? [...(w.snippets ?? []), full.snippets[nextIdx]!] : undefined;
      const candidate: FindFileGroup = { ...w, lines: candidateLines, ...(candidateSnippets ? { snippets: candidateSnippets } : {}) };
      const trialFiles = widened.map((x) => (x.path === w.path ? candidate : x));
      if (bytesOf(trialFiles) <= maxBytes) {
        w.lines = candidateLines;
        if (candidateSnippets) w.snippets = candidateSnippets;
        progressed = true;
      }
    }
  }

  const stillTruncated =
    filesDroppedOrTrimmed ||
    widened.some((w) => (trueLineCount.get(w.path) ?? w.lines.length) > w.lines.length);

  if (softDegradeSignal) {
    // Compare the two FINALIZED (more_lines-included) candidates for real —
    // never assume footholds is smaller just because it shows less.
    const footholdsFinal = finalize(footholds);
    const widenedFinal = finalize(widened);
    const footholdsBytes = Buffer.byteLength(JSON.stringify(build(footholdsFinal)), "utf8");
    const widenedBytes = Buffer.byteLength(JSON.stringify(build(widenedFinal)), "utf8");
    if (footholdsBytes <= widenedBytes) {
      return { files: footholdsFinal, truncated: true };
    }
    return { files: widenedFinal, truncated: stillTruncated };
  }

  return { files: finalize(widened), truncated: stillTruncated };
}

// ---------------------------------------------------------------------------
// "snippets may truncate; the inventory never lies" — complete match
// inventory attached to a truncated response.
//
// MOTIVATION (bench forensics): explore action=find responses were hard
// capped at MAX_RESPONSE_BYTES with no exhaustive fallback, so a search for a
// widely-used identifier returned `truncated:true` with no way to tell
// whether more FILES existed beyond the ones shown. Agents could not trust
// the response as an exhaustive usage map and issued many narrow follow-up
// searches (observed: 12+ extra searches in one session) where a competitor
// tool answered "N matches across M files" in one call. `total_files`/
// `total_matches` are now ALWAYS computed from the full, pre-cap match set
// (attachInventory below is the single place that recomputes them for every
// buildFindResponse()/buildFindResponseForQueries() return path), and a
// truncated response always carries a complete `inventory` on top — a
// per-file listing, or a per-directory rollup when the per-file list itself
// would be large (see attachInventory's doc comment).
// ---------------------------------------------------------------------------

function buildFileInventory(groups: FindFileGroup[]): FindInventoryFileEntry[] {
  return groups
    .map((g) => ({ path: g.path, matches: g.lines.length }))
    .sort((a, b) => b.matches - a.matches || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** Workspace-relative parent directory of `relPath` ("." for a root-level file). */
function dirOfPath(relPath: string): string {
  const idx = relPath.lastIndexOf("/");
  return idx === -1 ? "." : relPath.slice(0, idx);
}

function buildDirectoryRollup(groups: FindFileGroup[]): FindInventoryDirEntry[] {
  const byDir = new Map<string, { files: number; matches: number }>();
  for (const g of groups) {
    const dir = dirOfPath(g.path);
    const entry = byDir.get(dir) ?? { files: 0, matches: 0 };
    entry.files += 1;
    entry.matches += g.lines.length;
    byDir.set(dir, entry);
  }
  return [...byDir.entries()]
    .map(([dir, v]) => ({ dir, files: v.files, matches: v.matches }))
    .sort((a, b) => b.matches - a.matches || (a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0));
}

const INVENTORY_NOTE =
  "inventory[] plus total_files/total_matches are exhaustive (100% of matches); only the per-file snippets in files[] were capped — re-searching this exact query will not surface additional files";

const INVENTORY_NOTE_WITH_OMITTED =
  "inventory[] plus total_files/total_matches are exhaustive over every SCANNED file; paths counted in `omitted` were excluded from scanning (ignore rules / oversize) — re-scope directly at them to include them; only the per-file snippets in files[] were capped";

const ABSENCE_NOTE =
  "absence is authoritative over every scanned file — re-running this query, or a shell grep for the same token, will not surface a hit";

/** Tokens actually certified: first-occurrence order, case-insensitively deduped, bounded. */
const ABSENCE_MAX_TOKENS = 12;

function dedupeAbsenceTokens(tokens: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of tokens) {
    const trimmed = t.trim();
    if (trimmed.length === 0) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
    if (out.length >= ABSENCE_MAX_TOKENS) break;
  }
  return out;
}

/**
 * Builds the zero-match absence certificate (see `FindAbsence`) as a spreadable
 * response fragment, or `{}` when absence CANNOT be honestly certified.
 *
 * Refusal is the point of this function, so every gate lives here rather than
 * at the five zero-match return sites:
 *   - nothing content-scanned (empty query/queries — no walk ran at all; a
 *     scope excluded by `.tokenlightenignore`; an uncompilable regex that
 *     returned before reading a byte) -> no certificate. "I read nothing"
 *     must never render as "it isn't there".
 *   - no token survived (`tokens` empty after dedupe, or the tokenized pass's
 *     term budget dropped every one of the caller's own tokens) -> nothing to
 *     certify.
 * Callers additionally only reach it on paths where `total_matches` is 0 and
 * `truncated` is false; `attachInventory` (the match-bearing path) never calls
 * it, so a truncated or non-empty response can never carry `absence`.
 */
function buildAbsenceExtra(args: {
  /** The caller's own token(s), in the form they were scanned. */
  tokens: readonly string[];
  coverage: ScanCoverage;
  omissions: WalkOmissions;
  /** `input.path`, when the caller narrowed the scan — named in the conclusion. */
  subPath?: string;
  /** Regex queries certify a pattern, not a token. */
  regex?: boolean;
  /** True when the scan could not have seen a differently-cased occurrence. */
  caseSensitive: boolean;
}): Record<string, unknown> {
  const scanned_files = args.coverage.scanned.size;
  if (scanned_files === 0) return {};
  const tokens = dedupeAbsenceTokens(args.tokens);
  if (tokens.length === 0) return {};

  const scope = args.subPath ? `under '${args.subPath}'` : "under the scanned root";
  const subject = args.regex
    ? "matches this pattern"
    : tokens.length > 1
      ? "references any of these tokens"
      : "references this token";
  const conclusion = `no file ${scope} ${subject}${args.caseSensitive ? " (case-sensitive scan)" : ""}`;

  // Every skip class that could hide an occurrence, named by the rule the
  // caller can act on — same honesty contract as `omitted`, plus the files
  // the walk offered but whose bytes could not be read.
  const parts: string[] = [];
  let excluded = 0;
  for (const key of ["ignored", "gitignored", "tokenlighten_ignored", "oversize", "symlinks", "non_text", "secrets"] as const) {
    const n = args.omissions[key];
    if (n > 0) {
      parts.push(`${key}: ${n}`);
      excluded += n;
    }
  }
  const unreadable = args.coverage.unscanned.size;
  if (unreadable > 0) {
    parts.push(`unreadable: ${unreadable}`);
    excluded += unreadable;
  }

  const absence: FindAbsence = {
    scanned_files,
    tokens,
    conclusion,
    ...(parts.length > 0
      ? {
          caveat: `${excluded} ${excluded === 1 ? "path" : "paths"} were excluded from the scan (${parts.join(", ")}); absence covers only the ${scanned_files} scanned ${scanned_files === 1 ? "file" : "files"} — scope find directly at an excluded path to include it`,
        }
      : {}),
  };
  return { absence, note: ABSENCE_NOTE };
}

function buildOmittedExtra(om: WalkOmissions): Record<string, unknown> {
  if (!anyWalkOmission(om)) return {};
  const pruned: Partial<WalkOmissions> = {};
  for (const key of ["ignored", "gitignored", "tokenlighten_ignored", "oversize", "symlinks", "non_text", "secrets"] as const) {
    if (om[key] > 0) pruned[key] = om[key];
  }
  return { omitted: pruned };
}

/**
 * Drop trailing (lowest-priority, since callers pass matches-desc-sorted
 * arrays) entries from `items` one at a time until `build(items)` fits
 * `maxBytes`. Absolute last-resort defensive trim — see attachInventory's
 * doc comment for why this is expected to be unreachable on any realistic
 * repo, but guarantees MAX_INVENTORY_RESPONSE_BYTES is never crossed
 * regardless of how many distinct paths/directories a pathological match
 * set spans.
 */
function shrinkArrayToFit<T, R>(items: T[], build: (items: T[]) => R, maxBytes: number): R {
  let arr = items;
  let out = build(arr);
  while (arr.length > 1 && Buffer.byteLength(JSON.stringify(out), "utf8") > maxBytes) {
    arr = arr.slice(0, -1);
    out = build(arr);
  }
  return out;
}

/**
 * Attaches the "inventory never lies" fields to an already cap-fitted
 * response. `response` is the result of `buildWithExtra(roledFiles)` — the
 * EXISTING fitFilesToCap/applyRoles pipeline, unchanged, still targeting
 * MAX_RESPONSE_BYTES for the snippet section. `fullGroups` is the pre-cap
 * grouped match set (before fitFilesToCap ever trims anything) — the single
 * source of truth this function recomputes `total_files`/`total_matches`
 * from, REGARDLESS of `snippetTruncated`, so those two fields are always
 * accurate even when `response.files` itself is trimmed.
 *
 * When `snippetTruncated` is false, `files[]` already shows every match —
 * `inventory` would be redundant (spec: do not bloat the common case), so
 * only the cheap `inventory_complete:true` marker is added.
 *
 * When `snippetTruncated` is true, a complete `inventory` is attached: a
 * per-file listing (matches desc, then path asc) normally, collapsing to a
 * per-directory rollup once the per-file list would itself be large
 * (>INVENTORY_ROLLUP_FILE_THRESHOLD files, or >INVENTORY_ROLLUP_BYTES_THRESHOLD
 * bytes of JSON) — either way covering 100% of matches. This splice happens
 * AFTER fitFilesToCap/applyRoles have already fitted `files[]` to
 * MAX_RESPONSE_BYTES (it never feeds back into that fitting decision) and is
 * itself bounded to MAX_INVENTORY_RESPONSE_BYTES independently, with a final
 * defensive trim (shrinkArrayToFit) so the ~24 KiB ceiling is an absolute
 * guarantee, not a best-effort one.
 */
function attachInventory(
  response: FindResponse,
  fullGroups: FindFileGroup[],
  snippetTruncated: boolean,
  omissionsPresent = false,
): FindResponse {
  const total_files = fullGroups.length;
  const total_matches = fullGroups.reduce((n, g) => n + g.lines.length, 0);
  const withTotals: FindResponse = { ...response, total_files, total_matches, truncated: snippetTruncated };

  if (!snippetTruncated || fullGroups.length === 0) {
    return { ...withTotals, inventory_complete: true };
  }

  const note = omissionsPresent ? INVENTORY_NOTE_WITH_OMITTED : INVENTORY_NOTE;
  const fileInventory = buildFileInventory(fullGroups);
  const fileInventoryBytes = Buffer.byteLength(JSON.stringify(fileInventory), "utf8");
  const useRollup =
    fullGroups.length > INVENTORY_ROLLUP_FILE_THRESHOLD || fileInventoryBytes > INVENTORY_ROLLUP_BYTES_THRESHOLD;

  if (useRollup) {
    const rollup = buildDirectoryRollup(fullGroups);
    return shrinkArrayToFit(
      rollup,
      (items): FindResponse => ({ ...withTotals, inventory: items, inventory_complete: "by-directory", note }),
      MAX_INVENTORY_RESPONSE_BYTES,
    );
  }

  return shrinkArrayToFit(
    fileInventory,
    (items): FindResponse => ({ ...withTotals, inventory: items, inventory_complete: true, note }),
    MAX_INVENTORY_RESPONSE_BYTES,
  );
}

// ---------------------------------------------------------------------------
// Role annotations — one-line "primary symbol + purpose" per file hit.
//
// MOTIVATION (2026-07-09c bench run): agents working from compressed TL
// context ran explore action=find on a short method-name query against a
// C++ firmware fixture and got bare hits in three sibling implementation
// files — equally unlabeled — and twice anchored on the wrong file (a
// secondary module's same-named flag) instead of the task's real target (the
// central module the query was about). A one-line `role` per file lets significance
// survive compression without a full-file read.
//
// Derivation is intentionally cheap and language-agnostic, reusing EXISTING
// facilities only (no new parser):
//   (a) regexFallback.ts's regexSignatureLines() — the same per-language
//       declaration-line regex table getFileSkeleton()'s AST-fallback path
//       already uses — surfaces class/struct/interface/enum/trait and plain
//       top-level function declarations. For C++ specifically it is
//       supplemented with ONE small, targeted pattern for out-of-line
//       qualified member DEFINITIONS (`ReturnType Class::method(...) {`),
//       because regexSignatureLines' own cpp pattern cannot recognize that
//       shape (verified: its trailing `\w+` cannot span a `::` qualifier) —
//       and that shape is nearly the ONLY content of a firmware .cpp file
//       whose class lives in the paired .hpp (exactly the live fixture's
//       paired header/impl shape). A qualified `Class::method` is treated as evidence of
//       `class Class`.
//   (b) the first substantive line of a comment block directly above the
//       chosen declaration (Javadoc/`///`/`//`/`#` styles all handled by
//       stripping markers, not parsing them); when the primary symbol was
//       DERIVED from a qualifier (its literal declaration is not in this
//       file — the .cpp-implements-.hpp case), falls back to the file's own
//       leading header comment, which is the common C/C++ convention for
//       "what this file implements" and is what actually carries the useful
//       description in that case.
//   (c) markdown: first `#` heading, no symbol concept involved.
//   (d) anything else -> role is omitted entirely, never filler.
// ---------------------------------------------------------------------------

/** Annotate at most this many files per result. */
const ROLE_MAX_ANNOTATED_FILES = 5;

/**
 * Consider up to this many leading files as CANDIDATES for the
 * ROLE_MAX_ANNOTATED_FILES slots (still bounded — not "all files"). Wider
 * than the annotation budget itself so that when several files in the
 * window resolve to the SAME primary symbol (a class's .hpp declaration
 * sitting right next to its .cpp out-of-line definitions — the paired-file
 * shape: header+impl pairs sort adjacent-ish but the doc-rich impl file can
 * land just past position 5), the budget is spent on DISTINCT symbols
 * instead of repeating one. Without this, a doc-rich qualifier-derived role
 * (see module doc comment) could never win a slot over its bare
 * declaration-only sibling merely because the sibling's path sorts first.
 */
const ROLE_CONSIDER_WINDOW = 20;

/** "kind" prefixes deriveCodeRole() actually produces — used to recognize a
 * role's "kind Name[ — doc]" shape when extracting a dedup key from it. */
const ROLE_KIND_WORDS = new Set(["class", "struct", "interface", "enum", "trait", "function"]);

/** Hard cap on a single role string's length. */
const ROLE_MAX_CHARS = 72;

/** Bound on how much of a file is read FRESH to derive a role. Cheap even
 * though scanLiteral already reads whole files to find matches — role
 * derivation must stay bounded independent of that. */
const ROLE_READ_CAP_BYTES = 16 * 1024;

/** Files over this size skip role derivation entirely (not worth even a bounded read). */
const ROLE_SKIP_FILE_OVER_BYTES = 1_000_000;

/** JSX/TSX declaration syntax is a superset of its non-X counterpart for our
 * purposes; reuse the same pattern table entry rather than leaving them
 * unsupported (regexFallback.ts's LANG_PATTERNS has no *react entries). */
const ROLE_PATTERN_LANG_ALIAS: Record<string, string> = {
  typescriptreact: "typescript",
  javascriptreact: "javascript",
};

/** See module doc comment above — the one supplemental, targeted pattern
 * regexSignatureLines' own cpp table cannot express. cpp-only. */
const CPP_QUALIFIED_MEMBER_RE = /\b([A-Za-z_]\w*)::(?:~)?[A-Za-z_]\w*\s*\(/;

/** Common declaration-line modifiers/keywords to exclude when picking "the
 * name" as the last identifier before a function's '(' — without this,
 * e.g. Go's "func (s *Store) Flush()" would extract "func". */
const ROLE_FN_NAME_STOPWORDS = new Set([
  "public", "private", "protected", "internal", "static", "abstract", "final",
  "sealed", "virtual", "override", "synchronized", "native", "strictfp",
  "async", "function", "def", "func", "fn", "void", "const", "let", "var",
  "export", "default", "explicit", "constexpr", "inline", "friend", "unsafe",
  "partial", "extern", "noexcept", "mutable", "volatile", "register",
  "typename", "template", "class", "struct", "interface", "enum", "trait",
  "namespace", "using", "return",
]);

function truncateRole(s: string): string {
  if (s.length <= ROLE_MAX_CHARS) return s;
  return s.slice(0, ROLE_MAX_CHARS - 1).trimEnd() + "…";
}

function leadingWhitespaceLen(line: string): number {
  return /^[ \t]*/.exec(line)?.[0].length ?? 0;
}

function normalizeIdent(s: string): string {
  return s.replace(/[_-]/g, "").toLowerCase();
}

function fileStemNormalized(relPath: string): string {
  const base = relPath.slice(relPath.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return normalizeIdent(dot > 0 ? base.slice(0, dot) : base);
}

/**
 * Recover each regexSignatureLines() match's original 0-based line index by
 * a two-pointer merge against the same right-trimmed split it filtered —
 * regexSignatureLines only returns matched TEXT (in file order), not
 * indices, and re-implementing its own filter here would risk duplicating
 * (and drifting from) its pattern table instead of reusing it as-is.
 */
function locateMatchedLines(lines: string[], matched: string[]): number[] {
  const indices: number[] = [];
  let li = 0;
  for (const m of matched) {
    while (li < lines.length && lines[li]!.replace(/\s+$/, "") !== m) li++;
    if (li >= lines.length) break;
    indices.push(li);
    li++;
  }
  return indices;
}

interface RoleCandidate {
  lineIdx: number;
  name: string;
  kind: "class" | "function";
  kindWord: string;
  /** True when `name` was derived from a `Class::method` qualifier rather
   * than a literal class/struct/... keyword found on this line. */
  viaQualifier: boolean;
}

const ENUM_CLASS_RE = /\benum\s+class\s+([A-Za-z_]\w*)/;
const CLASS_KEYWORD_RE = /\b(class|struct|interface|enum|trait)\s+([A-Za-z_]\w*)/;

/** Parse a single already-matched declaration line into a name/kind candidate. */
function parseCandidateLine(line: string): { name: string; kind: "class" | "function"; kindWord: string } | null {
  const enumClass = ENUM_CLASS_RE.exec(line);
  if (enumClass) return { name: enumClass[1]!, kind: "class", kindWord: "enum" };

  const classKw = CLASS_KEYWORD_RE.exec(line);
  if (classKw) return { name: classKw[2]!, kind: "class", kindWord: classKw[1]! };

  const parenIdx = line.indexOf("(");
  if (parenIdx === -1) return null;
  const idents = line.slice(0, parenIdx).match(/[A-Za-z_]\w*/g) ?? [];
  const filtered = idents.filter((t) => !ROLE_FN_NAME_STOPWORDS.has(t));
  if (filtered.length === 0) return null;
  return { name: filtered[filtered.length - 1]!, kind: "function", kindWord: "function" };
}

function isCommentLine(trimmed: string): boolean {
  return (
    trimmed.startsWith("//") ||
    trimmed.startsWith("#") ||
    trimmed.startsWith("/*") ||
    trimmed.startsWith("*") ||
    trimmed.endsWith("*/")
  );
}

function stripCommentMarkers(trimmed: string): string {
  return trimmed
    .replace(/^\/\*\*?/, "")
    .replace(/\*\/$/, "")
    .replace(/^\*/, "")
    .replace(/^\/\/\/?/, "")
    .replace(/^#/, "")
    .trim();
}

/** A stripped comment line with no letters/digits at all is a pure divider
 * (`----`, `====`) or blank marker — never a usable doc snippet. */
function isDividerOrEmpty(stripped: string): boolean {
  return stripped.length === 0 || !/[A-Za-z0-9]/.test(stripped);
}

function firstSubstantiveLine(commentLines: string[]): string | undefined {
  for (const raw of commentLines) {
    const stripped = stripCommentMarkers(raw.trim());
    if (!isDividerOrEmpty(stripped)) return stripped;
  }
  return undefined;
}

/** Contiguous comment run directly above `lineIdx` (0-based), top-to-bottom.
 * Stops at the first blank or non-comment line — a doc comment must be
 * adjacent, not merely somewhere earlier in the file. */
function commentBlockAbove(lines: string[], lineIdx: number): string[] {
  const collected: string[] = [];
  for (let i = lineIdx - 1; i >= 0; i--) {
    const trimmed = lines[i]!.trim();
    if (trimmed.length === 0 || !isCommentLine(trimmed)) break;
    collected.push(lines[i]!);
  }
  return collected.reverse();
}

/** The file's own leading comment block (from line 0 downward). This is the
 * fallback source for a qualifier-derived symbol (see module doc comment). */
function leadingCommentBlock(lines: string[]): string[] {
  const collected: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || !isCommentLine(trimmed)) break;
    collected.push(line);
  }
  return collected;
}

/** Drop a redundant "Name — " / "Name: " prefix so the doc snippet doesn't
 * repeat the symbol name already in the role's base ("kind Name — Name — ..."). */
function stripRedundantNamePrefix(text: string, name: string): string {
  const re = new RegExp(`^${escapeRegExp(name)}\\s*[-—:]\\s*`, "i");
  const out = text.replace(re, "").trim();
  return out.length > 0 ? out : text;
}

function deriveMarkdownRole(text: string): string | undefined {
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (m) {
      const heading = m[1]!.trim();
      if (heading.length > 0) return truncateRole(heading);
    }
  }
  return undefined;
}

function deriveCodeRole(text: string, relPath: string, patternLang: string, language: string): string | undefined {
  const lines = text.split(/\r?\n/);

  const matched = regexSignatureLines(text, patternLang);
  const baseIndices = locateMatchedLines(lines, matched);
  const seen = new Set(baseIndices);

  const qualifiedIndices = new Set<number>();
  if (language === "cpp") {
    for (let i = 0; i < lines.length; i++) {
      if (seen.has(i)) continue;
      if (CPP_QUALIFIED_MEMBER_RE.test(lines[i]!)) qualifiedIndices.add(i);
    }
  }

  const allIndices = [...baseIndices, ...qualifiedIndices].sort((a, b) => a - b);
  if (allIndices.length === 0) return undefined;

  const withIndent = allIndices.map((lineIdx) => ({
    lineIdx,
    text: lines[lineIdx]!,
    indent: leadingWhitespaceLen(lines[lineIdx]!),
  }));
  const minIndent = Math.min(...withIndent.map((c) => c.indent));
  const topLevel = withIndent.filter((c) => c.indent === minIndent);

  const parsed: RoleCandidate[] = [];
  for (const c of topLevel) {
    if (qualifiedIndices.has(c.lineIdx)) {
      const m = CPP_QUALIFIED_MEMBER_RE.exec(c.text);
      if (m) parsed.push({ lineIdx: c.lineIdx, name: m[1]!, kind: "class", kindWord: "class", viaQualifier: true });
      continue;
    }
    const p = parseCandidateLine(c.text);
    if (p) parsed.push({ lineIdx: c.lineIdx, viaQualifier: false, ...p });
  }
  if (parsed.length === 0) return undefined;

  // Priority: a class/struct/... whose name mirrors the file's own stem
  // (e.g. pump.cpp -> Pump) wins regardless of position — this is what picks
  // "class Pump" over an incidental earlier file-local helper AND over an
  // earlier, less-central struct (e.g. pump.hpp's PumpConfig comes before Pump
  // itself). Else first class-kind candidate; else first plain function.
  const stem = fileStemNormalized(relPath);
  const classCandidates = parsed.filter((c) => c.kind === "class");
  const chosen =
    classCandidates.find((c) => normalizeIdent(c.name) === stem) ??
    classCandidates[0] ??
    parsed.find((c) => c.kind === "function");
  if (!chosen) return undefined;

  const base = `${chosen.kindWord} ${chosen.name}`;
  const local = firstSubstantiveLine(commentBlockAbove(lines, chosen.lineIdx));
  const raw = local ?? (chosen.viaQualifier ? firstSubstantiveLine(leadingCommentBlock(lines)) : undefined);
  const doc = raw ? stripRedundantNamePrefix(raw, chosen.name) : undefined;
  return truncateRole(doc ? `${base} — ${doc}` : base);
}

/**
 * Pure text -> role deriver (no I/O) — exported so tests can exercise
 * derivation directly against a fixture's content without depending on the
 * byte-cap/top-5 policy that wraps it in applyRoles().
 */
export function deriveRoleFromText(text: string, relPath: string): string | undefined {
  const language = languageForPath(relPath);
  if (!language) return undefined;
  if (language === "markdown") return deriveMarkdownRole(text);
  const patternLang = ROLE_PATTERN_LANG_ALIAS[language] ?? language;
  return deriveCodeRole(text, relPath, patternLang, language);
}

/**
 * Bounded file read + role derivation for one file hit. Skips files over
 * ROLE_SKIP_FILE_OVER_BYTES entirely; reads at most ROLE_READ_CAP_BYTES of
 * larger files (a top-level symbol and its doc comment are overwhelmingly
 * near the top of a file, and this is a best-effort annotation, not a
 * correctness-critical read).
 */
export function deriveFileRole(workspace: string, relPath: string): string | undefined {
  const absPath = path.join(workspace, relPath);
  let size: number;
  try {
    size = fs.statSync(absPath).size;
  } catch {
    return undefined;
  }
  if (size > ROLE_SKIP_FILE_OVER_BYTES) return undefined;

  let text: string;
  try {
    if (size > ROLE_READ_CAP_BYTES) {
      const fd = fs.openSync(absPath, "r");
      try {
        const buf = Buffer.alloc(ROLE_READ_CAP_BYTES);
        const bytesRead = fs.readSync(fd, buf, 0, ROLE_READ_CAP_BYTES, 0);
        text = buf.toString("utf8", 0, bytesRead);
      } finally {
        fs.closeSync(fd);
      }
    } else {
      text = fs.readFileSync(absPath, "utf8");
    }
  } catch {
    return undefined;
  }
  return deriveRoleFromText(text, relPath);
}

/**
 * Extract a dedup key from a role string: for a "kind Name[ — doc]"-shaped
 * role (what deriveCodeRole produces), the key is the symbol NAME, so a
 * class's declaration and its out-of-line definitions collapse to one key
 * regardless of which file each came from. Anything else (e.g. a markdown
 * heading has no such structure) keys on the whole role text, so unrelated
 * files never collide.
 */
function primarySymbolKey(role: string): string {
  const beforeDash = role.split(" — ")[0]!;
  const spaceIdx = beforeDash.indexOf(" ");
  if (spaceIdx > 0 && ROLE_KIND_WORDS.has(beforeDash.slice(0, spaceIdx))) {
    return normalizeIdent(beforeDash.slice(spaceIdx + 1));
  }
  return normalizeIdent(role);
}

/**
 * Annotate at most `maxFiles` items of `items` with a `role` (via
 * `roleForPath`), then re-check `maxBytes` WITH roles counted: if
 * annotating busts the cap, roles are dropped one at a time (lowest
 * priority first) until the response fits again — hits/lines themselves
 * (already fitted to cap by the caller) are never touched here.
 *
 * Candidates are drawn from the leading `considerWindow` items (wider than
 * `maxFiles` — see ROLE_CONSIDER_WINDOW doc comment) and deduplicated by
 * primarySymbolKey(): when two candidates share a symbol (a header
 * declaration and its out-of-line definition), the one WITH a doc snippet
 * wins, so the annotation budget is spent on distinct, maximally-useful
 * symbols rather than repeating one. Ties/no-doc-vs-no-doc keep the
 * earliest (lowest index). Among the deduplicated candidates, the
 * earliest-by-index `maxFiles` are kept, preserving the response's own
 * order as the priority signal whenever there is nothing to deduplicate.
 *
 * Generic over any item shape with `path`/optional `role` so both
 * buildFindResponse's FindFileGroup[] and searchSymbols' SymbolLocation[]
 * can share this one cap-aware annotator.
 */
export function applyRoles<T extends { path: string; role?: string }>(
  items: T[],
  roleForPath: (relPath: string) => string | undefined,
  build: (items: T[]) => unknown,
  maxBytes: number,
  maxFiles: number = ROLE_MAX_ANNOTATED_FILES,
  considerWindow: number = ROLE_CONSIDER_WINDOW,
): T[] {
  if (items.length === 0) return items;

  const window = Math.min(items.length, considerWindow);
  interface Scored { index: number; role: string; symbolKey: string; hasDoc: boolean }
  const scored: Scored[] = [];
  for (let i = 0; i < window; i++) {
    const role = roleForPath(items[i]!.path);
    if (!role) continue;
    scored.push({ index: i, role, symbolKey: primarySymbolKey(role), hasDoc: role.includes(" — ") });
  }

  const bestPerSymbol = new Map<string, Scored>();
  for (const s of scored) {
    const existing = bestPerSymbol.get(s.symbolKey);
    if (!existing || (s.hasDoc && !existing.hasDoc)) bestPerSymbol.set(s.symbolKey, s);
  }
  const chosen = [...bestPerSymbol.values()].sort((a, b) => a.index - b.index).slice(0, maxFiles);
  const roleByIndex = new Map(chosen.map((c) => [c.index, c.role]));

  const roled = items.map((item, i) => {
    const role = roleByIndex.get(i);
    return role ? { ...item, role } : item;
  });
  if (Buffer.byteLength(JSON.stringify(build(roled)), "utf8") <= maxBytes) return roled;

  // Over cap with roles counted — shed roles (never hits), lowest-priority
  // (last-chosen) first, until it fits.
  const shrinking = roled.map((item) => ({ ...item }));
  for (let k = chosen.length - 1; k >= 0; k--) {
    if (Buffer.byteLength(JSON.stringify(build(shrinking)), "utf8") <= maxBytes) break;
    delete shrinking[chosen[k]!.index]!.role;
  }
  // Defensive: the no-roles baseline is exactly `items`, which the caller
  // guarantees already fits — this should be unreachable, but never emit an
  // over-cap response because of a role.
  if (Buffer.byteLength(JSON.stringify(build(shrinking)), "utf8") > maxBytes) return items;
  return shrinking;
}

function pathNameCandidates(workspace: string, tokens: string[], limit: number): string[] {
  if (tokens.length === 0) return [];
  const lowerTokens = tokens.map((t) => t.toLowerCase()).filter((t) => t.length >= 3);
  if (lowerTokens.length === 0) return [];

  const dirHits = new Set<string>();
  const fileHits = new Set<string>();
  // did-you-mean is explore action=find's own fallback (only called from
  // buildFindResponse) — widen to FIND_ACTION_EXTRA_EXTS like the rest of
  // the find-action path (see FIND_ACTION_EXTRA_EXTS doc comment).
  const files = walkCodeFiles(workspace, {
    extraExts: FIND_ACTION_EXTRA_EXTS,
    extraBasenames: FIND_ACTION_EXTRA_BASENAMES,
    includeArtifacts: true,
  });
  for (const f of files) {
    const segments = f.relPath.split("/");
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i]!.toLowerCase();
      if (lowerTokens.some((t) => seg.includes(t))) {
        if (i < segments.length - 1) {
          dirHits.add(segments.slice(0, i + 1).join("/") + "/");
        } else {
          fileHits.add(f.relPath);
        }
      }
    }
  }
  return [...dirHits, ...fileHits].slice(0, limit);
}

// ---------------------------------------------------------------------------
// L3(a) (2026-08-08 find-honesty) — did_you_mean ranks by SERVED CONTENT.
//
// THE MEASURED DEFECT (run 2026-08-08-semantic-signal5-1, T05c rep2 arm-A,
// call 8). `find queries=["CW prop","yaw torque","clockwise","motor spins"]
// path=CONTRACT.md` matched nothing inside that scope, and did_you_mean
// answered [drv_motor.h, drv_motor_pwm.c] — chosen by pathNameCandidates
// because the token "motor" occurs in their FILENAMES. Neither file contains
// any of the four probes. The probes were sitting, verbatim ("// FR (0) —
// front-right, CW prop, produces -yaw"), in mixer.hpp and mixer.cpp — two
// files the session's own task pack had ALREADY SERVED the caller six calls
// earlier. Following the suggestion cost two dead calls (`find "CW"
// drv_motor.h` -> 0 matches; later `find "motor_idx" drv_motor_pwm.c`).
//
// A filename is a guess about content. The served surface IS content, and this
// server can check it for the literal probe in bounded time. So the content
// answer ranks first and says so; the filename guess is kept behind it,
// explicitly labelled as a guess, rather than dropped — a genuine miss with no
// served evidence must still get the old ladder.
// ---------------------------------------------------------------------------

/** Bound on how many already-served files a single did_you_mean pass reads. */
const DYM_MAX_SERVED_FILES = 40;
/** Bound on the size of any one of them. */
const DYM_MAX_SERVED_FILE_BYTES = 1_000_000;
/** A token-only match needs this many distinct token hits to outrank a name guess. */
const DYM_MIN_TOKEN_HITS = 2;

export interface DidYouMeanCandidates {
  candidates: string[];
  /** How many LEADING entries were chosen because they contain the probes. */
  content_matched: number;
  /** How many trailing entries are filename guesses. */
  name_matched: number;
}

/**
 * Rank did_you_mean candidates: files already served this session that
 * literally CONTAIN the caller's probes first, filename-similarity guesses
 * after.
 *
 * `probes` are the caller's own query strings verbatim (the strongest signal —
 * a phrase like "CW prop" either occurs or it does not); `tokens` are the
 * tokenized fallback. A served file qualifies on one probe hit, or on
 * DYM_MIN_TOKEN_HITS distinct token hits — one common word in a large file is
 * noise, not a lead.
 *
 * Deliberately ignores the request's `path` scope. The whole failure mode is
 * that the answer lay OUTSIDE the scope the caller guessed at, so re-applying
 * that guess here would reproduce the miss.
 */
function didYouMeanCandidates(
  workspace: string,
  probes: readonly string[],
  tokens: readonly string[],
  limit: number,
  scanned: ReadonlySet<string>,
): DidYouMeanCandidates {
  const nameCandidates = pathNameCandidates(workspace, [...tokens], limit)
    .filter((candidate) => !scanned.has(candidate));
  const lowerProbes = probes
    .map((probe) => probe.toLowerCase().trim())
    .filter((probe) => probe.length >= 3);
  const lowerTokens = [...new Set(tokens.map((token) => token.toLowerCase()))].filter(
    (token) => token.length >= 3,
  );
  if (lowerProbes.length === 0 && lowerTokens.length === 0) {
    return { candidates: nameCandidates, content_matched: 0, name_matched: nameCandidates.length };
  }

  const scored: { path: string; probeHits: number; tokenHits: number }[] = [];
  let read = 0;
  for (const relPath of getReadPaths(workspace)) {
    if (read >= DYM_MAX_SERVED_FILES) break;
    // THIS call already content-scanned it and found nothing. Suggesting it
    // back would contradict the absence certificate riding the same response —
    // and in the measured cell the scanned file WAS the scope the caller
    // named (CONTRACT.md), so it is the single likeliest false lead.
    if (scanned.has(relPath)) continue;
    let content: string;
    try {
      const abs = path.join(workspace, relPath);
      if (fs.statSync(abs).size > DYM_MAX_SERVED_FILE_BYTES) continue;
      content = fs.readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    read++;
    const haystack = content.toLowerCase();
    const probeHits = lowerProbes.filter((probe) => haystack.includes(probe)).length;
    const tokenHits = lowerTokens.filter((token) => haystack.includes(token)).length;
    if (probeHits === 0 && tokenHits < DYM_MIN_TOKEN_HITS) continue;
    scored.push({ path: relPath, probeHits, tokenHits });
  }
  scored.sort(
    (a, b) => b.probeHits - a.probeHits || b.tokenHits - a.tokenHits || a.path.localeCompare(b.path),
  );

  const contentPaths = scored.slice(0, limit).map((entry) => entry.path);
  const seen = new Set(contentPaths);
  const trailing = nameCandidates.filter((candidate) => !seen.has(candidate));
  const candidates = [...contentPaths, ...trailing].slice(0, limit);
  const contentMatched = candidates.filter((candidate) => seen.has(candidate)).length;
  return {
    candidates,
    content_matched: contentMatched,
    name_matched: candidates.length - contentMatched,
  };
}

/**
 * The did_you_mean fields for one zero-match response: the ranked list plus a
 * basis that says WHY each half is there. Without the basis a caller cannot
 * tell a verified content hit from a filename guess, which is precisely the
 * confusion that cost rep2 two calls.
 */
function didYouMeanExtra(
  workspace: string,
  probes: readonly string[],
  tokens: readonly string[],
  limit: number,
  scanned: ReadonlySet<string>,
): Record<string, unknown> {
  const ranked = didYouMeanCandidates(workspace, probes, tokens, limit, scanned);
  if (ranked.candidates.length === 0) return {};
  const basis: Record<string, unknown> = {
    content_matched: ranked.content_matched,
    name_matched: ranked.name_matched,
    note:
      ranked.content_matched > 0
        ? `first ${ranked.content_matched} CONTAIN your search text and were already served this session — check your context${ranked.name_matched > 0 ? "; the rest match by FILENAME only" : ""}`
        : "FILENAME matches only — no already-served file contains your search text, so a hit is not established",
  };
  return { did_you_mean: ranked.candidates, did_you_mean_basis: basis };
}

// ---------------------------------------------------------------------------
// C6.2 — sibling-stem collapse
// ---------------------------------------------------------------------------

/** Minimum stem length to search on — avoids a 1-2 char stem exploding into
 * an unrelated-match flood (e.g. query "a-b" should not stem-scan on "a-"). */
const MIN_STEM_LEN = 3;

/**
 * True when `query` is a hyphen/underscore-family token: a plain single
 * identifier (no whitespace) containing at least one `-` or `_` separator,
 * e.g. `chip--level-high`, `NAV_LINK_STATUS`,
 * `--color-level-high`. Multi-word free-text queries (handled by the
 * Pass-2 tokenizer instead) are excluded by the no-whitespace / single-token
 * check.
 */
function isStemFamilyToken(query: string): boolean {
  const q = query.trim();
  if (q.length === 0 || /\s/.test(q)) return false;
  return /[-_]/.test(q);
}

/**
 * Derive the "family stem" of a hyphen/underscore token: the prefix up to
 * (and including) its LAST separator run, e.g.
 * `chip--level-high` -> `chip--level-`,
 * `NAV_LINK_STATUS` -> `NAV_LINK_`,
 * `--color-level-high` -> `--color-level-`.
 * Returns null when the token has no separator to stem on, or the derived
 * stem is too short to search safely (MIN_STEM_LEN).
 */
function deriveQueryStem(query: string): string | null {
  const q = query.trim();
  const m = /^(.*[-_])[^-_]+$/.exec(q);
  if (!m) return null;
  const stem = m[1]!;
  return stem.length >= MIN_STEM_LEN ? stem : null;
}

/**
 * When the query is a hyphen/underscore-family token, append sibling
 * matches sharing its stem — but ONLY within files that already matched the
 * literal query, so e.g. querying `badge--priority-critical` (a value that
 * may not exist yet, mid-feature-add) still needs >=1 literal hit to anchor
 * which file(s) to widen; a query with zero literal matches falls through
 * to Pass 2 (tokenized fallback) unchanged, not this path.
 *
 * This lets a single query for one family member (`badge--priority-high`)
 * surface its siblings (`-none`, `-low`, `-medium`, `-urgent`, `-critical`)
 * in the same file in one call, instead of a serial per-member probe.
 *
 * Efficiency: the stem re-scan is restricted to `matchedFiles` via
 * scanLiteral's `onlyFiles` — those are the only files a sibling could ever
 * surface from (anything outside them is filtered out below anyway), so
 * there is no reason to walk + read every file in the workspace only to
 * discard everything outside this typically 1-3-file set.
 */
function withSiblingStemMatches(
  query: string,
  literalMatches: TextMatch[],
  workspace: string,
  opts: { lang?: LangKey; path?: string; contentCache?: ScanContentCache },
): TextMatch[] {
  if (!isStemFamilyToken(query)) return literalMatches;
  const stem = deriveQueryStem(query);
  if (!stem) return literalMatches;

  const matchedFiles = new Set(literalMatches.map((m) => m.path));
  if (matchedFiles.size === 0) return literalMatches;

  const stemHits = scanLiteral(stem, workspace, {
    caseInsensitive: true,
    onlyFiles: matchedFiles,
    ...(opts.contentCache ? { contentCache: opts.contentCache } : {}),
  });

  const existing = new Set(literalMatches.map((m) => `${m.path}:${m.line}`));
  const siblings = stemHits.filter(
    (m) => matchedFiles.has(m.path) && !existing.has(`${m.path}:${m.line}`),
  );
  if (siblings.length === 0) return literalMatches;

  return [...literalMatches, ...siblings];
}

// ---------------------------------------------------------------------------
// Identifier-variant fallback ladder (before did-you-mean).
// ---------------------------------------------------------------------------

/** Max variant probes attempted (bound the fallback's search cost). */
const MAX_VARIANT_PROBES = 6;

/**
 * Split an identifier into ordered segments, breaking camelCase/PascalCase
 * humps AND snake_case/kebab-case separators, lowercased. Empty runs (from a
 * `--` double separator) are dropped. e.g.
 * `chip--level-high` -> ["chip","level","high"],
 * `levelHigh` -> ["level","high"],
 * `NAV_LINK_STATUS` -> ["nav","link","status"].
 */
function identifierSegments(token: string): string[] {
  return token
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2") // camelCase hump
    .toLowerCase()
    .split(/[-_\s]+/)
    .filter((s) => s.length > 0);
}

/**
 * Derive identifier-VARIANT probes for a single identifier-shaped query whose
 * LITERAL form matched nothing — the naming-convention reconstructions the
 * benchmark's broken class-name/CSS-custom-property chain needs. Two families,
 * both derived purely from the query's own shape (no domain vocabulary):
 *
 *   1. AFFIX-STRIPPED STEMS: contiguous segment windows formed by dropping
 *      leading and/or trailing segments one at a time, e.g.
 *      `badge--priority-urgent` -> `priority-urgent` -> `priority` (also
 *      `badge-priority`, `urgent`, ...). This is what bridges a class-name
 *      stem ("badge--priority-urgent") to a differently-prefixed declaration
 *      ("--color-priority-urgent"): the shared middle "priority-urgent" is a
 *      substring of BOTH once the "badge" prefix is stripped.
 *   2. CASE/SEPARATOR RE-JOINS of each stem (and the full token) via the
 *      shared deriveTokenVariants (kebab/snake/SCREAMING plus "-"/"--" CSS
 *      wrapper forms), so a stem "priority-urgent" also probes "priority_urgent"
 *      and the CSS-custom-property wrappers "-priority-urgent"/"--priority-urgent".
 *
 * Ordered MOST-SPECIFIC first (more segments, longer) so the first probe to
 * hit is the most precise reconstruction and its label is the most useful.
 * The full literal query is intentionally EXCLUDED (it already missed). Probes
 * shorter than MIN_STEM_LEN are dropped (a 1-2 char stem floods unrelated
 * matches). Returns at most MAX_VARIANT_PROBES.
 */
export function deriveIdentifierVariantProbes(query: string): string[] {
  const q = query.trim();
  if (q.length === 0 || /\s/.test(q)) return []; // single identifier only
  const segs = identifierSegments(q);
  if (segs.length === 0) return [];

  // Contiguous segment windows (all lengths from segs.length down to 1),
  // longest first, then earliest start — a deterministic most-specific-first
  // order. Each window is a plain kebab join of consecutive segments, i.e. an
  // affix-stripped stem of the original (leading and/or trailing segments
  // dropped): badge-priority-urgent -> {badge-priority, priority-urgent} ->
  // {badge, priority, urgent}.
  const windows: string[] = [];
  for (let len = segs.length; len >= 1; len--) {
    for (let start = 0; start + len <= segs.length; start++) {
      windows.push(segs.slice(start, start + len).join("-"));
    }
  }

  const fullKebab = segs.join("-");
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (v: string): boolean => {
    const t = v.trim();
    if (t.length < MIN_STEM_LEN) return false;
    const key = t.toLowerCase();
    if (seen.has(key)) return false;
    // The full literal query (in its canonical kebab form) already missed —
    // do not re-probe it.
    if (key === fullKebab.toLowerCase()) return false;
    seen.add(key);
    out.push(t);
    return true;
  };

  // A compound identifier may fall back only to another compound
  // identifier. Single-segment fallbacks such as PRIORITY_ORDER -> "priority"
  // are too lossy: they silently turn a literal identifier lookup into a broad
  // repository crawl. Single-segment queries still keep their literal lookup,
  // while callers that genuinely want OR widening can state it via queries[].
  const minProbeSegments = segs.length > 1 ? 2 : 1;
  const safeWindows = windows.filter(
    (window) => identifierSegments(window).length >= minProbeSegments,
  );

  // Phase 1: PLAIN affix-stripped stems, most-specific first. These are the
  // high-value probes — a stem like "priority-urgent" is a substring of a
  // differently-prefixed declaration ("--color-priority-urgent") and matches
  // directly. They must be tried before any case/wrapper re-join so the
  // labeled hit is the most precise stem, not an incidental SCREAMING form.
  for (const window of safeWindows) {
    if (out.length >= MAX_VARIANT_PROBES) return out;
    push(window);
  }
  // Phase 2: case/separator/CSS-wrapper re-joins (kebab/snake/SCREAMING plus
  // "-"/"--" wrappers) of each window, filling any remaining probe budget —
  // for the case where the target uses a DIFFERENT separator/case than the
  // query's own (e.g. query kebab, target SCREAMING_SNAKE, or a CSS custom
  // property "--stem"). Same most-specific-first window order.
  for (const window of safeWindows) {
    if (out.length >= MAX_VARIANT_PROBES) break;
    for (const v of deriveTokenVariants(window.replace(/-/g, "_").toUpperCase())) {
      if (out.length >= MAX_VARIANT_PROBES) break;
      push(v);
    }
  }
  return out.slice(0, MAX_VARIANT_PROBES);
}

/**
 * Variant fallback stage: for an identifier-shaped query whose literal form
 * matched nothing, probe its naming variants (deriveIdentifierVariantProbes)
 * in most-specific-first order and return the FIRST probe that yields matches,
 * grouped by file. Reuses scanLiteral (the same search machinery) and reports
 * WHICH probe hit via `variant`. Returns null when no probe matches, so the
 * caller falls through to the tokenized fallback unchanged.
 */
function findViaIdentifierVariants(
  query: string,
  workspace: string,
  opts: { files: ReadonlyArray<Pick<FoundFile, "relPath" | "absPath" | "kind">>; contentCache: ScanContentCache },
): { variant: string; matches: TextMatch[] } | null {
  const probes = deriveIdentifierVariantProbes(query);
  for (const probe of probes) {
    // Only called from buildFindResponse — reuses the response's single walk
    // (same wide ext set) and shared content cache.
    const hits = scanLiteral(probe, workspace, {
      caseInsensitive: true,
      files: opts.files,
      contentCache: opts.contentCache,
    });
    if (hits.length > 0) return { variant: probe, matches: hits };
  }
  return null;
}

/**
 * Fix B (2026-07-12c single-query-find-loop forensics): combines an internal find-response
 * hint (empty query / regex-no-match / no-identifier-tokens) with the
 * one-shot find-batching nudge (see recordSingleFindCompletion in
 * util/session.ts) so neither is silently dropped when both fire on the
 * same call — e.g. the 2nd single-query find of a session happens to also
 * be one that matches nothing. Internal hint first (it names the immediate
 * problem), batching nudge second.
 */
function composeHint(internalHint: string | undefined, extraHint: string | undefined): string | undefined {
  if (internalHint && extraHint) return `${internalHint} | ${extraHint}`;
  return internalHint ?? extraHint;
}

/**
 * A1 never-empty explore action=find: literal match first; on 0 (or too few)
 * literal matches, tokenize the query and re-search AND-preferred (files
 * hitting every term) with OR fallback (files hitting any term); if still
 * empty, return did_you_mean path candidates plus a retry hint. Results are
 * always grouped by file so a hit's file is never hidden behind truncation.
 *
 * `opts.extraHint` (Fix B): a one-shot nudge (e.g. the find-batching hint)
 * to compose into the response's `hint` field — baked into every
 * fitFilesToCap/applyRoles cap trial via responseExtra/buildWithExtra
 * below, exactly like matched_terms/matched_variant, so a hint attached
 * here can never push a response over MAX_RESPONSE_BYTES unaccounted for.
 */
export function buildFindResponse(
  input: FindTextInput,
  workspace: string,
  opts: { extraHint?: string } = {},
): FindResponse {
  const query = input.query;
  const build = (files: FindFileGroup[], extra: Record<string, unknown> = {}): FindResponse => {
    const total_matches = files.reduce((n, f) => n + f.lines.length, 0);
    return {
      query,
      files,
      total_files: files.length,
      total_matches,
      truncated: false,
      literal: true,
      ...extra,
    } as FindResponse;
  };

  if (!query || !query.trim()) {
    return { ...build([]), hint: composeHint("query is empty; provide one identifier token, e.g. query=\"parseConfig\"", opts.extraHint) };
  }

  // ---- One walk per response. Every pass below scans the same walked file
  // list through one shared content cache instead of re-walking and
  // re-reading per term/probe; the walk's per-layer skip counts are
  // disclosed as `omitted` on every return path — a skipped file must never
  // read as "searched and found nothing".
  const walkOmissions = createWalkOmissions();
  const walked = walkCodeFiles(workspace, {
    ...(input.lang ? { lang: input.lang } : {}),
    ...(input.path ? { subPath: input.path } : {}),
    extraExts: FIND_ACTION_EXTRA_EXTS,
    extraBasenames: FIND_ACTION_EXTRA_BASENAMES,
    respectGitignore: true,
    omissions: walkOmissions,
  });
  const contentCache = createScanContentCache();
  // Which walked files really got content-scanned — the sole basis for the
  // zero-match absence certificate (see FindAbsence / buildAbsenceExtra).
  const coverage = createScanCoverage();
  const scopeHint =
    input.path && walked.length === 0 && walkOmissions.tokenlighten_ignored > 0
      ? `scope '${input.path}' is excluded by .tokenlightenignore (nothing was scanned); drop the pattern or read files there by explicit path`
      : undefined;
  const extraHint = composeHint(scopeHint, opts.extraHint);
  const literalCaseInsensitive = input.caseInsensitive ?? (!input.regex && isSingleToken(query));
  /** Certificate fragment for a zero-match return; `{}` when absence is not certifiable. */
  const absenceExtraFor = (tokens: readonly string[]): Record<string, unknown> =>
    buildAbsenceExtra({
      tokens,
      coverage,
      omissions: walkOmissions,
      ...(input.path ? { subPath: input.path } : {}),
      ...(input.regex ? { regex: true } : {}),
      caseSensitive: !literalCaseInsensitive,
    });

  // ---- Pass 1: literal/regex query, exactly as given. ------------------
  // S1/C2: buildFindResponse is explore action=find's own entrypoint —
  // widen to FIND_ACTION_EXTRA_EXTS so doc/config/log hits surface here,
  // without touching findText()'s narrower default used by other callers.
  let literalMatches = scanLiteral(query, workspace, {
    ...(input.regex !== undefined ? { regex: input.regex } : {}),
    caseInsensitive: literalCaseInsensitive,
    files: walked,
    contentCache,
    coverage,
  });

  let omittedExtra = buildOmittedExtra(walkOmissions);
  // The generic lane executes only after every existing public-find fallback
  // has missed. It therefore cannot perturb a semantic, variant, or tokenized
  // hit; it is the last chance before the historical empty response.
  const genericFallbackResponse = (): FindResponse | null => {
    if (input.lang || !genericTextDiscoveryEnabled()) return null;
    const genericOmissions = createWalkOmissions();
    const genericWalked = walkCodeFiles(workspace, {
      ...(input.path ? { subPath: input.path } : {}),
      extraExts: FIND_ACTION_EXTRA_EXTS,
      extraBasenames: FIND_ACTION_EXTRA_BASENAMES,
      includeGenericText: true,
      respectGitignore: true,
      omissions: genericOmissions,
    }).filter((file) => file.kind === "generic-text");
    let genericMatches = scanLiteral(query, workspace, {
      ...(input.regex !== undefined ? { regex: input.regex } : {}),
      caseInsensitive: literalCaseInsensitive,
      files: genericWalked,
      contentCache,
      coverage,
    });
    let matchedVariant: string | undefined;
    if (genericMatches.length === 0 && !input.regex) {
      const variant = findViaIdentifierVariants(query, workspace, { files: genericWalked, contentCache });
      if (variant) {
        genericMatches = variant.matches;
        matchedVariant = variant.variant;
      }
    }
    walkOmissions.oversize += genericOmissions.oversize;
    walkOmissions.non_text += genericOmissions.non_text;
    walkOmissions.secrets += genericOmissions.secrets;
    omittedExtra = buildOmittedExtra(walkOmissions);
    if (genericMatches.length === 0) return null;
    const source = input.regex || matchedVariant ? genericMatches : withSiblingStemMatches(query, genericMatches, workspace, { contentCache });
    const grouped = groupByFile(source);
    const responseExtra: Record<string, unknown> = {
      ...omittedExtra,
      ...(matchedVariant ? { literal: false, matched_variant: matchedVariant } : {}),
    };
    const buildWithExtra = (fs: FindFileGroup[]): FindResponse => build(fs, responseExtra);
    const fitted = fitFilesToCap(grouped, buildWithExtra, MAX_RESPONSE_BYTES);
    const roledFiles = applyRoles(fitted.files, (p) => deriveFileRole(workspace, p), buildWithExtra, MAX_RESPONSE_BYTES);
    return attachInventory(buildWithExtra(roledFiles), grouped, fitted.truncated, anyWalkOmission(walkOmissions));
  };

  if (literalMatches.length >= MIN_LITERAL_MATCHES_BEFORE_FALLBACK) {
    // C6.2 — widen with sibling-stem matches (e.g. badge--priority-high query
    // also surfaces -none/-low/-medium/-urgent/-critical in the same file)
    // before grouping, so fitFilesToCap sees the full candidate set.
    const withSiblings = input.regex
      ? literalMatches // regex queries keep their own semantics untouched
      : withSiblingStemMatches(query, literalMatches, workspace, { contentCache });
    // Fix B: bake the one-shot find-batching hint (if this call triggered
    // it) into every cap trial BEFORE trimming — same responseExtra/
    // buildWithExtra pattern as the variant/tokenized branches below, never
    // appended after fitFilesToCap/applyRoles have already run.
    const grouped = attachDominantEditContext(groupByFile(withSiblings), workspace);
    const editCandidate = grouped.find((file) => file.context !== undefined && file.handle !== undefined);
    const editHint = editCandidate ? repeatedHitHint(workspace, editCandidate) : undefined;
    const hint = composeHint(editHint, extraHint);
    const responseExtra: Record<string, unknown> = { ...omittedExtra, ...(hint ? { hint } : {}) };
    const buildWithExtra = (fs: FindFileGroup[]): FindResponse => build(fs, responseExtra);
    const fitted = fitFilesToCap(grouped, buildWithExtra, MAX_RESPONSE_BYTES);
    const roledFiles = applyRoles(fitted.files, (p) => deriveFileRole(workspace, p), buildWithExtra, MAX_RESPONSE_BYTES);
    return attachInventory(buildWithExtra(roledFiles), grouped, fitted.truncated, anyWalkOmission(walkOmissions));
  }

  // ---- Pass 1.5: identifier-VARIANT fallback (before the loose tokenized
  // fallback and before did-you-mean). For an identifier-shaped query whose
  // LITERAL form matched nothing, probe its naming variants — camelCase/snake/
  // kebab/SCREAMING re-joins plus affix-stripped stems — and, if one hits,
  // return that precise, LABELED result instead of decomposing the identifier
  // into loose tokens. This is what repairs a broken convention chain: a query
  // "badge--priority-urgent" that missed literally is bridged to the
  // stylesheet's "--color-priority-urgent" via the shared stem "priority-urgent"
  // (an affix-stripped variant), with matched_variant naming which form hit.
  // Regex queries keep their own semantics (no variant reconstruction). ------
  if (!input.regex) {
    const variantHit = findViaIdentifierVariants(query, workspace, { files: walked, contentCache });
    if (variantHit) {
      // The cap-fitting/role passes below must see literal:false/matched_variant
      // baked into every trial's byte count, not spliced on after — otherwise a
      // response that just fits at the files-only stage can burst
      // MAX_RESPONSE_BYTES once these fields are added back. Mirrors
      // buildFindResponseForQueries' responseExtra/buildWithExtra pattern.
      const responseExtra: Record<string, unknown> = {
        ...omittedExtra,
        literal: false,
        matched_variant: variantHit.variant,
        ...(extraHint ? { hint: extraHint } : {}),
      };
      const buildWithExtra = (fs: FindFileGroup[]): FindResponse => build(fs, responseExtra);
      const grouped = groupByFile(variantHit.matches);
      const fitted = fitFilesToCap(grouped, buildWithExtra, MAX_RESPONSE_BYTES);
      const roledFiles = applyRoles(fitted.files, (p) => deriveFileRole(workspace, p), buildWithExtra, MAX_RESPONSE_BYTES);
      return attachInventory(buildWithExtra(roledFiles), grouped, fitted.truncated, anyWalkOmission(walkOmissions));
    }
  }

  // ---- Pass 2: tokenized AND-preferred / OR-fallback. -------------------
  if (input.regex) {
    // Regex queries are not tokenized — an empty regex match is a genuine
    // empty result, but it must still redirect, not return a bare object.
    const generic = genericFallbackResponse();
    if (generic) return generic;
    return {
      ...build([], omittedExtra),
      matched_terms: [],
      // Certifies the PATTERN's absence; withheld when the regex failed to
      // compile (scanLiteral returned before reading any file, so coverage is
      // empty) — "the regex is invalid" must never read as "there is no match".
      ...absenceExtraFor([query]),
      hint: composeHint("regex matched nothing; retry with regex:false and one identifier token", extraHint),
    };
  }

  // action=find's documented single-token form is a literal identifier lookup.
  // If both the literal and safe compound-variant passes missed, do not
  // decompose that identifier into generic words. That used to turn a miss
  // such as PRIORITY_ORDER into every occurrence of "priority", producing a
  // large but misleading result and several avoidable follow-up reads.
  if (isSingleToken(query)) {
    const generic = genericFallbackResponse();
    if (generic) return generic;
    return {
      ...build([], omittedExtra),
      matched_terms: [],
      ...didYouMeanExtra(workspace, [query], tokenizeQuery(query), 5, coverage.scanned),
      // THE case the certificate exists for: a single identifier that is
      // genuinely nowhere. The literal pass AND the naming-variant probes
      // covered every scanned file, so this is a fact, not a weak search.
      ...absenceExtraFor([query]),
      hint: composeHint(
        "identifier matched neither literally nor via a specific compound naming variant; literal find does not decompose identifiers into broad terms — use queries=[...] for deliberate OR widening or action=references for call sites",
        extraHint,
      ),
    };
  }

  const baseTokens = tokenizeQuery(query);
  const expanded: string[] = [];
  const seenExpanded = new Set<string>();
  for (const tok of baseTokens.slice(0, 6)) {
    for (const variant of deriveTokenVariants(tok)) {
      const key = variant.toLowerCase();
      if (seenExpanded.has(key)) continue;
      seenExpanded.add(key);
      expanded.push(variant);
    }
  }
  const searchTerms = expanded.length > 0 ? expanded : baseTokens;

  if (searchTerms.length === 0) {
    const generic = genericFallbackResponse();
    if (generic) return generic;
    return {
      ...build([], omittedExtra),
      matched_terms: [],
      ...didYouMeanExtra(workspace, [query], tokenizeQuery(query), 5, coverage.scanned),
      // No token survived tokenization, but the VERBATIM query was still
      // scanned against every walked file by Pass 1 — that literal absence is
      // certifiable even though the tokenized pass has nothing to run.
      ...absenceExtraFor([query]),
      hint: composeHint("retry with one identifier token, e.g. query=\"parseConfig\"", extraHint),
    };
  }

  // Per-term literal scan (case-insensitive — A1 point 6), scored by file.
  // The 12-term budget is hoisted because a zero-match certificate may only
  // name tokens that were REALLY scanned: terms past the budget were not.
  const scannedTerms = searchTerms.slice(0, 12);
  const perTermMatches = new Map<string, TextMatch[]>();
  const fileTermHits = new Map<string, Set<string>>();
  for (const term of scannedTerms) {
    const hits = scanLiteral(term, workspace, {
      caseInsensitive: true,
      files: walked,
      contentCache,
      coverage,
    });
    if (hits.length === 0) continue;
    perTermMatches.set(term, hits);
    for (const h of hits) {
      let set = fileTermHits.get(h.path);
      if (!set) {
        set = new Set();
        fileTermHits.set(h.path, set);
      }
      set.add(term.toLowerCase());
    }
  }

  const actuallyMatchedTerms = [...perTermMatches.keys()];

  if (actuallyMatchedTerms.length === 0) {
    const generic = genericFallbackResponse();
    if (generic) return generic;
    // Certify the caller's OWN tokens, restricted to those the term budget
    // actually reached — never the derived case/kebab/snake variants (noise),
    // and never a base token that the budget dropped before scanning it.
    const scannedTermKeys = new Set(scannedTerms.map((t) => t.toLowerCase()));
    const certifiedTokens = baseTokens.filter((t) => scannedTermKeys.has(t.toLowerCase()));
    return {
      ...build([], omittedExtra),
      matched_terms: [],
      ...didYouMeanExtra(workspace, [query], baseTokens, 5, coverage.scanned),
      // Per-term scans are always case-insensitive here (A1 point 6), so this
      // branch's certificate never carries the case-sensitivity qualifier.
      ...buildAbsenceExtra({
        tokens: certifiedTokens,
        coverage,
        omissions: walkOmissions,
        ...(input.path ? { subPath: input.path } : {}),
        caseSensitive: false,
      }),
      hint: composeHint("retry with one identifier token, e.g. query=\"parseConfig\"", extraHint),
    };
  }

  const distinctTermCount = new Set(actuallyMatchedTerms.map((t) => t.toLowerCase())).size;
  const allMatches: TextMatch[] = [...perTermMatches.values()].flat();

  // AND-preferred: files whose hit set covers every distinct matched term.
  const andFiles = new Set<string>();
  for (const [path, terms] of fileTermHits) {
    if (terms.size >= distinctTermCount) andFiles.add(path);
  }

  const source = andFiles.size > 0
    ? allMatches.filter((m) => andFiles.has(m.path))
    : allMatches; // OR fallback: any term.

  // The cap-fitting/role passes below must see literal:false/matched_terms
  // baked into every trial's byte count, not spliced on after — otherwise a
  // response that just fits at the files-only stage can burst
  // MAX_RESPONSE_BYTES once these fields are added back (matched_terms can
  // run to several tokens' worth of bytes after AND/OR expansion). Mirrors
  // buildFindResponseForQueries' responseExtra/buildWithExtra pattern.
  const responseExtra: Record<string, unknown> = {
    ...omittedExtra,
    literal: false,
    matched_terms: actuallyMatchedTerms,
    ...(extraHint ? { hint: extraHint } : {}),
  };
  const buildWithExtra = (fs: FindFileGroup[]): FindResponse => build(fs, responseExtra);
  const grouped = groupByFile(source);
  const fitted = fitFilesToCap(grouped, buildWithExtra, MAX_RESPONSE_BYTES);
  const roledFiles = applyRoles(fitted.files, (p) => deriveFileRole(workspace, p), buildWithExtra, MAX_RESPONSE_BYTES);

  return attachInventory(buildWithExtra(roledFiles), grouped, fitted.truncated, anyWalkOmission(walkOmissions));
}

// ---------------------------------------------------------------------------
// queries[] — multi-token OR search (2026-07-11d).
//
// MOTIVATION (bench run 2026-07-11c): an agent probing a CSS custom-property
// family issued 7 sequential single-token explore action=find calls (one
// full billed turn each) because find only accepted ONE literal token; a
// sibling run instead escaped to native `grep -n "NONE\|LOW\|..."` OR-syntax.
// queries[] lets the caller supply up to 5 literal alternatives in ONE call.
//
// Each entry runs through the SAME core as buildFindResponse's own Pass 1
// (scanLiteral, plus C6.2 sibling-stem widening when non-regex) — NOT the
// Pass 1.5/Pass 2 fallback ladder (identifier-variant probing, tokenized
// AND/OR decomposition). The caller already supplied the alternatives it
// wants tried; re-guessing per entry would multiply cost unpredictably
// across up to 5 tokens. A miss still surfaces via did_you_mean.
//
// Merge happens BEFORE capping: raw matches from every hit query are
// concatenated and handed to groupByFile() once (it already unions/dedupes
// by (path,line) and concatenates snippets), then fitFilesToCap/applyRoles
// run ONCE on the merged set — so a response never exceeds MAX_RESPONSE_BYTES
// merely because it was assembled from N queries instead of 1.
//
// F4 (2026-08-01 find-diet): that single fitFilesToCap call is also where
// F2 (MAX_LINES_PER_FILE) and F3 (SOFT_DEGRADE_BYTES) apply — a merged
// OR-batch result gets the identical per-file line cap and response-level
// soft degrade as a single-query buildFindResponse call, with no separate
// wiring needed here.
// ---------------------------------------------------------------------------

export interface FindTextMultiInput {
  /** 1-5 literal tokens, OR-matched. Dispatch (server.ts) enforces the count. */
  queries: string[];
  regex?: boolean;
  lang?: LangKey;
  path?: string;
  caseInsensitive?: boolean;
}

export function buildFindResponseForQueries(input: FindTextMultiInput, workspace: string): FindResponse {
  const queries = input.queries;
  const build = (files: FindFileGroup[], extra: Record<string, unknown> = {}): FindResponse => {
    const total_matches = files.reduce((n, f) => n + f.lines.length, 0);
    return {
      query: queries.join(" OR "),
      files,
      total_files: files.length,
      total_matches,
      truncated: false,
      literal: true,
      ...extra,
    } as FindResponse;
  };

  if (queries.length === 0) {
    return { ...build([]), hint: "queries is empty; provide 1-5 literal tokens" };
  }

  // One walk per response — same contract as buildFindResponse: shared file
  // list + content cache across the 1-5 query terms, `omitted` disclosure on
  // every return path.
  const walkOmissions = createWalkOmissions();
  const walked = walkCodeFiles(workspace, {
    ...(input.lang ? { lang: input.lang } : {}),
    ...(input.path ? { subPath: input.path } : {}),
    extraExts: FIND_ACTION_EXTRA_EXTS,
    extraBasenames: FIND_ACTION_EXTRA_BASENAMES,
    respectGitignore: true,
    omissions: walkOmissions,
  });
  const contentCache = createScanContentCache();
  const coverage = createScanCoverage();
  const scopeHint =
    input.path && walked.length === 0 && walkOmissions.tokenlighten_ignored > 0
      ? `scope '${input.path}' is excluded by .tokenlightenignore (nothing was scanned); drop the pattern or read files there by explicit path`
      : undefined;

  const hitTerms: string[] = [];
  const mergedMatches: TextMatch[] = [];
  // L3(a): tokens of the entries that MISSED, harvested per query so the
  // ranked did_you_mean below probes for exactly the text the caller failed to
  // find — the filename walk that used to run per missing query is now one
  // ranked pass over both content and names (see didYouMeanCandidates).
  const missedQueries: string[] = [];
  const missedTokens: string[] = [];
  // Any case-SENSITIVE entry makes the OR-set's absence case-sensitive as a
  // whole (a differently-cased occurrence could have been missed) — disclosed
  // in the conclusion rather than silently over-claimed.
  let anyCaseSensitiveScan = false;

  for (const q of queries) {
    const caseInsensitive = input.caseInsensitive ?? (!input.regex && isSingleToken(q));
    if (!caseInsensitive) anyCaseSensitiveScan = true;
    const literalMatches = scanLiteral(q, workspace, {
      ...(input.regex !== undefined ? { regex: input.regex } : {}),
      caseInsensitive,
      files: walked,
      contentCache,
      coverage,
    });

    if (literalMatches.length === 0) {
      if (!input.regex) {
        missedQueries.push(q);
        for (const token of tokenizeQuery(q)) {
          if (!missedTokens.includes(token)) missedTokens.push(token);
        }
      }
      continue;
    }

    hitTerms.push(q);
    const withSiblings = input.regex
      ? literalMatches
      : withSiblingStemMatches(q, literalMatches, workspace, { contentCache });
    mergedMatches.push(...withSiblings);
  }

  // Match the single-query contract: only an all-miss response probes the
  // generic lane, so supported-extension query results and their ordering are
  // byte-for-byte unchanged when the fallback is unnecessary or disabled.
  if (mergedMatches.length === 0 && !input.lang && genericTextDiscoveryEnabled()) {
    const genericOmissions = createWalkOmissions();
    const genericWalked = walkCodeFiles(workspace, {
      ...(input.path ? { subPath: input.path } : {}),
      extraExts: FIND_ACTION_EXTRA_EXTS,
      extraBasenames: FIND_ACTION_EXTRA_BASENAMES,
      includeGenericText: true,
      respectGitignore: true,
      omissions: genericOmissions,
    }).filter((file) => file.kind === "generic-text");
    for (const q of queries) {
      const caseInsensitive = input.caseInsensitive ?? (!input.regex && isSingleToken(q));
      const genericMatches = scanLiteral(q, workspace, {
        ...(input.regex !== undefined ? { regex: input.regex } : {}),
        caseInsensitive,
        files: genericWalked,
        contentCache,
        coverage,
      });
      if (genericMatches.length === 0) continue;
      hitTerms.push(q);
      mergedMatches.push(...(input.regex ? genericMatches : withSiblingStemMatches(q, genericMatches, workspace, { contentCache })));
      const missedIndex = missedQueries.indexOf(q);
      if (missedIndex >= 0) missedQueries.splice(missedIndex, 1);
    }
    // Ignore rules were already counted by the semantic walk. Only the
    // generic-only exclusions are merged so `omitted` remains stable.
    walkOmissions.oversize += genericOmissions.oversize;
    walkOmissions.non_text += genericOmissions.non_text;
    walkOmissions.secrets += genericOmissions.secrets;
  }
  const omittedExtra = buildOmittedExtra(walkOmissions);

  if (mergedMatches.length === 0) {
    const missHint = input.regex
      ? "none of the regex queries matched; retry with regex:false and literal tokens"
      : "none of the queries matched; retry with literal tokens that appear in the target files";
    return {
      ...build([], omittedExtra),
      matched_terms: [],
      ...(input.regex ? {} : didYouMeanExtra(workspace, missedQueries, missedTokens, 5, coverage.scanned)),
      // Every entry was scanned against the same walked list, so a total miss
      // certifies the absence of the whole OR-set in one call — exactly the
      // multi-token negative an agent would otherwise shell out for.
      ...buildAbsenceExtra({
        tokens: queries,
        coverage,
        omissions: walkOmissions,
        ...(input.path ? { subPath: input.path } : {}),
        ...(input.regex ? { regex: true } : {}),
        caseSensitive: anyCaseSensitiveScan,
      }),
      hint: scopeHint ? `${scopeHint} | ${missHint}` : missHint,
    };
  }

  // The cap-fitting/role passes below must see matched_terms/did_you_mean
  // baked into every trial's byte count, not spliced on after — otherwise a
  // response that JUST fits at the files-only stage can still burst
  // MAX_RESPONSE_BYTES once these fields are added back (matched_terms alone
  // can run to several tokens' worth of bytes with up to 5 queries).
  const responseExtra: Record<string, unknown> = {
    ...omittedExtra,
    matched_terms: hitTerms,
    ...(input.regex || missedQueries.length === 0
      ? {}
      : didYouMeanExtra(workspace, missedQueries, missedTokens, 5, coverage.scanned)),
  };
  const buildWithExtra = (fs: FindFileGroup[]): FindResponse => build(fs, responseExtra);

  const grouped = groupByFile(mergedMatches);
  const fitted = fitFilesToCap(grouped, buildWithExtra, MAX_RESPONSE_BYTES);
  const roledFiles = applyRoles(fitted.files, (p) => deriveFileRole(workspace, p), buildWithExtra, MAX_RESPONSE_BYTES);

  return attachInventory(buildWithExtra(roledFiles), grouped, fitted.truncated, anyWalkOmission(walkOmissions));
}
