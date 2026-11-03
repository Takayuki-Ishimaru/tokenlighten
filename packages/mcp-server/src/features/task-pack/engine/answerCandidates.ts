// answerCandidates — extracted implementation; imports point to the owning modules.
import * as path from "path";
import type { AnchorFocusCandidate } from "./anchorFocus.js";
import type { AnchorFocusResult } from "./anchorFocus.js";
import type { ExplicitIdentifierAbsence } from "./identifierAbsence2.js";
import type { ImpactCandidate } from "@tokenlighten/types";
import type { RankedAnswerEvidenceCandidate } from "./roleAndConcernScope3.js";
import type { TaskPackArgs } from "../model.js";
import { BEHAVIOR_QUERY_RE } from "./changeAndReadinessEvidence2.js";
import { FileReadCache } from "./packBasics2.js";
import { IDENTIFIER_DEFINITION_KEYWORD_RE } from "./answerCandidates2.js";
import { REQUEST_ANCHOR_DEFINITION_WHY } from "./roleAndConcernScope3.js";
import { REQUEST_LITERAL_WHY } from "./roleAndConcernScope3.js";
import { classifySurface } from "../../../util/impact.js";
import { countLines } from "../../../util/countLines.js";
import { dominantRoot } from "../../../util/dominantRoot.js";
import { explicitCodeIdentifierEntries } from "./anchorFocus2.js";
import { framedCodeNamesIn } from "../requestFacets.js";
import { framedTypeInNamedFiles } from "./sameNameSubjects.js";
import { hasIdentifierSegment } from "./literalAndConcernSeeds.js";
import { isAnswerIntentQuery } from "./coverageAndContinuation4.js";
import { isLowValueDocPath } from "../../../util/docPaths.js";
import { isTestConcernPath } from "./literalAndConcernSeeds.js";
import { languageForPath } from "../../../util/languages.js";
import { projectRootOf } from "../../locator/locateTaskContext.js";
import { queryNamedWorkspaceFiles } from "./queryIntent3.js";
import { queryNamesDocPath } from "../../../util/docPaths.js";
import { readCached } from "./packBasics2.js";
import { requiredQueryFacets } from "./changeAndReadinessEvidence2.js";
import { scanLiteral } from "../../search/find/findText.js";
import { selectAnchorFocus } from "./anchorFocus3.js";
import { selectQueryEvidence } from "../../../tools/queryEvidence.js";
import { tokenizeForEpoch } from "../../../state/session.js";
import { walkCodeFiles } from "../../../tools/walkRepo.js";
import { wholeIdentifierOnHitLine } from "./identifierAbsence2.js";

export function isNonImplementationAnswerCandidate(candidate: ImpactCandidate): boolean {
  // `classifySurface` intentionally labels anything under a fixture root as
  // test data. That is correct for TokenLighten's own repository, but wrong
  // when the caller explicitly scopes the target application under a bench
  // fixture. Use the candidate's repository-relative path semantics here;
  // only actual test directories/files are non-implementation evidence.
  if (
    /(?:^|\/)(?:__tests__|test|tests|decoy|decoys)(?:\/|$)|(?:^|\/)(?:changelog|changes)\.[^/]+$|\.spec\.[^.]+$/i.test(
      candidate.path,
    )
  ) {
    return true;
  }
  // `example(s)`/`fixture(s)` are leaf-scoped, mirroring the identical
  // precedent already established for `classifySurface`'s "data" role
  // (util/impact.ts's `dataKeyword`): the keyword only counts when it names
  // the file itself (basename) or its immediate parent directory — NEVER a
  // distant ancestor segment. An any-segment check let ANY caller-scoped
  // root that happens to carry a "fixtures"/"examples" ancestor above the
  // real implementation tree (a bench-harness scope like
  // `bench/fixtures/<repo>/...`, or a workspace whose own filesystem
  // location simply sits under such a directory) misclassify every real
  // implementation file beneath it as decoy/non-implementation evidence —
  // that ancestor segment describes where the tree is rooted, not what the
  // file is. A genuine `fixtures/`/`examples/` directory *inside* the
  // target tree (e.g. `src/test/fixtures/SampleData.java`) still matches,
  // because there the segment names the file's own immediate parent.
  //
  // FX-O3 (2026-09-03, round-17 review finding 4): FX-N0 folded
  // `bench`/`benchmarks`/`workflow(s)` into this same leaf/parent rule,
  // reasoning it mirrored `example(s)`/`fixture(s)`. It does not:
  // "fixtures"/"examples" name test-data conventions with no legitimate
  // production-code meaning, but "workflow"/"bench" are ordinary words for
  // real implementation — a workflow engine, a workflow orchestrator, a
  // benchmark/rating engine — and the leaf/parent scoping does not save
  // this, because it demotes exactly the files that legitimately carry
  // those words as their own basename or directory name:
  // `src/workflow/engine.ts`, `internal/workflow/executor.go`,
  // `app/workflows/order_fulfillment.py`, `src/benchmark.rs`,
  // `lib/workflow_engine/step.rb` were all wrongly demoted on the default,
  // flags-off path in ANY repository, not just TokenLighten's own. These
  // terms were a TokenLighten-specific hack (this repo's own
  // `bench/workflows/` harness) dressed up as a generic rule; removed
  // entirely rather than re-scoped. Only `example(s)`/`fixture(s)` remain
  // leaf-scoped here.
  const segments = candidate.path.toLowerCase().split("/").filter((s) => s.length > 0);
  const basename = segments[segments.length - 1] ?? "";
  const parentSegment = segments.length >= 2 ? segments[segments.length - 2] : "";
  const leafDecoyKeyword = /(^|[^a-z])(examples?|fixtures?)([^a-z]|$)/;
  return leafDecoyKeyword.test(basename) || leafDecoyKeyword.test(parentSegment);
}

