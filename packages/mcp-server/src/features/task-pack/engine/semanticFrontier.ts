// semanticFrontier — extracted implementation; imports point to the owning modules.
import * as fs from "fs";
import type { SfAnchorResolution } from "../sfConcerns.js";
import type { SfAnchorResolver } from "../sfConcerns.js";
import type { SfExplicitTarget } from "../sfConcerns.js";
import type { SfRelationSeamOutcome } from "../sfRelationSeam.js";
import type { SfResponseEvidence } from "../sfSatisfaction.js";
import type { SfSatisfactionResult } from "../sfSatisfaction.js";
import type { SfServedEvidence } from "../../../task-state/sfState.js";
import type { SfSnapshot } from "../../../task-state/sfState.js";
import type { SfStructuralConcern } from "../sfConcerns.js";
import type { SfTaskContext } from "../../../task-state/sfState.js";
import type { SfWorkspaceIndex } from "../sfConcerns.js";
import type { TaskPackArgs } from "../model.js";
import type { TaskPackResult } from "../model.js";
import type { TaskPackSurface } from "../model.js";
import { FileReadCache } from "./packBasics2.js";
import { SF_EVIDENCE_ROLES } from "./taskPackEntry2.js";
import { annotateSemanticFrontierContinuation } from "../semanticFrontier.js";
import { applyResponseToConcerns } from "../sfSatisfaction.js";
import { applySemanticFrontierDemotion } from "../canonicalDecision.js";
import { attachSfDemotionResidency } from "../canonicalDecision.js";
import { attachSfPackContext } from "../sfSatisfaction.js";
import { centeredSliceForCap } from "./packBasics2.js";
import { compileSfRelationPackets } from "../sfRelationSeam.js";
import { concernAnchorTokens } from "./roleAndConcernScope3.js";
import { concernsAddressedByEvidence } from "../sfSatisfaction.js";
import { countLines } from "../../../util/countLines.js";
import { createSessionLedgerReader } from "../../../task-state/sfLedgerReader.js";
import { extractStructuralConcerns } from "../sfConcerns.js";
import { getIntentEditObserved } from "../../../state/session.js";
import { graphEvidenceEnabled } from "../../../util/flags.js";
import { handleTable } from "../../../util/handles.js";
import { hasExecutedSearchAction } from "../../../util/packServeLog.js";
import { isWithin } from "../../../util/safePath.js";
import { markConcernSatisfied } from "../../../task-state/sfState.js";
import { markSemanticFrontierNamedJoin } from "../sfWithholdingMarks.js";
import { mergeSfSatisfactionResults } from "../sfRelationSeam.js";
import { openSfTask } from "../../../task-state/sfState.js";
import { pendingNamedFrontierWindows } from "./semanticFrontier2.js";
import { readCached } from "./packBasics2.js";
import { reapplySemanticFrontierDecision } from "../canonicalDecision.js";
import { recordDecision } from "../../../task-state/sfState.js";
import { recordServed } from "../../../task-state/sfState.js";
import { resolveQualifiedSymbolAnchors } from "./wiringEvidence3.js";
import { resolveReal } from "../../../util/safePath.js";
import { safeResolve } from "../../../util/safePath.js";
import { scanLiteral } from "../../search/find/findText.js";
import { sfConcernGrounding } from "../sfConcerns.js";
import { sfContinuationCandidatePathsNear } from "./semanticFrontier2.js";
import { sfDemoteEnabled } from "../../../util/flags.js";
import { sfEvidenceIdFor } from "../../../task-state/sfState.js";
import { sfNamedFrontierDirectWindowsFor } from "./semanticFrontier2.js";
import { sfObservationOnly } from "../sfConcerns.js";
import { sfPackContextFor } from "../sfSatisfaction.js";
import { sfQueryFileAnchors } from "../sfConcerns.js";
import { sfRelationPacketsEnabled } from "../../../util/flags.js";
import { sfStatefulEnabled } from "../../../util/flags.js";
import { sfStructuralConcernsEnabled } from "../../../util/flags.js";
import { sfVerifyFirstEnabled } from "../../../util/flags.js";
import { shaOfText } from "../../../util/handles.js";
import { surfaceFileSha } from "./packState2.js";
import { trace } from "../../../util/trace.js";
import { verifyObligationsToSfConcerns } from "../sfVerifyObligations.js";
import { walkCodeFiles } from "../../../tools/walkRepo.js";
import { workspaceCallableDefinitionPaths } from "./wiringEvidence2.js";
import { workspaceValueDefinitionPaths } from "./wiringEvidence3.js";

export function sfLineRange(range: string | undefined): { startLine: number; endLine: number } | undefined {
  if (typeof range !== "string") return undefined;
  const match = /^(\d+)-(\d+)$/.exec(range.trim());
  if (match === null) return undefined;
  const startLine = Number(match[1]);
  const endLine = Number(match[2]);
  if (!Number.isFinite(startLine) || !Number.isFinite(endLine)) return undefined;
  return { startLine, endLine };
}

/** The caller's `paths[]`, in the extractor's target shape. ORDER IS KEPT (I-2). */
export function sfExplicitTargets(paths: TaskPackArgs["paths"]): SfExplicitTarget[] {
  const out: SfExplicitTarget[] = [];
  for (const entry of paths ?? []) {
    if (typeof entry === "string") {
      if (entry !== "") out.push({ path: entry });
      continue;
    }
    if (entry === null || typeof entry !== "object") continue;
    const target: SfExplicitTarget = {
      ...(typeof entry.path === "string" && entry.path !== "" ? { path: entry.path } : {}),
      ...(typeof entry.symbol === "string" && entry.symbol !== "" ? { symbol: entry.symbol } : {}),
    };
    if (target.path !== undefined || target.symbol !== undefined) out.push(target);
  }
  return out;
}

/**
 * The surfaces this pack SERVED, as both a catalog record and a satisfaction
 * input. A bodyless supporting line is still cataloged (the caller was told
 * the address is reachable) but carries `body:false`, which is what stops it
 * from closing anything (§3.3: "bodyless supporting 行は evidence を追加しない"
 * — here it is recorded as reachability and excluded from closure, which is
 * the same guarantee with an auditable record).
 */
