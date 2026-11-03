// unresolvedCalls — extracted implementation; imports point to the owning modules.
import type { ContinuationCall } from "./packBasics.js";
import type { TaskPackResult } from "../model.js";
import type { TaskReadinessObligation } from "@tokenlighten/types";
import { ASKED_PATH_OBLIGATION_PREFIX } from "../askedPathClosure.js";
import { ENUMERATED_ITEM_OBLIGATION_PREFIX } from "./changeAndReadinessEvidence2.js";
import { FileReadCache } from "./packBasics2.js";
import { MAX_UNDECLARED_IDENTIFIER_MATCHES } from "./unresolvedCalls.js";
import { REQUEST_ITEM_OBLIGATION_PREFIX } from "./recursiveClosure5.js";
import { anchorDefinitionGap } from "./unresolvedCalls3.js";
import { boundedCallerWindow } from "../callerExpansion.js";
import { cachedRequestItemPass } from "./requestItemAbsence2.js";
import { classifySurface } from "../../../util/impact.js";
import { codeTaskPackSurfaces } from "../artifactSections.js";
import { countLines } from "../../../util/countLines.js";
import { currentAskedPathPlan } from "./facetClosure2.js";
import { declarationLineRegex } from "./sourceAndConcernTerms.js";
import { enumeratedItemFindCall } from "./unresolvedCalls.js";
import { escapeRegExp } from "../../search/find/findText.js";
import { explicitCodeIdentifiers } from "./anchorFocus2.js";
import { hasServedCode } from "./wiringEvidence2.js";
import { isArtifactTaskPackSurface } from "../artifactSections.js";
import { isTestConcernPath } from "./literalAndConcernSeeds.js";
import { isWiringIdentifierShape } from "./createAndWiringEndpoints2.js";
import { moduleShapedQueryTokens } from "./queryIntent4.js";
import { qualifiedSymbolAnchors } from "./wiringEvidence3.js";
import { queryMentionsTests } from "../callerExpansion.js";
import { readCached } from "./packBasics2.js";
import { resolveQualifiedSymbolAnchors } from "./wiringEvidence3.js";
import { sameNameDeclarationReadCall } from "./sameNameSubjects.js";
import { sameNameSubjectsFor } from "./sameNameSubjects.js";
import { scanLiteral } from "../../search/find/findText.js";
import { servedLineSpansOf } from "./sourceAndConcernTerms.js";
import { servedRangeCoverage } from "../../../state/session.js";
import { shaOfText } from "../../../util/handles.js";
import { stripPathSpans } from "../../../util/queryShape.js";
import { tokenizeForEpoch } from "../../../state/session.js";
import { undeclaredIdentifierReadMemo } from "./unresolvedCalls.js";
import { unshownCallableBodiesByResult } from "./changeAndReadinessEvidence2.js";
import { wholeIdentifierOnHitLine } from "./identifierAbsence2.js";

/**
 * FIX-G G3 — the recovery read for an uncovered `identifier:<X>` that NO file
 * declares (an env-var key, a property, a string key): a bounded ranged read of
 * the window around X's best literal occurrence, over the pack's already-walked
 * universe (`cachedRequestItemPass`, memoized per pack build — no new walk).
 * "Best" = a code position (not a comment line) in a non-doc file, outside test
 * files unless the request mentions tests, not already served. `undefined`
 * whenever X IS declared somewhere (a `const`/`function`/`class`/`def`/… line,
 * a column-anchored `X = …` assignment, a `#define X`) — the symbol lookup is
 * then the right call and is kept — or when nothing qualifies (a verified
 * absence is other machinery's job). Language-independent: pure line text.
 */
export function undeclaredIdentifierReadCall(
  result: TaskPackResult,
  identifier: string,
  query: string,
  workspace: string,
): ContinuationCall | undefined {
  let memo = undeclaredIdentifierReadMemo.get(result);
  if (memo === undefined) {
    memo = new Map();
    undeclaredIdentifierReadMemo.set(result, memo);
  }
  const key = `${identifier}\u0000${query}`;
  if (memo.has(key)) return memo.get(key) ?? undefined;
  const call = computeUndeclaredIdentifierReadCall(result, identifier, query, workspace);
  memo.set(key, call ?? null);
  return call;
}

