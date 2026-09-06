// read_code mode=pack — assemble multiple path/range slices under a token cap.

import type { ReadCodePackInput, ReadCodePackOutput, ReadCodePackResponseItem } from "@tokenlighten/types";
import { locateTaskContext } from "../features/locator/locateTaskContext.js";
import { buildSmallFile } from "./readCodeSmallFile.js";
import { escapeRegExp, MAX_REGEX_QUERY_CHARS } from "../features/search/find/findText.js";
import { estimateBytesFromTokens, BYTES_PER_TOKEN_ESTIMATE } from "../protocol/budget/wireBudget.js";
import { measureResponseBytes } from "../protocol/budget/measure.js";

// A7: raised from 1600 — the query-pack code-bearing path and paths[]-driven
// packs both needed more headroom to close multi-surface tasks in one call
// (reports/bench/2026-07-02a/analysis/dive_mcp-source.md "First-class batching").
export const PACK_DEFAULT_MAX_TOKENS = 4000;
export const QUERY_PACK_DEFAULT_MAX_TOKENS = 1400;
export const QUERY_PACK_HARD_CAP_TOKENS = 2400;

// ---------------------------------------------------------------------------
// FX-U3 (2026-09-04, round-19A informational finding) — the WIRE budget for
// mode=pack, not a raw-content-chars proxy for it.
//
// Both admission loops below used to compare RAW CONTENT CHARS
// (`content.length`) against `maxTokens * 4`, entirely ignoring the wire
// envelope every admitted item actually costs once
// `protocol/readFamily.ts`'s `projectBatch` wraps it for the wire
// (`{form:"range",path,range,truncated,[purpose,]content}`, `readFamily.ts`
// ~:1226, `keep(entry, raw, ["purpose","content"])`) and the whole
// `read.batch` payload is JSON-serialized. Measured live (`mode=pack`,
// `TL_LEGACY_INPUT=accept`, 40 tiny files): 5.8x-13.5x the caller's declared
// `maxTokens * 4` byte ceiling. A caller-declared token budget is a WIRE
// budget everywhere else in this server (`estimateBytesFromTokens`,
// `protocol/budget/wireBudget.ts`, the same 4 B/token ratio) — mode=pack must
// budget the same quantity, not raw content chars, so a partial `read.batch`
// with `omitted[]` fits the declared budget BY CONSTRUCTION (the funnel's own
// `emit.ts` ladder no longer needs to special-case `mode=pack`; see the
// exclusion removed there in the same change).
//
// `packItemWireBytes` mirrors the exact downstream item shape above BYTE FOR
// BYTE (key order does not affect serialized length, only the key/value SET
// does, so the mirror does not need to match `projectBatch`'s literal
// insertion order) — it exists purely to size an admission decision, not to
// duplicate protocol-layer logic; the actual item pushed into `items` below
// is unchanged (still `{path,range,purpose?,content,truncated}`, no `form`
// key — `readFamily.ts` adds that independently).
// ---------------------------------------------------------------------------

/**
 * Wire-envelope bytes ONE admitted pack item costs on the actual
 * `read.batch` response, mirroring `protocol/readFamily.ts`'s `projectBatch`
 * range-item shape exactly. Pack items here never carry `truncated:true` (no
 * producer in this file truncates an admitted item), so this is always the
 * untruncated arm's byte cost.
 *
 * A "Class C pre-shed content budget" site (`wireBudgetG8Fence.spec.ts`'s own
 * framing): this producer, WHILE CONSTRUCTING a candidate pack, decides
 * whether ONE candidate item fits this call's feature-local `maxTokens`
 * allowance — a different thing from the funnel's single RESPONSE-level
 * measurement (`protocol/emit.ts` -> `measureResponseBytes`, taken once, on
 * the already-decided final payload). Reuses that same canonical byte-count
 * primitive (rather than a second, ad-hoc `Buffer.byteLength` fused directly
 * onto a fresh `JSON.stringify` call) so there is exactly one counting
 * routine in this server, not two that could drift.
 */
