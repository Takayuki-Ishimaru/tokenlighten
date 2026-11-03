/**
 * compactionMarker.ts — the writer side of the compaction reset (2026-11-03).
 *
 * When a host compacts (or clears) its conversation, the model loses the file
 * bytes TokenLighten served earlier, while the MCP server's ledgers still say
 * the client holds them, so the next read of those lines comes back as a held
 * `read.receipt` or a `code_unchanged` entry instead of content. The hook
 * adapters call `recordCompactionEpoch` on the host's compaction/clear
 * events; the server (`packages/mcp-server/src/state/compactionEpoch.ts`)
 * `stat`s the marker on every tool call and drops exactly those claims when
 * the stat changed. Several sessions on one workspace share the marker: one
 * session's compaction re-sends content to the others at worst.
 *
 * The write is atomic (temporary file in the same directory, then rename) so
 * a server never reads a half-written body, and the body carries a counter
 * that only grows, for people reading the file.
 */

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { COMPACTION_MARKER_RELATIVE_PATH, type CompactionMarker } from "@tokenlighten/types";
import { ensureRuntimeDirectory } from "@tokenlighten/skeleton-engine";
import { retryRename } from "./atomicWrite.js";

export function compactionMarkerPath(workspaceRoot: string): string {
  return join(workspaceRoot, COMPACTION_MARKER_RELATIVE_PATH);
}

/** The current marker, or undefined when there is none or it is unreadable. */
export function readCompactionMarker(workspaceRoot: string): CompactionMarker | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(compactionMarkerPath(workspaceRoot), "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const record = parsed as Record<string, unknown>;
    if (record["schemaVersion"] !== 1 || typeof record["epoch"] !== "number") return undefined;
    return record as unknown as CompactionMarker;
  } catch {
    return undefined;
  }
}

export interface CompactionNote {
  event: string;
  source?: string;
  client?: string;
}

/**
 * Bumps the marker for `workspaceRoot`. Creates `.tokenlighten/.runtime/`
 * (and TokenLighten's managed `.gitignore`) when missing, never the
 * workspace itself: a missing root throws, and the caller treats that as
 * "nothing to mark".
 */
export function recordCompactionEpoch(workspaceRoot: string, note: CompactionNote, now: Date = new Date()): { path: string; epoch: number } {
  // ensureRuntimeDirectory validates and creates `.tokenlighten/` (plus its
  // managed .gitignore); the `.runtime/` directory itself is created here.
  ensureRuntimeDirectory(workspaceRoot);
  const path = compactionMarkerPath(workspaceRoot);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const previous = readCompactionMarker(workspaceRoot);
  const marker: CompactionMarker = {
    schemaVersion: 1,
    epoch: (previous?.epoch ?? 0) + 1,
    at: now.toISOString(),
    event: note.event,
    ...(note.source !== undefined ? { source: note.source } : {}),
    ...(note.client !== undefined ? { client: note.client } : {}),
  };
  const temporary = join(dirname(path), `.compaction-epoch.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  writeFileSync(temporary, `${JSON.stringify(marker)}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    retryRename(temporary, path, { renameFn: renameSync });
  } catch (error) {
    try { unlinkSync(temporary); } catch { /* retryRename already removed it */ }
    throw error;
  }
  return { path, epoch: marker.epoch };
}