/**
 * A named implementation may answer a direct lookup alone.  A request that
 * explicitly asks for a relationship or supporting context cannot: collapsing
 * the locator's bounded candidate set to the named symbol would erase the
 * very context the caller asked to retain.  This is deliberately narrower
 * than open-universe intent; it preserves a small, ranked companion set and
 * never asks for an exhaustive repository scan.
 */
export function requiresRelatedAnswerContext(query: string): boolean {
  return /\b(?:continuations?|relations?|graphs?|edges?|wiring|imports?|references?)\b|\bsupporting\s+context\b/iu.test(query)
    || /(?:関係|接続|参照|継続)/u.test(query);
}

export function answerEvidencePathPenalty(candidate: ImpactCandidate, query: string): number {
  if (/\b(?:test|tests|spec|fixture|bench|benchmark)\b/i.test(query)) return 0;
  if (isNonImplementationAnswerCandidate(candidate)) return 3;
  // 2026-10-29 (first-hop field report): a change/release log or docs/ page
  // mentions almost every identifier of a project on some line, so a lexical
  // ranker puts History.md ahead of the code that implements what a behaviour
  // question asks about (express "How does res.redirect work?"). Rank it behind
  // the implementation unless the question names it ("what changed in
  // History.md for 5.0").
  if (
    isLowValueDocPath(candidate.path)
    && (BEHAVIOR_QUERY_RE.test(query) || isAnswerIntentQuery(query))
    && !queryNamesDocPath(query, candidate.path)
  ) return 3;
  return 0;
}

export function answerBuilderOwnershipBonus(candidate: ImpactCandidate, query: string): number {
  const asksForConstructionMechanism = /\b(?:trace|how|builds?|constructs?|creates?|assembles?|derives?)\b/i.test(query)
    || /どのように|どう作|構築|生成過程/.test(query);
  if (!asksForConstructionMechanism) return 0;
  return /^(?:build|construct|create|assemble|derive|resolve)/i.test(candidate.symbol ?? "")
    ? 2
    : 0;
}

/**
 * See the "2026-08-21 answer-path-inherits-locator fix" comment in
 * buildAnswerTaskPack. Picks a single abstain candidate to re-anchor the
 * locator on: one the query names by its own file (a whole-word basename
 * match), that already carries a resolved symbol from a real structural
 * locator match rather than a symbol-less prose/variant-text hit. Several
 * qualifying candidates (rare — the query would have to name more than one
 * file) fall back to the highest-confidence one; returns undefined when
 * nothing qualifies, leaving the existing candidate-list behavior in place.
 */
export function pickNamedFileAbstainAnchor(
  candidates: readonly ImpactCandidate[],
  query: string,
): ImpactCandidate | undefined {
  let best: ImpactCandidate | undefined;
  for (const candidate of candidates) {
    if (candidate.symbol === undefined) continue;
    if (isNonImplementationAnswerCandidate(candidate)) continue;
    const stem = path.basename(candidate.path, path.extname(candidate.path));
    if (stem.length < 3 || !hasIdentifierSegment(query, stem)) continue;
    if (best === undefined || candidate.confidence > best.confidence) best = candidate;
  }
  return best;
}

/**
 * See the "2026-08-21 answer-path-inherits-locator fix" comment in
 * buildAnswerTaskPack. Orders ranked answer candidates so the locator's own
 * verdict — its primary, first, then any related surface it flagged
 * `required` — always occupies the front of the list a capped selection
 * draws from; everything else (answer-path-discovered facet/responsibility
 * extras) follows in the same relative (score) order rankAnswerEvidence-
 * Candidates already produced. A no-op (plain score order) whenever the
 * locator never resolved a primary at all.
 */
export function orderByLocatorVerdict(
  ranked: readonly RankedAnswerEvidenceCandidate[],
  requiredPaths: ReadonlySet<string>,
  primaryPath: string | undefined,
): ImpactCandidate[] {
  if (requiredPaths.size === 0) return ranked.map((entry) => entry.candidate);
  const locked: ImpactCandidate[] = [];
  const extra: ImpactCandidate[] = [];
  for (const entry of ranked) {
    (requiredPaths.has(entry.candidate.path) ? locked : extra).push(entry.candidate);
  }
  locked.sort((a, b) => Number(b.path === primaryPath) - Number(a.path === primaryPath));
  return [...locked, ...extra];
}

/**
 * Recover the implementation that actually owns a multi-facet behaviour even
 * when the name in the request is colloquial or stale. Locator candidates are
 * name-first; for an explanation request such as "payment / inventory /
 * shipping", that can rank an analytics `orchestrator` above the service that
 * performs all three operations. This bounded pass ranks responsibility from
 * co-located query facets and structural layer evidence, within the caller's
 * scope, before the normal symbol focuser runs.
 */
