// readinessFalsification — extracted implementation; imports point to the owning modules.
import * as fs from "fs";
import * as path from "path";
import type { EnumeratedQueryItem } from "./changeAndReadinessEvidence2.js";
import type { TaskPackSurface } from "../model.js";
import { ENUMERATED_ITEM_MAX_WORDS } from "./changeAndReadinessEvidence2.js";
import { ENUMERATED_ITEM_OBLIGATION_PREFIX } from "./changeAndReadinessEvidence2.js";
import { ENUMERATED_QUERY_MAX_FACETS } from "./changeAndReadinessEvidence2.js";
import { ENUMERATED_QUERY_MIN_FACETS } from "./changeAndReadinessEvidence2.js";
import { ENUMERATION_LEADING_KEYWORD_RE } from "./changeAndReadinessEvidence2.js";
import { ENUMERATION_LIST_MARKER_RE } from "./changeAndReadinessEvidence2.js";
import { ENUMERATION_SEPARATOR_RE } from "./changeAndReadinessEvidence2.js";
import { FileReadCache } from "./packBasics2.js";
import { READINESS_PROBE_MAX_BYTES } from "./changeAndReadinessEvidence2.js";
import { classifySurface } from "../../../util/impact.js";
import { countLines } from "../../../util/countLines.js";
import { directImportNeighbors } from "./contentSettlement3.js";
import { enumeratedItemFacetFromId } from "./changeAndReadinessEvidence2.js";
import { enumerationItemFacet } from "./changeAndReadinessEvidence2.js";
import { explicitCodeIdentifiers } from "./anchorFocus2.js";
import { hasIdentifierSegment } from "./literalAndConcernSeeds.js";
import { isSourceOnlyExcludedPath } from "../../../tools/walkRepo.js";
import { isTestConcernPath } from "./literalAndConcernSeeds.js";
import { maskCallArgumentPunctuation } from "../requestFacets.js";
import { maskCitationFormatFields } from "../../../util/citationFormat.js";
import { maskEvaluationInputRecords } from "../../../util/evaluationInputs.js";
import { queryTaskContract } from "../taskContractStore.js";
import { readCached } from "./packBasics2.js";
import { requiredQueryFacets } from "./changeAndReadinessEvidence2.js";
import { servedTextOrUndefined } from "../../../util/textDecode.js";
import { shaOfText } from "../../../util/handles.js";
import { sliceLinesToText } from "../../../util/countLines.js";
import { stripPathSpans } from "../../../util/queryShape.js";
import { tokenizeForEpoch } from "../../../state/session.js";

