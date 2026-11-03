// servedStateAndEdits — extracted implementation; imports point to the owning modules.
import type { TaskPackResult } from "../model.js";
import { UNREADABLE_NAMED_PATH_PREFIX } from "./queryIntent4.js";
import { unreadableNamedPathRows } from "./queryIntent4.js";

/**
 * SHOULD-FIX 32 (2026-09-14, review round 4/5): the exact inverse of the
 * `missing[]` row template `discloseUnreadableNamedPaths` builds below
 * (`${UNREADABLE_NAMED_PATH_PREFIX}<path> (named by this request; not
 * served: <reason>)`) — kept beside its builder, one formula, so they can
 * never drift silently out of sync (`readCodeTaskPack.spec.ts` also pins a
 * literal build-then-parse round trip).
 *
 * Exists because `result.missing` is a plain, persisted string array
 * (`ServedPackRecord.missing`) that survives a `qref`/`task.handle` re-pack
 * that carries an earlier pack's `missing[]` forward, while
 * `result.unreadable_named_paths` — the FIRST-CLASS field `buildCapabilityGaps`
 * and `decisionWire.ts`'s `projectUnresolved` both key their own disclosure
 * off — is populated only from `unreadableNamedPathRows()`, an ALS scoped to
 * the ONE `buildTaskPack` call that actually re-ran
 * `augmentQueryNamedFileSurfaces`. A re-pack that instead reuses carried-
 * forward surfaces never re-populates that ALS, so without this the `missing`
 * row alone survived while the gap and the `unresolved[]` row it drives both
 * silently vanished.
 *
 * Exported (alongside `UNREADABLE_NAMED_PATH_PREFIX`) only so
 * `readCodeTaskPack.spec.ts` can pin the literal build-then-parse round trip
 * directly — the same "exported for one pin" precedent `FileReadCache` above
 * documents for the FX-OH F1 case.
 */
export function parseUnreadableNamedPathRow(
  row: string,
): { path: string; reason: "unreadable" | "undecodable"; provenance: "request" | "resolution" } | undefined {
  if (!row.startsWith(UNREADABLE_NAMED_PATH_PREFIX)) return undefined;
  const rest = row.slice(UNREADABLE_NAMED_PATH_PREFIX.length);
  // SHOULD-FIX 65 (AC1, 2026-09-14, review round 12): the row now spells its own
  // PROVENANCE, and both spellings round-trip — the pre-round-12 wording ("named
  // by this request") is exactly the `"request"` case, so a `missing[]` row
  // carried forward from an earlier pack parses back to the same meaning it had.
  const match = /^(.+) \((named by this request|reached while resolving this request); not served: (unreadable|undecodable)\)$/
    .exec(rest);
  if (match === null) return undefined;
  return {
    path: match[1]!,
    reason: match[3] as "unreadable" | "undecodable",
    provenance: match[2] === "named by this request" ? "request" : "resolution",
  };
}

/**
 * SHOULD-FIX 65 (AC1, 2026-09-14, review round 12): the ONE `missing[]` spelling,
 * so the producer and `parseUnreadableNamedPathRow` above cannot drift.
 */
export function unreadableNamedPathMissingRow(row: {
  path: string;
  reason: "unreadable" | "undecodable";
  provenance?: "request" | "resolution";
}): string {
  const provenance = (row.provenance ?? "request") === "request"
    ? "named by this request"
    : "reached while resolving this request";
  return `${UNREADABLE_NAMED_PATH_PREFIX}${row.path} (${provenance}; not served: ${row.reason})`;
}

