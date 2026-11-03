// changeAndReadinessEvidence — extracted implementation; imports point to the owning modules.
import * as path from "path";
import type { CallableDeclaration } from "./changeAndReadinessEvidence2.js";
import type { LineSpan } from "./sourceAndConcernTerms.js";
import type { TaskChangeContract } from "@tokenlighten/types";
import type { TaskChangeObligation } from "@tokenlighten/types";
import type { TaskChangeObligationKind } from "@tokenlighten/types";
import type { TaskPackResult } from "../model.js";
import type { TaskPackResultSurface } from "../model.js";
import type { TaskPackSurface } from "../model.js";
import type { TaskProfile } from "@tokenlighten/types";
import type { TaskReadinessEvidence } from "@tokenlighten/types";
import type { TaskVerifyObligation } from "@tokenlighten/types";
import { EDIT_CONTEXT_WHY } from "./focalFlow.js";
import { LISTED_ITEM_DERIVED_WHY } from "../listedScopeItems.js";
import { alternativeCoordinatedPaths } from "../requestItems.js";
import { asImpactSurface } from "./wiringEvidence2.js";
import { boundedWorkspaceText } from "./seedAdmission.js";
import { buildBasenameFrequency } from "../../locator/locateTaskContext.js";
import { buildVerificationManifest } from "../../../util/verificationPack.js";
import { callableDeclarationsIn } from "./changeAndReadinessEvidence2.js";
import { codeTaskPackSurfaces } from "../artifactSections.js";
import { declarationCarriesInlineBody } from "./changeAndReadinessEvidence2.js";
import { deriveVerifyObligations } from "../sfVerifyObligations.js";
import { escapeRegExp } from "../../search/find/findText.js";
import { explicitCodeIdentifiers } from "./anchorFocus2.js";
import { extractIdentifiers } from "../../locator/locateTaskContext.js";
import { fileNamesInPathSpans } from "../../../util/queryShape.js";
import { getIntentEditObserved } from "../../../state/session.js";
import { hasRequestedMutationIntent } from "./coverageAndContinuation3.js";
import { hasSufficientEditContent } from "./wiringEvidence2.js";
import { identifierNamesSymbol } from "./anchorFocus3.js";
import { isArtifactConsumerSurface } from "../artifactConsumers.js";
import { isAuxiliaryEnumSurface } from "../auxiliaryEnumContextIntegration.js";
import { isCallableBodyLine } from "./changeAndReadinessEvidence2.js";
import { isEnumLikeQueryShaped } from "./roleAndConcernScope2.js";
import { isWholeAuthoritySurface } from "./changeAndReadinessEvidence2.js";
import { lineSpansCover } from "./sourceAndConcernTerms.js";
import { literalFirstRelation } from "./literalAndConcernSeeds.js";
import { literalFirstRoutingEnabled } from "../../../util/flags.js";
import { matchBasenameTokens } from "../../locator/locateTaskContext.js";
import { normIdent } from "./createAndWiringEndpoints2.js";
import { obligationKindForRole } from "./wiringProfiles2.js";
import { pathClassCanCarryCode } from "./seedAdmission.js";
import { readCached } from "./packBasics2.js";
import { readinessEvidence } from "./changeAndReadinessEvidence2.js";
import { requestItemLeads } from "../requestItems.js";
import { servedLineSpansOf } from "./sourceAndConcernTerms.js";
import { servedSurfaceText } from "./changeAndReadinessEvidence2.js";
import { sfVerifyFirstEnabled } from "../../../util/flags.js";
import { surfaceBodyContainsToken } from "./changeAndReadinessEvidence2.js";
import { surfaceWhyHasMarker } from "./recursiveClosure.js";
import { termOccursOutsideComments } from "./seedAdmission.js";
import { trace } from "../../../util/trace.js";
import { walkCodeFiles } from "../../../tools/walkRepo.js";

export function obligationStage(kind: TaskChangeObligationKind): number {
  switch (kind) {
    case "definition":
    case "configuration":
    case "source":
      return 0;
    case "implementation":
    case "persistence":
      return 1;
    case "integration":
      return 2;
    case "presentation":
      return 3;
    case "style":
      return 4;
    case "documentation":
    case "verification":
      return 5;
  }
}

export function taskChangeContractReason(
  surface: TaskPackSurface,
  kind: TaskChangeObligationKind,
  action: "edit" | "review",
): string {
  if (kind === "source") return "review the producer contract and emitted value before wiring its consumer";
  if (action === "review") return surface.why ?? "review this related surface; edit only if its behavior must change";
  return surface.edit_intent
    ?? surface.why
    ?? "update the " + surface.role + " surface and preserve its existing contract";
}

export function shouldBuildTaskChangeContract(
  query: string,
  result: TaskPackResult,
  profile: TaskProfile,
): boolean {
  if (profile === "answer" || result.route?.action !== "edit_from_handles") return false;
  // A wiring profile still hunting an endpoint is the authority for that
  // work — a parallel change_contract would double-report the same missing
  // endpoint (taskContracts.spec pins its absence).
  if (result.wiring !== undefined && result.wiring.missing.length > 0) return false;
  const editIntent = hasRequestedMutationIntent(query)
    || profile !== "generic";
  if (!editIntent) return false;
  const surfaces = codeTaskPackSurfaces(result.surfaces);
  if (surfaces.length === 0) return false;
  return profile !== "generic"
    || isEnumLikeQueryShaped(query)
    || (result.required_surfaces?.length ?? 0) > 1
    || surfaces.length > 1;
}