export function currentEnumeratedQueryItems(query: string): EnumeratedQueryItem[] {
  const cleaned = stripPathSpans("", maskCitationFormatFields(maskEvaluationInputRecords(query)));
  const split = new RegExp(`${ENUMERATION_LIST_MARKER_RE.source}|${ENUMERATION_SEPARATOR_RE.source}`, "giu");
  const segments: Array<{ text: string; start: number; end: number }> = [];
  let cursor = 0;
  // 2026-10-06 independent review (P2-1): a call's own argument commas
  // (`calculateTotal(4800, 0)`) are never item separators; cut points come
  // from the guarded copy, text from `cleaned`.
  for (const match of maskCallArgumentPunctuation(cleaned, ",;、，・").matchAll(split)) {
    const index = match.index ?? cursor;
    const raw = cleaned.slice(cursor, index);
    const leftTrim = raw.length - raw.trimStart().length;
    const right = raw.trimEnd();
    if (right.trim().length > 0) {
      segments.push({ text: right.trimStart(), start: cursor + leftTrim, end: cursor + right.length });
    }
    cursor = index + match[0].length;
  }
  const raw = cleaned.slice(cursor);
  const leftTrim = raw.length - raw.trimStart().length;
  const right = raw.trimEnd();
  if (right.trim().length > 0) {
    segments.push({ text: right.trimStart(), start: cursor + leftTrim, end: cursor + right.length });
  }
  if (segments.length < ENUMERATED_QUERY_MIN_FACETS) return [];

  const facetFor = (segment: { text: string }, leading: boolean): string | undefined => {
    let phrase = segment.text.trim();
    if (leading) {
      const including = [...phrase.matchAll(/\bincluding\b/giu)].at(-1);
      if (including?.index !== undefined) phrase = phrase.slice(including.index + including[0].length);
      phrase = phrase.split(/[。.!?:：]/u).at(-1) ?? phrase;
    }
    phrase = phrase.trim().replace(ENUMERATION_LEADING_KEYWORD_RE, "");
    phrase = phrase.replace(/\s+(?:を|の)?(?:どう|どの|含|説明|扱|教).*/u, "").trim();
    const words = phrase.split(/\s+/);
    return enumerationItemFacet(phrase)
      ?? (leading ? enumerationItemFacet(words.slice(-ENUMERATED_ITEM_MAX_WORDS).join(" "), "last") : undefined);
  };

  const trailing = segments.slice(1)
    .map((segment) => ({ segment, facet: facetFor(segment, false) }))
    .filter((entry): entry is { segment: { text: string; start: number; end: number }; facet: string } => entry.facet !== undefined);
  if (trailing.length < ENUMERATED_QUERY_MIN_FACETS - 1) return [];
  const leadFacet = facetFor(segments[0]!, true);
  const candidates = leadFacet === undefined ? trailing : [{ segment: segments[0]!, facet: leadFacet }, ...trailing];
  const owned = new Set([
    ...requiredQueryFacets(query),
    ...explicitCodeIdentifiers(query).map((identifier) => identifier.toLowerCase()),
  ]);
  const items: EnumeratedQueryItem[] = [];
  const seen = new Set<string>();
  for (const { segment, facet } of candidates) {
    if (owned.has(facet) || seen.has(facet)) continue;
    seen.add(facet);
    const spanHash = shaOfText(`${segment.start}:${segment.end}:${cleaned.slice(segment.start, segment.end)}`)
      .replace(/^sha256:/u, "")
      .slice(0, 12);
    items.push({
      facet,
      id: `${ENUMERATED_ITEM_OBLIGATION_PREFIX}${spanHash}:${facet}`,
      start: segment.start,
      end: segment.end,
    });
  }
  return items.length >= ENUMERATED_QUERY_MIN_FACETS ? items.slice(0, ENUMERATED_QUERY_MAX_FACETS) : [];
}

export function enumeratedQueryItemsForEpoch(
  query: string,
  workspace?: string,
  priorConcernTokens?: readonly string[],
): EnumeratedQueryItem[] {
  const items = currentEnumeratedQueryItems(query);
  if (workspace === undefined && priorConcernTokens === undefined) return items;
  const storedConcernTokens = priorConcernTokens ?? (workspace === undefined
    ? []
    : queryTaskContract(workspace, tokenizeForEpoch(query))?.concernTokens ?? []);
  const byId = new Map(items.map((item) => [item.id, item]));
  for (const id of storedConcernTokens) {
    const facet = enumeratedItemFacetFromId(id);
    if (facet === undefined || byId.has(id)) continue;
    byId.set(id, { facet, id, start: -1, end: -1 });
  }
  return [...byId.values()].slice(0, ENUMERATED_QUERY_MAX_FACETS);
}

export function enumeratedQueryObligationIds(query: string, workspace?: string): string[] {
  return enumeratedQueryItemsForEpoch(query, workspace).map((item) => item.id);
}

export function enumeratedQueryFacets(query: string): string[] {
  return currentEnumeratedQueryItems(query).map((item) => item.facet);
}