function packItemWireBytes(path: string, range: string, content: string, purpose: string | undefined): number {
  const mirrored: Record<string, unknown> = { form: "range", path, range, truncated: false };
  if (purpose !== undefined) mirrored["purpose"] = purpose;
  mirrored["content"] = content;
  return measureResponseBytes(JSON.stringify(mirrored));
}

/**
 * Bytes for `{"v":1,"kind":"read.batch","entries":[]}` — the fixed
 * `read.batch` skeleton every admitted item (joined by one comma byte each,
 * beyond the first) is wrapped into. Measured directly
 * (`JSON.stringify({v:1,kind:"read.batch",entries:[]}).length === 40`); this
 * intentionally does NOT reserve for the `limit`/`next` recovery block a
 * partial pack may additionally carry (that block's size depends on the
 * caller's `cwd` path length and the omitted-path list, neither of which
 * this producer controls or can see in advance) — `emit.ts`'s funnel, no
 * longer excluding `mode=pack`, is the backstop for that remaining variable
 * cost, exactly as it already is for every other response kind.
 */
const PACK_FIXED_ENVELOPE_BYTES = 40;

// CWE-400/409 caller-value hard clamp (TL-V0.9-RELEASE-STRATEGY-2026-08-12.md
// §6.6-2 item 3, shipped 2026-08-13): the path-pack branch below used to take
// `input.maxTokens ?? PACK_DEFAULT_MAX_TOKENS` with NO ceiling — unlike
// readCodeQueryPack further down, which already clamps via
// `Math.min(input.maxTokens ?? QUERY_PACK_DEFAULT_MAX_TOKENS,
// QUERY_PACK_HARD_CAP_TOKENS)`. This mirrors that exact constant/shape for
// path-pack: a non-finite/negative/zero caller value collapses to
// PACK_DEFAULT_MAX_TOKENS (server.ts's only caller forwards
// Number(args["maxTokens"]) verbatim — no call site ever intentionally sends
// 0 here, unlike office/csv.ts's maxRows:0), otherwise the value is capped at
// QUERY_PACK_HARD_CAP_TOKENS. In-range values pass through exactly. Note
// PACK_DEFAULT_MAX_TOKENS (4000) is intentionally left ABOVE
// QUERY_PACK_HARD_CAP_TOKENS (2400) — the omitted-knob default is unchanged
// from today (keeps default behavior byte-identical), while any EXPLICIT
// caller value, however small or large, is bounded by the shared ceiling.
// Exported so callerValueClamps.spec.ts can pin the exact clamp math
// directly, alongside the real readCodePack() entry-point coverage.
export function clampPackMaxTokens(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return PACK_DEFAULT_MAX_TOKENS;
  return Math.min(value, QUERY_PACK_HARD_CAP_TOKENS);
}

const SURFACE_PRIORITY: Record<string, number> = {
  contract: 0, data: 1, api: 2, ui: 3, style: 4, test: 5, config: 6, unknown: 7,
};

// Simple symbol scan: find first line matching a keyword+symbol pattern, take ±20 lines.
//
// CWE-1333 hardening: `symbol` is `paths[].symbol` — a caller-supplied JSON
// string (server.ts's mode=pack path mapping does `String(e["symbol"])` with
// no validation) — and MUST NOT be interpolated into the RegExp source
// as-is: an unescaped value lets a caller trigger catastrophic backtracking
// (e.g. symbol:"(a+)+$") or an uncaught SyntaxError (e.g. symbol:"["). Escape
// it to a literal match (same primitive renameSymbol.ts/findReferences.ts/
// readCodeModes.ts already use) and cap its length at the admission bound
// findText.ts's find uses for caller regex text (MAX_REGEX_QUERY_CHARS). An
// empty or over-cap symbol degrades to "no match" — this file's established
// idiom (the caller already treats a null return as `reason: "not-found"`)
// — never a thrown SyntaxError; the construction itself is also wrapped so
// no caller-supplied string can throw out of the pack path.
function symbolSlice(lines: string[], symbol: string): { start: number; end: number } | null {
  if (symbol.length === 0 || symbol.length > MAX_REGEX_QUERY_CHARS) return null;
  let re: RegExp;
  try {
    re = new RegExp(`(function|class|def|interface|type)\\s+${escapeRegExp(symbol)}\\b`);
  } catch {
    return null;
  }
  for (let i = 0; i < lines.length; i++) {
    if (re.test((lines[i] ?? "").trim())) {
      const start = Math.max(0, i - 20);
      const end = Math.min(lines.length - 1, i + 20);
      return { start, end };
    }
  }
  return null;
}

