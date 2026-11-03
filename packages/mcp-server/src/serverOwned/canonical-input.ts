// canonical-input — extracted implementation; imports point to the owning modules.
import type { LineWindow } from "@tokenlighten/types";
import { ARTIFACT_SELECT_KEYS } from "../protocol/toolSchemas.js";
import { RANGE_CONTENT_FULL_MARKER } from "../protocol/budget/shedders/registry.js";
import { beginServeCall } from "../state/session.js";
import { countLines } from "../util/countLines.js";
import { elideDocCommentsForDisplay } from "../util/formatCompress.js";
import { handleTable } from "../util/handles.js";
import { languageForPath } from "../util/languages.js";
import { parseWindows } from "../state/readRequestStore.js";
import { protocolCallContext } from "../protocol/envelope.js";
import { rangeStartLine } from "./edit-anchor.js";
import { recordReadPath } from "../state/session.js";
import { recordServedRange } from "../state/session.js";
import { resolveSlice } from "../tools/readCodeModes.js";
import { resolveSliceRanges } from "../tools/readCodeModes.js";
import { servedTextForRoute } from "./read-admission2.js";
import { shaOfText } from "../util/handles.js";
import { shortSha } from "../util/handles.js";
import { spansExcludingWindows } from "../util/formatCompress.js";
import { splitArchiveVirtualPath } from "../tools/archive.js";
import { stageReadRequestForServe } from "./canonical-input2.js";
import { wireLineCostBytes } from "../state/readRequestStore.js";

/**
 * Normalize harmless, observed wire spellings before the strict schema fence.
 * This is deliberately the one boundary for all consumers of task-pack
 * arguments: downstream code may rely on `paths` being an array.
 */
export function asCanonicalObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function mapCanonicalTask(value: unknown, args: Record<string, unknown>): void {
  const task = asCanonicalObject(value);
  if (task === undefined) return;
  const names: ReadonlyArray<[string, string]> = [
    ["handle", "task_handle"],
    ["epoch", "taskEpoch"],
    ["profile", "taskProfile"],
    ["expected_state_version", "expected_state_version"],
    ["challenge", "challenge"],
    ["force_serve", "force_serve"],
  ];
  for (const [from, to] of names) {
    if (task[from] !== undefined) args[to] = task[from];
  }
  // This is deliberately not a general operation discriminator.
  if (task["pull"] === "closure") args["mode"] = "closure";
}

export function mapCanonicalBudget(value: unknown, args: Record<string, unknown>): void {
  const budget = asCanonicalObject(value);
  if (budget === undefined) return;
  const names: ReadonlyArray<[string, string]> = [
    ["bytes", "maxBytes"],
    ["tokens", "maxTokens"],
    ["items", "limit"],
    ["rows", "maxRows"],
    ["cells", "maxCells"],
    ["allowFull", "allowFull"],
  ];
  for (const [from, to] of names) if (budget[from] !== undefined) args[to] = budget[from];
  // P2-1 (2026-09-08): mark THIS args["allowFull"] as canonical-sourced, so
  // forceContentServe (dispatchTool's tl_read_file case) can tell it apart from
  // a raw legacy flat `allowFull` — see CANONICAL_ALLOWFULL_INPUT's own doc
  // comment for why only the legacy dialect still forces a resend from it.
  if (budget["allowFull"] !== undefined) {
    Object.defineProperty(args, CANONICAL_ALLOWFULL_INPUT, { value: true, enumerable: true, configurable: true });
  }
}

export function mapCanonicalScope(value: unknown, args: Record<string, unknown>): Record<string, unknown> | undefined {
  const scope = asCanonicalObject(value);
  if (scope === undefined) return undefined;
  for (const name of [
    "path", "archive", "credentialRef", "lang", "regex", "depth",
    "includeClosure", "surfaceRoles", "includeScores", "symbol",
  ]) {
    if (scope[name] !== undefined) args[name] = scope[name];
  }
  return scope;
}

export function mapCanonicalSelect(value: unknown, args: Record<string, unknown>): boolean {
  const select = asCanonicalObject(value);
  if (select === undefined) return false;
  const names: ReadonlyArray<[string, string]> = [
    ["kind", "kind"],
    ["format", "as"],
    ["comments", "comments"],
    ["sheet", "sheet"],
    ["rows", "rows"],
    ["columns", "columns"],
    ["sections", "sections"],
    ["slides", "slides"],
    ["pages", "pages"],
  ];
  // Every present field is still copied onto `args` unconditionally — a
  // `comments`/`sections` selector must reach the ordinary read dispatcher
  // exactly as before. Only the RETURN VALUE narrows to ARTIFACT_SELECT_KEYS,
  // because that value alone decides `mode="artifact"` at the call site.
  let selectsArtifact = false;
  for (const [from, to] of names) {
    if (select[from] !== undefined) {
      args[to] = select[from];
      if (ARTIFACT_SELECT_KEYS.includes(from)) selectsArtifact = true;
    }
  }
  return selectsArtifact;
}