export function probeFileText(workspace: string, filePath: string): string | undefined {
  try {
    const rootReal = fs.realpathSync(workspace);
    const candidate = path.resolve(rootReal, filePath);
    const real = fs.realpathSync(candidate);
    const rel = path.relative(rootReal, real);
    if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return undefined;
    const stat = fs.statSync(real);
    if (!stat.isFile() || stat.size > READINESS_PROBE_MAX_BYTES) return undefined;
    // P3 (2026-08-27): not a raw utf8 read — undecodable content probes as
    // unavailable, same as any other probe failure here.
    //
    // AA1 (2026-09-14, review round 10): this is the FIFTH door, and finding 49
    // is its bill. `probeFileText` feeds the readiness-falsification-
    // counterexample admission (`why:"readiness-falsification-counterexample"`)
    // and `statedRelationToNamedPath`; the counterexample's windows are
    // embedded as `code` in a CERTIFIED pack, for a file the request never even
    // named. It used to read via `decodeTextBuffer`, whose NUL probe stops at
    // `UNDECODABLE_PROBE_BYTES`, so a workspace file whose NULs begin at byte
    // 4260 probed as perfectly good text and put 300 escaped NULs inside an
    // `act.answer`. One policy (`servedTextOrUndefined` -> `readServedText`):
    // `"stripped"` probes on its NUL-free text, `"undecodable"` probes as
    // unavailable — a candidate this server cannot read is not a competing
    // implementation it can testify about either.
    // served-bytes: readServedText
    return servedTextOrUndefined(real);
  } catch {
    return undefined;
  }
}

/**
 * FIX-ORIG (2026-09-27, orchestrator ruling): now returns the SERVED spans it
 * blanked, not just the blanked text. `.text` still feeds `selectQueryEvidence`
 * below (biasing window SELECTION away from already-known content stays a
 * legitimate, reviewed 2026-08-21 byte-saving heuristic); `.servedSpans` is
 * the new, honest way the counterexample admission narrows its FINAL emitted
 * `range`/`code` to the UNSERVED remainder instead of shipping blanked lines
 * inside a served window (no new marker vocabulary; see the admission loop).
 */
export function maskServedRanges(
  content: string,
  filePath: string,
  surfaces: readonly TaskPackSurface[],
): { text: string; servedSpans: Array<{ start: number; end: number }> } {
  const lines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const servedSpans: Array<{ start: number; end: number }> = [];
  for (const surface of surfaces) {
    if (surface.path !== filePath) continue;
    const match = /^(\d+)-(\d+)$/.exec(surface.range);
    if (!match) continue;
    const start = Math.max(1, Number(match[1]));
    const end = Math.min(lines.length, Number(match[2]));
    if (end >= start) servedSpans.push({ start, end });
    for (let line = start; line <= end; line++) lines[line - 1] = "";
  }
  return { text: lines.join("\n"), servedSpans };
}

/**
 * FIX-ORIG (2026-09-27, orchestrator ruling): `[windowStart,windowEnd]` minus
 * every span in `servedSpans` that overlaps it — the same gap-subtraction
 * shape `packServedSpans` already uses for the inverse question ("what of
 * this surface's OWN range did IT serve"), applied here to find what a
 * counterexample window has left to serve after the lines another surface in
 * this same response already covers. Order-preserving, left to right.
 */
export function unservedSubSpans(
  windowStart: number,
  windowEnd: number,
  servedSpans: ReadonlyArray<{ start: number; end: number }>,
): Array<{ start: number; end: number }> {
  const relevant = servedSpans
    .filter((s) => s.end >= windowStart && s.start <= windowEnd)
    .map((s) => ({ start: Math.max(s.start, windowStart), end: Math.min(s.end, windowEnd) }))
    .sort((a, b) => a.start - b.start);
  const out: Array<{ start: number; end: number }> = [];
  let cursor = windowStart;
  for (const span of relevant) {
    if (span.start > cursor) out.push({ start: cursor, end: span.start - 1 });
    cursor = Math.max(cursor, span.end + 1);
    if (cursor > windowEnd) break;
  }
  if (cursor <= windowEnd) out.push({ start: cursor, end: windowEnd });
  return out;
}

