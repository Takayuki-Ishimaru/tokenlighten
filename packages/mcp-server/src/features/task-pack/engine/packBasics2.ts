// packBasics — extracted implementation; imports point to the owning modules.
import * as fs from "fs";
import * as path from "path";
import type { ArtifactKind } from "../model.js";
import type { ArtifactTaskPackSurface } from "../model.js";
import type { CompoundRequestPlan } from "../compoundRequests.js";
import type { FacetRequirement } from "../requestFacets.js";
import type { RequestItem } from "../requestItems.js";
import type { RequestItemIndexView } from "../requestItems.js";
import type { ServedTextVerdict } from "../../../util/textDecode.js";
import type { TaskPackArgs } from "../model.js";
import type { TaskPackPathEntry } from "../model.js";
import { ARTIFACT_EXTS } from "../../../tools/walkRepo.js";
import { DEFAULT_RESPONSE_BYTE_FLOOR } from "../../../tools/readCodeModes.js";
import { callWorkspace } from "../../../util/handles.js";
import { collectSymbols } from "../../../symbols/collectSymbols.js";
import { compoundParserOptions } from "./packBasics.js";
import { compoundParsingStorage } from "./packBasics.js";
import { countLines } from "../../../util/countLines.js";
import { discoverArtifactFiles } from "../../locator/locateTaskContext.js";
import { elideDocComments } from "../../../util/formatCompress.js";
import { extractCompoundFacetRequirements } from "../compoundRequests.js";
import { extractCompoundRequestItems } from "../compoundRequests.js";
import { handleTable } from "../../../util/handles.js";
import { isMarkdownPath } from "../../../util/markdownSections.js";
import { isWithin } from "../../../util/safePath.js";
import { languageForPath } from "../../../util/languages.js";
import { markdownOutline } from "../../../util/markdownSections.js";
import { markdownSectionAtLine } from "../../../util/markdownSections.js";
import { packByteCeilingStorage } from "./packBasics.js";
import { parseMarkdownHeadings } from "../../../util/markdownSections.js";
import { planCompoundRequest } from "../compoundRequests.js";
import { preferPythonImplementations } from "../../../symbols/collectSymbols.js";
import { readFileForRequest } from "../../../util/requestFileCache.js";
import { readServedText } from "../../../util/textDecode.js";
import { resolveReal } from "../../../util/safePath.js";
import { safeResolve } from "../../../util/safePath.js";
import { servedTextOrUndefined } from "../../../util/textDecode.js";
import { shaOfBytes } from "../../../util/handles.js";
import { sliceLinesToText } from "../../../util/countLines.js";
import { statReadTargetSync } from "../../../util/safePath.js";

export function extractRequestItems(query: string, index?: RequestItemIndexView): RequestItem[] {
  const cache = index === undefined ? compoundParsingStorage.getStore()?.items : undefined;
  let items = cache?.get(query);
  if (items === undefined) {
    items = extractCompoundRequestItems(query, index, compoundParserOptions());
    // The centralized composition-budget obligation below owns the omitted
    // tail. Do not run literal-absence heuristics over its synthetic fallback.
    if (compoundPlanForQuery(query)?.outstanding.length) {
      items = items.filter((item) => !(item.text === query && !item.bindable && item.terms.length === 0));
    }
    cache?.set(query, items);
  }
  // markFacetOwnedPoints annotates its own items; never mutate a cached parse.
  return items.map((item) => ({ ...item }));
}

export function extractFacetRequirements(query: string): FacetRequirement[] {
  const cache = compoundParsingStorage.getStore()?.facets;
  let requirements = cache?.get(query);
  if (requirements === undefined) {
    requirements = extractCompoundFacetRequirements(query, compoundParserOptions());
    cache?.set(query, requirements);
  }
  return requirements;
}

export function compoundPlanForQuery(query: string): CompoundRequestPlan | undefined {
  const options = compoundParserOptions();
  if (!options.enabled) return undefined;
  const cache = compoundParsingStorage.getStore()?.plans;
  let plan = cache?.get(query);
  if (plan === undefined) {
    plan = planCompoundRequest(query, undefined, options);
    cache?.set(query, plan);
  }
  return plan;
}

/** The active caller/env/profile byte ceiling for the buildTaskPack() call in progress, or undefined outside one (or when nothing constrained it) -- see packByteCeilingStorage's doc comment. */
export function activePackByteCeiling(): number | undefined {
  return packByteCeilingStorage.getStore();
}

/** rawCapForResult's type-specific tier, narrowed (never widened) to whatever byte ceiling is active -- see packByteCeilingStorage's doc comment. The identity function when no ceiling is active, which is every call today's replay corpus makes. */
export function clampToActiveCeiling(typeSpecificCap: number): number {
  const ceiling = activePackByteCeiling();
  if (ceiling === undefined) return typeSpecificCap;
  return Math.max(DEFAULT_RESPONSE_BYTE_FLOOR, Math.min(typeSpecificCap, ceiling));
}

/**
 * A1 (2026-07-30) — inline budget for the artifact SURFACES of a pack that is
 * not an artifact_build (any profile: answer, multi_concern, generic, …).
 *
 * Live defect (T14 two-deck audit): the pack resolved both .pptx decks to
 * `{kind:"artifact", size, handle, extract}` STUBS and served zero slide text,
 * in a 2.9 KB response — with ~21 KB of the pack budget unused — so the caller
 * spent two extra round trips extracting content the server had already
 * located. The distributed guide's own contract already promises the opposite
 * ("artifact packs need content-bearing artifact_sections per source"), so this
 * is the contract being honored, not a new one.
 *
 * Two caps, both deliberately well inside the pack ceiling so artifact content
 * can never crowd out code surfaces: 8 KiB for any ONE artifact (enough for
 * several whole slides / a docx section / a real sheet preview) and 16 KiB for
 * all of them together. Anything past a cap is served as a PREFIX plus the
 * exact per-section follow-up call, never dropped to a stub.
 */
export const ARTIFACT_SURFACE_INLINE_CAP_BYTES = 8192;

/** Rows a pack shows of a csv it cannot carry whole (artifactSections.ts `plainCsvSample`). */
export const CSV_SURFACE_SAMPLE_ROWS = 10;

/** Beside a complete lookup the sample only has to show the columns' values. */
export const CSV_LOOKUP_SAMPLE_ROWS = 1;

export const CSV_LOOKUP_MAX_ROWS = 30;

export const CSV_LOOKUP_PARTIAL_ROWS = 3;

export const CSV_LOOKUP_MAX_BYTES = 6 * 1024;

/** Room a lookup leaves in the entry for the columns, the sample and the note. */
export const CSV_LOOKUP_SECTION_OVERHEAD_BYTES = 2 * 1024;

export const ARTIFACT_SURFACE_INLINE_TOTAL_BYTES = 16384;

