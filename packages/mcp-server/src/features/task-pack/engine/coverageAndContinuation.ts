// coverageAndContinuation — extracted implementation; imports point to the owning modules.
import * as path from "path";
import type { ContinuationCall } from "./packBasics.js";
import type { ImpactCandidate } from "@tokenlighten/types";
import type { RankedAnswerEvidenceCandidate } from "./roleAndConcernScope3.js";
import type { TaskPackResult } from "../model.js";
import type { TaskPackSurface } from "../model.js";
import { FileReadCache } from "./packBasics2.js";
import { HIGH_CONFIDENCE_THRESHOLD } from "./packBasics2.js";
import { NATIVE_EXTS } from "./queryIntent.js";
import { WEAK_CONCERN_TOKENS } from "./roleAndConcernScope2.js";
import { answerBuilderOwnershipBonus } from "./answerCandidates.js";
import { candidateToSurface } from "./surfaceMaterialization.js";
import { concernGroupMatchesSurfaces } from "./roleAndConcernScope3.js";
import { concernGroupsForQuery } from "./roleAndConcernScope3.js";
import { concreteIdentifierTokens } from "./createAndWiringEndpoints2.js";
import { executeClosureRead } from "./recursiveClosure2.js";
import { extractEnumValueTokens } from "./createAndWiringEndpoints2.js";
import { hasServedCode } from "./wiringEvidence2.js";
import { isImplementationPath } from "./changeAndReadinessEvidence2.js";
import { isNonImplementationAnswerCandidate } from "./answerCandidates.js";
import { isUnderAncestor } from "./seedResolution.js";
import { isUnderAnyPrefix } from "./roleAndConcernScope.js";
import { locateTaskContext } from "../../locator/locateTaskContext.js";
import { normIdent } from "./createAndWiringEndpoints2.js";
import { rankAbstainCandidates } from "./roleAndConcernScope3.js";
import { roleSearchScope } from "./roleAndConcernScope.js";
import { styleNextForMissingRole } from "./queryIntent2.js";
import { surfaceIndexForToken } from "./createAndWiringEndpoints2.js";
import { unmatchedConcernTokens } from "./roleAndConcernScope3.js";

export function isStrongRecoveredAnswerCandidate(
  candidates: readonly RankedAnswerEvidenceCandidate[],
  query: string,
): boolean {
  const top = candidates[0];
  if (top === undefined) return false;
  if (top.exactIdentifier) {
    const runnerUp = candidates[1];
    return runnerUp === undefined
      || !runnerUp.exactIdentifier
      || top.score - runnerUp.score >= 0.35;
  }
  if (top.score < 2.5) return false;
  const runnerUp = candidates[1];
  if (
    runnerUp !== undefined
    && answerBuilderOwnershipBonus(top.candidate, query) > 0
    && answerBuilderOwnershipBonus(runnerUp.candidate, query) === 0
  ) {
    return true;
  }
  if (
    runnerUp !== undefined
    && !/\b(?:test|tests|spec|fixture|bench|benchmark)\b/i.test(query)
    && !isNonImplementationAnswerCandidate(top.candidate)
    && isNonImplementationAnswerCandidate(runnerUp.candidate)
  ) {
    return true;
  }
  // Two independently strong semantic matches are still an ambiguity even if
  // one edges out the other numerically. Promote only when every runner-up is
  // below the same evidence floor.
  return runnerUp === undefined || runnerUp.score < 2.5;
}

