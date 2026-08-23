/**
 * graphRetriever.ts — Wave C, finding F-A5: the graph axis, live.
 *
 * DESIGN-v0.11-expansion-plan-reconciliation.md §6 F-A5: "Graph-as-5th-RRF-
 * retriever wiring (direct-class floor eligibility; profiles predicted to
 * differentiate after it exists) | Wave C candidate; V11-02's finding text
 * is the spec." V11-02's own spec text (DESIGN-v0.10-expansion-plan-v1.3.md):
 * "profile別にexact、symbol、reference、BM25F、graph、recent diffのweightを
 * 持つ" — profiles.ts's `RetrieverWeights.graph` slot has existed since
 * V11-02 shipped (2026-08-21) as a DOCUMENTED PLACEHOLDER ("no retriever
 * produces a graph-evidence... ranked list yet"). This module is what fills
 * it: a deterministic ranked list built from the optional static code graph
 * (graph/index.ts's GraphIndex — the SAME reader locateTaskContext.ts's own
 * §A6 block and features/compound/ already consume).
 *
 * GATING (no new flag — reuses the pre-existing TL_RRF_FUSION per this
 * finding's own directive "this is the graph axis V11-02 already declared"):
 * index.ts's applyHybridRetrieval calls buildGraphRankedList() ONLY when
 * TL_RRF_FUSION is on (so a flag-off caller never reaches this module —
 * trivial byte identity) AND `loadGraphIndex(workspace)` returns a real
 * GraphIndex (so a workspace with no `.tokenlighten/index/` graph gets ZERO
 * new candidates and an empty ranked list — also byte-identical to pre-F-A5
 * output, since fusing an empty list changes no fused score for any key —
 * see rrf.ts's weightedReciprocalRankFusion). TL_RRF_PROFILES is NOT an
 * additional gate here: with profiles off, `retrieverWeights.graph` is
 * simply NEUTRAL_WEIGHTS.graph (=1, profiles.ts), so the graph list still
 * joins fusion at the same implicit weight every other list gets when
 * profiles are inactive — exactly how `bm25f`/`heuristic` already behave.
 *
 * LOOKUP STRATEGY — two independent, generic (never query-specific)
 * sources of candidate lookup KEYS, because GraphIndex.definition()/
 * .references() (tlGraphReader.ts / scipReader.ts) key their maps by a
 * symbol's REAL, exact-case, undecomposed name:
 *   1. `normalizeQuery(query).identifierSpans` (tokenize.ts) — raw,
 *      case-preserving, undecomposed identifier-shaped spans found in the
 *      query text verbatim. A query that names a real declaration directly
 *      ("find every caller of sendOrderConfirmation") is only matchable
 *      through this bucket — `identifierTokens` would have already split
 *      it into ["send", "order", "confirmation"], none of which is the
 *      graph's actual key.
 *   2. `normalizeQuery(query).identifierTokens` (the pre-existing decomposed
 *      bucket) tried BOTH as-is and Title-cased (first letter upper) — a
 *      cheap, uniform, non-query-specific case transform that catches a
 *      single-word symbol regardless of whether the codebase's own
 *      convention for it is lowerCamelCase, PascalCase, or plain lowercase
 *      (e.g. Go's exported `Withdraw` from a query that says "withdraw").
 *      This can never reconstruct a multi-word identifier (decomposition is
 *      lossy for that), which is an accepted, honestly-documented scope
 *      boundary, not a bug — bucket 1 above is what covers that case.
 *   3. `symbol` (HybridRetrievalInput.symbol), tried as-is when present —
 *      the caller's own already-known exact name.
 * Every one of these is a MECHANICAL, deterministic transform of the query
 * text alone; none of it is tuned to, or aware of, any specific holdout or
 * benchmark query.
 *
 * FLOOR POSTURE (binding — see index.ts's own wiring comment for the
 * enforcement mechanism): a hit from this module NEVER enters `floorKeys`.
 * The graph axis is a fusion participant only, exactly like `bm25f` and the
 * pre-existing "current heuristic" pool — it can win rank through fusion,
 * never through floor promotion. The three hard-floor rankers
 * (exact-path/text, parser-proven symbol, direct reference) already cover
 * every case V10-08/V11-02 designated "direct-class" evidence; this module
 * adds a FOURTH, independent signal source without touching that boundary.
 *
 * SCORING — "score units/files by role (definition > reference) and match
 * count" (this module's own task spec): each hit is keyed by
 * `${path}:${line}` (definition hits use the graph's own precise decl
 * location; reference hits use whatever location GraphIndex reports —
 * skeleton-engine's own graphBuilder.ts emits file-granular references at
 * line 1, so this module treats a reference honestly as "this FILE
 * references the symbol", never fabricating a more precise line or an
 * enclosing-symbol name it cannot prove). A DEFINITION hit's Candidate
 * carries `symbol: <the exact looked-up name>` (provably correct — the
 * graph only returns a definition when that name real-matches); a
 * REFERENCE hit's Candidate never sets `.symbol` (matches the existing
 * "graph-reference"/"graph-importer" convention in locateTaskContext.ts's
 * own §A6 block — see that file's comment on why an unproven enclosing
 * symbol is never fabricated). Multiple tokens or multiple reference
 * locations landing on the SAME key accumulate a bounded match-count bonus.
 *
 * BOUNDS — cap candidate FILES per token (MAX_REFERENCE_FILES_PER_TOKEN) and
 * the TOTAL hit count returned (MAX_TOTAL_GRAPH_HITS), matching this
 * module's own task spec ("bounded (cap candidate files per token and
 * total)") and the scale of this package's other MAX_ constants
 * (units.ts's MAX_SYMBOL_FILES=40, index.ts's MAX_BM25F_HITS=30).
 */

