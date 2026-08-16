import {
  existsSync,
  lstatSync,
  readFileSync,
  renameSync,
  rmdirSync,
  unlinkSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { StubTargetId } from "@tokenlighten/types";
import { SENTINEL_END, SENTINEL_START } from "./sentinel.js";
import { renderTargetPreamble } from "./render.js";
import { assertSafeWriteTarget, ensureSafeWriteParent } from "./safeWritePath.js";

const TARGET_SENTINEL_START = "<!-- tokenlighten:target-agents:begin -->";
const TARGET_SENTINEL_END = "<!-- tokenlighten:target-agents:end -->";

/** Paths emitted before target-native rule formats were adopted. */
const LEGACY_PATHS: Partial<Record<StubTargetId, string>> = {
  cursor: ".cursor/rules/tokenlighten.md",
  cline: ".clinerules",
};

export interface LegacyMigrationResult {
  status: "none" | "migrated" | "blocked";
  reason?: string;
}

function isGeneratedOnly(text: string, target: StubTargetId): boolean {
  const normalized = text.replace(/\r\n?/g, "\n");
  const expectedPreamble = renderTargetPreamble(target).trim();
  const pairs = [
    [SENTINEL_START, SENTINEL_END],
    [TARGET_SENTINEL_START, TARGET_SENTINEL_END],
  ] as const;

  for (const [startMarker, endMarker] of pairs) {
    const start = normalized.indexOf(startMarker);
    const end = normalized.indexOf(endMarker, start + startMarker.length);
    if (start < 0 || end < 0) continue;

    const before = normalized.slice(0, start).trim();
    const after = normalized.slice(end + endMarker.length).trim();
    if (after === "" && (before === "" || before === expectedPreamble)) return true;
  }

  return false;
}

/**
 * Move a generated legacy rule to its current tool-native path. Files with
 * user prose outside TokenLighten's managed block are never moved or removed.
 */
export function migrateLegacyTargetPath(opts: {
  repoRoot: string;
  target: StubTargetId;
  nextPath: string;
  checkOnly?: boolean;
}): LegacyMigrationResult {
  const legacyPath = LEGACY_PATHS[opts.target];
  if (!legacyPath || legacyPath === opts.nextPath) return { status: "none" };

  const legacyAbs = join(opts.repoRoot, legacyPath);
  if (!existsSync(legacyAbs)) return { status: "none" };

  try {
    assertSafeWriteTarget(opts.repoRoot, legacyAbs);
    const stat = lstatSync(legacyAbs);
    if (stat.isDirectory() && dirname(join(opts.repoRoot, opts.nextPath)) === legacyAbs) {
      return { status: "none" };
    }
    if (!stat.isFile() || stat.isSymbolicLink()) {
      return {
        status: "blocked",
        reason: `legacy-path-conflict: ${legacyPath} is not a regular generated file`,
      };
    }

    const legacyText = readFileSync(legacyAbs, "utf8");
    if (!isGeneratedOnly(legacyText, opts.target)) {
      return {
        status: "blocked",
        reason: `legacy-path-manual-content: move ${legacyPath} manually before regenerating`,
      };
    }

    if (opts.checkOnly) {
      return {
        status: "blocked",
        reason: `legacy-target-path: run tl-agents update to migrate ${legacyPath} → ${opts.nextPath}`,
      };
    }

    const nextAbs = join(opts.repoRoot, opts.nextPath);
    if (existsSync(nextAbs)) {
      assertSafeWriteTarget(opts.repoRoot, nextAbs);
      unlinkSync(legacyAbs);
      return { status: "migrated" };
    }

    const nextDir = dirname(nextAbs);
    if (nextDir === legacyAbs) {
      // Cline changed from a root file to a directory. Move the file aside
      // first so the directory can be created, then atomically move it in.
      const temporary = `${legacyAbs}.tl-migrate-${process.pid}`;
      renameSync(legacyAbs, temporary);
      try {
        ensureSafeWriteParent(opts.repoRoot, nextAbs, true);
        renameSync(temporary, nextAbs);
      } catch (error) {
        try { rmdirSync(nextDir); } catch { /* keep the original error */ }
        try { renameSync(temporary, legacyAbs); } catch { /* best effort rollback */ }
        throw error;
      }
    } else {
      ensureSafeWriteParent(opts.repoRoot, nextAbs, true);
      renameSync(legacyAbs, nextAbs);
    }

    return { status: "migrated" };
  } catch (error) {
    return { status: "blocked", reason: `legacy-migration-error: ${String(error)}` };
  }
}
