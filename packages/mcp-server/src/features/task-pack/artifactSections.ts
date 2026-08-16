import type {
  ArtifactTaskPackSection,
  ArtifactTaskPackSurface,
  TaskPackResultSurface,
  TaskPackSurface,
} from "./model.js";

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

/** Keep a sheet section's advertised A1 range honest after row/column fitting. */
function actualSheetRange(range: string, rowCount: number, columnCount: number): string {
  const match = range.match(/^([A-Z]+)(\d+):([A-Z]+)(\d+)$/i);
  if (match === null) return range;
  const startCol = match[1]!.toUpperCase();
  const startRow = Number(match[2]);
  const endCol = (n: number): string => {
    let out = "";    for (let value = Math.max(1, n); value > 0; value = Math.floor((value - 1) / 26)) {
      out = String.fromCharCode(65 + ((value - 1) % 26)) + out;
    }
    return out;
  };
  // A zero-cell fit is a deferred section, not a one-cell section: A1:A1
  // would claim content that is absent from `rows`/`columns`. The caller keeps
  // `remaining` and emits the executable artifact continuation for this case.
  if (rowCount <= 0 || columnCount <= 0) return "";
  const startColNumber = [...startCol].reduce((total, char) => total * 26 + char.charCodeAt(0) - 64, 0);
  // `startRow` is the HEADER row (xlsxTable's range convention: header at
  // `startRow`, data from `startRow + 1`, `rows` excludes the header), so an
  // embed of `rowCount` data rows spans through `startRow + rowCount` — not
  // `+ rowCount - 1`, which under-claimed the span by the header row.
  return `${startCol}${startRow}:${endCol(startColNumber + columnCount - 1)}${startRow + rowCount}`;
}

function honestSheetSection(section: Extract<ArtifactTaskPackSection, { sheet: string }>, rowCount = section.rows.length, columnCount = section.columns.length): Extract<ArtifactTaskPackSection, { sheet: string }> {
  return { ...section, range: actualSheetRange(section.range, rowCount, columnCount) };
}

/**
 * Stable per-entry ids of an extraction, in extraction order: docx headings,
 * pptx slide headings, "page-N" for pdf, and the single logical table name for
 * a sheet-shaped (xlsx/csv) section. Used to name the entries a bounded inline
 * did NOT serve (ArtifactTaskPackSectionEntry.remaining_sections).
 */
export function artifactSectionEntryIds(section: ArtifactTaskPackSection): string[] {
  if ("sheet" in section) return [section.sheet];
  if (section.kind === "docx") return section.sections.map((item) => item.heading);
  if (section.kind === "pptx") return section.slides.map((item) => item.heading);
  return section.pages.map((item) => `page-${item.page}`);
}

