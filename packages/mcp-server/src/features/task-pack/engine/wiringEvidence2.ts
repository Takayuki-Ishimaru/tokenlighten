// wiringEvidence — extracted implementation; imports point to the owning modules.
import * as path from "path";
import type { ImpactSurface } from "@tokenlighten/types";
import type { TaskEvidenceGraph } from "@tokenlighten/types";
import type { TaskEvidenceNode } from "@tokenlighten/types";
import type { TaskEvidenceRelation } from "@tokenlighten/types";
import type { TaskEvidenceRelationKind } from "@tokenlighten/types";
import type { TaskPackResult } from "../model.js";
import type { TaskPackSurface } from "../model.js";
import type { TaskWiringEndpoint } from "@tokenlighten/types";
import type { TaskWiringEvidence } from "@tokenlighten/types";
import type { WiringEndpoint } from "./createAndWiringEndpoints2.js";
import { FileReadCache } from "./packBasics2.js";
import { HIGH_CONFIDENCE_THRESHOLD } from "./packBasics2.js";
import { MAX_SURFACES_DISTINCT } from "./packBasics2.js";
import { MAX_SURFACE_CODE_BYTES } from "./packBasics2.js";
import { READINESS_PROBE_MAX_BYTES } from "./changeAndReadinessEvidence2.js";
import { READINESS_PROBE_MAX_FILES } from "./changeAndReadinessEvidence2.js";
import { TINY_FILE_MAX_BYTES } from "./packBasics2.js";
import { TINY_FILE_MAX_LINES } from "./packBasics2.js";
import { centeredSliceForCap } from "./packBasics2.js";
import { classifySurface } from "../../../util/impact.js";
import { codeTaskPackSurfaces } from "../artifactSections.js";
import { countLines } from "../../../util/countLines.js";
import { declaredCallableNames } from "./wiringEvidence3.js";
import { definedCallableNames } from "./wiringEvidence3.js";
import { evidenceNodeId } from "./wiringEvidence3.js";
import { evidenceRelationId } from "./wiringEvidence3.js";
import { explicitCodeIdentifiers } from "./anchorFocus2.js";
import { handleTable } from "../../../util/handles.js";
import { hasCallableBody } from "./changeAndReadinessEvidence2.js";
import { importLineTargetsPath } from "./wiringEvidence3.js";
import { inferCallableSymbol } from "./readinessFalsification.js";
import { isImplementationPath } from "./changeAndReadinessEvidence2.js";
import { normIdent } from "./createAndWiringEndpoints2.js";
import { qualifiedSymbolAnchors } from "./wiringEvidence3.js";
import { queryServedSurfaces } from "../../../util/packServeLog.js";
import { readCached } from "./packBasics2.js";
import { relationCodeOnly } from "./wiringEvidence3.js";
import { resolveQualifiedSymbolAnchors } from "./wiringEvidence3.js";
import { servedSurfaceText } from "./changeAndReadinessEvidence2.js";
import { stripModuleExtension } from "./wiringEvidence3.js";
import { surfaceBodyContainsToken } from "./changeAndReadinessEvidence2.js";
import { tokenizeForEpoch } from "../../../state/session.js";

export const IMPACT_SURFACE_ROLES = new Set<string>([
  "contract", "api", "domain", "data", "ui", "style", "test", "config", "doc", "unknown",
]);

export function asImpactSurface(role: string): ImpactSurface {
  return IMPACT_SURFACE_ROLES.has(role) ? role as ImpactSurface : "unknown";
}

export function hasServedCode(surface: TaskPackSurface): boolean {
  return (surface.code?.length ?? 0) > 0 || (surface.code_unchanged?.length ?? 0) > 0;
}

/**
 * `shippedSurfaces` before the auxiliary-row exclusion: every code surface that
 * ships a body (or a `code_unchanged` restatement). Private to
 * `shippedSurfaces` -- a consumer calls THAT, never this, so there is still one
 * answer to "what did this response ship".
 */
export function servedBodySurfaces(result: TaskPackResult): TaskPackSurface[] {
  return codeTaskPackSurfaces(result.surfaces).filter(hasServedCode);
}

