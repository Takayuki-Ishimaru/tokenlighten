/**
 * removeDuplicateBranch.ts — intent: remove-duplicate-branch.
 *
 * Finds consecutive if/else-if blocks with identical trimmed bodies and removes
 * the second (duplicate) block, repairing the else chain. Text-heuristic only —
 * no AST required for this structural pattern.
 *
 * Returns ok:true with path/lines/delta on success, or ok:false with reason and
 * next hint on refusal (no match, ambiguous, or parse failure).
 */

import * as fs from "fs";
import { writeExistingFileAtomic } from "../write/atomicWrite.js";
import { looksLikeSecretFile } from "../write/secretScan.js";
import { computeLineDelta, formatDelta, formatLines } from "../util/lineDelta.js";
import { safeResolveForWrite, resolveReal, isWithin, statReadTargetSync } from "../util/safePath.js";
import type { GuardedWorkspaceRoot } from "../write/guardedWorkspace.js";

export type RemoveDuplicateBranchResult =
  | { ok: true; path: string; lines: string; delta: string }
  | { ok: false; reason: string; next?: string };

interface Block {
  /** 0-based line index of the branch header line ("if" or "} else if"). */
  headerLine: number;
  /** 0-based inclusive last line of the block's body (before next header or chain end). */
  endLine: number;
  /** Trimmed body text (lines between header and endLine). */
  body: string;
}

/** Matches start of an if-chain block: "if (" (not preceded by "}"). */
const IF_START_RE = /^\s*if\s*\(/;
/** Matches "} else if (": closes prev block and opens next. */
const ELSE_IF_RE = /^\s*}\s*else\s+if\s*\(/;
/** Matches "} else {": closes the if-chain, starts unconditional else body. */
const ELSE_RE = /^\s*}\s*else\s*\{/;

/**
 * Parse a single-level if/else-if chain from `lines` starting at `startIdx`.
 *
 * Strategy: we split the chain at "} else if" and "} else {" boundaries.
 * Each block's body is the lines between its header and the next boundary.
 *
 * Returns an array of blocks (at least 2) or null if no valid chain is found.
 */
function parseIfChain(lines: string[], startIdx: number): Block[] | null {
  const blocks: Block[] = [];
  let currentHeader = startIdx;
  let i = startIdx + 1;

  while (i < lines.length) {
    const line = lines[i]!;

    if (ELSE_IF_RE.test(line)) {
      // This line closes the current block and opens the next.
      // The current block's body is lines[currentHeader+1 .. i-1].
      const bodyLines = lines.slice(currentHeader + 1, i);
      // Remove leading/trailing blank lines from body before trimming.
      const body = bodyLines.join("\n").trim();
      blocks.push({ headerLine: currentHeader, endLine: i - 1, body });
      currentHeader = i;
      i++;
      continue;
    }

    if (ELSE_RE.test(line)) {
      // "} else {" closes the last if/else-if block.
      const bodyLines = lines.slice(currentHeader + 1, i);
      const body = bodyLines.join("\n").trim();
      blocks.push({ headerLine: currentHeader, endLine: i - 1, body });
      // Stop — we don't parse the else body as a branch block.
      break;
    }

    // Check for a lone "}" that closes the last block in the chain.
    // Heuristic: same or lower indentation as the chain's opening if.
    if (/^\s*\}\s*$/.test(line)) {
      const headerIndent = (lines[currentHeader]!.match(/^(\s*)/) ?? [])[1]!.length;
      const closeIndent = (line.match(/^(\s*)/) ?? [])[1]!.length;
      if (closeIndent <= headerIndent) {
        // This "}" closes the last block.
        const bodyLines = lines.slice(currentHeader + 1, i);
        const body = bodyLines.join("\n").trim();
        blocks.push({ headerLine: currentHeader, endLine: i, body });
        break;
      }
    }

    i++;
  }

  return blocks.length >= 2 ? blocks : null;
}

/**
 * Find all duplicate adjacent pairs in a block list.
 */
function findDuplicatePairs(blocks: Block[]): Array<{ prev: Block; curr: Block }> {
  const pairs: Array<{ prev: Block; curr: Block }> = [];
  for (let i = 1; i < blocks.length; i++) {
    const prev = blocks[i - 1]!;
    const curr = blocks[i]!;
    if (prev.body !== "" && prev.body === curr.body) {
      pairs.push({ prev, curr });
    }
  }
  return pairs;
}