/**
 * BLOCKER 25 (2026-09-14, review round 4): PUBLISH what this call could not
 * read, on the pack that is actually shipping.
 *
 * A file the REQUEST NAMED BY PATH is a stated requirement (TL142-05 stamps
 * such a surface `required: true`). When it resolves but cannot be served,
 * three things must be true of the response and none of them was:
 *
 *  1. the path is DISCLOSED. `unreadable_named_paths` is the field the two wire
 *     projectors read — `buildCapabilityGaps` (a blocking `missing-evidence`
 *     gap whose `refs` name the path, which is how a `discover` says it) and
 *     `decisionWire.ts`'s `projectUnresolved` (an `await_input` row naming the
 *     path AND the cause). Plus a `missing` row in the epoch vocabulary, which
 *     is what `openEpochContractRequirements` reads: the served-terminal grant
 *     (P2-4) must not mint a certificate beside this disclosure either.
 *  2. `coverage` does not claim `complete`. The reported undecodable variant
 *     shipped `task.coverage:"complete"` while hiding a file the query named.
 *     `missing-roles` is the existing telemetry value for "a required surface
 *     is absent"; `??=` so a more specific reason already set is never
 *     overwritten.
 *  3. the terminal is refused (`canonicalDecision.ts`).
 *
 * Called from `dedupeTrimAndPersist`, the choke point EVERY builder funnels
 * through, and BEFORE the first `buildTaskExecutionContract` in it — so the
 * contract, its gaps and the canonical decision are all computed over the
 * disclosure rather than beside it. Idempotent: the rows are set, not appended,
 * and the `missing` row is de-duplicated, because this runs once per builder
 * and a pack can pass through more than one.
 *
 * SHOULD-FIX 32 (2026-09-14, review round 4/5): when THIS call's own ALS is
 * empty — a re-pack that carried surfaces forward instead of re-running
 * `augmentQueryNamedFileSurfaces` — re-derive `unreadable_named_paths` from
 * any `unreadable-named-path:` row `result.missing` already carries forward
 * (see `parseUnreadableNamedPathRow` above), so the gap/`unresolved[]` stay in
 * step with the `missing[]` row that already survives the re-pack, instead of
 * one persisting and the other silently vanishing.
 */
/**
 * SHOULD-FIX 65 (AC1, 2026-09-14, review round 12): does the REQUEST TEXT name
 * this path?
 *
 * The ALS provenance alone is not enough, and the reason is measured: the
 * query-named augmentation SKIPS a path the locator already surfaced
 * (`already.has(rel)`), so for the round-11 repro the only site that ran for the
 * file the query DOES name was `candidateToSurface` — i.e. the `"resolution"`
 * one. Provenance is a property of the request, so it is answered from the
 * request: verbatim mention of the workspace-relative path, or of its basename
 * (the two spellings `queryNamedWorkspaceFiles` itself resolves). The ALS hint
 * still wins for a caller-supplied `targets[]` entry, which IS named by the
 * request even when the prose never spells it.
 */
export function requestTextNamesPath(query: string, relPath: string): boolean {
  if (query === "") return false;
  const haystack = query.toLowerCase();
  if (haystack.includes(relPath.toLowerCase())) return true;
  const base = relPath.slice(relPath.lastIndexOf("/") + 1).toLowerCase();
  if (base === "" || !base.includes(".")) return false;
  // Word-bounded on the left so `notes.txt` does not match `my-notes.txt`.
  const index = haystack.indexOf(base);
  if (index < 0) return false;
  const before = index === 0 ? "" : haystack[index - 1]!;
  return !/[A-Za-z0-9_.-]/.test(before);
}

export function discloseUnreadableNamedPaths(result: TaskPackResult, query: string = ""): void {
  const rows = unreadableNamedPathRows().map((row) => (
    row.provenance === "request" || requestTextNamesPath(query, row.path)
      ? { ...row, provenance: "request" as const }
      : { ...row, provenance: "resolution" as const }
  ));
  if (rows.length > 0) {
    result.unreadable_named_paths = rows;
    const disclosures = rows.map(unreadableNamedPathMissingRow);
    result.missing = [...new Set([...result.missing, ...disclosures])];
    if (result.coverage === "complete") result.coverage = "partial";
    result.coverage_reason ??= "missing-roles";
    return;
  }
  if (result.unreadable_named_paths !== undefined && result.unreadable_named_paths.length > 0) return;
  const restored = result.missing
    .map(parseUnreadableNamedPathRow)
    .filter((entry): entry is NonNullable<ReturnType<typeof parseUnreadableNamedPathRow>> => entry !== undefined);
  if (restored.length === 0) return;
  result.unreadable_named_paths = restored;
  if (result.coverage === "complete") result.coverage = "partial";
  result.coverage_reason ??= "missing-roles";
}

