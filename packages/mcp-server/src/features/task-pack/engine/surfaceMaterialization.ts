// surfaceMaterialization — extracted implementation; imports point to the owning modules.
import * as fs from "fs";
import * as path from "path";
import type { ContinuationCall } from "./packBasics.js";
import type { ImpactCandidate } from "@tokenlighten/types";
import type { TaskPackResult } from "../model.js";
import type { TaskPackSurface } from "../model.js";
import { ANCHOR_FOCUS_MAX_RUNNER_UPS } from "./anchorFocus.js";
import { FileReadCache } from "./packBasics2.js";
import { HIGH_CONFIDENCE_THRESHOLD } from "./packBasics2.js";
import { HUB_WHOLE_EXTRA_CAP_BYTES } from "./packBasics.js";
import { MAX_TASK_PACK_BYTES } from "./packBasics.js";
import { MAX_TASK_PACK_BYTES_ARTIFACT_BUNDLE } from "./packBasics.js";
import { MAX_TASK_PACK_BYTES_CONSTRUCT_PROOF } from "./packBasics.js";
import { MAX_TASK_PACK_BYTES_HIGH_CONFIDENCE } from "./packBasics.js";
import { MAX_TASK_PACK_BYTES_MULTI_CONCERN } from "./packBasics.js";
import { MAX_TASK_PACK_BYTES_SEMANTIC_WIRING } from "./packBasics.js";
import { PROJECT_BOUNDARY_MARKERS } from "./contractReconciliation2.js";
import { anchorFocusRunnerUpOutline } from "./anchorFocus3.js";
import { appendWhySegmentOnce } from "./seedResolution.js";
import { buildCompactTree } from "../../../tools/exploreTree.js";
import { buildContractDocOutline } from "./packBasics2.js";
import { buildLikelyEdits } from "./surfaceMaterialization2.js";
import { centeredSliceForCap } from "./packBasics2.js";
import { clampRangeToFile } from "./packBasics2.js";
import { codeTaskPackSurfaces } from "../artifactSections.js";
import { collectSymbols } from "../../../symbols/collectSymbols.js";
import { commonAncestorDir } from "./seedResolution.js";
import { countLines } from "../../../util/countLines.js";
import { decodeTextBuffer } from "../../../util/textDecode.js";
import { dominantRoot } from "../../../util/dominantRoot.js";
import { doneCheckForRole } from "./createAndWiringEndpoints2.js";
import { editIntentForRole } from "./createAndWiringEndpoints2.js";
import { effHubWholeEnabled } from "../../../util/flags.js";
import { genericDoneCheck } from "./createAndWiringEndpoints2.js";
import { genericEditIntent } from "./createAndWiringEndpoints2.js";
import { goVerificationEntry } from "../../../util/goVerification.js";
import { goVerificationHint } from "../../../util/goVerification.js";
import { handleTable } from "../../../util/handles.js";
import { hasServedCode } from "./wiringEvidence2.js";
import { isArtifactConsumerSurface } from "../artifactConsumers.js";
import { isDirectoryWithin } from "./seedResolution.js";
import { isMarkdownPath } from "../../../util/markdownSections.js";
import { isModuleClosureSurface } from "./surfaceMaterialization2.js";
import { isNativeExtPath } from "../../../util/nativeSymbolRange.js";
import { languageForPath } from "../../../util/languages.js";
import { markExplicitRangeSurface } from "../sfWithholdingMarks.js";
import { mustFetchPackCap } from "../../../util/mustFetch.js";
import { nativeSyntaxCheck } from "../../../util/verificationPack.js";
import { noteUnreadableNamedPath } from "./queryIntent3.js";
import { projectRootOf } from "../../locator/locateTaskContext.js";
import { pythonSyntaxCheck } from "../../../util/verificationPack.js";
import { readCached } from "./packBasics2.js";
import { refocusCandidateForQuery } from "./anchorFocus3.js";
import { seededGenerousPackTier } from "./surfaceMaterialization2.js";
import { selectAnchorFocus } from "./anchorFocus3.js";
import { sliceCodeAfterCommentElision } from "./packBasics2.js";
import { surfaceWhyHasMarker } from "./recursiveClosure.js";
import { tinyFileWholeRange } from "./packBasics2.js";
import { wholeFileRangeIfDominant } from "./packBasics2.js";
import { wholeMarkdownRangeIfSmallRemainder } from "./packBasics2.js";
import { wholeTinyFileFitsCap } from "./packBasics2.js";
import { whySummary } from "./surfaceMaterialization2.js";
import { widenMarkdownSectionRange } from "./packBasics2.js";
import { widenNativeRangeString } from "../../../util/nativeSymbolRange.js";

export function hasProjectBoundaryMarker(workspace: string, dir: string): boolean {
  return PROJECT_BOUNDARY_MARKERS.some((name) => fs.existsSync(path.join(workspace, dir, name)));
}

/**
 * Walk upward from `rel`'s directory looking for the NEAREST package.json.
 * Stops (without crediting a test/typecheck script) as soon as a non-npm
 * project-boundary marker (Makefile, CMakeLists.txt, Cargo.toml, ...) is
 * found first — that marker means this subtree owns its own toolchain and
 * an ancestor's package.json belongs to an unrelated host project, not this
 * surface's own build.
 */