export async function applyRemoveDuplicateBranch(
  relPath: string,
  range: string | undefined,
  workspace: GuardedWorkspaceRoot,
  allowWrite: boolean,
  handleId: string,
): Promise<RemoveDuplicateBranchResult> {
  if (!allowWrite) {
    return { ok: false, reason: "write-not-enabled" };
  }

  if (!relPath) {
    return { ok: false, reason: "intent-unsupported", next: "provide a file handle" };
  }

  if (looksLikeSecretFile(relPath)) {
    return { ok: false, reason: "intent-unsupported" };
  }

  const abs = safeResolveForWrite(relPath, workspace);
  if (!abs) {
    return { ok: false, reason: "path-outside-workspace" };
  }
  let realPath: string;
  try {
    realPath = fs.realpathSync(abs);
  } catch {
    return { ok: false, reason: "path-outside-workspace" };
  }
  if (!isWithin(realPath, resolveReal(workspace))) {
    return { ok: false, reason: "path-outside-workspace" };
  }

  let raw: string;
  let rawMode: number | undefined;
  try {
    // Stat FIRST — see appendEnumMember.ts for why (FIFO/oversize must be
    // refused before the open; refusal throws into the existing catch).
    rawMode = statReadTargetSync(realPath, workspace).mode;
    raw = fs.readFileSync(realPath, "utf8");
  } catch {
    return { ok: false, reason: "intent-unsupported", next: `read_file mode=slice handle=${handleId}` };
  }

  // Parse optional range constraint ("a-b", 1-based inclusive).
  let scopeStart: number | undefined;
  let scopeEnd: number | undefined;
  if (range) {
    const m = /^(\d+)-(\d+)$/.exec(range);
    if (m) {
      scopeStart = parseInt(m[1]!, 10);
      scopeEnd = parseInt(m[2]!, 10);
    }
  }

  const lines = raw.split(/\r?\n/);

  // Find if-chains to scan. When a scope is set, only scan within that range.
  const scanStart = scopeStart !== undefined ? scopeStart - 1 : 0;
  const scanEnd = scopeEnd !== undefined ? scopeEnd - 1 : lines.length - 1;

  let chainStart = -1;
  for (let i = scanStart; i <= Math.min(scanEnd, lines.length - 1); i++) {
    const line = lines[i]!;
    if (IF_START_RE.test(line) && !ELSE_IF_RE.test(line)) {
      chainStart = i;
      break;
    }
  }

  if (chainStart === -1) {
    return {
      ok: false,
      reason: scopeStart !== undefined ? "intent-no-duplicate-in-scope" : "intent-unsupported",
      next: `read_file mode=slice handle=${handleId}`,
    };
  }

  const blocks = parseIfChain(lines, chainStart);

  if (!blocks) {
    return {
      ok: false,
      reason: scopeStart !== undefined ? "intent-no-duplicate-in-scope" : "intent-unsupported",
      next: `read_file mode=slice handle=${handleId}`,
    };
  }

  // When scope is set, filter blocks to those that lie within the range.
  const scopedBlocks = scopeStart !== undefined && scopeEnd !== undefined
    ? blocks.filter((b) => b.headerLine + 1 >= scopeStart! && b.endLine + 1 <= scopeEnd!)
    : blocks;

  const pairs = findDuplicatePairs(scopedBlocks.length >= 2 ? scopedBlocks : blocks);

  // When scope is set, further filter pairs so both blocks are within scope.
  const scopedPairs = scopeStart !== undefined && scopeEnd !== undefined
    ? pairs.filter(
        ({ prev, curr }) =>
          prev.headerLine + 1 >= scopeStart! &&
          curr.endLine + 1 <= scopeEnd!,
      )
    : pairs;

  const effectivePairs = scopeStart !== undefined ? scopedPairs : pairs;

  if (effectivePairs.length === 0) {
    return {
      ok: false,
      reason: scopeStart !== undefined ? "intent-no-duplicate-in-scope" : "intent-unsupported",
      next: `read_file mode=slice handle=${handleId}`,
    };
  }

  if (effectivePairs.length > 1) {
    return {
      ok: false,
      reason: "intent-ambiguous",
      next: `read_file mode=slice handle=${handleId}`,
    };
  }

  const { curr } = effectivePairs[0]!;

  // Remove lines [curr.headerLine .. curr.endLine] inclusive. For a terminal
  // `} else if (...) { ... }` block, the header line's leading `}` is the only
  // close brace for the previous branch, so preserve that brace as its own line.
  // When another `} else if` / `} else` follows, that following boundary line
  // already carries the close brace, so a plain deletion is correct.
  const before = lines.slice(0, curr.headerLine);
  const after = lines.slice(curr.endLine + 1);
  const nextLine = lines[curr.endLine + 1] ?? "";
  const shouldPreserveCloseBrace = ELSE_IF_RE.test(lines[curr.headerLine] ?? "") &&
    !ELSE_IF_RE.test(nextLine) &&
    !ELSE_RE.test(nextLine);
  const replacementLines = shouldPreserveCloseBrace
    ? [((lines[curr.headerLine] ?? "").match(/^(\s*)}/)?.[1] ?? "") + "}"]
    : [];

  const usesCRLF = raw.includes("\r\n");
  const newContent = [...before, ...replacementLines, ...after].join(usesCRLF ? "\r\n" : "\n");

  const removedLines = lines.slice(curr.headerLine, curr.endLine + 1);
  const removedText = removedLines.join("\n");

  // Mode preservation: see writeExistingFileAtomic's doc comment
  // (2026-08-07 chmod-reset incident).
  try {
    writeExistingFileAtomic(realPath, newContent, rawMode, { root: workspace, relPath });
  } catch (err) {
    return {
      ok: false,
      reason: "intent-unsupported",
      next: `write failed: ${(err as Error).message}`,
    };
  }

  const replacementText = replacementLines.length > 0 ? replacementLines.join("\n") + "\n" : "";
  const ld = computeLineDelta(raw, removedText + "\n", replacementText);
  return {
    ok: true,
    path: relPath,
    lines: formatLines(ld.startLine, ld.endLine),
    delta: formatDelta(ld.added, ld.removed),
  };
}
