// Plain data only — no meta envelope, no 'tokenlighten:meta' wrappers.
// Reason: docs/00-postmortem.md §2.2

/**
 * Index persistence module.
 * Handles reading/writing the SourceIndexManifestV1 JSON cache.
 */

import { promises as fs, realpathSync } from "node:fs";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";

import type { ChunkKind, IndexedChunkV1, SymbolKind } from "./chunker.js";
import { extractChunks } from "./chunker.js";
import { enumerateFiles, extractSymbolsRegex, languageForPath, languageForPathWithContent } from "./graph.js";
import { createIgnoreMatcher } from "./ignore.js";
import { hashContent, buildDirectoryDigests } from "./merkle.js";
import { writeGraphIfStale } from "./graphBuilder.js";
import { assertSafeWriteTarget } from "./safeWritePath.js";
import { readRegularFileUtf8 } from "./readGuard.js";
import { writeJsonAtomic, type AtomicJsonWriteHooks } from "./atomicJson.js";
import { readPublishJournal, writePendingPublishJournal, clearPublishJournal } from "./publishJournal.js";
import { runConsistencyScan, consistencyScanEnabledFromEnv } from "./consistencyScan.js";

export type { ChunkKind, IndexedChunkV1, SymbolKind };

const execFileAsync = promisify(execFile);

const _require = createRequire(import.meta.url);
const PKG_VERSION: string = (_require("../package.json") as { version: string }).version;

// Bump this whenever a change to the regex-based extraction pipeline
// (extractSymbolsRegex's LANG_PATTERNS / comment-and-string filtering in
// graph.ts, or symbolKindFromSignature's kind derivation below) should
// invalidate every cached per-file symbol entry, independent of whether
// PKG_VERSION itself has moved. Without this, a workspace whose files
// haven't changed keeps serving symbols extracted by the OLD logic
// indefinitely (see "Discard cache if engineVersion changed" below) — a
// package.json version bump is a separate, release-level decision (folded
// into the v0.10.0 version-bump commit per
// DESIGN-v0.10-expansion-plan-reconciliation.md §7's version-identity
// note), not something every extraction-logic fix should have to wait for
// or trigger on its own.
// Bumped 1 -> 2 (2026-08-20): extractSymbolsRegex's match-index handling
// no longer lets a declaration's line/endLine/signature land on a
// preceding blank line (see extractSymbolsRegex's inline comment in
// graph.ts) — every cached symbol entry produced by the old logic must
// be invalidated.
const SYMBOL_EXTRACTION_REVISION = "2";

// The actual cache-key value: PKG_VERSION plus the extraction-pipeline
// revision above, composed once so the discard-check and the
// freshly-built-manifest assembly can never drift apart from each other.
const CURRENT_ENGINE_VERSION = `${PKG_VERSION}+se${SYMBOL_EXTRACTION_REVISION}`;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SourceIndexManifestV1 {
  version: 1;
  engineVersion: string;
  repoRootRealpath: string;
  ignoreHash: string;
  builtFromCommit: string;
  rootHash: string;
  /**
   * V11-09 (Incremental Index / Graph Update v2): monotonic generation
   * counter, bumped exactly when `rootHash` changes relative to whichever
   * seed manifest (disk or in-process memo) fed this build — an unchanged
   * reload keeps the same generation. Optional/absent on a manifest built
   * before this field existed (treated as 0 everywhere it is read); a
   * fresh build always stamps a real number. graphBuilder.ts's TlGraph
   * carries the SAME value through unchanged, so the pair can be checked
   * for both-ends consistency, and publishJournal.ts uses it to detect a
   * crash between the manifest and graph halves of one publish. See
   * publishJournal.ts's doc comment for the full design.
   */
  generation?: number;
  /** key = workspace-relative POSIX path */
  files: Record<string, IndexedFileV1>;
  directories: Record<string, DirectoryDigestV1>;
}

/**
 * V11-09: per-file extraction outcome. Absent/undefined means "ok" (every
 * manifest entry written before this field existed) — never treat absence
 * as "unknown/worse than ok", only as the pre-V11-09 default. See
 * `getManifestCoverageSummary` for the aggregate disclosure this feeds.
 *
 *   - "ok": extractSymbolsRegex + extractChunks both completed normally
 *     (extractSymbolsRegex's OWN internal try/catch already degrades a
 *     parser throw there to an empty symbol list without this status, so
 *     "ok" can still mean zero symbols for a genuinely symbol-free file).
 *   - "quarantined": chunk/symbol extraction THREW for this file's content;
 *     the file is isolated as file-level partial (symbols/chunks empty,
 *     contentSha256 still recorded) instead of aborting the whole build.
 *     Re-attempted automatically the next time this file's content hash
 *     changes (same content-hash gate every other cache entry already uses
 *     — no special-casing needed for that half).
 *   - "failed": the file's bytes could not even be READ (permissions, a
 *     transient I/O error, ...). Pre-V11-09 this silently OMITTED the file
 *     from the manifest entirely — indistinguishable from a deletion, the
 *     exact "false absence" this workstream exists to close. Now the path
 *     always keeps an entry (the previous cached one if any, else a
 *     minimal placeholder) stamped "failed" instead of vanishing.
 */
export type IndexedFileParseStatus = "ok" | "quarantined" | "failed";

export interface IndexedFileV1 {
  path: string;
  language: string;
  sizeBytes: number;
  mtimeMs: number;
  contentSha256: string;
  symbols: IndexedSymbolV1[];
  chunks: IndexedChunkV1[];
  /** symbolName → count */
  outgoingSymbolRefs: Record<string, number>;
  /** V11-09 — see IndexedFileParseStatus. Absent means "ok". */
  parseStatus?: IndexedFileParseStatus;
}

export interface IndexedSymbolV1 {
  name: string;
  kind: SymbolKind;
  signature: string;
  lineStart: number;
  lineEnd: number;
  chunkIds: string[];
}

export interface DirectoryDigestV1 {
  path: string;
  childHashes: Record<string, string>;
  hash: string;
}

// ---------------------------------------------------------------------------
// Coverage disclosure (V11-09)
// ---------------------------------------------------------------------------