export async function discoverAnswerResponsibilityCandidates(
  args: TaskPackArgs,
  query: string,
  workspace: string,
  cache: FileReadCache,
): Promise<ImpactCandidate[]> {
  const facets = requiredQueryFacets(query);
  if (facets.length < 2) return [];
  const lifecycleRequested = /\b(?:state\s*machine|transition|lifecycle|workflow)\b/i.test(query)
    || /状態遷移|ライフサイクル/.test(query);
  const ranked: Array<{ candidate: ImpactCandidate; score: number }> = [];
  const files = walkCodeFiles(workspace, args.path ? { subPath: args.path } : {}).slice(0, 160);

  for (const file of files) {
    const surface = classifySurface(file.relPath);
    const candidateBase: ImpactCandidate = {
      path: file.relPath,
      line: 1,
      surface,
      why: "answer-semantic-responsibility",
      confidence: 0.5,
    };
    if (isNonImplementationAnswerCandidate(candidateBase)) continue;
    const content = readCached(workspace, file.relPath, cache);
    if (content === undefined) continue;
    const lower = content.toLowerCase();
    const matched = facets.filter((facet) => lower.includes(facet.toLowerCase()));
    if (matched.length < 2) continue;
    const evidence = selectQueryEvidence(content, query, { path: file.relPath });
    if (evidence === undefined) continue;
    const lifecycleEvidence = lifecycleRequested
      && /\b(?:transition|state|status|setStatus|stateMachine)\b/i.test(content);
    const serviceLayer = /(?:^|\/)(?:services?|domain|core|application)(?:\/|$)/i.test(file.relPath);
    const transportLayer = /(?:^|\/)(?:api|routes?|serializers?|controllers?)(?:\/|$)/i.test(file.relPath);
    const score = matched.length * 4
      + Math.min(4, evidence.score)
      + (lifecycleEvidence ? 3 : 0)
      + (serviceLayer ? 2 : 0)
      - (transportLayer ? 2 : 0);
    ranked.push({
      candidate: {
        ...candidateBase,
        line: evidence.line,
        range: evidence.range,
        confidence: Math.min(0.97, 0.72 + matched.length * 0.06 + (lifecycleEvidence ? 0.05 : 0)),
      },
      score,
    });
  }

  return ranked
    .sort((a, b) => b.score - a.score || a.candidate.path.localeCompare(b.candidate.path))
    .slice(0, 6)
    .map(({ candidate }) => candidate);
}

/**
 * Whether `candidate` already carries a locator-assigned `.symbol` worth
 * protecting from a weaker answer-focus replacement — i.e. at least one
 * token of the symbol's OWN name is also a query token. This subsumes every
 * strong locator anchor (an import-edge delegation target, a direct
 * query-symbol hit, a filename match refined to the outstanding token) by
 * the property they all share, rather than naming the locator's internal
 * `why` tags here. 2026-08-21 answer-focus precision fix.
 */
export function hasStrongLocatorAnchor(candidate: ImpactCandidate, queryTokens: readonly string[]): boolean {
  if (candidate.symbol === undefined) return false;
  return tokenizeForEpoch(candidate.symbol).some((token) => queryTokens.includes(token));
}

/**
 * 2026-08-21 answer-focus precision fix, item (b): drop a ranked answer
 * candidate whose only support is a weak (non-explicit, non-strong) token
 * match when it is EITHER a non-source-role surface (style/doc) OR from a
 * project root other than the dominant one — the root(s) carrying the
 * query's explicit-identifier/strong-evidence support. A common/short token
 * (a CSS "cursor:" property, a generic "var"/"color"/"value" symbol name)
 * must not by itself pull a style/doc surface, or a surface from an
 * unrelated root, into an answer pack about code. Returns true when at
 * least one candidate was dropped, so the caller can decline to claim
 * `coverage:"complete"` over a pack built partly from discarded evidence.
 */
export function dropWeakCrossRootAndNonSourceAnswerCandidates(
  ranked: RankedAnswerEvidenceCandidate[],
): boolean {
  const hasSupport = (entry: RankedAnswerEvidenceCandidate): boolean =>
    entry.exactIdentifier || entry.strongEvidence;
  const supported = ranked.filter(hasSupport);
  // No entry has explicit/strong support of its own — every candidate is
  // equally weak, so a root/role gate here would be arbitrary rather than a
  // real cross-root inconsistency check. Leave the set alone.
  if (supported.length === 0) return false;
  const rootOf = (entry: RankedAnswerEvidenceCandidate): string =>
    projectRootOf(entry.candidate.path) ?? entry.candidate.path.split("/", 1)[0];
  const dominant = dominantRoot(supported, rootOf);
  const kept = ranked.filter((entry) => {
    if (hasSupport(entry)) return true;
    const role = classifySurface(entry.candidate.path);
    if (role === "doc" || role === "style") return false;
    return dominant === null || rootOf(entry) === dominant;
  });
  if (kept.length === ranked.length) return false;
  ranked.splice(0, ranked.length, ...kept);
  return true;
}

/**
 * 2026-10-06 independent review (P1-3): the function / method / class in
 * `content` whose name is one the question frames as a code entity
 * (`framedCodeNamesIn`), from the file's parsed declarations, scored with
 * selectAnchorFocus's own score when it ranked it. A name declared more than once in the
 * file (overloads, two classes' same-named methods) is left to the ordinary
 * ranking — a frame names a word, not which of several declarations.
 */
export async function framedDeclarationFocus(
  content: string,
  relPath: string,
  framed: ReadonlySet<string>,
  focus: AnchorFocusResult | undefined,
  cache: FileReadCache,
): Promise<{ name: string; range: string; score: number } | undefined> {
  const substantive = (kind: string | undefined): boolean => kind === "function" || kind === "method" || kind === "class";
  const lang = languageForPath(relPath);
  const parsed = lang ? await cache.parsedSymbols(content, lang, relPath) : null;
  const declared = (parsed ?? []).filter((symbol) => substantive(symbol.kind) && framed.has(symbol.name.toLowerCase()));
  if (declared.length !== 1) return undefined;
  const symbol = declared[0]!;
  const range = `${symbol.startLine}-${symbol.endLine}`;
  const scored = focus === undefined ? undefined : [focus.best, ...focus.runnerUps].find((item) => item.name === symbol.name && item.range === range);
  return { name: symbol.name, range, score: scored?.score ?? 0 };
}

