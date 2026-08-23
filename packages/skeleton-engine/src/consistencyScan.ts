// Plain data only — no meta envelope, no 'tokenlighten:meta' wrappers.
// Reason: docs/00-postmortem.md §2.2

/**
 * consistencyScan.ts — bounded, explicitly-invocable self-heal for a
 * SourceIndexManifestV1 (V11-09, Incremental Index / Graph Update v2).
 *
 * WHAT IT DEFENDS AGAINST. Every ordinary cache-freshness check in this
 * package (the P1.4 content-hash fast-path gate, the manifestMemo whole-
 * match stat fingerprint) is triggered by something ASKING for the index —
 * a workspace nobody reads for a while just keeps whatever was last
 * written, trusted at face value the next time it IS read. That is
 * correct for every write that goes through TL's own invalidation seam
 * (invalidateCachedWorkspaceFiles), and self-heals immediately for any
 * stat-visible external change (enumerateFiles re-stats every file every
 * call). The residual this scan targets is narrower: content that changed
 * via a route that left size+mtime unchanged (the documented
 * same-stat-collision case — a coarse filesystem timestamp resolution, or
 * two writes landing in the same clock tick) AND was never routed through
 * invalidateCachedWorkspaceFiles at all (an external tool, not TL's own
 * write seams). That residual is explicitly accepted at the
 * loadOrBuildSourceIndex layer (AGENTS.md: "External same-stat writes
 * remain the accepted residual") — this scan does not change that
 * acceptance, it only bounds how long a workspace can go without ANYONE
 * asking before the drift is noticed and repaired. On by default since
 * 2026-08-21 (v0.11.x release prep, W2-C) — opt out with
 * TL_INDEX_CONSISTENCY_SCAN=0.
 *
 * BOUNDED, NEVER A BACKGROUND TIMER. `runConsistencyScan` is a plain async
 * function invoked synchronously as part of ONE loadOrBuildSourceIndex call
 * (when TL_INDEX_CONSISTENCY_SCAN is on) or directly by a future caller —
 * there is no setInterval/setTimeout anywhere in this module. Each
 * invocation scans at most `maxFiles` entries and stops early once
 * `maxDurationMs` has elapsed, so turning the flag on cannot turn one
 * ordinary call into an unbounded scan of a repo-scale manifest. A
 * manifest larger than one call's budget is covered PROBABILISTICALLY
 * across many calls (see `pickSample` below) rather than via a persisted
 * scan cursor — this repo already has one crash-safety-critical piece of
 * new persisted state this workstream (publishJournal.ts); a scan cursor
 * would be a second, for a feature that is explicitly a best-effort
 * hygiene pass, not a correctness-load-bearing one. That trade-off is the
 * design, not an oversight.
 *
 * REPAIR = DROP, NOT RE-EXTRACT. A stale entry is removed from the
 * manifest, not re-extracted in place — re-extraction would duplicate
 * loadOrBuildSourceIndex's own slow-path logic (chunking, symbol-kind
 * derivation, quarantine handling) a second time in this module. Dropping
 * is sufficient: the file simply falls out of the manifest's cache
 * entirely, so the very next loadOrBuildSourceIndex call sees no cached
 * entry for that path at all and re-extracts it through the ordinary slow
 * path — the same "drop and let the next full load re-add it" contract
 * indexStore.spec.ts already proves for an ordinary delete.
 */

import { join } from "node:path";
import type { SourceIndexManifestV1, IndexedFileV1 } from "./indexStore.js";
import { readRegularFileUtf8 } from "./readGuard.js";
import { hashContent, buildDirectoryDigests } from "./merkle.js";

export interface ConsistencyScanOptions {
  /** Maximum number of manifest entries examined in one call. */
  maxFiles?: number;
  /** Soft wall-clock budget for one call; checked between files. */
  maxDurationMs?: number;
}

export interface ConsistencyScanResult {
  /** Entries examined this call. */
  scanned: number;
  /** Entries whose content-sha still matched disk — no action needed. */
  ok: number;
  /** Entries dropped because the file is gone or its content-sha no longer matches. */
  dropped: number;
  /** True when the manifest has more entries than this call's budget covered. */
  truncated: boolean;
  durationMs: number;
  /** relPath of every dropped entry, for the caller's own disclosure/logging. */
  droppedPaths: string[];
}

const DEFAULT_MAX_FILES = 200;
const DEFAULT_MAX_DURATION_MS = 1500;

/**
 * Deterministic-enough sampling without a persisted cursor: a
 * splitmix32-style hash of (rootHash, path) turns "which entries does THIS
 * call examine" into something that varies call-to-call as rootHash
 * changes (an ordinary edit) while still being a pure function of its
 * inputs — no RNG, no module-level state, trivially testable. When the
 * manifest fits inside `maxFiles` this is moot; every entry is scanned.
 */
