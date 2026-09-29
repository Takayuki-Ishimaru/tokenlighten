// ---------------------------------------------------------------------------
// protocol v1 — the `read.batch` shed ladder (P3a S3).
//
// NORMATIVE SOURCE: TL-PROTOCOL-V1-PHASE3A-PLAN-DRAFT.md §5.3, §5.7;
// DESIGN-v0.10-protocol-v1-contract-freeze.md A.5.4 (`BatchEntry`, the closed
// four-member union), A.6.2, A.8.1 E-7; erratum E1 (rung 6).
//
// LADDER: 1 (per-entry prose) -> 4 (narrow every RANGED entry's own window,
// swept together) -> 6 (drop whole entries, FLOOR ONE ENTRY, `next` = the
// batch re-read of the dropped paths/windows).
//
// §5.3 states rung 6 outright: "Rung 6 drops whole entries ->
// `limit{cause:"wire", omitted:["results"], next:<batch call for the dropped
// handles>}`". Rung 4 is an ADDITIVE fix (TL-05 defect (b), adopted
// 2026-09-21, plan-0143 §7.1/§10 C01): §5.3/§5.7 as drafted named only 1 and
// 6 for this kind, leaving no rung between "strip prose" and "drop a whole
// entry" — so a caller-declared budget smaller than one requested RANGED
// slice (the "handle" BatchEntry form the A7 `handles=[]` batch mints) had
// nothing left to shed once rung 1 was exhausted, and rung 6 declines below
// its own one-entry floor on a single-entry batch. See `truncateRangedEntries`'s
// own doc comment for the measured dead end this closes, and for why it
// sweeps every eligible entry in one step rather than picking the widest one.
//
// THE FLOOR IS ONE ENTRY, AND THAT IS A READING, NOT A TRANSCRIPTION. §4.3's
// required-set row says only "a per-entry rollup keyed by handle/path, with
// per-entry completeness" and does not state non-emptiness the way
// `read.artifact`'s per-source floor does (recon open question §12.5). A batch
// that shed every entry would be a rollup about nothing — the `entries: []`
// shape is reachable legitimately (a batch call that matched no source) and
// would be INDISTINGUISHABLE from it, which is the class E-1's absence rules
// exist to prevent. One entry is therefore the conservative floor; below it the
// ladder declines and the fail-closed refusal names the limit. Rung 4 is what
// now stands between rung 1 and that floor for a ranged entry, so the floor
// itself is unchanged and "never split" (§5.3 as drafted) remains the rule
// exactly where no caller budget forced anything smaller — see rung 4's own
// comment for the ONE population it now handles instead.
// ---------------------------------------------------------------------------