/**
 * Issue #4 (2026-08-21): a "filename-match" surface whose only reason for
 * being in the pack is a query-identifier FRAGMENT (a compound identifier
 * merely containing this file's basename word as a substring — e.g. query
 * "buildInitializeInstructions" against packages/.../serverInstructions.ts)
 * or a lone generic-noun coincidence (query "issue" against a file merely
 * named "cumulativeReissueReceipt") is not real evidence once a DIFFERENT
 * surface in the SAME pack already carries the exact, workspace-unique
 * identifier the query actually names.
 *
 * Re-derives that admission with matchBasenameTokens' `strict` mode (see
 * its own history comment) rather than re-implementing the rule: this is a
 * POST-HOC surface filter, not a change to the locator's live candidate
 * pipeline. matchBasenameTokens' `resolvedSymbolFiles` fragment-suppression
 * was tried as a live Layer 5a input first and reverted — it fixed this bug
 * correctly in isolation, but silently starved an UNRELATED locator
 * mechanism (locateTaskContext's two-domain-wiring coverage/margin gate) of
 * matched-token score mass it happened to depend on. Filtering the FINAL
 * surface list here instead touches only change_contract's own obligation
 * formation — nothing upstream of it changes, so no other locate-level
 * heuristic can be starved of anything it was reading.
 *
 * Deliberately narrow: only ever REMOVES a surface whose `why` is exactly
 * "filename-match" (never a symbol/structural/anchor-focus/exact-text hit),
 * and only when the pack carries at least one workspace-unique resolved
 * identifier surface to check fragments against — a pack with no such
 * anchor is a no-op (nothing to fragment FROM), and every removal is
 * re-provable on demand via the same exported matchBasenameTokens a unit
 * test can call directly.
 */
export function suppressFragmentOnlyFilenameMatches(
  workspace: string,
  query: string,
  surfaces: TaskPackResultSurface[],
): void {
  const filenameMatchSurfaces = codeTaskPackSurfaces(surfaces).filter((s) => s.why === "filename-match");
  if (filenameMatchSurfaces.length === 0) return;

  const pathTokens = extractIdentifiers(query).map((t) => t.toLowerCase());
  if (pathTokens.length === 0) return;

  // Anchors: a surface whose symbol IS an explicit query identifier — an
  // anchor-focus resolution (server.ts @ buildInitializeInstructions) or a
  // plain exact-symbol/query-symbol surface. Workspace-UNIQUE only: a
  // symbol name that resolves to >= 2 different files in this pack is
  // itself ambiguous and not a trustworthy anchor to fragment-suppress
  // siblings against.
  const resolvedSymbolFiles = new Map<string, Set<string>>();
  for (const s of codeTaskPackSurfaces(surfaces)) {
    if (!s.symbol) continue;
    const isAnchorWhy = s.why === "exact-symbol"
      || s.why === "query-symbol"
      || (typeof s.why === "string" && s.why.startsWith("anchor-focus: explicit query identifier "));
    if (!isAnchorWhy) continue;
    const key = s.symbol.toLowerCase();
    if (!pathTokens.includes(key)) continue; // only identifiers the query itself names
    let set = resolvedSymbolFiles.get(key);
    if (!set) { set = new Set(); resolvedSymbolFiles.set(key, set); }
    set.add(s.path);
  }
  for (const [key, files] of resolvedSymbolFiles) {
    if (files.size !== 1) resolvedSymbolFiles.delete(key); // not workspace-unique
  }
  if (resolvedSymbolFiles.size === 0) return;

  const frequency = buildBasenameFrequency(walkCodeFiles(workspace, {}));
  const toRemove = new Set<TaskPackResultSurface>();
  for (const s of filenameMatchSurfaces) {
    if (matchBasenameTokens(s.path, pathTokens, frequency, resolvedSymbolFiles) === null) {
      toRemove.add(s);
    }
  }
  if (toRemove.size === 0) return;
  const kept = surfaces.filter((s) => !toRemove.has(s));
  surfaces.length = 0;
  surfaces.push(...kept);
}

/**
 * W-VERIFY-GEN seam: attaches `TaskChangeContract.verify_obligations` from
 * the existing `buildVerificationManifest`'s own output (see
 * sfVerifyObligations.ts's file doc for exactly which fields are reused and
 * why no new discovery logic is added here). Flag-gated
 * (`TL_SF_VERIFY_FIRST`, default OFF) and fail-open: a derivation defect
 * must never break the change_contract itself, mirroring
 * `applySemanticFrontierState`'s own I-1 contract.
 *
 * Ruling F8 (FX-OH2, 2026-09-04): `ready` is the caller's own
 * `phase:"prepared"` readiness (`buildTaskChangeContract`'s `ready`, which is
 * exactly what `phase:"prepared"` reads back as `status === "ready"`) — a
 * `discover`/`await_input` pack short-circuits here, before
 * `buildVerificationManifest` even walks the workspace.
 */
// Exported for the ruling F8 pin (sfVerifyObligations.spec.ts): the
// `ready` gate's effect is a property of this seam alone, and pinning it
// through a whole discover-shaped pack would require constructing a fixture
// whose incompleteness is otherwise irrelevant to what F8 changed.
export function deriveTaskChangeContractVerifyObligations(
  obligations: readonly TaskChangeObligation[],
  workspace: string,
  ready: boolean,
): TaskVerifyObligation[] | undefined {
  if (!sfVerifyFirstEnabled() || !ready) return undefined;
  try {
    const editPaths = [...new Set(
      obligations.filter((o) => o.action === "edit").map((o) => o.path),
    )];
    const manifest = editPaths.length > 0 ? buildVerificationManifest(workspace, editPaths) : undefined;
    const derived = deriveVerifyObligations({
      changeContract: { obligations },
      verificationManifest: manifest,
      ready,
    });
    return derived.length > 0 ? derived : undefined;
  } catch (err) {
    try {
      trace(
        "sf_verify_gen_error",
        { message: err instanceof Error ? err.message : String(err) },
        workspace,
      );
    } catch {
      /* the trace channel is best-effort too */
    }
    return undefined;
  }
}