/**
 * A locator abstain still carries useful filename-level candidates. For an
 * answer task, inspect only those bounded candidate files and re-rank their
 * symbols against the whole question. This turns a weak MAX_* filename hit
 * into the actual readiness builder without widening to a repository scan.
 */
export async function rankAnswerEvidenceCandidates(
  candidates: readonly ImpactCandidate[],
  query: string,
  workspace: string,
  cache: FileReadCache,
): Promise<RankedAnswerEvidenceCandidate[]> {
  const explicitEntries = explicitCodeIdentifierEntries(query);
  const explicit = new Set(explicitEntries.map((entry) => entry.token.toLowerCase()));
  // A name the request only FRAMES as a declaration (`Transport struct`) is matched in its own
  // spelling: the lowercase method `transport()` of another file is not the type.
  const framedSpelling = new Map(explicitEntries.filter((entry) => entry.framedOnly).map((entry) => [entry.token.toLowerCase(), entry.token]));
  const namesExplicit = (name: string): boolean => explicit.has(name.toLowerCase()) && (framedSpelling.get(name.toLowerCase()) ?? name) === name;
  const queryTokens = tokenizeForEpoch(query);
  const focusedPaths = new Set<string>();
  const ranked: RankedAnswerEvidenceCandidate[] = [];
  // A request anchor's declaration takes its file's focus; a locator candidate for the same file
  // that would itself have ranked as the named identifier is remembered on the anchor's entry
  // (`locatorAlsoExact`), so the decision state a located exact identifier earns is not mistaken for
  // the one a RECOVERED one earns (see `buildAnswerTaskPack`'s `recoveredExactAnswer`).
  const noteShadowedExact = (candidatePath: string): void => {
    const entry = ranked.find((item) => item.anchorDefinition === true && item.candidate.path === candidatePath);
    if (entry !== undefined) entry.locatorAlsoExact = true;
  };
  // WP-I (eval-0929 §5/§8): paths the question names EXPLICITLY (a path
  // string, e.g. "In src/service.ts, ...") — see `RankedAnswerEvidenceCandidate
  // .explicitNamedPath`'s own doc for why this is checked once, after the
  // main loop, rather than folded into `answerEvidencePathPenalty` above.
  const namedPaths = new Set(queryNamedWorkspaceFiles(query, workspace, candidates.map((c) => c.path)));
  // 2026-10-06 independent review (P1-3): plain words the question frames as
  // a code entity ("the retry function", "retry in src/retry.js") — see
  // `framedCodeNamesIn`. Tried after the explicit identifiers, before the
  // query-evidence sort, whose substring count let `retryDelay` (3 matched
  // words, "retry" inside its name) beat the `retry` the question named.
  const framed = new Set(framedCodeNamesIn(query).map((name) => name.toLowerCase()));

  for (const candidate of candidates) {
    // 2026-10-29: a request anchor's declaration / literal window is the answer's
    // subject as the workspace itself located it — it keeps its range and is not
    // re-focused. The same file's other candidates (a locator hit on a sibling
    // symbol) are dropped by `focusedPaths` like any other focused path.
    if (candidate.why === REQUEST_ANCHOR_DEFINITION_WHY) {
      if (focusedPaths.has(candidate.path) && ranked.some((entry) => entry.anchorDefinition === true && entry.candidate.path === candidate.path && entry.candidate.range === candidate.range)) continue;
      focusedPaths.add(candidate.path);
      // Ranked among its fellows by the score the ordinary ranking gives the same declaration (its
      // focus score plus the query-evidence score of its file), above everything else: two anchors
      // in two files stay distinguishable, which `isStrongRecoveredAnswerCandidate` reads.
      const anchorContent = readCached(workspace, candidate.path, cache);
      const anchorFocus = anchorContent === undefined ? undefined : await selectAnchorFocus(anchorContent, candidate.path, query, cache);
      const anchorEvidence = anchorContent === undefined ? undefined : selectQueryEvidence(anchorContent, query, { path: candidate.path });
      const focusScore = anchorFocus === undefined ? 0
        : [anchorFocus.best, ...anchorFocus.runnerUps].find((item) => item.name === candidate.symbol && item.range === candidate.range)?.score ?? 0;
      ranked.push({
        candidate: { ...candidate, handle: undefined },
        score: 100 + focusScore + (anchorEvidence?.score ?? 0) - answerEvidencePathPenalty(candidate, query),
        exactIdentifier: true,
        strongEvidence: true,
        anchorDefinition: true,
      });
      continue;
    }
    if (candidate.why === REQUEST_LITERAL_WHY) {
      ranked.push({
        candidate: { ...candidate, handle: undefined },
        score: 50,
        exactIdentifier: false,
        strongEvidence: true,
        anchorLiteral: true,
      });
      continue;
    }
    const content = readCached(workspace, candidate.path, cache);
    const focus = content === undefined ? undefined : await selectAnchorFocus(content, candidate.path, query, cache);
    const evidence = content === undefined
      ? undefined
      : selectQueryEvidence(content, query, { path: candidate.path });
    const strongEvidence = evidence !== undefined
      && evidence.score >= 6
      && evidence.matchedTerms.length >= 2;
    const exactFocuses = focus === undefined
      ? []
      : [focus.best, ...focus.runnerUps].filter((item) => namesExplicit(item.name));
    const candidateStem = path.basename(candidate.path, path.extname(candidate.path)).toLowerCase();
    const exactFocus = exactFocuses.length === 0
      ? undefined
      : explicit.has(candidateStem)
        ? [...exactFocuses].sort((a, b) => {
            const span = (item: AnchorFocusCandidate): number => {
              const [start, end] = item.range.split("-").map(Number);
              return Number.isFinite(start) && Number.isFinite(end) ? (end ?? 0) - (start ?? 0) : 0;
            };
            return span(b) - span(a);
          })[0]
        : exactFocuses[0];
    if (exactFocus !== undefined) {
      if (focusedPaths.has(candidate.path)) {
        if (true) noteShadowedExact(candidate.path);
        continue;
      }
      focusedPaths.add(candidate.path);
      const startLine = Number.parseInt(exactFocus.range.split("-", 1)[0] ?? "1", 10);
      ranked.push({
        candidate: {
          ...candidate,
          line: Number.isFinite(startLine) ? startLine : candidate.line,
          range: exactFocus.range,
          symbol: exactFocus.name,
          why: "answer-explicit-symbol-focus",
          confidence: Math.max(candidate.confidence, 0.98),
          handle: undefined,
        },
        score: exactFocus.score + (evidence?.score ?? 0) - answerEvidencePathPenalty(candidate, query),
        exactIdentifier: true,
        strongEvidence,
      });
      continue;
    }
    const framedFocus = framed.size === 0 || content === undefined
      ? undefined
      : await framedDeclarationFocus(content, candidate.path, framed, focus, cache);
    if (framedFocus !== undefined) {
      if (focusedPaths.has(candidate.path)) continue;
      focusedPaths.add(candidate.path);
      const startLine = Number.parseInt(framedFocus.range.split("-", 1)[0] ?? "1", 10);
      ranked.push({
        candidate: {
          ...candidate,
          line: Number.isFinite(startLine) ? startLine : candidate.line,
          range: framedFocus.range,
          symbol: framedFocus.name,
          why: "answer-query-evidence-symbol-focus",
          confidence: Math.max(candidate.confidence, 0.95),
          handle: undefined,
        },
        score: framedFocus.score + (evidence?.score ?? 0) - answerEvidencePathPenalty(candidate, query),
        exactIdentifier: false,
        strongEvidence: true,
      });
      continue;
    }
    if (strongEvidence) {
      const isSubstantiveKind = (item: { kind?: string }): boolean =>
        item.kind === "function" || item.kind === "method" || item.kind === "class";
      // 2026-08-21 answer-focus precision fix (file-named-header
      // short-circuit): the query's answer is "this file, generally" only
      // when EVERY term the evidence engine actually matched is already
      // accounted for by the file's OWN name — i.e. the query has no
      // substantive content beyond naming the file ("what does the coverage
      // packer do" naming coveragePacker.ts). A query that ALSO names
      // something else ("which codec does the pipeline choose" — "codec" is
      // not part of pipeline.ts's own name) is asking about a specific
      // behavior/relationship, not the file as a whole, even though it too
      // names the file; that case must fall through to
      // structural/enclosing/containment below so the actual function wins.
      // Decided FIRST, ahead of structural/enclosing/containment, so an
      // unrelated helper that merely happens to reference a type whose OWN
      // name contains the query's words (e.g. every function taking a
      // `CoveragePackerInput` parameter trivially "matches" coverage+packer)
      // can never outrank the file's own header once the query is purely
      // about that file.
      const isFileNamedHeader = (item: { kind?: string; name: string } | undefined): boolean => {
        if (item?.kind !== "module-header" || evidence.matchedTerms.length === 0) return false;
        const baseTokens = new Set(tokenizeForEpoch(item.name).map((t) => t.toLowerCase()));
        return evidence.matchedTerms.every((term) => baseTokens.has(term.toLowerCase()));
      };
      let evidenceFocus: { name: string; range: string; score: number } | undefined =
        isFileNamedHeader(focus?.best) ? focus!.best : undefined;
      // 2026-08-21 answer-focus precision fix: this used to accept ANY scored
      // focus candidate (including a module header or a const/type) whose
      // range merely CONTAINS evidence.line, before ever checking whether a
      // real function/method structurally answers the evidence — and once
      // that (possibly non-substantive) containment hit was accepted, the
      // enclosing-function fallback below was skipped entirely (it only ran
      // when nothing had matched yet). A header spanning lines 1-49 that
      // happens to contain the evidence line pre-empted the real function
      // every time. Now: try the STRUCTURAL (>=3 matched terms, or ALL
      // available matched terms when the query has fewer than 3 — e.g. a CJK
      // query embedding only 1-2 ASCII content words, which can then never
      // reach a fixed 3) and ENCLOSING function/method checks first — both
      // are substantive by construction — and only fall back to a bare
      // line-containment focus match (which may be a header/const) when
      // neither finds anything, i.e. the evidence genuinely sits outside any
      // callable.
      if (evidenceFocus === undefined && content !== undefined) {
        const lang = languageForPath(candidate.path);
        const parsed = lang ? await cache.parsedSymbols(content, lang, candidate.path) : null;
        const contentLines = content.split(/\r?\n/);
        const structural = (parsed ?? [])
          .filter((symbol) =>
            symbol.kind === "method"
            || symbol.kind === "function"
            || (candidate.why === "answer-semantic-responsibility" && symbol.kind === "class")
          )
          .map((symbol) => {
            const body = `${symbol.name}\n${contentLines.slice(symbol.startLine - 1, symbol.endLine).join("\n")}`.toLowerCase();
            return {
              symbol,
              matched: evidence.matchedTerms.filter((term) => body.includes(term.toLowerCase())).length,
            };
          })
          .sort((a, b) =>
            b.matched - a.matched
            || (a.symbol.endLine - a.symbol.startLine) - (b.symbol.endLine - b.symbol.startLine)
            || a.symbol.startLine - b.symbol.startLine
          )[0];
        const structuralFloor = Math.min(3, evidence.matchedTerms.length);
        if (structural && structural.matched >= structuralFloor && structural.matched > 0) {
          evidenceFocus = {
            name: structural.symbol.name,
            range: `${structural.symbol.startLine}-${structural.symbol.endLine}`,
            score: evidence.score + structural.matched,
          };
        }
        if (evidenceFocus === undefined) {
          const enclosing = (parsed ?? [])
            .filter((symbol) =>
              (symbol.kind === "method" || symbol.kind === "function")
              && evidence.line >= symbol.startLine
              && evidence.line <= symbol.endLine
            )
            .sort((a, b) =>
              (a.endLine - a.startLine) - (b.endLine - b.startLine)
            )[0];
          if (enclosing) {
            evidenceFocus = {
              name: enclosing.name,
              range: `${enclosing.startLine}-${enclosing.endLine}`,
              score: evidence.score,
            };
          }
        }
      }
      if (evidenceFocus === undefined && focus !== undefined) {
        // 2026-08-21 answer-focus precision fix (containment substantive
        // preference): a module header's range legitimately CONTAINS the
        // evidence line whenever the query's answer is discussed in the
        // header's own prose — that is a geometrically correct containment,
        // not a bug, but a real function ALSO in this candidate list
        // (focus.runnerUps) that covers the same evidence more usefully must
        // still win (the file-named-header case already short-circuited
        // above, so reaching here means the header — if any — is NOT what the
        // query named). Prefer a substantive (function/method/class)
        // containing item; when none of the geometrically-containing items is
        // substantive, fall back to selectAnchorFocus's own whole-file `best`
        // when it is substantive (more reliable than an arbitrary
        // non-substantive containing item) — but ONLY for a single-focus
        // query (no slash-grouped/quoted required facets). A multi-facet
        // query ("payment / inventory / shipping") already has its own
        // coverage contract: the caller-visible materializeNamedAnswer member-
        // expansion (and the pre-existing symbol-less whole-file serve it
        // expands from) is what is supposed to assemble multi-facet coverage;
        // pinning `best` here would narrow the surface to ONE facet's
        // function and silently drop that contract instead of feeding it.
        // Only settle for a non-substantive containing item as the last
        // resort.
        const containing = [focus.best, ...focus.runnerUps].filter((item) => {
          const bounds = item.range.match(/^(\d+)-(\d+)$/);
          return bounds != null
            && evidence.line >= Number(bounds[1])
            && evidence.line <= Number(bounds[2]);
        });
        evidenceFocus = containing.find(isSubstantiveKind)
          ?? (isSubstantiveKind(focus.best) && requiredQueryFacets(query).length < 2 ? focus.best : undefined)
          ?? containing[0];
      }
      if (evidenceFocus !== undefined) {
        if (focusedPaths.has(candidate.path)) {
          if (namesExplicit(evidenceFocus.name)) noteShadowedExact(candidate.path);
          continue;
        }
        focusedPaths.add(candidate.path);
        const startLine = Number.parseInt(evidenceFocus.range.split("-", 1)[0] ?? "1", 10);
        const exactIdentifier = namesExplicit(evidenceFocus.name);
        ranked.push({
          candidate: {
            ...candidate,
            line: Number.isFinite(startLine) ? startLine : candidate.line,
            range: evidenceFocus.range,
            symbol: evidenceFocus.name,
            why: "answer-query-evidence-symbol-focus",
            confidence: Math.max(candidate.confidence, 0.9),
            handle: undefined,
          },
          score: evidence.score + evidenceFocus.score - answerEvidencePathPenalty(candidate, query),
          exactIdentifier,
          strongEvidence: true,
        });
        continue;
      }
      // Anchor preservation: no window in THIS file's evidence scan resolved
      // to any symbol at all — but if the locator already anchored this
      // candidate on a query-relevant symbol (import-edge delegation target,
      // a direct query-symbol hit, or a filename match refined to the token
      // that answers the query — generalized as "the symbol's own name
      // covers a query token", so this needs no knowledge of the locator's
      // internal why-vocabulary), keep that anchor instead of reporting a
      // symbol-less range.
      if (candidate.symbol !== undefined && hasStrongLocatorAnchor(candidate, queryTokens)) {
        if (focusedPaths.has(candidate.path)) {
          if (candidate.symbol !== undefined && namesExplicit(candidate.symbol)) noteShadowedExact(candidate.path);
          continue;
        }
        focusedPaths.add(candidate.path);
        ranked.push({
          candidate: { ...candidate, confidence: Math.max(candidate.confidence, 0.9) },
          score: evidence.score - answerEvidencePathPenalty(candidate, query),
          exactIdentifier: namesExplicit(candidate.symbol),
          strongEvidence: true,
        });
        continue;
      }
      ranked.push({
        candidate: {
          ...candidate,
          line: evidence.line,
          range: evidence.range,
          symbol: undefined,
          why: "answer-query-evidence-focus",
          confidence: Math.max(candidate.confidence, 0.9),
          handle: undefined,
        },
        score: evidence.score - answerEvidencePathPenalty(candidate, query),
        exactIdentifier: false,
        strongEvidence: true,
      });
      continue;
    }
    // Anchor preservation: a locator-anchored, already-named symbol must not
    // be demoted to a non-substantive selectAnchorFocus guess (module header
    // / const / type / interface) purely because that guess scored higher on
    // lexical coverage — see hasStrongLocatorAnchor above. selectAnchorFocus
    // itself now prefers a substantive best when nothing was explicitly
    // named (2026-08-21), so this only still fires when its OWN best
    // candidate in THIS file is non-substantive.
    if (
      focus !== undefined
      && candidate.symbol !== undefined
      && focus.best.kind !== "function" && focus.best.kind !== "method" && focus.best.kind !== "class"
      && hasStrongLocatorAnchor(candidate, queryTokens)
    ) {
      if (focusedPaths.has(candidate.path)) {
        if (candidate.symbol !== undefined && namesExplicit(candidate.symbol)) noteShadowedExact(candidate.path);
        continue;
      }
      focusedPaths.add(candidate.path);
      ranked.push({
        candidate: { ...candidate, confidence: Math.max(candidate.confidence, 0.9) },
        score: candidate.confidence - answerEvidencePathPenalty(candidate, query),
        exactIdentifier: namesExplicit(candidate.symbol),
        strongEvidence: false,
      });
      continue;
    }
    if (focus !== undefined) {
      if (focusedPaths.has(candidate.path)) {
        if (namesExplicit(focus.best.name)) noteShadowedExact(candidate.path);
        continue;
      }
      focusedPaths.add(candidate.path);
      const startLine = Number.parseInt(focus.best.range.split("-", 1)[0] ?? "1", 10);
      const exactIdentifier = namesExplicit(focus.best.name);
      ranked.push({
        candidate: {
          ...candidate,
          line: Number.isFinite(startLine) ? startLine : candidate.line,
          range: focus.best.range,
          symbol: focus.best.name,
          why: exactIdentifier ? "answer-explicit-symbol-focus" : "answer-semantic-symbol-focus",
          confidence: Math.max(candidate.confidence, exactIdentifier ? 0.98 : 0.85),
          handle: undefined,
        },
        score: focus.best.score - answerEvidencePathPenalty(candidate, query),
        exactIdentifier,
        strongEvidence: false,
      });
      continue;
    }
    ranked.push({
      candidate,
      score: candidate.confidence - answerEvidencePathPenalty(candidate, query),
      exactIdentifier: candidate.symbol !== undefined && namesExplicit(candidate.symbol),
      strongEvidence: false,
    });
  }

  for (const entry of ranked) {
    entry.score += answerBuilderOwnershipBonus(entry.candidate, query);
    // WP-I (eval-0929 §5/§8, adopted chip from WP-F): a same-name decoy must
    // never outrank the file the question itself named just because it
    // scored higher on ordinary lexical/structural signal — a path in the
    // question is the answer's FOCUS, not one more ranked contender. Only
    // ever promotes a candidate that ALREADY carries `exactIdentifier`
    // (genuinely declares the identifier the query asked about); a named
    // path whose file is simply unrelated to the identifier gets no boost
    // and stays ranked on its own (unrelated) merits.
    if (entry.exactIdentifier && namedPaths.has(entry.candidate.path)) entry.explicitNamedPath = true;
  }
  return ranked.sort((a, b) =>
    Number(b.anchorDefinition === true) - Number(a.anchorDefinition === true)
    || Number(b.anchorLiteral === true) - Number(a.anchorLiteral === true)
    || Number(b.explicitNamedPath === true) - Number(a.explicitNamedPath === true)
    || Number(b.exactIdentifier) - Number(a.exactIdentifier)
    || b.score - a.score
    || b.candidate.confidence - a.candidate.confidence
    || a.candidate.path.localeCompare(b.candidate.path)
  );
}

