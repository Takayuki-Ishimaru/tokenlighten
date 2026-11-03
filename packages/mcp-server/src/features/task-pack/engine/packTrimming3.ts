// packTrimming — extracted implementation; imports point to the owning modules.
import * as path from "path";
import type { AnswerStructureMap } from "./answerPackBuilder2.js";
import type { TaskPackArgs } from "../model.js";
import type { TaskPackResult } from "../model.js";
import type { TaskProfile } from "@tokenlighten/types";
import { FileReadCache } from "./packBasics2.js";
import { activePackByteCeiling } from "./packBasics2.js";
import { appendAdvisoryLine } from "../structureMapElsewhere.js";
import { applyCanonicalTaskDecision } from "../canonicalDecision.js";
import { buildTaskExecutionContract } from "./executionContract.js";
import { buildTaskWorkspaceState } from "./epochEvidence2.js";
import { certifiedWorkingSets } from "./epochContract3.js";
import { clampToActiveCeiling } from "./packBasics2.js";
import { codeTaskPackSurfaces } from "../artifactSections.js";
import { computeWorkspaceInventoryState } from "./epochEvidence2.js";
import { enforceNoDeadEndContract } from "./contractReconciliation.js";
import { getSession } from "../../../state/session.js";
import { laneScopedKey } from "../../../util/laneKey.js";
import { languageForPath } from "../../../util/languages.js";
import { normalizeContractLane } from "../../../util/packServeLog.js";
import { packWireBytes } from "./packTrimming.js";
import { protocolCallContext } from "../../../protocol/envelope.js";
import { publishAuxiliaryEnumPool } from "../auxiliaryEnumContextIntegration.js";
import { readCached } from "./packBasics2.js";
import { reconcileTaskPackExecutionContract } from "./contractReconciliation.js";
import { servedZoomScopeForArgs } from "./packState2.js";
import { structureMapElsewhereNote } from "../structureMapElsewhere.js";
import { trimNextAgainstShippedEvidence } from "./answerCertificates2.js";

/**
 * TL_EFF_MAP_ANSWER_FIRST: an adopted answer-first page that did not ship as the answer
 * (`AnswerFirstShip`) leaves the chain on the ordinary map's requirements — the facet plan
 * the request would have had without the flag is recorded again (`restoreOrdinaryFacetPlan`)
 * — and, if the pack still presents itself as the answer, its contract is derived again
 * over the recorded plan (as `enforceCertificateWireInvariant` does after a late pass
 * withdrew evidence), so the reply is the discover that names what the ordinary
 * requirements still need instead of an answer over the core without its advisory.
 */
export function rederiveAfterPlanRestore(result: TaskPackResult, args: TaskPackArgs, workspace: string): void {
  certifiedWorkingSets.delete(laneScopedKey(path.resolve(workspace)));
  const effectiveQuery = args.query ?? args.symbol ?? args.path ?? "";
  const profile: TaskProfile = result.coverage_basis === "cumulative"
    ? "generic"
    : result.profile_binding?.selected ?? "answer";
  result.execution_contract = buildTaskExecutionContract(
    result,
    profile,
    effectiveQuery,
    buildTaskWorkspaceState(result, workspace, computeWorkspaceInventoryState(workspace)),
    workspace,
    false,
    servedZoomScopeForArgs(args, effectiveQuery),
  );
  reconcileTaskPackExecutionContract(result);
  enforceNoDeadEndContract(result, effectiveQuery, { workspace, lane: normalizeContractLane(args.lane) });
  applyCanonicalTaskDecision(result);
  trimNextAgainstShippedEvidence(result);
}

/** What the `"advisory":` key and its comma cost on the wire when the pack had none. */
/**
 * A structure map is a map of ONE file. When the type has members in other files
 * — the methods a Go package declares in its other files, the `impl` blocks a
 * Rust crate keeps in other modules (structureMapElsewhere.ts) — the reply says
 * so in one line of its `advisory`, appended to whatever advisory the pack
 * already carries and never in its place: `38 more methods of Command are
 * declared in other files of this package: completions.go (20), …`. Those
 * members are in no row, no required window and no `remaining_ranges` of the map;
 * the line is what tells the reader the map is not the whole type.
 *
 * Optional content, like the answer-first advisory and the plan aids: attached
 * after the shed ladder, and under an active byte ceiling only in the room the
 * finished pack has left under it (measured as the pack is, `packWireBytes`),
 * so it can never push a reply that fits back over its ceiling. States nothing
 * for a pack that did not serve the map.
 */
export function attachStructureMapElsewhereNote(
  result: TaskPackResult,
  map: AnswerStructureMap | undefined,
  rendered: boolean,
  workspace: string,
  cache: FileReadCache,
): void {
  if (map === undefined || !rendered || !map.type.members.some((member) => member.outOfLine === true)) return;
  const lang = languageForPath(map.type.path);
  if (lang === undefined || !codeTaskPackSurfaces(result.surfaces).some((surface) => surface.path === map.type.path)) return;
  const note = structureMapElsewhereNote({
    workspace,
    lang,
    typeName: map.type.name,
    typePath: map.type.path,
    read: (relPath) => readCached(workspace, relPath, cache),
  });
  const cppNote = lang === "cpp" && map.otherMemberFiles !== undefined
    ? `The bounded C++ counterpart scan also found ${map.otherMemberFiles.reduce((sum, file) => sum + file.count, 0)} matching ${map.type.name} definition${map.otherMemberFiles.reduce((sum, file) => sum + file.count, 0) === 1 ? "" : "s"} in other source file${map.otherMemberFiles.length === 1 ? "" : "s"}: ${map.otherMemberFiles.map((file) => `${file.path} (${file.count})`).join(", " )}; this map includes only ${map.fileLayouts?.find((file) => file.path !== map.type.path)?.path ?? "the selected counterpart"}.`
    : undefined;
  const lines = [note, cppNote].filter((line): line is string => line !== undefined);
  if (lines.length === 0) return;
  const advisory = lines.reduce((current, line) => appendAdvisoryLine(current, line), result.advisory);
  const previous = result.advisory;
  result.advisory = advisory;
  if (activePackByteCeiling() !== undefined
    && packWireBytes(result) > clampToActiveCeiling(Number.MAX_SAFE_INTEGER)) {
    if (previous === undefined) delete result.advisory;
    else result.advisory = previous;
  }
}

/** Bind optional candidate reuse only after normal qref/task authentication. */
export function publishTaskPackAuxiliaryEnumPool(workspace: string, original: object,
  qref: string, binding: string, taskHandle: string): void {
  if (protocolCallContext()?.sizePreview === true) return;
  publishAuxiliaryEnumPool(original, getSession(workspace).activeTaskQuery,
    workspace, qref, binding, taskHandle);
}
