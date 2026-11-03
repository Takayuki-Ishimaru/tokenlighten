// epochEvidence — extracted implementation; imports point to the owning modules.
import * as fs from "fs";
import type { ContinuationCall } from "./packBasics.js";
import type { TaskCapabilityGap } from "@tokenlighten/types";
import type { TaskDecisionEvidenceModel } from "@tokenlighten/types";
import type { TaskFalsificationReport } from "@tokenlighten/types";
import type { TaskPackResult } from "../model.js";
import type { TaskPackResultSurface } from "../model.js";
import type { TaskProfile } from "@tokenlighten/types";
import type { TaskReadinessObligation } from "@tokenlighten/types";
import type { TaskReadinessRisk } from "@tokenlighten/types";
import type { TaskWorkspaceState } from "@tokenlighten/types";
import { READINESS_FALSE_READY_LIMIT } from "./changeAndReadinessEvidence.js";
import { READINESS_PROBE_MAX_SURFACES } from "./changeAndReadinessEvidence2.js";
import { UNREADABLE_NAMED_PATH_PREFIX } from "./queryIntent4.js";
import { anchorDefinitionGap } from "./unresolvedCalls3.js";
import { codeTaskPackSurfaces } from "../artifactSections.js";
import { currentSessionLane } from "../../../util/laneKey.js";
import { exactIdentifierEvidence } from "./changeAndReadinessEvidence.js";
import { explicitCodeIdentifiers } from "./anchorFocus2.js";
import { handleTable } from "../../../util/handles.js";
import { hasExactNamedAnswerFacetEvidence } from "./recursiveClosure.js";
import { hasServedCode } from "./wiringEvidence2.js";
import { isArtifactTaskPackSurface } from "../artifactSections.js";
import { isAuxiliaryEnumSurface } from "../auxiliaryEnumContextIntegration.js";
import { isImplementationPath } from "./changeAndReadinessEvidence2.js";
import { isWithin } from "../../../util/safePath.js";
import { maskReadLeadSpan } from "../requestItems.js";
import { normIdent } from "./createAndWiringEndpoints2.js";
import { projectRootOf } from "../../locator/locateTaskContext.js";
import { readFileForRequest } from "../../../util/requestFileCache.js";
import { rehydrateHandleEntry } from "../../../state/stateHandles.js";
import { resolveReal } from "../../../util/safePath.js";
import { safeResolve } from "../../../util/safePath.js";
import { shaOfBytes } from "../../../util/handles.js";
import { shaOfText } from "../../../util/handles.js";
import { tokenizeForEpoch } from "../../../state/session.js";
import { verifiedAbsentIdentifiersFor } from "./identifierAbsence.js";
import { walkCodeFiles } from "../../../tools/walkRepo.js";
import { writeAuthorityVeto } from "./changeAndReadinessEvidence.js";