export function sfServedFromPack(
  result: TaskPackResult,
  namedPaths: ReadonlySet<string>,
  concerns: readonly SfStructuralConcern[],
  workspace: string,
): SfResponseEvidence[] {
  const out: SfResponseEvidence[] = [];
  // SF-F3: one file-sha per distinct path, computed at most once. `surfaceFileSha`
  // opens the file, so a pack with many surfaces of one file must not pay for it
  // repeatedly.
  const shaCache = new Map<string, string | undefined>();
  const fileShaOf = (relPath: string): string | undefined => {
    if (!shaCache.has(relPath)) shaCache.set(relPath, surfaceFileSha(workspace, relPath));
    return shaCache.get(relPath);
  };
  for (const surface of result.surfaces ?? []) {
    if (surface === null || typeof surface !== "object") continue;
    if (typeof surface.path !== "string" || surface.path === "") continue;
    const body = typeof surface.code === "string" && surface.code.length > 0;
    const lineRange = sfLineRange(surface.range);
    const roles = (typeof surface.role === "string" && SF_EVIDENCE_ROLES.has(surface.role)
      ? [surface.role]
      : []) as NonNullable<SfServedEvidence["roles"]>;
    // SF-F3: a freshly computed pack carries no `sha` on its surfaces (`sha`
    // rides the pack_unchanged re-serve), and this seam used to record such a
    // body as `evidenceClass:"direct"` with an EMPTY `contentHash` and an
    // EMPTY `validityKeys` — an entry nothing could ever invalidate, so a
    // later edit to the file never made the closure stale. Derive the file sha
    // instead (the same `surfaceFileSha` the pack fingerprint uses, so the two
    // agree on what "unchanged" means), and fall back to the served bytes'
    // own hash for a file too large or unreadable to fingerprint — never to
    // an empty hash.
    const sha = (typeof surface.sha === "string" && surface.sha !== "" ? surface.sha : undefined)
      ?? fileShaOf(surface.path)
      ?? (body ? shaOfText(surface.code as string) : undefined);
    const entry: SfResponseEvidence = {
      path: surface.path,
      ...(sha === undefined ? {} : { sha }),
      ...(lineRange === undefined ? {} : { lineRange }),
      ...(typeof surface.symbol === "string" && surface.symbol !== "" ? { symbol: surface.symbol } : {}),
      // A BODY went out AND something binds it to bytes: that is what `direct`
      // claims. With no derivable hash the honest class is `structural`.
      evidenceClass: body && sha !== undefined ? "direct" : "structural",
      roles,
      concernIds: concernsAddressedByEvidence(concerns, {
        path: surface.path,
        ...(typeof surface.symbol === "string" && surface.symbol !== "" ? { symbol: surface.symbol } : {}),
      }),
      // I-2: "required" means the CALLER named this address, not that the pack
      // marked the surface required. A caller-named address is permanently
      // out of reach of demotion.
      required: namedPaths.has(surface.path),
      body,
    };
    // SF-F10: stamp the CATALOG's evidence id, so the ids `recordServed`
    // catalogs and the ids the satisfaction updater names in its proofs are
    // the same strings. Without it the updater fell back to its own
    // `path:start-end` spelling, every proof ref dangled, and the closure the
    // seam nominated was refused for want of evidence it had just served.
    out.push({ ...entry, evidenceId: sfEvidenceIdFor(entry) });
  }
  return out;
}

/**
 * The decision state this pack represents, derived from the pack ALONE.
 *
 * `TaskPackResult` carries no `decision`: the canonical decision is projected
 * at the wire choke point (`protocol/decisionWire.ts`), which this seam must
 * not reach into and must not duplicate. `coverage` plus `missing` is what the
 * pack itself proved, so that is what is recorded — `prepared` when discovery
 * closed, `pending` otherwise. W-NEXT-ARBITER owns the decision projection and
 * may refine this; nothing downstream of the wire reads it today.
 */
/**
 * Bound on BARE identifiers this seam will resolve through the workspace in
 * one call. `sfConcerns.ts` already stops opening identifier concerns at
 * `SF_IDENTIFIER_CONCERNS_MAX` (6), and each lookup here costs one literal
 * scan plus a bounded content probe, so the two ceilings match deliberately:
 * the extractor can never ask for a lookup this budget would refuse.
 */
export const SF_INDEX_LOOKUPS_MAX = 6;

/** D6: files visited when building the per-call basename index. */
export const SF_BASENAME_INDEX_MAX_FILES = 20000;

/** D6: same-basename paths retained per basename. */
export const SF_BASENAME_MATCHES_MAX = 8;

/**
 * Build-output directory segments, mirroring `tools/findReferences.ts`'s
 * `GENERATED_SEGMENTS`. The basename is skipped on purpose: `src/out.ts` is
 * source, `src/out/x.ts` is build output.
 */
export const SF_GENERATED_SEGMENTS: ReadonlySet<string> = new Set([
  "dist", "build", "out", "coverage", ".next", "target", "generated", "__generated__",
]);

/**
 * SF-1 — the two workspace capabilities `extractStructuralConcerns` is
 * INJECTED with, and without which every concern it mints is advisory.
 *
 * This is the defect the round-11 review found: the seam called the extractor
 * with neither an `anchorResolver` nor a `workspaceIndex`, so a
 * `Class::member` anchor resolved to nothing (`definitions.length === 0` =>
 * `advisory: true`) and a bare identifier opened no concern at all — which
 * makes the whole concerns -> arbiter -> demote chain inert with every flag
 * on, because I-3 says an advisory concern closes nothing, blocks nothing and
 * is never selected.
 *
 * Both capabilities are the EXISTING D5 machinery, not new logic:
 * `resolveQualifiedSymbolAnchors` (definition/declaration/counterpart sites
 * for a qualified anchor) and `workspaceCallableDefinitionPaths` (the
 * definition sites of a bare callable token). Every result is memoized per
 * call and the identifier path is budgeted, so the extractor cannot turn a
 * long query into an unbounded number of workspace scans.
 */