/**
 * Aggregate parse-status disclosure over a manifest. CRITICAL INVARIANT
 * this accessor exists to serve: partial coverage (any quarantined or
 * failed file) must be VISIBLE to a consumer, so nothing downstream ever
 * claims completeness or absence over a file this manifest could not fully
 * index. `isPartial` is the single boolean a caller should gate
 * complete/absence claims on; `quarantinedPaths`/`failedPaths` are the
 * exact disclosure a caller needs to name what it cannot vouch for.
 *
 * Wire-level consumption (surfacing this in a tool response) is a later
 * wave's job — this accessor is the shape that wave consumes; it does not
 * itself touch any response.
 */
export interface ManifestCoverageSummary {
  totalFiles: number;
  ok: number;
  quarantined: number;
  failed: number;
  isPartial: boolean;
  quarantinedPaths: string[];
  failedPaths: string[];
}

export function getManifestCoverageSummary(manifest: SourceIndexManifestV1): ManifestCoverageSummary {
  let ok = 0;
  const quarantinedPaths: string[] = [];
  const failedPaths: string[] = [];
  for (const file of Object.values(manifest.files)) {
    if (file.parseStatus === "quarantined") quarantinedPaths.push(file.path);
    else if (file.parseStatus === "failed") failedPaths.push(file.path);
    else ok++;
  }
  quarantinedPaths.sort();
  failedPaths.sort();
  return {
    totalFiles: Object.keys(manifest.files).length,
    ok,
    quarantined: quarantinedPaths.length,
    failed: failedPaths.length,
    isPartial: quarantinedPaths.length > 0 || failedPaths.length > 0,
    quarantinedPaths,
    failedPaths,
  };
}

// ---------------------------------------------------------------------------
// Cache path
// ---------------------------------------------------------------------------

export const CACHE_PATH = ".tokenlighten/cache/source-index.v1.json";
export const MAX_CACHE_MANIFEST_BYTES = 32 * 1024 * 1024;

export function getCachePath(root: string): string {
  return join(root, ".tokenlighten", "cache", "source-index.v1.json");
}

// ---------------------------------------------------------------------------
// In-process manifest memo
// ---------------------------------------------------------------------------
//
// A server process asks for the same workspace's index many times per task
// (several symbol searches inside one locate, follow-up locates inside one
// pack). The on-disk cache alone cannot absorb that: it re-reads and
// re-validates every file per call, and on repos whose manifest exceeds
// MAX_CACHE_MANIFEST_BYTES it never persists at all, silently turning every
// call into a full rebuild. Memoize the last built manifests keyed by the
// workspace realpath and revalidate with a stat fingerprint (path+size+mtime
// of every enumerated file) — the same trust level as the disk fast path,
// without re-reading file contents. The memoized manifest is returned as a
// shared object; callers treat manifests as read-only.
const MANIFEST_MEMO_MAX_WORKSPACES = 2;

interface ManifestMemoEntry {
  ignoreHash: string;
  statFingerprint: string;
  manifest: SourceIndexManifestV1;
}

const manifestMemo = new Map<string, ManifestMemoEntry>();

/**
 * V11-09: per-root invalidation epoch. See invalidateCachedWorkspaceFiles
 * and the epoch check near the end of loadOrBuildSourceIndex for the race
 * this closes — a build that is in flight while an invalidation for the
 * SAME root arrives must not un-invalidate the memo by publishing its own
 * (possibly pre-invalidation) result over it once it finishes.
 */
const manifestMemoEpoch = new Map<string, number>();

/** Reset the in-process manifest memo (for tests). */
export function resetManifestMemoForTest(): void {
  manifestMemo.clear();
  manifestMemoEpoch.clear();
}

// A value statFingerprintOf(...) can never legitimately produce — it always
// returns a hashContent hex digest (non-empty, fixed length). Setting a memo
// entry's statFingerprint to this sentinel forces the "whole manifest still
// matches" shortcut below to miss on the NEXT loadOrBuildSourceIndex call for
// that workspace, without discarding the memoized manifest itself: it still
// seeds the per-file loop (the "stale memo still beats an absent disk cache"
// path below) for every OTHER, unaffected file.
const INVALIDATED_STAT_FINGERPRINT = "";

/**
 * V10-10: invalidate the in-process manifest memo for a workspace after a
 * successful write (edit, create, rollback-restore) lands on disk.
 *
 * Why this is needed even with the P1.4 content-hash fast-path gate above:
 * that gate only runs once the per-file loop is entered. The memo's own
 * "whole manifest still matches" shortcut (below, gated by a stat
 * fingerprint over every enumerated file's path+size+mtime) can return the
 * ENTIRE previous manifest WITHOUT entering that loop at all — so a write
 * whose mtime happens to collide with what was already on disk (forced via
 * fs.utimesSync in the regression test; achievable in practice on a
 * coarse-grained filesystem timestamp, or two writes landing in the same
 * clock tick) would otherwise serve stale symbols/chunks indefinitely for
 * that file, even though every OTHER caller of loadOrBuildSourceIndex reads
 * fresh bytes off disk. Write-path call sites (packages/mcp-server/src/
 * write/*.ts) call this after every successful apply so the very next read
 * in this process sees the new content, instead of depending on mtime
 * having actually changed.
 *
 * `root` is resolved through the same realpath normalization
 * loadOrBuildSourceIndex uses for its memo key, so callers may pass either
 * the raw workspace root or an already-resolved one. `relPaths` is accepted
 * for future surgical narrowing and caller-side symmetry with the write
 * path's own touched-file list; whether or not it is given (or matches a
 * currently-cached entry), poisoning the fingerprint alone is sufficient —
 * see the comment above — so a caller unsure of the exact relative path
 * form (POSIX vs platform separators) still gets a correct invalidation.
 */