export function actionFrontierForCertificate(
  result: TaskPackResult,
  profile: TaskProfile,
  obligations: readonly TaskReadinessObligation[],
  query: string,
  priorEpoch: readonly string[] = [],
  // DESIGN-v0.15-sf-intent-layers.md §4.2 (IL-W2): an tl_edit_file call that
  // already passed `guardExecutionEdit` this task epoch opens the write
  // frontier even for a "answer"-profile contract (§3's 「edit が本当に来る
  // なら層2で開く」) — WITHOUT touching `profile` itself (the certificate's
  // own fingerprint/obligations/theorem stay computed exactly as they were
  // for the declared profile; only the SET OF HANDLES this contract may
  // mutate widens to the same `provedImplementation` set a genuinely
  // declared non-answer profile falls through to below).
  editObserved = false,
  workspace?: string,
): string[] {
  if (profile === "answer" && !editObserved) return [];
  if (profile === "wiring") {
    // A wiring certificate's writable set is its edit_frontier ALONE (the
    // wiring write protocol), so prior-epoch evidence is deliberately excluded.
    return [...new Set(result.wiring?.edit_frontier ?? [])].slice(0, 12);
  }
  const fromWiring = result.wiring?.edit_frontier ?? [];
  const fromChange = result.change_contract?.obligations
    .filter((obligation) => obligation.action === "edit" && obligation.status === "ready" && obligation.handle)
    .map((obligation) => obligation.handle!) ?? [];
  // r4-should-fix-26-propagation-route residual (2026-09-14): `obligations`'
  // generic "surface-content"/"behavior-body"/etc. proofs carry EVERY served
  // surface as evidence once "proved" — including a surface the query names
  // under its own explicit read/explain lead — so this fallback used to
  // re-open write authority `buildTaskChangeContract`'s `change_contract`
  // (above) had already correctly closed for that path. Same veto, same
  // shared source of truth (`requestItems.ts::requestItemLeads`); see that
  // function's own doc and `buildTaskChangeContract`'s call site.
  // BLOCKER 61/62 (AC1, round 12): the read-lead veto is now one of three, all
  // asked of `writeAuthorityVeto` — the SAME predicate
  // `buildTaskChangeContract` consults, so the two producers cannot disagree
  // about who may write.
  const veto = writeAuthorityVeto(query, editObserved, workspace);
  const whyOfPath = new Map(
    codeTaskPackSurfaces(result.surfaces).map((surface) => [surface.path, surface.why] as const),
  );
  const auxiliaryPaths = new Set(result.surfaces.filter(isAuxiliaryEnumSurface).map(surface => surface.path));
  const vetoedPath = (path: string): boolean =>
    auxiliaryPaths.has(path) || veto.reasonFor(path, whyOfPath.get(path)) !== undefined;
  const provedImplementation = obligations
    .filter((obligation) => obligation.status === "proved" && obligation.kind !== "explicit-identifier")
    .flatMap((obligation) => (obligation.evidence ?? [])
      .filter((evidence) => !vetoedPath(evidence.path))
      .map((evidence) => evidence.handle));
  const createTarget = result.create_target?.path ? [result.create_target.path] : [];
  // Create-only context surfaces are read-only imitation evidence, not edit targets.
  // Mixed create+edit requests retain independent wiring/change obligations.
  //
  // THE EMPTY RETURN IS LOAD-BEARING — do not "fix" it (2026-08-30, F-V13-3
  // wave; measured, not reasoned). Returning `[...createTarget]` here looks
  // like the obvious repair for "a create pack does not authorize its own
  // create target", and it is wrong twice over:
  //
  //  (a) It is unnecessary. `recordExecutionContract` (state/session.ts, the
  //      2026-07-25 T13 refuse-only-fence guard) CLEARS the fence outright for
  //      an edit-terminal certificate with no handles, no action paths and no
  //      evidence — which is exactly a create-only pack — so the create is
  //      ungated. Verified end to end through the real dispatch, including the
  //      case where the same lane already holds admissible material (so the
  //      guard does NOT fire and the fence installs with an empty frontier):
  //      the `edits[]` create still lands, authorized by server.ts's own
  //      create pin (`create_target.authorized_by:"explicit-cwd"`).
  //  (b) It closes discovery. A non-empty frontier makes this a real prepared
  //      fence, so the NEXT task_pack of an unrelated task in the same session
  //      is refused `prepared-discovery-closed` — a single-lane wire change,
  //      caught by replayCorpus's tew3_2/tew3_3 (a create pack followed by an
  //      enum-addition pack).
  //
  // The create refusal observed in the field (F-V13-3, v0.13.0 decision run)
  // was NOT this: the lane's fence held a PEER lane's certificate. That is
  // fixed in the five lane-scoped stores, not here.
  if (createTarget.length > 0 && fromWiring.length === 0 && fromChange.length === 0) return [];
  const merged = [...new Set([
    ...createTarget, ...fromWiring, ...fromChange, ...provedImplementation,
    // Last, so the cap can only ever evict prior-epoch entries.
    ...priorEpoch,
  ])];
  // BLOCKER 34 fail-closed guard (2026-09-14, review round 5): every channel
  // above (`provedImplementation`, `priorEpochActionFrontier`'s own two
  // sub-sources) already filters itself by `readOnlyLeadPaths` individually
  // — this is the SAME check applied ONCE MORE, structurally, at the final
  // union, so a future channel added here without remembering to consult
  // `readOnlyLeadPaths` (the exact shape of the bug SHOULD-FIX 31's own new
  // continuation-donation mechanism reopened) can never arm the certificate
  // with a path this query's own wording explicitly marked read-only.
  // `fromWiring` is exempt (mirrors `buildTaskChangeContract`'s own
  // `connection === undefined` scoping): a wiring pack's `edit_frontier` is a
  // different, already call-graph-proved mechanism this invariant does not
  // second-guess.
  // BLOCKER 61/62 (AC1, round 12): the structural final-union guard now asks the
  // SHARED predicate, so it also catches a token-match-only surface the request
  // never names and a NUL-stripped serve no `edits[]` shape can write. It is no
  // longer short-circuited on `readOnlyLeadPaths.size === 0`: the round-11 leak
  // reached `src/http.ts` through a query that HAD a read-lead row, but the
  // nul-stripped half (BLOCKER 62) fires on a query with no lead rows at all
  // (`In src/retry.ts, set MAX_RETRIES to 5.` produces one `edit` row and no
  // `read` row), and skipping the guard for that shape is exactly how round 11's
  // false certificate got out.
  const wiringExempt = new Set(fromWiring);
  const surfacesForGuard = codeTaskPackSurfaces(result.surfaces);
  const pathOfHandle = new Map([
    ...(result.frontier_index ?? []).filter(row => typeof row.handle === "string")
      .map(row => [row.handle!, row.path] as const),
    ...surfacesForGuard.map((surface) => [surface.handle, surface.path] as const),
  ]);
  const whyOfHandle = new Map(surfacesForGuard.map((surface) => [surface.handle, surface.why] as const));
  const whyOfSurfacePath = new Map(surfacesForGuard.map((surface) => [surface.path, surface.why] as const));
  const guarded = merged.filter((entry) => {
    if (wiringExempt.has(entry)) return true;
    const historical = workspace === undefined ? undefined
      : handleTable.get(entry) ?? rehydrateHandleEntry(entry, workspace);
    const historicalPath = historical !== undefined && historical.workspaceRoot === workspace
      && (historical.lane ?? "") === currentSessionLane() ? historical.path : undefined;
    const surfacePath = pathOfHandle.get(entry) ?? historicalPath ?? entry;
    const why = whyOfHandle.get(entry) ?? whyOfSurfacePath.get(surfacePath);
    return veto.reasonFor(surfacePath, why) === undefined;
  });
  return guarded.slice(0, 12);
}

