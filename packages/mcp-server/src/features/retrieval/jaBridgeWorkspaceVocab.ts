// jaBridgeWorkspaceVocab.ts — per-workspace vocabulary CACHE feeding
// jaQueryBridge.ts (TL_JA_QUERY_BRIDGE; (S) supported first-pack policy,
// default ON since 2026-09-19 (USER ruling); explicit `=0` is the rollback
// path). This is the one file
// in the jaQueryBridge family that does I/O (a repo walk plus, since
// orchestrator Phase 2, bounded file-content reads); it exists separately
// from jaQueryBridge.ts specifically so that module can stay pure/zero-I/O
// and unit-test without any filesystem fixture.
//
// "Cheapest existing per-workspace inventory" (design item 7): rather than
// adding a new index or threading a workspace/walk-cache parameter through
// every one of locateTaskContext.ts's ~15 extractIdentifiers call sites,
// this reuses walkCodeFiles -- the SAME walker locateTaskContext.ts's own
// per-call WalkCache wraps -- called once per workspace independently of
// any single locate() call's WalkCache instance, then caches the derived
// vocabulary in a module-level Map keyed by workspace root.
//
// Phase 2 (orchestrator review): a path/basename-only vocabulary missed
// most real identifiers -- "cancel"/"refund"/"code" exist only inside
// function bodies (cancelOrder(), refund(), validateCouponCode), never as
// a file or directory name. This file now ALSO scans bounded file CONTENT
// through the same walker (no reusable persistent content cache exists
// elsewhere in this codebase for the walker's own FoundFile list -- only
// per-call, request-scoped content caches inside findText.ts -- so this
// reads files itself, exactly the way findText.ts's own readLinesCached
// does: fs.readFileSync the walker's own `absPath`, decodeTextBuffer to
// reject binary/undecodable content, never a path the walker itself would
// not have produced).
//
// Cache invalidation: built once per workspace root, kept across calls
// UNLESS the walker's own file COUNT has changed since the cached build
// (a cheap, already-computed signal -- no new stat/hash pass). This is
// still not a full generation token (a same-count edit to an existing
// file's content is not detected), a deliberate, documented simplification
// for a default-OFF flag whose only consumer re-walks the whole repo on
// every call anyway.
import * as fs from "node:fs";
import { walkCodeFiles, type FoundFile } from "../../tools/walkRepo.js";
import { decodeTextBuffer } from "../../util/textDecode.js";
import { decomposeIdentifier } from "./tokenize.js";
import { buildJaBridgeVocabulary, MAX_VOCAB_WORDS, type JaBridgeVocabulary } from "./jaQueryBridge.js";

const MIN_VOCAB_WORD_LEN = 3;

/** Bounds the content scan's own file-read fan-out (design cap) -- independent of MAX_VOCAB_WORDS, which bounds the resulting WORD count. */
const MAX_CONTENT_FILES = 5_000;
/** Files larger than this are skipped for content scanning outright (design cap) -- a generated/vendored/data file this large is unlikely to be hand-authored source anyway. */
const MAX_CONTENT_FILE_BYTES = 256 * 1024;
/** Wall-clock budget for the WHOLE content scan (design cap); on exhaustion, keep whatever was gathered and mark the vocabulary partial rather than block the caller. */
const CONTENT_BUILD_BUDGET_MS = 1_500;
/** A plain identifier span in source text -- letters/digits/underscore/$, min length 3 (the design's regex, run without the "no digit start" refinement extractIdentifiers-style code uses elsewhere: this is a cheap best-effort scan, not a tokenizer). */
const CONTENT_IDENTIFIER_RE = /[A-Za-z_$][A-Za-z0-9_$]{2,}/g;

interface CachedVocab {
  readonly vocab: JaBridgeVocabulary;
  readonly fileCount: number;
}

const workspaceVocabCache = new Map<string, CachedVocab>();

/** Split every path segment of `relPath` on camelCase/snake/kebab boundaries into lowercase word candidates (length >= 3) -- the same decomposition tokenize.ts already applies to identifiers, reused here for path segments/basenames. */
function wordsFromRelPath(relPath: string): string[] {
  const out: string[] = [];
  for (const segment of relPath.split("/")) {
    const dot = segment.lastIndexOf(".");
    const stem = dot > 0 ? segment.slice(0, dot) : segment;
    for (const w of decomposeIdentifier(stem)) {
      if (w.length >= MIN_VOCAB_WORD_LEN) out.push(w);
    }
  }
  return out;
}

/**
 * Read and decompose one file's identifiers into `counts`, bumping the
 * frequency of each. Never throws: a stat/read/decode failure for one file
 * is silently skipped (that file just contributes nothing), matching the
 * "never throw from the hook" requirement -- this is already several
 * layers away from the hook itself, but the property must hold end to end.
 */
function addContentWords(absPath: string, counts: Map<string, number>, maxContentFileBytes: number): void {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(absPath);
  } catch {
    return;
  }
  if (!stat.isFile() || stat.size > maxContentFileBytes) return;
  let buf: Buffer;
  try {
    buf = fs.readFileSync(absPath);
  } catch {
    return;
  }
  const text = decodeTextBuffer(buf);
  if (text === null) return; // binary/undecodable -- not a text file
  const matches = text.match(CONTENT_IDENTIFIER_RE) ?? [];
  for (const m of matches) {
    for (const w of decomposeIdentifier(m)) {
      if (w.length < MIN_VOCAB_WORD_LEN) continue;
      counts.set(w, (counts.get(w) ?? 0) + 1);
    }
  }
}