export function computeUndeclaredIdentifierReadCall(
  result: TaskPackResult,
  identifier: string,
  query: string,
  workspace: string,
): ContinuationCall | undefined {
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(identifier)) return undefined;
  const pass = cachedRequestItemPass(workspace, result);
  if (pass === undefined) return undefined;
  let matches: ReturnType<typeof scanLiteral>;
  try {
    matches = scanLiteral(identifier, workspace, { files: pass.universe.files, contentCache: pass.contentCache });
  } catch {
    return undefined;
  }
  // WP-N (eval-0929 §8): a line holding the name only inside a longer
  // identifier (`MAX_X_V2`, `APP_MAX_X`) is not a mention site of `MAX_X` — it
  // was read as one, so the recovery read prose that never names the
  // identifier (measured: two docs saying only `MAX_X_V2`, and the seeded
  // re-pack that served them certified `MAX_X`), and a `MAX_X_V2 = …` line
  // counted as `MAX_X`'s declaration. Whole occurrences only.
  const lineCache = new FileReadCache();
  matches = matches.filter((match) => wholeIdentifierOnHitLine(workspace, match, identifier, lineCache) !== undefined);
  const bounded = matches.slice(0, MAX_UNDECLARED_IDENTIFIER_MATCHES);
  if (bounded.length === 0) return undefined;
  const escaped = escapeRegExp(identifier);
  const declarationShapes = [
    declarationLineRegex(identifier),
    new RegExp(`^\\s*${escaped}\\s*(?::[^=]*)?=(?!=)`, "u"),
    new RegExp(`^\\s*#\\s*define\\s+${escaped}\\b`, "u"),
  ];
  if (bounded.some((match) => match.text !== undefined && declarationShapes.some((re) => re.test(match.text!)))) return undefined;
  const allowTests = queryMentionsTests(query);
  const surfaces = codeTaskPackSurfaces(result.surfaces).filter(hasServedCode);
  for (const match of bounded) {
    if (classifySurface(match.path) === "doc") continue;
    if (!allowTests && isTestConcernPath(match.path)) continue;
    const trimmed = (match.text ?? "").trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("#") || trimmed.startsWith("*") || trimmed.startsWith("/*")) continue;
    const served = servedLineSpansOf(surfaces.filter((surface) => surface.path === match.path));
    if (served.some((span) => span.start <= match.line && match.line <= span.end)) continue;
    const content = readCached(workspace, match.path);
    if (content === undefined) continue;
    // WP-M (2026-09-29, eval-0929 "non-terminating chains") — `surfaces`
    // above is only THIS call's own freshly-served evidence (`result.surfaces`
    // starts empty on every re-entry into the task and is populated solely by
    // whatever THIS invocation happened to (re-)serve). A candidate this
    // server served two hops ago, under a DIFFERENT tl_read_file call of the
    // SAME task, is invisible to that check, so a match already delivered
    // read as "unserved" again the next time this producer ran — confirmed
    // live: two mention-only candidates for an undeclared identifier
    // (docs/incident-2026-08.md, docs/ops-notes.md) that neither declares,
    // alternately proposed forever, the two-hop `discover` cycle this fix
    // closes. The task's own served-range ledger (state/session.ts) is the
    // authority for "does the CALLER already hold these bytes", judged at
    // the file's CURRENT sha exactly like `epochServedEvidence`'s
    // `reconstructServedEntryEvidence` (this file, below) already judges it
    // for the request-item engine: `servedRangeCoverage` reports "no claim"
    // on a sha mismatch, so a range served at a stale revision correctly
    // counts as unserved rather than masking a real edit.
    const totalLines = countLines(content);
    const ledgerCoverage = servedRangeCoverage(workspace, match.path, shaOfText(content), totalLines);
    if (ledgerCoverage?.served.some(([start, end]) => start <= match.line && match.line <= end) === true) continue;
    const window = boundedCallerWindow(match.line, totalLines);
    return {
      tool: "tl_read_file",
      arguments: { query, targets: [{ path: match.path, range: `${window.start}-${window.end}` }], content: "auto" },
    };
  }
  return undefined;
}