export function legacyPathTarget(target: Record<string, unknown>): string | Record<string, unknown> {
  if (typeof target["path"] === "string"
    && target["range"] === undefined
    && target["ranges"] === undefined
    && target["symbol"] === undefined
    && target["purpose"] === undefined) {
    return target["path"];
  }
  const mapped: Record<string, unknown> = {};
  for (const name of ["path", "range", "ranges", "symbol", "purpose"]) {
    if (target[name] !== undefined) mapped[name] = target[name];
  }
  // FX-M1/E1: a bare `{handle}` target (no `path`) used to become `{}` here
  // — indistinguishable from a genuinely empty entry, and silently dropped
  // by every downstream `paths[]` consumer (the mixed
  // `targets:[{handle},{path}]` batch defect). Preserve it as `handle` so
  // the two consumers that now know how to resolve it — the mode=full/
  // mode=skeleton `paths[]` batch loops just below (`resolvePathsBatchEntry`)
  // and task_pack's own `normalizePathEntry` — can turn it back into a real
  // path instead of losing it. Only set when `path` itself is absent: a
  // target that already resolved BOTH keeps its existing `{path,...}`
  // projection unchanged (every other branch above already handles that
  // combination byte-for-byte as before).
  if (mapped["path"] === undefined && typeof target["handle"] === "string") {
    mapped["handle"] = target["handle"];
  }
  return mapped;
}

/**
 * FX-M1/E1: resolve one `paths[]`-shape batch entry — a bare string path, a
 * `{path,...}` object (both pre-existing shapes), or a `{handle}` object with
 * no path at all (the shape `legacyPathTarget` above now preserves instead of
 * collapsing to `{}`). Mirrors the handles=[] batch loop's own
 * `handle-unknown` / `handle-workspace-mismatch` disclosure exactly (see that
 * loop, a few hundred lines below), so an entry whose handle cannot be
 * resolved is reported the same way there — never silently dropped.
 */
export function resolvePathsBatchEntry(
  entry: unknown,
  workspace: string,
): {
  path: string;
  handle?: string;
  handleReason?: "handle-unknown" | "handle-workspace-mismatch" | "not-found";
  // TL-05 (plan §7.1): an explicit per-entry selector, present only when the
  // CALLER's own `{path,...}`/`{handle,...}` object carried it — never
  // synthesized from a resolved handle's stored metadata (unlike the A7
  // handles=[] batch's override precedence a few hundred lines below). Read
  // by the `mode=full` paths[] batch loop to decide a ranged-slice serve vs.
  // today's whole-file serve, per entry; the other two callers of this
  // helper (the skeleton paths[] batches) never read these fields and are
  // therefore byte-identical to before this addition.
  range?: string;
  ranges?: string[];
  symbol?: string;
} {
  if (typeof entry !== "object" || entry === null) return { path: String(entry ?? "") };
  const record = entry as Record<string, unknown>;
  const selector = {
    ...(typeof record["range"] === "string" ? { range: record["range"] } : {}),
    ...(Array.isArray(record["ranges"]) ? { ranges: record["ranges"].map(String) } : {}),
    ...(typeof record["symbol"] === "string" ? { symbol: record["symbol"] } : {}),
  };
  const path = typeof record["path"] === "string" ? record["path"] : "";
  if (path.length > 0) return { path, ...selector };
  const handle = typeof record["handle"] === "string" ? record["handle"] : undefined;
  if (handle === undefined) return { path: "" };
  const hEntry = handleTable.get(handle);
  if (hEntry === undefined) return { path: "", handle, handleReason: "handle-unknown" };
  if (hEntry.workspaceRoot !== workspace) return { path: "", handle, handleReason: "handle-workspace-mismatch" };
  // Mirrors the handles=[] batch loop's own "not-found" reason for a live
  // handle entry that never recorded a path (same shape, same wording).
  return hEntry.path
    ? { path: hEntry.path, handle, ...selector }
    : { path: "", handle, handleReason: "not-found" };
}

