/**
 * retrieval/index.ts — V10-08 Hybrid Retrieval v1: orchestrator.
 *
 * The ONE seam locateTaskContext.ts calls into — see its own integration
 * comment at the (former) `filteredCandidates.sort` call site. Wires the
 * five named rankers (DESIGN-v0.10-expansion-plan-v1.3.md V10-08: "exact
 * path/text / parser-proven symbol / direct references / current heuristic
 * / BM25F") through RRF, enforces the hard floor, and — when only
 * TL_BM25F_CANDIDATE is on — extends the pool on the EXISTING linear-score
 * scale with no RRF math at all ("RRF alone (without BM25F) fuses only the
 * existing rankers" — task spec). Both flags off never reaches this module:
 * locateTaskContext.ts keeps the original plain sort as its own branch, so
 * "both OFF -> byte-identical" holds structurally, not by a runtime check
 * inside this file.
 *
 * Wave C (F-A5) adds a SIXTH ranker, the graph axis, under the same
 * TL_RRF_FUSION gate (no new flag) plus a real GraphIndex loading for the
 * workspace — see graphRetriever.ts and this file's own "Wave C (F-A5)"
 * comment further down for the lookup/scoring/floor-posture rules.
 */

import { bm25fCandidateEnabled, rrfFusionEnabled, rrfProfilesEnabled } from "../../util/flags.js";
import { trace } from "../../util/trace.js";
import type { FoundFile, WalkOptions } from "../../tools/walkRepo.js";
import type { Candidate } from "../locator/locateTaskContext.js";
import type { CollectedSymbol } from "../../symbols/collectSymbols.js";
import { loadGraphIndex } from "../../graph/index.js";
import { tokenizeQuery, decomposeIdentifier } from "./tokenize.js";
import { buildGraphRankedList, type GraphRetrieverHit } from "./graphRetriever.js";
import {
  buildFileMetadataUnits,
  buildMarkdownUnits,
  buildConfigUnits,
  buildTestCaseUnits,
  buildSymbolUnits,
  MAX_SYMBOL_FILES,
  type IndexUnit,
  type FieldName,
} from "./units.js";
import { Bm25fIndex, type Bm25fHit } from "./bm25f.js";
import { weightedReciprocalRankFusion, type RankedList, type WeightedRankedList } from "./rrf.js";
import { applyHardFloor } from "./hardFloor.js";
import {
  NEUTRAL_WEIGHTS,
  resolveProfileWeights,
  WEIGHTS_VERSION,
  type RetrieverWeights,
  type TaskProfileId,
} from "./profiles.js";
import { inferTaskFamily, type TaskFamilyInput } from "./taskFamily.js";
import { evaluateRetrieverQuality } from "./qualityGate.js";

export interface HybridRetrievalInput {
  workspace: string;
  query: string;
  symbol?: string;
  /** Already-scoped file list — the SAME list locateTaskContext.ts's own Layer 5 getCodeFiles() computed; no new whole-tree walk. */
  codeFiles: readonly FoundFile[];
  /** The shared per-call WalkCache, structurally typed so this module never needs locateTaskContext.ts to export its private class. */
  walkCache: { get(opts: WalkOptions): FoundFile[] };
  /**
   * Tuner-only BM25F field-weight override (bm25f.ts's Bm25fOptions.weights)
   * — NOT an env var / CLI flag. Omitted by every production call site
   * (locateTaskContext.ts's own applyHybridRetrieval() call never sets this
   * field), so `undefined` there and Bm25fIndex falls back to its own
   * FIELD_WEIGHTS default; only bench/workflows/retrieval/tune-bm25f.mjs
   * ever passes a candidate vector, one per evaluated weight vector.
   */
  weights?: Partial<Record<FieldName, number>>;
  /**
   * V11-02 (flag: TL_RRF_PROFILES, composes with TL_RRF_FUSION). Optional
   * task-aware profile context, threaded by the one production call site
   * (locateTaskContext.ts) ONLY under the flag. Default undefined -> profile
   * resolution never runs; fusion behavior is byte-identical to pre-V11-02
   * output (every ranked list keeps its implicit weight of 1, exactly like
   * the original reciprocalRankFusion call this seam used to make).
   */
  profileContext?: { explicitPath?: string };
  /**
   * V11-02 tuner/test-only direct weight override — bypasses inferTaskFamily
   * entirely and uses this vector as-is (merged over neutral). Mirrors the
   * `weights` (BM25F field weights) override immediately above: the
   * production call site never sets this; only
   * bench/workflows/retrieval/tune-profiles.mjs and this package's own specs
   * do, so they can hold a profile's weight vector fixed while sweeping it —
   * exactly like tune-bm25f.mjs's `weights` override holds FIELD_WEIGHTS
   * fixed during ITS sweep.
   */
  retrieverWeights?: Partial<RetrieverWeights>;
}