export function invalidateCachedWorkspaceFiles(root: string, relPaths?: string[]): void {
  let rootKey: string;
  try {
    rootKey = realpathSync(root);
  } catch {
    rootKey = root;
  }

  // V11-09: bump this root's invalidation epoch UNCONDITIONALLY, before the
  // entry===undefined early-return below. The race this closes is with a
  // build that is CURRENTLY IN FLIGHT (has not published to manifestMemo
  // yet, so `manifestMemo.get(rootKey)` may still be undefined, or may
  // still hold the OLD pre-write entry) racing this invalidation's write.
  // loadOrBuildSourceIndex captures the epoch it saw at the START of a
  // build and re-checks it right before publishing at the end; a mismatch
  // means an invalidation landed sometime during this build, so its result
  // (which may have read this exact file's PRE-write bytes) must not
  // overwrite/erase what this call is asking the memo to forget. This must
  // fire even with no existing entry — the thing being protected is a
  // FUTURE publish, not the current entry.
  manifestMemoEpoch.set(rootKey, (manifestMemoEpoch.get(rootKey) ?? 0) + 1);

  const entry = manifestMemo.get(rootKey);
  if (entry === undefined) return;

  let manifest = entry.manifest;
  if (relPaths !== undefined && relPaths.length > 0) {
    // Defense in depth: drop the named entries from the SEED manifest too
    // (a shallow copy — manifests are shared/read-only, see the memo's own
    // doc comment above), so even a caller of loadOrBuildSourceIndex that
    // bypassed the P1.4 gate somehow still cannot resurrect this exact
    // stale per-file entry from the memo-as-seed path.
    const files = { ...manifest.files };
    let changed = false;
    for (const relPath of relPaths) {
      if (relPath in files) {
        delete files[relPath];
        changed = true;
      }
    }
    if (changed) manifest = { ...manifest, files };
  }

  // Re-insert (delete then set, not a plain set-on-existing-key) so this
  // workspace moves to the MRU end of the memo's insertion-order LRU —
  // matching the recency refresh the whole-match hit path already does.
  manifestMemo.delete(rootKey);
  manifestMemo.set(rootKey, {
    ignoreHash: entry.ignoreHash,
    statFingerprint: INVALIDATED_STAT_FINGERPRINT,
    manifest,
  });
}

function statFingerprintOf(
  files: readonly { path: string; sizeBytes: number; mtimeMs: number }[],
): string {
  const lines = files.map((f) => `${f.path}\u0000${f.sizeBytes}\u0000${f.mtimeMs}`).sort();
  return hashContent(Buffer.from(lines.join("\n")));
}

// ---------------------------------------------------------------------------
// JSON serialization with sorted keys
// ---------------------------------------------------------------------------

function sortKeys(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value; // preserve array order
  const obj = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    sorted[key] = sortKeys(obj[key]);
  }
  return sorted;
}

// ---------------------------------------------------------------------------
// Load / write manifest
// ---------------------------------------------------------------------------

/**
 * Load the cached manifest from disk.
 * Returns null on any error (missing file, corrupt JSON, shape mismatch).
 */
export async function loadManifest(root: string): Promise<SourceIndexManifestV1 | null> {
  const cachePath = getCachePath(root);
  try {
    assertSafeWriteTarget(root, cachePath);
    const stat = await fs.stat(cachePath);
    if (!stat.isFile() || stat.size > MAX_CACHE_MANIFEST_BYTES) return null;
    const raw = await readRegularFileUtf8(cachePath, MAX_CACHE_MANIFEST_BYTES);
    if (Buffer.byteLength(raw, "utf8") > MAX_CACHE_MANIFEST_BYTES) return null;
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      return null;
    }
    if (
      data === null ||
      typeof data !== "object" ||
      (data as Record<string, unknown>).version !== 1 ||
      typeof (data as Record<string, unknown>).engineVersion !== "string" ||
      typeof (data as Record<string, unknown>).files !== "object"
    ) {
      return null;
    }
    return data as SourceIndexManifestV1;
  } catch {
    return null;
  }
}

/**
 * Write the manifest to the cache file atomically.
 * Creates parent directories as needed.
 */
export async function writeManifest(
  root: string,
  manifest: SourceIndexManifestV1,
  hooks?: AtomicJsonWriteHooks,
): Promise<void> {
  const cachePath = getCachePath(root);
  // Compact (non-pretty) canonical JSON: readers only ever JSON.parse this
  // file, and pretty-printing a repo-scale manifest roughly doubles both the
  // serialize time and the on-disk bytes counted against
  // MAX_CACHE_MANIFEST_BYTES.
  const serialized = JSON.stringify(sortKeys(manifest));
  if (Buffer.byteLength(serialized, "utf8") > MAX_CACHE_MANIFEST_BYTES) {
    throw new Error("source index manifest exceeds the 32 MiB cache limit");
  }
  // writeJsonAtomic (atomicJson.ts) owns the safety checks and the
  // write-tmp-then-rename sequence — see its doc comment for why this is
  // the one seam every skeleton-engine on-disk artifact publishes through.
  await writeJsonAtomic(
    root,
    cachePath,
    serialized,
    (dir) => join(dir, `source-index.v1.${process.pid}.${Date.now()}.tmp`),
    hooks,
  );
}

// ---------------------------------------------------------------------------
// Kind mapping helper
// ---------------------------------------------------------------------------

// Declaring keywords LANG_PATTERNS uses to capture a symbol's name, grouped
// by the SymbolKind they map to.
const CLASS_FAMILY_KEYWORDS = new Set(["class", "interface", "struct", "enum", "trait"]);
const BINDING_KEYWORDS = new Set(["const", "let", "var"]);
const DECLARING_KEYWORD_RE = /\b(class|interface|struct|enum|trait|type|const|let|var)\b/g;

function kindForKeyword(keyword: string): SymbolKind {
  if (CLASS_FAMILY_KEYWORDS.has(keyword)) return "class";
  if (keyword === "type") return "type";
  if (BINDING_KEYWORDS.has(keyword)) return "const";
  return "function";
}

// The declaring-keyword match closest to (and strictly before) index `at`
// in `text`, or null if none is present there. matchAll clones the regex
// per call, so DECLARING_KEYWORD_RE's shared `g` state is never at risk.
function lastDeclaringKeywordBefore(text: string, at: number): string | null {
  let last: string | null = null;
  for (const m of text.matchAll(DECLARING_KEYWORD_RE)) {
    if (m.index >= at) break;
    last = m[1]!;
  }
  return last;
}

// The first declaring-keyword match in `text`, or null if none is present.
function firstDeclaringKeyword(text: string): string | null {
  for (const m of text.matchAll(DECLARING_KEYWORD_RE)) return m[1]!;
  return null;
}

