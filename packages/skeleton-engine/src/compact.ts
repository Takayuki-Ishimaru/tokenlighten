// Plain data output — no meta envelope. See docs/00-postmortem.md §2.2.
//
// Compact skeleton renderer for target-repo AGENTS.md embedding.
// Targets ~800 tokens (configurable via maxTokens) for the "Repo skeleton"
// section in the AGENTS.md stable-prefix template.
// Spec: docs/06-stable-prefix-rebuild.md §3.5 / §4.4 Task B.

import type { RepoSkeleton } from "@tokenlighten/types";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface CompactSkeletonOptions {
  /**
   * Token cap for the output. Defaults to 800.
   * Estimation: 1 token ≈ 4 characters (no tokenizer dep).
   */
  maxTokens?: number;
  /**
   * Pre-rendered file signatures keyed by POSIX path (from renderFileSignatures).
   * Used to extract short symbol annotations (up to 3 symbols per file).
   */
  fileSignatures?: Map<string, string>;
}

/**
 * Render a compact directory-tree-like skeleton targeting ~800 tokens.
 *
 * Output shape (matches AGENTS.md §3.5 example):
 *
 *   src/
 *     core/                  - business logic, pure, no I/O
 *       ledger.ts            - postEntry, reverseEntry, getBalance
 *       ...
 *   tests/
 *     ...
 *
 * Byte-stable: directories sorted alphabetically, files by descending rank
 * then by path bytes (Buffer.compare). LF line endings, 2-space indentation.
 */
export function renderCompactSkeleton(
  skeleton: RepoSkeleton,
  opts: CompactSkeletonOptions = {},
): string {
  const maxTokens = opts.maxTokens ?? 800;
  const sigs = opts.fileSignatures ?? new Map<string, string>();

  if (skeleton.topRanked.length === 0) {
    return "_(no files ranked)_\n";
  }

  // Build sorted file list: descending rank, tiebreak by path bytes.
  const ranked = skeleton.topRanked.slice().sort((a, b) => {
    const scoreDiff = b.rank - a.rank;
    if (scoreDiff !== 0) return scoreDiff;
    return Buffer.compare(Buffer.from(a.path), Buffer.from(b.path));
  });

  // Build the full set of lines for all ranked files.
  const allLines = buildLines(ranked, sigs);

  // Apply token cap: drop lowest-ranked files until within budget.
  // But always keep at least the top 10 (or all if fewer than 10).
  const minInclude = Math.min(10, ranked.length);
  const result = applyTokenCap(allLines, ranked, sigs, maxTokens, minInclude);

  return result.endsWith("\n") ? result : result + "\n";
}

// ---------------------------------------------------------------------------
// Internal: tree building
// ---------------------------------------------------------------------------

interface FileLine {
  /** The ranked index in the sorted file array (for min-include). */
  rankIndex: number;
  /** Indented line text (without newline). */
  text: string;
  /** Path of the file this line represents (undefined for dir-header lines). */
  filePath?: string;
}

/**
 * Build the full list of output lines for the given sorted ranked files.
 * Returns FileLine[] so token-cap logic can reason about which lines to drop.
 */