export function findNearestNpmScripts(workspace: string, rel: string): { dir: string; pkg: { scripts?: Record<string, string> } } | null {
  const parts = rel.split("/");
  for (let i = parts.length - 1; i >= 0; i--) {
    const dir = parts.slice(0, i).join("/");
    if (hasProjectBoundaryMarker(workspace, dir)) return null;
    const pkgPath = path.join(workspace, dir, "package.json");
    try {
      // P3 (2026-08-27): decodeTextBuffer, not a raw utf8 read; an
      // undecodable package.json is treated the same as an absent/unparsable
      // one — keep walking upward, never crash and never JSON.parse garbage.
      // served-bytes: not-served (package.json scripts: JSON.parse, never served)
      const decoded = decodeTextBuffer(fs.readFileSync(pkgPath));
      if (decoded === null) continue;
      const pkg = JSON.parse(decoded) as { scripts?: Record<string, string> };
      return { dir, pkg };
    } catch {
      // keep walking upward
    }
  }
  return null;
}

/**
 * DESIGN-v0.8 §C2 item 1: the project root that OWNS most of the selected
 * surfaces — reuses locateTaskContext's own `projectRootOf` (the
 * `bench/fixtures/<name>` vs host-repo boundary A2 already established)
 * rather than a second, potentially-drifting definition of the same
 * boundary. Majority vote over the surfaces' own roots (count weight, via
 * the shared `dominantRoot` helper in util/dominantRoot.ts — see its doc
 * comment for the general shape locateTaskContext.ts's `computeDominantRoot`
 * also builds on), not just surfaces[0]'s root: a pack whose primary
 * surface happens to be the one contaminating outlier must still resolve to
 * the root the REST of the pack actually lives under. Ties break toward
 * whichever root is encountered first (stable, deterministic — surfaces are
 * already in a meaningful priority order by the time this runs). Adapts
 * `dominantRoot`'s `null`-on-empty to this call site's original `""`-on-
 * empty contract, so every existing caller is unaffected.
 */
export function dominantRootOf(surfaces: TaskPackSurface[]): string {
  return dominantRoot(surfaces, (s) => projectRootOf(s.path)) ?? "";
}

/**
 * DESIGN-v0.8 §A7: byte cap for a partial pack's embedded `tree` field. Kept
 * well under the pack's own byte cap (the tree is a navigation aid, not the
 * payload) and independently of exploreTree's own TREE_CAP_BYTES so a full
 * `explore action=tree` call can return a larger inventory than the inline
 * partial-pack teaser.
 */
export const PARTIAL_TREE_CAP_BYTES = 512;

/**
 * The workspace-relative common-ancestor directory of `surfaces`' paths that
 * are under the dominant root — the subtree an agent following THIS pack would
 * most plausibly want a wider inventory of. Returns "" (whole-root) when the
 * cluster shares no directory below the root itself.
 */
export function partialTreeSubPath(surfaces: TaskPackSurface[]): string {
  const dominantRoot = dominantRootOf(surfaces);
  const clusterPaths = surfaces.map((s) => s.path).filter((p) => projectRootOf(p) === dominantRoot);
  return commonAncestorDir(clusterPaths.length > 0 ? clusterPaths : surfaces.map((s) => s.path));
}

/**
 * DESIGN-v0.8 §A7: on a PARTIAL pack with at least one surface, attach a
 * compact one-line-per-dir tree of the surfaces' dominant-root cluster as
 * `result.tree`, and mention `explore action=tree` in `next` so the agent
 * reaches for the (larger, byte-capped) explore inventory instead of a native
 * `find`. No-op on complete packs, empty-surface packs, or an unavailable
 * tree. Runs BEFORE trimToCap so its bytes count toward the budget and the
 * trim ladder can drop it first when the pack is over cap.
 */
export function attachPartialTree(result: TaskPackResult, workspace: string, unresolvedFileParents: readonly string[] = []): void {
  if (result.coverage !== "partial" || result.surfaces.length === 0) return;
  const subPath = unresolvedFileParents.find(candidate => isDirectoryWithin(candidate, workspace))
    ?? partialTreeSubPath(result.surfaces);
  const compact = buildCompactTree(workspace, subPath || undefined, undefined, PARTIAL_TREE_CAP_BYTES);
  if (compact.tree.length === 0) return;
  result.tree = compact.tree;
  // Point the agent at the fuller inventory rather than a native `find`, but
  // never concatenate two commands into legacy `next`: that string must stay
  // exactly parseable into one schema-valid execution_contract.next_call.
  // The compact tree is already present inline, so an existing primary next is
  // sufficient. Use tree only when no more specific follow-up exists.
  const treeHint: ContinuationCall = {
    tool: "tl_search_files",
    arguments: { action: "tree", ...(subPath ? { path: subPath } : {}) },
  };
  if (result.next === undefined) result.next = treeHint;
}

/** Cap on the number of `verify` command hints returned (DESIGN-v0.8 §C1 item 4: lowered from 5 to 2). */
export const MAX_VERIFY_HINTS = 2;

/** Translation units the native verify hint's syntax check names (the edit kit's own check names up to 8). */
export const PACK_SYNTAX_CHECK_MAX_UNITS = 4;

