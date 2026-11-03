// literalAndConcernSeeds — extracted implementation; imports point to the owning modules.
import type { ContinuationCall } from "./packBasics.js";
import type { LiteralFirstMeasurement } from "./literalAndConcernSeeds.js";
import type { LiteralSourceWitness } from "./literalAndConcernSeeds.js";
import type { PropagationSeedHit } from "./literalAndConcernSeeds.js";
import type { PropagationSeedResolution } from "./literalAndConcernSeeds.js";
import type { TaskPackArgs } from "../model.js";
import type { TaskPackResult } from "../model.js";
import { MAX_SURFACES_DISTINCT } from "./packBasics2.js";
import { classifySurface } from "../../../util/impact.js";
import { codeTaskPackSurfaces } from "../artifactSections.js";
import { concernAnchorTokens } from "./roleAndConcernScope3.js";
import { concreteIdentifierTokens } from "./createAndWiringEndpoints2.js";
import { definitionVsDerivedAdjustment } from "./partialPackBuilder.js";
import { extractEnumValueTokens } from "./createAndWiringEndpoints2.js";
import { hasExecutedNext } from "../../../util/packServeLog.js";
import { hasExplicitConcernList } from "./roleAndConcernScope2.js";
import { hasIdentifierSegment } from "./literalAndConcernSeeds.js";
import { hasServedCode } from "./wiringEvidence2.js";
import { inferQueryProjectScope } from "../../locator/locateTaskContext.js";
import { isEnumLikeQuery } from "../../../util/queryShape.js";
import { isEnumLikeQueryShaped } from "./roleAndConcernScope2.js";
import { isTestConcernPath } from "./literalAndConcernSeeds.js";
import { literalConcernCandidates } from "./literalAndConcernSeeds.js";
import { literalFirstMeasurement } from "./literalAndConcernSeeds.js";
import { literalFirstRoutingEnabled } from "../../../util/flags.js";
import { literalSourceRarityLimit } from "./packBasics2.js";
import { normIdent } from "./createAndWiringEndpoints2.js";
import { normalizeContractLane } from "../../../util/packServeLog.js";
import { normalizePathEntry } from "./packBasics2.js";
import { normalizedRequestPath } from "./guideAndArtifactSurfaces.js";
import { orderedUniqueTokens } from "./roleAndConcernScope2.js";
import { propagationFacetGroups } from "./roleAndConcernScope3.js";
import { resolveQualifiedSymbolAnchors } from "./wiringEvidence3.js";
import { roleInventoryFor } from "./roleAndConcernScope.js";
import { scanLiteral } from "../../search/find/findText.js";
import { walkCodeFiles } from "../../../tools/walkRepo.js";