/**
 * TL-05 (plan §7.1) — resolve ONE `paths[]` batch entry that carries its own
 * `range`/`ranges`/`symbol` selector, for the `mode=full` batch loop below.
 *
 * Reaching that loop at all already means the call named `content:"full"`
 * (the only place a multi-target canonical request sets `mode="full"" —
 * see `RANGE_CONTENT_FULL_INPUT`'s doc comment), so every entry resolved
 * here is a "range + full" request: served UNELIDED (no
 * `elideDocCommentsForDisplay` call at all — `resolveSlice`/
 * `resolveSliceRanges` already return the raw, uncompressed slice) and
 * NEVER widened past the requested window, per the plan §7.1 contract table.
 *
 * Mirrors the A7 `handles=[]` batch's own per-item resolution (same
 * `resolveSlice`/`resolveSliceRanges` calls) but is kept SEPARATE from it:
 * A7 addresses an already-minted HANDLE (a prior resolution) and reads its
 * content through the handle-workspace/archive-member guards; this one
 * addresses a bare PATH (a first-time or plain re-read) via the ordinary
 * `servedTextForRoute` route only.
 *
 * Returns `undefined` when this entry should fall back to today's ordinary
 * whole-file `resolveFullReadForPath` route instead — an archive member, an
 * Office document (neither has line-addressable ranges), or a content read
 * that failed (not found / undecodable): `resolveFullReadForPath` already
 * knows how to serve or refuse each of those correctly, and re-implementing
 * that here would be a second, divergent copy of it.
 */
export async function resolveRangedPathsBatchEntry(
  workspace: string,
  path: string,
  selector: { range?: string; ranges?: string[]; symbol?: string },
  stageRequest = false,
): Promise<
  | { ok: true; items: Array<Record<string, unknown>> }
  | { ok: false; reason: string }
  | undefined
> {
  if (splitArchiveVirtualPath(path) !== undefined) return undefined;
  const ext = (path.toLowerCase().match(/\.([^.\\/]+)$/)?.[1]) ?? "";
  if (ext === "docx" || ext === "xlsx" || ext === "pptx" || ext === "pdf") return undefined;
  // served-bytes: readServedText
  const verdict = await servedTextForRoute(path, workspace);
  if (verdict === null || verdict.kind === "undecodable") return undefined;
  const content = verdict.text;
  const rawSha = shaOfText(content);
  const totalLines = countLines(content);

  if (selector.ranges !== undefined && selector.ranges.length > 0) {
    const batch = await resolveSliceRanges(workspace, path, content, selector.ranges);
    if (!batch.ok) return { ok: false, reason: batch.error };
    const batchData = batch.data;
    if (stageRequest) stageWindowReadRequest(workspace, path, content, selector.ranges, true);
    const call = beginServeCall(workspace);
    const items: Array<Record<string, unknown>> = batchData.segments.map((segment): Record<string, unknown> => {
      const segStart = rangeStartLine(segment.range);
      const segEnd = Math.min(totalLines, segStart + countLines(segment.code) - 1);
      recordServedRange(workspace, path, rawSha, segStart, segEnd, totalLines, { mode: "full", range: segment.range, call });
      return {
        path,
        handle: batchData.handle,
        range: segment.range,
        content: segment.code,
        truncated: segment.truncated === true,
        sha: shortSha(segment.sha),
        ...(segment.note !== undefined ? { note: segment.note } : {}),
      };
    });
    recordReadPath(workspace, path);
    // A requested window this call never even attempted (resolveSliceRanges'
    // OWN aggregate cap, independent of this loop's caller-declared byte
    // ceiling) rides the LAST segment's own `next`/`remaining_ranges` — the
    // same continuation a single-target `ranges:[...]` call would carry.
    if (batchData.remaining_ranges !== undefined && batchData.remaining_ranges.length > 0 && items.length > 0) {
      const last = items[items.length - 1]!;
      last["remaining_ranges"] = batchData.remaining_ranges;
      if (batchData.next !== undefined) last["next"] = batchData.next;
    }
    return { ok: true, items };
  }

  const sliceResult = await resolveSlice(workspace, path, content, selector.symbol, selector.range);
  if (!sliceResult.ok) return { ok: false, reason: sliceResult.error };
  const data = sliceResult.data;
  if (data.assembled || stageRequest) stageWindowReadRequest(workspace, path, content, selector.range ?? data.range, true);
  if (!data.assembled) {
    const start = rangeStartLine(data.range);
    const end = Math.min(totalLines, start + countLines(data.content) - 1);
    recordServedRange(workspace, path, rawSha, start, end, totalLines, { mode: "full", range: data.range, call: beginServeCall(workspace) });
  }
  return {
    ok: true,
    items: [{
      path,
      handle: data.handle,
      range: data.range,
      content: data.content,
      truncated: data.truncated,
      sha: shortSha(data.sha),
      ...(data.note !== undefined ? { note: data.note } : {}),
      ...(data.concern_note !== undefined ? { concern_note: data.concern_note } : {}),
      ...(data.remaining_ranges !== undefined ? { remaining_ranges: data.remaining_ranges } : {}),
      ...(data.next !== undefined ? { next: data.next } : {}),
    }],
  };
}