/**
 * Derive a symbol's `kind` from its raw declaration-line signature text.
 *
 * Previously this scanned the WHOLE line for the first class-family
 * keyword (class/interface/struct/enum/trait) anywhere in it, which
 * misclassified shapes like `export const Base = class { ... }` as
 * kind:"class" — "class" only appears there as part of the initializer
 * EXPRESSION assigned to Base, not as the keyword that actually declares
 * Base. `const` is.
 *
 * Fix: locate `name` — the identifier LANG_PATTERNS actually captured —
 * inside `signature`, then prefer the declaring keyword STRUCTURALLY
 * closest to it:
 *  1. The nearest keyword BEFORE `name`, when there is one, wins UNLESS
 *     it's "type" — every other leading keyword is unambiguous on its own
 *     (`export const Base` -> "const" governs, even though "class" appears
 *     later on the same line as part of the value expression; `class`,
 *     `interface`, `enum`, `struct`, `trait` are equally final).
 *  2. "type" alone is ambiguous — TypeScript's `type Y = ...` (always an
 *     alias) and Go's `type Foo struct { ... }` / `type Foo interface {
 *     ... }` (a named type DEFINITION, not an alias) both start this way.
 *     Disambiguate by looking immediately AFTER `name`, before any `=`: a
 *     class-family keyword found there (Go's "struct"/"interface")
 *     continues the SAME declaration clause and refines "type" to "class";
 *     TypeScript's alias form always hits `=` first (nothing to find
 *     before it), so it stays "type".
 *  3. No keyword before OR after `name` (nothing but the identifier and
 *     its parameter list) means "function" — matches every
 *     function/def/fn/func pattern, none of which contain a
 *     class/type/binding keyword at all.
 *
 * Known limits: identifies `name`'s declaration site as its FIRST
 * whole-word occurrence in the signature line — exactly where every
 * LANG_PATTERNS capture position actually is; a name that legitimately
 * recurs earlier on the SAME line before its own declaration (not a shape
 * any current pattern produces) is not specifically handled.
 */
function symbolKindFromSignature(signature: string, name: string): SymbolKind {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const nameMatch = new RegExp(`\\b${escapedName}\\b`).exec(signature);
  if (!nameMatch) {
    // Defensive fallback — `name` always comes from a match against this
    // exact `signature` line in practice, but never regress to throwing or
    // silently misreporting if that ever stops being true.
    const keyword = firstDeclaringKeyword(signature);
    return keyword ? kindForKeyword(keyword) : "function";
  }

  const before = lastDeclaringKeywordBefore(signature, nameMatch.index);
  // Every leading keyword except "type" is unambiguous on its own — return
  // immediately so a later, unrelated keyword (e.g. an initializer's
  // "class") never gets consulted at all.
  if (before && before !== "type") return kindForKeyword(before);

  // "type" (or no leading keyword at all) needs the same-clause lookahead:
  // a class-family keyword before any "=" refines a bare "type" to "class"
  // (Go's struct/interface continuation); for every other language this
  // finds nothing (function patterns have no "=" or class-family word
  // after the name; TS's type-alias pattern always has "=" immediately
  // after, so `sameClause` is empty before it).
  const after = signature.slice(nameMatch.index + name.length);
  const eqIdx = after.indexOf("=");
  const sameClause = eqIdx === -1 ? after : after.slice(0, eqIdx);
  const afterKeyword = firstDeclaringKeyword(sameClause);
  if (afterKeyword) return kindForKeyword(afterKeyword);

  if (before) return kindForKeyword(before); // bare "type", e.g. `type Y = string;`

  return "function";
}

// ---------------------------------------------------------------------------
// Symbol-line validation (P1.3 Skeleton Correctness Gate)
// ---------------------------------------------------------------------------

/**
 * Validate that each cached symbol's name is still findable (word-boundary
 * match) within ±2 lines of its advertised lineStart/lineEnd range.
 *
 * Returns true if all symbols validate (or symbols array is empty).
 * Returns false if any symbol cannot be found on its claimed lines.
 *
 * Deterministic — no Date.now / Math.random.
 */
export function validateCachedSymbols(file: IndexedFileV1, content: string): boolean {
  if (file.symbols.length === 0) return true;

  const lines = content.split(/\r?\n/);

  for (const sym of file.symbols) {
    const lo = Math.max(0, sym.lineStart - 2);
    const hi = Math.min(lines.length, sym.lineEnd + 2);
    const needle = sym.name;

    // Build a word-boundary regex for this symbol name (escape special chars).
    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`\\b${escaped}\\b`);

    let found = false;
    for (let i = lo; i < hi; i++) {
      if (re.test(lines[i] ?? "")) {
        found = true;
        break;
      }
    }
    if (!found) return false;
  }
  return true;
}

/**
 * V11-09: strip a stale "failed" parseStatus before a cached entry is
 * reused via the fast or mid path. "failed" specifically means "the bytes
 * could not be READ last time" (see IndexedFileParseStatus) — reaching the
 * fast/mid path at all is only possible AFTER a read for THIS call already
 * succeeded (both paths run after `raw = await readRegularFileUtf8(...)`
 * above), so carrying a "failed" status forward here would be actively
 * WRONG, not merely stale: it would keep disclosing "could not read this
 * file" about a file this exact call just finished reading. "quarantined"
 * is a DIFFERENT status (bytes read fine, PARSING/extraction failed) and a
 * property of the CONTENT, not of read-availability — correctly preserved
 * across a content-unchanged reuse (re-parsing unchanged content would
 * only fail again; see coverageDisclosure.spec.ts's "an UNCHANGED
 * quarantined file is NOT re-attempted on every reload").
 *
 * Cheap on the common case (no parseStatus, or "quarantined"): returns the
 * SAME object reference unchanged, no allocation, so the fast path's
 * `fileEntries[f.path] = cached` direct-reuse identity is preserved for
 * every entry except the rare one actually recovering from "failed".
 */
function withoutStaleFailedStatus(entry: IndexedFileV1): IndexedFileV1 {
  if (entry.parseStatus !== "failed") return entry;
  const { parseStatus: _drop, ...rest } = entry;
  return rest;
}