export function discoverVerificationHints(workspace: string, query: string, surfaces: TaskPackSurface[]): string[] {
  void query;
  const hints = new Set<string>();
  // DESIGN-v0.8 §C2 item 1: scope every hint below to paths under the
  // SELECTED surfaces' own dominant root — a host-repo surface that leaked
  // into an otherwise fixture-scoped pack (or vice versa) must not seed a
  // `cd packages/vscode-extension && npm test` / `cd bench/fixtures/x && ...`
  // hint the rest of the pack has nothing to do with. findNearestNpmScripts'
  // own PROJECT_BOUNDARY_MARKERS guard already stops a single path from
  // walking PAST its own project boundary; this is the complementary guard
  // against a MIXED-root surface set feeding the wrong path in at all.
  const dominantRoot = dominantRootOf(surfaces);
  const paths = surfaces.map((s) => s.path).filter((p) => projectRootOf(p) === dominantRoot);

  for (const rel of paths) {
    const found = findNearestNpmScripts(workspace, rel);
    if (!found) continue;
    const { dir, pkg } = found;
    if (pkg.scripts?.test) {
      hints.add(dir ? `cd ${dir} && npm test` : "npm test");
    }
    if (pkg.scripts?.typecheck) {
      hints.add(dir ? `cd ${dir} && npm run typecheck` : "npm run typecheck");
    }
  }

  const goHint = goVerificationHint(goVerificationEntry(workspace, paths));
  if (goHint) hints.add(goHint);
  if (paths.some((p) => p.endsWith(".rs")) || fs.existsSync(path.join(workspace, "Cargo.toml"))) hints.add("cargo test");
  const pythonPaths = paths.filter((p) => p.endsWith(".py"));
  if (pythonPaths.length > 0) {
    // 2026-10-20 (decision window 6t-7): when the PATH's python3 falls short
    // of the project (requires-python, declared modules), a bare "pytest"
    // runs under the wrong interpreter. State the check an edit kit carries
    // instead (verificationPack.ts pythonSyntaxCheck), then which interpreter
    // and why.
    const check = pythonSyntaxCheck(workspace, pythonPaths, { maxUnits: PACK_SYNTAX_CHECK_MAX_UNITS });
    if (check === undefined) {
      hints.add("pytest");
    } else {
      hints.add(check.commands[0]!);
      hints.add(check.note);
    }
  }
  if (paths.some((p) => p.endsWith(".java"))) {
    if (fs.existsSync(path.join(workspace, "pom.xml"))) hints.add("mvn test");
    if (fs.existsSync(path.join(workspace, "gradlew"))) hints.add("./gradlew test");
  }

  // C/C++ awareness (item 7): ungated on query keywords — any pack whose
  // surfaces are C/C++ needs a verify hint regardless of what words the
  // query used. Prefer a real build-system command when one exists in the
  // surface's own subtree; otherwise say plainly that there is no
  // discoverable toolchain, rather than staying silent or emitting an
  // unrelated `npm test` from a distant ancestor.
  const nativePaths = paths.filter((p) => /\.(c|cc|cpp|cxx|h|hpp|hh|hxx)$/.test(p));
  if (nativePaths.length > 0) {
    let buildCmd: string | null = null;
    for (const rel of nativePaths) {
      const parts = rel.split("/");
      for (let i = parts.length - 1; i >= 0; i--) {
        const dir = parts.slice(0, i).join("/");
        if (fs.existsSync(path.join(workspace, dir, "CMakeLists.txt"))) {
          buildCmd = dir ? `cmake --build ${dir}` : "cmake --build .";
          break;
        }
        if (fs.existsSync(path.join(workspace, dir, "Makefile")) || fs.existsSync(path.join(workspace, dir, "makefile"))) {
          buildCmd = dir ? `make -C ${dir}` : "make";
          break;
        }
      }
      if (buildCmd) break;
    }
    if (buildCmd !== null) {
      hints.add(buildCmd);
    } else {
      // 2026-10-19 (decision window 6t-6): with a compiler on PATH this said
      // "no build toolchain detected" beside a plan.verification naming
      // clang++. Now it states the check an edit kit carries
      // (verificationPack.ts nativeSyntaxCheck), then how to read its result.
      const check = nativeSyntaxCheck(workspace, nativePaths, { maxUnits: PACK_SYNTAX_CHECK_MAX_UNITS });
      if (check === undefined) {
        hints.add("no build toolchain detected for this native module: verify by tracing the code path against the reported symptom");
      } else {
        hints.add(check.commands[0]!);
        hints.add(check.note);
      }
    }
  }

  return [...hints].slice(0, MAX_VERIFY_HINTS);
}

// ---------------------------------------------------------------------------
// Convert an ImpactCandidate to a TaskPackSurface (minting handles).
// ---------------------------------------------------------------------------

/**
 * Resolve a candidate's named symbol to the parser's real body range.
 *
 * Locator candidates can carry an enclosing symbol name together with a
 * keyword-centered range. Treating that pair as a symbol handle is misleading:
 * the handle says "class/function" while covering only a few lines around the
 * hit. Prefer the exact parsed range when available; keep the locator window on
 * unsupported languages or parse failure.
 */