/** Same bound artifact_build's own input selection uses (selectArtifactBuildInputs). */
export const MAX_INLINED_ARTIFACT_SURFACES = 4;

/** `remaining_sections` stays a pointer, not an inventory. */
export const MAX_REMAINING_SECTION_IDS = 6;

/**
 * Per-surface embedded-code byte cap (keeps any single slice bounded).
 * Turn-economy serve budget (2026-07-24): raised 4096 -> 12288 so a single
 * relevant surface can ship a real code body inline (2-3 such surfaces fill
 * the raised pack cap) instead of degenerating into a handle the agent must
 * re-slice in a follow-up turn. Oversized surfaces STILL trim to a centered
 * window + remaining_ranges (centeredSliceForCap) — never drop to code-less.
 */
export const MAX_SURFACE_CODE_BYTES = 12288;

/**
 * WP-S2 (2026-09-20, TL_SEEDED_GENEROUS): per-surface embedded-code cap for a
 * file the CALLER NAMED, with no range/symbol, in an `answer` (read-only)
 * seeded pack. Measured host pricing makes one extra model turn cost about as
 * much as 9-14 KB of served source, so a named file the caller will read in
 * full anyway is cheaper served whole than re-served window by window: a
 * plain `content:"full"` batch of the same files is one call on every host.
 * Deliberately NOT the generic (change-profile) allowance, which keeps
 * MAX_SURFACE_CODE_BYTES — an edit frontier wants the narrow window.
 */
export const SEEDED_ANSWER_SURFACE_CODE_BYTES = 24576;

/**
 * WP-S2: bytes held back from the pack tier when water-filling the named
 * files' whole bodies, for the envelope (task/decision/profile_binding/qref)
 * and for JSON escaping of the bodies themselves. trimToCap remains the final,
 * honest governor — this only keeps the common case from reaching it.
 */
export const SEEDED_ANSWER_ENVELOPE_RESERVE = 4096;

/**
 * Pack budget a seeded ANSWER pack may claim when the caller named several
 * files (TL_SEEDED_GENEROUS only). Measured 2026-09-20 on a recorded Copilot
 * call — query + 8 caller-named files with `content:"full"`: the files total
 * ~44 KB embedded, the 32 KB multi-concern tier forced a second call for the
 * remainders, and that second turn costs the caller about as much as 9-14 KB
 * of served source on every host, while a native agent reads the same eight
 * files whole in one parallel turn. 48 KB keeps such a request to one call and
 * still sits well inside the task_pack wire budget; a client-profile ceiling
 * and a caller `budget.bytes` both still win (`Math.min` at the use sites).
 * The base multi-concern tier stays the floor for 2-3 named files.
 */
export const SEEDED_GENEROUS_PACK_BYTES = 48 * 1024;

export const SEEDED_GENEROUS_PACK_MIN_FILES = 4;

/** WP-S2: how many distinct symbol windows one oversized caller-named file may serve (rule 3). */
export const SEEDED_ANSWER_MAX_ANCHOR_WINDOWS = 4;

/** WP-P2 B: headroom a post-`trimToCap` body reduction takes on top of the measured overflow, so the honesty fields it stamps (`content_completeness`, the added `remaining_ranges` entry) cannot themselves put the pack back over the cap and cost a second surface its bytes. */
export const SHED_REDUCTION_SLACK_BYTES = 512;

/** Maximum surfaces when all roles are distinct. */
export const MAX_SURFACES_DISTINCT = 6;

/**
 * Copilot retest (2026-10-02): how far an answer pack's selection may grow
 * past MAX_SURFACES_DISTINCT for facet-closure windows alone (a focal's
 * callees and the constants they read). Those windows are already bounded by
 * MAX_CLOSURE_BYTES_PER_PACK; the distinct-surface cap used to drop them once
 * a hub function had more than a handful of small callees, so a computation
 * question took a second round trip for windows that fit the byte budget.
 */
export const MAX_SURFACES_WITH_FACET_CLOSURE = 16;

/**
 * Literal-first admits a source only while it remains rare in the exact
 * ordinary-find universe. The floor preserves bounded multi-surface renames
 * in small repositories; the ratio scales the same policy for monorepos.
 */
export const LITERAL_SOURCE_RARITY_RATIO = 0.02;

export const LITERAL_SOURCE_RARITY_FLOOR = MAX_SURFACES_DISTINCT * 2;

export function literalSourceRarityLimit(universePaths: number): number {
  const boundedUniverse = Math.max(0, Math.floor(universePaths));
  return Math.max(
    LITERAL_SOURCE_RARITY_FLOOR,
    Math.ceil(boundedUniverse * LITERAL_SOURCE_RARITY_RATIO),
  );
}

// Serve-honesty (2026-08-01): enrichment passes (query-named files, header/
// source pairs) on a multi_concern pack may fill past the base surface cap —
// a 3-concern fix pack legitimately owns 3 primaries + pairs + a named
// contract doc. The pack byte budget still governs total size, and the
// byte-budget trim discloses anything it sheds.
export const MULTI_CONCERN_ENRICHMENT_MAX_SURFACES = MAX_SURFACES_DISTINCT + 2;

export const MAX_SEMANTIC_WIRING_SURFACES = 12;

/** Kept separate from every source/text language extension registry. */
export const ARTIFACT_EXT_SET: ReadonlySet<string> = new Set(ARTIFACT_EXTS);

/** Confidence at/above which a non-required surface still embeds code. */
export const HIGH_CONFIDENCE_THRESHOLD = 0.7;

/**
 * B4: a file at/under BOTH of these bounds is "tiny" — small enough that a
 * partial-range handle on it (the live tiny-stub failure) is strictly worse than a
 * whole-file handle: the agent inevitably needs the rest of a tiny stub, and a
 * narrow handle forces a re-slice. When a range-kind candidate lands on a tiny
 * file, the surface HANDLE is minted over the whole file (1-EOF) even though
 * the displayed `range`/`code` slice stays narrow. Mirrors the small-file
 * thresholds used elsewhere (readCodeSmallFile) — hardcoded here rather than
 * imported to avoid a module cycle (readCodeSmallFile itself imports from this
 * layer); kept in sync by comment.
 */
export const TINY_FILE_MAX_BYTES = 8192;

export const TINY_FILE_MAX_LINES = 250;

// ---------------------------------------------------------------------------
// Per-pack file read/parse memo (efficiency): every pack build reads the same
// handful of files several times over — sliceCode, tinyFileWholeRange,
// widenNativeSymbolRange, buildContractDocOutline, definitionVsDerivedAdjustment
// and (in the seeded flow) the seed reads all hit the same paths. A single
// per-call cache keyed by workspace-relative path collapses each file to at
// most one readFileSync and one collectSymbols() per pack. Threaded as an
// OPTIONAL last argument everywhere: undefined preserves the original
// read-every-time behavior (safe for any caller that does not supply one).
// ---------------------------------------------------------------------------