export async function augmentConcernGroupSurfaces(
  surfaces: TaskPackSurface[],
  query: string,
  workspace: string,
  requiredRoles: string[],
  cache: FileReadCache,
  protectedSurfaces: Set<TaskPackSurface>,
  // 2026-07-12d confinement fix: caller-SEEDED-flow scope (buildSeededTaskPack's
  // own `ancestor`, the caller-supplied entries' common ancestor directory).
  // undefined at the OTHER two call sites (buildTaskPack's pathless flow,
  // buildPartialPack's abstain-candidate flow) — there is no caller-named
  // scope to respect there, so they keep today's unconfined behavior.
  scope?: string,
  // B1a (2026-08-01 retrieval-scope): the caller's own anchor cluster. When the
  // seeded flow deliberately LIFTS `scope` (IMPROVEMENT F: volunteering more
  // clustered paths must not shrink the discovered closure), "" used to mean
  // the WHOLE workspace — including sibling project trees that share nothing
  // with the caller's paths but a distant ancestor. The anchor prefixes keep
  // the cross-package reach IMPROVEMENT F is about while restoring the family
  // boundary. Absent → unchanged behavior.
  anchorPaths?: readonly string[],
): Promise<void> {
  const groups = concernGroupsForQuery(query);
  if (groups.length < 2) return;

  const familyScope = scope === undefined || scope !== ""
    ? undefined
    : roleSearchScope(anchorPaths ?? [], query, workspace);
  const withinScope = (candidatePath: string): boolean =>
    (!scope || isUnderAncestor(candidatePath, scope))
    && isUnderAnyPrefix(candidatePath, familyScope);

  const seen = new Set(surfaces.map((s) => s.path));
  let added = 0;
  for (const group of groups) {
    if (concernGroupMatchesSurfaces(group, surfaces)) continue;
    if (added >= 4) return;

    const located = await locateTaskContext(workspace, {
      action: "locate",
      query: group.query,
      ...(scope ? { path: scope } : {}),
      limit: 3,
    });
    const candidates: ImpactCandidate[] = located.hit
      ? [...located.primary, ...located.related]
      : rankAbstainCandidates(located.candidateDetails ?? []);
    // Defensive re-confinement (same discipline as buildSeededTaskPack's own
    // required-role-fill loop): locateTaskContext's own hard-scope filter
    // already restricts to `scope` when passed, but this stays explicit
    // rather than relying solely on that internal filter. An out-of-scope
    // candidate is dropped here — never added, never coverage-bearing.
    let candidate = candidates.find((c) => !seen.has(c.path) && withinScope(c.path));
    if (!candidate) {
      // R0 (2026-08-21, W4-A): case-insensitive compare — see orderedUniqueTokens.
      for (const token of group.tokens.filter((t) => !WEAK_CONCERN_TOKENS.has(t.toLowerCase())).slice(0, 3)) {
        const tokenLocated = await locateTaskContext(workspace, {
          action: "locate",
          query: token,
          ...(scope ? { path: scope } : {}),
          limit: 3,
        });
        const tokenCandidates: ImpactCandidate[] = tokenLocated.hit
          ? [...tokenLocated.primary, ...tokenLocated.related]
          : rankAbstainCandidates(tokenLocated.candidateDetails ?? []);
        candidate = tokenCandidates.find((c) => !seen.has(c.path) && withinScope(c.path));
        if (candidate) break;
      }
    }
    if (!candidate) continue;

    const surface = await candidateToSurface(
      { ...candidate, required: true, confidence: Math.max(candidate.confidence, 0.7) },
      workspace,
      requiredRoles,
      query,
      cache,
    );
    surfaces.push(surface);
    protectedSurfaces.add(surface);
    seen.add(surface.path);
    added++;
  }
}

/**
 * Build one `tl_search_files action:"find"` suggestion per unmatched concern
 * token, so the agent's next TL call is scoped to exactly what this pack could
 * not confirm coverage for — rather than a vague "locate more" or a full re-run
 * of the same query that already produced this pack.
 */
export function buildBlockingNextSteps(query: string, surfaces: TaskPackSurface[]): string[] {
  const tokens = unmatchedConcernTokens(query, surfaces);
  return tokens.map((t) => `tl_search_files {action:"find", queries:["${t}"]}`);
}