/**
 * BLOCKER 61 / BLOCKER 62 (AC1, 2026-09-14, review round 12) — ONE
 * WRITE-AUTHORITY PREDICATE.
 *
 * Rounds 8, 9, 10 and 11 each filed one half of the same question, and round 11
 * finally measured an ON-DISK WRITE to a file the query never names. Both
 * blockers are the same sentence — *a frontier entry was marked writable by a
 * construction that never consulted the authority evidence* — so they get ONE
 * predicate, consulted by BOTH producers (`buildTaskChangeContract`'s
 * `editRequired`, and `actionFrontierForCertificate`'s final structural union),
 * instead of a second veto per producer.
 *
 * Three independent reasons a path may not be written:
 *
 *  1. `read` LEAD (pre-existing, BLOCKER 34): the request's own wording asks to
 *     explain/review this file. `readOnlyLeadPaths`, unchanged.
 *  2. TOKEN-MATCH-ONLY EVIDENCE, UNNAMED BY THE REQUEST (BLOCKER 61): the
 *     surface was admitted because a query TOKEN happened to match an identifier
 *     in it (`why:"symbol hit for …"` / `"variant token match"` — the locator's
 *     weakest admission), and the request names no edit lead for that path.
 *     Round 11: `Explain how MAX_RETRIES works in src/retry.ts, and then set it
 *     to 5.` marked `src/http.ts` writable because the edit VERB `set` matched
 *     `SET_COOKIE` there, and `tl_edit_file` then applied a replacement to it. The
 *     locator half of that leak is closed in `requestItems.ts::
 *     stripValueOnlyLeadClauses`; this is the independent second half, so a
 *     token collision arriving by ANY other route (a genuinely named identifier
 *     that also occurs in an unrelated file) can never carry write authority
 *     either. Such a surface stays SERVED — it is discovery evidence, which is
 *     what the locator admitted it as; it is only not an authorized target.
 *  3. A NUL-STRIPPED SERVE (BLOCKER 62): `util/textDecode.ts::readServedText`
 *     serves a file whose NUL-free ratio is >= 0.99 with the NULs removed, while
 *     `detectWriteEncodingRisk` refuses to write ANY file with a NUL in its
 *     first 4096 bytes. Round 11 measured the two disagreeing about the same
 *     bytes: `act.edit`, frontier `[{path:"src/retry.ts", writable:true}]`, and
 *     an `tl_edit_file` refusal with `retry:"call"` that NO `edits[]` shape can
 *     satisfy. Refusing the write is right (writing the stripped text back would
 *     silently delete the NUL); the defect is certifying an edit the only
 *     sanctioned transition always refuses. One verdict per file: the pack
 *     already knows (the surface's own `why` carries `nul-stripped`), so it
 *     declines the authority instead.
 *
 * Gate 2 is scoped to a request that NAMES AT LEAST ONE FILE of its own, under
 * any lead. A path-less change request ("increase the premium multiplier in the
 * rating engine") has no lead rows at all, and there the locator's evidence IS
 * the only available target statement — so the gate stays off for it, exactly as
 * before.
 *
 * FIXALL-A (2026-09-14) — that scope used to require an EDIT lead specifically
 * (round 12's residual R1), which left the commonest BLOCKER-61 shape open:
 * `Explain how MAX_RETRIES works in src/retry.ts, and then update the
 * changelog.` has exactly one lead row, a READ on `src/retry.ts`, so
 * `editLeadPaths` was empty, the gate never ran, and `src/audit.ts` — admitted
 * solely because the edit verb `update` matched `UPDATE_MODE` in it — was
 * WRITABLE. The distinction that actually matters is not which LEAD the named
 * file carries but whether the request names a file AT ALL: once it does, a
 * file it never mentions cannot be the one it means, whatever a token collision
 * suggests. "The changelog" is a noun phrase, not a filename, and resolving it
 * by lexical proximity to whichever file happens to contain a matching token is
 * a guess — the pack still SERVES that surface as discovery evidence and the
 * caller can still name the file explicitly, which is what makes it writable.
 */
export const TOKEN_MATCH_ONLY_WHY_QUALIFIERS: ReadonlySet<string> = new Set([
  "nul-stripped", "caller-supplied",
]);

/**
 * True when every informative part of `why` says only "a query token matched an
 * identifier here". `why` is a `;`-joined qualifier list (see
 * `candidateToSurface`), so a stronger reason anywhere in it clears the surface.
 */
export function surfaceAdmittedByTokenMatchOnly(why: string | undefined): boolean {
  if (why === undefined || why === "") return false;
  const parts = why.split(";").map((part) => part.trim()).filter((part) => part.length > 0);
  const informative = parts.filter((part) => !TOKEN_MATCH_ONLY_WHY_QUALIFIERS.has(part));
  if (informative.length === 0) return false;
  return informative.every((part) => (
    part.startsWith("symbol hit for")
    || part === "variant token match"
    // FIXALL-A (2026-09-14): a raw `exact-text` hit (`whySummary`'s default
    // passthrough) is a literal match of a NON-distinctive query token against
    // this file's bytes — the weakest lexical admission the locator has, weaker
    // than the two above. Measured: `Implement a MIN_RETRIES constant to
    // src/cache.ts, and change "src/retry.ts".` made the re-export barrel
    // `src/index.ts` a required EDIT obligation because it contains the strings
    // "retry" and "cache", alongside the two files the request actually names.
    // `exact-text:distinctive` (`"matched distinctive identifier"`) is
    // deliberately NOT here: it is how an identifier-only request
    // (`Bump MAX_RETRIES to 5.`) legitimately finds its one file.
    || part === "exact-text"
  ));
}

