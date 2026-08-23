// Plain data only — no meta envelope, no 'tokenlighten:meta' wrappers.
// Reason: docs/00-postmortem.md §2.2

/**
 * publishJournal.ts — crash-safety for the manifest→graph two-file publish
 * transaction (V11-09, Incremental Index / Graph Update v2).
 *
 * CURRENT-STATE FINDING THIS MODULE ADDRESSES. Before V11-09, indexStore.ts
 * had NO journal of any kind — the only durability primitive was per-file
 * write-tmp-then-rename (now atomicJson.ts) for `source-index.v1.json` and
 * `tl-graph.json` independently. That already guarantees each file on its
 * own is never torn (a reader always sees the complete old or complete new
 * bytes). What it does NOT guarantee is the PAIR: a crash between
 * `writeManifest` succeeding (manifest now generation N) and
 * `writeGraphIfStale` succeeding (graph catches up to generation N) leaves
 * a fully-valid-but-STALE tl-graph.json (generation N-1) on disk next to a
 * fully-valid manifest at generation N, with nothing recording that fact.
 * The very next `loadOrBuildSourceIndex(..., {noCache:false})` call
 * self-heals this today (writeGraphIfStale's own rootHash comparison
 * rebuilds a stale graph unconditionally) — but a caller that reads
 * tl-graph.json directly without going through loadOrBuildSourceIndex first
 * (mcp-server's graph/index.ts loadGraphIndex(), which opens
 * .tokenlighten/index/tl-graph.json straight off disk with no manifest
 * cross-check at all — see graph/index.ts) has no way to detect the skew.
 *
 * DESIGN, AND WHY IT DEVIATES FROM stateStore.ts'S LITERAL SHAPE. The
 * repo's proven durability pattern (state/stateStore.ts) is an
 * append-journal + atomic-rename FILE store: meta.json epoch,
 * journal.ndjson of many small operations, snapshot.json compaction,
 * `.corrupt-<ts>` preservation, fail-closed-to-empty on any unreadable
 * record. That shape fits event-sourced state accumulating many small
 * `put()` calls over a session. The index/graph pair is NOT event-sourced —
 * `source-index.v1.json` and `tl-graph.json` are each always a FULL
 * snapshot rebuilt (or incrementally reused) and republished wholesale;
 * there is no sequence of small operations to replay. An unbounded NDJSON
 * append-log would be the wrong shape for a value that is only ever "is a
 * two-file publish transaction currently in flight, and for which
 * generation." So this journal keeps the PROVEN pieces of the pattern —
 * atomic-rename publication, fail-closed-to-"assume incomplete" on
 * corruption, `.corrupt-<ts>` preservation for forensics, a monotonic
 * generation identity — but represents them as a single small JSON record,
 * not an append log, and is that DEVIATION IS THE DESIGN in the same sense
 * stateStore.ts's own header comment claims for its choice of file store
 * over SQLite.
 *
 * STEADY-STATE COST. The journal file exists ONLY for the brief window
 * between a manifest write landing and its paired graph write confirming —
 * `loadOrBuildSourceIndex` writes it right after `writeManifest` commits
 * and clears it right after `writeGraphIfStale` confirms, in the SAME call,
 * whenever content actually changed. An unchanged workspace (the common
 * case) never writes a manifest this call and so never touches the
 * journal at all. The one unavoidable steady-state cost is a single
 * best-effort read attempt at the top of the graph-publish step, to notice
 * a journal left behind by a PRIOR call that crashed before clearing it —
 * on the (overwhelmingly common) no-crash history this is one ENOENT stat,
 * the same order of cost as the graph staleness probe's own head-read.
 *
 * FAIL-CLOSED. Any read that cannot prove the journal is absent-and-clean
 * (missing file → absent, the good case) is treated as "a publish may be
 * incomplete" — corrupt JSON, wrong version, wrong shape, or a read error
 * all force the conservative graph rebuild, mirroring loadManifest's own
 * "corrupt on-disk manifest triggers a full rebuild instead of a crash or
 * stale/empty result" discipline one level up. The offending file is
 * preserved as a `.corrupt-<ts>` sidecar (never deleted) so a real
 * corruption incident leaves forensic evidence, exactly as stateStore.ts's
 * corruption path does.
 */