/** True when `lines[start-1..end-1]` (1-based, inclusive) has at least one
 *  non-whitespace-only line — an unserved span of pure blank lines proves
 *  nothing and must not be admitted as counterexample evidence. */
export function spanHasNonBlankLine(lines: readonly string[], start: number, end: number): boolean {
  for (let line = start; line <= end; line++) {
    if ((lines[line - 1] ?? "").trim().length > 0) return true;
  }
  return false;
}

/**
 * Index of the unserved sub-span a counterexample shows: the one containing
 * the probe's own matched line when it has real content, else the non-blank
 * sub-span nearest to that line (the earlier one on a tie); -1 when every
 * sub-span is blank. The matched line is the point of the evidence — taking
 * the first sub-span in file order served a file's import header and pushed
 * the matched declaration into `remaining` (2026-09-27 integration).
 */
export function nearestNonBlankSubSpanIndex(
  spans: ReadonlyArray<{ start: number; end: number }>,
  lines: readonly string[],
  matchedLine: number,
): number {
  let best = -1;
  let bestDistance = Number.POSITIVE_INFINITY;
  spans.forEach((span, index) => {
    if (!spanHasNonBlankLine(lines, span.start, span.end)) return;
    const distance = matchedLine < span.start ? span.start - matchedLine : matchedLine > span.end ? matchedLine - span.end : 0;
    if (distance < bestDistance) {
      best = index;
      bestDistance = distance;
    }
  });
  return best;
}

/**
 * `span` without its leading and trailing blank lines (a span holding at
 * least one non-blank line never becomes empty). A server-chosen range must
 * not end on a blank line: its body would then end in "\n", which a reader
 * that drops a trailing newline (Python's `splitlines()`, for one) counts as
 * one line short of the declared range.
 */
export function trimBlankEdgeLines(lines: readonly string[], span: { start: number; end: number }): { start: number; end: number } {
  let { start, end } = span;
  while (start < end && (lines[start - 1] ?? "").trim().length === 0) start += 1;
  while (end > start && (lines[end - 1] ?? "").trim().length === 0) end -= 1;
  return { start, end };
}