/**
 * 2026-11-02 (external evaluation T2): every informative part of `why` is the
 * locator's file-name match (or one of the token-only admissions beside it):
 * the file is in the pack because its NAME shares a word with the request,
 * and nothing says its content relates to the change. A three-line test
 * fixture named after the project ("tests/.../flask.py" for a request about
 * flask) became a REQUIRED edit of a config-key change this way.
 */
export function surfaceAdmittedByFilenameMatchOnly(why: string | undefined): boolean {
  if (why === undefined || why === "") return false;
  const parts = why.split(";").map((part) => part.trim()).filter((part) => part.length > 0);
  const informative = parts.filter((part) => !TOKEN_MATCH_ONLY_WHY_QUALIFIERS.has(part));
  if (informative.length === 0 || !informative.includes("filename-match")) return false;
  return informative.every((part) => (
    part === "filename-match"
    || part.startsWith("symbol hit for")
    || part === "variant token match"
    || part === "exact-text"
  ));
}

/** The request spells `token` as a whole identifier/word (case- and underscore-insensitive), never as a substring of a longer word. */
export function requestSpellsWholeToken(query: string, token: string): boolean {
  const wanted = normIdent(token);
  if (wanted.length === 0) return false;
  for (const match of query.matchAll(/[A-Za-z0-9_]+/g)) {
    if (normIdent(match[0]) === wanted) return true;
  }
  return false;
}

/**
 * The request names this file: a path it spells (`fileNamesInPathSpans`), or
 * its bare file name as a whole word that is not also a directory name of the
 * workspace — a word that names a directory ("flask" for `src/flask/`) is the
 * project or a scope, not the fixture that happens to share it.
 */
export function requestNamesFileByWord(query: string, relPath: string, workspace: string | undefined): boolean {
  const base = path.posix.basename(relPath);
  const stem = base.replace(/\.[^.]+$/, "");
  if (fileNamesInPathSpans(query).some((name) => name.toLowerCase() === base.toLowerCase())) return true;
  if (stem.length < 3 || !requestSpellsWholeToken(query, stem)) return false;
  if (workspace === undefined) return true;
  const wanted = stem.toLowerCase();
  return !walkCodeFiles(workspace).some((file) =>
    file.relPath.toLowerCase().split("/").slice(0, -1).includes(wanted)
  );
}

/** True when this surface was served with its NUL characters stripped (BLOCKER 62). */
export function surfaceServedNulStripped(why: string | undefined): boolean {
  return why !== undefined && surfaceWhyHasMarker(why, "nul-stripped");
}

export interface WriteAuthorityVeto {
  /** Paths the request's own wording marks read-only (BLOCKER 34). */
  readonly readOnlyLeadPaths: ReadonlySet<string>;
  /** Is `path` barred from the writable frontier, and why? */
  readonly reasonFor: (path: string, why: string | undefined) => WriteAuthorityVetoReason | undefined;
}

/**
 * FIXALL-A group F (2026-09-14): a FOURTH reason — the request offers this path
 * as one of several ALTERNATIVES (`Update src/retry.ts or src/cache.ts …`) and
 * has not said which. `read-lead` would be the wrong sentence for it (the
 * request's wording does ask to edit it), so the veto names the ambiguity
 * instead of mislabelling it.
 */
export type WriteAuthorityVetoReason = "read-lead" | "token-match-only" | "nul-stripped" | "unresolved-alternative" | "edit-context" | "enum-derived" | "filename-match-only";

export function writeAuthorityVeto(query: string, editObserved = false, workspace?: string): WriteAuthorityVeto {
  const leads = requestItemLeads(query);
  const readOnlyLeadPaths = new Set(
    leads.filter((entry) => entry.lead === "read").map((entry) => entry.path),
  );
  // FIXALL-A (2026-09-14): gate 2's scope — every path the request names, under
  // any lead, not only the ones it names as edit targets. See the doc above.
  // (The old `editLeadPaths` set this replaced is gone; `readOnlyLeadPaths`
  // above still carries gate 1's own, separate question.)
  const namedPaths = new Set(leads.map((entry) => entry.path));
  // FIXALL-A group F (2026-09-14): the SAME structural test `requestItemLeads`
  // uses to hold an alternative down to `read`, imported rather than restated,
  // so the two can never disagree about which paths are alternatives.
  const alternatives = alternativeCoordinatedPaths(query);
  return {
    readOnlyLeadPaths,
    reasonFor: (path, why) => {
      // DESIGN-v0.15-sf-intent-layers.md §4.2 (IL-W2) — GATE-A, 2026-09-14: an
      // `tl_edit_file` call that already passed `guardExecutionEdit` THIS task
      // epoch is a stronger statement of intent than anything the request TEXT
      // says, and the three gates below are ALL request-text-derived (what the
      // wording asks for, which files it names, which of several alternatives
      // it left open). §4.2's whole premise is that a genuinely observed edit
      // overrides the wording — `sfIntentEditObservedE2E.spec.ts` pins exactly
      // that: `explain how computeTotal … in src/order.ts` is a read LEAD, yet
      // the caller has already edited that very file this task. Gate 3
      // (`nul-stripped`) is NOT suspended: it is a physical property of the
      // bytes (`detectWriteEncodingRisk` refuses that write however the
      // authority was earned), so certifying it would still promise an edit the
      // only sanctioned transition always refuses (BLOCKER 62).
      if (editObserved) return surfaceServedNulStripped(why) ? "nul-stripped" : undefined;
      // Served as a dependency of the located edit target (editContextCandidates).
      if (why?.startsWith(EDIT_CONTEXT_WHY) === true) return "edit-context";
      // Served to discharge a listed scope item (accountForListedScopeItems).
      if (why?.startsWith(LISTED_ITEM_DERIVED_WHY) === true) return "enum-derived";
      if (alternatives.has(path)) return "unresolved-alternative";
      if (readOnlyLeadPaths.has(path)) return "read-lead";
      // 2026-11-02 (external evaluation T2): a file admitted because its NAME
      // matched a request word, with no content relation to the change, is a
      // review candidate at most — unless the request names that file (a path
      // it spells, or the bare file name as a whole word that is not also a
      // directory of the workspace, i.e. the project's own name).
      if (
        surfaceAdmittedByFilenameMatchOnly(why)
        && !namedPaths.has(path)
        && !requestNamesFileByWord(query, path, workspace)
      ) return "filename-match-only";
      if (surfaceServedNulStripped(why)) return "nul-stripped";
      if (namedPaths.size > 0 && !namedPaths.has(path) && surfaceAdmittedByTokenMatchOnly(why)) {
        return "token-match-only";
      }
      return undefined;
    },
  };
}