import { emittableToolCall } from "../../refusal.js";
import {
  arrayAt,
  dropTrailingEntry,
  isRecord,
  requestedRangeContentFull,
  str,
  carriesStripDisclosure,
  withKey,
  withoutKeys,
  type ShedContext,
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
      // SHOULD-FIX 63 (AC1, round 12): an ENTRY whose own `note` carries the
      // NUL-strip statement keeps it; its siblings still shed. See
      // `registry.ts::carriesStripDisclosure`.
      if (carriesStripDisclosure(entry[key])) return entry;
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
 * TL-05 defect (a), adopted 2026-09-21 (plan-0143 §7.1/§10 C01): a dropped
 * entry that carries its own `range` (the "handle"/"range" BatchEntry forms,
 * A.5.4) is a WINDOW of the file, not the whole thing. The old unconditional
 * `read_file mode=full paths:[…]` continuation widened it back to the whole
 * file and lost the window — measured live: a dropped `range:"49-100"` entry
 * came back as `{path:"data/beta.txt"}` with no range at all. A "handle"-form
 * entry now recovers by its own handle+range (mirrors `readText.ts`'s rung-4
 * continuation exactly); a handle-less "range"-form entry recovers by
 * path+range. Only a "file"/"file-downgraded" entry — genuinely the whole
 * file, no `range` at all — keeps today's exact `mode:"full" paths:[…]`
 * continuation, which is the same shape `readFamily.ts`'s `deriveNext` builds
 * from an `omitted[]` ledger: a source the response did not carry, named so
 * the caller can ask for it directly.
 *
 * FIXED (FIX-A3, TL-05 follow-up, item 2, 2026-09-21): a ranged recovery now
 * echoes the ORIGINAL call's `content:"full"` when it named one, via
 * `requestedRangeContentFull(context)` (`registry.ts`) — the marker
 * `server.ts`'s `normalizeCanonicalRequest` stamps on `args` under a Symbol
 * BOTH modules import, so it survives that same function's later
 * `delete args["content"]` without a circular import (`server.ts` already
 * depends on this module transitively through `emit.ts`/`ladder.ts`/
 * `shedders/index.ts`, so importing one constant the other way is a shortcut
 * along an existing edge, not a new cycle). Only the two WINDOWED forms need
 * it: a "file"/"file-downgraded" entry's `mode:"full" paths:[…]` recovery
 * already names the whole file with no range at all, which is today's
 * unchanged, out-of-scope shape (plan §7.1's own table: "no range +
 * content:"full" => whole file").
 *
 * FIXED (FIX-A4, line-loss follow-up, 2026-09-21): the dropped entry's
 * recovery `range` is now the entry's WHOLE unserved window
 * (`unservedRangeFor`, below), not its bare CURRENT `range`. `runLadder`
 * (`../ladder.ts`) re-invokes a rung repeatedly while the payload is still
 * over budget, so rung 4 (`truncateRangedEntries`) commonly runs SEVERAL
 * times on one emission before this rung ever sees the payload — each pass
 * halves the entry's `content`, rewrites `range` down to the surviving
 * leading sliver, and books the true cut-off remainder into the entry's own
 * `remaining_ranges`. When THIS rung then drops that same entry outright
 * (still over budget with rung 4 exhausted), the entry ships NOTHING in this
 * response — it is removed from `entries[]` entirely — so the narrowed
 * sliver rung 4 kept is lost too, not merely the recorded remainder. Measured
 * live before this fix: a 40-line two-entry batch at a tight budget narrowed
 * one entry to `range:"1-1"` / `remaining_ranges:["2-40"]` over six rung-4
 * passes, then dropped it at rung 6 with a recovery of
 * `{range:"1-1",handle:…}` — lines 2-40 were reachable by NOTHING the
 * response named. `unservedRangeFor` reconstructs the original contiguous
 * window from `range` UNIONED with `remaining_ranges` (safe regardless of
 * whether `remaining_ranges` came from this rung, from repeated rung-4 passes
 * on this same ladder run, or from `server.ts`'s own construction-time
 * truncation — `truncateRangedEntries`'s doc comment above is the invariant:
 * "each entry's own remainder is always one contiguous span", so min(start)
 * .. max(end) over `range` and every `remaining_ranges` entry recovers
 * exactly the original span with no gap and no over-reach when nothing was
 * ever narrowed).
 */
function shedBatchEntry(payload: ShedPayload, context: ShedContext): ShedOutcome | undefined {
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
  const droppedRange = isRecord(dropped) ? str(dropped["range"]) : undefined;
  // FIX-A4: recover the WHOLE unserved window, not just the entry's current
  // (possibly rung-4-narrowed) `range` — see this function's own doc comment.
  const range = droppedRange === undefined ? undefined : unservedRangeFor(dropped, droppedRange);
  const handle = isRecord(dropped) ? str(dropped["handle"]) : undefined;
  const keepFull = range !== undefined && requestedRangeContentFull(context);
  const continuation = emittableToolCall(
    range === undefined
      ? { tool: "read_file", arguments: { mode: "full", paths: [path] } }
      : handle !== undefined
        ? { tool: "read_file", arguments: { mode: "slice", handle, range, ...(keepFull ? { content: "full" } : {}) } }
        : { tool: "read_file", arguments: { path, range, ...(keepFull ? { content: "full" } : {}) } },
  );
  if (continuation === undefined) return undefined;

  return {
    next: withKey(payload, "entries", trimmed.next),
    note: { rung: 6, refs: [path] },
    continuation,
  };
}

/** `"12-48"` -> `[12, 48]`. Fail-closed: anything else is not addressing. Same
 *  parse `readText.ts`'s rung 4 uses; kept local rather than shared since
 *  each shedder module is otherwise self-contained (registry.ts's own
 *  layout). */
function parseRange(value: unknown): [number, number] | undefined {
  if (typeof value !== "string") return undefined;
  const match = /^(\d+)-(\d+)$/u.exec(value.trim());
  if (match === null) return undefined;
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 1 || end < start) return undefined;
  return [start, end];
}

/**
 * FIX-A4 (line-loss follow-up, 2026-09-21) — `shedBatchEntry` (rung 6) is
 * about to drop `dropped` wholesale, so its recovery must name EVERYTHING of
 * it the caller has not received: `range` (the entry's current window,
 * possibly already narrowed to a leading sliver by one or more earlier rung-4
 * passes on this same ladder run) UNIONED with every span in its own
 * `remaining_ranges` (the sliver's own recorded cut-off remainder, when rung
 * 4 left one). Both are contiguous with each other by construction — see
 * `truncateRangedEntries`'s doc comment above ("each entry's own remainder is
 * always one contiguous span") — so min(start) .. max(end) reconstructs the
 * original requested window exactly, with no gap. An entry rung 4 never
 * touched carries no `remaining_ranges`, so the loop below is a no-op and
 * this returns `range` unchanged — byte-identical to before this fix for
 * that (today's common) case.
 */
function unservedRangeFor(dropped: unknown, range: string): string {
  const bounds = parseRange(range);
  if (bounds === undefined || !isRecord(dropped)) return range;
  let [start, end] = bounds;
  const remainingRanges = Array.isArray(dropped["remaining_ranges"]) ? dropped["remaining_ranges"] : [];
  for (const span of remainingRanges) {
    const parsed = parseRange(span);
    if (parsed === undefined) continue;
    if (parsed[0] < start) start = parsed[0];
    if (parsed[1] > end) end = parsed[1];
  }
  return start === bounds[0] && end === bounds[1] ? range : `${start}-${end}`;
}

/**
 * Cut EVERY ranged entry's `content` in half on a line boundary, narrowing
 * each one's `range` to its surviving prefix and moving its own cut window
 * into its own `remaining_ranges` — TL-05 defect (b), adopted 2026-09-21
 * (plan-0143 §7.1/§10 C01).
 *
 * THE DEAD END THIS CLOSES. Before this rung, the ladder's floor for this
 * kind was rung 6 (drop a WHOLE entry, floor ONE). A caller-declared budget
 * smaller than one requested slice — reachable on any handle/ranged batch,
 * e.g. the A7 `handles=[]` batch's own per-item ranged serve — left rung 1
 * (prose) unable to close the gap and rung 6 unable to shed below its own
 * one-entry floor on a single-entry batch: the ladder was exhausted with
 * nothing left to try, so `emit.ts`'s fail-closed tail converted the response
 * to a bare `refusal{cap-exceeded}` with NO continuation to attach — a dead
 * end, not a narrower retry.
 *
 * SWEEPS EVERY ELIGIBLE ENTRY IN ONE STEP — this is NOT
 * `readText.ts`'s rung-4 `truncateLargestBody` picking the single widest
 * `evidence[]` entry, and that is deliberate, not an oversight. Measured
 * regression while building this fix: a 30-entry ranged batch, one entry at a
 * time, needed roughly ten halvings PER entry to converge — ~300 total
 * ladder steps — against `ladder.ts`'s own `MAX_SHED_STEPS=64` termination
 * bound ("the incremental ones cut one array entry per step", a bound this
 * kind's rung 1 already respects via `shedEntryProse`'s per-field sweep
 * above). The ladder hit that bound mid-shed, partially truncated, still over
 * budget, and NEVER reached rung 6 — turning a batch that used to shed
 * cleanly via a few whole-entry drops into a bare `cap-exceeded` refusal.
 * Cutting every eligible entry together, like `shedEntryProse` already does
 * for prose, converges in O(log(largest entry)) total steps regardless of
 * entry count — unconditionally SAFE (the runner still checks the budget
 * before every step and stops at the first fit, so sweeping every entry when
 * only one needed it costs at most one extra pass, never a correctness
 * issue) and the fix this bound requires.
 *
 * Otherwise mirrors `readText.ts`'s rung-4 contract exactly per entry (same
 * halving, same "narrow `range`, name the cut in `remaining_ranges`", same R2
 * accumulation rule so a follower that runs the `next` verbatim and stops
 * never silently loses an earlier pass's cut) — generalized from ONE
 * `evidence[]` body to EVERY entry of a batch `entries[]` array.
 *
 * EACH CUT ENTRY CARRIES ITS OWN `next` (the "handle" BatchEntry form's own
 * per-entry field, A.5.4), NOT ONLY the step's combined multi-target
 * `continuation`. THE REASON, MEASURED while building this fix:
 * `wireLimit.ts`'s E3 merge (clause 4) keeps the EMITTER's own `next` over a
 * boundary step's continuation whenever the emitter's `limit` already names
 * one — which a `read.batch` response legitimately does whenever an EARLIER
 * entry was deferred to the caller's ceiling at construction time
 * (server.ts's own `deferredForNext`). A caller-declared budget of 6500 B
 * against `{alpha:80 lines, beta:70 lines}` (plan-0143 C01) forced alpha's
 * OWN construction-time defer, ships beta whole to guarantee progress, and
 * THIS rung then truncates beta to fit — but clause 4 keeps alpha's
 * construction-time `next` as the response's `limit.next`, discarding this
 * rung's own beta continuation entirely. Without a per-entry `next`, beta's
 * truncated remainder became UNREACHABLE: not named by `limit.next` (alpha
 * is) and not named anywhere else. The per-entry `next` is what the "handle"
 * form exists to carry for exactly this case, mirrors what
 * `resolveRangedPathsBatchEntry`'s CONSTRUCTION-TIME truncation (server.ts)
 * already does when `resolveSlice`'s own byte cap fires, and is checked by
 * `extractNext`-style continuation discovery that inspects `entries[].next`
 * (this repo's own `qualityFirstScenarios.ts` helper does exactly this as a
 * fallback source). The step's own combined multi-target `continuation` is
 * kept too, for the common case where no earlier entry competes for
 * `limit.next` (clause 3: the boundary's own continuation becomes it
 * directly) — a per-target `range`, never `ranges`, since each entry's own
 * remainder is always one contiguous span by construction, and a
 * multi-HANDLE batch whose target carries `ranges` (plural) is refused
 * elsewhere in this server (server.ts's A7 handles=[] batch pre-pass).
 *
 * SCOPED TO THE "handle" BatchEntry form ONLY (requires both `handle` and a
 * parsable `range`) — the one form A.5.4 keeps `remaining_ranges`/`next` on
 * (a handle-less "range"-form pack candidate does not carry them, and a
 * "file"/"file-downgraded" entry has no `range` to narrow at all). Those
 * forms are unaffected by this rung and still fall through to rung 6, which
 * keeps "never split" as the rule exactly where no caller budget forced
 * anything smaller.
 *
 * FIX-A3 (TL-05 follow-up, item 2, 2026-09-21): both the per-entry `next`
 * (the "handle" form's own field, read by `rung 6`'s discovery precedent and
 * by a follower zooming ONE entry directly) and the step's combined
 * multi-target `continuation` now echo the ORIGINAL call's `content:"full"`
 * via `requestedRangeContentFull(context)` — see `shedBatchEntry`'s doc
 * comment above for why the marker needs no circular import. Computed ONCE:
 * every entry this rung touches is, by construction, the "handle" BatchEntry
 * form with a real `range` (the `handle === undefined || bounds === undefined`
 * guard below skips anything else), so "range + content:full => unelided"
 * applies uniformly across the whole sweep, not per-entry.
 */
function truncateRangedEntries(payload: ShedPayload, context: ShedContext): ShedOutcome | undefined {
  const entries = arrayAt(payload, "entries");
  if (entries === undefined) return undefined;
  const keepFull = requestedRangeContentFull(context);

  const nextEntries = [...entries];
  const refs: string[] = [];
  const targets: Array<Record<string, unknown>> = [];

  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    if (!isRecord(entry)) continue;
    const handle = str(entry["handle"]);
    const bounds = parseRange(entry["range"]);
    // E5: no parsable addressing means no executable continuation for THIS
    // entry, so it is left untouched — a sibling entry can still shed.
    if (handle === undefined || bounds === undefined) continue;
    const rawContent = entry["content"];
    if (typeof rawContent !== "string" || rawContent === "") continue;
    // TL-A6-3 (v0.14.4 candidate, item 3): strip the file's OWN trailing
    // newline before splitting. A served window that reaches EOF keeps the
    // file's trailing "\n" (readCodeModes.ts's sliceLinesToText, T1b), and
    // `content.split("\n")` on that text counts one phantom empty final
    // segment — util/countLines.ts's own bug write-up: "a 50-line file...
    // splits into 51 elements, the 51st being ''". Left uncorrected, that
    // phantom segment inflated `keep`/`unkeptEnd` below by one, naming a
    // recovery range that reached line N+1 of an N-line file. Mirrors
    // countLines.ts's own algorithm (strip exactly one trailing newline, then
    // split) inline rather than importing it, matching this module's
    // existing self-contained convention (see `parseRange`'s own comment).
    const content = rawContent.endsWith("\n") ? rawContent.slice(0, -1) : rawContent;
    const lines = content.split("\n");
    if (lines.length < 2) continue;
    const keep = Math.ceil(lines.length / 2);
    if (keep >= lines.length) continue;

    const [start] = bounds;
    const keptRange = `${start}-${start + keep - 1}`;
    const cutStart = start + keep;
    const priorRemaining = Array.isArray(entry["remaining_ranges"])
      ? (entry["remaining_ranges"] as unknown[]).filter((value): value is string => typeof value === "string")
      : [];
    let unkeptEnd = start + lines.length - 1;
    for (const span of priorRemaining) {
      const parsed = parseRange(span);
      if (parsed !== undefined && parsed[1] > unkeptEnd) unkeptEnd = parsed[1];
    }
    const unkeptRange = `${cutStart}-${unkeptEnd}`;
    const entryContinuation = emittableToolCall({
      tool: "read_file",
      arguments: { mode: "slice", handle, range: unkeptRange, ...(keepFull ? { content: "full" } : {}) },
    });
    // E5: no constructible per-entry continuation means no shed of THIS
    // entry — a sibling entry can still shed.
    if (entryContinuation === undefined) continue;

    nextEntries[i] = {
      ...entry,
      range: keptRange,
      content: lines.slice(0, keep).join("\n"),
      truncated: true,
      remaining_ranges: priorRemaining.length === 1 && priorRemaining[0] === unkeptRange
        ? priorRemaining
        : [unkeptRange],
      next: entryContinuation,
    };
    refs.push(handle);
    targets.push({ handle, range: unkeptRange });
  }
  if (targets.length === 0) return undefined;

  const continuation = emittableToolCall({
    tool: "read_file",
    arguments: { targets, ...(keepFull ? { content: "full" } : {}) },
  });
  if (continuation === undefined) return undefined;

  return {
    next: withKey(payload, "entries", nextEntries),
    note: { rung: 4, refs },
    continuation,
  };
}

export const READ_BATCH_SHEDDER: Shedder = {
  kind: "read.batch",
  rungs: [
    { rung: 1, step: shedEntryProse },
    { rung: 4, step: truncateRangedEntries },
    { rung: 6, step: shedBatchEntry },
  ],
  refusalConvertible: true,
};