const candidateKey = (c: Candidate): string => `${c.path}:${c.line}`;

const MAX_BM25F_HITS = 30;
/** New Candidates get a conservative score on the EXISTING scale — always below an exact-text (1.2) / exact-symbol (2.0) hit, comparable to the existing "reference"/"variant-text" weak layers (0.5-0.7). */
const BM25F_ONLY_SCORE_TOP = 0.7;
const BM25F_ONLY_SCORE_FLOOR = 0.35;
const BM25F_ONLY_SCORE_STEP = 0.02;

function bm25fOnlyScore(rankIndex: number): number {
  return Math.max(BM25F_ONLY_SCORE_FLOOR, BM25F_ONLY_SCORE_TOP - rankIndex * BM25F_ONLY_SCORE_STEP);
}

function uniqueOrderedPaths(candidates: readonly Candidate[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of candidates) {
    if (seen.has(c.path)) continue;
    seen.add(c.path);
    out.push(c.path);
  }
  return out.slice(0, MAX_SYMBOL_FILES);
}

function rankedListOf(candidates: readonly Candidate[]): RankedList {
  return candidates.map(candidateKey);
}

/**
 * A `kind==="symbol"` candidate is PI-06-pure ("parser-proven") only when
 * collectSymbols independently confirms a same-named declaration in that
 * file at/near that line — see units.ts's file doc for why this is never
 * derived from searchSymbols' own (regex-based) hit directly.
 */
function isParserProven(candidate: Candidate, byPath: ReadonlyMap<string, readonly CollectedSymbol[]>): boolean {
  if (candidate.kind !== "symbol" || !candidate.symbol) return false;
  const declared = byPath.get(candidate.path);
  if (!declared) return false;
  const wanted = candidate.symbol.toLowerCase();
  return declared.some((sym) =>
    sym.name.toLowerCase() === wanted
    && candidate.line >= sym.signatureStartLine - 3
    && candidate.line <= sym.endLine,
  );
}

function newCandidateFromUnit(unit: IndexUnit, score: number): Candidate {
  return {
    path: unit.path,
    line: unit.line,
    ...(unit.endLine !== undefined ? { endLine: unit.endLine } : {}),
    ...(unit.symbol !== undefined ? { symbol: unit.symbol } : {}),
    kind: "bm25f",
    score,
    why: `bm25f:${unit.kind}`,
  };
}

/**
 * Wave C (F-A5): a graph-derived hit becomes a Candidate tagged
 * `kind: "path-token"` — deliberately NOT a new `Candidate["kind"]` union
 * member (locateTaskContext.ts, where that union lives, is out of this
 * finding's scope) and deliberately NOT "reference"/"symbol"/"text" (each
 * of those three is a HARD-FLOOR kind — see index.ts's own floor-posture
 * comment below for why a graph hit must never accidentally qualify).
 * "path-token" is the one existing kind value with NO special-cased
 * behavior anywhere in locateTaskContext.ts (confirmed by exhaustive
 * grep — not in TEXTUAL_KINDS, not in isStrongScopeCandidate, not in the
 * exact-symbol/exact-text success-gate checks, not in rangeForCandidate's
 * symbol-aware-range branch): a graph hit rides it as an ordinary,
 * fusion-only candidate, exactly like a `kind: "bm25f"` one already does
 * for a different retriever. `graphRetriever.ts`'s own GraphRetrieverHit
 * already carries `symbol` ONLY for a definition hit (never fabricated for
 * a reference) — passed through unchanged here.
 */