/** The caller-facing sentence for each veto reason (obligation `reason`, <=180 chars). */
export const WRITE_AUTHORITY_VETO_REASON: Readonly<Record<WriteAuthorityVetoReason, string>> = {
  "read-lead": "the request's own wording asks to explain/review this file, not edit it",
  "unresolved-alternative":
    "the request offers this file as one of several alternatives and has not said which; name the one you mean before editing either",
  "token-match-only":
    "a query token matched an identifier here; this request never names this file as a change target, so it is discovery evidence, not a write target",
  "nul-stripped":
    "served with NUL characters stripped, so it cannot be written back without losing them: re-save this file as UTF-8 before editing it",
  "edit-context":
    "served as a definition the edit target depends on, so you need not look it up; it is context, not a change target",
  "enum-derived":
    "served for a place the request lists: it enumerates the enum as a whole, so the new value reaches it without an edit",
  "filename-match-only":
    "only this file's name matched a request word; nothing in the request relates to its content, so it is a review candidate, not a write target",
};

export function buildTaskChangeContract(
  query: string,
  result: TaskPackResult,
  workspace: string,
): TaskChangeContract {
  suppressFragmentOnlyFilenameMatches(workspace, query, result.surfaces as TaskPackResultSurface[]);
  // Artifact consumers are context the target's code will use, never change
  // obligations of their own (a consumer named like a query word would
  // otherwise turn into a required edit).
  const allSurfaces = codeTaskPackSurfaces(result.surfaces).filter((surface) => !isArtifactConsumerSurface(surface) && !isAuxiliaryEnumSurface(surface));
  const wiringFrontier = result.wiring?.status === "ready"
    ? new Set([...result.wiring.edit_frontier, ...result.wiring.review_frontier])
    : undefined;
  const surfaces = wiringFrontier === undefined
    ? allSurfaces
    : allSurfaces.filter((surface) => wiringFrontier.has(surface.handle));
  const primaryHandle = surfaces[0]?.handle;
  const concernHandles = new Set((result.concerns ?? []).flatMap((concern) => concern.handles));
  const requiredRoles = new Set(result.required_surfaces ?? []);
  const connection = result.wiring?.connections[0];
  const sourceHandle = connection?.source?.handle;
  const destinationHandle = connection?.destination?.handle;
  const adapterHandles = new Set([
    ...(connection?.supporting_handles ?? []),
    ...(result.wiring?.evidence_graph?.nodes
      .filter((node) => node.roles.includes("adapter"))
      .map((node) => node.handle)
      .filter((handle): handle is string => handle !== undefined) ?? []),
  ]);
  const normalizedQuery = normIdent(query);
  // r4-should-fix-26-propagation-route residual (2026-09-14): a path the
  // query names under its OWN explicit read/explain lead
  // (`requestItems.ts`'s `requestItemLeads` — the same per-item machinery
  // `explicitMultiEditRequestPaths` uses) must never earn edit authority
  // through the softer, name-only signals below (`explicitlyNamed`, the
  // `primaryHandle` positional fallback) merely because ANOTHER clause of
  // the same query edits a DIFFERENT file. Every query-derived builder's
  // writable frontier funnels through here:
  // `actionFrontierForCertificate` derives the certificate's writable
  // `action_frontier` from `change_contract.obligations` whose
  // `action === "edit"`, so gating `editRequired` here (rather than in each
  // builder that seeds `result.surfaces`) closes the propagation/
  // literal-first route's own independent seeding
  // (`buildPropagationTaskPack` / `buildSeededTaskPack`) along with every
  // other non-wiring builder that lands here, without re-deriving the
  // edit/read verb rule a second time. Scoped to `connection === undefined`
  // (a wiring pack's `wiringDestination` signal is a different, already
  // call-graph-proved mechanism this finding does not touch).
  // BLOCKER 61/62 (AC1, round 12): the read-lead veto is now one of THREE, all
  // asked of the one shared predicate — see `writeAuthorityVeto`'s doc.
  // GATE-A (2026-09-14): the observed-edit exemption is passed HERE too, not
  // only at `actionFrontierForCertificate`, so the two producers cannot
  // disagree about who may write (the exact failure the shared predicate
  // exists to prevent): a §4.2 task would otherwise certify a writable
  // `action_frontier` while its own `change_contract` said `action:"review"`.
  const veto = writeAuthorityVeto(query, getIntentEditObserved(workspace), workspace);
  // A row that only discharges a listed item needs no edit, so no edit
  // obligation waits on it (accountForListedScopeItems).
  const dischargeOnly = new Set<string>();

  const obligations: TaskChangeObligation[] = surfaces.map((surface, index) => {
    const basename = path.basename(surface.path).replace(/\.[^.]+$/, "");
    const namedToken = surface.symbol ?? basename;
    // 2026-11-02 (external evaluation T2): a surface the locator admitted on
    // lexical grounds alone (its file name, a token, a directory fill) is
    // "named" only when the request spells its name as a whole word, never
    // as a substring — `conf` inside "config" made the Sphinx docs/conf.py a
    // required edit of a config-key change.
    const lexicalOnly = surfaceAdmittedByFilenameMatchOnly(surface.why)
      || surfaceAdmittedByTokenMatchOnly(surface.why)
      || surfaceWhyHasMarker(surface.why, "caller-supplied-dir");
    const explicitlyNamed = namedToken.length >= 3 && (
      lexicalOnly
        ? requestSpellsWholeToken(query, namedToken)
        : normalizedQuery.includes(normIdent(namedToken))
    );
    const wiringSource = surface.handle === sourceHandle;
    const wiringDestination = surface.handle === destinationHandle;
    // BLOCKER 61/62 (AC1, round 12). Scoped to `connection === undefined` for
    // exactly the reason `readLedExplicitly` already is: a wiring pack's
    // `edit_frontier` is a separate, call-graph-proved mechanism.
    const vetoReason = connection === undefined ? veto.reasonFor(surface.path, surface.why) : undefined;
    if (vetoReason === "enum-derived") dischargeOnly.add("o" + (index + 1));
    const editRequired = vetoReason === undefined && (
      connection !== undefined
        ? wiringDestination
        : concernHandles.has(surface.handle)
          || surface.required === true
          || requiredRoles.has(surface.role)
          // Issue #4 (2026-08-21): a "doc" surface (CHANGELOG/README/contract
          // prose) must not inherit required-edit status purely from landing
          // at array position 0 — that is exactly what happens when an
          // EARLIER, stronger candidate is removed (e.g. by
          // suppressFragmentOnlyFilenameMatches above) and a documentation
          // surface that merely discusses the same topic is promoted into the
          // "primary" slot by accident. A doc surface still becomes required
          // through any of the OTHER, EXPLICIT signals above/below
          // (concernHandles, surface.required, requiredRoles, or the query
          // literally naming it) — this only removes the position-only
          // fallback for that one role.
          || (surface.handle === primaryHandle && !wiringSource && surface.role !== "doc")
          || explicitlyNamed
    );
    const action: "edit" | "review" = wiringSource ? "review" : editRequired ? "edit" : "review";
    const required = editRequired || wiringSource || (connection !== undefined && surface.required === true);
    // Wiring graph roles are semantic and survive project/file/symbol
    // renames; generic surface roles are filename heuristics. An adapter in
    // the proved graph therefore remains an integration review obligation
    // even when its renamed path classifies as unknown/domain.
    const kind = adapterHandles.has(surface.handle)
      ? "integration"
      : obligationKindForRole(surface.role, sourceHandle, destinationHandle, surface.handle);
    const confidence = surface.likely_edits
      ?.map((hint) => hint.confidence ?? 0)
      .reduce((best, value) => Math.max(best, value), 0);
    return {
      id: "o" + (index + 1),
      kind,
      action,
      status: hasSufficientEditContent(surface) ? "ready" : "needs-context",
      required,
      handle: surface.handle,
      path: surface.path,
      range: surface.range,
      role: asImpactSurface(surface.role),
      reason: (vetoReason !== undefined
        ? WRITE_AUTHORITY_VETO_REASON[vetoReason]
        : taskChangeContractReason(surface, kind, action)
      ).slice(0, 180),
      confidence: Math.round(((confidence && confidence > 0) ? confidence : required ? 0.85 : 0.65) * 100) / 100,
      depends_on: [],
    };
  });

  const definitions = obligations
    .filter((item) => item.kind === "definition" && !dischargeOnly.has(item.id))
    .map((item) => item.id);
  const integrations = obligations
    .filter((item) => ["implementation", "integration", "persistence"].includes(item.kind) && !dischargeOnly.has(item.id))
    .map((item) => item.id);
  const presentations = obligations
    .filter((item) => item.kind === "presentation" && !dischargeOnly.has(item.id))
    .map((item) => item.id);
  const editIds = obligations.filter((item) => item.action === "edit").map((item) => item.id);
  for (const obligation of obligations) {
    if (obligation.kind === "integration" && sourceHandle !== undefined) {
      const source = obligations.find((item) => item.handle === sourceHandle);
      obligation.depends_on = source ? [source.id] : [];
    } else if (["implementation", "integration", "persistence"].includes(obligation.kind)) {
      obligation.depends_on = definitions.filter((id) => id !== obligation.id);
    } else if (obligation.kind === "presentation") {
      obligation.depends_on = integrations.length > 0 ? integrations : definitions;
    } else if (obligation.kind === "style") {
      obligation.depends_on = presentations.length > 0 ? presentations : integrations;
    } else if (obligation.kind === "documentation" || obligation.kind === "verification") {
      obligation.depends_on = editIds.filter((id) => id !== obligation.id);
    }
  }

  const stageNumbers = [...new Set(
    obligations.filter((item) => item.action === "edit").map((item) => obligationStage(item.kind)),
  )].sort((a, b) => a - b);
  const stages = stageNumbers.map((stage) => obligations
    .filter((item) => item.action === "edit" && obligationStage(item.kind) === stage)
    .map((item) => item.id));
  const missing = [
    ...result.missing,
    ...(result.wiring?.missing ?? []).map((item) => "wiring:" + item),
    ...obligations
      .filter((item) => item.required && item.status === "needs-context")
      .map((item) => "context:" + item.id),
  ];
  if (result.route && result.route.action !== "edit_from_handles" && missing.length === 0) {
    missing.push("route:" + result.route.action);
  }
  const uniqueMissing = [...new Set(missing)];
  const ready = uniqueMissing.length === 0
    && result.route?.action === "edit_from_handles"
    && obligations.some((item) => item.action === "edit");
  // Ruling F8 (FX-OH2, 2026-09-04): `verify_obligations` ride only a pack
  // whose readiness ("ready" here IS `phase:"prepared"` -- see
  // `buildTaskExecutionContract`'s `result.change_contract?.status === "ready"`
  // read) will project to `decision.kind:"act.edit"`. A `discover`/`await_input`
  // pack (readiness false) derives none: the closure/verify-first withholding
  // logic (sfSatisfaction.ts's `read.closure` branch, `applySemanticFrontierPreBookingSeam`'s
  // W-VERIFY-GEN fold) is unaffected -- obligations are still derived at
  // closure time, from the change_contract a PREPARED pack carried.
  const verify_obligations = deriveTaskChangeContractVerifyObligations(obligations, workspace, ready);
  return {
    version: 1,
    status: ready ? "ready" : "needs-followup",
    discovery_complete: ready,
    obligations,
    stages,
    missing: uniqueMissing,
    max_additional_tl_calls: ready
      ? 0
      : Math.max(1, result.route?.max_additional_tl_calls ?? 1),
    ...(verify_obligations !== undefined ? { verify_obligations } : {}),
  };
}