export type ParsedSymbols = Awaited<ReturnType<typeof collectSymbols>>;

/** Sentinel distinguishing "read, but failed" from "not yet read". */
export const READ_FAILED = Symbol("read-failed");

// Exported alongside `sfNamedFrontierRow` for the FX-OH F1 pin.
export class FileReadCache {
  private readonly content = new Map<string, string | typeof READ_FAILED>();
  private readonly verdicts = new Map<string, ServedTextVerdict>();
  private readonly symbols = new Map<string, ParsedSymbols | null>();

  /**
   * Read `relPath` under `workspace` once; subsequent calls return the memo.
   * Returns undefined on any I/O error OR content the ONE serve-side decode
   * policy refuses; cached as a failure so it is not retried.
   *
   * AA1 (2026-09-14, review round 10): this is the reader behind nearly every
   * task-pack BODY (`readCached` -> candidateToSurface / anchorFocusFor-
   * LocatorCandidate / centeredSliceForCap / sliceRange), so it is where the
   * single `readServedText` verdict (util/textDecode.ts) belongs. It used to
   * call `decodeTextBuffer`, whose NUL probe stops at
   * `UNDECODABLE_PROBE_BYTES` -- which is why a file whose NULs begin at byte
   * 4260 was read, sliced, embedded and CERTIFIED with 300 escaped NULs on the
   * wire (review round 9, findings 49/50). Now: `"clean"` and `"stripped"`
   * memoize the verdict's own (NUL-free) text, so no downstream consumer can
   * ever see a NUL this cache handed out; `"undecodable"` memoizes the failure,
   * exactly as an unreadable file always did. The verdict itself is kept so a
   * caller that must ANNOTATE the strip can ask (`verdictFor`), instead of
   * re-deriving the judgment with a second, differently-spelled predicate.
   */
  read(workspace: string, relPath: string): string | undefined {
    const hit = this.content.get(relPath);
    if (hit !== undefined) return hit === READ_FAILED ? undefined : hit;
    let raw: string | typeof READ_FAILED;
    try {
      const abs = workspaceBodyPath(workspace, relPath);
      if (abs === undefined) throw new Error(`${relPath} resolves outside the workspace`);
      // served-bytes: readServedText
      const verdict = readServedText(readFileForRequest(abs));
      this.verdicts.set(relPath, verdict);
      raw = verdict.kind === "undecodable" ? READ_FAILED : verdict.text;
    } catch {
      raw = READ_FAILED;
    }
    this.content.set(relPath, raw);
    return raw === READ_FAILED ? undefined : raw;
  }

  /**
   * AA1 (round 10): the serve-side decode verdict `read` recorded for
   * `relPath`, when this cache is the one that read it. `undefined` means this
   * cache never read that path itself (a `seed`/`reseed` caller supplied the
   * text, or nothing read it at all) -- never "the verdict was clean".
   */
  verdictFor(relPath: string): ServedTextVerdict | undefined {
    return this.verdicts.get(relPath);
  }

  /**
   * Seed the cache with content already read elsewhere (e.g. the seeded-pack
   * parallel reads), so downstream slice/widen calls reuse it.
   *
   * SHOULD-FIX 57 (AB1, 2026-09-14, review round 11): the seeding caller ALREADY
   * HAS the `readServedText` verdict for those bytes (`buildSeededTaskPack`'s
   * loop reads through `readServedTextSafe`), and dropping it here is what made
   * `verdictFor` empty for every seeded path — so `candidateToSurface`'s
   * annotation (AA1's door 7, "the ONE place a strip is STATED") could not cover
   * a seeded path at all, and the seeded door had to keep a SECOND register
   * (`nulStrippedSeedPaths`) that an anchor-focus `why` rewrite then dropped on
   * a 16 KiB fixture. Record it, so `verdictFor` is the single source.
   */
  seed(relPath: string, content: string, verdict?: ServedTextVerdict): void {
    if (this.content.has(relPath)) return;
    this.content.set(relPath, content);
    if (verdict !== undefined) this.verdicts.set(relPath, verdict);
  }

  /**
   * SHOULD-FIX 37 (2026-09-14, review round 6): `seed` above is
   * deliberately a no-op once `relPath` is already memoized — including a
   * memoized `READ_FAILED` — so it can never clobber real content another
   * caller already cached. That is wrong for a caller who tried the
   * STRICT read first (via `readCached`/`read`, which memoizes the
   * `READ_FAILED` failure itself), then successfully recovered via a
   * lenient re-decode: the recovered text is exactly what SHOULD replace
   * the memoized failure, not be silently dropped by it. `reseed`
   * unconditionally overwrites the memo (clearing any `READ_FAILED` for
   * this path too), so every later `read`/`readCached` call for the SAME
   * `FileReadCache` instance — including the ones `augmentQueryNamedFileSurfaces`
   * itself makes right after seeding, to slice/anchor/build the surface
   * body — observes the SAME recovered text instead of re-hitting the
   * stale strict failure. `seed`'s own 4 pre-existing call sites are
   * untouched; only a caller that just proved a memoized failure is now
   * stale should ever reach for this.
   */
  reseed(relPath: string, content: string, verdict?: ServedTextVerdict): void {
    this.content.set(relPath, content);
    // SHOULD-FIX 57: see `seed` above — the verdict is recorded unconditionally
    // here because `reseed`'s whole purpose is to REPLACE what an earlier read
    // concluded, including that read's verdict.
    if (verdict !== undefined) this.verdicts.set(relPath, verdict);
  }

  /** Parse `relPath`'s symbols once (given its already-cached content + language); memoized including the null (parse-failure) result. */
  async parsedSymbols(text: string, lang: string, relPath: string): Promise<ParsedSymbols | null> {
    const hit = this.symbols.get(relPath);
    if (hit !== undefined) return hit;
    let parsed: ParsedSymbols | null;
    try {
      parsed = await collectSymbols(text, lang, {});
      if (lang === "python") parsed = preferPythonImplementations(parsed, text);
    } catch {
      parsed = null;
    }
    this.symbols.set(relPath, parsed);
    return parsed;
  }
}

/**
 * 2026-10-06 (independent review follow-up, security): the absolute path of a
 * task-pack body read, or `undefined` when `relPath` resolves outside
 * `workspace` — lexically (a `../` an import resolution kept) or through a
 * symlink. A constant closure following `import … from "../../shared/x.js"`
 * served that file's text as answer evidence, while `tl_read_file` refuses the
 * same path `not-found`. Every read behind a task-pack body goes through here.
 */
export function workspaceBodyPath(workspace: string, relPath: string): string | undefined {
  const abs = safeResolve(relPath, workspace);
  if (abs === undefined) return undefined;
  return isWithin(resolveReal(abs), resolveReal(workspace)) ? abs : undefined;
}

