// semanticFrontier — extracted implementation; imports point to the owning modules.
import * as fs from "fs";
import type { SfContinuationAddress } from "../sfContinuationBundle.js";
import type { SfContinuationFill } from "../sfContinuationBundle.js";
import type { SfContinuationNamedTest } from "../sfContinuationBundle.js";
import type { SfContinuationWorkspaceIndex } from "../sfContinuationBundle.js";
import type { TaskPackResult } from "../model.js";
import { FileReadCache } from "./packBasics2.js";
import { attachSfContinuationFills } from "../sfContinuationBundle.js";
import { buildStructuralContinuation } from "../sfContinuationBundle.js";
import { countLines } from "../../../util/countLines.js";
import { createSessionLedgerReader } from "../../../task-state/sfLedgerReader.js";
import { handleTable } from "../../../util/handles.js";
import { isWithin } from "../../../util/safePath.js";
import { readCached } from "./packBasics2.js";
import { resolveReal } from "../../../util/safePath.js";
import { safeResolve } from "../../../util/safePath.js";
import { sfContinuationBundleEnabled } from "../../../util/flags.js";
import { sfPackContextFor } from "../sfSatisfaction.js";
import { sfStatefulEnabled } from "../../../util/flags.js";
import { trace } from "../../../util/trace.js";

/**
 * F9 (2026-09-04, ruling (a)): every caller-named path this join touched,
 * keyed by workspace-relative path, `undefined` when no bounded window is
 * needed (the file joined within `SF_NAMED_FRONTIER_MAX_BODY_BYTES`, or a
 * window could not be computed). Read by `openSemanticFrontierPackState` /
 * `applySemanticFrontierRelationPackets` and folded into `SfPackContext`
 * (`sfSatisfaction.ts`) for `selectCanonicalNext.ts` alone — never consumed
 * or cleared, since (unlike `pendingNamedFrontierOnlyEntries`) nothing about
 * it is wire-shaped and more than one attach site reads it.
 */
export const pendingNamedFrontierWindows = new WeakMap<TaskPackResult, Map<string, string | undefined>>();

/** The F9 direct-read window map `applySemanticFrontierNamedFrontier` built for `result`, if any. */
export function sfNamedFrontierDirectWindowsFor(
  result: TaskPackResult,
): ReadonlyMap<string, string | undefined> | undefined {
  return pendingNamedFrontierWindows.get(result);
}

// ---------------------------------------------------------------------------
// W-CONT-BUNDLE (2026-09-02): the structural continuation bundle wiring
// seam. DESIGN-v0.15-sf-continuation-and-metrics.md §3.1 / ratified DC2 — a
// prediction may ONLY fill `evidence[]`/`remaining` slack under budget, and
// must NEVER construct or override `decision.next` (that stays
// `selectCanonicalNext`'s, W-DEMOTE). Runs strictly AFTER
// `applySemanticFrontierState` — it needs that call's `attachSfPackContext`
// to know this pack's concerns — and mutates `result.surfaces` ADDITIVELY
// only: it appends bodyless rows and never removes, reorders, or rewrites an
// existing entry. Fails open like its neighbor above: any error is a trace
// line, never a degraded pack.
// ---------------------------------------------------------------------------

export const SF_CONTINUATION_CANDIDATE_EXTS: readonly string[] = [
  ".c", ".cc", ".cpp", ".cxx", ".m", ".mm",
  ".ts", ".tsx", ".js", ".jsx",
  ".go", ".java", ".kt", ".py", ".rb", ".rs", ".swift", ".php",
];

export function sfContinuationRoleForSurface(role: SfContinuationFill["role"]): string {
  switch (role) {
    case "declaration":
      return "contract";
    case "test":
      return "test";
    case "definition":
    case "counterpart":
    default:
      return "domain";
  }
}

/**
 * A SMALL, bounded same-stem probe near `declarationPath` (never a directory
 * walk or a content search): the same basename under a fixed list of
 * implementation extensions, each checked with the same safe-path pattern
 * `singleSiteShortCircuitSeed` already uses (`safeResolve` + `realpathSync`
 * + `isWithin` against the resolved real workspace root).
 */
export function sfContinuationCandidatePathsNear(declarationPath: string, workspace: string): string[] {
  const slash = Math.max(declarationPath.lastIndexOf("/"), declarationPath.lastIndexOf("\\"));
  const dir = slash === -1 ? "" : declarationPath.slice(0, slash);
  const base = slash === -1 ? declarationPath : declarationPath.slice(slash + 1);
  const stem = base.replace(/\.d\.(?:[cm]?ts|tsx)$/i, "").replace(/\.[^.]+$/, "");
  const out: string[] = [];
  let root: string;
  try {
    root = resolveReal(workspace);
  } catch {
    return out;
  }
  for (const ext of SF_CONTINUATION_CANDIDATE_EXTS) {
    const candidate = dir === "" ? `${stem}${ext}` : `${dir}/${stem}${ext}`;
    const abs = safeResolve(candidate, workspace);
    if (abs === undefined) continue;
    try {
      const real = fs.realpathSync(abs);
      if (!isWithin(real, root) || !fs.statSync(real).isFile()) continue;
      out.push(candidate);
    } catch {
      continue;
    }
  }
  return out;
}

/** A real handle + total line count for `relPath`, or undefined when unreadable. Never a partial read. */
export function sfContinuationResolveAddress(
  relPath: string,
  workspace: string,
  cache: FileReadCache,
): SfContinuationAddress | undefined {
  const text = readCached(workspace, relPath, cache);
  if (text === undefined) return undefined;
  const totalLines = Math.max(1, countLines(text));
  const handle = handleTable.upsert({
    kind: "range",
    path: relPath,
    range: `1-${totalLines}`,
    workspaceRoot: workspace,
  }).id;
  return { handle, totalLines };
}