export function sfWorkspaceCapabilities(workspace: string): {
  readonly anchorResolver: SfAnchorResolver;
  readonly workspaceIndex: SfWorkspaceIndex;
} {
  const cache = new FileReadCache();
  const anchorMemo = new Map<string, SfAnchorResolution>();
  const definitionMemo = new Map<string, readonly string[]>();
  const existsMemo = new Map<string, boolean>();
  let lookups = 0;
  // D6: basename -> workspace paths, built at most ONCE per call and only if a
  // query actually contains a bare filename token (the extractor calls
  // `pathsForBasename` lazily, so a query without one pays nothing).
  let basenameIndex: Map<string, string[]> | undefined;

  const anchorResolver: SfAnchorResolver = (anchor) => {
    const key = anchor.raw.toLowerCase();
    const memo = anchorMemo.get(key);
    if (memo !== undefined) return memo;
    let resolved: SfAnchorResolution;
    try {
      const found = resolveQualifiedSymbolAnchors(anchor.raw, workspace, cache);
      resolved = {
        definitions: [...found.definitions],
        declarations: [...found.declarations],
        counterparts: [...found.counterparts],
      };
    } catch {
      // I-1: a resolver defect degrades this anchor to advisory, never fails
      // the read.
      resolved = {};
    }
    anchorMemo.set(key, resolved);
    return resolved;
  };

  const workspaceIndex: SfWorkspaceIndex = {
    definitionPathsFor(identifier: string): readonly string[] {
      const key = identifier.toLowerCase();
      const memo = definitionMemo.get(key);
      if (memo !== undefined) return memo;
      if (lookups >= SF_INDEX_LOOKUPS_MAX) return [];
      lookups += 1;
      let paths: readonly string[] = [];
      try {
        const candidates: string[] = [];
        for (const match of scanLiteral(identifier, workspace, { caseInsensitive: false })) {
          if (!candidates.includes(match.path)) candidates.push(match.path);
        }
        paths = workspaceCallableDefinitionPaths(identifier, candidates, workspace, cache);
        // D7 (FX-R3b): a callable resolver cannot see a constant, class, type,
        // enum or module-level value. Falling back keeps `ENGAGEMENT_WITNESS`
        // (and every other non-callable the caller names) groundable, which is
        // what the D4 marking source needs to be non-empty at all.
        if (paths.length === 0) {
          paths = workspaceValueDefinitionPaths(identifier, candidates, workspace, cache);
        }
      } catch {
        paths = [];
      }
      definitionMemo.set(key, paths);
      return paths;
    },
    /**
     * D6: every workspace path whose basename equals `basename`. One bounded
     * walk (the same `walkCodeFiles` the discovery lanes use, generic text and
     * artifacts included so `CONTRACT.md` / `pyproject.toml` / a `.zip` are
     * addressable), memoized for the whole call.
     */
    pathsForBasename(basename: string): readonly string[] {
      if (basenameIndex === undefined) {
        const built = new Map<string, string[]>();
        try {
          let seen = 0;
          for (
            const file of walkCodeFiles(workspace, {
              includeGenericText: true,
              includeArtifacts: true,
              respectGitignore: true,
            })
          ) {
            if (seen >= SF_BASENAME_INDEX_MAX_FILES) break;
            seen += 1;
            const base = (file.relPath.split(/[\\/]/).at(-1) ?? "").toLowerCase();
            if (base === "") continue;
            const bucket = built.get(base);
            if (bucket === undefined) built.set(base, [file.relPath]);
            else if (bucket.length < SF_BASENAME_MATCHES_MAX) bucket.push(file.relPath);
          }
        } catch {
          // I-1: a walk defect degrades the rule to "no match", never fails.
        }
        basenameIndex = built;
      }
      return basenameIndex.get(basename.toLowerCase()) ?? [];
    },
    hasPath(relPath: string): boolean {
      const memo = existsMemo.get(relPath);
      if (memo !== undefined) return memo;
      let exists = false;
      try {
        const abs = safeResolve(relPath, workspace);
        if (abs !== undefined) {
          const real = fs.realpathSync(abs);
          exists = isWithin(real, resolveReal(workspace)) && fs.statSync(real).isFile();
        }
      } catch {
        exists = false;
      }
      existsMemo.set(relPath, exists);
      return exists;
    },
    roleFor(relPath: string): "template" | "generated" | undefined {
      const segments = relPath.split(/[\\/]/);
      for (let i = 0; i < segments.length - 1; i += 1) {
        if (SF_GENERATED_SEGMENTS.has(segments[i]!)) return "generated";
      }
      // `template` has no directory-segment authority in this codebase, so it
      // is left to `sfConcerns.ts`'s own path patterns (an index that returns
      // `undefined` falls through to them by contract).
      return undefined;
    },
    counterpartsFor(relPath: string): readonly string[] {
      // The header/impl rule, reusing the bounded same-stem probe the
      // continuation seam already runs (`x.hpp` -> `x.cpp`, `x.d.ts` -> `x.ts`).
      try {
        return sfContinuationCandidatePathsNear(relPath, workspace);
      } catch {
        return [];
      }
    },
  };

  return { anchorResolver, workspaceIndex };
}

/**
 * D8 (FX-R3c, 2026-09-04): ONE set of SF workspace capabilities per CALL.
 *
 * `sfWorkspaceCapabilities` memoizes a symbol-resolution cache AND (since D6)
 * a whole-workspace basename index. D8 needs the basename resolution twice in
 * one call — once early, to join the caller-named file to the frontier before
 * surface selection is booked, and once at the pre-booking seam, to extract
 * the full concern set — and building it twice would mean two workspace walks
 * AND two authorities that can disagree about which file the caller named.
 * Keyed on the request `args`, which is the one object that survives every
 * `result` copy `dedupeTrimAndPersist` makes (trim, fallback, receipt).
 */
export const sfCallCapabilities = new WeakMap<object, {
  readonly anchorResolver: SfAnchorResolver;
  readonly workspaceIndex: SfWorkspaceIndex;
}>();

export function sfCapabilitiesFor(args: TaskPackArgs | undefined, workspace: string): {
  readonly anchorResolver: SfAnchorResolver;
  readonly workspaceIndex: SfWorkspaceIndex;
} {
  if (args === undefined) return sfWorkspaceCapabilities(workspace);
  const memo = sfCallCapabilities.get(args);
  if (memo !== undefined) return memo;
  const built = sfWorkspaceCapabilities(workspace);
  sfCallCapabilities.set(args, built);
  return built;
}

/** Caller-named workspace FILES `query` grounds, through the shared index (D8). */
export function sfGroundedQueryFilePaths(
  query: string,
  index: SfWorkspaceIndex,
  namedPaths: ReadonlySet<string>,
): string[] {
  const out: string[] = [];
  for (const anchor of sfQueryFileAnchors(query, index, namedPaths)) {
    if (anchor.kind !== "path" || !anchor.proven) continue;
    if (!out.includes(anchor.path)) out.push(anchor.path);
  }
  return out;
}

export function sfDecisionStateOf(result: TaskPackResult): "pending" | "prepared" {
  const complete = result.coverage === "complete" || result.coverage === "focused";
  const missing = Array.isArray(result.missing) ? result.missing.length : 0;
  return complete && missing === 0 ? "prepared" : "pending";
}

/**
 * The sync half of the SF lifecycle's state, carried from
 * `openSemanticFrontierPackState` to the async relation-packet continuation
 * so the two never re-derive (and so cannot disagree about) the task context,
 * the concern set, or the snapshot they are both advancing.
 */
export interface SfPackSeamState {
  readonly ctx: SfTaskContext;
  readonly concerns: readonly SfStructuralConcern[];
  readonly groundingOf: ReadonlyMap<string, "direct" | "structural">;
  snapshot: SfSnapshot;
  satisfaction: SfSatisfactionResult;
}

export const sfPackSeamStates = new WeakMap<object, SfPackSeamState>();