function buildLines(
  ranked: Array<{ path: string; rank: number }>,
  sigs: Map<string, string>,
): FileLine[] {
  // Group files by top-level directory.
  // We build a two-level structure: dir → files within that dir.
  // For deeply nested paths we show only the dir and the filename.

  // Collect unique top-level dirs in sorted order.
  const dirFiles = new Map<string, Array<{ path: string; rank: number; rankIndex: number }>>();

  for (let i = 0; i < ranked.length; i++) {
    const { path, rank } = ranked[i]!;
    const topDir = getTopDir(path);
    if (!dirFiles.has(topDir)) dirFiles.set(topDir, []);
    dirFiles.get(topDir)!.push({ path, rank, rankIndex: i });
  }

  // Sort directories alphabetically (byte order).
  const sortedDirs = Array.from(dirFiles.keys()).sort((a, b) =>
    Buffer.compare(Buffer.from(a), Buffer.from(b)),
  );

  const lines: FileLine[] = [];

  for (const dir of sortedDirs) {
    const filesInDir = dirFiles.get(dir)!;

    if (dir === "") {
      // Files in repo root — no directory header.
      for (const f of filesInDir) {
        const annotation = buildAnnotation(f.path, sigs);
        const text = formatFileLine(f.path, 0, annotation);
        lines.push({ rankIndex: f.rankIndex, text, filePath: f.path });
      }
    } else {
      // Directory header line (no filePath → never dropped individually).
      lines.push({ rankIndex: -1, text: `${dir}/` });

      // Sub-group by immediate subdirectory within dir.
      const subDirFiles = groupBySubDir(dir, filesInDir);
      const sortedSubDirs = Array.from(subDirFiles.keys()).sort((a, b) =>
        Buffer.compare(Buffer.from(a), Buffer.from(b)),
      );

      for (const subDir of sortedSubDirs) {
        const filesInSubDir = subDirFiles.get(subDir)!;

        if (subDir === "") {
          // Files directly in dir.
          for (const f of filesInSubDir) {
            const annotation = buildAnnotation(f.path, sigs);
            const text = formatFileLine(getFileName(f.path), 1, annotation);
            lines.push({ rankIndex: f.rankIndex, text, filePath: f.path });
          }
        } else {
          // Sub-directory header.
          lines.push({ rankIndex: -1, text: `  ${subDir}/` });

          for (const f of filesInSubDir) {
            const annotation = buildAnnotation(f.path, sigs);
            const text = formatFileLine(getFileName(f.path), 2, annotation);
            lines.push({ rankIndex: f.rankIndex, text, filePath: f.path });
          }
        }
      }
    }
  }

  return lines;
}

/**
 * Apply the token cap by removing the lowest-ranked file lines until under budget.
 * Always preserves at least the top `minInclude` files.
 */
function applyTokenCap(
  allLines: FileLine[],
  ranked: Array<{ path: string; rank: number }>,
  _sigs: Map<string, string>,
  maxTokens: number,
  minInclude: number,
): string {
  // First try rendering all lines.
  let currentLines = allLines;
  let output = linesToString(currentLines);

  if (estimateTokens(output) <= maxTokens) {
    return output;
  }

  // Need to trim. Find which rankIndexes are beyond minInclude.
  // We'll drop in reverse rank order (highest rankIndex first = lowest ranked).
  const maxRankIndex = ranked.length - 1;

  // Build list of candidate rankIndexes to drop (from lowest-rank to highest).
  const droppable: number[] = [];
  for (let i = maxRankIndex; i >= minInclude; i--) {
    droppable.push(i);
  }

  // Drop one file at a time (its lines) until under cap.
  const dropped = new Set<number>();
  for (const ri of droppable) {
    dropped.add(ri);
    currentLines = allLines.filter((l) => !dropped.has(l.rankIndex));
    output = linesToString(currentLines);
    if (estimateTokens(output) <= maxTokens) {
      break;
    }
  }

  // If still over cap (because min-include files alone exceed the budget),
  // truncate the annotation of the last file line to fit.
  if (estimateTokens(output) > maxTokens) {
    // Annotation-truncation: shorten lines by trimming annotation text.
    output = truncateAnnotations(currentLines, maxTokens);
  }

  return output;
}

/**
 * Convert FileLine[] to a string, pruning empty directory headers
 * (dir headers with no file children underneath them).
 */
function linesToString(lines: FileLine[]): string {
  // Prune orphaned directory headers (rankIndex === -1 with no following file lines
  // before the next dir header or end).
  const result: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.rankIndex === -1) {
      // Check if any file line follows before the next same-or-shallower dir header.
      let hasChild = false;
      const currentIndent = countLeadingSpaces(line.text);
      for (let j = i + 1; j < lines.length; j++) {
        const next = lines[j]!;
        if (next.rankIndex === -1) {
          const nextIndent = countLeadingSpaces(next.text);
          if (nextIndent <= currentIndent) break; // sibling or parent dir
        }
        if (next.filePath !== undefined) {
          hasChild = true;
          break;
        }
      }
      if (hasChild) result.push(line.text);
    } else {
      result.push(line.text);
    }
  }
  return result.join("\n");
}

/**
 * When even min-include files exceed the token cap, truncate annotation text
 * to squeeze output under the budget.
 */
