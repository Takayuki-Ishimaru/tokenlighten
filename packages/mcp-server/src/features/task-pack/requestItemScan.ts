import * as fs from "node:fs";
import { createHash } from "node:crypto";
import { currentRequestSignal } from "../../util/requestCancellation.js";
import { createScanCoverage, scanLiteral, type ScanContentCache, type ScanCoverage, type TextMatch } from "../search/find/findText.js";

type Files = NonNullable<Parameters<typeof scanLiteral>[2]["files"]>;
interface Entry { matches: TextMatch[]; coverage: ScanCoverage; bytes: number }
interface Inventory { fingerprint: string; entries: Map<string, Entry>; coverage?: ScanCoverage }
interface Memo { inventories: Map<string, Inventory>; bytes: number }
const memos = new WeakMap<ScanContentCache, Memo>();
export const REQUEST_ITEM_SCAN_MEMO_BYTES = 4 * 1024 * 1024;

function fingerprint(files: Files): string | undefined {
  const hash = createHash("sha256");
  const signal = currentRequestSignal();
  for (const file of files) {
    signal?.throwIfAborted();
    try {
      const stat = fs.statSync(file.absPath, { bigint: true });
      hash.update(JSON.stringify([file.absPath, file.relPath, file.kind, String(stat.dev), String(stat.ino),
        String(stat.size), String(stat.mtimeNs), String(stat.ctimeNs), stat.isFile()]));
    } catch { return undefined; }
  }
  return hash.digest("hex");
}

function mergeCoverage(target: ScanCoverage, source: ScanCoverage): void {
  for (const key of ["scanned", "unscanned", "undecodable"] as const) {
    for (const file of source[key]) target[key].add(file);
  }
}

function sameCoverage(left: ScanCoverage, right: ScanCoverage): boolean {
  return (["scanned", "unscanned", "undecodable"] as const).every(key =>
    left[key].size === right[key].size && [...left[key]].every(file => right[key].has(file)));
}

/** Memoize identical readiness scans within one response's content cache.
 * Large inventories overflow the 64 MiB content cache; rebuilding readiness
 * otherwise reopens every overflow file for each identical literal. Keep only
 * bounded match/coverage records, with the exact inventory identity and options.
 * Revalidate file identities/timestamps on every hit; a changed or unreadable
 * inventory invalidates both memo and stale content before scanning again.
 */
export function scanRequestItemLiteral(query: string, workspace: string, opts: {
  files: Files; caseInsensitive?: boolean; coverage: ScanCoverage; contentCache?: ScanContentCache;
}): TextMatch[] {
  const cache = opts.contentCache;
  if (cache === undefined) return scanLiteral(query, workspace, opts);
  let memo = memos.get(cache);
  if (memo === undefined) { memo = { inventories: new Map(), bytes: 0 }; memos.set(cache, memo); }
  const stamp = fingerprint(opts.files);
  // A rebuilt array with the same paths/kinds/file identities is the SAME
  // inventory. Readiness rebuilds these arrays; object-reference keys would
  // miss every rebuild and require re-statting all previous arrays as well.
  let inventory = stamp === undefined ? undefined : memo.inventories.get(stamp);
  if (stamp === undefined) {
    memo.inventories.clear();
    memo.bytes = 0;
    cache.lines.clear();
    cache.bytes = 0;
    inventory = undefined;
  }
  // A prewalk or another scanner may have filled this cache before our first
  // file-identity observation. Those bytes have no fingerprint binding, so
  // they cannot seed a new proof. Start that inventory with fresh reads.
  if (inventory === undefined && cache.lines.size > 0) {
    cache.lines.clear();
    cache.bytes = 0;
  }
  const key = JSON.stringify([workspace, query, opts.caseInsensitive === true]);
  const hit = inventory?.entries.get(key);
  if (hit !== undefined) {
    mergeCoverage(opts.coverage, hit.coverage);
    return hit.matches.map(match => ({ ...match }));
  }
  const coverage = createScanCoverage();
  const matches = scanLiteral(query, workspace, { ...opts, coverage });
  mergeCoverage(opts.coverage, coverage);
  if (stamp === undefined || fingerprint(opts.files) !== stamp) {
    memo.inventories.clear();
    memo.bytes = 0;
    cache.lines.clear();
    cache.bytes = 0;
    return matches;
  }
  // Most literals scanned the identical files. Share that immutable coverage
  // record after equality checking instead of charging thousands of paths for
  // each needle and crowding useful results out of the fixed memory bound.
  const sharedCoverage = inventory?.coverage !== undefined && sameCoverage(inventory.coverage, coverage)
    ? inventory.coverage : undefined;
  const bytes = key.length * 2 + 128 + matches.reduce((total, match) => total + 64 + 2 * (match.path.length + (match.text?.length ?? 0)), 0)
    + (sharedCoverage === undefined
      ? [...coverage.scanned, ...coverage.unscanned, ...coverage.undecodable].reduce((total, file) => total + 48 + file.length * 2, 0) : 0);
  if (memo.bytes + bytes > REQUEST_ITEM_SCAN_MEMO_BYTES || (inventory === undefined && memo.inventories.size >= 16)) return matches;
  if (inventory === undefined) {
    inventory = { fingerprint: stamp, entries: new Map(), coverage };
    memo.inventories.set(stamp, inventory);
  }
  inventory.entries.set(key, { matches: matches.map(match => ({ ...match })), coverage: sharedCoverage ?? coverage, bytes });
  memo.bytes += bytes;
  return matches;
}