function newCandidateFromGraphHit(hit: GraphRetrieverHit): Candidate {
  return {
    path: hit.path,
    line: hit.line,
    ...(hit.symbol !== undefined ? { symbol: hit.symbol } : {}),
    kind: "path-token",
    score: hit.score,
    why: hit.why,
  };
}

/** Build the full BM25F corpus and score it. Only called when TL_BM25F_CANDIDATE is on. */
function runBm25f(input: HybridRetrievalInput, symbolUnits: readonly IndexUnit[], queryTokens: readonly string[]): Bm25fHit[] {
  const mdFiles = input.walkCache.get({ extraExts: [".md", ".markdown"] });
  const configFiles = input.walkCache.get({ extraExts: [".json", ".yaml", ".yml", ".toml"] });
  const allUnits: IndexUnit[] = [
    ...buildFileMetadataUnits(input.codeFiles),
    ...symbolUnits,
    ...buildMarkdownUnits(input.workspace, mdFiles),
    ...buildConfigUnits(input.workspace, configFiles),
    ...buildTestCaseUnits(input.workspace, input.codeFiles),
  ];
  return new Bm25fIndex(allUnits, { weights: input.weights }).score(queryTokens).slice(0, MAX_BM25F_HITS);
}

/**
 * Apply hybrid retrieval to `candidates` IN PLACE: extend it with BM25F-only
 * finds and/or reorder it per RRF fusion, per whichever of
 * TL_BM25F_CANDIDATE / TL_RRF_FUSION is on. The caller (locateTaskContext.ts)
 * only invokes this when at least one is on.
 */