export async function parsedCandidateSymbolRange(
  candidate: ImpactCandidate,
  workspace: string,
  cache?: FileReadCache,
): Promise<string | undefined> {
  if (!candidate.symbol) return undefined;
  const content = readCached(workspace, candidate.path, cache);
  const lang = languageForPath(candidate.path);
  if (content === undefined || lang === undefined) return undefined;
  const parsed = cache
    ? await cache.parsedSymbols(content, lang, candidate.path)
    : await collectSymbols(content, lang, {}).catch(() => null);
  if (!parsed || parsed.length === 0) return undefined;

  const normalizedTarget = candidate.symbol.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (normalizedTarget.length === 0) return undefined;
  const named = parsed.filter((symbol) => {
    const normalizedName = symbol.name.toLowerCase().replace(/[^a-z0-9]/g, "");
    return normalizedName === normalizedTarget
      || normalizedTarget.endsWith(normalizedName)
      || normalizedName.endsWith(normalizedTarget);
  });
  if (named.length === 0) return undefined;
  const containing = named.filter((symbol) =>
    symbol.startLine <= candidate.line && symbol.endLine >= candidate.line
  );
  const chosen = (containing.length > 0 ? containing : named)
    .sort((a, b) => (a.endLine - a.startLine) - (b.endLine - b.startLine))[0];
  return chosen ? `${chosen.startLine}-${chosen.endLine}` : undefined;
}

/** Cap on remaining-range disclosure entries per surface (wire weight). */
export const MAX_REMAINING_RANGE_ENTRIES = 3;

/**
 * Serve-honesty (2026-08-01): bounded remaining-span disclosure for a served
 * surface — embed-trim spans first (they are the precise zoom targets), then
 * the served range's complement within the WHOLE file. Empty when the file is
 * fully covered. Completeness stamped relative to the served range only
 * (the pre-fix §4.1 behavior) let a surface that embedded its whole range
 * while covering part of the file read as complete (T05c rep2:
 * mode_manager.cpp served 136-309 of 309 with no stamp, no remaining_ranges),
 * so the guide's zoom affordance never fired and the caller's only visible
 * continuation was native IO.
 */
export function partialityStamp(
  workspace: string,
  relPath: string,
  servedRange: string,
  embedRemaining: string[],
  cache?: FileReadCache,
  callerWindow = false,
): { content_completeness?: "partial"; remaining_ranges?: string[] } {
  const remaining = [...embedRemaining];
  // A caller-EXPLICIT range is a hard window (11a): its remainder protocol is
  // "advance INSIDE the window" — embed-trim spans only. Appending the file
  // complement would point the zoom OUTSIDE the window the caller pinned and
  // break remainder progress (every entry must start past the window head).
  const match = callerWindow ? null : /^(\d+)-(\d+)$/.exec(servedRange);
  const content = match ? readCached(workspace, relPath, cache) : undefined;
  if (match && content !== undefined) {
    const start = Number(match[1]);
    const end = Number(match[2]);
    const total = countLines(content);
    if (start > 1) remaining.push(`1-${start - 1}`);
    if (end < total) remaining.push(`${end + 1}-${total}`);
  }
  const deduped = [...new Set(remaining)].slice(0, MAX_REMAINING_RANGE_ENTRIES);
  if (deduped.length === 0) return {};
  // The "partial" LABEL stays scoped to an embed-level trim — the served
  // slice itself was cut (§4.1), which is what the readiness risk model's
  // partial-surface-content factor prices. A COMPLETE embed whose file merely
  // has more content discloses the remainder as zoomable remaining_ranges
  // without the label: it is a normal serving shape, not false-ready risk,
  // and labeling it demoted every windowed-but-whole serve to discovery
  // (4 replay-corpus prepared certificates regressed before this split).
  return embedRemaining.length > 0
    ? { content_completeness: "partial", remaining_ranges: deduped }
    : { remaining_ranges: deduped };
}