export const READINESS_FALSE_READY_LIMIT = 0.05;

export const READINESS_NORMALIZED_TURN_COST = 0.18;

/**
 * The callables whose body `served` does not show (see this section's
 * header): `[]` when every one the rule asks about shows its body,
 * `undefined` when the rule does not reach the question (the caller keeps
 * its pre-existing proof).
 *
 * `scope`: `"named"` — the `behavior-body` rule: only declarations of an
 * identifier the query names; none located is `undefined`. `"any"` — the
 * ceiling snapshot's question "does this one surface show a body at all?"
 * (`sharpenBehaviorBodyCitation`): any declaration in its file.
 */
export function callableBodiesNotShown(
  callable: readonly TaskPackSurface[],
  served: readonly TaskPackSurface[],
  query: string,
  workspace: string | undefined,
  scope: "named" | "any",
): CallableDeclaration[] | undefined {
  if (workspace === undefined || callable.length === 0) return undefined;
  const named = new Set(scope === "named" ? explicitCodeIdentifiers(query).slice(0, 6) : []);
  if (scope === "named" && named.size === 0) return undefined;
  const declarations: CallableDeclaration[] = [];
  const linesByPath = new Map<string, string[]>();
  const spansByPath = new Map<string, LineSpan[]>();
  for (const filePath of new Set(callable.map((surface) => surface.path))) {
    const content = readCached(workspace, filePath);
    if (content === undefined) continue;
    linesByPath.set(filePath, content.split(/\r?\n/));
    spansByPath.set(filePath, servedLineSpansOf(served.filter((surface) => surface.path === filePath)));
    declarations.push(...callableDeclarationsIn(filePath, content)
      .filter((declaration) => scope === "any" || named.has(declaration.name)));
  }
  if (declarations.length === 0) return undefined;
  const shown = (declaration: CallableDeclaration): boolean => {
    const lines = linesByPath.get(declaration.path) ?? [];
    const spans = spansByPath.get(declaration.path) ?? [];
    // The whole extent served: nothing further exists to read (an empty
    // body, a stub), so the rule never asks for it again — and a read the
    // rule prescribes always makes progress toward this.
    if (lineSpansCover(spans, { start: declaration.line, end: Math.max(declaration.line, declaration.bound - 1) })) return true;
    for (const span of spans) {
      if (span.start <= declaration.line && declaration.line <= span.end
        && declarationCarriesInlineBody(lines[declaration.line - 1] ?? "")) return true;
      const last = Math.min(span.end, declaration.bound - 1);
      for (let line = Math.max(span.start, declaration.line + 1); line <= last; line++) {
        if (isCallableBodyLine(lines[line - 1] ?? "")) return true;
      }
    }
    return false;
  };
  if (scope === "any") return declarations.some(shown) ? [] : [declarations[0]!];
  const unshown: CallableDeclaration[] = [];
  for (const name of new Set(declarations.map((declaration) => declaration.name))) {
    const own = declarations.filter((declaration) => declaration.name === name);
    if (!own.some(shown)) unshown.push(own[0]!);
  }
  return unshown;
}