/**
 * FX-J/FX-K — the state `finalizePackServeState` hands forward to the single
 * post-trim booking pass. Created (and threaded through this one synchronous
 * call) by `dedupeTrimAndPersist`, UNCONDITIONALLY since FX-K: there is no
 * longer a flag-selected pre-seam booking position, so this object is never
 * `undefined`. Deliberately NOT module state: FX-H's module-global
 * deferred-booking queue, flushed by whichever handler exited first, was
 * round-13 finding 3.
 */
export interface PendingPackBookings {
  epochTokens: string[];
  cumulativeEligible: boolean;
  /** The pack object whose own surfaces were handed to the contract build in place of the deferred log write; cleared once the bookings land. */
  pack?: TaskPackResult;
}

export function hasSufficientEditContent(surface: TaskPackSurface): boolean {
  // anchors_served (2026-07-25 honest-hub fix): a partial hub whose decision
  // anchors are all inside the served ranges is edit-sufficient — without this
  // exemption the honest "partial" label re-created the receiver-construction
  // discovery-stuck regression the Wave-4 label suppression papered over.
  if (
    !hasServedCode(surface)
    || (surface.content_completeness === "partial" && surface.anchors_served !== true)
  ) return false;
  const inspectConfidence = surface.likely_edits
    ?.find((hint) => hint.kind === "inspect-slice")
    ?.confidence;
  return !(
    (surface.outline?.length ?? 0) > 0
    && inspectConfidence !== undefined
    && inspectConfidence < HIGH_CONFIDENCE_THRESHOLD
  );
}

export function endpointFromSurface(
  token: string,
  surface: TaskPackSurface,
  evidence: TaskWiringEvidence[],
): TaskWiringEndpoint {
  return {
    token,
    handle: surface.handle,
    path: surface.path,
    range: surface.range,
    role: asImpactSurface(surface.role),
    evidence: [...new Set(evidence)],
  };
}

/**
 * D2 (2026-09-05, measured on paid smoke r10 / SF13 call 2): a wiring endpoint
 * whose file an EARLIER call in this epoch already served.
 *
 * The wiring builder resolves both endpoints out of THIS pack's `surfaces`
 * alone. Live: call 1 served the producer (`…/ekf.cpp` 592-595) and the
 * caller's own bundle `next` then asked for the five OTHER files — so the
 * producer was, correctly, not re-served, and the follow-up pack reported
 * `missing:["source","destination"]` with a `wiring-source` gap for bytes the
 * caller was holding the whole time. The caller's only move is to ask again
 * for what it already has, which is the loop.
 *
 * The epoch ledger is the existing seam for exactly this question
 * (`queryServedSurfaces`, already consulted by `reconcileCallerPathCoverage`
 * for the sibling "named but unserved" defect): it is epoch-gated by token
 * overlap and revalidates each entry by content fingerprint, so a file EDITED
 * since it was served drops out and is honestly re-reported as missing.
 * The endpoint minted here is BODYLESS by construction — it names the handle
 * the caller already holds, and this pack spends no bytes re-serving it.
 *
 * The token must still be DEFINED in that file (`implementsCallableToken`,
 * the same test the readiness proof uses), so a file that merely mentions the
 * word can never stand in as an endpoint. Returns `undefined` — the ordinary
 * case — when no served file defines the token, leaving the wire unchanged.
 */
export function epochServedWiringEndpoint(
  token: string | undefined,
  query: string,
  surfaces: readonly TaskPackSurface[],
  workspace: string,
  cache: FileReadCache | undefined,
): TaskWiringEndpoint | undefined {
  if (token === undefined || token.length === 0) return undefined;
  const epochTokens = tokenizeForEpoch(query);
  if (epochTokens.length === 0) return undefined;
  const inPack = new Set(surfaces.map((surface) => surface.path));
  let fallback: TaskWiringEndpoint | undefined;
  for (const entry of queryServedSurfaces(workspace, workspace, { epochTokens })) {
    if (entry.handle === undefined || inPack.has(entry.path)) continue;
    // C1's range-aware verdict: only a serve that already amounted to the whole
    // file lets this name a whole-file range as the caller's resident bytes.
    // `undefined` keeps the ledger's original path-only semantics (see
    // `ServedSurfaceEntry.fullyServed`).
    if (entry.fullyServed === false) continue;
    const content = readCached(workspace, entry.path, cache);
    if (content === undefined) continue;
    if (!implementsCallableToken(content, token)) continue;
    const endpoint: TaskWiringEndpoint = {
      token,
      handle: entry.handle,
      path: entry.path,
      range: `1-${Math.max(1, countLines(content))}`,
      role: asImpactSurface(entry.role ?? classifySurface(entry.path)),
      // The definition is what was proved here; "located-surface" would claim a
      // surface THIS pack served, which it deliberately did not.
      evidence: ["query-token", "workspace-definition"],
    };
    // An implementation outranks a declaration for either endpoint, exactly as
    // the in-pack resolution does; ledger order (servedAt) breaks ties.
    if (isImplementationPath(entry.path)) return endpoint;
    fallback ??= endpoint;
  }
  return fallback;
}