/**
 * Dominance tie-break (issue #3, 2026-08-21). `deriveCoverage` below brands a
 * pack "candidate-list" whenever the locator returned MULTIPLE primary
 * candidates for one query — genuine ties (a header+impl pair, two same-role
 * files) as well as the far more common case where one candidate obviously
 * outclasses the rest (a `filename-match` hit on an `api`/`domain`-role
 * implementation file next to a single stray `exact-text` hit inside an
 * unrelated `unknown`-role file). Shipping "candidate-list" for the second
 * shape — and therefore `await_input`/`choose-candidate` on the wire
 * (`protocol/decisionWire.ts`'s `projectTaskDecision`) — spends a caller
 * round trip confirming a choice that was never really in doubt.
 *
 * `candidateDominanceClass` scores a surface on three independent axes, most
 * significant first — the "lexicographic class tuple" this fix is named for:
 *
 *   1. role class    — a recognized structural/code role (every `ImpactSurface`
 *                       value except "doc"/"unknown": contract, api, domain,
 *                       data, ui, style, test, config) beats "doc", which
 *                       beats "unknown". `classifySurface` (util/impact.ts) is
 *                       the sole producer of `role`, so this reuses ITS
 *                       vocabulary rather than inventing a parallel one.
 *   2. evidence class — WHY this candidate matched at all. A structural or
 *                       distinctive match (`query-symbol`, `filename-match`,
 *                       `exact-text:distinctive`, `reference` — the strong
 *                       `why` vocabulary locateTaskContext.ts already emits)
 *                       beats a plain lexical hit (`exact-text`, `path-token`,
 *                       `text`), which in turn beats every OTHER `why` this
 *                       file emits (`caller-supplied`, `header-source-pair`,
 *                       `role-fill-scan`, the `answer-*` family, …): those say
 *                       nothing about how well THIS candidate matches the
 *                       query relative to its rivals, so an unrecognized `why`
 *                       sits at the bottom rather than being trusted to break
 *                       a tie. This is also what keeps a directory-seeded pack
 *                       (`why:"caller-supplied"`, never routed through this
 *                       helper in the first place — see the call sites below)
 *                       from ever winning on evidence class alone.
 *   3. source-ness    — a recognized implementation/native source extension
 *                       (`isImplementationPath`, plus the native C/C++
 *                       extension set `NATIVE_EXTS` already used for header
 *                       pairing) beats everything else. No repository-specific
 *                       directory name is consulted, per the design brief.
 *
 * A candidate wins only when it is STRICTLY better than every other candidate
 * on this tuple — `resolveDominantSurfaceIndex` returns -1 on any tie at the
 * best rank, so the genuine-tie case (same role/why/extension — e.g. WP-A
 * test (c)'s header+impl same-stem pair) keeps shipping `choose-candidate`
 * exactly as before. This helper never emits a decision itself: it only stops
 * `deriveCoverage` from asserting an ambiguity that provably was not one.
 * `buildTaskExecutionContract` and `decisionWire.ts`'s `projectTaskDecision`
 * still gate the actual `act.answer`/`act.edit` behind their own unchanged
 * certificate/floor checks — a dominance win with no certificate still lands
 * on `discover` or `await_input`, never a fabricated `act.*`.
 *
 * Deliberately silent on whether the winner already carries a body:
 * `resolveDominantSurfaceIndex` answers only "is the choice resolved". A
 * codeless winner is a real, common shape (`runCandidateInlinePass` below is
 * what a live "candidate-list" pack normally relies on to serve bodies at
 * all) — `applyDominancePromotion`, called right after this at every
 * caller, is what turns "resolved" into "just serve it and proceed" (design
 * point 1) by running the SAME single-handle closure read the inline pass
 * uses, scoped to the one surface that matters now that the choice is not
 * open. Splitting the two keeps this function a pure, cheaply-testable
 * classifier.
 */
export const DOMINANCE_STRONG_WHY: ReadonlySet<string> = new Set([
  "query-symbol", "filename-match", "exact-text:distinctive", "reference",
]);

export const DOMINANCE_WEAK_WHY: ReadonlySet<string> = new Set([
  "exact-text", "path-token", "text",
]);

export function candidateDominanceRoleTier(role: string | undefined): number {
  return role === "doc" ? 1 : role === undefined || role === "unknown" ? 2 : 0;
}