export async function propagationSeedResolution(
  args: TaskPackArgs,
  query: string,
  workspace: string,
): Promise<PropagationSeedResolution> {
  const newValues = new Set(extractEnumValueTokens(query).map(normIdent));
  // An explicit path remains a hard scope. Without one, exact identifier
  // matches are safe to follow across package roots: cross-layer propagation
  // commonly spans shared contracts, services, and frontends in a monorepo.
  const explicitScope = args.path
    ? normalizedRequestPath(args.path).replace(/\/$/, "")
    : undefined;
  const explicitPathUnion = (args.paths ?? []).map(normalizePathEntry).map((entry) => entry.path);
  const literalScopes = explicitPathUnion.length > 0
    ? explicitPathUnion
    : explicitScope
      ? [explicitScope]
      : undefined;
  const literalFirst = literalFirstRoutingEnabled()
    ? literalFirstMeasurement(args, query, workspace, literalScopes)
    : undefined;
  // Grammar-assigned literal sources must not be erased by the legacy
  // destination/enum shape filter (for example MAX_SIZE during a rename).
  // Literal-first is precision routing. A broad source token is not a safe
  // seed merely because it is present; leave the normal locator to abstain
  // rather than turning 60 noise files into six arbitrary edits.
  if (
    literalFirst?.kind === "present"
    && (
      literalFirst.sourcePaths > literalSourceRarityLimit(literalFirst.universePaths)
      || literalFirst.sourceImplementationPaths === 0
      || literalFirst.sourceRootCount !== 1
    )
  ) {
    return { paths: [], literal: literalFirst };
  }
  const identifiers = literalFirst !== undefined
    ? literalFirst.seedTokens.slice(0, 6)
    : orderedUniqueTokens([
        ...(args.symbol ? [args.symbol] : []),
        ...concreteIdentifierTokens(query),
      ])
        .filter((token) => token.length >= 4 && !newValues.has(normIdent(token)))
        .slice(0, 6);
  if (identifiers.length === 0) {
    return { paths: [], ...(literalFirst !== undefined ? { literal: literalFirst } : {}) };
  }
  // Reuse the find-equivalent universe for literal seeds as well as the
  // measurement. Otherwise a manifest can be measured but silently dropped
  // by the later legacy code-only scan.
  const literalSeedFiles = literalFirst?.universe.files;
  const byPath = new Map<string, PropagationSeedHit>();

  for (const token of identifiers) {
    for (const match of scanLiteral(token, workspace, {
      caseInsensitive: true,
      ...(literalSeedFiles ? { files: literalSeedFiles } : {}),
    })) {
      if (
        explicitScope
        && match.path !== explicitScope
        && !match.path.startsWith(explicitScope + "/")
      ) {
        continue;
      }
      if (!hasIdentifierSegment(match.text ?? "", token)) continue;
      const current = byPath.get(match.path) ?? {
        path: match.path,
        line: match.line,
        role: classifySurface(match.path),
        tokens: new Set<string>(),
        definitionScore: -1,
      };
      current.tokens.add(token);
      const adjustment = definitionVsDerivedAdjustment(workspace, match.path, match.line);
      if (
        adjustment > current.definitionScore
        || (adjustment === current.definitionScore && match.line < current.line)
      ) {
        current.line = match.line;
        current.definitionScore = adjustment;
      }
      byPath.set(match.path, current);
    }
  }

  const roleOrder = new Map(
    ["contract", "api", "domain", "data", "ui", "style", "config", "test", "doc", "unknown"]
      .map((role, index) => [role, index]),
  );
  // D5 (2026-09-02): resolve a `Class::method` anchor as a UNIT before the flat
  // tokens rank anything. Without it the last tie-break was
  // `path.localeCompare`, so two sibling headers that merely DECLARE a bare
  // same-named member outranked the class the caller actually named.
  const qualifiedAnchors = resolveQualifiedSymbolAnchors(query, workspace);
  const qualifiedAnchorRank = (candidatePath: string): number =>
    qualifiedAnchors.definitions.includes(candidatePath)
      ? 0
      : qualifiedAnchors.counterparts.includes(candidatePath)
        ? 1
        : qualifiedAnchors.declarations.includes(candidatePath)
          ? 2
          : 3;
  const ranked = [...byPath.values()].sort((a, b) => {
    const tokenDelta = b.tokens.size - a.tokens.size;
    if (tokenDelta !== 0) return tokenDelta;
    const definitionDelta = b.definitionScore - a.definitionScore;
    if (definitionDelta !== 0) return definitionDelta;
    const testDelta = Number(isTestConcernPath(a.path)) - Number(isTestConcernPath(b.path));
    if (testDelta !== 0) return testDelta;
    const roleDelta = (roleOrder.get(a.role) ?? 99) - (roleOrder.get(b.role) ?? 99);
    if (roleDelta !== 0) return roleDelta;
    // (a) the file that DEFINES the anchored member, then (b) a declaring
    // header's implementation counterpart, then the declaring header itself —
    // all before the alphabetical fallback below.
    const anchorDelta = qualifiedAnchorRank(a.path) - qualifiedAnchorRank(b.path);
    if (anchorDelta !== 0) return anchorDelta;
    return a.line - b.line || a.path.localeCompare(b.path);
  });

  // Reuse this bounded discovery pool; auxiliary delivery never starts a walk
  // or changes which six primary paths the ordinary planner admits.
  const propagationScope = args.path ?? inferQueryProjectScope(workspace, query) ?? null;
  const auxiliaryScopes = (explicitPathUnion.length > 0 ? explicitPathUnion
    : propagationScope === null ? [] : [propagationScope])
    .map(scope => normalizedRequestPath(scope).replace(/\/$/, ""))
    .filter(scope => scope !== "" && scope !== ".");
  const auxiliaryCandidates = isEnumLikeQuery(query)
    ? ranked.filter(hit => auxiliaryScopes.length === 0
        || auxiliaryScopes.some(scope => hit.path === scope || hit.path.startsWith(scope + "/")))
      .slice(0, 24).map((hit, rank) => ({path: hit.path, rank}))
    : undefined;
  const selected: PropagationSeedHit[] = [];
  const selectedPaths = new Set<string>();
  // Cross-package enum fan-out with a real stylesheet needs one compact style
  // surface plus enough wire budget for the prepared contract. Keep the code
  // frontier to four edit sites; delegation-only route/review candidates are
  // lower value than the style family that the UI mapping actually names.
  const maxSeedPaths = isEnumLikeQueryShaped(query)
    && roleInventoryFor(workspace, propagationScope).has("style")
    ? MAX_SURFACES_DISTINCT - 2
    : MAX_SURFACES_DISTINCT;
  const add = (hit: PropagationSeedHit | undefined): void => {
    if (!hit || selectedPaths.has(hit.path) || selected.length >= maxSeedPaths) return;
    selected.push(hit);
    selectedPaths.add(hit.path);
  };

  // D5: an explicitly qualified `Class::method` is the most precise anchor a
  // caller can type, and it names exactly ONE definition site. Claim its seed
  // slot before any cap-bounded fill can shed it — the SF13 failure was the
  // definition file never reaching the frontier NOR the disclosure list.
  for (const definitionPath of qualifiedAnchors.definitions) {
    add(ranked.find((hit) => hit.path === definitionPath) ?? {
      path: definitionPath,
      line: qualifiedAnchors.lines.get(definitionPath) ?? 1,
      role: classifySurface(definitionPath),
      tokens: new Set<string>(),
      definitionScore: 0,
    });
  }

  // A directed source is a hard anchor, not merely one weighted identifier
  // among documentation and destination matches.  Keep only implementation
  // witnesses here: README, fixtures, and tests can enrich the ordinary
  // frontier later, but never stand in for the change-owning source.
  if (literalFirst?.kind === "present") {
    const anchorPriority = (path: string): number => {
      if (/\.(?:[cm]?[jt]sx?|vue|svelte|py|go|rs|java|rb|php|cs|cpp?|h)$/iu.test(path)) return 0;
      if (/(?:^|\/)(?:package|tsconfig|vite|webpack|eslint|prettier)\.[^/]+$/iu.test(path)) return 1;
      return 2;
    };
    for (const witness of [...literalFirst.sourceWitnesses].sort((a, b) =>
      anchorPriority(a.path) - anchorPriority(b.path) || a.path.localeCompare(b.path) || a.line - b.line,
    )) {
      if (witness.implementation) add(ranked.find((hit) => hit.path === witness.path));
    }
  }

  // Enum members usually co-locate in one definition. Spend one slot on that
  // definition rather than allowing every old member to select a different
  // downstream consumer. Explicit compound identifiers (for example a named
  // component or service) remain independently required.
  const enumIdentifiers = identifiers.filter((token) => /^[A-Z][A-Z0-9_]{2,}$/.test(token));
  if (enumIdentifiers.length > 0) {
    add(ranked
      .filter((hit) => enumIdentifiers.some((token) => hit.tokens.has(token)))
      .sort((a, b) => b.definitionScore - a.definitionScore || ranked.indexOf(a) - ranked.indexOf(b))[0]);
  }
  const compoundIdentifiers = identifiers
    .filter((token) => !enumIdentifiers.includes(token) && /[a-z][A-Z]/.test(token))
    .sort((a, b) => b.length - a.length);
  for (const token of compoundIdentifiers) add(ranked.find((hit) => hit.tokens.has(token)));
  if (hasExplicitConcernList(query)) {
    const hardScopes = (args.paths ?? []).map(normalizePathEntry).map((entry) => entry.path);
    const scopedFiles = new Set(
      (hardScopes.length > 0
        ? hardScopes.flatMap((scope) => walkCodeFiles(workspace, { subPath: scope }))
        : walkCodeFiles(workspace, explicitScope ? { subPath: explicitScope } : {}))
        .map((file) => file.relPath),
    );
    for (const group of propagationFacetGroups(query)) {
      const candidates = await literalConcernCandidates(workspace, group, scopedFiles);
      const candidate = candidates[0];
      if (!candidate) continue;
      add({
        path: candidate.path,
        line: candidate.line,
        role: candidate.surface as string,
        tokens: new Set(group.tokens),
        definitionScore: 0,
      });
      const spansCreateValidation = (/\bcreat(?:e|es|ed|ing)\b/i.test(group.query) || group.query.includes("作成"))
        && (/\b(?:validation|validate|validator|schema)\b/i.test(group.query) || /バリデーション|検証/.test(group.query));
      const requestAlsoNeedsAggregation = /\b(?:stats?|statistics|aggregate|aggregation|counts?|summary)\b/i.test(query)
        || /統計|集計|件数/.test(query);
      if (spansCreateValidation && maxSeedPaths === MAX_SURFACES_DISTINCT && !requestAlsoNeedsAggregation) {
        const boundary = candidates.find((entry) => entry.path !== candidate.path);
        if (boundary) {
          add({
            path: boundary.path,
            line: boundary.line,
            role: boundary.surface as string,
            tokens: new Set(group.tokens),
            definitionScore: 0,
          });
        }
      }
    }
    const aggregationPattern = /\b(?:stats?|statistics|aggregate|aggregation|counts?|summary)\b/i;
    const aggregationJapanesePattern = /統計|集計|件数/;
    const aggregationClause = query
      .replace(/\r/g, "\n")
      .split(/[。；;\n]+/)
      .map((clause) => clause.replace(/^\s*(?:[-*]|\d+[.)]|[①②③④⑤⑥⑦⑧⑨⑩])\s*/, "").trim())
      .find((clause) => aggregationPattern.test(clause) || aggregationJapanesePattern.test(clause));
    // The bounded facet list can be filled by earlier bullets. Recover an
    // explicitly requested aggregate directly from its clause so a trailing
    // statistics sentence cannot be dropped merely because it was unbulleted.
    const aggregationGroup = aggregationClause
      ? { query: aggregationClause, tokens: concernAnchorTokens(aggregationClause) }
      : propagationFacetGroups(query).find((group) =>
          aggregationPattern.test(group.query) || aggregationJapanesePattern.test(group.query)
        );
    if (aggregationGroup && aggregationGroup.tokens.length > 0) {
      const candidates = await literalConcernCandidates(workspace, aggregationGroup, scopedFiles);
      const aggregate = candidates[0];
      if (aggregate && !selectedPaths.has(aggregate.path)) {
        // Preserve an explicitly requested aggregate over a same-role
        // delegation boundary selected earlier (for example a route that only
        // forwards into a schema). The aggregate owns state that must actually
        // change, while the forwarding surface is review-only.
        if (selected.length >= maxSeedPaths) {
          const removed = selected.pop();
          if (removed) selectedPaths.delete(removed.path);
        }
        add({
          path: aggregate.path,
          line: aggregate.line,
          role: aggregate.surface as string,
          tokens: new Set(aggregationGroup.tokens),
          definitionScore: 0,
        });
      }
    }
    if (selected.length >= 2) {
      return { paths: selected.map((hit) => hit.path), auxiliaryCandidates, auxiliaryScopes, ...(literalFirst !== undefined ? { literal: literalFirst } : {}) };
    }
  }
  for (const token of identifiers) add(ranked.find((hit) => hit.tokens.has(token)));
  for (const role of roleOrder.keys()) {
    if (!selected.some((hit) => hit.role === role)) add(ranked.find((hit) => hit.role === role));
  }
  for (const hit of ranked) add(hit);

  const minimumPaths = literalFirst?.kind === "present" ? 1 : 2;
  return {
    paths: selected.length >= minimumPaths ? selected.map((hit) => hit.path) : [],
    auxiliaryCandidates,
    auxiliaryScopes,
    ...(literalFirst !== undefined ? { literal: literalFirst } : {}),
  };
}