export async function readCodePack(
  input: ReadCodePackInput,
  workspace: string,
  readFileSafe: (relPath: string) => Promise<string | null>,
): Promise<ReadCodePackOutput> {
  // Defense in depth: reject if both paths and query are set.
  const hasPaths = Array.isArray(input.paths) && input.paths.length > 0;
  const hasQuery = typeof input.query === "string" && input.query.length > 0;

  if (hasPaths && hasQuery) {
    return { mode: "pack", items: [], omitted: [], completeness: "empty" };
  }

  if (hasQuery) {
    return readCodeQueryPack(input, workspace, readFileSafe);
  }

  // Path-pack (v0.4 behavior).
  const paths = input.paths ?? [];
  const maxTokens = clampPackMaxTokens(input.maxTokens);
  const budgetBytes = estimateBytesFromTokens(maxTokens) ?? maxTokens * BYTES_PER_TOKEN_ESTIMATE;
  let usedBytes = PACK_FIXED_ENVELOPE_BYTES;

  const items: ReadCodePackResponseItem[] = [];
  const omitted: ReadCodePackOutput["omitted"] = [];

  const rangeRe = /^(\d+)-(\d+)$/;
  let capExhausted = false;

  for (const entry of paths) {
    if (capExhausted) {
      omitted.push({ path: entry.path, reason: "cap-exhausted" });
      continue;
    }

    const raw = await readFileSafe(entry.path);
    if (raw === null) {
      omitted.push({ path: entry.path, reason: "not-found" });
      continue;
    }

    const lines = raw.split(/\r?\n/);

    let sliceStart: number;
    let sliceEnd: number;
    let rangeStr: string;

    const rangeMatch = entry.range ? rangeRe.exec(entry.range) : null;
    if (rangeMatch) {
      const s = parseInt(rangeMatch[1]!, 10);
      const e = parseInt(rangeMatch[2]!, 10);
      if (s > lines.length || e < 1) {
        omitted.push({ path: entry.path, range: entry.range, reason: "out-of-range" });
        continue;
      }
      sliceStart = Math.max(0, s - 1);
      sliceEnd = Math.min(lines.length - 1, e - 1);
      rangeStr = entry.range!;
    } else if (entry.symbol && !entry.range) {
      const hit = symbolSlice(lines, entry.symbol);
      if (!hit) {
        omitted.push({ path: entry.path, reason: "not-found" });
        continue;
      }
      sliceStart = hit.start;
      sliceEnd = hit.end;
      rangeStr = `${sliceStart + 1}-${sliceEnd + 1}`;
    } else {
      // A7: bare {path} (no range, no symbol) — treat like small_file instead
      // of rejecting as out-of-range, so naive batched "read these N files"
      // requests succeed for tiny files. Falls through to "not-tiny" when the
      // file is not tiny (small_file's own refusal path).
      //
      // P3: the small_file default flipped to "auto" (§C4), so a 3-8KB tiny
      // file returns OUTLINE (no content) by default and this branch dropped
      // it into omitted[]. An explicit paths[] pack enumerates the exact files
      // it wants FULL, so ask for content:"full" and exempt the request from
      // TINY_TASK_CAP (governorExempt — an explicit N-file pack is
      // one-call-complete by design; see item G1). A no-content result here is
      // "not-tiny" (the file exceeded the tiny threshold), NOT a range failure.
      const sfResult = await buildSmallFile(workspace, entry.path, undefined, { content: "full", governorExempt: true });
      if (!("mode" in sfResult) || sfResult.content === undefined) {
        omitted.push({ path: entry.path, range: entry.range, reason: "not-tiny" });
        continue;
      }
      // buildSmallFile's own `.content` is ELIDED (multi-line doc/comment
      // blocks collapse to a single marker line) — it exists here only to
      // gate tininess and record the governor exemption. Serving THOSE lines
      // as the pack item would silently drop the elided lines from the RAW
      // file (a 10-line JSDoc header collapses to 1 marker line, so slicing
      // the raw `lines` array to sfLines.length truncates the file's real
      // tail). Serve the FULL RAW file instead — the raw `lines` array
      // already in scope above.
      sliceStart = 0;
      sliceEnd = lines.length - 1;
      rangeStr = `1-${lines.length}`;
    }

    const sliceLines = lines.slice(sliceStart, sliceEnd + 1);
    const content = sliceLines.join("\n");

    const itemBytes = packItemWireBytes(entry.path, rangeStr, content, entry.purpose);
    const separatorBytes = items.length > 0 ? 1 : 0;
    const projectedBytes = usedBytes + separatorBytes + itemBytes;
    if (projectedBytes <= budgetBytes) {
      usedBytes = projectedBytes;
      items.push({
        path: entry.path,
        range: rangeStr,
        ...(entry.purpose !== undefined ? { purpose: entry.purpose } : {}),
        content,
        truncated: false,
      });
    } else if (PACK_FIXED_ENVELOPE_BYTES + itemBytes > budgetBytes) {
      // This single item's own wire cost is larger than the entire pack budget — cap-exceeded.
      omitted.push({ path: entry.path, range: rangeStr, reason: "cap-exceeded" });
    } else {
      // Item would fit in a fresh budget but not in the remaining budget — cap-exhausted.
      omitted.push({ path: entry.path, range: rangeStr, reason: "cap-exhausted" });
      capExhausted = true;
    }
  }

  const completeness = omitted.length === 0 ? "complete" : items.length === 0 ? "empty" : "partial";

  return {
    mode: "pack",
    items,
    omitted,
    completeness,
  };
}