export function firstNonCommentTokenLine(text: string, token: string): number {
  const normalizedToken = normIdent(token);
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const trimmed = lines[index]!.trim();
    if (
      trimmed.startsWith("//")
      || trimmed.startsWith("/*")
      || trimmed.startsWith("*")
      || trimmed.startsWith("#")
    ) continue;
    if (normIdent(trimmed).includes(normalizedToken)) return index + 1;
  }
  return 1;
}

/**
 * Ensures a wiring endpoint is represented by an embedded, reusable handle.
 * The locator/check machinery decides the path and role; this helper only
 * supplies a bounded edit anchor and never invents implementation code.
 */
export function ensureWiringEndpointSurface(
  surfaces: TaskPackSurface[],
  endpoint: WiringEndpoint,
  workspace: string,
  cache: FileReadCache | undefined,
  required: boolean,
  maxSurfaces = MAX_SURFACES_DISTINCT,
  maxSurfaceBytes = MAX_SURFACE_CODE_BYTES,
  /**
   * B2a (2026-08-01 serving-completeness): the file-size bound under which this
   * surface is served WHOLE (range 1-EOF) instead of a ±20/+40 window around the
   * token match. Defaults to the tiny-file thresholds, i.e. today's behavior;
   * the construct-receiver frontier raises it so a wiring edit site never
   * arrives as a teaser the solver has to full-read.
   */
  completeUnderBytes = TINY_FILE_MAX_BYTES,
  completeUnderLines = TINY_FILE_MAX_LINES,
  /**
   * E1 (2026-09-05): an honesty clause appended to a REQUIRED destination's
   * `why` — set only when the query named a destination domain this endpoint
   * does not belong to, so "use this handle as the insertion site" can never
   * read as a domain-matched claim it is not.
   */
  whyNote?: string,
): { surface: TaskPackSurface; discovered: boolean } | undefined {
  let surface = surfaces.find((candidate) => candidate.path === endpoint.path);
  if (surface !== undefined) {
    if (required) surface.required = true;
    // B2a: a raised completeness bar must also WIDEN a surface some earlier
    // (smaller-budget) ensure already served partially — otherwise the first
    // caller's teaser wins and the frontier stays incomplete.
    const widenToWhole = completeUnderBytes > TINY_FILE_MAX_BYTES
      && (surface.content_completeness === "partial" || !hasServedCode(surface));
    if (widenToWhole) {
      const text = readCached(workspace, surface.path, cache);
      const lineCount = text === undefined ? 0 : Math.max(1, countLines(text));
      if (
        text !== undefined
        && Buffer.byteLength(text, "utf8") <= completeUnderBytes
        && lineCount <= completeUnderLines
      ) {
        const wholeRange = `1-${lineCount}`;
        const whole = centeredSliceForCap(workspace, surface.path, wholeRange, cache, undefined, maxSurfaceBytes);
        if (whole !== undefined && whole.remaining_ranges.length === 0) {
          surface.range = wholeRange;
          surface.handle = handleTable.upsert({
            kind: "range",
            path: surface.path,
            range: wholeRange,
            workspaceRoot: workspace,
          }).id;
          surface.code = whole.code;
          delete surface.content_completeness;
          delete surface.remaining_ranges;
          return { surface, discovered: false };
        }
      }
    }
    if (!hasServedCode(surface)) {
      const embedded = centeredSliceForCap(workspace, surface.path, surface.range, cache, undefined, maxSurfaceBytes);
      if (embedded !== undefined) {
        surface.code = embedded.code;
        if (embedded.remaining_ranges.length > 0) {
          surface.content_completeness = "partial";
          surface.remaining_ranges = embedded.remaining_ranges;
        }
      }
    }
    return { surface, discovered: false };
  }

  const text = readCached(workspace, endpoint.path, cache);
  if (text === undefined) return undefined;
  if (surfaces.length >= maxSurfaces) {
    let replaceIndex = -1;
    for (let index = surfaces.length - 1; index >= 0; index--) {
      if (surfaces[index]!.required !== true) {
        replaceIndex = index;
        break;
      }
    }
    if (replaceIndex < 0) return undefined;
    surfaces.splice(replaceIndex, 1);
  }

  const lineCount = Math.max(1, countLines(text));
  const matchLine = firstNonCommentTokenLine(text, endpoint.token);
  const wholeFileFits = Buffer.byteLength(text, "utf8") <= completeUnderBytes
    && lineCount <= completeUnderLines;
  const range = wholeFileFits
    ? "1-" + lineCount
    : Math.max(1, matchLine - 20) + "-" + Math.min(lineCount, matchLine + 40);
  const handle = handleTable.upsert({
    kind: "range",
    path: endpoint.path,
    range,
    workspaceRoot: workspace,
  });
  const embedded = centeredSliceForCap(workspace, endpoint.path, range, cache, matchLine, maxSurfaceBytes);
  const callableSymbol = inferCallableSymbol(text, matchLine);
  surface = {
    role: endpoint.role,
    handle: handle.id,
    path: endpoint.path,
    range,
    ...(callableSymbol ? { symbol: callableSymbol } : {}),
    ...(required ? { required: true } : {}),
    why: required
      ? "wiring destination for " + endpoint.token + "; use this handle as the insertion site"
        + (whyNote === undefined ? "" : "; " + whyNote)
      : "wiring source for " + endpoint.token + "; review before editing the consumer",
    ...(embedded ? { code: embedded.code } : {}),
    ...(embedded && embedded.remaining_ranges.length > 0
      ? { content_completeness: "partial" as const, remaining_ranges: embedded.remaining_ranges }
      : {}),
  };
  surfaces.push(surface);
  return { surface, discovered: true };
}