/** Largest `n` in [0, hi] for which `fits(n)` holds; assumes `fits` is monotone. */
function largestFitting(hi: number, fits: (n: number) => boolean): number {
  let low = 0;
  let high = hi;
  let best = 0;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (fits(mid)) {
      best = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return best;
}

export interface ArtifactSectionBudgetFit {
  section: ArtifactTaskPackSection;
  /** True when entries, rows, columns, or text were cut to reach the cap. */
  partial: boolean;
  /** Ids of the extraction entries this fit does NOT carry. */
  remaining: string[];
}

/**
 * A1 — fit ONE artifact extraction into `capBytes` by serving a PREFIX of it.
 *
 * Distinct from artifactSectionCandidates(), which offers a fixed ladder of
 * whole-section size variants for the pack-cap search: this one answers "how
 * much of this extraction fits in exactly this many bytes", keeping leading
 * entries INTACT (a caller auditing a deck needs slide 1 whole, not five slides
 * clipped to 750 chars each) and naming what was left out. The first entry
 * always survives — its text is truncated if it alone exceeds the cap — so a
 * caller-named artifact never degrades back to the content-free stub this
 * feature exists to eliminate.
 */
export function fitArtifactSectionToBytes(
  section: ArtifactTaskPackSection,
  capBytes: number,
): ArtifactSectionBudgetFit {
  if (jsonBytes(section) <= capBytes) {
    // Already inside the budget. `truncated` may still be set by the extractor's
    // own char cap, which is partialness the caller must see either way.
    return { section, partial: section.truncated === true, remaining: [] };
  }

  if ("sheet" in section) {
    const build = (rowCount: number, colCount: number): ArtifactTaskPackSection => ({
      sheet: section.sheet,
      range: actualSheetRange(section.range, rowCount, colCount),
      columns: section.columns.slice(0, colCount),
      rows: section.rows.slice(0, rowCount).map((row) => row.slice(0, colCount)),
      truncated: true,
      ...(section.visuals ? { visuals: section.visuals } : {}),
    });
    let colCount = section.columns.length;
    let rowCount = largestFitting(section.rows.length, (n) => jsonBytes(build(n, colCount)) <= capBytes);
    if (rowCount === 0 && section.rows.length > 0) {
      // Not even one full-width row fits — narrow the columns instead of
      // serving a header-only table.
      colCount = largestFitting(section.columns.length, (c) => jsonBytes(build(1, c)) <= capBytes);
      rowCount = colCount > 0 ? 1 : 0;
    }
    return {
      section: build(rowCount, colCount),
      partial: true,
      remaining: rowCount < section.rows.length
        ? [`rows ${rowCount + 1}-${section.rows.length}`]
        : [],
    };
  }

  const ids = artifactSectionEntryIds(section);
  // One shared prefix-fit over the three text-entry shapes: `pick` rebuilds the
  // section from a prefix (optionally clipping the LAST kept entry's text), so
  // the greedy loop below is written once instead of three times.
  const pick = (count: number, clipLast?: number): ArtifactTaskPackSection => {
    if (section.kind === "docx") {
      const kept = section.sections.slice(0, count);
      return {
        kind: "docx",
        sections: kept.map((item, index) =>
          clipLast !== undefined && index === kept.length - 1
            ? { ...item, text: item.text.slice(0, clipLast) }
            : item
        ),
        truncated: true,
        ...(section.visuals ? { visuals: section.visuals } : {}),
      };
    }
    if (section.kind === "pptx") {
      const kept = section.slides.slice(0, count);
      return {
        kind: "pptx",
        slides: kept.map((item, index) =>
          clipLast !== undefined && index === kept.length - 1
            ? { ...item, text: item.text.slice(0, clipLast) }
            : item
        ),
        truncated: true,
        ...(section.visuals ? { visuals: section.visuals } : {}),
      };
    }
    const kept = section.pages.slice(0, count);
    return {
      kind: "pdf",
      pages: kept.map((item, index) =>
        clipLast !== undefined && index === kept.length - 1
          ? { ...item, text: item.text.slice(0, clipLast) }
          : item
      ),
      truncated: true,
      ...(section.visuals ? { visuals: section.visuals } : {}),
    };
  };

  const entryCount = ids.length;
  const served = largestFitting(entryCount, (n) => n === 0 || jsonBytes(pick(n)) <= capBytes);
  if (served > 0) {
    return {
      section: pick(served),
      partial: true,
      remaining: ids.slice(served),
    };
  }
  // The first entry alone exceeds the cap: clip its text rather than serve a
  // content-free section. `capBytes` is always well above the JSON scaffolding,
  // so the clip length search converges on a usable body.
  const firstTextLength = section.kind === "docx"
    ? (section.sections[0]?.text.length ?? 0)
    : section.kind === "pptx"
      ? (section.slides[0]?.text.length ?? 0)
      : (section.pages[0]?.text.length ?? 0);
  const clip = largestFitting(firstTextLength, (n) => jsonBytes(pick(1, n)) <= capBytes);
  return {
    section: pick(1, clip),
    partial: true,
    remaining: ids.slice(1),
  };
}

function compactArtifactCell(value: unknown, maxChars: number): unknown {
  return typeof value === "string" && value.length > maxChars
    ? value.slice(0, maxChars)
    : value;
}

/** Largest-first bounded variants; callers choose the first one that fits the pack cap. */
export function artifactSectionCandidates(
  section: ArtifactTaskPackSection,
): ArtifactTaskPackSection[] {
  const candidates: ArtifactTaskPackSection[] = [section];
  if ("sheet" in section) {
    for (const [maxColumns, maxRows, maxChars] of [
      [24, 12, 160],
      [12, 8, 80],
      [8, 4, 64],
      [4, 2, 32],
    ] as const) {
      if (
        section.columns.length <= maxColumns
        && section.rows.length <= maxRows
        && section.rows.every((row) =>
          row.every((value) => typeof value !== "string" || value.length <= maxChars)
        )
      ) {
        continue;
      }
      candidates.push({
        ...honestSheetSection(section, Math.min(maxRows, section.rows.length), Math.min(maxColumns, section.columns.length)),
        columns: section.columns.slice(0, maxColumns),
        rows: section.rows.slice(0, maxRows).map((row) =>
          row.slice(0, maxColumns).map((value) => compactArtifactCell(value, maxChars))
        ),
        truncated: true,
      });
    }
    return candidates;
  }

  for (const maxChars of [6_000, 3_000, 1_500, 750] as const) {
    if (section.kind === "docx") {
      candidates.push({
        kind: "docx",
        sections: section.sections.slice(0, maxChars >= 3_000 ? 2 : 1).map((item) => ({
          ...item,
          text: item.text.slice(0, maxChars),
        })),
        truncated: true,
        ...(section.visuals ? { visuals: section.visuals } : {}),
      });
    } else if (section.kind === "pptx") {
      candidates.push({
        kind: "pptx",
        slides: section.slides.slice(0, 1).map((item) => ({
          ...item,
          text: item.text.slice(0, maxChars),
        })),
        truncated: true,
        ...(section.visuals ? { visuals: section.visuals } : {}),
      });
    } else {
      candidates.push({
        kind: "pdf",
        pages: section.pages.slice(0, 1).map((item) => ({
          ...item,
          text: item.text.slice(0, maxChars),
        })),
        truncated: true,
        ...(section.visuals ? { visuals: section.visuals } : {}),
      });
    }
  }
  return candidates;
}

export function isArtifactTaskPackSurface(
  surface: TaskPackResultSurface,
): surface is ArtifactTaskPackSurface {
  return "kind" in surface && surface.kind === "artifact";
}

export function codeTaskPackSurfaces(
  surfaces: TaskPackResultSurface[],
): TaskPackSurface[] {
  return surfaces.filter(
    (surface): surface is TaskPackSurface => !isArtifactTaskPackSurface(surface),
  );
}