/**
 * A verification-manifest-named referencing test for `relPath`, when
 * `TL_SF_VERIFY_FIRST` already populated `change_contract.verify_obligations`
 * with one. This module never derives a test surface itself — it only reads
 * an obligation another wave already proved.
 */
export function sfContinuationNamedTestFor(
  relPath: string,
  result: TaskPackResult,
  workspace: string,
  cache: FileReadCache,
): SfContinuationNamedTest | undefined {
  const obligations = result.change_contract?.verify_obligations ?? [];
  for (const obligation of obligations) {
    if (obligation.kind !== "referencing-test") continue;
    if (!obligation.targets.includes(relPath)) continue;
    for (const proof of obligation.evidence ?? []) {
      if (typeof proof.path !== "string" || proof.path === "") continue;
      if (typeof proof.handle !== "string" || proof.handle === "") continue;
      const address = sfContinuationResolveAddress(proof.path, workspace, cache);
      if (address === undefined) continue;
      return { path: proof.path, handle: proof.handle, totalLines: address.totalLines };
    }
  }
  return undefined;
}

export function applySfContinuationBundle(result: TaskPackResult, workspace: string): void {
  if (!sfStatefulEnabled() || !sfContinuationBundleEnabled()) return;
  try {
    const ctx = sfPackContextFor(result);
    if (ctx === undefined || ctx.observationOnly) return;

    const servedPaths = new Set<string>();
    for (const surface of result.surfaces ?? []) {
      if (typeof surface.path === "string" && surface.path !== "") servedPaths.add(surface.path);
    }
    for (const entry of result.frontier_index ?? []) {
      if (typeof entry.path === "string" && entry.path !== "") servedPaths.add(entry.path);
    }

    const cache = new FileReadCache();
    const ledger = createSessionLedgerReader(workspace);
    const workspaceIndex: SfContinuationWorkspaceIndex = {
      resolveAddress: (relPath) => sfContinuationResolveAddress(relPath, workspace, cache),
      candidatePathsNear: (declarationPath) => sfContinuationCandidatePathsNear(declarationPath, workspace),
      namedTestFor: (relPath) => sfContinuationNamedTestFor(relPath, result, workspace, cache),
      isServed: (relPath) => ledger.hasServedPath(relPath),
    };

    const fills = buildStructuralContinuation({
      concerns: ctx.concerns,
      servedPaths,
      workspaceIndex,
    });
    attachSfContinuationFills(result, fills);
    if (fills.length === 0) return;

    for (const fill of fills) {
      result.surfaces.push({
        role: sfContinuationRoleForSurface(fill.role),
        handle: fill.handle,
        path: fill.path,
        range: fill.remaining[0] ?? "",
        remaining_ranges: [...fill.remaining],
      });
    }
  } catch (err) {
    // I-1: an SF defect is a trace line, never a degraded pack.
    try {
      trace(
        "sf_continuation_seam_error",
        { message: err instanceof Error ? err.message : String(err) },
        workspace,
      );
    } catch {
      /* the trace channel is best-effort too */
    }
  }
}

// ---------------------------------------------------------------------------
// T2 (2026-08-27, v0.12 wave D2): pre-pipeline single-site short circuit.
//
// A natural-language generic edit query often already names an exact
// workspace file inline ("packages/backend/src/telemetry/estimator.ts の
// PACKET_LOSS_FAILURE を 0.12->0.15") without using the structured `paths`
// argument. Before this, such a query fell all the way through to the
// pathless multi-layer locator (locateTaskContext) -- the same expensive,
// whole-repository candidate search a completely unscoped query pays for --
// even though the ONE relevant file and the ONE relevant identifier are both
// already unambiguously named. When that identifier/literal resolves to
// exactly one occurrence in that one file, singleSiteShortCircuitSeed hands
// buildSeededTaskPack an EXPLICIT, identifier-centered range (never the whole
// file, never a caller-inferred anchor-focus window), so the served pack
// stays small end-to-end while still running through the exact same
// certificate/obligation/canonical-decision machinery every other seeded
// pack does. This is deliberately the "narrow the pipeline's evidence"
// design, not a hand-rolled execution_contract: buildTaskExecutionContract's
// obligation/falsification/risk/certificate chain is reused unmodified via
// the shared dedupeTrimAndPersist exit, so every canonicalDecision invariant
// is satisfied by construction rather than re-approximated here.
//
// Fails OPEN (returns undefined -> the normal profile routing below runs
// unchanged) on any ambiguity: more or fewer than one existing path named in
// the query, more or fewer than one occurrence of the bound literal/
// identifier in that file, or a query shaped like a batch/independent-
// concern/rename request. The batch/rename exclusion signals are exactly the
// ones attachSingleSiteUniqueMatchFastPath already trusts for the identical
// safety reason: such a request must never be approximated as a single-site
// edit, however cleanly a path happens to parse out of its text.
// Byte, not line, budget for the identifier-centered slice -- see the
// centeredSliceForCap call below for why (dense vs. sparse real code lines).
export const SINGLE_SITE_SHORT_CIRCUIT_MAX_CODE_BYTES = 700;

export const SINGLE_SITE_SHORT_CIRCUIT_PATH_RE = /(?:[A-Za-z]:)?(?:[\w.-]+[/\\])+[\w.-]+\.[A-Za-z][A-Za-z0-9]{0,9}\b/g;