/**
 * Definition sites of the qualified anchors whose QUALIFIER or MEMBER is
 * `token` — the authoritative binding for a wiring endpoint the caller wrote as
 * `Class::method`. Empty for a bare token, which keeps the
 * `ambiguousUnlinkedSource` abstention intact for genuinely ambiguous names.
 */
export function qualifiedAnchorDefinitionPathsForToken(
  token: string,
  query: string,
  workspace: string,
  cache?: FileReadCache,
): string[] {
  const matched = qualifiedSymbolAnchors(query).filter((anchor) =>
    normIdent(anchor.qualifier) === normIdent(token) || normIdent(anchor.member) === normIdent(token)
  );
  if (matched.length === 0) return [];
  return [
    ...resolveQualifiedSymbolAnchors(
      matched.map((anchor) => anchor.raw).join(" "),
      workspace,
      cache,
    ).definitions,
  ];
}

export function implementsCallableToken(content: string, token: string): boolean {
  if (definedCallableNames(content).some((name) => normIdent(name) === normIdent(token))) return true;
  if (token.length === 0) return false;
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}::[A-Za-z_][A-Za-z0-9_]*\\s*\\(`)
    .test(relationCodeOnly(content));
}

export function wiringConsumerToken(
  query: string,
  surface: TaskPackSurface,
  fallback: string,
): string {
  const callables = definedCallableNames(servedSurfaceText(surface));
  const explicit = explicitCodeIdentifiers(query).find((identifier) =>
    callables.some((callable) => normIdent(callable) === normIdent(identifier))
  );
  if (explicit !== undefined) {
    return callables.find((callable) => normIdent(callable) === normIdent(explicit)) ?? explicit;
  }
  if (surface.symbol !== undefined) {
    const defined = callables.find((callable) => normIdent(callable) === normIdent(surface.symbol!));
    if (defined !== undefined) return defined;
  }
  return callables.length === 1 ? callables[0]! : surface.symbol ?? fallback;
}

/**
 * Return bounded implementation definitions for one callable token. Multiple
 * unrelated bodies mean a new wiring task has no structural basis for choosing
 * a producer; an import edge may still disambiguate them later.
 */
export function workspaceCallableDefinitionPaths(
  token: string,
  walked: ReadonlyArray<string>,
  workspace: string,
  cache: FileReadCache | undefined,
): string[] {
  const wanted = normIdent(token);
  const matches: string[] = [];
  let filesRead = 0;
  let bytesRead = 0;
  for (const relPath of walked) {
    if (filesRead >= READINESS_PROBE_MAX_FILES || bytesRead >= READINESS_PROBE_MAX_BYTES) break;
    if (!isImplementationPath(relPath)) continue;
    const content = readCached(workspace, relPath, cache);
    if (content === undefined) continue;
    filesRead += 1;
    bytesRead += Buffer.byteLength(content, "utf8");
    if (definedCallableNames(content).some((name) => normIdent(name) === wanted)) {
      matches.push(relPath);
      if (matches.length > 3) break;
    }
  }
  return matches;
}

export function workspaceCallableDeclarationPaths(
  token: string,
  walked: ReadonlyArray<string>,
  workspace: string,
  cache: FileReadCache | undefined,
): string[] {
  const wanted = normIdent(token);
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const declaration = new RegExp(
    "^\\s*(?:(?:export|declare|extern|static|inline|virtual)\\s+)*"
      + "(?:[A-Za-z_][A-Za-z0-9_:<>,*&]*\\s+)+"
      + escaped + "\\s*\\([^;{}]*\\)\\s*(?:const\\s*)?(?:->\\s*[^;]+)?;\\s*$",
    "m",
  );
  const matches: string[] = [];
  let filesRead = 0;
  let bytesRead = 0;
  for (const relPath of walked) {
    if (filesRead >= READINESS_PROBE_MAX_FILES || bytesRead >= READINESS_PROBE_MAX_BYTES) break;
    const content = readCached(workspace, relPath, cache);
    if (content === undefined) continue;
    filesRead += 1;
    bytesRead += Buffer.byteLength(content, "utf8");
    if (
      definedCallableNames(content).some((name) => normIdent(name) === wanted)
      || declaration.test(relationCodeOnly(content))
    ) {
      matches.push(relPath);
      if (matches.length > 3) break;
    }
  }
  return matches;
}

/** Resolve only import/include evidence observable in the selected consumer. */
export function importedWiringSource(
  consumer: TaskPackSurface | undefined,
  sourceToken: string,
  walked: ReadonlyArray<string>,
  workspace: string,
  cache: FileReadCache | undefined,
): WiringEndpoint | undefined {
  if (consumer === undefined) return undefined;
  const body = readCached(workspace, consumer.path, cache)
    ?? consumer.code
    ?? consumer.code_unchanged
    ?? "";
  const tokenNorm = normIdent(sourceToken);
  const specs: string[] = [];
  for (const line of body.split(/\r?\n/).slice(0, 240)) {
    if (!/^\s*(?:import\b|#\s*include\b|use\b|from\b|.*\brequire\s*\()/.test(line)) continue;
    if (!normIdent(line).includes(tokenNorm)) continue;
    for (const match of line.matchAll(/(?:from\s*|require\s*\(\s*|#\s*include\s*)["'<]([^"'>)]+)["'>)]/g)) {
      specs.push(match[1]!);
    }
  }
  for (const specifier of specs.slice(0, 8)) {
    const normalized = specifier.replace(/\\/g, "/");
    const targetStem = normalized.startsWith(".")
      ? stripModuleExtension(path.posix.normalize(path.posix.join(path.posix.dirname(consumer.path), normalized)))
      : stripModuleExtension(normalized);
    const candidates = walked.filter((candidate) => {
      const stem = stripModuleExtension(candidate);
      return normalized.startsWith(".") ? stem === targetStem : stem.endsWith("/" + targetStem) || stem === targetStem;
    });
    candidates.sort((left, right) => {
      const implementation = Number(isImplementationPath(right)) - Number(isImplementationPath(left));
      return implementation || left.localeCompare(right);
    });
    const selected = candidates[0];
    if (selected !== undefined) {
      return { token: sourceToken, path: selected, role: asImpactSurface(classifySurface(selected)) };
    }
  }
  return undefined;
}

export function buildWiringEvidenceGraph(
  source: TaskWiringEndpoint | undefined,
  destination: TaskWiringEndpoint | undefined,
  surfaces: ReadonlyArray<TaskPackSurface>,
  workspace: string,
  cache: FileReadCache | undefined,
): TaskEvidenceGraph | undefined {
  // D10 (2026-08-14): `TL_EVIDENCE_RELATIONS` is deleted.
  if (source === undefined || destination === undefined) return undefined;
  const sourceSurface = surfaces.find((surface) => surface.handle === source.handle);
  const destinationSurface = surfaces.find((surface) => surface.handle === destination.handle);
  if (sourceSurface === undefined || destinationSurface === undefined) return undefined;

  const sourceSymbol = sourceSurface.symbol ?? source.token;
  const destinationSymbol = destinationSurface.symbol ?? destination.token;
  const sourceFileId = evidenceNodeId("file", source.path);
  const sourceSymbolId = evidenceNodeId("symbol", source.path, sourceSymbol);
  const destinationFileId = evidenceNodeId("file", destination.path);
  const destinationSymbolId = evidenceNodeId("symbol", destination.path, destinationSymbol);
  const nodes: TaskEvidenceNode[] = [
    { id: sourceFileId, kind: "file", path: source.path, handle: source.handle, range: source.range, roles: ["producer"] },
    { id: sourceSymbolId, kind: "symbol", path: source.path, symbol: sourceSymbol, handle: source.handle, range: source.range, roles: ["producer"] },
    { id: destinationFileId, kind: "file", path: destination.path, handle: destination.handle, range: destination.range, roles: ["consumer"] },
    { id: destinationSymbolId, kind: "symbol", path: destination.path, symbol: destinationSymbol, handle: destination.handle, range: destination.range, roles: ["consumer"] },
  ];
  const relations: TaskEvidenceRelation[] = [];
  const addRelation = (
    kind: TaskEvidenceRelationKind,
    from: string,
    to: string,
    provenance: TaskEvidenceRelation["provenance"],
    confidence: number,
  ): void => {
    const id = evidenceRelationId(kind, from, to);
    if (relations.some((relation) => relation.id === id)) return;
    relations.push({ id, kind, from, to, provenance, confidence });
  };
  if (
    isImplementationPath(source.path)
    && implementsCallableToken(servedSurfaceText(sourceSurface), source.token)
  ) {
    addRelation("defines", sourceFileId, sourceSymbolId, "index", sourceSurface.symbol ? 0.98 : 0.84);
  }
  if (
    isImplementationPath(destination.path)
    && implementsCallableToken(servedSurfaceText(destinationSurface), destination.token)
  ) {
    addRelation("defines", destinationFileId, destinationSymbolId, "index", destinationSurface.symbol ? 0.98 : 0.84);
  }

  const destinationBodyRaw = (readCached(workspace, destination.path, cache)
    ?? destinationSurface.code
    ?? destinationSurface.code_unchanged
    ?? "").slice(0, 32768);
  const destinationBody = relationCodeOnly(destinationBodyRaw);
  const escapedSource = source.token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const importMentionsSource = destinationBodyRaw.split(/\r?\n/).some((line) =>
    normIdent(line).includes(normIdent(source.token))
    && importLineTargetsPath(destination.path, line, source.path)
  );
  if (importMentionsSource) addRelation("imports", destinationFileId, sourceFileId, "lexical", 0.9);
  if (new RegExp(`\\b${escapedSource}\\b`, "i").test(destinationBody)) {
    addRelation("references", destinationSymbolId, sourceSymbolId, "lexical", 0.82);
  }
  if (new RegExp(`\\b${escapedSource}\\s*\\(`).test(destinationBody)) {
    addRelation("direct_calls", destinationSymbolId, sourceSymbolId, "lexical", 0.94);
  }
  for (const supportSurface of surfaces) {
    if (
      supportSurface.handle === source.handle
      || supportSurface.handle === destination.handle
      || supportSurface.path === source.path
      || supportSurface.path === destination.path
    ) continue;
    const supportDefinitions = definedCallableNames(servedSurfaceText(supportSurface));
    const supportNames = [
      supportSurface.symbol,
      ...declaredCallableNames(servedSurfaceText(supportSurface)),
    ].filter((name): name is string => Boolean(name));
    const imported = destinationBodyRaw.split(/\r?\n/).some((line) => {
      if (!importLineTargetsPath(destination.path, line, supportSurface.path)) return false;
      const lineNorm = normIdent(line);
      return /^\s*#\s*include\b/.test(line)
        || supportNames.some((name) => lineNorm.includes(normIdent(name)));
    });
    const calledName = supportNames.find((name) => {
      const escaped = name.replace(/[.*+?^$(){}|[\]\\]/g, "\\$&");
      if (!new RegExp("\\b" + escaped + "\\s*\\(").test(destinationBody)) return false;
      if (imported) return true;
      const definingPaths = new Set(
        surfaces
          .filter((candidate) => candidate.path !== destination.path)
          .filter((candidate) => [
            candidate.symbol,
            ...declaredCallableNames(servedSurfaceText(candidate)),
          ].some((candidateName) =>
            candidateName !== undefined && normIdent(candidateName) === normIdent(name)))
          .map((candidate) => candidate.path),
      );
      return definingPaths.size === 1;
    });
    if (!imported && calledName === undefined) continue;

    const supportSymbol = calledName ?? supportNames[0];
    if (supportSymbol === undefined) continue;
    const supportFileId = evidenceNodeId("file", supportSurface.path);
    const supportSymbolId = evidenceNodeId("symbol", supportSurface.path, supportSymbol);
    nodes.push(
      { id: supportFileId, kind: "file", path: supportSurface.path, handle: supportSurface.handle, range: supportSurface.range, roles: ["adapter"] },
      { id: supportSymbolId, kind: "symbol", path: supportSurface.path, symbol: supportSymbol, handle: supportSurface.handle, range: supportSurface.range, roles: ["adapter"] },
    );
    if (
      isImplementationPath(supportSurface.path)
      && supportDefinitions.some((name) => normIdent(name) === normIdent(supportSymbol))
    ) {
      addRelation("defines", supportFileId, supportSymbolId, "index", supportSurface.symbol ? 0.98 : 0.9);
    }
    if (imported) addRelation("imports", destinationFileId, supportFileId, "lexical", 0.94);
    if (calledName !== undefined) {
      addRelation("references", destinationSymbolId, supportSymbolId, "lexical", 0.9);
      addRelation("direct_calls", destinationSymbolId, supportSymbolId, "lexical", 0.98);
    }
  }
  return { version: 1, nodes, relations };
}

/**
 * Prefer a callable consumer implementation over a declaration-only endpoint.
 * Wiring discovery often grounds a destination token in an API/header first
 * (for example MAVLink -> mavlink.hpp), even though the safe insertion site is
 * a task/controller that consumes that API.  Only promote already-served,
 * body-scoped references; this never guesses an unobserved edit target.
 */
export function bestServedWiringConsumer(
  query: string,
  destinationToken: string,
  surfaces: readonly TaskPackSurface[],
): TaskPackSurface | undefined {
  const destinationNorm = normIdent(destinationToken);
  if (destinationNorm.length === 0) return undefined;
  const queryTerms = tokenizeForEpoch(query)
    .filter((term) => term.length >= 4 && normIdent(term) !== destinationNorm)
    .slice(0, 32);
  const candidates = surfaces
    .filter((surface) =>
      isImplementationPath(surface.path)
      && hasCallableBody(surface)
      && surfaceBodyContainsToken(surface, destinationToken)
    )
    .map((surface) => {
      const body = normIdent(surface.code ?? surface.code_unchanged ?? "");
      const pathText = normIdent(surface.path);
      const basename = normIdent(path.basename(surface.path, path.extname(surface.path)));
      const bodyHits = queryTerms.filter((term) => body.includes(normIdent(term))).length;
      const pathHits = queryTerms.filter((term) => pathText.includes(normIdent(term))).length;
      // A same-named implementation is normally the endpoint definition, not
      // its consumer.  It remains eligible when no real consumer was served.
      const definitionPenalty = basename.includes(destinationNorm) ? 100 : 0;
      return { surface, score: bodyHits * 4 + pathHits * 2 - definitionPenalty };
    });
  candidates.sort((a, b) =>
    b.score - a.score
    || a.surface.path.localeCompare(b.surface.path)
    || a.surface.range.localeCompare(b.surface.range)
  );
  return candidates.find((candidate) => candidate.score > 0)?.surface;
}