/**
 * TL-05 (plan §7.1) — shrink ONE resolved ranged-batch item's `content` to at
 * most `maxBytes` (of the whole item's own JSON encoding), on a line
 * boundary, narrowing `range` and reporting the cut-off remainder as a
 * "start-end" string.
 *
 * WHY THIS RUNS AT CONSTRUCTION TIME, NOT LEFT TO THE EMIT-TIME SHED LADDER.
 * The mode=full paths[] batch loop's admission (below) guarantees progress by
 * force-admitting ONE entry even when it alone exceeds the caller's declared
 * ceiling (see that loop's own comment). Measured while building this fix:
 * when that forced entry was left oversized and a DIFFERENT entry was ALSO
 * deferred to the ceiling, the response ended up with TWO independent things
 * needing a continuation — the deferred entry (this response's own
 * `next`) and the forced entry's own overage (which only the emit-time
 * ladder could shed, as a PER-ENTRY `next`). `wireLimit.ts`'s E3 merge
 * (clause 4) keeps an emitter-provided `next` over the ladder's own
 * continuation whenever one already exists, and a caller that runs a
 * response's `next` verbatim (AGENTS.md) has no reason to also inspect a
 * DIFFERENT entry's own `next` once it does — plan §7.1's own C01 fixture
 * (two ranged targets, EACH alone over a 6500 B budget) reproduced this
 * exactly: beta shipped, truncated by the ladder to a `next` naming its own
 * remainder, but the response's actual `limit.next` (correctly) named
 * alpha instead, and beta's remainder was never revisited. Truncating HERE
 * — before either entry reaches the ladder — keeps the whole response
 * within budget by construction, so there is only ever ONE thing left
 * to name, and it can ride the SAME combined `targets:[]` continuation this
 * loop already builds for its other deferred entries.
 */
/**
 * BCF: the caller-side reserve `truncateResolvedItemToFit`'s ONE call site
 * (the mode=full paths[] batch admission loop) subtracts from
 * `fullBatchCeiling`, on top of each sibling deferred target's own already-
 * known address bytes — see that call site's own comment for why the item-
 * local fit this function performs is not, by itself, the whole response's
 * budget.
 */
export const OUTER_BATCH_RESERVE_BYTES = 700;

