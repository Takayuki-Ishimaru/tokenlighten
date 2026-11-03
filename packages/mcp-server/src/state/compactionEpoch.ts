/**
 * compactionEpoch.ts — drops every "the client already holds these bytes"
 * claim when an agent host compacted or cleared its conversation
 * (2026-11-03).
 *
 * WHY. The served-range ledger, the held window receipts
 * (`read.receipt` / `code_unchanged`, `heldBatchWindowEntry`), the find and
 * search dedupe ledgers and the verification-kit dedupe all answer a repeat
 * request with "you were sent this earlier" instead of bytes. They are right
 * as long as the model's context still holds what was sent. After a
 * compaction (or `/clear`) it does not, and the server kept answering with
 * receipts for content the model could no longer see.
 *
 * HOW. The CLI's hook adapters (`tl hook pre-compact` / `post-compact` /
 * `session-start`, for Claude Code, Codex and Copilot alike) rewrite one
 * marker file atomically: `.tokenlighten/.runtime/compaction-epoch.json`
 * (COMPACTION_MARKER_RELATIVE_PATH in @tokenlighten/types). `callTool`
 * calls `noteCompactionMarker` once per tool call, which costs ONE `stat`:
 * the (mtime, size, inode) signature is compared with the one this process
 * saw last for the workspace. The first observation only records; a later
 * change clears, in every lane of the workspace, exactly the state that
 * claims the client holds content (`clearServedContentState` in
 * state/session.ts lists it) plus the prior-pack obligations and the served
 * surfaces/windows of the task-pack serve log and the task-pack module's own
 * served-pack claims (`clearServedPackClaimsForWorkspace`: cached-pack and
 * subset receipts, prior-pack pointers, source capsules). Task handles, plans,
 * cursors, edit authority, the retained certificate and edit state stay: they
 * are valid server-side whatever the model remembers.
 *
 * Several sessions on one workspace share the marker, and no client id is
 * consulted: one session's compaction makes the others re-send at worst,
 * which is the cheap direction. TL_COMPACTION_MARKER=0 (util/flags.ts
 * `compactionMarkerEnabled`) turns the check off.
 *
 */

import { statSync } from "node:fs";
import { join } from "node:path";
import { COMPACTION_MARKER_RELATIVE_PATH } from "@tokenlighten/types";
import { compactionMarkerEnabled } from "../util/flags.js";
import { clearServedSurfaces, clearServedWindowsForScope } from "../util/packServeLog.js";
import { clearPriorPackObligations } from "../features/task-pack/priorPackStore.js";
import { clearServedPackClaimsForWorkspace } from "../features/task-pack/readCodeTaskPack.js";
import { clearServedContentState } from "./session.js";

/** Workspace root → the marker's stat signature this process saw last ("absent" for no marker). */
const lastSeen = new Map<string, string>();

/** The marker's stat signature, or undefined when the stat itself failed (a permission problem, a vanished root). */
export function compactionMarkerSignature(workspaceRoot: string): string | undefined {
  try {
    const stat = statSync(join(workspaceRoot, COMPACTION_MARKER_RELATIVE_PATH), { throwIfNoEntry: false });
    return stat === undefined ? "absent" : `${stat.mtimeMs}:${stat.size}:${stat.ino}`;
  } catch {
    return undefined;
  }
}

/**
 * Called once per tool call with the call's resolved workspace root (undefined
 * when the call's own validation will refuse the root). Returns true when it
 * reset the served-content claims.
 */
export function noteCompactionMarker(workspaceRoot: string | undefined): boolean {
  if (workspaceRoot === undefined || !compactionMarkerEnabled()) return false;
  const signature = compactionMarkerSignature(workspaceRoot);
  if (signature === undefined) return false;
  const prior = lastSeen.get(workspaceRoot);
  lastSeen.set(workspaceRoot, signature);
  // First sight is the baseline; a marker that disappeared compacted nothing.
  if (prior === undefined || prior === signature || signature === "absent") return false;
  resetServedContentClaims(workspaceRoot);
  return true;
}

/** Everything a compaction invalidates, and nothing else (see the module header). */
export function resetServedContentClaims(workspaceRoot: string): void {
  clearServedContentState(workspaceRoot);
  clearPriorPackObligations(workspaceRoot);
  clearServedSurfaces(workspaceRoot);
  clearServedWindowsForScope(workspaceRoot);
  clearServedPackClaimsForWorkspace(workspaceRoot);
}

/** Test hook: forget every baseline (testing/sessionReset.ts). */
export function resetCompactionMarkerForTest(): void {
  lastSeen.clear();
}
