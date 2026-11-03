// recursiveClosure — extracted implementation; imports point to the owning modules.
import * as path from "path";
import type { ContinuationCall } from "./packBasics.js";
import type { TaskPackResult } from "../model.js";
import type { TaskPackResultSurface } from "../model.js";
import { CLOSURE_EXECUTED_TOKENS_MAX } from "./recursiveClosure.js";
import { CLOSURE_EXECUTED_TOKEN_KEY } from "./recursiveClosure.js";
import { MAX_SURFACE_CODE_BYTES } from "./packBasics2.js";
import { NEXT_CALL_GENERIC_QUERY_TERMS } from "./epochEvidence2.js";
import { READINESS_PROBE_MAX_FILES } from "./changeAndReadinessEvidence2.js";
import { RECURSIVE_READ_CLOSURE_MAX_BRANCHES } from "./readinessFalsification2.js";
import { RECURSIVE_READ_CLOSURE_MAX_MERGED_BYTES } from "./readinessFalsification2.js";
import { admitReadOnlyNextCall } from "./unresolvedCalls.js";
import { canonicalClosureValue } from "./recursiveClosure.js";
import { classifySurface } from "../../../util/impact.js";
import { closureExecutedCallsByPack } from "./recursiveClosure.js";
import { closureExecutedCallsByToken } from "./recursiveClosure.js";
import { codeTaskPackSurfaces } from "../artifactSections.js";
import { countLines } from "../../../util/countLines.js";
import { elideDocComments } from "../../../util/formatCompress.js";
import { handleTable } from "../../../util/handles.js";
import { hasServedCode } from "./wiringEvidence2.js";
import { inferCallableSymbol } from "./readinessFalsification.js";
import { isImplementationPath } from "./changeAndReadinessEvidence2.js";
import { languageForPath } from "../../../util/languages.js";
import { normIdent } from "./createAndWiringEndpoints2.js";
import { probeFileText } from "./readinessFalsification.js";
import { relationCodeOnly } from "./wiringEvidence3.js";
import { repairedNextCallTerms } from "./epochEvidence2.js";
import { resolveReal } from "../../../util/safePath.js";
import { selectCallableClosureEvidence } from "./readinessFalsification.js";
import { selectQueryEvidence } from "../../../tools/queryEvidence.js";
import { shaOfText } from "../../../util/handles.js";
import { sliceLinesToText } from "../../../util/countLines.js";
import { tokenizeForEpoch } from "../../../state/session.js";
import { walkCodeFiles } from "../../../tools/walkRepo.js";

export let closureExecutedTokenCounter = 0;

/** The set this build already executed for `result`, minting one if needed. */
export function closureExecutedCallSet(result: object): Set<string> {
  const existing = closureExecutedCallSignatures(result);
  if (existing !== undefined) return existing;
  const set = new Set<string>();
  closureExecutedCallsByPack.set(result, set);
  const token = `tlc${(closureExecutedTokenCounter += 1)}:${shaOfText(String(Date.now()))}`;
  closureExecutedCallsByToken.set(token, set);
  while (closureExecutedCallsByToken.size > CLOSURE_EXECUTED_TOKENS_MAX) {
    const oldest = closureExecutedCallsByToken.keys().next();
    if (oldest.done === true) break;
    closureExecutedCallsByToken.delete(oldest.value);
  }
  try {
    Object.defineProperty(result, CLOSURE_EXECUTED_TOKEN_KEY, {
      value: token,
      enumerable: true, // MUST be enumerable — this is what survives {...result}.
      configurable: true,
      writable: true,
    });
  } catch {
    // A frozen pack keeps the WeakMap binding for THIS exact object.
  }
  return set;
}

/** The executed-call fingerprints of `result`, or `undefined` when none. */
export function closureExecutedCallSignatures(result: object): Set<string> | undefined {
  if (result === null || typeof result !== "object") return undefined;
  const token = (result as Record<symbol, unknown>)[CLOSURE_EXECUTED_TOKEN_KEY];
  if (typeof token === "string") {
    const viaToken = closureExecutedCallsByToken.get(token);
    if (viaToken !== undefined) return viaToken;
  }
  return closureExecutedCallsByPack.get(result);
}

