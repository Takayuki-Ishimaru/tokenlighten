// Plain data output — no meta envelope. See docs/00-postmortem.md §2.2.
//
// injectAll: orchestrates injection into AGENTS.md + 5 stub files.
// Spec: docs/components/04-agents-md-generator.md §2, §3, §7, §9.

import { readFileSync, writeFileSync, lstatSync, readdirSync, existsSync, renameSync, unlinkSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import type { StubTargetId, GenerateResult } from "@tokenlighten/types";
import { STUB_TARGETS, STUB_TARGET_BY_ID } from "./stubs.js";
import { renderBlock, renderCanonicalBlock, INSTRUCTIONS_VERSION, blockSha256 } from "./render.js";
import { rewrite, DriftMode, restoreEol } from "./inject.js";
import { detectEol, stripBom, sha256hex } from "./sentinel.js";
import type { Clock } from "./clock.js";
import { RealClock } from "./clock.js";
import type { Locale } from "./render.js";
import { migrateLegacyTargetPath } from "./migrateLegacyTarget.js";
import { assertSafeWriteTarget, ensureSafeWriteParent } from "./safeWritePath.js";

/** Maximum file size to parse (5 MB). Files larger than this are refused. */
const MAX_FILE_BYTES = 5 * 1024 * 1024;

/** Directory for backup files. */
const BACKUP_DIR = ".tokenlighten/backups";

export interface InjectAllConfig {
  /** Absolute path to the repo root. */
  repoRoot: string;
  /**
   * Drift mode.
   * - "auto-rewrite" (default): silently rewrite outdated blocks.
   * - "diff-warn": warn to stderr but leave file unchanged.
   * - "fail-build": exit 1 on drift.
   */
  driftMode?: DriftMode;
  /**
   * Which stub targets to process. Defaults to all 5.
   * The canonical AGENTS.md is always processed first.
   */
  targets?: StubTargetId[];
  /**
   * Template locale. Defaults to "en".
   * Precedence: config > env TL_AGENTS_LOCALE > "en".
   */
  locale?: Locale;
  /**
   * Version string to embed. Defaults to INSTRUCTIONS_VERSION.
   */
  version?: string;
  /**
   * If true, skip manual-edit detection and overwrite in all drift modes.
   */
  force?: boolean;
  /**
   * Injectable clock (for deterministic backup timestamps in tests).
   */
  clock?: Clock;
}

/**
 * Inject the canonical managed block into AGENTS.md and the 5 stub files.
 * Returns a GenerateResult describing what happened.
 *
 * @param config  Injection configuration.
 */
export async function injectAll(config: InjectAllConfig): Promise<GenerateResult> {
  const {
    repoRoot,
    driftMode = "auto-rewrite",
    targets,
    locale = resolveLocale(config.locale),
    version = INSTRUCTIONS_VERSION,
    force = false,
    clock = RealClock,
  } = config;

  const result: GenerateResult = { wrote: [], skipped: [], drifted: [] };

  const sha = blockSha256(locale, version);

  // Process AGENTS.md (canonical primary block)
  const agentsBlock = renderCanonicalBlock(locale, version);
  await processFile({
    repoRoot,
    relPath: "AGENTS.md",
    canonical: agentsBlock,
    version,
    sha,
    driftMode: force ? "auto-rewrite" : driftMode,
    result,
    clock,
  });

  // Process each stub target
  const targetIds: StubTargetId[] = targets ?? (STUB_TARGETS.map((t) => t.id) as StubTargetId[]);
  for (const id of targetIds) {
    const target = STUB_TARGET_BY_ID[id];
    if (!target) {
      result.skipped.push({ path: id, reason: `unknown-target-id` });
      continue;
    }
    const effectiveDriftMode = force ? "auto-rewrite" : driftMode;
    const migration = migrateLegacyTargetPath({
      repoRoot,
      target: target.id,
      nextPath: target.file,
      checkOnly: effectiveDriftMode === "fail-build",
    });
    if (migration.status === "blocked") {
      result.skipped.push({ path: target.file, reason: migration.reason ?? "legacy-migration-blocked" });
      if (effectiveDriftMode === "fail-build") {
        result.drifted.push({ path: target.file, expected: sha, actual: "legacy-path" });
      }
      continue;
    }
    const block = renderBlock(target.id, locale, version);
    const targetSha = blockSha256(locale, version, target.id);
    await processFile({
      repoRoot,
      relPath: target.file,
      canonical: block,
      version,
      sha: targetSha,
      driftMode: effectiveDriftMode,
      result,
      clock,
    });
  }

  if (driftMode === "fail-build" && result.drifted.length > 0) {
    process.exitCode = 1;
  }

  return result;
}

export interface RemoveAllConfig {
  /** Absolute path to the repo root. */
  repoRoot: string;
  /** Defaults to all five generated stub targets. */
  targets?: readonly StubTargetId[];
  /** Report matching managed blocks without changing files. */
  dryRun?: boolean;
}

export interface RemoveAllResult {
  removed: string[];
  planned: string[];
  skipped: Array<{ path: string; reason: string }>;
  errors: Array<{ path: string; reason: string }>;
}

const MANAGED_BLOCK_START = "<!-- tokenlighten:mcp-instructions:start -->";
const MANAGED_BLOCK_END = "<!-- tokenlighten:mcp-instructions:end -->";

/**
 * Remove only blocks owned by TokenLighten's exact sentinels. User text is
 * retained byte-for-byte; malformed, oversized, symlinked, or racing targets
 * fail closed.
 */
export async function removeAll(config: RemoveAllConfig): Promise<RemoveAllResult> {
  const result: RemoveAllResult = { removed: [], planned: [], skipped: [], errors: [] };
  const repoRoot = config.repoRoot;
  try {
    const rootStat = lstatSync(repoRoot);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
      throw new Error("repo root must be a real directory");
    }
  } catch (error: unknown) {
    result.errors.push({ path: repoRoot, reason: `invalid-repo-root: ${String(error)}` });
    return result;
  }
  const ids = config.targets
    ?? (STUB_TARGETS.map((target) => target.id) as StubTargetId[]);
  const paths = [
    "AGENTS.md",
    ...ids.flatMap((id) => {
      const target = STUB_TARGET_BY_ID[id];
      if (!target) {
        result.skipped.push({ path: id, reason: "unknown-target-id" });
        return [];
      }
      return [target.file];
    }),
  ];

  for (const relPath of paths) {
    const absPath = join(repoRoot, relPath);
    if (!existsSync(absPath)) {
      result.skipped.push({ path: relPath, reason: "not-found" });
      continue;
    }
    let beforeStat;
    let existing: string;
    try {
      assertSafeWriteTarget(repoRoot, absPath);
      beforeStat = lstatSync(absPath);
      if (beforeStat.isSymbolicLink() || !beforeStat.isFile()) {
        result.errors.push({ path: relPath, reason: "unsafe-target-type" });
        continue;
      }
      if (beforeStat.size > MAX_FILE_BYTES) {
        result.errors.push({ path: relPath, reason: "oversized" });
        continue;
      }
      const parentDir = dirname(absPath);
      const fileName = basename(absPath);
      const collisions = readdirSync(parentDir).filter(
        (s) => s.toLowerCase() === fileName.toLowerCase() && s !== fileName,
      );
      if (collisions.length > 0) {
        result.errors.push({ path: relPath, reason: "case-collision" });
        continue;
      }
      existing = readFileSync(absPath, "utf8");
    } catch (error: unknown) {
      result.errors.push({ path: relPath, reason: `read-refused: ${String(error)}` });
      continue;
    }

    const start = existing.indexOf(MANAGED_BLOCK_START);
    const end = existing.indexOf(MANAGED_BLOCK_END);
    const oneStart = start >= 0
      && existing.indexOf(MANAGED_BLOCK_START, start + MANAGED_BLOCK_START.length) < 0;
    const oneEnd = end >= 0
      && existing.indexOf(MANAGED_BLOCK_END, end + MANAGED_BLOCK_END.length) < 0;
    if (start < 0 && end < 0) {
      result.skipped.push({ path: relPath, reason: "managed-block-absent" });
      continue;
    }
    if (!oneStart || !oneEnd || end < start) {
      result.errors.push({ path: relPath, reason: "malformed-managed-block" });
      continue;
    }
    result.planned.push(relPath);
    if (config.dryRun) continue;

    const next = existing.slice(0, start)
      + existing.slice(end + MANAGED_BLOCK_END.length);
    const tmpPath = `${absPath}.tl-tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
    try {
      ensureSafeWriteParent(repoRoot, absPath, false);
      assertSafeWriteTarget(config.repoRoot, absPath);
      const currentStat = lstatSync(absPath);
      if (
        currentStat.isSymbolicLink()
        || currentStat.dev !== beforeStat.dev
        || currentStat.ino !== beforeStat.ino
      ) {
        throw new Error("target-changed-during-removal");
      }
      writeFileSync(tmpPath, next, { encoding: "utf8", flag: "wx", mode: 0o600 });
      assertSafeWriteTarget(repoRoot, absPath);
      const finalStat = lstatSync(absPath);
      if (finalStat.dev !== beforeStat.dev || finalStat.ino !== beforeStat.ino) {
        throw new Error("target-changed-before-publication");
      }
      renameSync(tmpPath, absPath);
      result.removed.push(relPath);
    } catch (error: unknown) {
      try { unlinkSync(tmpPath); } catch { /* best-effort owned temporary cleanup */ }
      result.errors.push({ path: relPath, reason: `write-refused: ${String(error)}` });
    }
  }
  return result;
}

interface ProcessFileOptions {
  repoRoot: string;
  relPath: string;
  canonical: string;
  version: string;
  sha: string;
  driftMode: DriftMode;
  result: GenerateResult;
  clock: Clock;
}

async function processFile(opts: ProcessFileOptions): Promise<void> {
  const { repoRoot, relPath, canonical, version, sha, driftMode, result, clock } = opts;
  const absPath = join(repoRoot, relPath);

  // §9.3 + §9.10: symlink check
  try {
    assertSafeWriteTarget(repoRoot, absPath);
    const stat = lstatSync(absPath);
    if (stat.isSymbolicLink()) {
      result.skipped.push({
        path: relPath,
        reason: `symlink-refused: ${relPath} is a symlink; delete it and re-run`,
      });
      return;
    }
  } catch (error: unknown) {
    if (existsSync(absPath)) {
      result.skipped.push({
        path: relPath,
        reason: `symlink-refused: ${String(error)}`,
      });
      return;
    }
    try {
      ensureSafeWriteParent(repoRoot, absPath, false);
    } catch (parentError: unknown) {
      result.skipped.push({
        path: relPath,
        reason: `symlink-refused: ${String(parentError)}`,
      });
      return;
    }
  }

  // §9.9: case-collision detection on the parent directory
  const parentDir = dirname(absPath);
  const fileName = basename(absPath);
  if (existsSync(parentDir)) {
    try {
      const siblings = readdirSync(parentDir);
      const collisions = siblings.filter(
        (s) => s.toLowerCase() === fileName.toLowerCase() && s !== fileName
      );
      if (collisions.length > 0) {
        result.skipped.push({
          path: relPath,
          reason: `case-collision: directory contains [${[fileName, ...collisions].join(", ")}]; resolve manually`,
        });
        return;
      }
    } catch {
      // readdir failure — continue and let writeFile fail if needed
    }
  }

  // §9.6: file size guard
  if (existsSync(absPath)) {
    let size = 0;
    try {
      const stat = lstatSync(absPath);
      size = stat.size;
    } catch {
      // ignore
    }
    if (size > MAX_FILE_BYTES) {
      result.skipped.push({
        path: relPath,
        reason: `oversized: file exceeds 5MB; use tl-agents doctor`,
      });
      return;
    }
  }

  // Read existing content
  let existingRaw = "";
  const fileExists = existsSync(absPath);
  if (fileExists) {
    try {
      existingRaw = readFileSync(absPath, "utf8");
    } catch (err: unknown) {
      result.skipped.push({
        path: relPath,
        reason: `read-error: ${String(err)}`,
      });
      return;
    }
  }

  // A check is observational: missing generated files are drift, never writes.
  if (!fileExists && driftMode === "fail-build") {
    result.skipped.push({ path: relPath, reason: "missing-generated-file" });
    result.drifted.push({ path: relPath, expected: sha, actual: "(missing)" });
    return;
  }

  // Detect EOL and BOM for restoration
  const eol = detectEol(existingRaw) ?? "\n";
  const { hasBom } = stripBom(existingRaw);

  // Run idempotent rewrite
  const rwResult = rewrite(existingRaw, canonical, version, sha, driftMode);

  if (rwResult.action === "fail") {
    result.skipped.push({
      path: relPath,
      reason: rwResult.diagnostic ?? "sentinel-fail",
    });
    if (driftMode === "fail-build") {
      result.drifted.push({ path: relPath, expected: sha, actual: "(malformed)" });
    }
    return;
  }

  if (rwResult.action === "no-op") {
    if (rwResult.diagnostic) {
      // diff-warn: record drift
      const actual = sha256hex(existingRaw);
      result.drifted.push({ path: relPath, expected: sha, actual });
    } else {
      // Block is already up-to-date — record as skipped for idempotency tracking
      result.skipped.push({ path: relPath, reason: "already-up-to-date" });
    }
    return;
  }

  if (rwResult.action === "leave-manual") {
    result.skipped.push({ path: relPath, reason: "manual-guidance-detected" });
    return;
  }

  // Backup if replacing an existing block with sha mismatch (manual edit)
  if (rwResult.manualEditDetected && existingRaw) {
    writeBackup(repoRoot, relPath, existingRaw, clock);
  }

  // Restore EOL and BOM for write-back
  let finalText = restoreEol(rwResult.text, eol);
  if (hasBom && !finalText.startsWith("﻿")) {
    finalText = "﻿" + finalText;
  }

  // §9.8: atomic write via tmp file + rename
  const tmpPath = `${absPath}.tl-tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  try {
    ensureSafeWriteParent(repoRoot, absPath, true);
    assertSafeWriteTarget(repoRoot, absPath);
    writeFileSync(tmpPath, finalText, { encoding: "utf8", flag: "wx", mode: 0o600 });
    ensureSafeWriteParent(repoRoot, absPath, false);
    assertSafeWriteTarget(repoRoot, absPath);
    renameSync(tmpPath, absPath);
    result.wrote.push(relPath);
  } catch (err: unknown) {
    // Best-effort cleanup of tmp file
    try { unlinkSync(tmpPath); } catch { /* ignore */ }
    result.skipped.push({ path: relPath, reason: `write-error: ${String(err)}` });
  }
}

/**
 * Write a backup of the file to .tokenlighten/backups/<relPath>.<ts>.bak.
 */
function writeBackup(repoRoot: string, relPath: string, content: string, clock: Clock): void {
  const ts = clock.now();
  const safeName = relPath.replace(/[/\\]/g, "_");
  const backupPath = join(repoRoot, BACKUP_DIR, `${safeName}.${ts}.bak`);
  try {
    ensureSafeWriteParent(repoRoot, backupPath, true);
    assertSafeWriteTarget(repoRoot, backupPath);
    writeFileSync(backupPath, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
  } catch {
    // Best-effort — do not fail the whole operation if backup fails
  }
}

/**
 * Resolve the locale from config, env var, or default.
 */
function resolveLocale(configLocale?: Locale): Locale {
  if (configLocale) return configLocale;
  const env = process.env["TL_AGENTS_LOCALE"];
  if (env === "jp") return "jp";
  return "en";
}