import type { GraphIndex, GraphLocation } from "../../graph/index.js";
import { normalizeQuery } from "./tokenize.js";

export type GraphHitRole = "graph:definition" | "graph:reference";

export interface GraphRetrieverHit {
  /** `${path}:${line}` — the same key shape every other ranker in this package uses (index.ts's candidateKey). */
  key: string;
  path: string;
  line: number;
  /** Set ONLY for a definition hit — see file doc on why a reference hit never fabricates one. */
  symbol?: string;
  why: GraphHitRole;
  score: number;
}

/** Bounds a single token's reference expansion to this many DISTINCT files (a hot symbol can have far more references than are useful to surface from one query token). */
export const MAX_REFERENCE_FILES_PER_TOKEN = 5;
/** Raw reference locations inspected per token, before the distinct-file cap above — a defensive bound on GraphIndex.references()'s own returned list length. */
const MAX_REFERENCES_INSPECTED_PER_TOKEN = 20;
/** Bounds the total number of distinct lookup keys (spans + tokens + case variants + symbol) tried per call. */
export const MAX_LOOKUP_KEYS = 24;
/** Bounds the total ranked list length this module ever returns. */
export const MAX_TOTAL_GRAPH_HITS = 20;

const DEFINITION_ROLE_SCORE = 1;
const REFERENCE_ROLE_SCORE = 0.5;
/** Added per EXTRA corroborating match (token or reference occurrence) landing on the same key, capped so one very hot key cannot dominate purely on volume. */
const MATCH_COUNT_BONUS_STEP = 0.05;
const MATCH_COUNT_BONUS_CAP = 0.3;

function titleCase(token: string): string {
  return token.length === 0 ? token : token[0]!.toUpperCase() + token.slice(1);
}