export function truncateResolvedItemToFit(
  item: Record<string, unknown>,
  maxBytes: number,
): { item: Record<string, unknown>; deferredRange?: string } {
  const range = typeof item["range"] === "string" ? item["range"] : undefined;
  const content = typeof item["content"] === "string" ? item["content"] : undefined;
  if (range === undefined || content === undefined) return { item };
  const bounds = /^(\d+)-(\d+)$/.exec(range);
  if (bounds === null) return { item };
  const start = Number(bounds[1]);
  const end = Number(bounds[2]);
  // The item's own non-content bytes (handle/range/sha/…) count against the
  // budget too — shrinking only `content` while ignoring that overhead would
  // still overshoot on a small declared ceiling.
  const overhead = Buffer.byteLength(JSON.stringify({ ...item, content: "" }), "utf8");
  const budget = Math.max(1, maxBytes - overhead);
  const lines = content.split("\n");
  // BCF (eval-0929 §9, DESIGN-v0.14-plan.md §16.6 residual): byte-precise
  // greedy fill — the SAME wire-accurate per-line measurement `choosePage`
  // uses (`state/readRequestStore.ts`'s `wireLineCostBytes`, which escapes
  // each line the way `JSON.stringify` would, so quote/backslash-heavy
  // source is not under-counted the way a raw `Buffer.byteLength` compare
  // is) — instead of converging on a power-of-two FRACTION of the line
  // count. `keep` is the LARGEST whole-line prefix whose wire cost fits
  // `budget`, found in one pass rather than several halving passes that each
  // overshoot past the true boundary (measured: a 70-line/11,409 B window
  // against a 6,377 B sub-budget halved straight to 35 lines/5,704 B — one
  // fewer halving step than the boundary needed, landing at 89% fill instead
  // of the ~99% one more precise line would have reached).
  let used = 0;
  let keep = 0;
  for (const line of lines) {
    const cost = wireLineCostBytes(line);
    if (used + cost > budget) break;
    used += cost;
    keep += 1;
  }
  if (keep >= lines.length) return { item }; // the whole (escaped) content already fits
  if (lines.length < 2) return { item }; // one giant line: nothing to cut on a line boundary
  keep = Math.max(1, keep);
  const keptText = lines.slice(0, keep).join("\n");
  const keptEnd = start + keep - 1;
  if (keptEnd >= end) return { item };
  const priorRemaining = Array.isArray(item["remaining_ranges"])
    ? (item["remaining_ranges"] as unknown[]).filter((value): value is string => typeof value === "string")
    : [];
  let unkeptEnd = end;
  for (const span of priorRemaining) {
    const parsed = /^(\d+)-(\d+)$/.exec(span);
    if (parsed !== null && Number(parsed[2]) > unkeptEnd) unkeptEnd = Number(parsed[2]);
  }
  const deferredRange = `${keptEnd + 1}-${unkeptEnd}`;
  // BCF: this call site now also reaches a WHOLE-FILE item
  // `resolveFullReadForPath`/`buildFullServePayload` already chunked once
  // (its own `FULL_SERVE_CHUNK_BYTES`/caller-budget cap) — that producer
  // attaches its OWN `next`, naming ITS chunk's own remainder. Cutting this
  // item FURTHER moves the true remainder to `deferredRange` (computed above
  // against the WIDEST prior end, `unkeptEnd`, so it already supersedes that
  // producer `next`'s own range) — an untouched `item.next` would still name
  // the pre-cut boundary and skip every line between the two (confirmed
  // live: a 90-line chunk cut to 21 lines left its own stale `next` naming
  // "91-…", silently skipping lines 22-90). The response's own top-level
  // continuation (built from `deferredForNext`, which this call's caller
  // pushes `deferredRange` onto) is what is authoritative now, so any
  // per-item `next` is dropped rather than left to disagree with it — a
  // `resolveRangedPathsBatchEntry` item never carried one in the first
  // place, so this is a no-op for that, the original, caller.
  const { next: _staleNext, ...withoutStaleNext } = item;
  return {
    item: {
      ...withoutStaleNext,
      range: `${start}-${keptEnd}`,
      content: keptText,
      truncated: true,
      remaining_ranges: [deferredRange],
    },
    deferredRange,
  };
}

// D-3 router bridge: canonical inputs become the existing serving arguments.
// Wire callers cannot forge this module-private symbol. It survives the one
// internal spread between canonical projection and legacy dispatch, proving
// that create-by-copy came from the advertised edits[] carrier.
export const CANONICAL_CREATE_COPY_INPUT = Symbol("tokenlighten.canonical-create-copy-input");

// F-V13-1 Fix B (DESIGN-v0.13-plan.md:167, 2026-08-30 triage): per-target
// range/symbol overrides for a multi-HANDLE tl_read_file batch. A Symbol key for
// the exact same reason as CANONICAL_CREATE_COPY_INPUT above — it must never
// be reachable as an advertised/wire property (requestShape.ts's
// findUnknownProperties walks `Object.keys`/`Object.entries` only, so a
// Symbol-keyed property is structurally invisible to it and to a caller
// forging a plain string `"handleOverrides"` key). Unlike
// CANONICAL_CREATE_COPY_INPUT, this is NOT deleted inside normalizeWireArgs —
// it has to survive all the way to the A7 handles=[] batch loop deep inside
// dispatchTool's tl_read_file case, and `args` is passed by reference (plus one
// more object-spread in normalizeWireArgs, which — like the canonical
// projection's own `{...input}` — copies own ENUMERABLE properties including
// symbol keys) the whole way there.
export const HANDLE_OVERRIDES_INPUT = Symbol("tokenlighten.read-file-handle-overrides");

