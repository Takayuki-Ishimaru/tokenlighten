// packState — extracted implementation; imports point to the owning modules.
import type { ServedPackRecord } from "./packState2.js";
import type { TaskPackSurface } from "../model.js";
import type { TaskWorkspaceState } from "@tokenlighten/types";
import type { WorkspaceInventoryState } from "./epochEvidence2.js";
import { buildTaskWorkspaceState } from "./epochEvidence2.js";

/**
 * D2 (F-B2): the ONE workspace_state computation both sides of
 * `revalidateRecordToReceipt`'s freshness equality run — over a record's OWN
 * stored surfaces, never over a certificate's possibly-broader evidence list.
 * `captureServedPack` calls it once to stamp `ServedPackRecord.workspaceState`;
 * the revalidation calls it again against live disk and the current inventory.
 * Both callers hash the SAME surface identity list by construction, so the only
 * thing their comparison can detect is an actual change on disk — which is
 * precisely what the receipt's "you already hold these exact bytes" claim needs
 * proved, and all it ever proved.
 */
export function recordWorkspaceState(
  workspace: string,
  record: Pick<ServedPackRecord, "surfaces" | "coverage" | "missing">,
  inventory: WorkspaceInventoryState,
): TaskWorkspaceState {
  return buildTaskWorkspaceState({
    mode: "task_pack",
    coverage: record.coverage,
    surfaces: record.surfaces as TaskPackSurface[],
    missing: record.missing,
  }, workspace, inventory);
}