export const MAX_WORKSPACE_STATE_INVENTORY_FILES = 10_000;

export const MAX_WORKSPACE_STATE_HASH_BYTES = 4 * 1024 * 1024;

export interface WorkspaceInventoryState {
  fingerprint: string;
  files: number;
  complete: boolean;
}

/**
 * Cheap invalidation fingerprint over the walked source inventory. Content
 * hashes for action-bearing evidence files are added separately below. If the
 * inventory cannot be proved complete, exact-call caching fails closed.
 *
 * turn-economy wave 3 (V2): keyed on (relPath, size) — NOT mtime. E2 forensics
 * (run signal5-3): a byte-identical task_pack re-call "in a row" re-served the
 * full ~12-14KB pack instead of the sub-1KB `pack_unchanged` acknowledgement,
 * because `mtimeMs` folded into this fingerprint (and thus into
 * workspace_state.fingerprint) flipped on ANY file's mtime change between the
 * two calls — even an UNRELATED file, even a no-op rewrite with byte-identical
 * content (a formatter pass, an edit-then-revert, a checkout). tryServeCachedPack
 * then saw a "changed" workspace and recomputed. mtime is a false-positive-prone
 * proxy for change; (relPath, size) is content-stable across those no-op touches
 * while still catching add/remove (the sorted relPath set) and any size-changing
 * edit. A same-size in-place edit to an UNSERVED file is the only change this no
 * longer flags here — an accepted, negligible narrowing, since every SERVED
 * surface is content-sha revalidated separately (surfaceFileSha, evidence hashes)
 * and the dedup only fires on a byte-identical re-request.
 */
export function computeWorkspaceInventoryState(workspace: string): WorkspaceInventoryState {
  const files = walkCodeFiles(workspace, {})
    .map((file) => file.relPath)
    .sort();
  const complete = files.length <= MAX_WORKSPACE_STATE_INVENTORY_FILES;
  const inventory = complete ? files : files.slice(0, MAX_WORKSPACE_STATE_INVENTORY_FILES);
  const records: Array<[string, number]> = [];
  const rootReal = resolveReal(workspace);
  // The native resolver, as resolveReal's on Windows: the JS one takes an lstat per path segment there.
  const realOf = process.platform === "win32" ? fs.realpathSync.native : fs.realpathSync;
  for (const relPath of inventory) {
    const abs = safeResolve(relPath, workspace);
    if (abs === undefined) continue;
    try {
      const real = realOf(abs);
      if (!isWithin(real, rootReal)) continue;
      const stat = fs.statSync(real);
      records.push([relPath, stat.size]);
    } catch {
      return {
        fingerprint: shaOfText(JSON.stringify(records)),
        files: files.length,
        complete: false,
      };
    }
  }
  return {
    fingerprint: shaOfText(JSON.stringify(records)),
    files: files.length,
    complete,
  };
}