/**
 * V11-09: opportunistic bounded consistency scan, default OFF behind
 * TL_INDEX_CONSISTENCY_SCAN. Runs synchronously as part of THIS call —
 * never a background timer — and is itself bounded (count/duration), so
 * enabling it cannot turn one call into an unbounded scan. See
 * consistencyScan.ts for the mechanics and what residual it exists to
 * catch.
 *
 * CALLED FROM TWO PLACES, not just the end of a full rebuild: the
 * manifestMemo whole-match shortcut is an EARLY RETURN that skips the
 * entire per-file loop and every step after it — which means it is
 * PRECISELY the path that lets a same-stat content swap without a
 * corresponding invalidateCachedWorkspaceFiles call (the "dropped
 * invalidation" residual) slip through unnoticed, since nothing on that
 * path ever re-reads or re-hashes any file. A scan that only ran at the
 * end of a full rebuild would never fire on an unchanged-looking workspace
 * hitting that exact shortcut — which is the majority of calls once a
 * workspace is warm — so it would provide close to zero real protection
 * despite being "wired in". Calling it from both exits closes that gap.
 */
async function runOpportunisticConsistencyScan(
  root: string,
  manifest: SourceIndexManifestV1,
  opts: { ignoreHash: string; __testHooks?: IndexFaultHooksForTest },
  rootKey: string,
  epochAtStart: number,
  warnings: string[],
): Promise<SourceIndexManifestV1> {
  if (!consistencyScanEnabledFromEnv()) return manifest;
  try {
    const { manifest: healed, result } = await runConsistencyScan(root, manifest);
    if (result.dropped === 0) return manifest;
    try {
      await writeManifest(root, healed, { beforeRename: opts.__testHooks?.beforeManifestRename });
      const epochNow = manifestMemoEpoch.get(rootKey) ?? 0;
      if (epochNow === epochAtStart) {
        // NEVER cache `healed` under the ORIGINAL statFingerprint: that
        // fingerprint's whole definition is "matches the CURRENT on-disk
        // path+size+mtime of every enumerated file" — including the ones
        // the scan just dropped, which are (per this scan's own contract)
        // still physically present on disk with unchanged stat, just with
        // untrustworthy recorded content. Reusing it would let the very
        // NEXT call's whole-match shortcut re-match on that same
        // unchanged disk state and return `healed` again — a manifest
        // that is now PERMANENTLY missing those files, since nothing
        // would ever re-enter the per-file loop that could re-add them.
        // Poisoning it (the same sentinel invalidateCachedWorkspaceFiles
        // uses) forces the next call to miss the shortcut and go through
        // real per-file re-validation, where a dropped-but-still-present
        // file is correctly treated as new and re-extracted.
        manifestMemo.set(rootKey, {
          ignoreHash: opts.ignoreHash,
          statFingerprint: INVALIDATED_STAT_FINGERPRINT,
          manifest: healed,
        });
      }
    } catch (e) {
      warnings.push(`skeleton-index: failed to persist consistency-scan repair: ${String(e)}`);
    }
    warnings.push(
      `skeleton-index: consistency scan dropped ${result.dropped} stale entr${result.dropped === 1 ? "y" : "ies"}`,
    );
    return healed;
  } catch (e) {
    warnings.push(`skeleton-index: consistency scan failed: ${String(e)}`);
    return manifest;
  }
}

// ---------------------------------------------------------------------------
// loadOrBuildSourceIndex
// ---------------------------------------------------------------------------

/**
 * Load the source index from cache or rebuild it from scratch.
 *
 * Returns the manifest plus stats:
 *   - reused: number of file entries reused from cache (fast or mid path)
 *   - reparsed: number of file entries that were re-extracted from source
 *   - cacheRebuildReasons: list of reasons why cache entries were rebuilt
 */
/**
 * V11-09: test-only fault injection hooks. Never set outside this package's
 * own specs (see `__tests__/helpers/faultInjector.ts`) — mirrors the
 * `__quotaOverridesForTest` naming convention mcp-server's artifactEdit.ts
 * already uses for the same purpose.
 */
export interface IndexFaultHooksForTest {
  /** Force this file's extraction to throw, simulating a parser crash. */
  forceExtractionCrash?: (relPath: string) => boolean;
  /**
   * Fires once per file, early in the per-file loop, well before this
   * build's own publish decision. A test uses this as the seam to run a
   * SYNCHRONOUS invalidateCachedWorkspaceFiles call "concurrently" with an
   * in-flight build — single-threaded JS has no real concurrency, so this
   * hook stands in for "another async task got a turn on the event loop
   * and completed its invalidate call before this build finished."
   */
  midBuild?: (relPath: string) => void;
  /** Fires after the manifest's tmp file is durably written, before rename. */
  beforeManifestRename?: () => void;
  /** Fires after the graph's tmp file is durably written, before rename. */
  beforeGraphRename?: () => void;
  /** Fires after the publish journal's tmp file is durably written, before rename. */
  beforeJournalRename?: () => void;
}