function truncateAnnotations(lines: FileLine[], maxTokens: number): string {
  // Build output with progressively shorter annotations.
  // Strategy: remove annotation text entirely from the end, line by line.
  const texts = lines.map((l) => l.text);
  let output = texts.join("\n");
  if (estimateTokens(output) <= maxTokens) return output;

  // Strip annotations from file lines (those containing " - ").
  for (let i = texts.length - 1; i >= 0; i--) {
    const t = texts[i]!;
    const dashIdx = t.indexOf(" - ");
    if (dashIdx !== -1) {
      texts[i] = t.slice(0, dashIdx);
      output = texts.join("\n");
      if (estimateTokens(output) <= maxTokens) return output;
    }
  }
  return output;
}

// ---------------------------------------------------------------------------
// Internal: formatting helpers
// ---------------------------------------------------------------------------

/** 4-char heuristic (no tokenizer dep). */
function estimateTokens(s: string): number {
  return Math.ceil(s.length / 4);
}

/**
 * Extract up to 3 symbol names from a pre-rendered file signature block.
 * Returns "- sym1, sym2, sym3" or "" if not available.
 */
function buildAnnotation(filePath: string, sigs: Map<string, string>): string {
  const sig = sigs.get(filePath) ?? sigs.get(toPosix(filePath));
  if (!sig) return "";

  const symbols: string[] = [];

  // Each line in a signature block is either a function/class/const declaration
  // or a comment. Extract the first identifier-like token from non-comment lines.
  for (const line of sig.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("*")) continue;

    const sym = extractSymbolName(trimmed);
    if (sym && !symbols.includes(sym)) {
      symbols.push(sym);
      if (symbols.length >= 3) break;
    }
  }

  if (symbols.length === 0) return "";
  return `- ${symbols.join(", ")}`;
}

/**
 * Extract the primary symbol name from a signature line.
 * Handles: function foo, class Foo, const foo, export function foo, async function foo, etc.
 */
function extractSymbolName(line: string): string | undefined {
  // Strip common modifiers.
  let s = line
    .replace(/^export\s+default\s+/, "")
    .replace(/^export\s+/, "")
    .replace(/^async\s+/, "")
    .replace(/^abstract\s+/, "")
    .replace(/^static\s+/, "")
    .replace(/^public\s+|^private\s+|^protected\s+/, "")
    .trim();

  // function name(...), class Name, const/let/var name
  const match =
    s.match(/^(?:function\s*\*?\s*|class\s+|(?:const|let|var)\s+)([A-Za-z_$][\w$]*)/) ??
    s.match(/^([A-Za-z_$][\w$]*)\s*[(<:=]/);

  return match?.[1];
}

/**
 * Format a file/dir entry with consistent column alignment.
 * The annotation is right-padded after the name so annotations start at a
 * consistent column per depth level.
 *
 * Column widths: depth 0 = 26, depth 1 = 24, depth 2 = 22 chars for the name part.
 */
function formatFileLine(name: string, depth: number, annotation: string): string {
  const indent = "  ".repeat(depth);
  if (!annotation) return `${indent}${name}`;
  const nameWidth = Math.max(26 - depth * 2, 14);
  const padded = name.padEnd(nameWidth);
  return `${indent}${padded} ${annotation}`;
}

/** Get the top-level directory of a POSIX path (or "" for root files). */
function getTopDir(p: string): string {
  const posix = toPosix(p);
  const slash = posix.indexOf("/");
  return slash === -1 ? "" : posix.slice(0, slash);
}

/** Get the file name (last segment) of a path. */
function getFileName(p: string): string {
  const posix = toPosix(p);
  return posix.split("/").pop() ?? posix;
}

/**
 * Within a top-level directory, group files by their immediate subdirectory.
 * Files directly in the top-level dir are grouped under "".
 */
function groupBySubDir(
  topDir: string,
  files: Array<{ path: string; rank: number; rankIndex: number }>,
): Map<string, typeof files> {
  const result = new Map<string, typeof files>();

  for (const f of files) {
    const posix = toPosix(f.path);
    // Remove topDir prefix.
    const rest = posix.slice(topDir.length + 1); // e.g. "core/ledger.ts" or "index.ts"
    const slash = rest.indexOf("/");
    const subDir = slash === -1 ? "" : rest.slice(0, slash);
    if (!result.has(subDir)) result.set(subDir, []);
    result.get(subDir)!.push(f);
  }

  return result;
}

function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

function countLeadingSpaces(s: string): number {
  let count = 0;
  for (const ch of s) {
    if (ch === " ") count++;
    else break;
  }
  return count;
}