/**
 * Read `relPath` under `workspace`, using `cache` when supplied. Returns
 * undefined on I/O error or content the serve-side decode policy refuses.
 *
 * AA1 (2026-09-14, round 10): the cache-less branch runs the SAME
 * `readServedText` policy `FileReadCache.read` does, so "which reader did I
 * happen to get" can never decide whether a NUL reaches the wire.
 */
export function readCached(workspace: string, relPath: string, cache?: FileReadCache): string | undefined {
  if (cache) return cache.read(workspace, relPath);
  const abs = workspaceBodyPath(workspace, relPath);
  if (abs === undefined) return undefined;
  // served-bytes: readServedText
  return servedTextOrUndefined(abs);
}

// ---------------------------------------------------------------------------
// Code slicing (A2 item 1): populate surface.code with the exact range
// text instead of leaving the field permanently unset. Bounded per-slice so
// one huge symbol cannot blow the whole pack's budget; the trim ladder in
// trimToCap() still protects/drops code as a last resort under the overall
// cap.
// ---------------------------------------------------------------------------

/**
 * Read `path` under `workspace` and return the 1-based inclusive line range
 * `range` ("start-end"). Returns undefined on any I/O error, a malformed
 * range, or when the slice would exceed MAX_SURFACE_CODE_BYTES (the caller
 * then falls back to a handle+skeleton-only surface — no embedded `code`).
 *
 * DESIGN-v0.8 §C3: the cap check runs on the RAW slice (unchanged semantics —
 * a slice too big to read at all still falls back to handle+skeleton-only);
 * elideDocComments then runs on the slice that IS returned, collapsing
 * multi-line doc/comment blocks to a compact marker. This is task_pack's
 * ONE choke point for embedded code (candidateToSurface, buildPartialPack,
 * and buildDiffTaskPack all call sliceCode), so eliding here covers every
 * task_pack surface without a second call site. Read-only/display text —
 * never used for handle sha or edit preconditions (edits always re-read the
 * real file via the surface's `handle`, never this embedded `code` string).
 */
/**
 * Wave 4 (2026-07-24 T10 forensics): a slice whose ENTIRE range is doc/comment
 * text elides down to a bare `doc elided L<a>-<b>` marker — a served surface
 * with zero real content ("# doc elided L1-13" was an edit-frontier surface's
 * whole code). When elision leaves only markers, the comments ARE the content;
 * serve the raw text instead.
 */
export function elisionLeftMarkersOnly(elided: string): boolean {
  const lines = elided.split("\n");
  let sawMarker = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    if (/^(?:\/\*\s*doc elided L\d+-\d+\s*\*\/|#\s*doc elided L\d+-\d+)$/.test(trimmed)) {
      sawMarker = true;
      continue;
    }
    return false;
  }
  return sawMarker;
}

export function sliceCode(
  workspace: string,
  relPath: string,
  range: string,
  cache?: FileReadCache,
  /** WP-S2: overridden ONLY by `centeredSliceForCap`'s `wholeFileParity` opt-in; every other caller keeps the shared per-surface cap. */
  maxBytes = MAX_SURFACE_CODE_BYTES,
  /** The slice with its comments, unelided: an artifact consumer's stub member (artifactConsumers.ts `whole`). */
  keepComments = false,
): string | undefined {
  const m = range.match(/^(\d+)-(\d+)$/);
  if (!m) return undefined;
  const start = parseInt(m[1]!, 10);
  const end = parseInt(m[2]!, 10);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 1 || end < start) return undefined;

  const raw = readCached(workspace, relPath, cache);
  if (raw === undefined) return undefined;
  // T1b (v0.13, UTF-16 3-way read-parity wave): sliceLinesToText restores
  // raw's own trailing newline when [start,end] reaches EOF -- see its doc
  // comment (util/countLines.ts). Fixes task_pack evidence for a whole-file
  // range coming back one trailing newline short of the SAME file read via
  // mode=full path=/handle= (utf16ReadParity.spec.ts / the release
  // rehearsal's utf16 scenario three_way_consistent check).
  const slice = sliceLinesToText(raw, start, end);
  if (slice.length === 0) return undefined;
  if (Buffer.byteLength(slice, "utf8") > maxBytes) return undefined;
  if (keepComments) return slice;
  // item 11: pass the slice's true file start line so elision markers carry
  // file line numbers, not slice-relative ones.
  const elided = elideDocComments(slice, languageForPath(relPath), start);
  return elisionLeftMarkersOnly(elided) ? slice : elided;
}

/**
 * WP-S2 rule 1 (TL_SEEDED_GENEROUS): how many bytes a WHOLE-FILE surface for
 * `content` would really put on the wire — i.e. what `centeredSliceForCap`
 * (via `candidateToSurface`) will actually embed, which is the elided text
 * whenever elision leaves real code behind, and the raw text when the file is
 * nothing but comments (`sliceCode`'s markers-only fallback).
 *
 * The seeded loop used to take its "does this file fit?" decision on RAW
 * bytes, so a comment-heavy file whose executable body fits the cap outright
 * was re-pointed at a single anchor symbol anyway — the embed layer below it
 * has measured the elided form since DESIGN-v0.8 §C3, but the decision above
 * it never asked. Pure; no workspace access (the seed content is already in
 * hand), so this adds no read.
 */
export function wholeFileEmbedBytes(content: string, relPath: string): number {
  const rawBytes = Buffer.byteLength(content, "utf8");
  const elided = elideDocComments(content, languageForPath(relPath), 1);
  if (elisionLeftMarkersOnly(elided)) return rawBytes;
  return Math.min(rawBytes, Buffer.byteLength(elided, "utf8"));
}

// Comment-heavy implementation ranges can exceed the raw per-surface cap even
// though their complete executable content is compact. Try elision before the
// byte decision so a causal multi-method slice is not needlessly cut in half.
// This never raises the fixed response cap: the compressed result must still
// fit MAX_SURFACE_CODE_BYTES.
export function sliceCodeAfterCommentElision(
  workspace: string,
  relPath: string,
  range: string,
  cache?: FileReadCache,
  executableOnlyFallback = false,
): string | undefined {
  const match = range.match(/^(\d+)-(\d+)$/);
  if (!match) return undefined;
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) {
    return undefined;
  }
  const raw = readCached(workspace, relPath, cache);
  if (raw === undefined) return undefined;
  const selected = raw.split(/\r?\n/).slice(start - 1, end).join("\n");
  if (selected.length === 0) return undefined;
  let compact = elideDocComments(selected, languageForPath(relPath), start);
  if (
    elisionLeftMarkersOnly(compact)
    && Buffer.byteLength(selected, "utf8") <= MAX_SURFACE_CODE_BYTES
  ) {
    compact = selected;
  }
  if (Buffer.byteLength(compact, "utf8") <= MAX_SURFACE_CODE_BYTES) return compact;
  if (!executableOnlyFallback) return undefined;

  // If comment elision markers are still too large, keep every executable and
  // preprocessor line while dropping standalone commentary and blank padding.
  // Inline comments remain attached to their statements. This is still a
  // complete code slice: only non-executable prose is removed.
  let inBlockComment = false;
  const executableOnly = compact.split("\n").filter((line) => {
    const trimmed = line.trim();
    if (inBlockComment) {
      if (trimmed.includes("*/")) inBlockComment = false;
      return false;
    }
    if (trimmed.startsWith("/*")) {
      if (!trimmed.includes("*/")) inBlockComment = true;
      return false;
    }
    if (trimmed.startsWith("//") || trimmed === "") return false;
    return true;
  }).join("\n");
  return Buffer.byteLength(executableOnly, "utf8") <= MAX_SURFACE_CODE_BYTES
    ? executableOnly
    : undefined;
}