// FX-M8: same module-private Symbol pattern as HANDLE_OVERRIDES_INPUT above —
// unforgeable from the wire (findUnknownProperties walks Object.keys/
// Object.entries only, which never see a Symbol key) and, like that constant,
// survives the `{...input}`/`{...args}` spreads between normalizeWireArgs and
// dispatchTool. Set at both `args["paths"] = targets.map(legacyPathTarget)`
// sites below, whenever the canonical `targets:[...]` dialect rescue is the
// one synthesizing `args.paths` rather than a caller sending legacy `paths[]`
// directly. dispatchTool's tl_read_file case reads (and deletes) it right before
// building the post-normalization validation schema, and substitutes
// LEGACY_PATHS_SCHEMA_INTERNAL for `paths` only when it is present — so a
// bare `{handle}` entry `legacyPathTarget` produced (FX-M1/E1) still clears
// the gate, while the wire-facing LEGACY_PATHS_SCHEMA (and its `keys` in an
// actual caller's `unknown-arguments` refusal) never advertises `handle`.
export const LEGACY_PATHS_INTERNAL_HANDLE_INPUT = Symbol("tokenlighten.read-file-legacy-paths-internal-handle");

// P2-1 (2026-09-08, hands-on report v0.14.1): `allowFull` is decoupled from
// forced resend — `budget.allowFull` now only raises the full-read byte cap
// (resolveFullReadForPath's `effectiveCapBytes`); it no longer makes
// `forceContentServe` (below) bypass an otherwise-qualifying receipt. Only
// `task.force_serve:true` does that for the CANONICAL dialect. The LEGACY
// flat `allowFull` field (pi03DedupHonesty.spec.ts's "mode=slice: legacy
// allowFull:true still forces a real serve..." case, exercised under this
// package's ambient `TL_LEGACY_INPUT=accept`) keeps its old forcing meaning —
// this Symbol is how `forceContentServe` tells the two apart under the one
// flat `args["allowFull"]` key `mapCanonicalBudget` writes for both. Same
// module-private Symbol pattern as HANDLE_OVERRIDES_INPUT above: unforgeable
// from the wire, survives the `{...input}`/`{...args}` spreads between
// normalizeWireArgs and dispatchTool. Set only by `mapCanonicalBudget`, when
// `budget.allowFull` (not a raw legacy top-level `allowFull`) is what
// populated `args["allowFull"]`.
export const CANONICAL_ALLOWFULL_INPUT = Symbol("tokenlighten.canonical-allowfull-input");

/** Marks a `force_serve` that WP-S10's small-window reserve set on the caller's behalf (see `forceServeCallerTargetsOnly`). */
export const SMALL_WINDOW_RESERVE_FORCE = Symbol("tokenlighten.small-window-reserve-force");

// TL-05 (plan §7.1, 2026-09-21 fix wave): a canonical `content:"full"`
// combined with an explicit `range`/`ranges`/`symbol` selector on the SAME
// request must serve that window UNELIDED (no doc-comment collapsing, no
// outline/skeleton substitution while the window still fits the budget) and
// must never widen the target past the requested window. `content` is
// consulted only to pick `args["mode"]` a few lines below and is then
// deleted (`delete args["content"]`, this block's own tail) — by the time a
// ranged dispatch (mode=slice, the `ranges[]` batch, or the `paths[]`
// mode=full batch loop) decides whether to elide, there is no way left to
// tell "range + full" apart from "range + auto" without this marker. Same
// module-private Symbol pattern as HANDLE_OVERRIDES_INPUT/
// CANONICAL_ALLOWFULL_INPUT above: unforgeable from the wire, survives the
// `{...input}`/`{...args}` spreads between normalizeWireArgs and
// dispatchTool. Deliberately NOT reused for `forceContentServe` — R6
// (immediately below) already settled that `content:"full"` alone must never
// force a resend; this marker only ever widens WHAT IS SHOWN of bytes that
// were going to be served anyway, never WHETHER they are served.
//
// FIX-A3 (2026-09-21): this is now an ALIAS for `RANGE_CONTENT_FULL_MARKER`
// (`protocol/budget/shedders/registry.ts`), not a second, locally-scoped
// Symbol — a shed rung that mints a continuation for a truncated ranged serve
// (`readBatch.ts`'s rungs 4/6) needs to read the SAME fact off `ShedContext.args`
// to keep echoing `content:"full"` across the hop, and two distinct Symbols
// keyed under two different names would make this file's own stamp invisible
// to that reader. Every existing local use of `RANGE_CONTENT_FULL_INPUT`
// below is unchanged; only the declaration moved.
export const RANGE_CONTENT_FULL_INPUT = RANGE_CONTENT_FULL_MARKER;