/**
 * FX-I-A (2026-09-03) — WHY THIS IS SYNC AND WHY IT RUNS INSIDE THE CORE.
 *
 * Every serve-booking producer (the edit gate's admissible union,
 * `rememberCertifiedWorkingSet`, `captureServedPack`'s
 * `recordPackServedRanges`) lives inside `dedupeTrimAndPersist`, which is
 * inside `buildTaskPackCore`. W-DEMOTE may still WITHHOLD a body, so it has to
 * run BEFORE all of them or those producers book bytes the response never
 * sends — the round-13 finding-1 widening, where a demoted file's handle drove
 * `edit.applied` under `workspace.scope:"served-evidence"`.
 *
 * Demotion eligibility needs this pack's SF context, so the context has to
 * exist that early too. Everything the context needs is synchronous; only the
 * relation-packet compilation (`compileSfRelationPackets`, a workspace-wide
 * tree-sitter port build) is async, and it feeds `plan.wiring.evidence_graph`
 * and concern satisfaction — never demotion eligibility. So the lifecycle is
 * split: this sync opener runs at the pre-booking seam, and
 * `applySemanticFrontierRelationPackets` continues it after the core returns,
 * advancing the SAME record through the state stashed here.
 *
 * Total, like its predecessor: it returns `void`, cannot fail the pack, and
 * never mutates `result` beyond the two WeakMap side tables.
 */
export function openSemanticFrontierPackState(
  args: TaskPackArgs,
  workspace: string,
  result: TaskPackResult,
  extraConcerns: readonly SfStructuralConcern[] = [],
): void {
  if (!sfStatefulEnabled()) return;
  if (sfPackSeamStates.has(result)) return;
  try {
    const query = typeof args.query === "string" ? args.query : "";
    const targets = sfExplicitTargets(args.paths);
    const profile = result.profile_binding?.selected ?? result.task_profile ?? "generic";

    // W-VERIFY-GEN hook: `extraConcerns` (verify concerns derived from
    // `result.change_contract.verify_obligations` at this function's call
    // site) is additive, pure data passed in by the caller — this seam adds
    // no new satisfaction logic of its own, per W-VERIFY-GEN's file scope.
    // See sfVerifyObligations.ts's `verifyObligationsToSfConcerns`.
    // SF-1: the extractor's two workspace capabilities are built HERE and
    // passed in. Built only when the extraction flag is on, so a flag-off call
    // pays nothing at all — not even the `FileReadCache` allocation.
    const capabilities = sfStructuralConcernsEnabled()
      ? sfCapabilitiesFor(args, workspace)
      : undefined;
    const concerns: SfStructuralConcern[] = [
      ...(capabilities !== undefined
        ? extractStructuralConcerns({
          query,
          targets,
          profile,
          writeAllowed: args.writeAllowed,
          // §4.4(a) (IL-W3 landed the field/OR-logic; this is the production
          // wire): has THIS task already issued a `references` search, by any
          // query? Injected here, never read inside sfConcerns.ts itself —
          // keeps the extractor pure.
          referencesObserved: hasExecutedSearchAction(workspace, "references"),
          // §4.2 (IL-W2): the same task already landed an edit — injected, never
          // read inside sfConcerns.ts.
          editObserved: getIntentEditObserved(workspace),
          anchorResolver: capabilities.anchorResolver,
          workspaceIndex: capabilities.workspaceIndex,
        })
        : []),
      ...extraConcerns,
    ];
    // SF-F2: the grounding class each concern's claim demands, by id. A body
    // claim (`definition`, `template`, `generated`, `verify`, `answer`) may
    // not be closed by a structural catalog entry.
    const groundingOf = new Map(concerns.map((concern) => [concern.id, sfConcernGrounding(concern.kind)] as const));

    const ctx: SfTaskContext = {
      workspaceRoot: workspace,
      ...(typeof args.lane === "string" ? { lane: args.lane } : {}),
      ...(typeof args.taskBinding === "string" && args.taskBinding !== ""
        ? { taskId: args.taskBinding }
        : {}),
      ...(typeof result.qref === "string" && result.qref !== "" ? { qref: result.qref } : {}),
      // The FINGERPRINT, never the text — see this section's PRIVACY note.
      ...(query === "" ? {} : { query: shaOfText(query) }),
      ...(args.taskEpoch === "new" ? { epochNew: true } : {}),
      ...(args.forceServe === true ? { forceServe: true } : {}),
      ledger: createSessionLedgerReader(workspace),
    };

    let latest: SfSnapshot = openSfTask(ctx, concerns);

    const namedPaths = new Set(
      targets.map((t) => t.path).filter((p): p is string => typeof p === "string" && p !== ""),
    );
    // D8 (FX-R3c), I-2: a file the caller NAMED IN THE REQUEST TEXT is a
    // caller-named address exactly like one passed through structured
    // `targets`. Adding it here is what puts it in `snapshot.requiredAddresses`
    // once served, so W-DEMOTE can never withhold the body of the very file
    // the query is about — and, symmetrically, is what lets demotion act on
    // the UNBOUND candidates that are not serving any open concern.
    if (capabilities !== undefined) {
      for (const groundedPath of sfGroundedQueryFilePaths(query, capabilities.workspaceIndex, namedPaths)) {
        namedPaths.add(groundedPath);
      }
    }
    const served = sfServedFromPack(result, namedPaths, concerns, workspace);
    if (served.length > 0) {
      const after = recordServed(ctx, served);
      if (after.active) latest = after;
    }

    let satisfaction = applyResponseToConcerns({
      snapshot: latest,
      concerns,
      response: {
        kind: "read.task_pack",
        evidence: served,
        decision: { state: sfDecisionStateOf(result) },
      },
      // R27b-FIX F9 (2026-09-05): a path-anchored concern closes on a served
      // body only when that body COVERS the bounded window F9's own `next`
      // asks for. `applySemanticFrontierNamedFrontier` already published the
      // map for this exact `result` (see `attachSfPackContext` below).
      directReadWindows: sfNamedFrontierDirectWindowsFor(result),
    });
    for (const concernId of satisfaction.satisfied) {
      // The closure GATE has the last word (§3.4 I-4): a nomination this seam
      // gets wrong is refused inside `markConcernSatisfied`, never applied.
      const after = markConcernSatisfied(ctx, concernId, {
        ...(satisfaction.proofs[concernId] ?? {}),
        grounding: groundingOf.get(concernId) ?? "structural",
      });
      if (after.active) latest = after;
    }

    const decided = recordDecision(ctx, { state: sfDecisionStateOf(result) });
    if (decided.active) latest = decided;

    // NOT `closeSfTask`. A pack that closed DISCOVERY has not ended the task —
    // the caller still has to edit and verify — and dropping the record's LRU
    // entry here would forget a graph the very next call needs. Closing is
    // W-VERIFY-CLOSURE's, on the verification path.
    //
    // `result` is this seam's own mutable pack object, returned as-is by
    // `buildTaskPack`, but `server.ts`'s production dispatch shallow-copies it
    // (`attachSupply`) before the decision the context below feeds into is
    // ever derived (round-22B finding 2). `attachSfPackContext` stamps a
    // token onto `result` that survives that copy — see `sfSatisfaction.ts`'s
    // block comment — so this call site needs no change beyond calling it
    // exactly as before.
    attachSfPackContext(result, {
      snapshot: latest,
      concerns,
      satisfaction,
      observationOnly: sfObservationOnly(result.profile_binding),
      // F9 (ruling (a)): `applySemanticFrontierNamedFrontier` runs earlier in
      // `dedupeTrimAndPersist` (before this pre-booking seam), so its window
      // map — if any — is already published for this exact `result` object.
      namedFrontierDirectWindows: sfNamedFrontierDirectWindowsFor(result),
    });
    // SF-8 / D4: W-DEMOTE must ask the served ledger about a SPECIFIC ADDRESS,
    // not settle for the pack-wide `ledgerWired` boolean the snapshot carries.
    // Publish the very context this seam drove the record with — never a
    // second, re-derived reader.
    attachSfDemotionResidency(result, ctx);
    sfPackSeamStates.set(result, { ctx, concerns, groundingOf, snapshot: latest, satisfaction });
  } catch (err) {
    // I-1: an SF defect is a trace line, never a degraded pack.
    try {
      trace(
        "sf_pack_seam_error",
        { message: err instanceof Error ? err.message : String(err) },
        workspace,
      );
    } catch {
      /* the trace channel is best-effort too */
    }
  }
}