export function inferCallableSymbol(content: string, line: number): string | undefined {
  const lines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const start = Math.max(0, line - 14);
  const end = Math.min(lines.length, line + 3);
  let found: string | undefined;
  for (let index = start; index < end; index++) {
    const candidate = lines[index]!;
    // C/C++ projects commonly put the opening brace on the following line.
    // Join one lookahead line for signature recognition without widening the
    // evidence window or treating declarations ending in ';' as callables.
    const signature = `${candidate} ${lines[index + 1] ?? ""}`;
    const explicit = /\b(?:def|fn|func|function)\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(candidate)?.[1];
    const method = /\b([A-Za-z_][A-Za-z0-9_]*(?:::[A-Za-z_][A-Za-z0-9_]*)*)\s*\([^;{}]*\)\s*(?:const\s*)?\{/.exec(signature)?.[1];
    const name = explicit ?? method;
    if (name && !/^(?:if|for|while|switch|catch)$/.test(name)) found = name;
  }
  return found;
}

export function selectCallableClosureEvidence(
  content: string,
  pathName: string,
  endpointTerms: readonly string[],
  contextTerms: readonly string[],
  compoundTerms: readonly string[],
): { range: string; content: string; line: number; score: number } | undefined {
  const lines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  // FIX-C1 (2026-09-27, eval-0927 P1): `end` must clamp against the file's
  // REAL logical line count (countLines.ts), not `lines.length` -- a file
  // ending in "\n" (nearly every file) makes `split("\n")` count a phantom
  // trailing empty element, so clamping to `lines.length` reported "1-17" for
  // a 16-line file (also observed at 15->16 and 13->14 lines). `content`
  // below is still built from the SAME (inflated) `lines` array via
  // `sliceLinesToText`, which reconstructs the identical trailing-newline
  // byte the old `lines.slice(...).join("\n")` produced by accident when a
  // window reached end-of-file -- served BYTES are unchanged; only the
  // label was wrong.
  const totalLines = countLines(content);
  let best: { range: string; content: string; line: number; score: number } | undefined;
  for (let index = 0; index < lines.length; index++) {
    const rawLine = lines[index]!;
    const trimmedLine = rawLine.trim();
    if (
      trimmedLine.startsWith("//")
      || trimmedLine.startsWith("/*")
      || trimmedLine.startsWith("*")
      || trimmedLine.startsWith("#")
    ) continue;
    const lineText = rawLine.toLowerCase();
    // A consumer window must contain an endpoint or task facet inside a
    // callable body. Hits confined to includes/comments are supporting
    // context, not insertion-site proof.
    if (!endpointTerms.some((term) => lineText.includes(term.toLowerCase()))) continue;
    const line = index + 1;
    if (inferCallableSymbol(content, line) === undefined) continue;
    const start = Math.max(1, line - 18);
    const end = Math.min(totalLines, line + 18);
    const selected = sliceLinesToText(content, start, end);
    const scoringText = selected.split("\n")
      .map((candidate) => candidate.replace(/\/\/.*$/, ""))
      .filter((candidate) => {
        const trimmed = candidate.trim();
        return !trimmed.startsWith("/*")
          && !trimmed.startsWith("*")
          && !trimmed.startsWith("#");
      })
      .join("\n");
    const lower = scoringText.toLowerCase();
    const endpointHits = endpointTerms.filter((term) => lower.includes(term.toLowerCase())).length;
    const contextHits = contextTerms.filter((term) => lower.includes(term.toLowerCase())).length;
    const pathHits = contextTerms.filter((term) => pathName.toLowerCase().includes(term.toLowerCase())).length;
    const normalizedSelected = scoringText.toLowerCase().replace(/[-_]/g, "");
    const compoundHits = compoundTerms.filter((term) => normalizedSelected.includes(term)).length;
    const candidate = {
      range: `${start}-${end}`,
      content: selected,
      line,
      score: endpointHits * 8 + contextHits * 3 + pathHits * 2 + compoundHits * 20 + 8,
    };
    if (best === undefined || candidate.score > best.score) best = candidate;
  }
  return best;
}

/**
 * Drop comment-only lines — the same leading `//`, `/*`, `*`, `#` shapes
 * selectCallableClosureEvidence above already treats as non-anchoring —
 * before a file is scored as a readiness-falsification counterexample.
 *
 * Issue #4 (2026-08-21): a file's own PROSE mentioning an identifier (a
 * doc comment, a changelog-style "why" note, a residual-bug writeup) is not
 * competing CODE. Once isImplementationPath's `__tests__`/`.spec.`/`.test.`
 * gap was fixed so a spec file could no longer win this probe on a comment
 * match, the SAME raw comment-inclusive scan immediately promoted a
 * DIFFERENT file instead: this module's own `// R0 ...` note discussing a
 * past attempt to fix the exact "buildInitializeInstructions" bug this
 * negative probe was being run for, in prose, matched the query's own
 * explicit identifier and got force-added as a REQUIRED competing
 * implementation. This is a best-effort line-level filter (it does not
 * track string/template state), which is the safe direction here: it can
 * only make the probe LESS likely to admit a file, never invent a match
 * that is not really in the code.
 */
export function stripCommentOnlyLines(content: string): string {
  return content
    .split(/\r?\n/)
    .filter((rawLine) => {
      const trimmed = rawLine.trim();
      return !(
        trimmed.startsWith("//")
        || trimmed.startsWith("/*")
        || trimmed.startsWith("*")
        || trimmed.startsWith("#")
      );
    })
    .join("\n");
}

// ---------------------------------------------------------------------------
// TL142-05 (2026-09-13, v0.14.2 hands-on report): relation gating for extra
// evidence admitted alongside a request's own EXPLICITLY named path(s).
//
// Root cause this closes: neither the `answer-query-evidence-focus` fallback
// admission (rankAnswerEvidenceCandidates) nor the readiness-falsification
// counterexample admission (below) ever asked "is this related to what the
// caller actually named?" — a match was admitted purely because SOME line in
// it scored as lexically relevant (the former) or looked like a competing
// implementation (the latter), full stop. Reused, not reinvented: `imports`/
// `is imported by` go through `directImportNeighbors`, the SAME bounded
// import-specifier scan (no new tree-sitter parse) `augmentExplicitAnswer-
// ImportSurfaces` already uses — "apiGraph or import parse" per the report.
// `calls`/`is called by`/`config`/`test` are bounded lexical proxies in the
// same spirit (a shared top-level declared name used in a call position;
// `isTestConcernPath`/`classifySurface` already exist and are reused
// verbatim) — deliberately NOT a new path-detection regex.
// ---------------------------------------------------------------------------

/**
 * Whole top-level `export function|class|const|let|var|interface|type|enum
 * <Name>` identifiers, in `content`. A bounded regex scan (no new parse),
 * the same discipline `directImportNeighbors` already uses for import
 * specifiers — used below as the "shared declared name" proxy for a
 * calls/is-called-by/config/test relation.
 */
export function topLevelDeclaredNames(content: string): string[] {
  const names = new Set<string>();
  for (
    const m of content.matchAll(
      /^export\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][A-Za-z0-9_$]*)/gm,
    )
  ) {
    if (m[1]) names.add(m[1]);
  }
  return [...names];
}