export async function applyHybridRetrieval(input: HybridRetrievalInput, candidates: Candidate[]): Promise<void> {
  const bm25fOn = bm25fCandidateEnabled();
  const rrfOn = rrfFusionEnabled();
  // V11-02 composes with TL_RRF_FUSION: profile resolution and the weak-
  // retriever quality gate only ever run when RRF fusion itself is on. With
  // rrfOn false this is always false, so every profilesOn-gated branch below
  // collapses to exactly the pre-V11-02 code path.
  const profilesOn = rrfProfilesEnabled() && rrfOn;
  const candidatesBefore = candidates.length;

  const queryTokens = [
    ...new Set([...tokenizeQuery(input.query), ...(input.symbol ? decomposeIdentifier(input.symbol) : [])]),
  ];

  // Parser-proven symbol ground truth: needed for the RRF floor ranker AND
  // (when BM25F is on) as BM25F's own symbol-declaration/symbol-body units.
  // Bounded to files already surfaced by some other layer — see units.ts's
  // MAX_SYMBOL_FILES doc for why this never tree-sitter-parses the whole repo.
  const parseFiles = uniqueOrderedPaths(candidates);
  const symbolResult = (rrfOn || bm25fOn) && parseFiles.length > 0
    ? await buildSymbolUnits(input.workspace, parseFiles)
    : { units: [] as IndexUnit[], byPath: new Map<string, CollectedSymbol[]>() };

  const bm25fHits = bm25fOn ? runBm25f(input, symbolResult.units, queryTokens) : [];

  if (!rrfOn) {
    // BM25F-only: extend the pool on the existing linear-score scale, no RRF/floor math.
    const existingKeys = new Set(candidates.map(candidateKey));
    bm25fHits.forEach((hit, rankIndex) => {
      if (existingKeys.has(hit.unit.key)) return;
      existingKeys.add(hit.unit.key);
      candidates.push(newCandidateFromUnit(hit.unit, bm25fOnlyScore(rankIndex)));
    });
    candidates.sort((a, b) => b.score - a.score);
    trace("hybrid_retrieval_applied", {
      mode: "bm25f_only",
      candidates_before: candidatesBefore,
      candidates_after: candidates.length,
      bm25f_hits: bm25fHits.length,
    }, input.workspace);
    return;
  }

  // RRF path (rrfOn === true; bm25fOn may or may not also be true).
  const rExact = candidates.filter((c) => c.kind === "text" && (c.why === "exact-text" || c.why === "exact-text:distinctive"));
  const rRef = candidates.filter((c) => c.kind === "reference");
  const rSymbol = candidates.filter((c) => isParserProven(c, symbolResult.byPath));
  // "Current heuristic" as its own ranker: the pool exactly as the existing
  // pipeline scored it, captured BEFORE any BM25F-only extension below.
  const rHeuristic = [...candidates].sort((a, b) => b.score - a.score);

  // ---------------------------------------------------------------------
  // V11-02: resolve which per-retriever weight vector applies to THIS call.
  // Neutral (all-1) unless profiles are active; see profilesOn's own doc
  // comment above for why that alone guarantees flag-off byte identity.
  // ---------------------------------------------------------------------
  let retrieverWeights: RetrieverWeights = NEUTRAL_WEIGHTS;
  let profileResult: { profile: TaskProfileId; confidence: number; signals: readonly string[] } | undefined;
  let weightsSource: "inferred" | "override" | undefined;
  if (profilesOn) {
    if (input.retrieverWeights) {
      retrieverWeights = { ...NEUTRAL_WEIGHTS, ...input.retrieverWeights };
      weightsSource = "override";
    } else {
      const familyInput: TaskFamilyInput = {
        query: input.query,
        ...(input.symbol ? { symbol: input.symbol } : {}),
        ...(input.profileContext?.explicitPath ? { explicitPath: input.profileContext.explicitPath } : {}),
        candidatePaths: parseFiles,
      };
      profileResult = inferTaskFamily(familyInput);
      retrieverWeights = resolveProfileWeights(profileResult.profile);
      weightsSource = "inferred";
    }
  }

  // ---------------------------------------------------------------------
  // V11-02: the weak-retriever quality gate — BM25F and the pre-existing
  // "current heuristic" pool only, never the three hard-floor rankers (see
  // qualityGate.ts's doc comment). A gate failure removes a list from
  // FUSION, never from the candidate pool: every BM25F-sourced candidate is
  // still added to `candidates` below regardless of gate outcome, unchanged
  // from pre-V11-02 behavior.
  // ---------------------------------------------------------------------
  const gateLog: Array<{ retriever: "heuristic" | "bm25f" | "graph"; passed: boolean; reason?: string }> = [];
  const gateAllows = (retriever: "heuristic" | "bm25f" | "graph", scores: readonly number[]): boolean => {
    if (!profilesOn) return true;
    const result = evaluateRetrieverQuality(scores);
    gateLog.push({ retriever, passed: result.passed, ...(result.reason ? { reason: result.reason } : {}) });
    return result.passed;
  };

  const heuristicPassed = gateAllows("heuristic", rHeuristic.map((c) => c.score));

  const rExactList = rankedListOf(rExact);
  const rSymbolList = rankedListOf(rSymbol);
  const rRefList = rankedListOf(rRef);
  const rHeuristicList = rankedListOf(rHeuristic);

  const fusionLists: WeightedRankedList[] = [
    { list: rExactList, weight: retrieverWeights.exact },
    { list: rSymbolList, weight: retrieverWeights.symbol },
    { list: rRefList, weight: retrieverWeights.reference },
  ];
  if (heuristicPassed) fusionLists.push({ list: rHeuristicList, weight: 1 });

  const existingKeys = new Set(candidates.map(candidateKey));
  let bm25fList: RankedList = [];
  if (bm25fOn) {
    const fresh: Candidate[] = [];
    bm25fHits.forEach((hit, rankIndex) => {
      if (existingKeys.has(hit.unit.key)) return;
      existingKeys.add(hit.unit.key);
      fresh.push(newCandidateFromUnit(hit.unit, bm25fOnlyScore(rankIndex)));
    });
    candidates.push(...fresh);
    const bm25fPassed = gateAllows("bm25f", bm25fHits.map((h) => h.score));
    bm25fList = bm25fHits.map((hit) => hit.unit.key);
    if (bm25fPassed) fusionLists.push({ list: bm25fList, weight: retrieverWeights.bm25f });
  }

  // ---------------------------------------------------------------------
  // Wave C (F-A5): the graph axis — profiles.ts's `RetrieverWeights.graph`
  // slot, live for the first time. Gated behind TL_RRF_FUSION alone (no new
  // flag: we are already inside the `rrfOn === true` branch here) AND a
  // real GraphIndex loading for this workspace — no graph ⇒ `graphList`
  // stays `[]` ⇒ zero new candidates ⇒ fusing an empty list changes no
  // fused score for any existing key (rrf.ts) ⇒ byte-identical to pre-F-A5
  // output, exactly like the "flag off" case. See graphRetriever.ts's own
  // file doc for the lookup strategy and scoring rules.
  //
  // FLOOR POSTURE (binding): `graphList`'s keys are NEVER added to
  // `floorKeys` below. The three pre-existing hard-floor rankers already
  // cover every direct-class case (exact path/text, parser-proven symbol,
  // direct reference); the graph axis is a fusion participant ONLY,
  // exactly like `bm25f` and the "current heuristic" pool — it can win
  // rank through fusion, never through floor promotion. See
  // __tests__/graphRetriever.spec.ts's adversarial-weight floor-survival
  // proof.
  // ---------------------------------------------------------------------
  let graphList: RankedList = [];
  const graphIndex = loadGraphIndex(input.workspace);
  if (graphIndex) {
    const graphHits = buildGraphRankedList(graphIndex, input.query, input.symbol);
    if (graphHits.length > 0) {
      const fresh: Candidate[] = [];
      for (const hit of graphHits) {
        if (existingKeys.has(hit.key)) continue;
        existingKeys.add(hit.key);
        fresh.push(newCandidateFromGraphHit(hit));
      }
      candidates.push(...fresh);
      const graphPassed = gateAllows("graph", graphHits.map((h) => h.score));
      graphList = graphHits.map((hit) => hit.key);
      if (graphPassed) fusionLists.push({ list: graphList, weight: retrieverWeights.graph });
    }
  }

  const fused = weightedReciprocalRankFusion(fusionLists);
  // The hard floor: exact path/text, parser-proven declarations, and direct
  // references may never be displaced or dropped by fusion (V10-08), under
  // EVERY profile including an adversarial all-zero weight vector (V11-02) —
  // floor MEMBERSHIP below is entirely independent of retrieverWeights; only
  // each floor item's OWN fused-score-based ordering WITHIN the floor group
  // can move. "current heuristic", "BM25F", and "graph" (F-A5) are NOT floor
  // rankers — their unique-beyond-floor contributions are exactly what
  // fusion is allowed to reorder/extend/mute.
  const floorKeys = new Set<string>([...rExactList, ...rSymbolList, ...rRefList]);
  const ordered = applyHardFloor(candidates, candidateKey, fused, floorKeys);
  candidates.length = 0;
  candidates.push(...ordered);

  trace("hybrid_retrieval_applied", {
    mode: bm25fOn ? "bm25f_rrf" : "rrf_only",
    candidates_before: candidatesBefore,
    candidates_after: candidates.length,
    floor_size: floorKeys.size,
    bm25f_hits: bm25fHits.length,
    graph_hits: graphList.length,
    exact: rExact.length,
    symbol: rSymbol.length,
    reference: rRef.length,
    ...(profilesOn ? {
      weights_version: WEIGHTS_VERSION,
      retriever_weights: retrieverWeights,
      retriever_weights_source: weightsSource,
      ...(profileResult ? {
        profile: profileResult.profile,
        profile_confidence: profileResult.confidence,
        profile_signals: profileResult.signals,
      } : {}),
      gated_retrievers: gateLog.filter((g) => !g.passed),
      top_candidate_provenance: (() => {
        const exactSet = new Set(rExactList);
        const symbolSet = new Set(rSymbolList);
        const refSet = new Set(rRefList);
        const heuristicSet = heuristicPassed ? new Set(rHeuristicList) : new Set<string>();
        const bm25fSet = new Set(bm25fList);
        const graphSet = new Set(graphList);
        return ordered.slice(0, 10).map((c) => {
          const key = candidateKey(c);
          const retrievers: string[] = [];
          if (exactSet.has(key)) retrievers.push("exact");
          if (symbolSet.has(key)) retrievers.push("symbol");
          if (refSet.has(key)) retrievers.push("reference");
          if (heuristicSet.has(key)) retrievers.push("heuristic");
          if (bm25fSet.has(key)) retrievers.push("bm25f");
          if (graphSet.has(key)) retrievers.push("graph");
          return { key, retrievers };
        });
      })(),
    } : {}),
  }, input.workspace);
}
