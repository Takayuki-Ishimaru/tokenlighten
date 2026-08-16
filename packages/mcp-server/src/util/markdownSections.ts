export interface MarkdownHeading {
  level: number;
  text: string;
  /** 1-based line containing the visible heading text. */
  line: number;
  /** Inclusive end of this heading's section. */
  endLine: number;
  /** Hierarchical heading path, e.g. "Guide > Linux > Install". */
  path: string;
  style: "atx" | "setext";
}

export interface MarkdownSectionSelection {
  matches: MarkdownHeading[];
  missing: string[];
  ambiguous: Array<{ query: string; candidates: MarkdownHeading[] }>;
}

export function isMarkdownPath(filePath: string): boolean {
  return /\.(?:md|markdown)$/i.test(filePath);
}

function sourceLines(text: string): string[] {
  const lines = text.split(/\r\n|\r|\n/);
  if (lines.length > 1 && lines.at(-1) === "") lines.pop();
  return lines;
}

function atxHeading(line: string): { level: number; text: string } | undefined {
  const match = /^ {0,3}(#{1,6})(?:[ \t]+(.*)|[ \t]*)$/.exec(line);
  if (!match) return undefined;
  const text = (match[2] ?? "")
    .replace(/[ \t]+#+[ \t]*$/, "")
    .trim();
  if (!text) return undefined;
  return { level: match[1]!.length, text };
}

function setextLevel(line: string): number | undefined {
  const match = /^ {0,3}(=+|-+)[ \t]*$/.exec(line);
  if (!match) return undefined;
  return match[1]![0] === "=" ? 1 : 2;
}

function canBeSetextText(line: string): boolean {
  if (!/^ {0,3}\S.*$/.test(line) || /^ {0,3}(?:>|[-+*][ \t]+|\d+[.)][ \t]+)/.test(line)) {
    return false;
  }
  return atxHeading(line) === undefined;
}

/**
 * Parse useful Markdown sections without treating YAML frontmatter or
 * fenced-code examples as document structure. Supports ATX and Setext
 * headings and computes the full same-or-higher-level section range for
 * handle-based reads and edits.
 */
export function parseMarkdownHeadings(text: string): MarkdownHeading[] {
  const lines = sourceLines(text);
  const raw: Array<Omit<MarkdownHeading, "endLine" | "path">> = [];
  let fenceChar: string | undefined;
  let fenceLength = 0;
  let frontmatterEnd = -1;

  if (/^---[ \t]*$/.test(lines[0] ?? "")) {
    for (let index = 1; index < lines.length; index++) {
      if (/^(?:---|\.\.\.)[ \t]*$/.test(lines[index]!)) {
        frontmatterEnd = index;
        break;
      }
    }
  }

  for (let index = 0; index < lines.length; index++) {
    if (index <= frontmatterEnd) continue;
    const line = lines[index]!;
    if (fenceChar) {
      const close = new RegExp("^ {0,3}" + fenceChar.replace(/[.*+?^$\x7b\x7d()|[\]\\]/g, "\\$&") + "{" + fenceLength + ",}[ \\t]*$");
      if (close.test(line)) {
        fenceChar = undefined;
        fenceLength = 0;
      }
      continue;
    }

    const opener = /^ {0,3}((?:\x60){3,}|~{3,}).*$/.exec(line);
    if (opener) {
      fenceChar = opener[1]![0]!;
      fenceLength = opener[1]!.length;
      continue;
    }

    const atx = atxHeading(line);
    if (atx) {
      raw.push({ ...atx, line: index + 1, style: "atx" });
      continue;
    }

    const next = lines[index + 1];
    const level = next === undefined ? undefined : setextLevel(next);
    if (level !== undefined && canBeSetextText(line)) {
      raw.push({ level, text: line.trim(), line: index + 1, style: "setext" });
      index += 1;
    }
  }

  const stack: Array<{ level: number; text: string }> = [];
  const headings: MarkdownHeading[] = raw.map((heading) => {
    while (stack.length > 0 && stack.at(-1)!.level >= heading.level) stack.pop();
    const path = [...stack.map((parent) => parent.text), heading.text].join(" > ");
    stack.push({ level: heading.level, text: heading.text });
    return { ...heading, path, endLine: lines.length };
  });

  for (let index = 0; index < headings.length; index++) {
    const heading = headings[index]!;
    for (let next = index + 1; next < headings.length; next++) {
      const candidate = headings[next]!;
      if (candidate.level <= heading.level) {
        heading.endLine = candidate.line - 1;
        break;
      }
    }
  }
  return headings;
}

export function markdownSectionAtLine(
  headings: readonly MarkdownHeading[],
  line: number,
): MarkdownHeading | undefined {
  let best: MarkdownHeading | undefined;
  for (const heading of headings) {
    if (heading.line > line) break;
    if (line <= heading.endLine) best = heading;
  }
  return best;
}

function normalizeLabel(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\x60*_~\[\](){}<>]+/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function normalizePath(value: string): string {
  return value.split(">").map(normalizeLabel).filter(Boolean).join(">");
}

export function selectMarkdownSections(
  headings: readonly MarkdownHeading[],
  queries: readonly string[],
): MarkdownSectionSelection {
  const matches: MarkdownHeading[] = [];
  const missing: string[] = [];
  const ambiguous: Array<{ query: string; candidates: MarkdownHeading[] }> = [];
  const seen = new Set<number>();

  for (const original of queries) {
    const query = original.trim();
    if (!query) continue;
    const pathQuery = query.includes(">");
    const normalized = pathQuery ? normalizePath(query) : normalizeLabel(query);
    if (!normalized) continue;

    let candidates = headings.filter((heading) =>
      pathQuery
        ? normalizePath(heading.path) === normalized
        : normalizeLabel(heading.text) === normalized,
    );
    // R1 doc-navigation (2026-07-25 live forensics): a solver asks for the
    // section it can NAME ("Telemetry", "10.3"), never the exact heading
    // string. Exact-normalized equality alone missed both, and the fuzzy
    // scorer below scores a short query against a long heading far under its
    // 0.72 floor ("telemetry" vs "10.2 telemetry dialect (big file pair)" =
    // 0.35), so every such call fell through to `missing` and the solver
    // escaped to native grep/sed. Numbering-token and substring matching run
    // BETWEEN exact and fuzzy: both are strictly more precise than fuzzy
    // token overlap, and either can still hand >1 candidate to the ambiguity
    // path below rather than guessing.
    if (candidates.length === 0 && !pathQuery) {
      candidates = matchNumberedHeadings(headings, query);
    }
    if (candidates.length === 0 && !pathQuery) {
      candidates = matchSubstringHeadings(headings, normalized);
    }
    if (candidates.length === 0) {
      const queryDepth = pathQuery ? query.split(">").length : 1;
      const scored = headings
        .filter((heading) => !pathQuery || heading.path.split(">").length === queryDepth)
        .map((heading) => {
          const target = pathQuery ? normalizePath(heading.path) : normalizeLabel(heading.text);
          return { heading, score: fuzzyHeadingScore(normalized, target) };
        })
        .filter(({ score }) => score >= 0.72)
        .sort((a, b) => b.score - a.score || a.heading.line - b.heading.line);
      if (scored.length > 0) {
        const best = scored[0]!.score;
        candidates = scored.filter(({ score }) => Math.abs(score - best) < 0.001).map(({ heading }) => heading);
      }
    }

    if (candidates.length === 1) {
      const match = candidates[0]!;
      if (!seen.has(match.line)) {
        seen.add(match.line);
        matches.push(match);
      }
    } else if (candidates.length === 0) {
      missing.push(query);
    } else {
      ambiguous.push({ query, candidates });
    }
  }

  return { matches, missing, ambiguous };
}

/**
 * Lexical closeness of two normalized heading-ish strings: containment ratio
 * when one contains the other, else Jaccard token overlap. 0..1.
 *
 * Exported for the P1 evidence resolver (D7 normative.prose), which needs the
 * RAW score plus its own threshold. It deliberately does NOT go through
 * similarHeadingTexts: that helper is documented as never-empty (it falls back
 * to leading top-level headings so a human hint is always actionable), and
 * accepting that fallback would manufacture irrelevant "normative evidence" on
 * every pack.
 */
export function fuzzyHeadingScore(query: string, target: string): number {
  if (query === target) return 1;
  if (target.includes(query) || query.includes(target)) {
    return Math.min(query.length, target.length) / Math.max(query.length, target.length);
  }
  const q = new Set(query.split(/\s+/).filter(Boolean));
  const t = new Set(target.split(/\s+/).filter(Boolean));
  const intersection = [...q].filter((token) => t.has(token)).length;
  const union = new Set([...q, ...t]).size;
  return union === 0 ? 0 : intersection / union;
}

export function markdownOutline(
  headings: readonly MarkdownHeading[],
  cap = 30,
  textCap = 70,
): string[] {
  return headings.slice(0, cap).map((heading) => {
    const indent = "  ".repeat(Math.max(0, heading.level - 1));
    return "L" + heading.line + ": " + indent + heading.text.slice(0, textCap);
  });
}

// ---------------------------------------------------------------------------
// Heading index served BESIDE a partial markdown surface (R1, 2026-07-25).
//
// A slice/section/capped serve shows the solver one window of a long doc and
// says nothing about the rest, so navigating meant guessing line numbers —
// live, solvers escaped to `grep -n section | head` + `sed -n 'A,Bp'` (13
// native calls / 35KB on one 1500-line CONTRACT.md). The index is the cheap
// map that makes `sections:[...]` usable: heading text (what the solver can
// name) plus the section's own line span (what mode=slice needs).
// ---------------------------------------------------------------------------

/** One entry of the heading index: what to ask for, and where it lives. */
export interface MarkdownHeadingIndexEntry {
  level: number;
  text: string;
  /** "A-B": the heading line through the line before the next same-or-higher heading. */
  range: string;
}

export interface MarkdownHeadingIndex {
  headings: MarkdownHeadingIndexEntry[];
  /** Total headings parsed (present whether or not the index truncated). */
  total: number;
  truncated: boolean;
  /** Present only when entries were dropped — never a silent truncation. */
  note?: string;
}

/** Longest heading text kept in an index entry (byte discipline). */
const HEADING_INDEX_TEXT_CAP = 80;

/** Shared instruction text: how to turn a heading name into a slice. */
export const MARKDOWN_SECTIONS_HINT =
  'pass sections:["<heading text>"] (heading name, numbering token like "10.3", or substring) to slice this doc by section';

function headingIndexEntry(heading: MarkdownHeading): MarkdownHeadingIndexEntry {
  return {
    level: heading.level,
    text: heading.text.slice(0, HEADING_INDEX_TEXT_CAP),
    range: String(heading.line) + "-" + String(heading.endLine),
  };
}

/** Serialized size of `entries` as a JSON array, mirroring server.ts capEnvelopeArray. */
function indexBytes(entries: readonly MarkdownHeadingIndexEntry[]): number {
  return Buffer.byteLength(JSON.stringify(entries), "utf8");
}

/**
 * Build a capped heading index. Under both caps every heading rides along in
 * document order; over them, entries are kept by priority — headings whose
 * section intersects the SERVED window first, then the document's own
 * top-level headings, then deeper ones — and the kept set is re-sorted into
 * document order with an explicit truncation note.
 */
export function buildMarkdownHeadingIndex(
  headings: readonly MarkdownHeading[],
  opts: { maxEntries: number; maxBytes: number; focus?: { start: number; end: number } },
): MarkdownHeadingIndex {
  const total = headings.length;
  if (total === 0) return { headings: [], total: 0, truncated: false };

  const all = headings.map(headingIndexEntry);
  if (all.length <= opts.maxEntries && indexBytes(all) <= opts.maxBytes) {
    return { headings: all, total, truncated: false };
  }

  const minLevel = headings.reduce((low, heading) => Math.min(low, heading.level), 6);
  const focus = opts.focus;
  const ranked = headings.map((heading, index) => {
    const intersectsFocus = focus !== undefined
      && heading.line <= focus.end
      && heading.endLine >= focus.start;
    const rank = intersectsFocus ? 0 : heading.level === minLevel ? 1 : heading.level === minLevel + 1 ? 2 : 3;
    // Within a rank, nearest-to-the-served-window first: a solver reading
    // lines 3000-3040 of a 6000-line doc is asking "what is around me", so a
    // truncated index that spent its whole budget on the document's first 40
    // sections would answer a question nobody asked.
    const distance = focus === undefined
      ? 0
      : Math.min(Math.abs(heading.line - focus.start), Math.abs(heading.line - focus.end));
    return { index, rank, distance, entry: all[index]! };
  });
  ranked.sort((a, b) => a.rank - b.rank || a.distance - b.distance || a.index - b.index);

  const kept: Array<{ index: number; entry: MarkdownHeadingIndexEntry }> = [];
  let bytes = 2; // "[]"
  for (const candidate of ranked) {
    if (kept.length >= opts.maxEntries) break;
    const entryBytes = Buffer.byteLength(JSON.stringify(candidate.entry), "utf8") + (kept.length > 0 ? 1 : 0);
    if (bytes + entryBytes > opts.maxBytes) break;
    bytes += entryBytes;
    kept.push({ index: candidate.index, entry: candidate.entry });
  }
  kept.sort((a, b) => a.index - b.index);

  return {
    headings: kept.map((k) => k.entry),
    total,
    truncated: true,
    note: `heading index truncated to fit the response cap: ${kept.length} of ${total} shown (served-section + top-level headings kept)`,
  };
}

/**
 * C1 (2026-08-09): rank of an ALREADY-BUILT index entry, reconstructed from the
 * entry itself so a post-hoc shrink drops what buildMarkdownHeadingIndex would
 * have admitted last, not what happens to sit last in the DOCUMENT.
 *
 * The builder emits `kept` in document order (deliberately: an index reads as a
 * table of contents), which erased the rank it selected by. The follow-up
 * shrink then did `headings.pop()` — dropping the last-in-document entry first.
 * Measured on the T05c CONTRACT.md pack: "7.6 `<control/mixer.hpp>`" sits at
 * line 1018 of 1514 (the last third), so the ONE entry the task needed died
 * before the §1-§3 layout entries nobody asked for. Same rank formula as the
 * builder: focus-intersecting first, then top level, then the level below it.
 */
function heldEntryRank(
  entry: MarkdownHeadingIndexEntry,
  minLevel: number,
  focus?: { start: number; end: number },
): { rank: number; distance: number } {
  const m = /^(\d+)\s*-\s*(\d+)$/.exec(entry.range);
  const start = m ? Number(m[1]) : Number(entry.range);
  const end = m ? Number(m[2]) : start;
  const intersectsFocus = focus !== undefined
    && Number.isFinite(start) && Number.isFinite(end)
    && start <= focus.end && end >= focus.start;
  const rank = intersectsFocus
    ? 0
    : entry.level === minLevel ? 1 : entry.level === minLevel + 1 ? 2 : 3;
  const distance = focus === undefined || !Number.isFinite(start)
    ? 0
    : Math.min(Math.abs(start - focus.start), Math.abs(start - focus.end));
  return { rank, distance };
}

/**
 * Remove the single LOWEST-RANKED entry of a built index, in place, and return
 * it. Worst = highest rank, then farthest from focus, then latest in document —
 * the exact inverse of the builder's admission order, so repeated calls unwind
 * the index in reverse-preference order and the focus entry is the last to go.
 * Returns undefined for an empty index.
 */
export function dropLowestRankedHeadingIndexEntry(
  entries: MarkdownHeadingIndexEntry[],
  focus?: { start: number; end: number },
): MarkdownHeadingIndexEntry | undefined {
  if (entries.length === 0) return undefined;
  const minLevel = entries.reduce((low, entry) => Math.min(low, entry.level), 6);
  let worstIndex = 0;
  let worst = heldEntryRank(entries[0]!, minLevel, focus);
  for (let i = 1; i < entries.length; i++) {
    const candidate = heldEntryRank(entries[i]!, minLevel, focus);
    if (
      candidate.rank > worst.rank
      || (candidate.rank === worst.rank && candidate.distance > worst.distance)
      || (candidate.rank === worst.rank && candidate.distance === worst.distance)
    ) {
      // The final clause makes a tie resolve to the LATER entry (document
      // order), matching the builder's `a.index - b.index` tie-break.
      worstIndex = i;
      worst = candidate;
    }
  }
  return entries.splice(worstIndex, 1)[0];
}

/**
 * The heading texts most lexically similar to `query` — the recovery list a
 * doc symbol-miss turns into a concrete `sections=[...]` next call. Falls
 * back to the document's leading top-level headings when nothing scores, so
 * the hint is always actionable instead of an empty gesture.
 */
export function similarHeadingTexts(
  headings: readonly MarkdownHeading[],
  query: string,
  cap = 3,
): string[] {
  if (headings.length === 0) return [];
  const normalized = normalizeLabel(query);
  const scored = headings
    .map((heading, index) => {
      const target = normalizeLabel(heading.text);
      const substring = normalized.length >= 3 && target.includes(normalized) ? 0.5 : 0;
      return { index, text: heading.text.slice(0, HEADING_INDEX_TEXT_CAP), score: fuzzyHeadingScore(normalized, target) + substring };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, cap)
    .map((entry) => entry.text);
  if (scored.length > 0) return [...new Set(scored)];

  const minLevel = headings.reduce((low, heading) => Math.min(low, heading.level), 6);
  return [...new Set(
    headings
      .filter((heading) => heading.level <= minLevel + 1)
      .slice(0, cap)
      .map((heading) => heading.text.slice(0, HEADING_INDEX_TEXT_CAP)),
  )];
}

/** Leading numbering token of a heading, e.g. "10.3" for "## 10.3 Telemetry". */
function headingNumberToken(text: string): string | undefined {
  return /^\s*(\d+(?:\.\d+)*)[.)]?(?:\s|$)/.exec(text)?.[1];
}

/** Headings whose own leading numbering token equals a pure-numbering query. */
function matchNumberedHeadings(
  headings: readonly MarkdownHeading[],
  query: string,
): MarkdownHeading[] {
  const token = /^\s*(\d+(?:\.\d+)*)[.)]?\s*$/.exec(query)?.[1];
  if (token === undefined) return [];
  return headings.filter((heading) => headingNumberToken(heading.text) === token);
}

/**
 * Case-insensitive substring match over heading text. A query matching
 * several headings stays AMBIGUOUS (the caller lists candidates) unless
 * exactly one heading STARTS with it — "Telemetry" then resolves to
 * "Telemetry NET_STATUS fields" rather than refusing because an unrelated
 * "10.2 telemetry dialect" also contains the word.
 */
function matchSubstringHeadings(
  headings: readonly MarkdownHeading[],
  normalizedQuery: string,
): MarkdownHeading[] {
  if (normalizedQuery.length < 3) return [];
  const contains = headings.filter((heading) => normalizeLabel(heading.text).includes(normalizedQuery));
  if (contains.length <= 1) return contains;
  const prefixed = contains.filter((heading) => normalizeLabel(heading.text).startsWith(normalizedQuery));
  return prefixed.length === 1 ? prefixed : contains;
}