/**
 * The ASYNC continuation of the lifecycle `openSemanticFrontierPackState`
 * opened: W-RELATION-SEAM (DESIGN-v0.15 §3.7). It compiles at most
 * SF_RELATION_CONCERN_MAX relation packets for this pack's grounded relation
 * concerns and projects them into the EXISTING `plan.wiring.evidence_graph`
 * field (§4.2: no new wire field), then advances the same SF record with what
 * those packets satisfied.
 *
 * Deliberately OUTSIDE the pre-booking seam: `compileSfRelationPackets` is a
 * workspace-wide tree-sitter port build, it is the only async step in the
 * lifecycle, and nothing it produces can make a surface demotion-eligible
 * (eligibility reads `requiredAddresses`, the residency ledger and the
 * surface's own body — never a relation packet). Running it after the pack has
 * been booked therefore changes no booking, and running it before would force
 * the whole synchronous core to become async.
 *
 * Skipped entirely under an observation-only profile binding (§3.6.2) — SF may
 * record concerns there, but must not spend a workspace-wide port build on a
 * profile that cannot use the result for decision/next/rank anyway.
 */
export async function applySemanticFrontierRelationPackets(
  args: TaskPackArgs,
  workspace: string,
  result: TaskPackResult,
): Promise<void> {
  if (!sfStatefulEnabled()) return;
  if (!sfRelationPacketsEnabled() || !graphEvidenceEnabled()) return;
  if (sfObservationOnly(result.profile_binding)) return;
  const state = sfPackSeamStates.get(result);
  if (state === undefined) return;
  try {
    const { ctx, concerns, groundingOf } = state;
    let latest = state.snapshot;
    let satisfaction = state.satisfaction;
    // ROUND-24 FINDING 1 / RULING (dd), 2026-09-04 (FX-Y2): this pass runs
    // strictly AFTER `applySemanticFrontierPreBookingSeam`'s demotion step
    // (this function's own doc comment; `buildTaskPack` awaits this only once
    // `buildTaskPackCore` — and therefore the pre-booking seam — has already
    // returned), so `result.surfaces` here is the POST-SEAM, POST-DEMOTION
    // truth: a surface `TL_SF_DEMOTE` withheld already reads bodyless. Recompute
    // served evidence fresh from THAT state (never reuse the sync pass's
    // pre-demotion `served` list, which is exactly the stale, too-generous
    // input the finding traced) and hand it to `applyResponseToConcerns` as
    // this response's own `evidence`, so `relationAnchorGroundingServed`'s
    // sibling check can tell a genuinely-served definition/declaration from a
    // demoted, bodyless one instead of trusting the persisted "satisfied"
    // mark alone.
    const namedPaths = new Set(
      sfExplicitTargets(args.paths)
        .map((t) => t.path)
        .filter((p): p is string => typeof p === "string" && p !== ""),
    );
    const groundingEvidence = sfServedFromPack(result, namedPaths, concerns, workspace);
    const relationOutcome: SfRelationSeamOutcome = await compileSfRelationPackets({
      workspaceRoot: workspace,
      ...(typeof args.lane === "string" ? { lane: args.lane } : {}),
      concerns,
      ...(result.wiring?.evidence_graph !== undefined
        ? { existingGraph: result.wiring.evidence_graph }
        : {}),
    });
    if (relationOutcome.evidenceGraph !== undefined) {
      result.wiring = result.wiring !== undefined
        ? { ...result.wiring, evidence_graph: relationOutcome.evidenceGraph }
        : {
          version: 1,
          status: "needs-followup",
          connections: [],
          missing: [],
          edit_frontier: [],
          review_frontier: [],
          evidence_graph: relationOutcome.evidenceGraph,
          note: "relation packet(s) merged for grounded relation concern(s) (W-RELATION-SEAM)",
        };
    }
    // `applyResponseToConcerns` accepts exactly one `relationPacket` per
    // call (§4.2), so a second compiled packet (a different anchor) needs
    // its own pass — merged via `mergeSfSatisfactionResults`, never a new
    // satisfaction rule.
    for (const { view } of relationOutcome.packets) {
      const relationPass = applyResponseToConcerns({
        snapshot: latest,
        concerns,
        response: { kind: "read.task_pack", relationPacket: view, evidence: groundingEvidence },
        directReadWindows: sfNamedFrontierDirectWindowsFor(result),
      });
      for (const concernId of relationPass.satisfied) {
        const after = markConcernSatisfied(ctx, concernId, {
          ...(relationPass.proofs[concernId] ?? {}),
          grounding: groundingOf.get(concernId) ?? "structural",
        });
        if (after.active) latest = after;
      }
      satisfaction = mergeSfSatisfactionResults(satisfaction, relationPass, concerns);
    }
    state.snapshot = latest;
    state.satisfaction = satisfaction;
    attachSfPackContext(result, {
      snapshot: latest,
      concerns,
      satisfaction,
      observationOnly: sfObservationOnly(result.profile_binding),
      // F9 (ruling (a)): carry the same window map forward on this re-attach
      // — see the sync seam's own attach call for why it is already published.
      namedFrontierDirectWindows: sfNamedFrontierDirectWindowsFor(result),
    });
  } catch (err) {
    // I-1: an SF defect is a trace line, never a degraded pack.
    try {
      trace(
        "sf_pack_seam_error",
        { message: err instanceof Error ? err.message : String(err) },
        workspace,
      );
    } catch {
      /* the trace channel is best-effort too */
    }
  }
}

