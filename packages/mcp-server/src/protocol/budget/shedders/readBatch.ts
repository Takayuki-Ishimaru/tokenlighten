// ---------------------------------------------------------------------------
// protocol v1 — the `read.batch` shed ladder (P3a S3).
//
// NORMATIVE SOURCE: TL-PROTOCOL-V1-PHASE3A-PLAN-DRAFT.md §5.3, §5.7;
// DESIGN-v0.10-protocol-v1-contract-freeze.md A.5.4 (`BatchEntry`, the closed
// four-member union), A.6.2, A.8.1 E-7; erratum E1 (rung 6).
//
// LADDER: 1 (per-entry prose) -> 6 (drop whole entries, FLOOR ONE ENTRY,
// `next` = the batch re-read of the dropped paths).
//
// §5.3 states this rung outright: "Rung 6 drops whole entries ->
// `limit{cause:"wire", omitted:["results"], next:<batch call for the dropped
// handles>}`".
//
// THE FLOOR IS ONE ENTRY, AND THAT IS A READING, NOT A TRANSCRIPTION. §4.3's
// required-set row says only "a per-entry rollup keyed by handle/path, with
// per-entry completeness" and does not state non-emptiness the way
// `read.artifact`'s per-source floor does (recon open question §12.5). A batch
// that shed every entry would be a rollup about nothing — the `entries: []`
// shape is reachable legitimately (a batch call that matched no source) and
// would be INDISTINGUISHABLE from it, which is the class E-1's absence rules
// exist to prevent. One entry is therefore the conservative floor; below it the
// ladder declines and the fail-closed refusal names the limit.
// ---------------------------------------------------------------------------

import { emittableToolCall } from "../../refusal.js";
import {
  arrayAt,
  dropTrailingEntry,
  isRecord,
  str,
  withKey,
  withoutKeys,
  type ShedOutcome,
  type ShedPayload,
  type Shedder,
} from "./registry.js";

/**
 * Prose carried INSIDE a batch entry, cheapest-loss-first.
 *
 *   `note`     the `file-downgraded` form's commentary (E-7 canonical).
 *   `summary`  the same form's downgrade summary (E-7 canonical).
 *   `purpose`  the `range` form's per-window purpose (E-7 canonical).
 *
 * `reason`, `downgraded_from`, `allow_full_would_help`, `alternatives`,
 * `truncated` and `code_unchanged` are NOT prose: `reason` is the eight-literal
 * downgrade union (a machine value), `truncated` is Rule T's per-entry
 * completeness signal — the one A.5.4 requires — and `alternatives` is the
 * office redirect's list of calls that WOULD work.
 *
 * All entries are swept in one step: the prose is homogeneous across the array
 * and peeling it entry-by-entry would book N records for one class of loss.
 */
const BATCH_ENTRY_PROSE: readonly string[] = ["note", "summary", "purpose"];

function shedEntryProse(payload: ShedPayload): ShedOutcome | undefined {
  const entries = arrayAt(payload, "entries");
  if (entries === undefined) return undefined;

  for (const key of BATCH_ENTRY_PROSE) {
    let cut = 0;
    const next = entries.map((entry) => {
      if (!isRecord(entry)) return entry;
      const stripped = withoutKeys(entry, [key]);
      if (stripped === undefined) return entry;
      cut += 1;
      return stripped.next;
    });
    if (cut > 0) {
      return {
        next: withKey(payload, "entries", next),
        note: { rung: 1, refs: [`entries[].${key}`] },
      };
    }
  }
  return undefined;
}

/**
 * Drop one trailing entry, naming the batch re-read that returns it.
 *
 * The continuation is `read_file mode=full paths:[…]` — the same shape
 * `readFamily.ts`'s `deriveNext` builds from an `omitted[]` ledger, which is
 * what this rung's drop IS from the caller's side: a source the response did
 * not carry, named by path so the caller can ask for it directly.
 */
function shedBatchEntry(payload: ShedPayload): ShedOutcome | undefined {
  const entries = arrayAt(payload, "entries");
  if (entries === undefined) return undefined;
  const trimmed = dropTrailingEntry(entries, 1);
  if (trimmed === undefined) return undefined;

  const dropped = trimmed.dropped;
  const path = isRecord(dropped) ? str(dropped["path"]) : undefined;
  // E5: an entry with no path cannot be named in a recovery call, so it is not
  // shed. The `handle` form always carries `path` (possibly `""`, which `str`
  // rejects); the three others require it.
  if (path === undefined) return undefined;
  const continuation = emittableToolCall({
    tool: "read_file",
    arguments: { mode: "full", paths: [path] },
  });
  if (continuation === undefined) return undefined;

  return {
    next: withKey(payload, "entries", trimmed.next),
    note: { rung: 6, refs: [path] },
    continuation,
  };
}

export const READ_BATCH_SHEDDER: Shedder = {
  kind: "read.batch",
  rungs: [
    { rung: 1, step: shedEntryProse },
    { rung: 6, step: shedBatchEntry },
  ],
  refusalConvertible: true,
};