export function nextCallForUnresolved(
  result: TaskPackResult,
  obligations: readonly TaskReadinessObligation[],
  query: string,
  workspace?: string,
): ContinuationCall | undefined {
  const unresolved = obligations.find((obligation) => obligation.status === "uncovered");
  if (!unresolved) return undefined;
  // DESIGN-v0.15 R1: ahead of every other branch, same reasoning as the
  // enumerated-item case just below — `buildRequestItemReadiness` already
  // computed the single BATCHED call covering every still-uncovered request
  // item (contract §3.4), so the generic "first uncovered obligation"
  // single-token fallbacks below must not re-derive a narrower one.
  if (unresolved.id.startsWith(REQUEST_ITEM_OBLIGATION_PREFIX)) {
    return result.request_item_gap?.next_call;
  }
  // Ahead of the generic branches below: an enumerated item names its own
  // search term, so the shared "first uncovered obligation" fallbacks would
  // otherwise emit a symbols/references sweep over an unrelated token.
  if (unresolved.id.startsWith(ENUMERATED_ITEM_OBLIGATION_PREFIX)) {
    return enumeratedItemFindCall(obligations, workspace);
  }
  // 2026-11 (external A/B of v0.16.4): an unserved self-method body on the
  // asked path is fetched by its exact range, query-bearing so the response
  // re-enters the pack with a decision — never a name search that would
  // return the call line the pack already holds.
  if (unresolved.id.startsWith(ASKED_PATH_OBLIGATION_PREFIX)) {
    const name = unresolved.id.slice(ASKED_PATH_OBLIGATION_PREFIX.length);
    const window = currentAskedPathPlan(workspace, query)?.windows.find((entry) => entry.name === name);
    if (window !== undefined) {
      return {
        tool: "tl_read_file",
        arguments: { query, targets: [{ path: window.path, range: `${window.start}-${window.end}` }], content: "auto" },
      };
    }
  }
  const identifier = unresolved.id.startsWith("identifier:") ? unresolved.id.slice("identifier:".length) : undefined;
  if (identifier) {
    // 2026-10-29: an anchor the request names and the workspace defines is
    // fetched by its declaration's own span, not searched for by name.
    const anchorRead = workspace === undefined ? undefined : anchorDefinitionGap([unresolved], query, workspace);
    if (anchorRead !== undefined) return anchorRead.next_call;
    // WP-O (eval-0929 §8): an open same-name subject names the declaration
    // the question means (or every declaration, when ambiguous) as a ranged,
    // query-bearing read — never a name search that returns its call sites.
    const sameNameSubject = sameNameSubjectsFor(result).get(identifier);
    const sameNameRead = sameNameSubject === undefined
      ? undefined
      : sameNameDeclarationReadCall(result, sameNameSubject, query, workspace);
    if (sameNameRead !== undefined) return sameNameRead;
    // FIX-G G3 (2026-09-27, eval-0927 "also seen"): a symbol lookup is the
    // right recovery only for a name something DECLARES. An env-var key /
    // property / string key (`HTTP_TIMEOUT_MS`) is declared nowhere, so the
    // symbol-scoped find answered with an unrelated symbol and no `next` — a
    // dead end. Read the window around its best literal occurrence instead,
    // query-bearing so the response re-enters the pack with a decision.
    const literalRead = workspace === undefined
      ? undefined
      : undeclaredIdentifierReadCall(result, identifier, query, workspace);
    return literalRead ?? { tool: "tl_search_files", arguments: { action: "symbols", query: identifier } };
  }
  const connection = result.wiring?.connections[0];
  // Raw-query fallbacks manufactured junk sweeps (references on the whole
  // sentence / a stopword — 2026-07-31 T13 rep0 forensics); endpoint recovery
  // calls run on identifier-shaped tokens only, or not at all (the
  // no-dead-end guard still keeps one bounded call open downstream).
  // W9 (2026-08-22): scrub generic path spans from `query` FIRST — this is a
  // raw `.match()` extraction, not a call through one of the shared,
  // already-scrubbing token helpers, so a path segment mentioned in prose
  // (e.g. a PascalCase repo folder name) would otherwise pass
  // isWiringIdentifierShape and become a wiring `find`/`references` `next`.
  const cleanedQuery = stripPathSpans("", query);
  const queryIdentifiers = (cleanedQuery.match(/\b[A-Za-z_$][A-Za-z0-9_$-]*\b/g) ?? []).filter(isWiringIdentifierShape);
  if (unresolved.kind === "wiring-source") {
    // E2 (2026-09-05, measured on paid smoke r9 / SF13): an owed wiring SOURCE
    // must be chased on the identity the CALLER named. Live, the connection's
    // source token had degraded to the unrelated `GPS` and the pack emitted
    // `tl_search_files find queries:["GPS"]` while the query had spelled
    // `EKF::isHealthy`. When the query names a qualified anchor, that anchor's
    // member is the source identity, and its resolved DEFINITION SITE — when
    // the pack has not already served it — is a strictly better affordance
    // than a repository-wide find: it addresses the one symbol directly.
    const anchor = qualifiedSymbolAnchors(query)[0];
    if (anchor !== undefined && workspace !== undefined) {
      const servedPaths = new Set(result.surfaces.map((surface) => surface.path));
      // WP-M (2026-09-29, eval-0929 "non-terminating chains") — the same
      // this-call-only gap `computeUndeclaredIdentifierReadCall` above had:
      // `result.surfaces` is only THIS invocation's own freshly-served
      // surfaces, never an earlier hop's serve of the SAME task, so with two
      // or more qualified-definition candidates this branch could re-offer a
      // definition site the caller already read two hops ago, alternating
      // with its sibling candidate forever. Judged instead against the
      // task's own served-range ledger (state/session.ts) at each
      // candidate's CURRENT sha — "no claim" on a sha mismatch, so a stale
      // revision still counts as unserved — the same rule
      // `computeUndeclaredIdentifierReadCall` uses just above.
      const definitionPath = resolveQualifiedSymbolAnchors(query, workspace)
        .definitions.find((candidate) => {
          if (servedPaths.has(candidate)) return false;
          const content = readCached(workspace, candidate);
          if (content === undefined) return true;
          const coverage = servedRangeCoverage(workspace, candidate, shaOfText(content), countLines(content));
          return coverage === undefined || coverage.served.length === 0;
        });
      if (definitionPath !== undefined) {
        return {
          tool: "tl_read_file",
          arguments: { targets: [{ path: definitionPath, symbol: anchor.raw }] },
        };
      }
    }
    const token = anchor?.member ?? connection?.source?.token ?? queryIdentifiers[0];
    return token === undefined
      ? undefined
      : { tool: "tl_search_files", arguments: { action: "find", query: token } };
  }
  if (unresolved.kind === "wiring-consumer" || unresolved.kind === "wiring-insertion") {
    const token = connection?.destination?.token
      ?? (queryIdentifiers.length > 1 ? queryIdentifiers.at(-1) : queryIdentifiers[0]);
    return token === undefined
      ? undefined
      : { tool: "tl_search_files", arguments: { action: "references", query: token } };
  }
  if (unresolved.kind === "behavior-body") {
    // R2-T1 (ruling rule 3): the declaration was located and only its body is
    // missing — read the body, query-bearing like the facet gap's own ranged
    // read, so the response re-enters the pack with a decision. A name search
    // would return its call sites, never the body.
    const unshown = unshownCallableBodiesByResult.get(result) ?? [];
    if (unshown.length > 0) {
      return {
        tool: "tl_read_file",
        arguments: {
          query,
          targets: unshown.map((declaration) => ({
            path: declaration.path,
            range: `${declaration.line}-${Math.max(declaration.line, declaration.bound - 1)}`,
          })),
          content: "auto",
        },
      };
    }
    const explicit = explicitCodeIdentifiers(query)[0];
    return { tool: "tl_search_files", arguments: { action: explicit ? "references" : "symbols", query: explicit ?? tokenizeForEpoch(cleanedQuery)[0] ?? query } };
  }
  if (unresolved.id === "analysis-source") {
    return { tool: "tl_search_files", arguments: { action: "locate", query, includeClosure: true } };
  }
  if (unresolved.id === "artifact-input") {
    const artifact = result.surfaces.find(isArtifactTaskPackSurface);
    if (artifact) {
      return { tool: "tl_read_file", arguments: { mode: "artifact", path: artifact.path } };
    }
  }
  if (unresolved.id === "artifact-implementation") {
    return {
      tool: "tl_search_files",
      arguments: {
        action: "locate",
        query: moduleShapedQueryTokens(query)[0] ?? query,
        includeClosure: true,
      },
    };
  }
  if (unresolved.id.startsWith("open-universe:")) {
    // Additive propagation queries still need one authoritative existence
    // probe for the requested value before the caller continues. Prefer an
    // identifier-shaped all-caps token (e.g. REFUNDED) over the enum name.
    const requestedValue = query.match(/\b[A-Z][A-Z0-9_]{2,}\b/)?.[0];
    if (requestedValue !== undefined) {
      return { tool: "tl_search_files", arguments: { action: "find", query: requestedValue } };
    }
  }
  return undefined;
}