export function surfaceDeclaresNamedAuthority(surface: TaskPackSurface, identifier: string): boolean {
  const normalized = normIdent(identifier);
  // E3: a surface's `symbol` can be a QUALIFIED member name (`EKF::isHealthy`)
  // while `identifier` is the bare token the query spelled.
  if (surface.symbol !== undefined && identifierNamesSymbol(surface.symbol, identifier)) return true;
  if (normIdent(path.basename(surface.path, path.extname(surface.path))) === normalized) return true;
  const escaped = escapeRegExp(identifier);
  return new RegExp(
    `\\b(?:class|interface|type|enum|function|const|let|var|struct|trait|fn|func|def|module)\\s+${escaped}\\b`,
    "iu",
  ).test(servedSurfaceText(surface));
}

export function isLiteralFirstSurfaceDuty(query: string): boolean {
  return literalFirstRoutingEnabled() && literalFirstRelation(query) !== undefined;
}

export function namedAuthorityFacetProofs(
  served: readonly TaskPackSurface[],
  queryIdentifiers: readonly string[],
  facets: readonly string[],
  workspace?: string,
): Map<string, "served" | "authoritative-absent" | "uncovered"> {
  const authorities = queryIdentifiers.length > 0
    ? served.filter((surface) =>
        isWholeAuthoritySurface(surface, workspace)
        && queryIdentifiers.some((identifier) => surfaceDeclaresNamedAuthority(surface, identifier)))
    : [];
  const proofs = new Map<string, "served" | "authoritative-absent" | "uncovered">();
  for (const facet of facets) {
    if (served.some((surface) => surfaceBodyContainsToken(surface, facet))) proofs.set(facet, "served");
    else if (authorities.length > 0) proofs.set(facet, "authoritative-absent");
    else proofs.set(facet, "uncovered");
  }
  return proofs;
}