// ---------------------------------------------------------------------------
// D8 (FX-R3c, 2026-09-04) — THE CALLER-NAMED FRONTIER JOIN.
//
// THE DEFECT, LIVE. On the sealed SF05 replay the query named a file twice.
// D6 resolved it to one real workspace address and minted a GROUNDED,
// non-advisory structural concern for it — and the pack served seven other
// files, listed those same seven in `frontier_index`, pointed `next` at a
// codeless row of one of them, and demoted nothing. The concern was correct
// and completely inert.
//
// THE CAUSE. Concern extraction runs at the PRE-BOOKING seam
// (`openSemanticFrontierPackState`, above), which `dedupeTrimAndPersist`
// reaches long AFTER the locator has fixed `result.surfaces` and
// `attachFrontierIndex` has inventoried them. Nothing ever fed a grounded
// concern's address back into surface selection, so "the caller named this
// file" could influence `next` at best and the served bytes never.
//
// THE FIX. Resolve the caller-named file anchors HERE — before
// `finalizePackServeState`/`attachFrontierIndex`, before the contract build,
// before `trimToCap`, and therefore before every booking producer (FX-J/FX-K:
// they all run at `dedupeTrimAndPersist`'s exit over the FINAL pack, so this
// join is booked exactly like any other surface and `sfBookingOrderFence`'s
// ordering claim is unaffected). The row carries the file's BODY when it is
// small enough to inline (`SF_NAMED_FRONTIER_MAX_BODY_BYTES` — a JOIN bound,
// so one caller-named file can never dominate the pack before the real
// shedder sees it); either way `trimToCap` Phase E is what decides whether the
// body survives the pack's own byte cap, and a stripped row keeps its handle
// plus `remaining_ranges`. That is exactly ruling (q)/(t)'s "served body
// within caps, else bodyless row with handle + remaining", with no second
// shedding POLICY invented here.
//
// GENERALITY. The rule is "an explicitly named file that grounds a
// non-advisory structural path concern is a caller-named target". It reads no
// fixture, no path pattern, no task id: `sfQueryFileAnchors` (sfConcerns.ts)
// is the ONE authority, the same one `extractStructuralConcerns` consumes, and
// it is inert without the injected index.
//
// D9: an AMBIGUOUS basename (several same-basename files, no family token to
// disambiguate) joins its candidates as BODYLESS rows — addressable handles
// the caller can pick between — and `selectCanonicalNext` surfaces the same
// set as `candidates` so an `await_input` carries a choice (ruling (cc))
// rather than a dead end.
// ---------------------------------------------------------------------------

/** Largest body D8 will inline itself; beyond it the row joins bodyless. */
export const SF_NAMED_FRONTIER_MAX_BODY_BYTES = 32 * 1024;

/** Caller-named files (and, for D9, ambiguous candidates) joined in one call. */
export const SF_NAMED_FRONTIER_MAX_ROWS = 4;

export const SF_NAMED_FRONTIER_MAX_CANDIDATE_ROWS = 8;

/**
 * F9 (2026-09-04, ruling (a)): the bound a FOLLOW-UP `next` call's bounded
 * window is sized against for an over-bound caller-named file. Reuses ruling
 * F1's own retired constant value (FX-OH, 636fc67e) — that ruling's mistake
 * was inlining the window's bytes into the pack itself (measured as a new
 * early-byte cost, ruling F1'); sizing a call the CALLER makes next carries no
 * such cost, so the same "~8 KiB is a useful window" judgment still applies.
 */
export const SF_NAMED_FRONTIER_ANCHORED_MAX_BODY_BYTES = 8 * 1024;

// ---------------------------------------------------------------------------
// FX-OH F1 (2026-09-04), SUPERSEDED BY RULING F1' (FX-OH2, 2026-09-04) --
// AN UNAFFORDABLE CALLER-NAMED FILE IS NOT A WHOLE-FILE OBLIGATION, AND NOT AN
// EARLY-BYTE OBLIGATION EITHER.
//
// THE DEFECT, MEASURED (FX-OH). A caller-named file OVER the join bound used
// to join BODYLESS with `remaining_ranges:["1-<EOF>"]` -- the entire file
// minted as an addressable, unserved obligation. On the sealed SF05 replay
// that row was a 1,514-line, ~50 KB document, and following the wire's own
// continuations took the opening from 2 calls / 30,759 B to 4 calls /
// 82,934 B -- 3,491,284 byte-turns, 39.2 % of that 56-turn cell's whole
// resident cost. The flag withheld ZERO bytes it would otherwise have sent
// and ADDED 50 KB of reads.
//
// FX-OH's FIX (RETIRED). The row stayed and carried a BOUNDED, query-anchored
// window (never more than 8 KiB) with `remaining_ranges` set to the exact
// complement. That closed the whole-file obligation, but the deterministic
// replay gate (ruling (mm), build 6ab07eaf) then measured the WINDOW ITSELF as
// a NEW early-byte cost: SF05 all-nine rose to 40,887 B against an all-off
// baseline of 31,832 B -- the inline window is bytes the all-off arm never
// sent at all, and the row it produced still had a `remaining_ranges` other
// continuation heuristics could follow.
//
// THE RULE NOW (ruling F1'). An over-bound caller-named file adds NO evidence
// row -- neither the pre-FX-OH bodyless whole-file row nor FX-OH's windowed
// one. It is caller-named and belongs in `snapshot.requiredAddresses` (I-2)
// unconditionally (that ledger is untouched by this change: see
// `openSemanticFrontierPackState`'s `sfGroundedQueryFilePaths` join, which
// reads the query text and the workspace index directly, never this row), so
// dropping the ROW does not make the caller's own words inert -- only the
// EAGER, UNASKED-FOR shipment of bytes toward it. What the caller gets instead
// is a `frontier_index` entry (path + handle, no body, no `remaining`, ~100 B)
// so the file stays addressable by handle on the very first response: a
// FOLLOW-UP call the caller chooses to make, never a body or a continuation
// this response pushes on its own.
//
// Files within `SF_NAMED_FRONTIER_MAX_BODY_BYTES` (32 KiB) are UNCHANGED --
// FX-OH F1 never touched them, and this ruling doesn't either.
// ---------------------------------------------------------------------------

/**
 * The result of joining an over-bound caller-named file (ruling F1', FX-OH2):
 * addressable by handle, but no evidence row -- no body, no `remaining`, and
 * therefore nothing a continuation heuristic (the gap fallback, `TL_SF_DEMOTE`'s
 * `limit.next`) could ever point `next` at. The caller adds this to
 * `frontier_index` alone.
 */
export interface SfNamedFrontierIndexOnly {
  readonly frontierOnly: true;
  readonly path: string;
  readonly handle: string;
}

/**
 * A row for `relPath`.
 *
 * - `withBody` and the whole file fits the JOIN bound -> the whole body.
 * - `withBody` and it does not -> ruling F1' (FX-OH2): NO evidence row at
 *   all -- an {@link SfNamedFrontierIndexOnly} address for `frontier_index`.
 * - not `withBody` (D9's ambiguous candidates) -> addressable only, unchanged:
 *   those rows are a CHOICE offered, not a body withheld.
 */
