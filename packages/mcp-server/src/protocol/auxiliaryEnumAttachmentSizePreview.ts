import type {TaskExecutionContract} from "@tokenlighten/types";
import type {TaskPackResult} from "../features/task-pack/model.js";
import {isAuxiliaryEnumSurface} from "../features/task-pack/auxiliaryEnumContextIntegration.js";
import {deriveCanonicalTaskDecision} from "../features/task-pack/canonicalDecision.js";
import {projectEvidence, projectTaskDecision, projectTaskRef, packUnchangedPriorLabel} from "./decisionWire.js";
import {projectReadBody} from "./readFamily.js";
import {applySourceFidelity} from "./sourceFidelity.js";
import {isExactContiguousBody, preferExactAnswerBody} from "./answerBodyPolicy.js";
import {readWorkspaceFileSync} from "./lineGutter.js";
import {handleTable} from "../util/handles.js";
import {measureResponseBytes} from "./budget/measure.js";
import {groupEvidencePaths} from "./evidencePathGroups.js";
import {protocolCallContext, runWithProtocolCall} from "./envelope.js";
import {semanticFrontierGuardEnabled, sfDemoteEnabled} from "../util/flags.js";

/** Attachment-only measurement, after primary change readiness is complete.
 * The normal pack shedder keeps its existing measurement. Auxiliary windows
 * contribute bytes here, never a decision, obligation, certificate or booking.
 */
export function auxiliaryEnumAttachmentSizePreview(result: TaskPackResult, clientId: string | undefined): number | undefined {
  if (result.task_profile === "answer" || result.change_contract?.status !== "ready"
    || result.execution_contract?.typestate?.phase !== "prepared" || !preferExactAnswerBody(clientId)
    || semanticFrontierGuardEnabled() || sfDemoteEnabled()) return undefined;
  const auxiliary = result.surfaces.filter(isAuxiliaryEnumSurface);
  const primary = result.surfaces.filter(row => !isAuxiliaryEnumSurface(row));
  if (!auxiliary.length || !primary.length) return undefined;
  const context = protocolCallContext();
  try {
    return runWithProtocolCall({...context, tool: context?.tool ?? "tl_read_file", clientId, sizePreview: true}, () => {
      // Detach all public mutable values; no projector receives production state.
      const copy = JSON.parse(JSON.stringify({...result, surfaces: primary})) as Record<string, unknown>;
      const contract = copy["execution_contract"] as TaskExecutionContract;
      const primaryEvidence = projectEvidence(primary, packUnchangedPriorLabel(copy));
      const canonical = deriveCanonicalTaskDecision(copy as unknown as TaskPackResult);
      const decision = projectTaskDecision({result: copy, contract, canonicalKind: canonical?.kind, evidence: primaryEvidence});
      if (decision?.kind !== "act.edit") return undefined;
      const evidence = [...primaryEvidence, ...projectEvidence(auxiliary, packUnchangedPriorLabel(copy))];
      const task = {...projectTaskRef(copy, contract, "size-preview"), id: "x".repeat(192)};
      const projected = projectReadBody("read.task_pack", {...copy, task, profile: "generic", evidence, decision});
      const first = primary.find(row => row.handle !== undefined);
      const workspace = context?.workspace ?? context?.codecTraceWorkspace
        ?? (first === undefined ? undefined : handleTable.get(first.handle)?.workspaceRoot);
      if (!workspace) return undefined;
      const primaryPaths = new Set(primary.map(row => row.path));
      if (auxiliary.some(row => primaryPaths.has(row.path))) return undefined;
      const baseline = applySourceFidelity(projectReadBody("read.task_pack", {
        ...copy, task, profile:"generic", evidence:primaryEvidence, decision,
      }), "read.task_pack", {readServeWorkspace:workspace});
      const faithful = applySourceFidelity(projected, "read.task_pack", {readServeWorkspace: workspace});
      const rows = faithful["evidence"];
      const sources = new Map<string, string | undefined>();
      // Fidelity can split a disjoint primary body into exact windows. Compare
      // against the identical primary-only projection, rather than its earlier
      // construction row count, to prove attachment does not drop primary bytes.
      if (!Array.isArray(rows) || !Array.isArray(baseline["evidence"])
        || JSON.stringify(rows.filter(row => row !== null && typeof row === "object"
          && primaryPaths.has((row as Record<string, unknown>)["path"] as string))) !== JSON.stringify(baseline["evidence"])
        || rows.length - baseline["evidence"].length !== auxiliary.length || rows.some(row => {
        if (row === null || typeof row !== "object") return true;
        const entry = row as Record<string, unknown>;
        if (typeof entry["body"] !== "string") return false;
        const span = typeof entry["range"] === "string" ? /^([0-9]+)-([0-9]+)$/.exec(entry["range"]) : null;
        const file = entry["path"];
        if (!span || typeof file !== "string") return true;
        const handle = entry["handle"];
        const bound = typeof handle === "string" ? handleTable.get(handle) : undefined;
        // Only the adapter's marked, not-yet-minted placeholder is a size-only
        // exception. It still needs the exact fresh source proof below.
        const placeholder = handle === "h0000000000" && auxiliary.some(surface =>
          surface.handle === handle && surface.path === file && surface.range === entry["range"]);
        if (typeof handle === "string" && !placeholder
          && (!bound || bound.path !== file || bound.workspaceRoot !== workspace)) return true;
        if (!sources.has(file)) sources.set(file, readWorkspaceFileSync(file, workspace));
        const source = sources.get(file);
        return source === undefined || !isExactContiguousBody(entry["body"], source, Number(span[1]), Number(span[2]));
      })) return undefined;
      // Same task placeholder and post-projection reserve as the answer preview.
      // TL_EFF_EVIDENCE_PATH_GROUPS: priced as the grouped rows ship (emit.ts); the identity while the flag is off.
      return measureResponseBytes(JSON.stringify(groupEvidencePaths({v: 1, kind: "read.task_pack", ...faithful}))) + 512;
    });
  } catch {
    return undefined;
  }
}