// DESIGN-v0.15 §6.3 (R6, 2026-09-07): round-18A finding 3 / ruling (u-1) is
// SUPERSEDED. That ruling treated "a canonical `content:"full"` repeat still
// answers `read.receipt` instead of bytes" as a bug and added a Symbol-keyed
// marker (`CANONICAL_CONTENT_FULL_INPUT`, formerly declared here) carrying
// the ORIGINAL canonical `content:"full"` fact across `normalizeCanonicalRequest`'s
// `delete args["content"]` so `forceContentServe` could see it under any
// dialect and force a resend. R6 makes that dedup the INTENDED behavior — see
// `forceContentServe`'s own doc comment (deep inside dispatchTool's tl_read_file
// case) for the current contract — so the marker is removed rather than kept
// unused: `content:"full"` no longer needs to survive the delete for
// `forceContentServe`'s sake, and nothing else ever read it.

// I-5 fix (v0.13.1 forensics, DESIGN-v0.13-plan.md §6 2026-08-30 entry;
// bench/workflows/experiments/2026-08-30-v0131-forensics/{REPORT.md,terra/
// report.md}): a multi-target tl_read_file call that mixes an archive selector
// (or a call-level artifact `select`) with another target cannot be
// projected onto the legacy paths[]/mode dispatcher below without either an
// order-dependent refusal or a SILENT PARTIAL SERVE. legacyPathTarget above
// keeps only path/range/symbol/purpose, so an archive-carrying target riding
// alongside a plain sibling loses its selector the moment it is mapped —
// and depending on which sibling `first` (the mode-inference target) turns
// out to be, the call either never resolves mode="archive"/"artifact" at
// all (the archive/artifact target becomes a bare `{}` inside paths[],
// silently served as nothing — the correctness defect) or resolves it while
// paths[] still carries more than one entry, which the archive/artifact
// dispatcher refuses "path is required" — order-dependent either way.
// Spawned-stdio-confirmed for all three shapes (terra/i5-i6-spawned-
// results.json): archive-first+plain -> invalid-input; plain+archive-second
// -> read.batch serving ONLY the plain target with no error at all; two
// paths+artifact select -> invalid-input.
//
// F5 extension (opus pre-release review, 2026-08-30): a DIFFERENT silent-drop
// shape shares this exact gate. `mapCanonicalScope` copies `scope.archive`
// onto the legacy top-level `args["archive"]` field regardless of `targets`,
// and `selectorFromArgs(args)` (tools/archive.ts) reads that top-level field
// UNCONDITIONALLY a few hundred lines below in the tl_read_file dispatch
// (`archiveSelector`), computing `resolvedPath` from it before `mode` is even
// resolved — so a `targets:[...]` batch riding alongside `scope.archive`
// never reaches the legacy `paths[]`/multi-target machinery at all: the
// single archive-derived `resolvedPath` silently wins and every target is
// dropped, with no error, regardless of target count or whether `query` also
// rode along. Gated on `scope.archive` being present AND at least one target
// lacking its own per-target `archive` (a target that DOES carry its own
// `archive` is unambiguous and already handled above) — this also covers a
// SINGLE plain target, unlike the multi-target-only condition above, because
// the silent-drop mechanism here does not require a second target to bite.
//
// Same module-private Symbol pattern as HANDLE_OVERRIDES_INPUT immediately
// above — unforgeable from the wire (findUnknownProperties walks
// Object.keys/Object.entries only) and, like that constant, survives the
// `{...input}` spread inside normalizeWireArgs all the way to dispatchTool's
// tl_read_file case. Read back and returned there BEFORE declareKind — the
// exact F-V13-1 Fix B / B1 ordering constraint documented at this file's A7
// handles=[] block (a refusal returned after declareKind is misclassified as
// a successful, empty read.batch).
//
// Reuses the existing `invalid-input` RefusalCode (A.7.1) rather than
// minting a new one: the immediately-adjacent F-V13-1 Fix B / B1 refusals a
// few hundred lines below this one refuse the SAME class of problem — "this
// multi-target batch shape cannot be dispatched" — with `code:"invalid-
// input"` plus a descriptive `field`/`error`, never a dedicated code. A new
// code would be free to mint (refusalCodeParity.spec.ts's own doc: additive
// minting is a floor, not a pin) but would still need a matching
// `RequestShapeCode` entry in packages/types/src/mcp/protocol.ts for
// refusalCodeOf to recognize it at all — extra surface with no behavioral
// upside here, since `code`+`field`+`detail`+`next` already fully describe
// the recovery and no caller-side branch depends on a more specific token.
export const MULTI_TARGET_SELECTOR_REFUSAL_INPUT = Symbol("tokenlighten.read-file-multi-target-selector-refusal");

