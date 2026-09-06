/**
 * renameSymbolReferences.ts — intent: rename-symbol-references.
 *
 * Enforces the precondition that the caller has reviewed references
 * (precondition="references-reviewed"), then delegates to tools/renameSymbol.ts.
 *
 * Refuses if:
 *   - handle is not a symbol kind
 *   - target is not a valid identifier ([A-Za-z_][A-Za-z0-9_]*)
 *   - precondition "references-reviewed" was not explicitly supplied
 *   - renameSymbol returns an error
 */

import type { ToolCall } from "@tokenlighten/types";
import { renameSymbol } from "../tools/renameSymbol.js";
import type { HandleEntry } from "../util/handles.js";
import type { GuardedWorkspaceRoot } from "../write/guardedWorkspace.js";

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export type RenameSymbolReferencesResult =
  | { ok: true; from: string; to: string; changed_files: unknown[]; total_replacements: number; skipped: unknown[]; checkpoint: string | null }
  | { ok: false; reason: string; next?: ToolCall; detail?: string };

export async function applyRenameSymbolReferences(
  handle: HandleEntry,
  target: string,
  precondition: string | undefined,
  workspace: GuardedWorkspaceRoot,
  allowWrite: boolean,
  sessionId: string,
): Promise<RenameSymbolReferencesResult> {
  // Must be a symbol handle.
  if (handle.kind !== "symbol") {
    return {
      ok: false,
      reason: "intent-unsupported",
      detail: "handle must be kind=symbol — use read_file with a symbol target to get one",
    };
  }

  // Caller must have acknowledged they reviewed references.
  if (precondition !== "references-reviewed") {
    return {
      ok: false,
      reason: "intent-unsupported",
      ...(handle.symbol
        ? { next: { tool: "search_files", arguments: { action: "references", queries: [handle.symbol] } } }
        : {}),
      detail: "set precondition=references-reviewed after reviewing the emitted reference search",
    };
  }

  if (!target || !IDENT_RE.test(target)) {
    return {
      ok: false,
      reason: "intent-unsupported",
      detail: "target must be a valid identifier [A-Za-z_][A-Za-z0-9_]*",
    };
  }

  const symbolName = handle.symbol;
  if (!symbolName) {
    return {
      ok: false,
      reason: "intent-unsupported",
      detail: "handle has no symbol name",
    };
  }

  // Do NOT pass handle.path — rename workspace-wide so all call sites are updated.
  // The handle.path is the definition file only; references span the whole workspace.
  const result = await renameSymbol(
    {
      from: symbolName,
      to: target,
    },
    workspace,
    allowWrite,
    sessionId,
  );

  if (!result.ok) {
    return {
      ok: false,
      reason: "intent-unsupported",
      detail: result.error,
    };
  }

  return {
    ok: true,
    from: result.from,
    to: result.to,
    changed_files: result.changed_files,
    total_replacements: result.total_replacements,
    skipped: result.skipped,
    checkpoint: result.checkpoint,
  };
}