// Exported for the FX-OH/FX-OH2 F1 pin (fxR3cNamedFrontier.spec.ts): the
// join's behaviour on an OVERSIZED caller-named file is a property of this
// function alone, and pinning it through a whole pack would depend on whether
// the locator happened to surface the same document by another route.
export function sfNamedFrontierRow(
  relPath: string,
  workspace: string,
  cache: FileReadCache,
  withBody: boolean,
): TaskPackSurface | SfNamedFrontierIndexOnly | undefined {
  const text = readCached(workspace, relPath, cache);
  if (text === undefined) return undefined;
  // A binary payload has no line body to serve; it stays out of the join
  // rather than shipping mojibake (the artifact lanes own those formats).
  if (text.includes("\u0000")) return undefined;
  const totalLines = Math.max(1, countLines(text));
  const range = `1-${totalLines}`;
  const handle = handleTable.upsert({ kind: "range", path: relPath, range, workspaceRoot: workspace }).id;
  const base = {
    role: "domain",
    handle,
    path: relPath,
    range,
    why: "caller-named in the request",
  };
  if (!withBody) {
    return { ...base, content_completeness: "partial" as const, remaining_ranges: [range] };
  }
  if (Buffer.byteLength(text, "utf8") <= SF_NAMED_FRONTIER_MAX_BODY_BYTES) {
    return { ...base, code: text };
  }
  // Ruling F1' (FX-OH2): over the join bound. No evidence row -- addressable
  // only, via `frontier_index`.
  return { frontierOnly: true, path: relPath, handle };
}

/**
 * Ruling F1' (FX-OH2, 2026-09-04): over-bound caller-named files the join
 * could not afford an evidence row for -- path + handle only. Populated by
 * `applySemanticFrontierNamedFrontier`, consumed and cleared by
 * `attachFrontierIndex` (both run inside the same `buildTaskPackCore` call),
 * so these addresses reach `frontier_index` without ever becoming a surface
 * a `next`/`limit.next` heuristic could target.
 */
export const pendingNamedFrontierOnlyEntries = new WeakMap<
  TaskPackResult,
  Array<{ path: string; handle: string }>
>();

/**
 * F9 (2026-09-04, ruling (a)): the bounded, query-anchored line range for a
 * FOLLOW-UP call's target — reusing ruling F1's retired anchor-line finder
 * and `centeredSliceForCap`'s window-growth algorithm (FX-OH, 636fc67e),
 * without inlining the resulting bytes anywhere: ruling F1' retired that
 * half of F1 (the early-byte cost), so this keeps only the "which window"
 * arithmetic, for a call the CALLER makes next rather than a body this pack
 * ships now. `undefined` on a genuine read/parse failure, or when the window
 * would cover the whole file anyway (no bound is needed) — the caller then
 * falls back to a plain whole-file direct read rather than a guessed range.
 */
export function sfNamedFrontierWindowRange(
  relPath: string,
  workspace: string,
  cache: FileReadCache,
  query: string,
): string | undefined {
  const text = readCached(workspace, relPath, cache);
  if (text === undefined) return undefined;
  const totalLines = Math.max(1, countLines(text));
  const tokens = concernAnchorTokens(query, 8)
    .map((token) => token.toLowerCase())
    .filter((token) => token.length >= 3);
  let anchorLine: number | undefined;
  if (tokens.length > 0) {
    const lines = text.split(/\r?\n/);
    let bestScore = 0;
    for (let index = 0; index < lines.length; index++) {
      const lower = lines[index]!.toLowerCase();
      if (lower === "") continue;
      let score = 0;
      for (const token of tokens) if (lower.includes(token)) score += 1;
      if (score > bestScore) {
        bestScore = score;
        anchorLine = index + 1;
      }
    }
  }
  const centre = anchorLine ?? 1;
  const slice = centeredSliceForCap(
    workspace,
    relPath,
    `1-${totalLines}`,
    cache,
    centre,
    SF_NAMED_FRONTIER_ANCHORED_MAX_BODY_BYTES,
  );
  if (slice === undefined) return undefined;
  // Recover the served bounds by POSITION relative to the centre — the same
  // pattern `singleSiteShortCircuitSeed` and the retired F1 window branch
  // both use: `centeredSliceForCap` caps each disclosed side
  // (MAX_REMAINING_RANGE_CHUNK_LINES), so matching on boundary VALUES would
  // silently mis-read the served window on a large file.
  let start = 1;
  let end = totalLines;
  for (const remaining of slice.remaining_ranges) {
    const bounds = /^(\d+)-(\d+)$/.exec(remaining);
    if (bounds === null) continue;
    const remStart = Number(bounds[1]);
    const remEnd = Number(bounds[2]);
    if (remEnd < centre) start = remEnd + 1;
    else if (remStart > centre) end = remStart - 1;
  }
  if (start <= 1 && end >= totalLines) return undefined;
  return `${start}-${end}`;
}

/**
 * Join every caller-named workspace file (and every ambiguous candidate) that
 * this pack does not already carry. Additive only: never removes, reorders or
 * rewrites an existing surface. Fails open — an SF defect is a trace line.
 */