/**
 * Record that the closure loop RAN `calls` for `result` — both the raw
 * candidate (the shape `result.next` still holds) and the admitted shape the
 * loop actually executed, because `admitReadOnlyNextCall` may rewrite the
 * arguments and only one of the two will match at contract-build time.
 */
export function noteClosureExecutedCalls(
  result: object,
  calls: readonly ({ readonly tool: string; readonly arguments: Readonly<Record<string, unknown>> } | undefined)[],
): void {
  if (result === null || typeof result !== "object") return;
  const set = closureExecutedCallSet(result);
  for (const call of calls) {
    if (call === undefined) continue;
    try {
      set.add(closureCallSignature(call as unknown as ContinuationCall));
    } catch {
      // A signature this build cannot compute simply does not suppress a next.
    }
  }
}

/**
 * True when the closure loop of THIS build already executed `call` itself.
 *
 * Structurally typed on purpose: the candidates this is asked about come from
 * two different `ContinuationCall` spellings (`util/continuation`'s and the
 * protocol `ToolCall`), and the fingerprint only ever reads `tool` +
 * `arguments`.
 */
export function closureAlreadyExecuted(
  result: object,
  call: { readonly tool: string; readonly arguments: Readonly<Record<string, unknown>> } | undefined,
  query: string,
): boolean {
  if (call === undefined) return false;
  const executed = closureExecutedCallSignatures(result);
  if (executed === undefined || executed.size === 0) return false;
  const raw = call as unknown as ContinuationCall;
  const shapes: ContinuationCall[] = [raw];
  try {
    const admitted = admitReadOnlyNextCall(raw, query);
    if (admitted !== undefined) shapes.push(admitted);
  } catch {
    // Admission is advisory here; the raw shape below still answers.
  }
  for (const shape of shapes) {
    try {
      if (executed.has(closureCallSignature(shape))) return true;
    } catch {
      // See noteClosureExecutedCalls.
    }
  }
  return false;
}

/** Test-only: forget every executed-call token (specs start from a clean slate). */
export function resetClosureExecutedCallsForTest(): void {
  closureExecutedCallsByToken.clear();
  closureExecutedTokenCounter = 0;
}

export function closureCallSignature(call: ContinuationCall): string {
  const args = call.arguments;
  const handleId = typeof args["handle"] === "string" ? args["handle"] : undefined;
  const handleSha = handleId ? handleTable.get(handleId)?.sha ?? "" : "";
  return `${call.tool}\u0000${JSON.stringify(canonicalClosureValue(args))}\u0000${handleSha}`;
}

export function closureSlice(
  content: string,
  requestedRange: string | undefined,
): { range: string; code: string } | undefined {
  const lines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  if (lines.length === 0) return undefined;
  // FIX-C1 (2026-09-27, eval-0927 P1): same bug class as
  // selectCallableClosureEvidence above -- `lines.length` over-counts by one
  // for a file ending in "\n". A bare `{handle}`/`{path}` continuation with
  // no per-target `range` (executeClosureRead's `target.range` is genuinely
  // `undefined` for a `paths[]` entry with no `range`, or a handle whose
  // stored entry carries none) used to default `end` to that inflated count
  // and report e.g. "1-17" for a 16-line whole-file closure read. Clamping
  // against `countLines(content)` instead, and building `code` with
  // `sliceLinesToText` (which reconstructs the same trailing-newline byte the
  // old inflated slice produced by accident), keeps served bytes identical.
  const totalLines = countLines(content);
  const match = requestedRange ? /^(\d+)-(\d+)$/.exec(requestedRange) : undefined;
  let start = match ? Math.max(1, Number(match[1])) : 1;
  let end = match ? Math.min(totalLines, Number(match[2])) : totalLines;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start > lines.length) return undefined;
  let code = sliceLinesToText(content, start, end);
  while (Buffer.byteLength(code, "utf8") > MAX_SURFACE_CODE_BYTES && end > start) {
    end -= 1;
    code = sliceLinesToText(content, start, end);
  }
  if (Buffer.byteLength(code, "utf8") > MAX_SURFACE_CODE_BYTES) {
    code = Buffer.from(code, "utf8").subarray(0, MAX_SURFACE_CODE_BYTES).toString("utf8");
  }
  return { range: `${start}-${end}`, code };
}