// ---------------------------------------------------------------------------
// P2 fix (2026-09-19) — DESIGN-v0.15-exploration-continuation-reliability.md
// §3.2 ("本文をさらに削った場合も、被覆を再計算する") / §5.1 (D=Q-(C∪S)) /
// §5.3 ("単独の小範囲nextで残りtargetsを失わせない").
//
// ROOT CAUSE, PINNED (2026-09-19, live-repo repro against the real
// DESIGN-*.md docs, call shape verbatim from the orchestrator's report):
// trimToCap's Phase E "legacy halving" loop (>=2 caller-supplied ranged
// bodies) can shrink a surface's `code` a SECOND time, after an earlier,
// more generous construction pass already set `remaining_ranges` for a
// FIRST cut. Phase E's own bookkeeping only ever unions in the surface's
// WHOLE `range` (`[...new Set([...(remaining ?? []), surf.range])]`) — it
// never learns the specific window its OWN halving just cut away. Measured:
// a 274-line file served through line ~51 with
// `remaining_ranges:["104-274","1-274"]` — "104-274" is the pre-halving
// remainder, "1-274" is Phase E's whole-range fallback; lines 52-103 were
// neither delivered nor named by either entry.
//
// `dedupeTrimAndPersist` is the single choke point every pack builder funnels
// through (see its own doc comment), so this reconciles ONCE, right after
// its `trimToCap` call — the LAST stage in this function that can shrink a
// surface's body — rather than patching every individual trimming pass
// (Phase E's loop, Phase F's whole-body strip, `shedSurface`'s whole-surface
// drop) that could independently go stale. Scoped to a `markCallerRangeSurface`
// mark (set from `why` containing "caller-supplied" AND no `.symbol`, before
// trimToCap can clear `why`) — so a query/search-located document's
// single-answer zoom, and a symbol-anchored surface (a DIFFERENT remaining/
// pointer contract; "anchor-focus: … caller-supplied" also contains the
// substring, which is why `.symbol === undefined` is required too — see
// `markCallerRangeSurface`'s own call site) are both untouched. UNCHANGED by
// the B1 fix (2026-09-21) — this reconciliation is disclosure-accuracy, not a
// withholding gate; see that call site's own "DELIBERATELY UNCHANGED" note.
//
// P3 CORRECTION (2026-09-19, orchestrator-caught regression): the P2 version
// above computed `firstUndelivered` from the RAW line count of `surf.code`,
// silently assuming one display line == one source line. A served body's
// comment-elision marker (`/* doc elided L<a>-<b> */` / `# doc elided L<a>-<b>`,
// util/formatCompress.ts) collapses MANY source lines into ONE display line,
// so a complete, whole-range body that happens to contain a marker was
// undercounted and stamped with a false `remaining` — a wasted hop on the
// single most common shape there is (a ranged read of commented code).
// Fixed by NEVER re-parsing the rendered text for marker-shaped strings
// (unsound: fxq2RangeGranularForeignHandle.spec.ts exists precisely because a
// file can contain a LITERAL string byte-identical to a genuine marker) and
// instead re-deriving the elision windows from the ACTUAL SOURCE via the
// same sanctioned renderer function every honest booking site uses,
// `elideDocCommentsWithWindows` (see `fxoServeCoordinateSettlement.spec.ts`'s
// "THE FIX" note and `spansExcludingWindows`'s doc comment, both
// util/formatCompress.ts) — never `servedSpansOfDisplayedText`, which is
// TEST-ONLY (fxnBookingSettlementFence.spec.ts pins that no new production
// caller reappears).
// ---------------------------------------------------------------------------

/** One marked surface's `code`/`remaining_ranges`/`content_completeness`, captured immediately before `trimToCap` runs. */
export interface CallerRangePreTrimSnapshot {
  readonly code: string | undefined;
  readonly remainingRanges: readonly string[] | undefined;
  readonly contentCompleteness: "partial" | undefined;
}