export function evidenceFileState(workspace: string, relPath: string): string | undefined {
  const abs = safeResolve(relPath, workspace);
  if (abs === undefined) return undefined;
  try {
    const real = fs.realpathSync(abs);
    if (!isWithin(real, resolveReal(workspace))) return undefined;
    const stat = fs.statSync(real);
    if (!stat.isFile()) return undefined;
    if (stat.size > MAX_WORKSPACE_STATE_HASH_BYTES) {
      return `large:${stat.size}:${Math.trunc(stat.mtimeMs)}`;
    }
    // served-bytes: not-served (content sha only)
    return shaOfBytes(readFileForRequest(real));
  } catch {
    return undefined;
  }
}

export function buildTaskWorkspaceState(
  result: TaskPackResult,
  workspace?: string,
  inventory?: WorkspaceInventoryState,
): TaskWorkspaceState {
  const evidence = [...new Map(
    (result.surfaces as TaskPackResultSurface[]).map((surface) => [surface.path, surface] as const),
  ).values()]
    .sort((left, right) => left.path.localeCompare(right.path))
    .map((surface) => {
      const diskState = workspace ? evidenceFileState(workspace, surface.path) : undefined;
      const servedState = isArtifactTaskPackSurface(surface)
        ? `${surface.handle}:${surface.size}`
        : shaOfText(surface.code ?? surface.code_unchanged ?? `${surface.handle}:${surface.range}`);
      return [surface.path, diskState ?? servedState];
    });
  const literalUniverseState = result.literal_source_absence === undefined
    ? undefined
    : {
        fingerprint: result.literal_source_absence.universe_fingerprint,
        files: result.literal_source_absence.universe_paths,
        complete: result.literal_source_absence.universe_complete,
      };
  const inventoryState = literalUniverseState
    ?? (workspace
      ? inventory ?? computeWorkspaceInventoryState(workspace)
      : { fingerprint: "no-inventory", files: 0, complete: false });
  const scope = inventoryState.complete ? "evidence-plus-inventory" : "served-evidence";
  return {
    version: 1,
    fingerprint: shaOfText(JSON.stringify({
      evidence,
      inventory: inventoryState.complete ? inventoryState.fingerprint : undefined,
    })),
    scope,
    evidence_files: evidence.length,
    inventory_files: inventoryState.files,
    inventory_complete: inventoryState.complete,
  };
}

export function buildDecisionEvidenceModel(
  terminalAction: "answer" | "edit",
  obligations: readonly TaskReadinessObligation[],
  falsification: TaskFalsificationReport,
  risk: TaskReadinessRisk,
): TaskDecisionEvidenceModel {
  const confidence = Math.max(0, Math.min(1, 1 - risk.estimated_false_ready_risk));
  return {
    version: 1,
    decision: terminalAction,
    claims: obligations.map((obligation) => ({
      id: obligation.id,
      kind: obligation.kind,
      status: obligation.status === "proved" ? "supported" : "unresolved",
      reason: (obligation.reason ?? obligation.status).slice(0, 180),
      evidence_handles: [...new Set((obligation.evidence ?? []).map((item) => item.handle))].slice(0, 6),
      ...(obligation.evidence_ids?.length ? { evidence_ids: obligation.evidence_ids.slice(0, 8) } : {}),
      confidence: obligation.status === "proved" ? confidence : 0,
    })),
    counterexamples: falsification.counterexamples.slice(0, 2),
    unresolved: [...new Set([
      ...obligations.filter((obligation) => obligation.status !== "proved").map((obligation) => obligation.id),
      ...falsification.unresolved,
    ])].slice(0, 12),
  };
}

/** `queries` is OR-matched and capped per call (server.ts find dispatch: 10, or 5 with TL_EFF_WIDE_FIND=0); 5 fits either cap. */
export const UNCOVERED_IDENTIFIER_FIND_MAX = 5;