export function closureUnionRange(a: string, b: string): string | undefined {
  const ma = /^(\d+)-(\d+)$/.exec(a);
  const mb = /^(\d+)-(\d+)$/.exec(b);
  if (!ma || !mb) return undefined;
  const aStart = Number(ma[1]);
  const aEnd = Number(ma[2]);
  const bStart = Number(mb[1]);
  const bEnd = Number(mb[2]);
  if (aEnd + 1 < bStart || bEnd + 1 < aStart) return undefined;
  return `${Math.min(aStart, bStart)}-${Math.max(aEnd, bEnd)}`;
}

/**
 * D2 (FX-R3, 2026-09-04) — INTRA-PACK RANGE IDENTITY.
 *
 * The closure's merge/dedup checks compared `range` STRINGS, so a narrower
 * window of a path this pack already serves with a wider body read as a brand
 * new surface: the loop minted a second `required:true` row for bytes already
 * on the wire (observed live, smoke-r3 cell SF05 ... -r0: `drv_baro.h` served
 * `1-49` WITH a body, plus a second `1-23` row for the same file). These two
 * helpers answer the question the string compare could not — does this window
 * already sit inside (or across) a window this pack serves?
 *
 * File coordinates per ruling (t): the spans are the surface's own served
 * line range, never a wire display range.
 */
export function closureLineSpan(range: string | undefined): [number, number] | undefined {
  if (typeof range !== "string") return undefined;
  const match = /^(\d+)-(\d+)$/.exec(range.trim());
  if (match === null) return undefined;
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 1 || end < start) return undefined;
  return [start, end];
}

/**
 * Does an ALREADY-SERVED surface window subsume or overlap `candidate`?
 *
 * A served window with no parseable range is treated as covering the whole
 * file (fail-closed toward "already on the wire": the alternative is minting a
 * duplicate row for bytes the caller already has).
 */
export function closureServedWindowCovers(servedRange: string | undefined, candidateRange: string | undefined): boolean {
  const served = closureLineSpan(servedRange);
  if (served === undefined) return true;
  const candidate = closureLineSpan(candidateRange);
  if (candidate === undefined) return true;
  return served[0] <= candidate[1] && candidate[0] <= served[1];
}

export function closureCanMerge(result: TaskPackResult, extraCode: string): boolean {
  return Buffer.byteLength(JSON.stringify(result), "utf8") + Buffer.byteLength(extraCode, "utf8")
    <= RECURSIVE_READ_CLOSURE_MAX_MERGED_BYTES;
}