/** Keep every range minted by a task pack within the current file bounds. */
export function clampRangeToFile(
  workspace: string,
  relPath: string,
  range: string,
  cache?: FileReadCache,
): string {
  const match = range.match(/^(\d+)-(\d+)$/);
  if (!match) return range;
  const raw = readCached(workspace, relPath, cache);
  if (raw === undefined) return range;
  const lineCount = countLines(raw);
  if (lineCount === 0) return range;

  const start = Math.min(Math.max(1, parseInt(match[1]!, 10)), lineCount);
  const end = Math.min(Math.max(start, parseInt(match[2]!, 10)), lineCount);
  return `${start}-${end}`;
}

export function elideCausalLineCommentRuns(source: string, startLine: number): string {
  const lines = source.split(/\r?\n/);
  const out: string[] = [];
  let runStart = -1;
  const flush = (endExclusive: number): void => {
    if (runStart < 0) return;
    out.push(`// comments elided L${startLine + runStart}-${startLine + endExclusive - 1}`);
    runStart = -1;
  };
  const causalComment = /\b(?:race|mutex|lock(?:ed|ing)?|atomic|concurrent|partially[- ]written|silently lost|stale)\b/i;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const comment = /^\s*\/\//.test(line);
    if (comment && !causalComment.test(line)) {
      if (runStart < 0) runStart = index;
      continue;
    }
    flush(index);
    out.push(line);
  }
  flush(lines.length);
  return out.join("\n");
}

// T3 (2026-08-27, v0.12 wave D2, DEFECT B): max width of one side of the
// `remaining_ranges` disclosure centeredSliceForCap emits when the served
// window does not reach a file boundary. See the fix's own doc comment at
// the emission site for why this must never be the raw, unbounded leftover.
export const MAX_REMAINING_RANGE_CHUNK_LINES = 200;

/**
 * DESIGN-v0.9 §4.1 cliff fix: return a match-CENTERED, symbol-boundary-aware
 * trimmed chunk for an oversize `range` instead of `undefined` — a relevant
 * surface over MAX_SURFACE_CODE_BYTES must still ship SOME body (a trimmed
 * window is strictly better than the pre-v0.9 code-less surface). Generalizes
 * the wholeTinyFileFitsCap measure/clamp:
 *   - center on `centerLine` — the line that made the surface relevant (a
 *     candidate's matched line, or a diff hunk's anchor) — falling back to the
 *     `range` midpoint when none is given or it lands outside the range;
 *   - grow a WHOLE-LINE window symmetrically (alternating up/down, greedily
 *     filling whichever side still fits) until neither side's next line fits
 *     the cap;
 *   - report the uncovered spans of the ORIGINAL range as `remaining_ranges`
 *     (0, 1, or 2 "<start>-<end>" spans on the SAME handle — one re-slice each).
 * The window stays within [start,end] by construction, so for a symbol-kind
 * surface (whose `range` IS the symbol) it never spills past the symbol —
 * "symbol-boundary-aware" in the only sense this layer can know boundaries.
 *
 * Returns { code, remaining_ranges:[] } when the whole range already fits (the
 * sliceCode fast path, so callers can use this unconditionally). Returns
 * undefined ONLY for a genuine I/O error, a malformed range, or an empty slice
 * — NEVER "solely because of the cap" (the §4.1 acceptance bar).
 */