/**
 * W9 (2026-08-22) — THE ONE BATCHED FIND THAT CLOSES AN UNCOVERED-IDENTIFIER GAP.
 *
 * A pack whose `answer-explicit-symbol-focus` shortcut resolved ONE query
 * identifier lands `coverage:"focused"` on that one symbol, while the
 * obligation pass leaves `identifier:<other>` uncovered. The gap built for it
 * (`ambiguous-target`, below) carried NO call, so the projector fell through to
 * `servedEvidenceZoom` — a same-handle remaining-range zoom, which for the live
 * repro was the served file's 519-byte `using` header. That zoom is a dead end
 * FOR THE GAP IT WAS ISSUED FOR by construction: the identifier is provably not
 * in this file's body, so widening this file's window cannot produce it. The
 * caller then paid its own find+read fan-out for the rest of the path.
 *
 * The recovery is the call the gap actually needs, batched into ONE search:
 * `tl_search_files action=find queries=[<every still-uncovered identifier>]`.
 *
 * FOUR STRICTNESS RULES, so this can never widen into a speculative find:
 *  0. `coverage:"complete"` is EXCLUDED. That value is model.ts's promise that
 *     every required role is covered and every query concern is addressed —
 *     "trust it" — so a find issued against it would contradict the pack's own
 *     claim, exactly the contradiction `complete-coverage-forbids-discover-gaps`
 *     encodes and `discoveryBundleNext` opens with. Caught live by replay case
 *     ds8 (colloquial `QuoteOrchestrator` resolved semantically on a complete
 *     pack): re-siting its "act on the served evidence" grant onto a find for a
 *     name the pack had ALREADY resolved would have bought a round trip and
 *     lost a served answer. `focused` and `partial` are the honest targets —
 *     `focused` in particular claims "one confident site, no fan-out", which an
 *     uncovered query identifier directly contradicts.
 *  1. ONLY `explicit-identifier` obligations — identities the QUERY named
 *     literally (`explicitCodeIdentifiers`), never an inferred facet or token.
 *  2. The absence test is `exactIdentifierEvidence` — the SAME word-boundary
 *     matcher that marked the obligation uncovered, over served body + symbol
 *     only. Never a substring test, so `Mount` inside `DriveMounter` is not
 *     "found" and, conversely, a token this pack really did serve never earns
 *     a find.
 *  3. A VERIFIED-ABSENT identifier is dropped: its zero-occurrence fact is
 *     already decision-grade (the guide's "absence is meaning" contract), so
 *     re-searching it is the re-grep the protocol forbids.
 *
 * Returns `undefined` when nothing qualifies, which leaves every existing
 * catch-all — including the served-evidence zoom for packs with NO uncovered
 * identifiers — exactly as it was.
 */
export function uncoveredIdentifierFindCall(
  result: TaskPackResult,
  obligations: readonly TaskReadinessObligation[],
  query?: string,
  workspace?: string,
): ContinuationCall | undefined {
  // 2026-10-29: an uncovered anchor the workspace defines is read at its
  // declaration's own span — the `find` below is the fallback for a name whose
  // declaration is not known.
  const definitionRead = query === undefined || workspace === undefined ? undefined : anchorDefinitionGap(obligations, query, workspace);
  if (definitionRead !== undefined) return definitionRead.next_call;
  if (result.coverage === "complete") return undefined;
  const served = codeTaskPackSurfaces(result.surfaces).filter(hasServedCode);
  const verifiedAbsent = new Set(verifiedAbsentIdentifiersFor(result).map(normIdent));
  const seen = new Set<string>();
  const tokens: string[] = [];
  for (const obligation of obligations) {
    if (obligation.status === "proved") continue;
    if (obligation.kind !== "explicit-identifier") continue;
    if (!obligation.id.startsWith("identifier:")) continue;
    const identifier = obligation.id.slice("identifier:".length);
    // A dotted member the request names (`res.redirect`) is one literal to find.
    if (!/^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*$/u.test(identifier)) continue;
    const key = normIdent(identifier);
    if (seen.has(key) || verifiedAbsent.has(key)) continue;
    if (exactIdentifierEvidence(served, identifier).length > 0) continue;
    seen.add(key);
    tokens.push(identifier);
    if (tokens.length >= UNCOVERED_IDENTIFIER_FIND_MAX) break;
  }
  if (tokens.length === 0) return undefined;
  return { tool: "tl_search_files", arguments: { action: "find", queries: tokens } };
}