export function executeClosureRead(
  result: TaskPackResult,
  call: ContinuationCall,
  workspace: string,
): { evidence: number; handle?: string } {
  const args = call.arguments;
  const requestedRange = typeof args["range"] === "string" ? args["range"] : undefined;
  const targets: Array<{ path: string; range?: string; handle?: string }> = [];
  const pushHandle = (id: string): void => {
    const entry = handleTable.get(id);
    if (!entry?.path || resolveReal(entry.workspaceRoot) !== resolveReal(workspace)) return;
    targets.push({ path: entry.path, range: requestedRange ?? entry.range, handle: id });
  };
  if (typeof args["handle"] === "string") pushHandle(args["handle"]);
  if (Array.isArray(args["handles"])) {
    for (const id of args["handles"]) if (typeof id === "string") pushHandle(id);
  }
  if (typeof args["path"] === "string") {
    targets.push({ path: args["path"], range: requestedRange });
  }
  if (Array.isArray(args["paths"])) {
    for (const item of args["paths"]) {
      if (typeof item === "string") targets.push({ path: item });
      else if (item && typeof item === "object" && typeof (item as Record<string, unknown>)["path"] === "string") {
        const obj = item as Record<string, unknown>;
        targets.push({
          path: obj["path"] as string,
          range: typeof obj["range"] === "string" ? obj["range"] : undefined,
        });
      }
    }
  }

  let evidence = 0;
  let receiptHandle: string | undefined;
  for (const target of targets.slice(0, RECURSIVE_READ_CLOSURE_MAX_BRANCHES)) {
    const content = probeFileText(workspace, target.path);
    if (content === undefined) continue;
    const served = closureSlice(content, target.range);
    if (!served || !closureCanMerge(result, served.code)) continue;
    const packSurfaces = codeTaskPackSurfaces(result.surfaces);
    const existing = packSurfaces.find((surface) =>
      surface.handle === target.handle || (
        surface.path === target.path
        && surface.range === served.range
      )
    )
      // D2 (FX-R3): the same path, at a window this pack ALREADY SERVES bytes
      // for, is the same row — not a new one. Falling through to the `push`
      // below minted a second `required:true` surface for bytes already on the
      // wire. Resolving to that row instead means the branches below either
      // widen it (when the window is an advertised `remaining_ranges` entry)
      // or leave the pack exactly as it is.
      ?? packSurfaces.find((surface) =>
        surface.path === target.path
        && hasServedCode(surface)
        && closureServedWindowCovers(surface.range, served.range)
      );
    if (existing) {
      if (existing.code === undefined) {
        existing.code = elideDocComments(served.code, languageForPath(target.path));
        existing.range = served.range;
      } else if (target.range && existing.remaining_ranges?.includes(target.range)) {
        const union = closureUnionRange(existing.range, target.range);
        const merged = union ? closureSlice(content, union) : undefined;
        if (!merged || merged.range !== union || !closureCanMerge(result, merged.code)) continue;
        existing.range = merged.range;
        existing.code = elideDocComments(merged.code, languageForPath(target.path));
        existing.remaining_ranges = existing.remaining_ranges.filter((range) => range !== target.range);
        if (existing.remaining_ranges.length === 0) {
          delete existing.remaining_ranges;
          delete existing.content_completeness;
        }
        const refreshed = handleTable.upsert({
          kind: existing.symbol ? "symbol" : "range",
          path: existing.path,
          range: existing.range,
          ...(existing.symbol ? { symbol: existing.symbol } : {}),
          workspaceRoot: workspace,
          sha: shaOfText(merged.code),
        });
        existing.handle = refreshed.id;
        receiptHandle = refreshed.id;
      } else {
        continue;
      }
      receiptHandle ??= existing.handle;
    } else {
      const handle = handleTable.upsert({
        kind: "range",
        path: target.path,
        range: served.range,
        workspaceRoot: workspace,
        sha: shaOfText(served.code),
      });
      (result.surfaces as TaskPackResultSurface[]).push({
        role: classifySurface(target.path),
        handle: handle.id,
        path: target.path,
        range: served.range,
        required: true,
        why: "recursive-read-closure",
        code: elideDocComments(served.code, languageForPath(target.path)),
      });
      receiptHandle = handle.id;
    }
    evidence += 1;
  }
  return { evidence, ...(receiptHandle ? { handle: receiptHandle } : {}) };
}