/**
 * Combine ALWAYS-kept path words with frequency-ranked content words, never
 * exceeding `cap` total. Path words are never dropped for being over the
 * cap (design requirement); when path words alone reach or exceed `cap`
 * there is simply no room left for any content word. Content words are
 * chosen by descending frequency, alphabetically tiebroken for
 * determinism.
 */
function selectVocabularyWords(
  pathWords: ReadonlySet<string>,
  contentCounts: ReadonlyMap<string, number>,
  cap: number,
): string[] {
  const result = new Set<string>(pathWords);
  if (result.size >= cap) return [...result];
  const remaining = cap - result.size;
  const contentOnly = [...contentCounts.entries()].filter(([w]) => !result.has(w));
  contentOnly.sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  for (const [w] of contentOnly.slice(0, remaining)) result.add(w);
  return [...result];
}

interface VocabBuildOptions {
  readonly maxContentFiles: number;
  readonly maxContentFileBytes: number;
  readonly contentBuildBudgetMs: number;
  readonly maxVocabWords: number;
}

const PRODUCTION_OPTIONS: VocabBuildOptions = {
  maxContentFiles: MAX_CONTENT_FILES,
  maxContentFileBytes: MAX_CONTENT_FILE_BYTES,
  contentBuildBudgetMs: CONTENT_BUILD_BUDGET_MS,
  maxVocabWords: MAX_VOCAB_WORDS,
};

function buildVocabFromFiles(files: readonly FoundFile[], opts: VocabBuildOptions): JaBridgeVocabulary {
  // Sorted file order first, so the derived vocabulary (and therefore every
  // downstream keyToWords ordering, and which files are scanned first under
  // a budget/cap) is independent of the OS's own directory-listing order --
  // determinism must not depend on readdir().
  const sortedFiles = [...files].sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));

  const pathWords = new Set<string>();
  for (const f of sortedFiles) for (const w of wordsFromRelPath(f.relPath)) pathWords.add(w);

  const contentCounts = new Map<string, number>();
  const startedAt = Date.now();
  let filesScanned = 0;
  let partial = false;
  for (const f of sortedFiles) {
    if (filesScanned >= opts.maxContentFiles) {
      partial = filesScanned < sortedFiles.length;
      break;
    }
    if (Date.now() - startedAt > opts.contentBuildBudgetMs) {
      partial = true;
      break;
    }
    addContentWords(f.absPath, contentCounts, opts.maxContentFileBytes);
    filesScanned += 1;
  }

  const words = selectVocabularyWords(pathWords, contentCounts, opts.maxVocabWords);
  if (words.length >= opts.maxVocabWords) partial = true; // word cap itself also cut something off

  return buildJaBridgeVocabulary(words, { partial });
}

/**
 * Get (building and caching on first use, or when the workspace's file
 * count has changed) the `JaBridgeVocabulary` for `workspace`. Cheap on a
 * cache hit: a walk (for the file-count invalidation check) plus a Map
 * lookup -- no re-scan. The first build per workspace/generation walks the
 * repo once for path words, then reads up to MAX_CONTENT_FILES files
 * (bounded further by CONTENT_BUILD_BUDGET_MS wall-clock time and
 * MAX_CONTENT_FILE_BYTES per file) for content words, keeping the most
 * frequent content words plus every path word when the combined total
 * would exceed MAX_VOCAB_WORDS. `vocab.partial` is true iff the file cap,
 * word cap, or wall-clock budget cut the scan short.
 */
export function getWorkspaceJaBridgeVocabulary(workspace: string): JaBridgeVocabulary {
  const files: FoundFile[] = walkCodeFiles(workspace, {});
  const cached = workspaceVocabCache.get(workspace);
  if (cached && cached.fileCount === files.length) return cached.vocab;

  const vocab = buildVocabFromFiles(files, PRODUCTION_OPTIONS);
  workspaceVocabCache.set(workspace, { vocab, fileCount: files.length });
  return vocab;
}

/**
 * Test-only: build a vocabulary for `workspace` with explicit (typically
 * tiny) bounds, bypassing the module cache entirely -- lets a spec exercise
 * the file-cap/word-cap/wall-clock-budget/partial logic deterministically,
 * without needing thousands of real files or a mocked clock. Never called
 * from production code (getWorkspaceJaBridgeVocabulary above is the only
 * production entry point, and always uses PRODUCTION_OPTIONS).
 */
export function buildWorkspaceVocabForTest(workspace: string, opts: Partial<VocabBuildOptions> = {}): JaBridgeVocabulary {
  const files = walkCodeFiles(workspace, {});
  return buildVocabFromFiles(files, { ...PRODUCTION_OPTIONS, ...opts });
}

/** Test-only: drop every cached vocabulary so a spec can rebuild from a fresh fixture tree. Never called from production code. */
export function resetJaBridgeWorkspaceVocabCacheForTest(): void {
  workspaceVocabCache.clear();
}