export function centeredSliceForCap(
  workspace: string,
  relPath: string,
  range: string,
  cache?: FileReadCache,
  centerLine?: number,
  maxBytes = MAX_SURFACE_CODE_BYTES,
  opts?: {
    fullRemainder?: boolean;
    /**
     * WP-S2 (TL_SEEDED_GENEROUS): take the fits-case slice through `sliceCode`
     * even though `maxBytes` is not the shared cap, so a whole-file body served
     * under the widened caller-named allowance keeps sliceCode's exact read
     * semantics — `sliceLinesToText`'s trailing-newline restoration at EOF (the
     * T1b three-way read parity fix) and the markers-only elision fallback.
     * Opt-in, because every OTHER caller that passes a custom `maxBytes` (the
     * wiring/hub embeds) is serving a WINDOW, not a whole file, and its bytes
     * must stay exactly as they are.
     */
    wholeFileParity?: boolean;
  },
): { code: string; remaining_ranges: string[] } | undefined {
  const m = range.match(/^(\d+)-(\d+)$/);
  if (!m) return undefined;
  const start = parseInt(m[1]!, 10);
  const end = parseInt(m[2]!, 10);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 1 || end < start) return undefined;

  const raw = readCached(workspace, relPath, cache);
  if (raw === undefined) return undefined;
  const fileLines = raw.split(/\r?\n/);
  const clampedEnd = Math.min(end, fileLines.length);
  if (clampedEnd < start) return undefined;
  const lang = languageForPath(relPath);

  // Whole-range fast path: fits the cap outright → serve it all (elided), no
  // remaining ranges. Delegates to sliceCode so the fits-case elide/cap
  // semantics stay single-sourced (sliceCode remains the shared fit helper;
  // this function only adds the OVERSIZE trim-and-report behavior on top).
  const whole = fileLines.slice(start - 1, clampedEnd).join("\n");
  if (whole.length === 0) return undefined;
  if (Buffer.byteLength(whole, "utf8") <= maxBytes) {
    const fit = maxBytes === MAX_SURFACE_CODE_BYTES
      ? sliceCode(workspace, relPath, range, cache)
      : opts?.wholeFileParity === true
        ? sliceCode(workspace, relPath, range, cache, maxBytes) ?? elideDocComments(whole, lang, start)
        : elideDocComments(whole, lang, start);
    if (fit !== undefined) return { code: fit, remaining_ranges: [] };
  }

  // Comment-heavy implementations can exceed the raw cap while their
  // executable body fits after the same elision used for returned slices.
  // Test that representation before fragmenting the handle.
  const compactWhole = elideDocComments(whole, lang, start);
  if (Buffer.byteLength(compactWhole, "utf8") <= maxBytes) {
    return { code: compactWhole, remaining_ranges: [] };
  }
  const causalMarkerCount = (compactWhole.match(/\b(?:data race|race condition|mutex|partially[- ]written|silently lost|stale pointer)\b/gi) ?? []).length;
  if (causalMarkerCount >= 2) {
    const causalCompact = elideCausalLineCommentRuns(compactWhole, start);
    if (Buffer.byteLength(causalCompact, "utf8") <= maxBytes) {
      return { code: causalCompact, remaining_ranges: [] };
    }
  }

  // Oversize: grow a whole-line window centered on the relevant line.
  let center = centerLine !== undefined && centerLine >= start && centerLine <= clampedEnd
    ? centerLine
    : Math.round((start + clampedEnd) / 2);
  if (center < start) center = start;
  if (center > clampedEnd) center = clampedEnd;

  const lineBytes = (n: number): number => Buffer.byteLength(fileLines[n - 1] ?? "", "utf8");
  // The center line is always included (even if it alone exceeds the cap — a
  // code-less surface is worse than one over-long line).
  let winStart = center;
  let winEnd = center;
  let bytes = lineBytes(center);
  let growUp = true;
  for (;;) {
    const canUp = winStart > start;
    const canDown = winEnd < clampedEnd;
    const upBytes = canUp ? lineBytes(winStart - 1) + 1 : Infinity; // + newline
    const downBytes = canDown ? lineBytes(winEnd + 1) + 1 : Infinity;
    const upFits = canUp && bytes + upBytes <= maxBytes;
    const downFits = canDown && bytes + downBytes <= maxBytes;
    if (!upFits && !downFits) break;
    // Alternate for centering, but only pick a side that actually fits.
    const pickUp = upFits && (!downFits || growUp);
    if (pickUp) { winStart -= 1; bytes += upBytes; } else { winEnd += 1; bytes += downBytes; }
    growUp = !growUp;
  }

  const windowText = fileLines.slice(winStart - 1, winEnd).join("\n");
  const remaining: string[] = [];
  // T3 (2026-08-27, v0.12 wave D2, DEFECT B -- field-eval report): a leftover
  // span reported verbatim can be thousands of lines wide on a huge file
  // (observed: a 23k-line file's discover-next named mode=slice range=1-7032
  // -- not an actionable zoom, and the exact non-actionable-next symptom
  // AGENTS.md's own protocol text warns every caller to expect a SMALL
  // slice, never a re-fetch-most-of-the-file range). Cap each side to the
  // chunk NEAREST the just-served window -- the part a caller asking to
  // "see more" almost always means -- rather than the raw remainder; a
  // caller that genuinely needs the far end can always re-slice again from
  // there. Both canonicalDecision.ts's servedDocumentZoom (the discover-next
  // builder) and every other remaining_ranges reader take this verbatim, so
  // capping it here is sufficient without touching any downstream consumer.
  // RANGE PRESERVATION (2026-09-19, reliability design 5.1: D = Q - (C u S)):
  // the nearest-chunk cap above is right for a surface TL discovered -- the
  // far end is optional context. It is wrong for a range the CALLER named:
  // every line of it is owed, and a remainder cut to the nearest 200 lines
  // made the continuation chain end there with the tail never scheduled
  // (requested 1-300, served window 1-99, remaining 100-299, line 300 lost;
  // a denser file lost 276-300). `fullRemainder` reports the whole remainder
  // and leaves paging to the follow-up read's own continuation.
  const chunkLines = opts?.fullRemainder === true
    ? Number.MAX_SAFE_INTEGER
    : MAX_REMAINING_RANGE_CHUNK_LINES;
  if (winStart > start) {
    const chunkStart = Math.max(start, winStart - chunkLines);
    remaining.push(`${chunkStart}-${winStart - 1}`);
  }
  if (winEnd < end) {
    const chunkEnd = Math.min(end, winEnd + chunkLines);
    remaining.push(`${winEnd + 1}-${chunkEnd}`);
  }
  return { code: elideDocComments(windowText, lang, winStart), remaining_ranges: remaining };
}

/**
 * B4: when `relPath` is a TINY file (≤ TINY_FILE_MAX_BYTES and
 * ≤ TINY_FILE_MAX_LINES), return a whole-file range "1-<EOF>" so the surface
 * HANDLE covers the entire stub instead of the narrow `range`. Returns the
 * ORIGINAL range unchanged when the file is not tiny, is unreadable, or is
 * empty (nothing to clamp to). Read-only for handle minting AND — item 4
 * (tiny-file whole embed) — as the candidate for a tiny surface's DISPLAY
 * range/embedded `code`, gated by wholeTinyFileFitsCap so the whole-file slice
 * only becomes the display range when it fits the per-surface byte cap.
 */
export function tinyFileWholeRange(workspace: string, relPath: string, range: string, cache?: FileReadCache): string {
  const raw = readCached(workspace, relPath, cache);
  if (raw === undefined) return range;
  if (Buffer.byteLength(raw, "utf8") > TINY_FILE_MAX_BYTES) return range;
  // BUG FIX (bench transcript forensics): raw.split(/\r?\n/).length counts a
  // PHANTOM final segment for content ending in a trailing newline (nearly
  // every file) — a 50-line file yielded lineCount=51, minting handle range
  // "1-51", which edit_code's OWN bounds check (util/countLines.ts's
  // countLines(), matching applyEditsMulti.ts's countLogicalLinesEntry())
  // then rejects as out of bounds for a 50-line file. countLines() is the
  // trailing-newline-aware count both the mint and the check now share.
  const lineCount = countLines(raw);
  if (lineCount > TINY_FILE_MAX_LINES || lineCount === 0) return range;
  return `1-${lineCount}`;
}

/**
 * Item 4 (tiny-file whole embed): true when embedding `relPath`'s whole file
 * as the code slice stays within the per-surface byte cap (MAX_SURFACE_CODE_BYTES).
 * A tiny file (by line/total-byte thresholds) can still be DENSE enough that
 * its whole body exceeds the per-slice cap — sliceCode would then reject it and
 * the surface would ship with NO code at all, strictly worse than the narrow
 * keyword window. Gating the whole-file DISPLAY range on this keeps the narrow
 * window in that case. Read-only; fail-closed (an unreadable file returns
 * false, so the caller keeps the widened window). Note: sliceCode's own cap
 * still runs afterward, so this is the display-range decision, not the final
 * embed guarantee.
 */
export function wholeTinyFileFitsCap(workspace: string, relPath: string, wholeRange: string, cache?: FileReadCache): boolean {
  const raw = readCached(workspace, relPath, cache);
  if (raw === undefined) return false;
  const m = wholeRange.match(/^(\d+)-(\d+)$/);
  if (!m) return false;
  const end = parseInt(m[2]!, 10);
  const lines = raw.split(/\r?\n/);
  const slice = lines.slice(0, Math.min(end, lines.length)).join("\n");
  return Buffer.byteLength(slice, "utf8") <= MAX_SURFACE_CODE_BYTES;
}