export function executeClosureSearch(
  result: TaskPackResult,
  call: ContinuationCall,
  workspace: string,
  originalQuery: string,
  scopePaths?: readonly string[],
): number {
  const args = call.arguments;
  const seed = Array.isArray(args["queries"])
    ? args["queries"].filter((item): item is string => typeof item === "string").join(" ")
    : typeof args["query"] === "string"
      ? args["query"]
      : originalQuery;
  const terms = repairedNextCallTerms(seed);
  if (terms.length === 0) return 0;
  const wiringSemanticSearch = result.task_profile === "wiring";
  const wiringReferenceSearch = wiringSemanticSearch && args["action"] === "references";
  const evidenceQuery = wiringReferenceSearch ? originalQuery : seed;
  const contextTerms = wiringReferenceSearch
    ? tokenizeForEpoch(originalQuery)
        .filter((term) => term.length >= 4 && !NEXT_CALL_GENERIC_QUERY_TERMS.has(term))
        .slice(0, 32)
    : [];
  const compoundTerms = wiringReferenceSearch
    ? (() => {
        const words = tokenizeForEpoch(originalQuery).filter((term) => term.length >= 3);
        const compounds = new Set<string>();
        for (let index = 0; index + 1 < words.length; index++) {
          const left = words[index]!.toLowerCase().replace(/[-_]/g, "");
          const right = words[index + 1]!.toLowerCase().replace(/[-_]/g, "");
          compounds.add(left + right);
          compounds.add((left === "system" ? "sys" : left) + right);
        }
        return [...compounds].filter((term) => term.length >= 6).slice(0, 64);
      })()
    : [];
  const scopes = (typeof args["path"] === "string" ? [args["path"]] : scopePaths ?? [])
    .map((entry) => path.posix.normalize(entry.replace(/\\/g, "/")).replace(/^\.\//, ""))
    .filter((entry) => entry.length > 0);
  // Only rows whose bytes the caller will hold count as "already there": a
  // row that names a window WITHOUT its body (a filename-matched or
  // caller-named file joined codeless) is exactly what this read can serve —
  // see the bodyless branch in the admission loop below.
  const existingKeys = new Set(
    codeTaskPackSurfaces(result.surfaces)
      .filter((surface) => hasServedCode(surface) || surface.code_unchanged !== undefined)
      .map((surface) => `${surface.path}:${surface.range}`),
  );
  // D2 (FX-R3): the exact `path:range` key above cannot see a NARROWER window
  // of a path this pack already serves with a wider body — that is how a
  // second, duplicate row for already-shipped bytes got minted. Track the
  // served windows per path and treat any overlap as the same evidence.
  const servedWindowsByPath = new Map<string, string[]>();
  const noteServedWindow = (relPath: string, range: string | undefined): void => {
    const windows = servedWindowsByPath.get(relPath);
    if (windows === undefined) servedWindowsByPath.set(relPath, [range ?? ""]);
    else windows.push(range ?? "");
  };
  const alreadyServedWindow = (relPath: string, range: string): boolean =>
    (servedWindowsByPath.get(relPath) ?? []).some((served) =>
      closureServedWindowCovers(served === "" ? undefined : served, range));
  for (const surface of codeTaskPackSurfaces(result.surfaces)) {
    if (!hasServedCode(surface)) continue;
    noteServedWindow(surface.path, surface.range);
  }
  const ranked: Array<{
    path: string;
    range: string;
    line: number;
    code: string;
    score: number;
    symbol?: string;
  }> = [];

  const pathRankTerms = [...new Set([...terms, ...contextTerms])];
  const closureFiles = walkCodeFiles(workspace, {})
    .filter((file) =>
      scopes.length === 0
      || scopes.some((scope) =>
        file.relPath === scope || file.relPath.startsWith(`${scope.replace(/\/$/, "")}/`)
      )
    )
    .sort((a, b) => {
      const aPath = a.relPath.toLowerCase();
      const bPath = b.relPath.toLowerCase();
      const aHits = pathRankTerms.filter((term) => aPath.includes(term.toLowerCase())).length;
      const bHits = pathRankTerms.filter((term) => bPath.includes(term.toLowerCase())).length;
      return bHits - aHits || a.relPath.localeCompare(b.relPath);
    })
    .slice(0, READINESS_PROBE_MAX_FILES);

  for (const file of closureFiles) {
    const content = probeFileText(workspace, file.relPath);
    if (content === undefined) continue;
    // Wiring closure is proof construction, not a raw text search. Strip
    // comments before hit counting and evidence selection so prose-only
    // decoys cannot create semantic surfaces or consume the closure budget.
    const searchableContent = wiringSemanticSearch ? relationCodeOnly(content) : content;
    const lower = searchableContent.toLowerCase();
    const hitCount = terms.filter((term) => lower.includes(term.toLowerCase())).length;
    if (hitCount === 0) continue;
    const selected = wiringReferenceSearch
      ? selectCallableClosureEvidence(
          searchableContent,
          file.relPath,
          [...new Set([...terms, ...contextTerms])],
          contextTerms,
          compoundTerms,
        )
        ?? selectQueryEvidence(searchableContent, evidenceQuery, { path: file.relPath, windowLines: 18 })
      : selectQueryEvidence(searchableContent, evidenceQuery, { path: file.relPath, windowLines: 18 });
    let range: string;
    let code: string;
    let line: number;
    let score: number;
    if (selected) {
      ({ range, content: code, line, score } = selected);
    } else {
      const lines = searchableContent.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
      const index = lines.findIndex((candidate) =>
        terms.some((term) => candidate.toLowerCase().includes(term.toLowerCase()))
      );
      if (index < 0) continue;
      // FIX-C1 (2026-09-27, eval-0927 P1): same bug class as
      // selectCallableClosureEvidence/closureSlice above -- clamp against the
      // real logical line count, and build `code` with `sliceLinesToText` so
      // served bytes stay byte-identical while the reported `range` no
      // longer overstates by one for a window that reaches end-of-file.
      const totalLines = countLines(searchableContent);
      const start = Math.max(1, index - 5 + 1);
      const end = Math.min(totalLines, index + 5 + 1);
      range = `${start}-${end}`;
      code = sliceLinesToText(searchableContent, start, end);
      line = index + 1;
      score = hitCount;
    }
    if (existingKeys.has(`${file.relPath}:${range}`)) continue;
    // D2 (FX-R3): merged into the row already carrying these bytes.
    if (alreadyServedWindow(file.relPath, range)) continue;
    const contextHits = contextTerms.filter((term) => lower.includes(term.toLowerCase())).length;
    const basename = normIdent(path.basename(file.relPath, path.extname(file.relPath)));
    const endpointDefinitionPenalty = wiringReferenceSearch
      && terms.some((term) => basename === normIdent(term))
      ? 40
      : 0;
    const implementationScore = wiringReferenceSearch
      ? isImplementationPath(file.relPath) ? 8 : -8
      : 0;
    ranked.push({
      path: file.relPath,
      range,
      line,
      code,
      score: score + hitCount * 4 + contextHits * 3 + implementationScore - endpointDefinitionPenalty,
      symbol: inferCallableSymbol(content, line),
    });
  }

  ranked.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path) || a.line - b.line);
  let added = 0;
  for (const candidate of ranked) {
    if (added >= RECURSIVE_READ_CLOSURE_MAX_BRANCHES) break;
    // D2 (FX-R3): re-checked here too — an earlier candidate of this same pass
    // may have just served an overlapping window of the same file.
    if (alreadyServedWindow(candidate.path, candidate.range)) continue;
    const code = elideDocComments(candidate.code, languageForPath(candidate.path));
    if (!closureCanMerge(result, code)) break;
    // eval-0927 review (handsOnReport0141 r2f4): the pack already names this
    // exact window without its bytes — serve them on that row instead of
    // minting a duplicate. Before the N+1 range fixes this window read one
    // line past EOF ("1-13" for a 12-line file), never matched the codeless
    // "1-12" row, and reached the pack only by accident as a second row.
    const bodyless = codeTaskPackSurfaces(result.surfaces).find((surface) =>
      surface.path === candidate.path
      && surface.range === candidate.range
      && !hasServedCode(surface)
      && surface.code_unchanged === undefined);
    if (bodyless !== undefined) {
      bodyless.code = code;
      delete bodyless.content_completeness;
      delete bodyless.remaining_ranges;
      existingKeys.add(`${candidate.path}:${candidate.range}`);
      noteServedWindow(candidate.path, candidate.range);
      added += 1;
      continue;
    }
    const handle = handleTable.upsert({
      kind: "range",
      path: candidate.path,
      range: candidate.range,
      ...(candidate.symbol ? { symbol: candidate.symbol } : {}),
      workspaceRoot: workspace,
      sha: shaOfText(candidate.code),
    });
    (result.surfaces as TaskPackResultSurface[]).push({
      role: classifySurface(candidate.path),
      handle: handle.id,
      path: candidate.path,
      range: candidate.range,
      ...(candidate.symbol ? { symbol: candidate.symbol } : {}),
      required: true,
      why: "recursive-read-closure",
      code,
    });
    existingKeys.add(`${candidate.path}:${candidate.range}`);
    noteServedWindow(candidate.path, candidate.range);
    added += 1;
  }
  return added;
}