/** True when `name` appears in `content` immediately followed by `(` (whitespace-tolerant), at an identifier boundary — a bounded "is this name CALLED here" proxy, no new parse. */
export function isCalledIn(content: string, name: string): boolean {
  let from = 0;
  while (from < content.length) {
    const index = content.indexOf(name, from);
    if (index < 0) return false;
    const before = content[index - 1];
    let after = index + name.length;
    while (content[after] === " " || content[after] === "\t") after++;
    if (content[after] === "(" && (before === undefined || !/[A-Za-z0-9_$]/.test(before))) return true;
    from = index + 1;
  }
  return false;
}

/**
 * TL142-05: the report's own four relation kinds — "import / is imported by
 * (apiGraph or import parse), calls / is called by, config declaring a
 * symbol used there, or a test referencing it". Returns a `why`-suffix
 * phrase naming the ONE named path `candidatePath` relates to (the FIRST
 * relation found, in that same order), or undefined when none of the four
 * hold — the caller drops the candidate in that case, never admits it
 * unconditionally.
 *
 * BLOCKER 3 (2026-09-13, review round): `calls`/`is-called-by`/`config`/
 * `test` are bounded LEXICAL proxies (a shared top-level declared name in a
 * call-shaped position, per topLevelDeclaredNames/isCalledIn's own doc
 * comments) — real signal for two genuinely different files, but a
 * dist/build MIRROR of `candidatePath`'s own source satisfies them
 * SYSTEMATICALLY, because the mirror simply re-declares the same names, and
 * a declaration site ("name(...) {") looks identical to a call to this
 * naive scanner. Live regression: a `dist/cache.ts` compiled copy of
 * `src/cache.ts` minted a false `is called by dist/cache.ts` purely from
 * shared declared names. Two guards, both required, applied to every one of
 * these four lexical checks (never to `imports`/`is imported by` just above,
 * which are exact import-specifier matches via directImportNeighbors and do
 * not share this weakness): (a) `named` must not be a file the DEFAULT walk
 * would exclude as build/generated output (isSourceOnlyExcludedPath) — a
 * compiled copy is never a meaningful caller or callee of its own source;
 * (b) only a name declared on ONE side counts as evidence of a real call —
 * a name BOTH files declare at top level is exactly the duplicate-
 * declaration signature, not "actually references the named file's exported
 * symbol".
 *
 * Exported (C17, chip wave, 2026-09-14) so guard (b) can be pinned with a
 * direct unit test — see readCodeTaskPack.spec.ts's "statedRelationToNamedPath
 * guard (b)" describe — without routing through the fuller answer-pack
 * pipeline both call sites below sit behind.
 */