export async function candidateToSurface(
  candidate: ImpactCandidate,
  workspace: string,
  requiredRoles: string[],
  query: string,
  cache?: FileReadCache,
  options?: {
    answerProfile?: boolean;
    causalMultiMethod?: boolean;
    /**
     * WP-S2 rule 2 (TL_SEEDED_GENEROUS): per-surface embedded-code allowance
     * for THIS candidate, overriding MAX_SURFACE_CODE_BYTES. Set only by
     * `buildSeededTaskPack`'s caller-NAMED whole-file seeds on an `answer`
     * profile, and only after that builder's water-filling pass proved the
     * pack budget can carry the body — every other call site omits it and
     * keeps the shared cap exactly.
     */
    surfaceCodeBytes?: number;
  },
): Promise<TaskPackSurface> {
  const callerScoped = surfaceWhyHasMarker(candidate.why, "caller-supplied");
  // SHOULD-FIX 58 (AB1, 2026-09-14, review round 11): DISCLOSE, wherever the
  // candidate came from. `augmentQueryNamedFileSurfaces` is the only caller of
  // `noteUnreadableNamedPath` on door 1 and it skips a path something else
  // surfaced first (`if (already.has(rel)) continue;`), so whether a caller was
  // told the reason depended on the WORKSPACE SHAPE: AA1's own door log shows
  // `latin1.ts` / `short73.ts` / `nulpast4k.ts` / `sjis.ts` surfaced as
  // `{why:"filename-match", len:0}` with no disclosure at all, and `latin1.ts`'s
  // prescribed `next` refusing. This is the one place EVERY surface is built, so
  // it is where the fact belongs: a path the serve-side policy will not read is
  // named in `missing`/`unresolved` (the store is per-`buildTaskPack` ALS and
  // de-dupes), and `coverage` can no longer be `complete` over it.
  //
  // Cheap: `readCached` is the same memo every later step in this function uses
  // (`clampRangeToFile`, `tinyFileWholeRange`, `sliceCode`), so this adds no
  // read — it only observes the one that was going to happen anyway.
  if (readCached(workspace, candidate.path, cache) === undefined) {
    // SHOULD-FIX 65 (AC1, round 12): a LOCATOR candidate. The request may never
    // have mentioned it, so the disclosure must not claim it did — `"request"`
    // still wins if the query-named site notes the same path.
    noteUnreadableNamedPath(workspace, candidate.path, "resolution");
  }
  candidate = refocusCandidateForQuery(candidate, workspace, query, cache);
  const role = candidate.surface as string;
  const rawRange = candidate.range ?? `${candidate.line}-${candidate.line}`;
  const parsedSymbolRange = await parsedCandidateSymbolRange(candidate, workspace, cache);
  // Item 11: a large markdown contract/spec candidate gets its range
  // widened to the whole enclosing section instead of the locator's fixed
  // keyword-centered window, so the pack can hand over the relevant
  // section as a real slice instead of leaving the agent to Read the
  // whole file natively. DESIGN-v0.8 §A5 deliverable 2: a C/C++ candidate
  // gets the same treatment, widened to its enclosing symbol instead of a
  // section — see widenNativeSymbolRange's doc comment.
  // A caller-EXPLICIT range is a hard window (11a parity for the pack path,
  // 2026-07-30): never widen it back to the enclosing symbol/section. A
  // remaining_ranges zoom that gets re-widened re-serves already-held bytes
  // and its remaining_ranges never advance (live T03 loop).
  const widenedRange = candidate.callerRange === true
    ? rawRange
    : candidate.symbol
      ? parsedSymbolRange ?? rawRange
      : isNativeExtPath(candidate.path)
        ? await widenNativeRangeString(workspace, candidate.path, rawRange, cache)
        : widenMarkdownSectionRange(workspace, candidate.path, rawRange, cache);
  const boundedRange = clampRangeToFile(workspace, candidate.path, widenedRange, cache);

  // B4: a range-kind candidate on a TINY file gets a WHOLE-FILE handle
  // (1-EOF). A partial-range handle on a tiny stub inevitably forces the agent
  // to re-slice for the rest of the file (the live tiny-stub failure). Symbol-kind
  // candidates keep their symbol-precise handle (a symbol handle already covers
  // the whole symbol; re-pointing it at the file would lose that precision).
  // Returns the widened range unchanged when the file is not tiny or is
  // unreadable, so non-tiny files are unaffected.
  const tinyWholeRange = candidate.symbol
    ? boundedRange
    : tinyFileWholeRange(workspace, candidate.path, boundedRange, cache);

  // Item 4 (tiny-file whole embed): for a TINY non-symbol file, DISPLAY the
  // whole-file range (and, below, slice the whole file as `code`) instead of a
  // narrow keyword window that would force a follow-up `read_code mode=slice`
  // just to see the rest of a small stub. Only when the whole-file slice
  // actually fits the per-surface byte cap (checked here so a tiny-but-dense
  // file between MAX_SURFACE_CODE_BYTES and TINY_FILE_MAX_BYTES keeps the
  // narrow window rather than losing its code entirely to sliceCode's own cap
  // rejection); trimToCap Phase 5 may still strip the whole-file code under
  // pack-level pressure (unchanged, honest). A large file keeps its windowed
  // slice — tinyWholeRange === widenedRange there, so `range` is unchanged.
  let range =
    !candidate.symbol
    && candidate.callerRange !== true
    && tinyWholeRange !== boundedRange
    && wholeTinyFileFitsCap(workspace, candidate.path, tinyWholeRange, cache)
      ? tinyWholeRange
      : boundedRange;

  // The handle covers the whole tiny file regardless of whether the DISPLAY
  // range was widened to it (a narrow display range still wants a whole-file
  // handle — the tiny-file fix), so mint against tinyWholeRange, not `range`.
  const handleRange = tinyWholeRange;

  // Reuse the handle already minted by locateTaskContext ONLY when the handle
  // range was not changed by widening OR the tiny-file clamp (either change
  // needs its own handle, since the original still points at the narrow
  // keyword window).
  let handleId: string;
  if (candidate.handle && handleRange === rawRange) {
    handleId = candidate.handle;
  } else {
    const kind = candidate.symbol ? "symbol" : "range";
    const entry = handleTable.upsert({
      kind,
      path: candidate.path,
      range: handleRange,
      ...(candidate.symbol ? { symbol: candidate.symbol } : {}),
      workspaceRoot: workspace,
    });
    handleId = entry.id;
  }

  // Derive a short why string from the candidate's why field.
  const summarizedWhy = candidate.why
    ? whySummary(candidate.why, candidate.symbol, role)
    : undefined;
  // AA1 (2026-09-14, review round 10): the ONE place a NUL strip is STATED for
  // ANY surface. `readServedText`'s `"stripped"` verdict is only honest if the
  // response says so, and rounds 5-8 stated it at exactly the two doors that
  // happened to notice: `augmentQueryNamedFileSurfaces` (its own
  // "query-named-file; nul-stripped") and the seeded loop (`nulStrippedSeedPaths`).
  // Now that `FileReadCache.read` applies the policy, an ORDINARY LOCATOR
  // candidate for the same file is also served NUL-free -- and used to be served
  // with no annotation at all, because the augmentation skips a path the locator
  // already surfaced (`already.has(rel)`). Every surface built from a path THIS
  // cache read and stripped now carries the marker, wherever the candidate came
  // from. Inserted BEFORE a trailing "caller-supplied" for the same reason the
  // seeded loop does (see its comment): `surfaceWhyHasMarker` re-appends that
  // token, so the qualifier list must read "...; nul-stripped; caller-supplied".
  // The exact-segment guard keeps a route that already stated it from doubling.
  const nulStrippedByCache = cache?.verdictFor(candidate.path)?.kind === "stripped"
    && !(summarizedWhy !== undefined && surfaceWhyHasMarker(summarizedWhy, "nul-stripped"));
  const strippedWhy = summarizedWhy === undefined
    ? (nulStrippedByCache ? "nul-stripped" : undefined)
    : nulStrippedByCache ? `${summarizedWhy}; nul-stripped` : summarizedWhy;
  const why = callerScoped && strippedWhy
    ? appendWhySegmentOnce(strippedWhy, "caller-supplied")
    : strippedWhy;

  // Build likely_edits: a single generic hint based on role (or the
  // candidate's raw `why`, when it carries more specific guidance — see
  // DESIGN-v0.8 §A6 deliverable 1 — NOT the human-summarized `why` local
  // above, which is display text, not the machine-checkable raw tag).
  const answerProfile = options?.answerProfile === true;
  const editIntent = answerProfile ? undefined : editIntentForRole(query, role, candidate.why);
  const doneCheck = answerProfile ? undefined : doneCheckForRole(query, role, candidate.why);
  const required = requiredRoles.includes(role) || candidate.required === true;
  // DESIGN-v0.8 §C1 item 1: likely_edits is boilerplate on every SECONDARY
  // surface — build it only for a required surface here; the pack-assembly
  // callers additionally run finalizePrimarySurface() so surfaces[0] keeps it
  // even when nothing in the pack is required.
  const likelyEdits = !answerProfile && required
    ? buildLikelyEdits(role, handleId, candidate.confidence)
    : [];

  // A2 item 1: embed the exact code for required/high-confidence surfaces so
  // the pack can close the task in one read instead of forcing a follow-up
  // mode=slice call per surface. Lower-confidence surfaces stay
  // handle-only (no `code`) to keep the pack compact — the agent widens via
  // `read_code mode=slice handle=<handle>` only when it actually needs that
  // content.
  // A markdown-contract-section match (item 11) always embeds its slice
  // when found at all: locating the right section IS the hard part, and a
  // handle without the section text still forces a follow-up read.
  // DESIGN-v0.8 §A5 deliverable 1: a NATIVE_EXTS (C/C++) surface also always
  // embeds, regardless of confidence — see isNativeExtPath's doc comment.
  const isHighConfidence = answerProfile || required || candidate.confidence >= HIGH_CONFIDENCE_THRESHOLD || candidate.why === "doc-contract-match" || isNativeExtPath(candidate.path);
  // DESIGN-v0.9 §4.1: centeredSliceForCap never returns undefined "solely
  // because of the cap" — an oversize surface gets a match-centered trimmed
  // body + remaining_ranges instead of the old code-less cliff. Center on the
  // candidate's own matched line when known (finer than the range midpoint).
  const centeredEmbed = isHighConfidence
    ? centeredSliceForCap(workspace, candidate.path, range, cache, candidate.line, options?.surfaceCodeBytes, {
        fullRemainder: candidate.callerRange === true,
        ...(options?.surfaceCodeBytes !== undefined ? { wholeFileParity: true } : {}),
      })
    : undefined;
  const fullAfterElision = centeredEmbed?.remaining_ranges.length
    ? sliceCodeAfterCommentElision(
        workspace,
        candidate.path,
        range,
        cache,
        options?.causalMultiMethod === true,
      )
    : undefined;
  let embed = fullAfterElision !== undefined
    ? { code: fullAfterElision, remaining_ranges: [] }
    : centeredEmbed;

  // F1 (2026-08-07): a complete embed (no cap-driven trim) whose range is
  // already the dominant majority of the file gets one shot at promotion to
  // the WHOLE file, shipped as a complete embed with no remaining_ranges at
  // all — this is what actually removes the deterministic follow-up
  // same-handle re-slice for the complement (measured: T05c-shaped packs,
  // 12/12 cells re-requested the exact head complement of a majority-served
  // native surface). Bounded by construction: it can never make a single
  // surface bigger than MAX_SURFACE_CODE_BYTES already allowed it to be
  // (centeredSliceForCap enforces that below, and a non-fit aborts the
  // promotion), and it only fires when the locate-time window was already
  // dominant, so a small match inside an unrelated small file keeps its
  // narrow, deliberately-scoped window. Symbol-kind and caller-pinned
  // ranges are hard windows (DESIGN-v0.8 §B4 / 11a) and are never widened.
  if (
    embed !== undefined
    && embed.remaining_ranges.length === 0
    && candidate.symbol === undefined
    && candidate.callerRange !== true
  ) {
    const wholeRange = wholeFileRangeIfDominant(workspace, candidate.path, range, cache);
    if (wholeRange !== undefined) {
      const wholeEmbed = centeredSliceForCap(workspace, candidate.path, wholeRange, cache, candidate.line);
      if (wholeEmbed !== undefined && wholeEmbed.remaining_ranges.length === 0) {
        range = wholeRange;
        embed = wholeEmbed;
        handleId = handleTable.upsert({
          kind: "range",
          path: candidate.path,
          range: wholeRange,
          workspaceRoot: workspace,
        }).id;
      }
    }
  }
  // A small file-complement is cheaper to inline than a guaranteed follow-up:
  // promote it only when the whole Markdown file fits the existing per-surface
  // cap. The pack-level trim still decides whether the resulting pack fits.
  if (
    !candidate.symbol
    && candidate.callerRange !== true
    && isMarkdownPath(candidate.path)
    && embed !== undefined
    && embed.remaining_ranges.length === 0
  ) {
    const wholeRange = wholeMarkdownRangeIfSmallRemainder(workspace, candidate.path, range, cache);
    if (wholeRange !== undefined && wholeRange !== range) {
      const wholeEmbed = centeredSliceForCap(workspace, candidate.path, wholeRange, cache, candidate.line);
      if (wholeEmbed !== undefined && wholeEmbed.remaining_ranges.length === 0) {
        range = wholeRange;
        embed = wholeEmbed;
        handleId = handleTable.upsert({
          kind: "range",
          path: candidate.path,
          range: wholeRange,
          workspaceRoot: workspace,
        }).id;
      }
    }
  }

  // DESIGN-v0.8 §A5 deliverable 3: a matched contract-doc surface also
  // carries the whole document's heading outline alongside its matched
  // section, so a multi-topic doc can be sliced targeted instead of
  // natively dumped when the task's OTHER topics live in a different
  // section. See buildContractDocOutline's doc comment.
  let outline = candidate.why === "doc-contract-match"
    ? buildContractDocOutline(workspace, candidate.path, cache)
    : undefined;
  // A broad answer symbol (typically a class/module) may exceed the contiguous
  // body cap. Bundle the query-ranked, independently sliceable member handles
  // so the one honest follow-up can batch them instead of paying one discovery
  // turn per method after a separate skeleton read.
  if (answerProfile && embed && embed.remaining_ranges.length > 0 && outline === undefined) {
    const content = readCached(workspace, candidate.path, cache);
    const focus = content === undefined
      ? undefined
      : await selectAnchorFocus(content, candidate.path, query, cache);
    if (focus) {
      const relevant = [focus.best, ...focus.runnerUps]
        .filter((item) =>
          item.range !== range
          && (!candidate.symbol || item.name.toLowerCase() !== candidate.symbol.toLowerCase())
        )
        .slice(0, ANCHOR_FOCUS_MAX_RUNNER_UPS + 1);
      if (relevant.length > 0) {
        outline = anchorFocusRunnerUpOutline(relevant, candidate.path, workspace);
      }
    }
  }

  const surface = {
    role,
    handle: handleId,
    path: candidate.path,
    range,
    ...(candidate.symbol ? { symbol: candidate.symbol } : {}),
    ...(required ? { required: true } : {}),
    ...(why ? { why } : {}),
    // DESIGN-v0.8 §C1 item 2: omit when equal to the generic role fallback —
    // a role-specific string (enum-like queries) always survives since it
    // carries task information the fallback does not.
    ...(!answerProfile && editIntent !== genericEditIntent(role) ? { edit_intent: editIntent } : {}),
    ...(!answerProfile && doneCheck !== genericDoneCheck(role) ? { done_check: doneCheck } : {}),
    ...(likelyEdits.length > 0 ? { likely_edits: likelyEdits } : {}),
    ...(embed ? { code: embed.code } : {}),
    // §4.1 + serve-honesty (2026-08-01): completeness is stamped relative to
    // the FILE, not just the served range — see partialityStamp's doc comment.
    ...(embed
      ? partialityStamp(workspace, candidate.path, range, embed.remaining_ranges, cache, candidate.callerRange === true)
      : {}),
    ...(outline ? { outline } : {}),
  };
  // B1 fix (2026-09-21). A SEPARATE, narrower mark from `markCallerRangeSurface`
  // below (the P2/2026-09-19 mark `dedupeTrimAndPersist` still sets from `why`
  // — deliberately UNCHANGED, see that call site's own comment for why: it
  // feeds `settleCallerRangeDelivery`/`reconcileCallerRangeRemaining`/
  // `applyFoldSmallRemainder`, disclosure-accuracy functions that
  // `firstPackCompleteness.spec.ts`'s "B" suite proves must keep reconciling
  // `remaining_ranges` for ANY caller-named surface, ranged or not — narrowing
  // THAT mark broke it: a range-less named target's stale `remaining_ranges`
  // (double-booked with the surface's own whole `range`) went unreconciled).
  //
  // This mark answers a DIFFERENT, narrower question those functions never
  // needed to ask: was THIS call's own targets[]/paths[] entry an EXPLICIT
  // range/ranges (`candidate.callerRange === true`, the pre-existing, precise
  // bit the widening suppression above already keys on — never survives onto
  // the returned TaskPackSurface as an ordinary field, so `candidateToSurface`
  // — the one place every surface is built — is the only point it can be
  // captured). Consumed ONLY by `unservedCallerRangedTargetsNext`
  // (canonicalDecision.ts) — the actual WITHHOLD-THE-CERTIFICATE gate — so
  // that gate binds ruling case (a) alone: an explicit caller/continuation
  // range. A range-less candidate inside a query-bearing pack — however it
  // got into targets[], caller-typed or a server `next` re-offering it (B1's
  // repro) — never sets this mark, so the gate never withholds a certificate
  // or mints a paging `next` for it; `remaining` stays exactly what ruling
  // (b)/the HEAD behaviour says it always was: an offered zoom, computed by
  // the UNCHANGED broader mark's own reconciliation.
  if (candidate.callerRange === true) markExplicitRangeSurface(surface);
  return surface;
}