export async function propagationSeedPaths(
  args: TaskPackArgs,
  query: string,
  workspace: string,
): Promise<string[]> {
  return (await propagationSeedResolution(args, query, workspace)).paths;
}

/**
 * A partial universe or an already-present destination is not a failed rename;
 * it is an unproved discovery state. Keep it in protocol-v1 `discover` space
 * with an executable find continuation instead of minting a fast edit from a
 * lexical witness.
 */
export function literalFirstRemainingCall(
  literal: LiteralFirstMeasurement,
  selectedPaths: readonly string[],
): { call?: ContinuationCall; remaining: readonly LiteralSourceWitness[] } {
  const selected = new Set(selectedPaths);
  const remaining = literal.sourceWitnesses.filter((witness) => !selected.has(witness.path));
  return {
    remaining,
    ...(remaining.length > 0 ? {
      call: {
        tool: "tl_read_file" as const,
        arguments: {
          targets: remaining.map((witness) => ({ path: witness.path, range: `${witness.line}-${witness.line}` })),
        },
      },
    } : {}),
  };
}

/**
 * A directed `everywhere` request has a stronger proof than the generic
 * one-hop dependency expansion: an ordinary-find scan has already enumerated
 * the entire source universe, and every exact source witness is resident in
 * this pack.  This predicate is intentionally stricter than route selection;
 * it is used only to write a normal ledger proof, never to force a decision.
 */
export function literalSourceUniverseProved(
  result: TaskPackResult,
  literal: LiteralFirstMeasurement | undefined,
  context?: { workspace: string; args: TaskPackArgs },
): boolean {
  if (
    literal?.kind !== "present"
    || !literal.universeComplete
    || literal.destinationCollision
    || literal.sourceRootCount !== 1
    || literal.sourceImplementationPaths === 0
    || literal.sourcePaths > literalSourceRarityLimit(literal.universePaths)
  ) return false;
  const servedPaths = new Set(codeTaskPackSurfaces(result.surfaces)
    .filter(hasServedCode)
    .map((surface) => surface.path));
  const remainingCall = literalFirstRemainingCall(literal, [...servedPaths]).call;
  if (remainingCall === undefined) return true;
  // The source witness outside this capped pack was supplied by the exact
  // continuation. Its authenticated ledger record is the proof, rather than a
  // generic re-pack or an untyped occurrence flag.
  return context !== undefined && hasExecutedNext(
    context.workspace,
    normalizeContractLane(context.args.lane),
    remainingCall.tool,
    remainingCall.arguments as Record<string, unknown>,
    context.args.taskBinding,
  );
}