export function candidateDominanceEvidenceTier(why: string | undefined): number {
  if (why === undefined) return 2;
  if (DOMINANCE_STRONG_WHY.has(why)) return 0;
  if (DOMINANCE_WEAK_WHY.has(why)) return 1;
  return 2;
}

export function candidateDominanceSourceTier(relPath: string): number {
  const ext = path.extname(relPath).toLowerCase();
  return isImplementationPath(relPath) || NATIVE_EXTS.has(ext) ? 0 : 1;
}

export function candidateDominanceClass(
  surface: Pick<TaskPackSurface, "role" | "why" | "path">,
): readonly [number, number, number] {
  return [
    candidateDominanceRoleTier(surface.role),
    candidateDominanceEvidenceTier(surface.why),
    candidateDominanceSourceTier(surface.path),
  ];
}

export function compareDominanceClass(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/**
 * The index of the unique strictly-best surface among `surfaces`, or -1 when
 * there are fewer than two surfaces, or more than one surface ties the best
 * rank (a genuine tie — see the doc comment above). Silent on whether the
 * winner is already served — see `applyDominancePromotion` below.
 */
export function resolveDominantSurfaceIndex(surfaces: readonly TaskPackSurface[]): number {
  if (surfaces.length < 2) return -1;
  const classes = surfaces.map(candidateDominanceClass);
  let bestIdx = 0;
  for (let i = 1; i < classes.length; i++) {
    if (compareDominanceClass(classes[i]!, classes[bestIdx]!) < 0) bestIdx = i;
  }
  const tiedAtBest = classes.some(
    (c, i) => i !== bestIdx && compareDominanceClass(c, classes[bestIdx]!) === 0,
  );
  return tiedAtBest ? -1 : bestIdx;
}

/**
 * "Just serve it and proceed" (design point 1), the two parts `deriveCoverage`
 * cannot do itself: it only picks {coverage, reason}, before the pack's
 * `TaskPackResult` even exists. Called once by each producer right after
 * `result` is assembled (and BEFORE `dedupeTrimAndPersist`, so any embed
 * counts toward its byte-cap trim like any other served body):
 *
 *   1. if `resolveDominantSurfaceIndex` found a winner that is still
 *      codeless, run the identical single-handle form of the closure read
 *      `runCandidateInlinePass` uses for a live candidate-list — reusing
 *      `executeClosureRead` rather than a second embedding mechanism — so the
 *      promoted primary is genuinely actionable in THIS response, not a
 *      promise that trades the confirmation round trip for an equally costly
 *      fetch.
 *   2. demote every OTHER surface to `required: false` — the same
 *      primary/`required:true` vs. related/`required:false` split
 *      `locateTaskContext.ts`'s `buildMultiPrimaryHit` already draws between
 *      its own `primary`/`related` arrays. Undone, `buildTaskExecutionContract`
 *      (`requiredSurfaces = ...filter(required !== false)`) keeps chasing the
 *      LOSER's body next — the choice is resolved, but the contract cannot
 *      tell that a still-required, still-codeless loser is not blocking
 *      evidence. `result.missing`/`_required_surfaces` are role lists (api,
 *      test, …), never a per-candidate ledger, so this never removes a role
 *      that stays genuinely covered by the promoted primary alone.
 *
 * A no-op on every pack that never had a resolvable candidate-list to begin
 * with (`dominantIndex === -1`): `result` is left untouched, byte-identical
 * to before this fix.
 */
export function applyDominancePromotion(
  result: TaskPackResult,
  surfaces: readonly TaskPackSurface[],
  dominantIndex: number,
  workspace: string,
): void {
  if (dominantIndex === -1) return;
  const winner = surfaces[dominantIndex];
  if (winner === undefined) return;
  if (!hasServedCode(winner)) {
    executeClosureRead(result, { tool: "tl_read_file", arguments: { handle: winner.handle } }, workspace);
  }
  for (const [index, surface] of surfaces.entries()) {
    if (index !== dominantIndex) surface.required = false;
  }
}

/**
 * DESIGN-v0.8 coverage-honesty: map the main locate flow's signals to the
 * three-way coverage + its telemetry reason, in the exact priority order the
 * workstream spec defines. `unmatched` is the pre-computed unmatched-concern
 * token list (computed ONCE by the caller and reused by buildRoute, so the
 * coverage label and the route can never disagree about concern coverage).
 *
 * Precedence (first match wins):
 *   1. missingRequired>0            → partial / "missing-roles"
 *   2. unmatched>0                  → partial / "concerns-uncovered"
 *   3. locate completeness=complete → complete (no reason)
 *   4. completeness=unknown & conf>=0.7 → focused / "single-site"
 *   5. completeness=partial & primary>1 → partial / "candidate-list", UNLESS
 *      one surface strictly dominates the rest on role/evidence/source-ness
 *      (see `resolveDominantSurfaceIndex` above) — a genuinely resolved
 *      "choice" is not an open one, so the reason is dropped and the pack
 *      stays "partial" (not "focused"/"complete": those suppress
 *      `frontier_index`, and the dominated candidate must stay inventoried —
 *      design point 1/4c). `buildRoute` then falls through past its
 *      "candidate-list" branch to the plain partial-coverage route, an
 *      existing, unmodified path.
 *   6. otherwise → partial / (locate said a role is missing ? "missing-roles" : "candidate-list").
 *      A single-primary "candidate-list" is kept on purpose: the generic/edit routes and the write
 *      frontier read it as "not yet confirmed" (eval-0927 review r2 P2-17(a) — a one-candidate
 *      confirmation round trip — is a known residual, not fixed here).
 *

 * `dominantSurfaceIndex` is the caller's OWN precomputed
 * `resolveDominantSurfaceIndex(surfaces)` (-1 by default, for any caller that
 * does not care — rule 5 then behaves exactly as before). It is a parameter
 * rather than a `surfaces` array recomputed in here because the caller needs
 * the SAME index a second time, after `deriveCoverage` returns, to serve the
 * winner's body (`applyDominancePromotion`) — computing it once keeps
 * both call sites agreeing on which surface won by construction.
 */
export function deriveCoverage(
  locate: { completeness: "complete" | "partial" | "unknown"; confidence: number; primaryCount: number; missingSurfaces?: string[] },
  missingRequired: string[],
  unmatched: string[],
  dominantSurfaceIndex = -1,
): { coverage: "complete" | "focused" | "partial"; reason?: TaskPackResult["coverage_reason"]; dominancePromoted?: true } {
  if (missingRequired.length > 0) return { coverage: "partial", reason: "missing-roles" };
  if (unmatched.length > 0) return { coverage: "partial", reason: "concerns-uncovered" };
  if (locate.completeness === "complete") return { coverage: "complete" };
  if (locate.completeness === "unknown" && locate.confidence >= HIGH_CONFIDENCE_THRESHOLD) {
    return { coverage: "focused", reason: "single-site" };
  }
  if (locate.completeness === "partial" && locate.primaryCount > 1) {
    if (dominantSurfaceIndex !== -1) {
      // `dominancePromoted` is the ONE place this fired — the caller relies
      // on it (rather than re-deriving the same precondition) to know it may
      // now call `applyDominancePromotion` for `dominantSurfaceIndex`.
      return { coverage: "partial", reason: undefined, dominancePromoted: true };
    }
    return { coverage: "partial", reason: "candidate-list" };
  }
  return {
    coverage: "partial",
    reason: locate.missingSurfaces !== undefined && locate.missingSurfaces.length > 0
      ? "missing-roles"
      : "candidate-list",
  };
}

/** Max handles listed in a batch `read_code handles=[...]` next hint (mirrors MAX_SURFACES_DISTINCT). */
export const MAX_BATCH_NEXT_HANDLES = 6;

/**
 * Item 3 (wiring `next` that isn't a dead end): for a two-domain WIRING query
 * ("feed A into B", "wire X into Y") whose SECOND domain / consumer is
 * uncovered, return a `next` that points at the DESTINATION side, never a
 * `explore action=find query=<source symbol>`. Finding the source is a
 * structural dead end here: the source symbol DOES exist and is already
 * surfaced — the actual gap is that the consumer that should reference it does
 * not exist yet, so a find for the source lands right back on the surface the
 * pack already returned.
 *
 * Detection (conservative, pack-local — the locator's two-domain signal is not
 * exposed on its output, so this reconstructs the shape from the query + the
 * returned surfaces):
 *   - `concreteIdentifierTokens(query)` (the SAME extraction
 *     buildWiringCooccurrenceCheck uses) must yield >= 2 concrete identifier
 *     tokens, EXCLUDING any enum new-value token (extractEnumValueTokens) — a
 *     brand-new enum member never maps to a surface and must not masquerade as
 *     an uncovered "destination".
 *   - the SOURCE (earliest such token) maps to a surface (surfaceIndexForToken)
 *     but the DEST (a later such token) does NOT map to any surface, i.e. the
 *     consumer is genuinely absent (the missing wire IS the task).
 *
 * Preference order (per the spec): (a) `explore action=references
 * symbol=<dest>` when a concrete dest token exists; (b) `explore action=find
 * query=<second domain's strongest distinct token>` (the first unmatched
 * concern token) when there is a distinct second-domain word but no clean
 * concrete dest identifier; (c) undefined → caller falls through to its
 * existing surfaceRoles re-pack branch (the last resort). Returns undefined
 * whenever the shape is NOT a two-domain wiring dead end, so every non-wiring
 * partial keeps nextHintForCoverage's existing branches untouched.
 */
export function wiringConsumerNext(query: string, surfaces: TaskPackSurface[]): ContinuationCall | undefined {
  if (surfaces.length === 0) return undefined;
  const valueTokens = new Set(extractEnumValueTokens(query).map((t) => normIdent(t)));
  // Concrete identifier tokens in query order, minus enum new-value tokens.
  const tokens = concreteIdentifierTokens(query).filter((t) => !valueTokens.has(normIdent(t)));
  if (tokens.length < 2) return undefined;

  // A token is COVERED when it maps to a surface's basename/symbol OR appears in
  // an already-embedded surface `code` block. The `code` check is what stops a
  // false wiring dead end for an enum+aggregation query: a token like
  // "byTicket" is a FUNCTION inside an already-surfaced aggregation-service file (so
  // its basename does not name it), but the surface's embedded code does — the
  // consumer plainly exists and this is not a missing wire.
  const covered = (tok: string): boolean => {
    if (surfaceIndexForToken(tok, surfaces) !== -1) return true;
    const nt = normIdent(tok);
    return surfaces.some((s) => s.code !== undefined && normIdent(s.code).includes(nt));
  };

  const source = tokens[0]!;
  // A dest-side token is any LATER concrete token that is a genuinely different
  // identifier from the source. Pick the latest such token as the destination
  // (directionality: mentioned later = the thing being wired INTO).
  let dest: string | undefined;
  for (let i = tokens.length - 1; i >= 1; i--) {
    if (normIdent(tokens[i]!) !== normIdent(source)) { dest = tokens[i]; break; }
  }
  if (dest === undefined) return undefined;

  // The two-domain DEAD END: the destination/consumer is genuinely uncovered
  // (no surface names it AND no surface's embedded code contains it). When the
  // consumer already exists among the surfaces there is no dead end — leave
  // `next` to the normal branches.
  if (covered(dest)) return undefined;
  // Require the source to be a real, located domain — otherwise this is not a
  // "source exists, consumer missing" wiring at all; (b) handles the
  // fully-unlocated case below.
  if (covered(source)) {
    // (a) references sweep on the destination-side token: find where the
    // consumer that should receive the wire lives / is referenced.
    return { tool: "tl_search_files", arguments: { action: "references", query: dest } };
  }
  // (b) neither end located cleanly: point at the second domain's strongest
  // distinct token (the first query concern with no surface match).
  const unmatched = unmatchedConcernTokens(query, surfaces);
  if (unmatched.length > 0) return { tool: "tl_search_files", arguments: { action: "find", query: unmatched[0] } };
  return undefined;
}

/**
 * DESIGN-v0.8 coverage-honesty (Part 3): the single most turn-efficient `next`
 * hint for this pack's coverage state — teaches the agent the exact follow-up
 * that closes the remaining gap in ONE call, rather than a generic single
 * slice. Returns undefined only when there is no surface to point at (caller
 * keeps its own fallback).
 *
 *   - complete/focused: if ≥2 surfaces still lack embedded code, hand back a
 *     BATCH read of every code-less surface handle (the server accepts a
 *     top-level `handles:[...]` array regardless of mode; `next` strings are
 *     how an agent learns this un-advertised affordance). Else if the primary
 *     surface already carries its code, point straight at editing it. Else
 *     fall back to a single slice of the primary.
 *   - candidate-list: batch ranked candidate handles; slice only when one remains.
 *   - missing-roles: re-locate for exactly the missing roles via surfaceRoles.
 *   - concerns-uncovered: an `explore action=find` on the ONE top unmatched
 *     token (find rejects multi-token sentences, so only the first is used).
 */
/**
 * The task query as it may appear inside a `next` hint: LOSSLESS.
 *
 * Every `next` string is contractually EXECUTABLE — AGENTS.md tells the agent
 * to run it verbatim — so whatever query it carries BECOMES the next task
 * query. Five builders used to embed `query.slice(0, 60)` / `.slice(0, 80)`,
 * which cuts mid-word and silently drops the intent-bearing tail: the caller
 * then re-packs a DIFFERENT, truncated task and the original request is
 * unrecoverable. session.ts's own continuation builder already states the
 * rule this restores — "Verbatim, never an excerpt: this call must be
 * EXECUTABLE, and a truncated query is a different task."
 *
 * Two normalizations, neither of which drops a word:
 *   - whitespace collapses to single spaces (a `next` is one line, and a
 *     multi-line query would otherwise break the string it lives in);
 *   - `"` is stripped, the same scrub the sibling `fallbackQuery` already
 *     applies, because the surrounding `query="..."` encoding has no escape
 *     and `nextStringToCall` performs no unescaping.
 *
 * Deliberately NOT a `qref` hint, though the protocol prefers one: the four
 * shapes above must stay parseable by `nextStringToCall`, whose grammar has
 * no `qref` form, and `buildTaskExecutionContract` feeds the PARSED call into
 * `next_call` — the field the wire decision actually projects. Emitting an
 * unparseable qref form would delete the hint from the decision instead of
 * improving it. (The rootSuggestion re-scope hint additionally CANNOT use a
 * qref: a qref is bound to the workspace root it was minted under, and that
 * hint's whole point is moving to a different one.)
 */
// Exported for queryContinuity.spec.ts — the losslessness property is easier
// to pin directly than through the five packs that reach the five call sites.
export function continuationQuery(query: string): string {
  return query.replace(/\s+/gu, " ").replace(/"/g, "").trim();
}

export function nextHintForCoverage(
  surfaces: TaskPackSurface[],
  coverage: "complete" | "focused" | "partial",
  reason: TaskPackResult["coverage_reason"] | undefined,
  query: string,
  missingRoles: string[],
  unmatchedTokens: string[],
): ContinuationCall | undefined {
  const primary = surfaces[0];
  if (!primary) return undefined;

  if (coverage === "complete" || coverage === "focused") {
    // code_unchanged surfaces are excluded: their content is already known
    // from the prior pack, so batching them into a re-read wastes the call.
    const codeless = surfaces
      .filter((s) => s.code === undefined && s.code_unchanged === undefined)
      .map((s) => s.handle);
    if (codeless.length >= 2) {
      return { tool: "tl_read_file", arguments: { handles: codeless.slice(0, MAX_BATCH_NEXT_HANDLES) } };
    }
    if (primary.code !== undefined) return undefined;
    return { tool: "tl_read_file", arguments: { mode: "slice", handle: primary.handle } };
  }

  if (reason === "candidate-list") {
    // 2026-07-19a: only CODELESS candidates justify a follow-up read — the old
    // unconditional batch re-read of every candidate handle kept pointing at
    // bodies the pack itself already served, refuelling the full/slice thrash
    // it was meant to close. With nothing codeless left, choosing IS the next
    // act, so there is no `next` at all (the execution contract lands on
    // choose-candidate / awaiting-input instead).
    const codeless = [...new Set(
      surfaces
        .filter((surface) => surface.code === undefined && surface.code_unchanged === undefined)
        .map((surface) => surface.handle),
    )].slice(0, MAX_BATCH_NEXT_HANDLES);
    if (codeless.length > 1) {
      return { tool: "tl_read_file", arguments: { handles: codeless } };
    }
    if (codeless.length === 1) {
      return { tool: "tl_read_file", arguments: { mode: "slice", handle: codeless[0] } };
    }
    // B1c (2026-08-01 retrieval-scope): with every candidate body served the
    // choice IS the next act, so there is still no `next` here — the EXECUTABLE
    // recovery for a candidate list whose query named files it could not serve
    // is attached at the shared exit instead (attachCandidateListRecovery),
    // where the workspace is in scope.
    return undefined;
  }

  // Item 1 (named next when the style file was not found): a still-missing
  // "style" role gets a CONCRETE `explore find <derived token stem>` (the CSS
  // custom-property / member stem) — never a bare "locate the style role"
  // re-pack. Only when augmentStyleSurface could NOT name a stylesheet
  // (styleNextForMissingRole is a no-op once a style surface exists).
  if (reason === "missing-roles" && missingRoles.includes("style")) {
    const styleNext = styleNextForMissingRole(query, surfaces);
    if (styleNext) return styleNext;
  }

  // Item 3 (wiring `next` that isn't a dead end): a two-domain wiring query
  // whose consumer is uncovered gets a destination-side hint (references the
  // dest token / finds the second domain's distinct token) INSTEAD of the
  // dead-end `explore action=find <source>` a concerns-uncovered / missing-role
  // partial would otherwise emit. Fires only for that specific shape (see
  // wiringConsumerNext); every other partial falls through to the existing
  // branches below unchanged (which are, for missing-roles, the surfaceRoles
  // re-pack that is item 3's own last-resort option (c)).
  const wiringNext = wiringConsumerNext(query, surfaces);
  if (wiringNext) return wiringNext;

  if (reason === "missing-roles" && missingRoles.length > 0) {
    return {
      tool: "tl_read_file",
      arguments: { mode: "task_pack", query, surfaceRoles: missingRoles },
    };
  }
  if (reason === "concerns-uncovered" && unmatchedTokens.length > 0) {
    return { tool: "tl_search_files", arguments: { action: "find", query: unmatchedTokens[0] } };
  }

  // Any other partial (e.g. diff-truncated) keeps a single-slice fallback — but
  // ONLY when that slice can still deliver bytes the caller does not already
  // hold. Re-slicing a fully-served primary is a no-op read, and it was the
  // fuel for exactly the full/slice thrash the two branches above each closed
  // on their own side (complete/focused checks `primary.code !== undefined`;
  // candidate-list went codeless-only in 2026-07-19a). This catch-all had been
  // left behind, so a pack that served every byte of surfaces[0] still told the
  // caller to read it again — observed live 2026-07-31 on a 32-line
  // package.json whose whole body was embedded in the same response. With no
  // progressing read left, returning undefined is the honest answer: it lets
  // the execution contract land on prepared / awaiting-input instead of naming
  // a call that cannot advance discovery.
  const remainingWindow = primary.remaining_ranges?.[0];
  if (remainingWindow) {
    return { tool: "tl_read_file", arguments: { mode: "slice", handle: primary.handle, range: remainingWindow } };
  }
  if (primary.code === undefined && primary.code_unchanged === undefined) {
    return { tool: "tl_read_file", arguments: { mode: "slice", handle: primary.handle } };
  }
  return undefined;
}