/**
 * F1 (2026-08-07, round-trip-aware supply, cont'd): a high-confidence
 * candidate's `servedRange` is a locate-time GUESS at the relevant window —
 * literalConcernCandidates (and friends) center a fixed-width window on the
 * matched/causal-evidence line, not on a byte budget. When that guess
 * already covers a STRICT MAJORITY of the file's lines, promoting to the
 * whole file only tops off a window the heuristic already judged dominant;
 * a genuinely narrow, deliberately-scoped window (a small match inside a
 * small-but-mostly-irrelevant file) is left untouched. Returns the
 * whole-file range only as a CANDIDATE — the caller must still confirm it
 * fits the same per-surface cap via centeredSliceForCap before using it, so
 * this function never itself decides a byte budget.
 */
export function wholeFileRangeIfDominant(
  workspace: string,
  relPath: string,
  servedRange: string,
  cache?: FileReadCache,
): string | undefined {
  const m = /^(\d+)-(\d+)$/.exec(servedRange);
  if (!m) return undefined;
  const start = parseInt(m[1]!, 10);
  const raw = readCached(workspace, relPath, cache);
  if (raw === undefined) return undefined;
  const total = countLines(raw);
  if (total <= 0) return undefined;
  const end = Math.min(parseInt(m[2]!, 10), total);
  if (start <= 1 && end >= total) return undefined; // already the whole file
  const served = Math.max(0, end - start + 1);
  if (served * 2 <= total) return undefined; // not a majority — leave the deliberate window alone
  return `1-${total}`;
}

/** A large markdown file above this size gets section-widened (item 11) instead of left as a narrow keyword window or read whole natively. */
export const LARGE_MARKDOWN_BYTES = 8192;

/** Cap on a widened markdown section's line count, so one huge section cannot swallow the whole surface budget. */
export const MAX_MARKDOWN_SECTION_LINES = 150;

/** Minimum context around a Markdown hit when its section is short. */
export const DOC_ANCHOR_RADIUS_LINES = 20;

/** Small file-complement threshold for one-shot Markdown embedding. */
export const DOC_INLINE_REMAINDER_MAX_LINES = 60;

/**
 * Widen a candidate range inside a large markdown file to cover its whole
 * enclosing section (from the nearest heading at/above the range's start
 * line, to the next heading of the same-or-higher level) instead of a
 * fixed keyword-centered window. This is what lets task_pack hand the
 * agent the relevant slice of a big CONTRACT.md/SPEC.md as a normal
 * handle-bearing surface instead of leaving the agent to Read the whole
 * 50K+ char file natively to find the right section.
 *
 * Only applies to files at/above LARGE_MARKDOWN_BYTES — a small doc file
 * is already cheap to return in full via its existing range.
 */
export function wholeMarkdownRangeIfSmallRemainder(
  workspace: string,
  relPath: string,
  range: string,
  cache?: FileReadCache,
): string | undefined {
  if (!isMarkdownPath(relPath)) return undefined;
  const m = /^(\d+)-(\d+)$/.exec(range);
  if (!m) return undefined;
  const raw = readCached(workspace, relPath, cache);
  if (raw === undefined) return undefined;
  const total = countLines(raw);
  const start = Number(m[1]);
  const end = Number(m[2]);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || total < end) {
    return undefined;
  }
  const remainder = (start - 1) + (total - end);
  return remainder <= DOC_INLINE_REMAINDER_MAX_LINES ? `1-${total}` : undefined;
}

export function widenMarkdownSectionRange(
  workspace: string,
  relPath: string,
  range: string,
  cache?: FileReadCache,
): string {
  if (!isMarkdownPath(relPath)) return range;
  const m = range.match(/^(\d+)-(\d+)$/);
  if (!m) return range;
  const rangeStart = parseInt(m[1]!, 10);
  const rangeEnd = parseInt(m[2]!, 10);
  // The incoming range is typically a fixed keyword-centered window
  // (matchLine - 10 .. matchLine + 10, see buildCandidateDetails), so its
  // MIDPOINT recovers the actual matched line — using range.start directly
  // would anchor on the window's edge instead of the match itself (e.g. a
  // match on line 11 arrives as range "1-21"; the midpoint, 11, is correct;
  // range.start, 1, is not — it would land on an unrelated heading above
  // the true match, such as the document's own title).
  const matchLine = Math.round((rangeStart + rangeEnd) / 2);

  const raw = readCached(workspace, relPath, cache);
  if (raw === undefined) return range;
  if (Buffer.byteLength(raw, "utf8") < LARGE_MARKDOWN_BYTES) return range;

  const lineCount = countLines(raw);
  const headings = parseMarkdownHeadings(raw);
  const section = markdownSectionAtLine(headings, matchLine);
  if (!section) return range;
  const sectionEnd = Math.min(section.endLine, lineCount);
  const sectionLines = sectionEnd - section.line + 1;
  // A complete section is preferable when it fits the bounded anchor. For
  // short sections, also include a real context window around the hit; this
  // prevents a one-line heading/body match from becoming a one-line surface.
  if (sectionLines <= MAX_MARKDOWN_SECTION_LINES) {
    const contextStart = Math.max(1, matchLine - DOC_ANCHOR_RADIUS_LINES);
    const contextEnd = Math.min(lineCount, matchLine + DOC_ANCHOR_RADIUS_LINES);
    return `${Math.min(section.line, contextStart)}-${Math.max(sectionEnd, contextEnd)}`;
  }
  // A huge section cannot fit as one bounded anchor. Keep the hit plus at
  // least twenty lines of surrounding document context instead.
  const contextStart = Math.max(1, matchLine - DOC_ANCHOR_RADIUS_LINES);
  const contextEnd = Math.min(lineCount, matchLine + DOC_ANCHOR_RADIUS_LINES);
  return `${contextStart}-${contextEnd}`;
}

/** Max heading lines carried in a contract doc's outline field (deliverable 3). */
export const MAX_CONTRACT_OUTLINE_HEADINGS = 30;

/** Max characters of a single heading's own text kept in the outline (post "#" markers). */
export const MAX_CONTRACT_OUTLINE_HEADING_CHARS = 70;