export function rawCapForResult(result: TaskPackResult): number {
  if (result.wiring?.strategy === "semantic-multihop") {
    if ((result.wiring.connections[0]?.completion_proof?.structural_checks.length ?? 0) > 0) {
      const hubWhole = result.wiring.connections[0]?.mode === "construct-receiver" && effHubWholeEnabled();
      return MAX_TASK_PACK_BYTES_CONSTRUCT_PROOF + (hubWhole ? HUB_WHOLE_EXTRA_CAP_BYTES : 0);
    }
    return MAX_TASK_PACK_BYTES_SEMANTIC_WIRING;
  }
  if (
    (result.artifact_requirements?.length ?? 0) > 1
    && result.artifact_sections?.length === result.artifact_requirements?.length
    && (
      result.execution_contract === undefined
      || result.execution_contract.state === "ready"
    )
  ) {
    return MAX_TASK_PACK_BYTES_ARTIFACT_BUNDLE;
  }
  if (
    result.task_profile === "artifact_build"
    && result.create_target !== undefined
    && (result.artifact_sections?.length ?? 0) > 0
  ) {
    // Extracted artifact sections are content-bearing proof even though they
    // are not code surfaces. Give a uniquely proved create frontier the same
    // bounded tier as required implementation code; otherwise 9-10KB of
    // useful XLSX/DOCX evidence collapses into the empty emergency fallback.
    return MAX_TASK_PACK_BYTES_HIGH_CONFIDENCE;
  }
  if (
    result.task_profile === "multi_concern"
    && (result.concerns?.length ?? 0) > 1
    && result.concerns?.every((concern) => concern.status === "covered") === true
    && codeTaskPackSurfaces(result.surfaces)
      .filter((surface) => surface.required !== false)
      .every(hasServedCode)
  ) {
    // Independent concerns have a real additive evidence floor. A fixed 8KB
    // cap forced a complete three-bug pack through the emergency empty-pack
    // fallback, making the cheapest run depend on agent luck. This tier is
    // available only while every concern still carries required code.
    return MAX_TASK_PACK_BYTES_MULTI_CONCERN;
  }
  // DESIGN-v0.8 §C1 item 3: needs_exact_code was always `code !== undefined`
  // at every emission site — the check now reads `code` directly instead of
  // the redundant boolean.
  // DESIGN-v0.8 coverage-honesty (Part 4): module-closure companion code
  // counts toward the high-confidence 16KB cap just like required-surface
  // code — a header+impl chain must be able to ship both bodies without
  // trimToCap stripping the companion's, which is exactly where the fix
  // lives.
  const hasHighConfCode = result.surfaces.some(
    (s) => s.code !== undefined && (s.required || isModuleClosureSurface(s)),
  );
  // Artifact consumers ride the pack's spare budget and never raise its tier.
  const hasAnyCode = result.surfaces.some((s) => s.code !== undefined && !isArtifactConsumerSurface(s));
  // WP-S2 rule 2 (TL_SEEDED_GENEROUS): several files the CALLER NAMED have the
  // same additive evidence floor the multi_concern tier above exists for — a
  // four-file answer pack cannot prove four things inside the base tier. Taken
  // as a FLOOR on the tier this result would otherwise get, never a narrowing,
  // and only for a pack `buildSeededTaskPack` itself marked (>= 2 named files
  // it decided to serve whole). Unmarked packs — every pack with the flag off
  // — keep their exact tier.
  const base = Math.max(
    seededGenerousPackTier(result),
    hasHighConfCode
      ? MAX_TASK_PACK_BYTES_HIGH_CONFIDENCE
      : hasAnyCode
        ? Math.round((MAX_TASK_PACK_BYTES + MAX_TASK_PACK_BYTES_HIGH_CONFIDENCE) / 2)
        : MAX_TASK_PACK_BYTES,
  );
  // DESIGN-v0.9 §4.8: content the server internally executed (§4.6b codeless
  // surface bodies — signalled by a non-empty `inlined[]`) may expand the
  // budget to the must-fetch tier, and ONLY behind TL_MUSTFETCH_EXPAND.
  // mustFetchPackCap returns `base` unchanged when the flag is off, so a pack
  // that never inlined, or any pack with the flag off, keeps today's caps —
  // the isolation the lean-stratum rollback criterion (§11.6) requires.
  if (result.inlined !== undefined && result.inlined.length > 0) return mustFetchPackCap(base);
  return base;
}