export async function recoverExplicitIdentifierAnswerCandidates(
  args: TaskPackArgs,
  query: string,
  workspace: string,
  ranked: RankedAnswerEvidenceCandidate[],
  cache: FileReadCache,
  /** WP-N: the pack's whole-identifier absence verdicts (`explicitIdentifierAbsences`) — the only source of "verified absent". */
  absences: ReadonlyMap<string, ExplicitIdentifierAbsence>,
): Promise<string[]> {
  const entries = explicitCodeIdentifierEntries(query).slice(0, 3);
  const identifiers = entries.map((entry) => entry.token);
  if (identifiers.length === 0) return [];
  if (ranked.some((entry) => entry.exactIdentifier)) return [];
  const framedOnly = new Set(entries.filter((entry) => entry.framedOnly).map((entry) => entry.token));
  const verifiedAbsent: string[] = [];
  const injected: RankedAnswerEvidenceCandidate[] = [];
  for (const identifier of identifiers) {
    // A plain word the request frames as a declaration, in a file the request names: that file's
    // declaration of it, before the workspace-wide literal scan below (see `framedTypeInNamedFiles`).
    const named = framedOnly.has(identifier) ? await framedTypeInNamedFiles(identifier, query, workspace, cache) : undefined;
    if (named !== undefined) {
      injected.push({
        candidate: {
          path: named.path,
          line: named.startLine,
          surface: classifySurface(named.path),
          why: "answer-explicit-identifier-recovery",
          confidence: 0.97,
          range: `${named.startLine}-${named.endLine}`,
          symbol: identifier,
        },
        score: 6 + 9,
        exactIdentifier: true,
        strongEvidence: true,
      });
      continue;
    }
    // WP-N (eval-0929 §8): only a WHOLE-identifier occurrence can name the
    // definition owner. This scan is a substring scan, and a `MAX_X_V2`
    // declaration used to be injected as `MAX_X`'s "definition" (the text
    // before the substring reads `export const `) — a near-miss is never a
    // declaration. Each hit's FULL line is re-read: `match.text` is a trimmed
    // window that can cut a whole occurrence following a near-miss.
    const matches = scanLiteral(identifier, workspace, {
      caseInsensitive: false,
      ...(args.path ? { path: args.path } : {}),
    }).flatMap((match) => {
      const hit = wholeIdentifierOnHitLine(workspace, match, identifier, cache);
      return hit === undefined ? [] : [{ ...match, hit }];
    });
    if (matches.length === 0) {
      // No whole occurrence in this (possibly path-scoped) code scan. Absent
      // only when the pack-wide verdict agrees — a name written whole in a doc,
      // a config file or outside `args.path` is not absent.
      if (absences.has(identifier)) verifiedAbsent.push(identifier);
      continue;
    }
    const scored = matches
      .map((match) => {
        const asCandidate: ImpactCandidate = {
          path: match.path,
          line: match.line,
          surface: classifySurface(match.path),
          why: "answer-explicit-identifier-recovery",
          confidence: 0.97,
        };
        // Unchanged when the line's FIRST occurrence is the whole one (the
        // trimmed-window reading this always used); read around the whole
        // occurrence only when a near-miss precedes it on the same line.
        const text = match.text ?? "";
        const at = text.indexOf(identifier);
        const before = match.hit.firstIsWhole ? (at >= 0 ? text.slice(0, at) : "") : match.hit.text.slice(0, match.hit.offset);
        const after = match.hit.firstIsWhole
          ? (at >= 0 ? text.slice(at + identifier.length) : "")
          : match.hit.text.slice(match.hit.offset + identifier.length);
        // Definition-shaped = a declaration keyword precedes the name, or the
        // name is being bound (= / :). A bare `name(` is a CALL — counting
        // calls made every call site a "definition file" and the ambiguity
        // guard then suppressed recovery exactly where it should fire.
        const definitionShaped = IDENTIFIER_DEFINITION_KEYWORD_RE.test(before)
          || /^\s*[=:]/.test(after);
        let score = 0;
        if (IDENTIFIER_DEFINITION_KEYWORD_RE.test(before)) score += 4;
        if (/^\s*[(=:{]/.test(after)) score += 2;
        if (!isNonImplementationAnswerCandidate(asCandidate) && !isTestConcernPath(match.path)) score += 3;
        if (/\.(?:md|markdown|txt|rst|adoc)$/i.test(match.path)) score -= 4;
        return { match, asCandidate, score, definitionShaped };
      })
      .sort((a, b) =>
        b.score - a.score
        || a.match.path.localeCompare(b.match.path)
        || a.match.line - b.match.line
      );
    // Ambiguity guard: inject only when definition-shaped occurrences are
    // confined to exactly ONE file (a unique definition owner). A name whose
    // definition-shaped hits span several files — or that only ever appears
    // as a value/reference — keeps the candidate-choice flow: picking one
    // owner there would silently resolve a genuinely ambiguous investigation.
    const definitionFiles = new Set(
      scored.filter((entry) => entry.definitionShaped).map((entry) => entry.match.path),
    );
    if (definitionFiles.size !== 1) continue;
    const owner = [...definitionFiles][0]!;
    const best = scored.find((entry) => entry.definitionShaped && entry.match.path === owner)!;
    const content = readCached(workspace, best.match.path, cache);
    let range: string | undefined;
    let symbol: string | undefined;
    if (content !== undefined) {
      const lang = languageForPath(best.match.path);
      const parsed = lang ? await cache.parsedSymbols(content, lang, best.match.path) : null;
      const enclosing = (parsed ?? [])
        .filter((sym) => best.match.line >= sym.startLine && best.match.line <= sym.endLine)
        .sort((a, b) => (a.endLine - a.startLine) - (b.endLine - b.startLine))[0];
      if (enclosing) {
        range = `${enclosing.startLine}-${enclosing.endLine}`;
        symbol = enclosing.name;
      } else {
        // FIX-ORIG (2026-09-27, eval-0927 P1 §6.1): was content.split(/\r?\n/).length
        // -- the phantom-trailing-newline off-by-one (util/countLines.ts) --
        // which this `Math.min` engages precisely for a short file (the
        // common case a bare literal-identifier hit with no enclosing
        // symbol lands in), mining an out-of-bounds `end` for the injected
        // candidate's `range` that later becomes this surface's evidence
        // range. countLines() matches tl_edit_file's own bounds check.
        const total = countLines(content);
        const start = Math.max(1, best.match.line - 8);
        const end = Math.min(total, best.match.line + 24);
        range = `${start}-${end}`;
      }
    }
    injected.push({
      candidate: {
        ...best.asCandidate,
        ...(range ? { range } : {}),
        symbol: symbol ?? identifier,
      },
      score: 6 + best.score,
      exactIdentifier: true,
      strongEvidence: true,
    });
  }
  if (injected.length > 0) ranked.unshift(...injected);
  return verifiedAbsent;
}