// ---------------------------------------------------------------------------
// FX-2 (v0.13 wave-3 review fix): string-to-structure leniency.
//
// Review probe evidence (session transcript, 2026-08-29): Claude Code 2.1.211
// has been observed sending a top-level canonical object/array parameter
// JSON-STRINGIFIED rather than as a native object/array — `typeof
// input.edits === "string"` holding `JSON.stringify(...)` of the caller's
// intended array. Codex CLI, sending native objects, does not hit this.
//
// Every existing consumer below is silently string-blind: `asCanonicalObject`
// (this file) returns `undefined` for a string and callers no-op on
// `undefined`, so a stringified `task` does not refuse — it vanishes. The
// caller's `task.epoch`/`task.id`/`task.challenge`/`task.force_serve` binding
// is silently dropped, the session stays on whatever state it already held,
// and the NEXT typestate-fence refusal has nothing to do with serialization —
// a strong root cause of the repeated execution-typestate refusal loops this
// client was observed producing. A stringified `edits` fares better only by
// accident: tl_edit_file's own `Array.isArray(edits)` guard (~L11114) already
// refuses "edits must be an array" — but only once the call clears every
// earlier gate, and only for `edits` specifically.
//
// D-5 (acceptance-first: intent is unambiguous): a string is accepted IN
// PLACE of its declared object/array shape ONLY when (a) it parses as JSON,
// (b) the parsed value's top-level shape (object vs array) matches what the
// field declares, AND (c) the parsed value passes the EXACT SAME recursive
// property-name validation (`findUnknownProperties`) a natively-sent value
// would receive against the REAL advertised schema (`advertisedPropertiesFor`
// — the same map `emittedToolCallShape.spec.ts` validates outbound calls
// against). A parse failure or a validation failure changes NOTHING: the
// original string rides through untouched, so every existing refusal path
// (`asCanonicalObject` no-op, "edits must be an array", unknown-arguments)
// still fires exactly as it does today for anything this does not rescue —
// this function only ever WIDENS acceptance, never narrows or hides a
// genuine shape defect.
//
// Nested one-level rescue: an array field that already arrived as a native
// array, but whose OWN elements are individually stringified objects
// (`edits[0]` a JSON string while `edits` itself is a real array), gets the
// identical treatment for each element — once, not recursively, so a caller
// cannot bury an arbitrarily-deep stringified structure and have all of it
// silently unwrapped. Scoped to fields whose declared item shape is itself an
// object (`targets`, `edits`) — `queries`' items are plain strings by
// design, so a literal string that happens to parse as JSON (e.g. a search
// for the text `["x"]`) must never be reinterpreted as structure.
// ---------------------------------------------------------------------------

export const CANONICAL_OBJECT_FIELDS: readonly string[] = ["task", "scope", "select", "budget", "artifact", "credentials"];

export const CANONICAL_ARRAY_FIELDS: readonly string[] = ["targets", "queries", "edits"];

export function stageWindowReadRequest(
  workspace: string,
  filePath: string,
  content: string,
  ranges: string | string[],
  keepComments: boolean,
  forceServeOrigin = false,
): void {
  const args = protocolCallContext()?.args;
  const totalLines = countLines(content);
  if (args === undefined || totalLines <= 0) return;
  const requested: LineWindow[] = [];
  const elided: LineWindow[] = [];
  const lines = content.split(/\r?\n/);
  for (const window of parseWindows(Array.isArray(ranges) ? ranges : [ranges])) {
    const start = Math.max(1, window.start);
    const end = Math.min(totalLines, window.end);
    if (start > end) continue;
    const raw = lines.slice(start - 1, end).join("\n");
    const policyElided = keepComments
      ? []
      : elideDocCommentsForDisplay(raw, languageForPath(filePath), false, start).elided;
    requested.push(...(keepComments ? [[start, end]] : spansExcludingWindows(start, end, policyElided))
      .map(([first, last]) => ({ start: first!, end: last! })));
    elided.push(...policyElided.map(([first, last]) => ({ start: first, end: last })));
  }
  stageReadRequestForServe({
    workspace, relPath: filePath, fileSha: shaOfText(content), totalLines,
    requested, content: "auto", keepComments,
    args: forceServeOrigin ? {...args, force_serve: true} : args, elided,
  });
}