import { promises as fs } from "node:fs";
import { join } from "node:path";
import { writeJsonAtomic, type AtomicJsonWriteHooks } from "./atomicJson.js";

export const PUBLISH_JOURNAL_PATH = ".tokenlighten/index/publish-journal.v1.json";

export function getPublishJournalPath(root: string): string {
  return join(root, ".tokenlighten", "index", "publish-journal.v1.json");
}

export interface PublishJournalRecordV1 {
  v: 1;
  generation: number;
  rootHash: string;
  atMs: number;
}

/**
 * true = "a publish transaction may be incomplete; force the conservative
 * path" (either a well-formed pending record was found, or the file exists
 * but could not be trusted). false = no journal present — nothing pending.
 */
export interface PublishJournalStatus {
  pending: boolean;
  record: PublishJournalRecordV1 | null;
}

function isPublishJournalRecordV1(data: unknown): data is PublishJournalRecordV1 {
  if (data === null || typeof data !== "object") return false;
  const obj = data as Record<string, unknown>;
  return (
    obj["v"] === 1 &&
    typeof obj["generation"] === "number" &&
    typeof obj["rootHash"] === "string" &&
    typeof obj["atMs"] === "number"
  );
}

/**
 * Read the current publish journal. Fail-closed: any error reading or
 * parsing an EXISTING file reports `pending: true` with `record: null`
 * (generation/rootHash unknown — the caller must force a rebuild rather
 * than try to match a specific generation) and preserves the offending
 * file as a `.corrupt-<ts>` sidecar. A genuinely absent file is the clean,
 * common case: `pending: false`.
 */
export async function readPublishJournal(root: string): Promise<PublishJournalStatus> {
  const journalPath = getPublishJournalPath(root);
  let raw: string;
  try {
    raw = await fs.readFile(journalPath, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { pending: false, record: null };
    // Some other read error (permissions, not-a-file, ...) — cannot prove
    // absence, so treat as pending/unknown rather than silently ignoring it.
    return { pending: true, record: null };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    await quarantineCorruptJournal(journalPath, raw);
    return { pending: true, record: null };
  }

  if (!isPublishJournalRecordV1(parsed)) {
    await quarantineCorruptJournal(journalPath, raw);
    return { pending: true, record: null };
  }

  return { pending: true, record: parsed };
}

async function quarantineCorruptJournal(journalPath: string, raw: string): Promise<void> {
  // Best-effort forensic preservation, mirroring stateStore.ts's
  // `.corrupt-<ts>` discipline. Never blocks or throws into the caller —
  // the fail-closed "pending:true" verdict already stands regardless of
  // whether this succeeds.
  try {
    const sidecar = `${journalPath}.corrupt-${Date.now()}`;
    await fs.writeFile(sidecar, raw, { encoding: "utf8", mode: 0o600, flag: "wx" });
  } catch {
    // best-effort
  }
}

/**
 * Publish a new "generation G's manifest is durable, graph not yet
 * confirmed" record. Called right after a manifest write commits, only
 * when content actually changed — never on an unchanged-workspace reload.
 */
export async function writePendingPublishJournal(
  root: string,
  generation: number,
  rootHash: string,
  hooks?: AtomicJsonWriteHooks,
): Promise<void> {
  const journalPath = getPublishJournalPath(root);
  const record: PublishJournalRecordV1 = { v: 1, generation, rootHash, atMs: Date.now() };
  const serialized = JSON.stringify(record);
  await writeJsonAtomic(
    root,
    journalPath,
    serialized,
    (dir) => join(dir, `publish-journal.v1.${process.pid}.${Date.now()}.tmp`),
    hooks,
  );
}

/**
 * Clear the journal once the graph has confirmed it is at (or past) the
 * given generation. Best-effort: a failure here just means the NEXT call's
 * `readPublishJournal` sees a (harmless, already-resolved) pending record
 * and does one extra defensive rebuild — never a correctness problem,
 * only a missed steady-state optimization.
 */
export async function clearPublishJournal(root: string): Promise<void> {
  const journalPath = getPublishJournalPath(root);
  try {
    await fs.unlink(journalPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw err;
  }
}