/**
 * SHOULD-FIX 29 (2026-09-14, review round 4) — A MENTION IS NOT A DECLARATION.
 *
 * This is the ROOT of a weakness rounds 1, 2 and 3 each closed one carrier at a
 * time (markdown, then HTML/SQL/ini/unknown, then the absence-staleness chain):
 * the test was a bare word-boundary scan of `servedSurfaceText`, so
 * `identifier:<term>` was PROVED by
 *
 *     // TODO: quantumTeleportationMode is intentionally not implemented here.
 *     const note = "plasmaConduitMode";
 *
 * — a comment and a string literal — and the response certified `act.answer`
 * with no gap, having disclosed an honest "absent, scope complete" for the same
 * two identifiers one call earlier. Every previous fix was at a PROMOTION
 * boundary, so a caller who read a doc or markup file DIRECTLY still discharged
 * the obligation from prose.
 *
 * Closed here instead, at the obligation boundary, with the same rule the
 * promotion gate uses (`termOccursOutsideComments` over the served text, with
 * the surface's own language):
 *  - a prose/markdown/markup/stylesheet surface never discharges
 *    (`pathClassCanCarryCode`, extension-driven — BLOCKER 30, 2026-09-14
 *    review round 5: no longer also refuses on `classifySurface`'s `ui`/
 *    `style` DIRECTORY heuristics, which refused an ordinary
 *    `src/components/settings.ts` declaration for living under
 *    `components/`, not for what its bytes were);
 *  - an unknown language never discharges (that is also what keeps
 *    SHOULD-FIX 28's newly-SERVED `"located"` surfaces from certifying);
 *  - a KNOWN language discharges only on an occurrence outside comments.
 *
 * THE `symbol` ARM IS KEPT AND IS THE AST ESCAPE HATCH. A surface's `symbol` is
 * the skeleton/tree-sitter engine's own anchor, i.e. a real declaration
 * identified by a parser rather than by this lexical pass — strictly stronger
 * evidence than the text test, and the one way a file whose comment syntax is
 * unclassified can still legitimately prove an identifier.
 *
 * FAIL-CLOSED DIRECTION. A surface this rejects leaves the obligation UNCOVERED,
 * which keeps discovery open and makes `uncoveredIdentifierFindCall` re-propose
 * the search — a bounded extra call, never a false certificate.
 */
/**
 * SHOULD-FIX 29 / SHOULD-FIX 28 (2026-09-14, review round 4): does this
 * request-item proof cite a CODE-BEARING occurrence of `identifier`?
 *
 * `buildRequestItemReadiness` may reconcile a proved `decision` item onto the
 * matching `identifier:<term>` obligation (see the "reconciled from
 * request-item" site). That reconciliation exists to fix a real staleness — the
 * item proved the identifier from CARRIED-FORWARD evidence this turn's surfaces
 * no longer contain — but it wrote a verdict from a DIFFERENT proof engine onto
 * the one obligation `exactIdentifierEvidence` is the authority for, so it was
 * also the second door into the class findings 28/29 close: an extensionless
 * `bin/tool` whose comment syntax this server cannot classify still certified
 * `identifier:plasmaConduitMode`, and any comment/prose mention could arrive the
 * same way.
 *
 * So the reconciliation now has to meet the SAME bar: the cited file's class can
 * carry code, and the term occurs outside its comments — or the cited evidence
 * carries a `symbol` that NAMES the identifier, which is the parser's own
 * declaration anchor and strictly stronger than this lexical test.
 *
 * Reads the cited file whole rather than its cited range: the range belongs to an
 * EARLIER turn's surface, so slicing it against today's bytes would be wrong,
 * and erring wider errs toward KEEPING the pre-existing reconciliation (whose own
 * staleness fix must not be undone) — the language/class axes are what actually
 * close the leak. Fails closed on an unreadable/undecodable/oversize file.
 */
export function proofCitesCodeBearingOccurrence(
  workspace: string | undefined,
  evidence: readonly TaskReadinessEvidence[] | undefined,
  identifier: string,
): boolean {
  if (workspace === undefined) return false;
  const seen = new Set<string>();
  for (const item of evidence ?? []) {
    if (item.symbol !== undefined && identifierNamesSymbol(item.symbol, identifier)) return true;
    const rel = item.path;
    if (typeof rel !== "string" || rel === "" || seen.has(rel)) continue;
    seen.add(rel);
    if (!pathClassCanCarryCode(rel)) continue;
    const text = boundedWorkspaceText(workspace, rel);
    if (text !== undefined && termOccursOutsideComments(text, rel, identifier)) return true;
  }
  return false;
}

export function exactIdentifierEvidence(
  surfaces: readonly TaskPackSurface[],
  identifier: string,
): TaskReadinessEvidence[] {
  return surfaces
    .filter((surface) =>
      // E3: a qualified `symbol` (`EKF::isHealthy`) is named by the bare token.
      (surface.symbol !== undefined && identifierNamesSymbol(surface.symbol, identifier))
      // SHOULD-FIX 29 (2026-09-14): THE FILE ITSELF IS NAMED BY THE IDENTIFIER.
      // The same arm `surfaceDeclaresNamedAuthority` has always trusted, and it
      // is not a "mention": the identifier is the served file's own basename, so
      // serving that file IS serving the thing the query named. Required because
      // `explicitCodeIdentifiers` harvests a DOCUMENT name out of a query too —
      // `replayCorpus`'s `mc2` asks about `aeroctl/CONTRACT.md` and its
      // `identifier:CONTRACT` is discharged by serving that very file, which the
      // code-bearing arm below (correctly) refuses to do for a markdown body.
      || normIdent(path.basename(surface.path, path.extname(surface.path))) === normIdent(identifier)
      || (
        pathClassCanCarryCode(surface.path)
        && termOccursOutsideComments(servedSurfaceText(surface), surface.path, identifier)
      )
    )
    .map(readinessEvidence);
}
