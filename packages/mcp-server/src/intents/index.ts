/**
 * intents/index.ts — deterministic edit intent dispatcher (v0.7 Phase 4).
 *
 * applyIntent routes an intent name to its implementation module.
 * Unknown intents return { ok: false, reason: "intent-unknown" }.
 *
 * Each intent returns a compact success or structured refusal. The caller
 * (server.ts edit_code handler) augments success with handle/sha.
 */

import type { HandleEntry } from "../util/handles.js";
import type { GuardedWorkspaceRoot } from "../write/guardedWorkspace.js";
import { applyRemoveDuplicateBranch } from "./removeDuplicateBranch.js";
import { applyAppendUnionMember } from "./appendUnionMember.js";
import { applyAppendEnumMember } from "./appendEnumMember.js";
import { applyRenameSymbolReferences } from "./renameSymbolReferences.js";

export type IntentResult =
  | ({ ok: true } & Record<string, unknown>)
  | { ok: false; reason: string; next?: string };

interface IntentArgs {
  /** Resolved workspace-relative path (from handle or explicit arg). */
  path: string;
  /** Inclusive 1-based "start-end" range from the handle (undefined for file handles). */
  range?: string;
  /** Resolved symbol name (from handle). */
  symbol?: string;
  /** New name / value to apply. */
  target?: string;
  /** Precondition string forwarded from edit_code args. */
  precondition?: string;
  /** Language hint. */
  lang?: string;
  /** The raw handle entry (for kind checks). */
  handle: HandleEntry;
  /** The raw handle id string. */
  handleId: string;
  /** Write-enable flag passed from server. */
  allowWrite: boolean;
  /** Session ID for checkpoints. */
  sessionId: string;
}

export async function applyIntent(
  intent: string,
  args: IntentArgs,
  workspace: GuardedWorkspaceRoot,
): Promise<IntentResult> {
  switch (intent) {
    case "remove-duplicate-branch": {
      // Accepts file, symbol, or range handles — all have a resolved path.
      // Pass range only for non-file handles so the scan is scoped to the handle's range.
      const rangeArg = args.handle.kind === "file" ? undefined : args.range;
      return applyRemoveDuplicateBranch(args.path, rangeArg, workspace, args.allowWrite, args.handleId);
    }

    case "append-union-member": {
      const target = args.target ?? "";
      return applyAppendUnionMember(
        args.path,
        args.symbol,
        target,
        workspace,
        args.allowWrite,
        args.handleId,
        args.lang,
      );
    }

    case "append-enum-member": {
      const target = args.target ?? "";
      return applyAppendEnumMember(
        args.path,
        args.symbol,
        target,
        workspace,
        args.allowWrite,
        args.handleId,
        args.lang,
      );
    }

    case "rename-symbol-references": {
      const target = args.target ?? "";
      return applyRenameSymbolReferences(
        args.handle,
        target,
        args.precondition,
        workspace,
        args.allowWrite,
        args.sessionId,
      );
    }

    default:
      return {
        ok: false,
        reason: "intent-unknown",
        next: "edit_file search=... replace=...",
      };
  }
}