export function applySemanticFrontierNamedFrontier(
  workspace: string,
  result: TaskPackResult,
  args: TaskPackArgs | undefined,
  effectiveQuery: string,
): void {
  if (!sfStatefulEnabled() || !sfStructuralConcernsEnabled()) return;
  if (effectiveQuery === "" || !Array.isArray(result.surfaces)) return;
  try {
    const held = new Set<string>();
    for (const surface of result.surfaces) {
      const path = (surface as { path?: unknown }).path;
      if (typeof path === "string" && path !== "") held.add(path);
    }
    const namedPaths = new Set(
      sfExplicitTargets(args?.paths)
        .map((t) => t.path)
        .filter((p): p is string => typeof p === "string" && p !== ""),
    );
    const { workspaceIndex } = sfCapabilitiesFor(args, workspace);
    const anchors = sfQueryFileAnchors(effectiveQuery, workspaceIndex, namedPaths);
    const cache = new FileReadCache();
    const joined: string[] = [];
    const frontierOnly: Array<{ path: string; handle: string }> = [];
    // F9 (ruling (a)): the direct-read window map for this pack, populated
    // for every PATH anchor this loop touches (not the D9 ambiguous
    // candidates below — those are a choice offered, never a single grounded
    // target `next` could read directly).
    const directWindows = new Map<string, string | undefined>();
    let named = 0;
    let ambiguous = 0;
    let withBody = 0;
    for (const anchor of anchors) {
      if (anchor.kind === "path") {
        if (!anchor.proven || held.has(anchor.path) || named >= SF_NAMED_FRONTIER_MAX_ROWS) continue;
        const row = sfNamedFrontierRow(anchor.path, workspace, cache, true);
        if (row === undefined) continue;
        held.add(anchor.path);
        joined.push(anchor.path);
        named += 1;
        // Ruling F1' (FX-OH2): an over-bound file. No evidence row -- an
        // address for `frontier_index` alone, never `result.surfaces` and
        // never marked (nothing here for W-DEMOTE/`withheld_named_count` to
        // have withheld).
        if ("frontierOnly" in row) {
          frontierOnly.push({ path: row.path, handle: row.handle });
          // F9 (ruling (a)): the bounded window this file's OWN `next` (once
          // this concern is selected) should target — never the whole file.
          directWindows.set(row.path, sfNamedFrontierWindowRange(row.path, workspace, cache, effectiveQuery));
          continue;
        }
        // FX-R3d (D10): a GROUNDED caller-named row that DID ship (whether a
        // whole-file body). The mark is taken unconditionally and the final
        // wire decides what survives `trimToCap`. It is what keeps a
        // bodyless caller-named row visible as `withheld_named_count` instead
        // of counting as a W-DEMOTE engagement it had no part in. D9's
        // ambiguous CANDIDATE rows below are deliberately bodyless by design
        // — a choice offered, not a body withheld — so they are NOT marked.
        markSemanticFrontierNamedJoin(row);
        result.surfaces.push(row);
        if (typeof row.code === "string") withBody += 1;
        // F9 (ruling (a)): within the join bound, this pack already inlined
        // the body (Fix (b), sfSatisfaction.ts, closes the concern from it
        // directly) — recorded with no window so a residual open concern
        // still gets the safe direct-read shape rather than the pre-F9
        // whole-file/`qref` one.
        directWindows.set(anchor.path, undefined);
        continue;
      }
      // D9: an ambiguous basename. Every candidate becomes addressable, none
      // gets a body — binding one at random is the masquerade D6 retired.
      for (const candidate of anchor.candidates) {
        if (held.has(candidate) || ambiguous >= SF_NAMED_FRONTIER_MAX_CANDIDATE_ROWS) continue;
        const row = sfNamedFrontierRow(candidate, workspace, cache, false);
        if (row === undefined || "frontierOnly" in row) continue; // withBody:false never mints this shape.
        held.add(candidate);
        result.surfaces.push(row);
        joined.push(candidate);
        ambiguous += 1;
      }
    }
    if (frontierOnly.length > 0) pendingNamedFrontierOnlyEntries.set(result, frontierOnly);
    if (directWindows.size > 0) pendingNamedFrontierWindows.set(result, directWindows);
    if (joined.length === 0) return;
    // `with_body` counts rows this join could afford to inline; the rest joined
    // addressably (handle + `remaining`, or ruling F1' frontier-index-only for
    // an over-bound file) and `trimToCap` may still strip more.
    trace(
      "sf_named_frontier_join",
      { joined, named, ambiguous, with_body: withBody, frontier_only: frontierOnly.length },
      workspace,
    );
  } catch (err) {
    try {
      trace(
        "sf_named_frontier_error",
        { message: err instanceof Error ? err.message : String(err) },
        workspace,
      );
    } catch {
      /* the trace channel is best-effort too */
    }
  }
}

/**
 * FX-I-A — the PRE-BOOKING seam: the last pass that can shed a body, run
 * before the first producer that books one.
 *
 * Called from `dedupeTrimAndPersist` right after
 * `annotateSemanticFrontierContinuation` has classified the FINAL pack (the
 * earliest point at which a surface can be known SF-supporting) and before
 * `bookServedEditAdmissibility`, `rememberCertifiedWorkingSet` and
 * `captureServedPack`/`recordPackServedRanges`. Opens this pack's SF context,
 * restates the canonical decision against it, and applies W-DEMOTE. With
 * `TL_SF_STATEFUL` off it returns immediately, so a flag-off pack is byte- and
 * state-identical by construction.
 */
export function applySemanticFrontierPreBookingSeam(
  workspace: string,
  result: TaskPackResult,
  args: TaskPackArgs | undefined,
  // D4 (FX-R3): the SAME query string the pre-seam
  // `annotateSemanticFrontierContinuation` call used, so the marking pass this
  // seam re-runs cannot diverge from it on its legacy half.
  effectiveQuery: string,
): void {
  if (!sfStatefulEnabled() || args === undefined) return;
  try {
    // W-VERIFY-GEN: fold `verify_obligations` (already attached to
    // `result.change_contract` by the contract builder) into `verify`
    // concerns for the same call — a purely additive, data-only extra
    // argument; see `openSemanticFrontierPackState`'s own doc for why this is
    // a hook, not new satisfaction logic.
    let verifyConcerns: SfStructuralConcern[] = [];
    if (sfVerifyFirstEnabled()) {
      try {
        const editObligations = (result.change_contract?.obligations ?? []).filter(
          (o) => o.action === "edit",
        );
        verifyConcerns = verifyObligationsToSfConcerns(
          editObligations,
          result.change_contract?.verify_obligations ?? [],
        );
      } catch {
        verifyConcerns = [];
      }
    }
    openSemanticFrontierPackState(args, workspace, result, verifyConcerns);
    // D4 (FX-R3, 2026-09-04): THE MARKING PASS, RE-RUN WITH THE V2 SOURCE.
    //
    // `annotateSemanticFrontierContinuation` runs once BEFORE this seam (it
    // needs the finalized `execution_contract` to tell a required surface from
    // a supporting one) — and at that point this pack's structural concerns do
    // not exist yet, so under `TL_SF_DEMOTE` that call marks nothing. The
    // concerns exist now: `openSemanticFrontierPackState` just extracted them
    // ONCE and published them on the pack context. Re-running the classifier
    // with them is what makes demotion structural rather than
    // vocabulary-driven. Marking is a monotone WeakSet add, so the earlier
    // (no-op under DEMOTE) call cannot contradict this one, and the legacy
    // guard arm never reaches here (`sfDemoteEnabled()` and the guard are
    // mutually exclusive; this call passes `guardEnabled:false`).
    if (sfDemoteEnabled()) {
      annotateSemanticFrontierContinuation(
        result,
        effectiveQuery,
        false,
        sfPackContextFor(result)?.concerns,
      );
    }
    // SF-8: the canonical exit that ran earlier in this build saw no SF
    // context, so W-DEMOTE's marking pass and W-NEXT-ARBITER's seat did
    // nothing. Re-run it now that the context exists, then withhold the
    // §3.5.1 `supporting` bodies. Both are flag- and context-gated inside.
    reapplySemanticFrontierDecision(result);
    applySemanticFrontierDemotion(result);
  } catch (err) {
    // I-1: an SF defect is a trace line, never a degraded pack.
    try {
      trace(
        "sf_pack_seam_error",
        { message: err instanceof Error ? err.message : String(err) },
        workspace,
      );
    } catch {
      /* the trace channel is best-effort too */
    }
  }
}