export function buildCapabilityGaps(
  result: TaskPackResult,
  obligations: readonly TaskReadinessObligation[],
  nextCall: ContinuationCall | undefined,
  awaitingUserInput: boolean,
  query?: string,
  workspace?: string,
): TaskCapabilityGap[] | undefined {
  const uncovered = obligations.filter((obligation) => obligation.status !== "proved").map((obligation) => obligation.id);
  const gaps: TaskCapabilityGap[] = [];
  // Retrieval caps are known inability to inspect a requirement, never proof
  // that it is absent. Keep these disclosures ahead of the bounded gap list.
  for (const obligation of obligations.filter((entry) => entry.id.startsWith("request-item:compound-request:"))) {
    gaps.push({
      kind: "request-item-undetermined",
      recoverable: false,
      reason: obligation.reason ?? "compound discovery was bounded before every requested point was inspected",
      obligation_ids: [obligation.id],
    });
  }
  if (result.missing.some((item) => item.startsWith("(invalid paths[] entry"))) {
    gaps.push({
      kind: "invalid-request",
      recoverable: true,
      reason: "one or more caller-supplied paths entries are malformed",
    });
  }
  // BLOCKER 25 (2026-09-14, review round 4): a file the REQUEST NAMED that this
  // response could not read. Pushed BEFORE the three mutually-exclusive arms
  // below so the `.slice(0, 3)` at the end can never drop it, and `refs` carry
  // the path itself — `projectGaps` projects `obligation_ids` onto
  // `decision.gaps[].refs`, which is how a `discover` names what is hidden.
  // `recoverable: false` and no `next_call`: `readCached` failed, so there is no
  // bounded call this server can vouch for that would produce those bytes
  // (permissions and text-decodability are not fixed by asking again). The
  // caller learns WHICH file and WHY, which is what it can act on.
  for (const entry of result.unreadable_named_paths ?? []) {
    gaps.push({
      kind: "missing-evidence",
      recoverable: false,
      reason: `this request names ${entry.path}, which could not be served (${entry.reason})`,
      obligation_ids: [`${UNREADABLE_NAMED_PATH_PREFIX}${entry.path}`],
    });
  }
  if (result.route?.action === "fallback_native") {
    gaps.push({
      kind: "unsupported-operation",
      recoverable: false,
      reason: result.route.reason,
    });
  } else if (awaitingUserInput) {
    // W9: the gap NAMES its own recovery when one exists. `TaskCapabilityGap`
    // has always had `next_call` (the missing-evidence branch below uses it);
    // this arm simply stopped being the one gap kind that could never carry a
    // call. The wire projection of a gap is `code` + `refs` (§4.4), so this
    // costs no response bytes — the projector reads it to replace the dead
    // same-handle zoom it would otherwise emit as `decision.discover.next`.
    const identifierFind = uncoveredIdentifierFindCall(result, obligations, query, workspace);
    gaps.push({
      kind: "ambiguous-target",
      recoverable: true,
      reason: result.route?.reason ?? "repository evidence does not determine one safe target",
      ...(uncovered.length > 0 ? { obligation_ids: uncovered.slice(0, 8) } : {}),
      ...(identifierFind ? { next_call: identifierFind } : {}),
    });
  } else if (uncovered.length > 0 || result.missing.length > 0) {
    gaps.push({
      kind: "missing-evidence",
      recoverable: nextCall !== undefined,
      reason: nextCall
        ? "a bounded evidence call can resolve the remaining semantic obligation"
        : "required semantic evidence is not present in the served pack",
      ...(uncovered.length > 0 ? { obligation_ids: uncovered.slice(0, 8) } : {}),
      ...(nextCall ? { next_call: nextCall } : {}),
    });
  }
  // DESIGN-v0.15 R1 (2026-09-07): an explicit request item this pack closed
  // by VERIFIED ABSENCE (design §4.2) — see `TaskPackResult.
  // request_item_absences`'s own doc comment. ADDITIVE and never gates
  // `decision.kind` by itself: appended after the blocking arms above (so a
  // genuine blocking gap keeps priority under the `.slice(0,3)` cap below),
  // and this gap's own `recoverable:false` never installs a `next_call` — a
  // verified absence has nothing further to fetch. The wire projection
  // (`decisionWire.ts`'s `projectGaps`) only ever runs from a `discover`
  // decision (D-4), so this rides the wire exactly when some OTHER open
  // point keeps the pack from closing `act.answer`/`act.edit` outright —
  // never by itself changing which decision this pack reaches.
  for (const absence of result.request_item_absences ?? []) {
    // R-D2 (2026-09-21, item B): a could-not-determine entry is not a
    // verified absence (see `TaskPackResult.request_item_absences`'s own doc
    // comment) and the orchestrator ruling scopes its NEW code word to the
    // `certificate.gaps` STRING array only (no new `kind` on this STRUCTURED
    // `TaskCapabilityGap` shape). Rendering it here as `request-item-absent`
    // would be the exact false "no occurrence" claim this fix exists to
    // avoid, so it is skipped: the ALL-TOPIC pass that minted it is
    // non-blocking by design (invariant (iv)) and never the reason this pack
    // is `discover`, and it still reaches the wire via `certificate.gaps`
    // once the pack certifies.
    //
    // R2-T2 (2026-09-30, review-0929, orchestrator ruling — supersedes the
    // "certificate.gaps only" scoping above): "once the pack certifies" never
    // came for a `discover` whose `next` leads to a non-pack response (a plain
    // range read), so an undetermined point was named NOWHERE in that chain
    // (measured: 「…の役割を説明し、ドキュメントを更新してください。」 once
    // ドキュメント became undetermined). It now rides `decision.gaps` under its
    // OWN additive code `request-item-undetermined` — exactly parallel to
    // `request-item-absent` below (same refs shape, `recoverable:false`, no
    // call, never gating `decision.kind`), never under the absent code.
    if (absence.undetermined === true) {
      gaps.push({
        kind: "request-item-undetermined",
        recoverable: false,
        reason: absence.undetermined_reason ?? `${absence.term} could not be determined either way — not a verified absence`,
        obligation_ids: [absence.id, absence.term],
      });
      continue;
    }
    // FIX-G: a verified-EMPTY facet (see `request_item_absences`' doc) is
    // covered, not absent — same reasoning as the undetermined skip above:
    // it reaches the wire through `certificate.gaps` once the pack certifies.
    if (absence.empty === true) continue;
    // 2026-11-02 (external evaluation T2): a name the request asks to ADD is
    // the thing to create, never a missing-code gap — the certificate reader
    // discloses it as `request-item-create` (see the model's `create` field).
    if (absence.create === true) continue;
    // Review finding 2(c) fix (2026-09-08): same qualification rule as
    // `decisionWire.ts`'s `projectCertificate` (the OTHER `request_item_absences`
    // reader) so `decision.gaps` and `decision.certificate.gaps` never
    // disagree about the same entry — "scope complete" only when the scan
    // truly excluded nothing; otherwise the excluded-path count, mirroring
    // `tl_search_files`' own `absence.caveat` phrasing.
    const qualifier = absence.scope_complete
      ? "; scope complete"
      : `; ${absence.omitted_count} ${absence.omitted_count === 1 ? "path" : "paths"} excluded from the scan`;
    gaps.push({
      kind: "request-item-absent",
      recoverable: false,
      // R-B3 (ruling 5): a served-but-incidental absence (the term DOES occur)
      // reuses the policy's own wording for it, never "no occurrence".
      reason: absence.incidental === true
        ? `only an incidental mention of ${absence.term} in served workspace files${qualifier}`
        : `no occurrence of ${absence.term} in scanned workspace files${qualifier}`,
      obligation_ids: [absence.id, absence.term],
    });
  }
  return gaps.length > 0 ? gaps.slice(0, 3) : undefined;
}