function sampleKey(rootHash: string, relPath: string): number {
  let h = 0x811c9dc5;
  const s = rootHash + "|" + relPath;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Entries this scan can meaningfully verify. "failed" entries (see
 * IndexedFileParseStatus) carry a sentinel empty contentSha256, not a real
 * one — there is nothing to verify against disk, and treating a
 * still-unreadable file as "stale" would DROP it, silently erasing the
 * exact "failed" disclosure loadOrBuildSourceIndex's file-read-error path
 * exists to preserve (see its own doc comment: a dropped entry is
 * indistinguishable from a deletion). A failed entry that becomes readable
 * again is picked up by the NEXT ordinary loadOrBuildSourceIndex call's
 * per-file loop, not by this scan.
 */
function scannableCandidates(manifest: SourceIndexManifestV1): string[] {
  return Object.keys(manifest.files).filter((p) => manifest.files[p]!.parseStatus !== "failed");
}

function pickSample(manifest: SourceIndexManifestV1, candidates: string[], maxFiles: number): string[] {
  if (candidates.length <= maxFiles) return candidates;
  return [...candidates]
    .sort((a, b) => sampleKey(manifest.rootHash, a) - sampleKey(manifest.rootHash, b))
    .slice(0, maxFiles);
}

/**
 * Read TL_INDEX_CONSISTENCY_SCAN directly (skeleton-engine cannot import
 * mcp-server's util/flags.ts — see AGENTS.md's package-boundary table: this
 * package must not import mcp-server). Mirrors flags.ts's own parseBool
 * convention (case-insensitive 1/true/yes/on vs 0/false/no/off/"";
 * unset/unrecognized => the default) so the two packages' env-var UX stays
 * consistent even though the reader implementations cannot be shared.
 * Registered for discoverability in mcp-server's util/flags.ts (C) doc
 * block, which documents this exact cross-package split.
 *
 * DEFAULT ON since 2026-08-21 (v0.11.x release prep, W2-C: reclassified
 * class (B) -> (C) — content-only self-heal, no wire-shape branch, same
 * class as TL_GRAPH_INDEX). Evidence: the manifestMemo whole-match
 * shortcut (indexStore.ts) demonstrably serves stale symbol data
 * indefinitely, within one long-lived server process, for a same-stat
 * (size+mtime) external write that skips invalidateCachedWorkspaceFiles —
 * reproduced end-to-end against the real server via search_files
 * action=symbols (the one production loadOrBuildSourceIndex call site);
 * see faultInjection.spec.ts and consistencyScan.spec.ts for the pinned
 * regression shape. Cost is bounded (maxFiles/maxDurationMs below) and
 * measured in the tens-to-low-hundreds of ms on a same-process warm
 * (memo-hit) call; a cross-process cold or per-file-loop warm call pays
 * effectively nothing extra, since the P1.4 content-hash gate already
 * re-verifies every file's bytes on those paths regardless of this flag.
 * Opt out with TL_INDEX_CONSISTENCY_SCAN=0|false|no|off|"" (the same
 * explicit-off spellings parseBool recognizes elsewhere); any other
 * recognized/unrecognized value, or leaving it unset, keeps the scan on.
 */
export function consistencyScanEnabledFromEnv(): boolean {
  const value = process.env["TL_INDEX_CONSISTENCY_SCAN"];
  if (value === undefined) return true;
  switch (value.toLowerCase()) {
    case "1":
    case "true":
    case "yes":
    case "on":
      return true;
    case "0":
    case "false":
    case "no":
    case "off":
    case "":
      return false;
    default:
      return true;
  }
}

/**
 * Bounded self-heal pass. Never mutates `manifest` — returns a NEW
 * manifest (only when something was actually dropped; otherwise the same
 * reference is returned so callers can cheaply skip a no-op re-persist)
 * plus a report of what happened. The caller (loadOrBuildSourceIndex, or
 * a future explicit invoker) owns persisting the result — this function
 * only touches the files it is verifying, never the manifest cache file
 * or tl-graph.json itself.
 */
export async function runConsistencyScan(
  root: string,
  manifest: SourceIndexManifestV1,
  opts?: ConsistencyScanOptions,
): Promise<{ manifest: SourceIndexManifestV1; result: ConsistencyScanResult }> {
  const maxFiles = opts?.maxFiles ?? DEFAULT_MAX_FILES;
  const maxDurationMs = opts?.maxDurationMs ?? DEFAULT_MAX_DURATION_MS;
  const startedAtMs = Date.now();

  const candidates = scannableCandidates(manifest);
  const sample = pickSample(manifest, candidates, maxFiles);

  let scanned = 0;
  let ok = 0;
  const droppedPaths: string[] = [];
  let truncated = sample.length < candidates.length;

  for (const relPath of sample) {
    if (Date.now() - startedAtMs > maxDurationMs) {
      truncated = true;
      break;
    }
    const entry = manifest.files[relPath];
    if (entry === undefined) continue; // defensive — cannot happen, sample is drawn from these keys
    scanned++;

    const stale = await isEntryStale(root, entry);
    if (stale) {
      droppedPaths.push(relPath);
    } else {
      ok++;
    }
  }

  const durationMs = Date.now() - startedAtMs;
  const result: ConsistencyScanResult = {
    scanned,
    ok,
    dropped: droppedPaths.length,
    truncated,
    durationMs,
    droppedPaths: [...droppedPaths].sort(),
  };

  if (droppedPaths.length === 0) {
    return { manifest, result };
  }

  const files: Record<string, IndexedFileV1> = { ...manifest.files };
  for (const relPath of droppedPaths) delete files[relPath];
  const { root: rootHash, directories } = buildDirectoryDigests(Object.values(files));

  const healed: SourceIndexManifestV1 = {
    ...manifest,
    files,
    directories,
    rootHash,
    // rootHash changed (entries were removed) — this is the same "bump on
    // content change" rule loadOrBuildSourceIndex applies everywhere else.
    generation: (manifest.generation ?? 0) + 1,
  };

  return { manifest: healed, result };
}

/** true = this entry's on-disk content no longer matches contentSha256 (or the file is gone). */
async function isEntryStale(root: string, entry: IndexedFileV1): Promise<boolean> {
  try {
    const raw = await readRegularFileUtf8(join(root, entry.path));
    const sha = hashContent(Buffer.from(raw));
    return sha !== entry.contentSha256;
  } catch {
    // Missing, unreadable, or no-longer-a-regular-file — cannot vouch for
    // this entry either way; drop it. The next full load re-adds it if it
    // is genuinely still there and readable (e.g. a transient permissions
    // blip), or leaves it correctly absent if it was actually deleted.
    return true;
  }
}