interface PackEntry {
  path: string;
  range: string;
}

const RANGE_RE = /^(\d+)-(\d+)$/;

/** Normalize a locate candidate (hit or candidateDetail) into a deduplicated PackEntry list. */
function entriesFromCandidates(candidates: Array<{ path: string; line: number; range?: string }>): PackEntry[] {
  const rawEntries: PackEntry[] = candidates.map((c) => {
    let range: string;
    if (c.range && RANGE_RE.test(c.range)) {
      range = c.range;
    } else {
      const startLine = Math.max(1, c.line - 10);
      const endLine = c.line + 10;
      range = `${startLine}-${endLine}`;
    }
    return { path: c.path, range };
  });

  const seen = new Set<string>();
  const entries: PackEntry[] = [];
  for (const e of rawEntries) {
    const key = `${e.path}::${e.range}`;
    if (!seen.has(key)) {
      seen.add(key);
      entries.push(e);
    }
  }
  return entries;
}

/** Slice each entry's file content into the pack under the shared token budget. */
async function assemblePack(
  entries: PackEntry[],
  maxTokens: number,
  readFileSafe: (relPath: string) => Promise<string | null>,
): Promise<{ items: ReadCodePackResponseItem[]; omitted: ReadCodePackOutput["omitted"]; completeness: "complete" | "partial" | "empty" }> {
  const budgetBytes = estimateBytesFromTokens(maxTokens) ?? maxTokens * BYTES_PER_TOKEN_ESTIMATE;
  let usedBytes = PACK_FIXED_ENVELOPE_BYTES;
  const items: ReadCodePackResponseItem[] = [];
  const omitted: ReadCodePackOutput["omitted"] = [];
  let capExhausted = false;

  for (const entry of entries) {
    if (capExhausted) {
      omitted.push({ path: entry.path, range: entry.range, reason: "cap-exhausted" });
      continue;
    }

    const raw = await readFileSafe(entry.path);
    if (raw === null) {
      omitted.push({ path: entry.path, range: entry.range, reason: "not-found" });
      continue;
    }

    const lines = raw.split(/\r?\n/);
    const rangeMatch = RANGE_RE.exec(entry.range)!;
    const s = parseInt(rangeMatch[1]!, 10);
    const e = parseInt(rangeMatch[2]!, 10);

    if (s > lines.length || e < 1) {
      omitted.push({ path: entry.path, range: entry.range, reason: "out-of-range" });
      continue;
    }

    const sliceStart = Math.max(0, s - 1);
    const sliceEnd = Math.min(lines.length - 1, e - 1);
    const sliceLines = lines.slice(sliceStart, sliceEnd + 1);
    const content = sliceLines.join("\n");

    const itemBytes = packItemWireBytes(entry.path, entry.range, content, undefined);
    const separatorBytes = items.length > 0 ? 1 : 0;
    const projectedBytes = usedBytes + separatorBytes + itemBytes;
    if (projectedBytes <= budgetBytes) {
      usedBytes = projectedBytes;
      items.push({
        path: entry.path,
        range: entry.range,
        content,
        truncated: false,
      });
    } else if (PACK_FIXED_ENVELOPE_BYTES + itemBytes > budgetBytes) {
      omitted.push({ path: entry.path, range: entry.range, reason: "cap-exceeded" });
    } else {
      omitted.push({ path: entry.path, range: entry.range, reason: "cap-exhausted" });
      capExhausted = true;
    }
  }

  const completeness = omitted.length === 0 ? "complete" : items.length === 0 ? "empty" : "partial";
  return { items, omitted, completeness };
}