/**
 * DESIGN-v0.8 §A5 deliverable 3: for a matched contract-doc candidate
 * (`why === "doc-contract-match"`, minted by locateTaskContext's
 * addMarkdownContractCandidates), build a compact heading OUTLINE of the
 * WHOLE document — each real ATX or Setext heading with its 1-based line number —
 * alongside the matched section widenMarkdownSectionRange already slices.
 * A multi-topic contract doc (a live fixture's contract doc covers several
 * unrelated bug topics under one file) otherwise leaves the agent with only the ONE
 * section that happened to match this query's terms and no way to see
 * what ELSE the doc covers without a native full-file read — the outline
 * is what turns a follow-up need into a targeted `tl_read_file mode=slice`
 * over a known line range instead of another native dump.
 *
 * Reuses the shared fenced-code-aware Markdown heading parser used by section
 * widening, and follows the existing `outline: string[]` convention from readCodeSmallFile.ts
 * (`"L<n>: <heading text>"` entries) rather than inventing a new shape.
 *
 * Returns undefined when the path is not markdown, the file cannot be
 * read, or it has no headings at all — callers omit the field rather than
 * serialize an empty/meaningless array.
 */
export function buildContractDocOutline(workspace: string, relPath: string, cache?: FileReadCache): string[] | undefined {
  if (!isMarkdownPath(relPath)) return undefined;

  const raw = readCached(workspace, relPath, cache);
  if (raw === undefined) return undefined;

  const outline = markdownOutline(
    parseMarkdownHeadings(raw),
    MAX_CONTRACT_OUTLINE_HEADINGS,
    MAX_CONTRACT_OUTLINE_HEADING_CHARS,
  );
  return outline.length > 0 ? outline : undefined;
}

// widenNativeSymbolRange (C/C++ enclosing-symbol range widener) and its
// MAX_NATIVE_SYMBOL_LINES cap now live in util/nativeSymbolRange.ts, shared
// with locateTaskContext.ts's equivalent widener — see that module's doc
// comment. This call site passes `cache` (structurally compatible with
// FileReadCache's `read`/`parsedSymbols` shape) so repeated widening calls
// within one pack build stay memoized, matching prior behavior exactly.

/**
 * FIX-B3: coerce one paths[] entry to the canonical object shape — a bare
 * string becomes `{path: <string>}`; an already-object entry passes through
 * unchanged. Mirrors server.ts's mode="full" batch-paths coercion
 * (`typeof p === "object" && p !== null ? String(p.path) : String(p)`), which
 * task_pack's own dispatch had not applied, silently turning a supplied bare
 * string into an empty path (see TaskPackArgs.paths's doc comment).
 *
 * FX-M1/E1: also resolves a HANDLE-only entry (no `path` at all) — the shape
 * `server.ts`'s `legacyPathTarget` now preserves (rather than collapsing to
 * `{}`) for a bare `{handle}` target riding in a mixed
 * `targets:[{handle},{path}]` `tl_read_file` batch. `handleTable.get` is scoped
 * to THIS call's workspace via `callWorkspace()` — safe to read here with no
 * extra parameter because every caller of `buildTaskPack`/`buildSeededTaskPack`
 * runs inside `runWithCallWorkspace` (server.ts's dispatch wrapper), the same
 * ambient scoping `handleTable.get`'s own persistence-rehydrate path already
 * relies on. An entry whose handle cannot be resolved (unknown, or minted
 * against a different workspace) keeps `path:""` — unrepresentable as a real
 * TaskPackPathEntry, so it stays `""` deliberately, and the ONE call site
 * that gates on that emptiness (buildSeededTaskPack's malformed-entry check,
 * "invalid paths[] entry") reports the handle by name instead of a bare
 * "missing path" — see that gate for the disclosure. Threading `handle`
 * through on that failure path only (never on a successful resolve, where the
 * plain `{path}` shape callers already expect is unchanged byte-for-byte) is
 * why the return type carries an intersection cast rather than a
 * `TaskPackPathEntry.handle` field: no other reader of this type needs to
 * know about it, and the one that does reads it defensively.
 */
export function normalizePathEntry(p: TaskPackPathEntry | string): TaskPackPathEntry {
  if (typeof p === "string") return { path: p };
  const asRecord = p as unknown as Record<string, unknown>;
  if (typeof asRecord["path"] === "string" && asRecord["path"].length > 0) return p;
  const handle = typeof asRecord["handle"] === "string" ? asRecord["handle"] : undefined;
  if (handle === undefined) return p;
  const workspace = callWorkspace();
  const hEntry = handleTable.get(handle);
  const resolvedPath = hEntry !== undefined && workspace !== undefined && hEntry.workspaceRoot === workspace
    ? hEntry.path
    : undefined;
  if (resolvedPath !== undefined && resolvedPath.length > 0) {
    return { ...(p as TaskPackPathEntry), path: resolvedPath };
  }
  // Unresolved: keep `path:""` (the existing empty-path contract) but carry
  // the handle along so the malformed-entry gate can name it.
  return { ...(p as TaskPackPathEntry), path: "", handle } as unknown as TaskPackPathEntry;
}

export type DiscoveredArtifactFile = ReturnType<typeof discoverArtifactFiles>[number];

export interface MintedArtifactSurface {
  file: DiscoveredArtifactFile;
  bytes: Buffer;
  surface: ArtifactTaskPackSurface;
  credentialRef?: string;
  credentialPassword?: string;
}

/** Mint the exact discovery surface/handle shape shared with mode=artifact. */
export function mintArtifactSurface(
  file: DiscoveredArtifactFile,
  workspace: string,
  args?: Pick<TaskPackArgs, "credentialRef" | "credentialPassword">,
): MintedArtifactSurface | undefined {
  try {
    // Stat-first (FIFO/device/oversize) before materializing a discovered
    // artifact: this read happens before any container preflight can run.
    statReadTargetSync(file.absPath, workspace);
    // served-bytes: not-served (artifact mint: shaOfBytes for the handle; the artifact's own extractor serves its sections)
    const bytes = fs.readFileSync(file.absPath);
    const handle = handleTable.upsert({
      kind: "file",
      path: file.relPath,
      workspaceRoot: workspace,
      sha: shaOfBytes(bytes),
    });
    return {
      file,
      bytes,
      ...(args?.credentialRef !== undefined ? { credentialRef: args.credentialRef } : {}),
      ...(args?.credentialPassword !== undefined ? { credentialPassword: args.credentialPassword } : {}),
      surface: {
        path: file.relPath,
        basename: path.posix.basename(file.relPath),
        kind: "artifact",
        // .tsv normalizes to the "csv" kind so a single csv branch downstream
        // (extractArtifactBuildSection) serves both; every other artifact ext
        // maps 1:1 to its kind (.xlsx→"xlsx", .pdf→"pdf", …).
        artifactKind: (file.ext === ".tsv" ? "csv" : file.ext.slice(1)) as ArtifactKind,
        size: bytes.byteLength,
        handle: handle.id,
        extract: `tl_read_file {targets:[{path:${JSON.stringify(file.relPath)}${
          args?.credentialRef !== undefined
            ? `, credentialRef:${JSON.stringify(args.credentialRef)}`
            : ""
        }}]}`,
      },
    };
  } catch {
    return undefined;
  }
}