export function buildFalsificationReport(
  result: TaskPackResult,
  profile: TaskProfile,
  obligations: readonly TaskReadinessObligation[],
): TaskFalsificationReport {
  const checked = ["required-surface-content", "uncovered-obligations"];
  if (result.route?.action === "answer_from_handles" || result.route?.action === "edit_from_handles") {
    checked.push("bounded-counterexample-probe");
  }
  if (profile === "answer") checked.push("callable-behavior-evidence");
  if (profile === "wiring") checked.push("producer-consumer-implementation", "callable-insertion-site");
  if (profile === "artifact_build") checked.push("artifact-to-implementation-target");
  if (profile === "multi_concern") checked.push("independent-concern-frontiers");
  const counterexamples = codeTaskPackSurfaces(result.surfaces)
    // TL142-05: a relation-gated counterexample's `why` is now
    // "<relation> (readiness-falsification-counterexample)", not the bare
    // literal — `.includes` keeps both shapes in this report; the ONLY
    // producer of this suffix is the relation gate above, so no OTHER `why`
    // tag can accidentally match here.
    .filter((surface) => (surface.why ?? "").includes("readiness-falsification-counterexample"))
    .map((surface) => `${surface.path}:${surface.range}`)
    .slice(0, READINESS_PROBE_MAX_SURFACES);
  return {
    version: 1,
    checked,
    counterexamples,
    unresolved: obligations.filter((obligation) => obligation.status === "uncovered").map((obligation) => obligation.id),
  };
}