async function readCodeQueryPack(
  input: ReadCodePackInput,
  workspace: string,
  readFileSafe: (relPath: string) => Promise<string | null>,
): Promise<ReadCodePackOutput> {
  const maxTokens = Math.min(input.maxTokens ?? QUERY_PACK_DEFAULT_MAX_TOKENS, QUERY_PACK_HARD_CAP_TOKENS);

  // Mirrors buildTaskPack's locate call (readCodeTaskPack.ts): same query,
  // path/symbol/lang scoping, and the 6-surface limit, so a query that
  // yields a task_pack with surfaces also yields a non-empty plain pack here.
  const locate = await locateTaskContext(workspace, {
    action: "locate",
    query: input.query!,
    ...(input.path ? { path: input.path } : {}),
    ...(input.symbol ? { symbol: input.symbol } : {}),
    ...(input.lang ? { lang: input.lang } : {}),
    limit: 6,
  });

  if (!locate.hit) {
    // Mirror buildTaskPack's ambiguous-abstain fallback (readCodeTaskPack.ts
    // buildPartialPack): the locator often abstains ("ambiguous",
    // "multi-surface", "missing-surface") while still returning
    // candidateDetails — real path/range hits it just isn't confident enough
    // to call a single "hit". A plain pack can use those directly (refusals
    // are redirects: return the usable candidates, not a bare empty pack)
    // instead of forcing a second call.
    if (locate.candidateDetails && locate.candidateDetails.length > 0) {
      const entries = entriesFromCandidates(locate.candidateDetails);
      const result = await assemblePack(entries, maxTokens, readFileSafe);
      if (result.items.length > 0) {
        return {
          mode: "pack",
          items: result.items,
          omitted: result.omitted,
          completeness: result.completeness,
          locate: {
            hit: false,
            reason: locate.reason,
            ...(locate.candidates ? { candidates: locate.candidates } : {}),
          },
        };
      }
    }
    return {
      mode: "pack",
      items: [],
      omitted: [],
      completeness: "empty",
      locate: {
        hit: false,
        reason: locate.reason,
        ...(locate.candidates ? { candidates: locate.candidates } : {}),
      },
    };
  }

  // Build flat candidate list: primary first, then related sorted by surface priority.
  const primaryCandidates = locate.primary;
  const relatedCandidates = [...locate.related].sort((a, b) => {
    const pa = SURFACE_PRIORITY[a.surface] ?? 7;
    const pb = SURFACE_PRIORITY[b.surface] ?? 7;
    return pa - pb;
  });

  const allCandidates = [...primaryCandidates, ...relatedCandidates];
  const entries = entriesFromCandidates(allCandidates);
  const { items, omitted, completeness } = await assemblePack(entries, maxTokens, readFileSafe);

  return {
    mode: "pack",
    items,
    omitted,
    completeness,
    locate: {
      hit: true,
      confidence: locate.confidence,
      completeness: locate.completeness,
    },
  };
}