export async function loadOrBuildSourceIndex(
  root: string,
  opts: {
    noCache?: boolean;
    commit?: string;
    ignoreHash: string;
    extraIgnorePatterns?: string[];
    __testHooks?: IndexFaultHooksForTest;
  },
): Promise<{
  manifest: SourceIndexManifestV1;
  warnings: string[];
  reused: number;
  reparsed: number;
  cacheRebuildReasons: string[];
}> {
  const warnings: string[] = [];
  const cacheRebuildReasons: string[] = [];
  let reused = 0;
  let reparsed = 0;

  const rootKey = await fs.realpath(root).catch(() => root);
  // V11-09: snapshot this root's invalidation epoch BEFORE any await below
  // can yield to a concurrent invalidateCachedWorkspaceFiles call. Compared
  // again right before this build publishes to manifestMemo — see that
  // check's own comment for the race this closes.
  const epochAtStart = manifestMemoEpoch.get(rootKey) ?? 0;

  // 1) Try to load cached manifest.
  let cachedManifest: SourceIndexManifestV1 | null = null;
  if (!opts.noCache) {
    cachedManifest = await loadManifest(root);
    // Discard cache if ignoreHash changed.
    if (cachedManifest !== null && cachedManifest.ignoreHash !== opts.ignoreHash) {
      cachedManifest = null;
      cacheRebuildReasons.push("ignore-hash");
    }
    // Discard cache if engineVersion changed.
    if (cachedManifest !== null && cachedManifest.engineVersion !== CURRENT_ENGINE_VERSION) {
      cachedManifest = null;
      cacheRebuildReasons.push("engine-version");
    }
    // P1.3: Discard cache if repoRootRealpath doesn't match current root (foreign cache).
    if (cachedManifest !== null) {
      if (cachedManifest.repoRootRealpath !== rootKey) {
        cachedManifest = null;
        cacheRebuildReasons.push("foreign-cache");
      }
    }
  }

  // 2) Enumerate files.
  const matcher = await createIgnoreMatcher(root, opts.extraIgnorePatterns);
  const files = await enumerateFiles(root, matcher);

  // 2b) In-process memo: an identical stat fingerprint (and compatible
  // options) means the previously built manifest is still current — skip the
  // per-file reads/validation and the cache/graph writes outright.
  const diskManifest = cachedManifest;
  const statFingerprint = opts.noCache ? "" : statFingerprintOf(files);
  if (!opts.noCache) {
    const memoEntry = manifestMemo.get(rootKey);
    if (
      memoEntry !== undefined &&
      memoEntry.ignoreHash === opts.ignoreHash &&
      memoEntry.statFingerprint === statFingerprint &&
      (opts.commit === undefined || opts.commit === memoEntry.manifest.builtFromCommit)
    ) {
      // Refresh recency (Map insertion order doubles as the LRU order).
      manifestMemo.delete(rootKey);
      manifestMemo.set(rootKey, memoEntry);

      const shortcutWarnings: string[] = [];
      const shortcutManifest = await runOpportunisticConsistencyScan(
        root,
        memoEntry.manifest,
        opts,
        rootKey,
        epochAtStart,
        shortcutWarnings,
      );
      return {
        manifest: shortcutManifest,
        warnings: shortcutWarnings,
        reused: Object.keys(shortcutManifest.files).length,
        reparsed: 0,
        cacheRebuildReasons: [],
      };
    }
    // A stale memo still beats an absent/failed disk cache as the incremental
    // seed: unchanged files take the fast path below instead of a full
    // re-extract when the disk manifest could not be persisted.
    if (cachedManifest === null && memoEntry !== undefined && memoEntry.ignoreHash === opts.ignoreHash) {
      cachedManifest = memoEntry.manifest;
    }
  }

  // 3) Process each file.
  const fileEntries: Record<string, IndexedFileV1> = {};

  for (const f of files) {
    opts.__testHooks?.midBuild?.(f.path);
    const cached = cachedManifest?.files[f.path];

    // Read file — needed for hash verification (fast path P1.4 gate and mid
    // path) and P1.3 symbol-line validation (fast path and mid path).
    let raw: string;
    try {
      raw = await readRegularFileUtf8(f.absPath);
    } catch (e) {
      warnings.push(`skeleton-index: failed to read ${f.path}: ${String(e)}`);
      cacheRebuildReasons.push(`file-read-error:${f.path}`);
      // V11-09: a `continue` here used to OMIT the entry entirely — a file
      // that becomes transiently unreadable (permissions, an I/O error)
      // would silently vanish from manifest.files, indistinguishable from
      // a real deletion. That is exactly the "false absence" this
      // workstream exists to close (see IndexedFileParseStatus's doc
      // comment). Keep the file's LAST KNOWN GOOD entry if one exists
      // (stamped "failed" so it is visibly not fresh), or else synthesize
      // a minimal placeholder from the enumeration metadata we do have —
      // either way the path stays present and re-attempts on the next
      // build once it becomes readable again (no special-casing needed:
      // it just re-enters this same per-file loop next time).
      if (cached !== undefined) {
        fileEntries[f.path] = { ...cached, parseStatus: "failed" };
      } else {
        fileEntries[f.path] = {
          path: f.path,
          language: f.language ?? languageForPath(f.path) ?? "default",
          sizeBytes: f.sizeBytes,
          mtimeMs: f.mtimeMs,
          contentSha256: "",
          symbols: [],
          chunks: [],
          outgoingSymbolRefs: {},
          parseStatus: "failed",
        };
      }
      continue;
    }

    // Computed once, right after the bytes are in hand — feeds both the
    // fast-path content gate below (P1.4) and the mid-path comparison, so
    // neither path costs any extra IO to check content freshness.
    const sha = hashContent(Buffer.from(raw));
    const statMatched = cached !== undefined && cached.sizeBytes === f.sizeBytes && cached.mtimeMs === f.mtimeMs;
    const contentMatched = cached !== undefined && cached.contentSha256 === sha;

    // Fast path: cached entry exists, sizeBytes + mtimeMs match, AND the
    // content hash matches. P1.4: matching size+mtime alone is NOT proof the
    // bytes are unchanged — mtime can be forced back onto a file whose
    // content changed (fs.utimesSync), or two distinct writes can land on
    // the same filesystem timestamp resolution — so the hash comparison
    // (already-read bytes above, zero extra IO) gates the fast path before
    // P1.3's symbol-line heuristic ever gets a say. Without this, a
    // same-size/same-mtime content swap validated fine against its OLD
    // symbol names/positions and was served forever.
    if (cached && statMatched && contentMatched) {
      if (validateCachedSymbols(cached, raw)) {
        fileEntries[f.path] = withoutStaleFailedStatus(cached);
        reused++;
        continue;
      } else {
        // Symbol-line mismatch despite matching mtime/size/content — cache is corrupted.
        const rawLines = raw.split(/\r?\n/);
        const failingSym = cached.symbols.find((sym) => {
          const lo = Math.max(0, sym.lineStart - 2);
          const hi = Math.min(rawLines.length, sym.lineEnd + 2);
          const escaped = sym.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          const re = new RegExp(`\\b${escaped}\\b`);
          for (let i = lo; i < hi; i++) {
            if (re.test(rawLines[i] ?? "")) return false; // found — not the failing sym
          }
          return true; // not found — this is the failing sym
        });
        const symName = failingSym?.name ?? "unknown";
        cacheRebuildReasons.push(`symbol-line-mismatch:${f.path}:${symName}`);
        // Fall through to slow path below.
      }
    } else if (cached && statMatched && !contentMatched) {
      // P1.4: the exact case the fast path used to miss silently — size and
      // mtime both match the cached entry, but the content hash does not. A
      // distinct reason (rather than "file-content-change" below) flags this
      // as the dangerous stat-blind case, not an ordinary mtime-driven
      // invalidation. Falls through — the mid-path check below also sees
      // contentMatched === false and correctly routes this file to the slow
      // (full re-extract) path; it never gets a second chance to fast-path
      // via validateCachedSymbols alone.
      cacheRebuildReasons.push(`content-hash-mismatch-despite-stat-match:${f.path}`);
    }

    // Track content change reason before mid-path check (the ordinary case:
    // stat already differed, so this isn't the stat-blind case above, which
    // recorded its own more specific reason).
    if (cached && !contentMatched && !statMatched) {
      cacheRebuildReasons.push(`file-content-change:${f.path}`);
    }

    // Mid path: cached entry exists and content hash matches (stat may have
    // changed, e.g. a touch with no content change, or a rename that
    // preserved bytes). P1.3: also run symbol-line validation before
    // trusting the cached entry.
    if (cached && contentMatched) {
      if (validateCachedSymbols(cached, raw)) {
        fileEntries[f.path] = {
          ...withoutStaleFailedStatus(cached),
          sizeBytes: f.sizeBytes,
          mtimeMs: f.mtimeMs,
        };
        reused++;
        continue;
      } else {
        // Symbol-line mismatch — find the first failing symbol name for the reason.
        // A symbol "fails" when its name is NOT found in its claimed line range.
        const rawLines = raw.split(/\r?\n/);
        const failingSym = cached.symbols.find((sym) => {
          const lo = Math.max(0, sym.lineStart - 2);
          const hi = Math.min(rawLines.length, sym.lineEnd + 2);
          const escaped = sym.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          const re = new RegExp(`\\b${escaped}\\b`);
          for (let i = lo; i < hi; i++) {
            if (re.test(rawLines[i] ?? "")) return false; // found — not the failing sym
          }
          return true; // not found — this is the failing sym
        });
        const symName = failingSym?.name ?? "unknown";
        // Avoid double-pushing the same reason if already added by the fast-path check.
        if (!cacheRebuildReasons.some((r) => r === `symbol-line-mismatch:${f.path}:${symName}`)) {
          cacheRebuildReasons.push(`symbol-line-mismatch:${f.path}:${symName}`);
        }
      }
    }

    // Slow path: extract symbols and chunks.
    // Text-bearing files (.md/.txt/... — EnumeratedFile.textOnly) get
    // chunked below (extractChunks routes empty-symbols input through
    // makeTextChunks) but must never get symbols or outgoingSymbolRefs —
    // both feed ranking/reference graphs (buildTlGraphFromManifest,
    // mcp-server's buildFileScoresFromManifest) that must stay neutral to
    // doc/config prose. Content is already in hand here — sniff .h files
    // for C++ signals instead of trusting the static extension-only "c"
    // answer, so the PERSISTED index that search_files action=symbols
    // reads from doesn't lock in the wrong grammar for genuinely-C++ .h
    // files. See graph.ts's languageForPathWithContent doc comment.
    const language = f.textOnly
      ? "text"
      : languageForPathWithContent(f.path, raw) ?? f.language ?? languageForPath(f.path) ?? "default";
    let extractedSymbols: import("./graph.js").ExtractedSymbol[];
    if (f.textOnly) {
      extractedSymbols = [];
    } else {
      try {
        extractedSymbols = extractSymbolsRegex(raw, language);
      } catch {
        extractedSymbols = [];
      }
    }

    // V11-09 (parser crash quarantine): everything from here through the
    // assembly below is now wrapped in one try/catch. Pre-V11-09 only
    // extractSymbolsRegex had its own internal guard (defaulting to an
    // empty symbol list on a throw) — extractChunks and the
    // symbolKindFromSignature/chunkIdsBySymbolName assembly that follows it
    // had NONE, so a single file whose content made either of them throw
    // aborted the ENTIRE workspace build, not just that file. See
    // IndexedFileParseStatus's doc comment for the isolated-partial
    // contract this now provides instead.
    let quarantined = false;
    let symbols: IndexedSymbolV1[] = [];
    let chunks: IndexedChunkV1[] = [];
    let refCounts: Record<string, number> = {};
    try {
      if (opts.__testHooks?.forceExtractionCrash?.(f.path)) {
        throw new Error(`__testHooks.forceExtractionCrash(${f.path})`);
      }

      chunks = extractChunks({
        path: f.path,
        raw,
        language,
        symbols: extractedSymbols,
      });

      // Build IndexedSymbolV1[]
      // One pass over chunks keyed by base symbol name (the slice suffix is
      // `#<i>`), instead of a per-symbol chunks.filter scan — that pairing was
      // O(symbols × chunks) per file.
      const chunkIdsBySymbolName = new Map<string, string[]>();
      for (const c of chunks) {
        if (c.symbolName === undefined) continue;
        const hashIdx = c.symbolName.indexOf("#");
        const base = hashIdx === -1 ? c.symbolName : c.symbolName.slice(0, hashIdx);
        const ids = chunkIdsBySymbolName.get(base);
        if (ids) ids.push(c.id);
        else chunkIdsBySymbolName.set(base, [c.id]);
      }
      symbols = extractedSymbols.map((sym) => {
        const kind = symbolKindFromSignature(sym.signature, sym.name);
        const chunkIds = chunkIdsBySymbolName.get(sym.name) ?? [];
        return {
          name: sym.name,
          kind,
          signature: sym.signature,
          lineStart: sym.line,
          lineEnd: sym.endLine,
          chunkIds,
        };
      });

      // outgoingSymbolRefs: count all identifier occurrences. Skipped for
      // textOnly files — prose mentioning a real symbol name (e.g. a README
      // that says "Widget") must not inject a reference edge into
      // buildTlGraphFromManifest's graph.
      if (!f.textOnly) {
        // Iterate the matches lazily — materializing every identifier
        // occurrence of every file into an array first was pure allocation
        // churn on repo-scale builds.
        for (const t of raw.matchAll(/\b[A-Za-z_$][\w$]*\b/g)) {
          const tok = t[0]!;
          refCounts[tok] = (refCounts[tok] ?? 0) + 1;
        }
      }
    } catch (e) {
      // Isolate as file-level partial instead of aborting the whole build.
      // contentSha256 below still records `sha` (computed unconditionally
      // earlier from the bytes we already read), so a content change on
      // THIS file re-attempts extraction next time through the ordinary
      // content-hash gate every other cache entry already uses — no
      // special-casing needed for that half of the re-attempt contract.
      quarantined = true;
      symbols = [];
      chunks = [];
      refCounts = {};
      warnings.push(`skeleton-index: quarantined ${f.path} after an extraction error: ${String(e)}`);
      cacheRebuildReasons.push(`parser-crash-quarantined:${f.path}`);
    }

    fileEntries[f.path] = {
      path: f.path,
      language,
      sizeBytes: f.sizeBytes,
      mtimeMs: f.mtimeMs,
      contentSha256: sha,
      symbols,
      chunks,
      outgoingSymbolRefs: refCounts,
      ...(quarantined ? { parseStatus: "quarantined" as const } : {}),
    };
    reparsed++;
  }

  // 4) Sort file entries by key.
  const sortedFiles: Record<string, IndexedFileV1> = {};
  for (const key of Object.keys(fileEntries).sort()) {
    sortedFiles[key] = fileEntries[key]!;
  }

  // 5) Build directory digests.
  const { root: rootHash, directories } = buildDirectoryDigests(Object.values(sortedFiles));

  // 6) Resolve commit.
  let commit: string;
  if (opts.commit) {
    commit = opts.commit;
  } else {
    try {
      const { stdout } = await execFileAsync("git", ["-C", root, "rev-parse", "HEAD"], {
        timeout: 5000,
      });
      commit = stdout.trim().slice(0, 40);
    } catch {
      commit = "unknown";
    }
  }

  // 7) Resolve repoRootRealpath (resolved once at the top).
  const repoRootRealpath = rootKey;

  // 7b) V11-09: generation is a monotonic counter over ACTUAL content
  // changes only — bumped when rootHash differs from whichever seed
  // (cachedManifest: disk or memo, whichever fed the per-file loop above)
  // this build started from, otherwise carried through unchanged. See
  // SourceIndexManifestV1.generation's doc comment and publishJournal.ts.
  const priorGeneration = cachedManifest?.generation ?? 0;
  const contentChanged = rootHash !== cachedManifest?.rootHash;
  const generation = contentChanged ? priorGeneration + 1 : priorGeneration;

  // 8) Assemble manifest.
  const manifest: SourceIndexManifestV1 = {
    version: 1,
    engineVersion: CURRENT_ENGINE_VERSION,
    repoRootRealpath,
    ignoreHash: opts.ignoreHash,
    builtFromCommit: commit,
    rootHash,
    generation,
    files: sortedFiles,
    directories,
  };

  // 9) Write cache (unless noCache). Skip the rewrite when the disk cache
  // already holds this exact index content (only stat metadata could have
  // been refreshed) — serializing a repo-scale manifest per call is a real
  // cost, and the next reader re-derives freshness from content hashes.
  const diskCacheCurrent = diskManifest !== null
    && reparsed === 0
    && manifest.rootHash === diskManifest.rootHash;
  if (!opts.noCache && !diskCacheCurrent) {
    try {
      await writeManifest(root, manifest, { beforeRename: opts.__testHooks?.beforeManifestRename });
      // V11-09: manifest generation `generation` is now durable but the
      // paired graph write (step 10) has not confirmed yet. Record that so
      // a crash in exactly this window is detectable and self-healing on
      // the very next call, instead of silently trusting tl-graph.json's
      // own rootHash forever — see publishJournal.ts's doc comment.
      // Best-effort: a journal-write failure must never block the manifest
      // publish that already succeeded; it only narrows the crash window
      // the NEXT call's recovery check can prove complete.
      try {
        await writePendingPublishJournal(root, generation, rootHash, {
          beforeRename: opts.__testHooks?.beforeJournalRename,
        });
      } catch (e) {
        warnings.push(`skeleton-index: failed to write publish journal: ${String(e)}`);
      }
    } catch (e) {
      warnings.push(`skeleton-index: failed to write cache: ${String(e)}`);
    }
  }

  // 10) Build/refresh tl-graph.json (unless noCache). Consult the publish
  // journal first: a pending record — from THIS call's step 9 above, or
  // from an EARLIER call/process that crashed between its own step 9 and
  // step 10 — means the on-disk graph's rootHash cannot be trusted to
  // prove freshness on its own, so force the rebuild instead of trusting
  // the cheap shortcut.
  if (!opts.noCache) {
    try {
      const journalStatus = await readPublishJournal(root);
      await writeGraphIfStale(root, manifest, {
        forceRebuild: journalStatus.pending,
        beforeRename: opts.__testHooks?.beforeGraphRename,
      });
      // Graph now confirmed at (at least) this generation — clear any
      // pending record, including one this same call just wrote above.
      await clearPublishJournal(root).catch((e) => {
        warnings.push(`skeleton-index: failed to clear publish journal: ${String(e)}`);
      });
    } catch (e) {
      warnings.push(`skeleton-index: failed to write graph index: ${String(e)}`);
    }
  }

  if (!opts.noCache) {
    // V11-09: an invalidation that landed WHILE this build was running must
    // not be erased by this build unconditionally publishing its own
    // (possibly pre-invalidation) result over it. See
    // invalidateCachedWorkspaceFiles's and epochAtStart's own comments for
    // the race this closes. A mismatch means: skip the memo publish, but
    // still return this build's manifest to THIS caller — the next call
    // simply redoes the work, which is the safe/conservative choice.
    const epochNow = manifestMemoEpoch.get(rootKey) ?? 0;
    if (epochNow === epochAtStart) {
      manifestMemo.delete(rootKey);
      if (manifestMemo.size >= MANIFEST_MEMO_MAX_WORKSPACES) {
        const oldest = manifestMemo.keys().next().value;
        if (oldest !== undefined) manifestMemo.delete(oldest);
      }
      manifestMemo.set(rootKey, { ignoreHash: opts.ignoreHash, statFingerprint, manifest });
    }
  }

  // 11) V11-09: opportunistic bounded consistency scan (see
  // runOpportunisticConsistencyScan's own doc comment — this is the
  // SECOND of its two call sites, covering every path that reaches a full
  // rebuild/reuse pass rather than the memo's whole-match shortcut above).
  const finalManifest = opts.noCache
    ? manifest
    : await runOpportunisticConsistencyScan(root, manifest, opts, rootKey, epochAtStart, warnings);

  return { manifest: finalManifest, warnings, reused, reparsed, cacheRebuildReasons };
}