/**
 * Deterministic, bounded set of candidate GRAPH LOOKUP KEYS for one query —
 * see file doc's "LOOKUP STRATEGY" for the rationale behind each source.
 * Order is: explicit `symbol` first (highest-confidence — the caller
 * already named it), then raw identifier spans (case-preserved, most likely
 * to real-match a multi-word declaration), then decomposed tokens with
 * their Title-cased variant (single-word coverage). Order only affects
 * which token gets attributed match-count credit first when several tokens
 * resolve to the identical graph key — the final hit set is unaffected by
 * order (record() below is order-independent for hit MEMBERSHIP).
 */
function lookupKeys(query: string, symbol: string | undefined): string[] {
  const norm = normalizeQuery(query);
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (s: string): void => {
    if (s.length === 0 || seen.has(s)) return;
    seen.add(s);
    out.push(s);
  };
  if (symbol) add(symbol);
  for (const span of norm.identifierSpans) add(span);
  for (const token of norm.identifierTokens) {
    add(token);
    add(titleCase(token));
  }
  return out.slice(0, MAX_LOOKUP_KEYS);
}

/**
 * Build a deterministic ranked list of graph-derived hits for one query.
 * Pure function of (graphIndex, query, symbol) — no I/O (the graph is
 * already loaded), no clock, no randomness. Returns `[]` when nothing in
 * the graph matches any lookup key — a genuinely common, honest outcome for
 * free-text queries with no literal identifier mention (see
 * TUNING-PROFILES-2026-08-21.md's own analysis of why the exact/symbol/
 * reference axes are structurally inert for most of the holdout corpus;
 * the graph axis inherits the same honest limitation for the same
 * underlying reason — a query has to actually NAME something for a
 * name-keyed lookup to find it).
 */
export function buildGraphRankedList(
  graphIndex: GraphIndex,
  query: string,
  symbol: string | undefined,
): GraphRetrieverHit[] {
  const keys = lookupKeys(query, symbol);
  if (keys.length === 0) return [];

  const matchCountByKey = new Map<string, number>();
  const hitByKey = new Map<string, GraphRetrieverHit>();

  const record = (loc: GraphLocation, why: GraphHitRole, token: string): void => {
    const key = `${loc.path}:${loc.line}`;
    matchCountByKey.set(key, (matchCountByKey.get(key) ?? 0) + 1);
    const existing = hitByKey.get(key);
    // A definition hit for this key always wins the role/symbol attribution
    // over a reference hit for the SAME key, regardless of which was seen
    // first — "role: definition > reference" per this module's own spec.
    if (existing === undefined || (why === "graph:definition" && existing.why === "graph:reference")) {
      hitByKey.set(key, {
        key,
        path: loc.path,
        line: loc.line,
        ...(why === "graph:definition" ? { symbol: token } : {}),
        why,
        score: 0, // filled in below, once every hit's final match count is known.
      });
    }
  };

  for (const token of keys) {
    const def = graphIndex.definition(token);
    if (def) record(def, "graph:definition", token);

    const refs = graphIndex.references(token).slice(0, MAX_REFERENCES_INSPECTED_PER_TOKEN);
    const filesForToken = new Set<string>();
    for (const ref of refs) {
      if (!filesForToken.has(ref.path)) {
        if (filesForToken.size >= MAX_REFERENCE_FILES_PER_TOKEN) continue;
        filesForToken.add(ref.path);
      }
      record(ref, "graph:reference", token);
    }
  }

  const hits: GraphRetrieverHit[] = [...hitByKey.values()].map((hit) => {
    const matchCount = matchCountByKey.get(hit.key) ?? 1;
    const roleScore = hit.why === "graph:definition" ? DEFINITION_ROLE_SCORE : REFERENCE_ROLE_SCORE;
    const bonus = Math.min(MATCH_COUNT_BONUS_CAP, MATCH_COUNT_BONUS_STEP * (matchCount - 1));
    return { ...hit, score: roleScore + bonus };
  });

  hits.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });
  return hits.slice(0, MAX_TOTAL_GRAPH_HITS);
}