export function estimateReadinessRisk(
  result: TaskPackResult,
  profile: TaskProfile,
  query: string,
  obligations: readonly TaskReadinessObligation[],
  falsification: TaskFalsificationReport,
): TaskReadinessRisk {
  const factors: string[] = [];
  let risk = 0.01;
  if (obligations.some((obligation) => obligation.status === "uncovered")) {
    risk = 1;
    factors.push("uncovered-required-obligation");
  } else {
    if (result.coverage === "focused") { risk += 0.01; factors.push("focused-not-complete"); }
    if (result.coverage === "partial") {
      const terminalRoute = result.route?.action === "answer_from_handles" || result.route?.action === "edit_from_handles";
      if (terminalRoute) {
        risk += 0.01;
        factors.push("partial-coverage-with-terminal-route");
      } else {
        risk += 0.5;
        factors.push("partial-coverage");
      }
    }
    // 2026-07-16a: an INLINED counterexample is served evidence the agent sees;
    // enrichment must not tip an otherwise-proved pack over the reject line.
    // Zero-risk factor kept for observability; competing evidence that could
    // NOT be incorporated still lands in the uncovered branch above (risk=1).
    if (falsification.counterexamples.length > 0) { factors.push("counterexample-incorporated"); }
    if (
      !(profile === "answer" && (
        result.answer_resolution !== undefined
        || hasExactNamedAnswerFacetEvidence(result, query)
      ))
      && codeTaskPackSurfaces(result.surfaces).some((surface) =>
        surface.required !== false
        && surface.content_completeness === "partial"
        && surface.anchors_served !== true
      )
    ) {
      risk += 0.2;
      factors.push("partial-surface-content");
    }
    const roots = new Set(codeTaskPackSurfaces(result.surfaces).map((surface) => projectRootOf(surface.path) ?? surface.path.split("/", 1)[0]));
    // 2026-07-16a: wiring/change_propagation/multi_concern are cross-root BY
    // TASK SHAPE (producer→consumer hookup, enum/schema fan-out) — spanning
    // roots is their completeness evidence, not a false-ready signal.
    const crossRootByShape = profile === "wiring"
      || profile === "change_propagation"
      || profile === "multi_concern"
      || profile === "artifact_build";
    if (roots.size > 1 && !crossRootByShape) { risk += 0.04; factors.push("multi-root-evidence"); }
    if (profile === "answer" && explicitCodeIdentifiers(result.profile_binding?.reason ?? "").length === 0) {
      // No extra penalty here: explicit query obligations are already checked.
    }
    if (profile === "wiring") {
      const implementations = new Set(codeTaskPackSurfaces(result.surfaces).filter((surface) => isImplementationPath(surface.path)).map((surface) => surface.path));
      if (implementations.size < 3) { risk += 0.03; factors.push("thin-wiring-path"); }
      else { risk += 0.02; factors.push("wiring-path"); }
    }
  }
  const estimated = Number(Math.min(1, risk).toFixed(3));
  return {
    policy: "selective-reject",
    estimated_false_ready_risk: estimated,
    max_false_ready_risk: READINESS_FALSE_READY_LIMIT,
    decision: estimated <= READINESS_FALSE_READY_LIMIT ? "accept" : "reject",
    factors,
  };
}

export const NEXT_CALL_SEARCH_ACTIONS = new Set(["find", "symbols", "references", "diff", "tree", "locate"]);

export const NEXT_CALL_GENERIC_QUERY_TERMS = new Set([
  "what", "should", "could", "would", "explain", "describe", "behavior", "feature", "issue", "system",
]);

/** A token made only of hiragana (plus the長音 mark) — see repairedNextCallTerms. */
export const HIRAGANA_ONLY_TERM_RE = /^[\p{Script=Hiragana}ー]+$/u;

/** R-B3 (ruling 6): the lowercase words of `query`'s generalised read-lead span — exactly the characters `maskReadLeadSpan` blanks (empty when the rule does not fire). */
export function readLeadSpanWords(query: string): ReadonlySet<string> {
  const masked = maskReadLeadSpan(query);
  if (masked === query) return new Set<string>();
  let lead = "";
  for (let i = 0; i < query.length; i++) lead += masked[i] === query[i] ? " " : query[i];
  return new Set(tokenizeForEpoch(lead).map((word) => word.toLowerCase()));
}

export function repairedNextCallTerms(query: string): string[] {
  const terms = tokenizeForEpoch(query)
    .filter((term) => !NEXT_CALL_GENERIC_QUERY_TERMS.has(term));
  // 2026-07-31: this list is consumed POSITIONALLY — terms[0] becomes the whole
  // query of the emitted next_call. tokenizeForEpoch splits CJK on script
  // boundaries, so a Japanese request's leading run is very often a
  // demonstrative or other function word carrying no search signal; a live pack
  // emitted `tl_search_files action=locate query="こんな"` from exactly that.
  // Han / Katakana / ASCII runs are the content-bearing ones, so rank the
  // hiragana-only runs last. Stable within each group, and a no-op for queries
  // with no hiragana at all.
  const contentful = terms.filter((term) => !HIRAGANA_ONLY_TERM_RE.test(term));
  const functional = terms.filter((term) => HIRAGANA_ONLY_TERM_RE.test(term));
  return [...contentful, ...functional].slice(0, 5);
}