export function statedRelationToNamedPath(
  candidatePath: string,
  candidateContent: string,
  namedPaths: readonly string[],
  workspace: string,
  cache: FileReadCache,
): string | undefined {
  const others = namedPaths.filter((p) => p !== candidatePath);
  if (others.length === 0) return undefined;
  const candidateImports = new Set(
    directImportNeighbors(workspace, [{ path: candidatePath, code: candidateContent } as TaskPackSurface], new Set()),
  );
  for (const named of others) {
    if (candidateImports.has(named)) return `imports ${named}`;
  }
  const candidateNames = topLevelDeclaredNames(candidateContent);
  const candidateIsTest = isTestConcernPath(candidatePath);
  const candidateIsConfig = classifySurface(candidatePath) === "config";
  for (const named of others) {
    const namedContent = readCached(workspace, named, cache);
    if (namedContent === undefined) continue;
    const namedImports = directImportNeighbors(
      workspace, [{ path: named, code: namedContent } as TaskPackSurface], new Set(),
    );
    if (namedImports.includes(candidatePath)) return `is imported by ${named}`;
    // BLOCKER 3, guard (a): everything below this line is a lexical proxy —
    // never credit one to a compiled/generated mirror of the candidate.
    if (isSourceOnlyExcludedPath(named)) continue;
    const namedNames = topLevelDeclaredNames(namedContent);
    // BLOCKER 3, guard (b): exclude names BOTH files declare at top level —
    // that overlap is the duplicate-declaration signature the naive
    // "name(" scan cannot otherwise tell apart from a real call.
    if (namedNames.some((name) => !candidateNames.includes(name) && isCalledIn(candidateContent, name))) {
      return `calls ${named}`;
    }
    if (candidateNames.some((name) => !namedNames.includes(name) && isCalledIn(namedContent, name))) {
      return `is called by ${named}`;
    }
    if (
      candidateIsConfig
      && namedNames.some((name) => !candidateNames.includes(name) && hasIdentifierSegment(candidateContent, name))
    ) {
      return `config declares a symbol ${named} uses`;
    }
    if (
      candidateIsTest
      && (
        hasIdentifierSegment(candidateContent, path.basename(named, path.extname(named)))
        || namedNames.some((name) => !candidateNames.includes(name) && hasIdentifierSegment(candidateContent, name))
      )
    ) {
      return `test references ${named}`;
    }
  }
  return undefined;
}

/**
 * TL142-05 pathless-variant relevance: a counterexample WINDOW that is
 * markup/CSS template content, not implementation code, never counts as
 * competing-implementation evidence — the report's own diagnosticsPanel.ts
 * CSS-block false positive ("反証チェックだから常に必要とは考えにくい"). A
 * bounded tag/rule-shape density heuristic, no new parse: `text` here is
 * already the SERVED, byte-capped window, not the whole file, so this stays
 * cheap regardless of file size.
 */
export function looksLikeMarkupOrCssWindow(text: string): boolean {
  if (/<\s*(?:html|body|head|div|span|style|script|button|table|tr|td|h[1-6])\b/i.test(text)) return true;
  const cssShapedLines = text.split(/\r?\n/).filter((line) =>
    /^\s*[a-zA-Z.#][\w.#-]*\s*\{?\s*$/.test(line) || /^\s*[a-z-]+\s*:\s*[^;{}]+;\s*$/.test(line)
  ).length;
  return cssShapedLines >= 3;
}
