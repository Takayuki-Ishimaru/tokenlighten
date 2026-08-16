import * as fs from "fs";
import { writeExistingFileAtomic } from "../write/atomicWrite.js";
import { looksLikeSecretFile } from "../write/secretScan.js";
import { formatDelta, formatLines } from "../util/lineDelta.js";
import { safeResolveForWrite, resolveReal, isWithin, statReadTargetSync } from "../util/safePath.js";
import type { GuardedWorkspaceRoot } from "../write/guardedWorkspace.js";
import { countLines } from "../util/countLines.js";

export type AppendEnumMemberResult =
  | { ok: true; path: string; lines: string; delta: string }
  | { ok: false; reason: string; next?: string };

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function changedLine(before: string, after: string): number {
  const beforeLines = before.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const afterLines = after.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const max = Math.max(beforeLines.length, afterLines.length);
  for (let i = 0; i < max; i++) {
    if (beforeLines[i] !== afterLines[i]) return i + 1;
  }
  return 1;
}

function findMatchingBrace(content: string, openIdx: number): number {
  let depth = 0;
  for (let i = openIdx; i < content.length; i++) {
    const ch = content[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// symbolName arrives as the caller's raw args.symbol (see server.ts intent
// dispatch); escape it before interpolation so a regex-active name cannot
// throw SyntaxError or backtrack catastrophically (CWE-1333). Same helper as
// appendUnionMember.ts.
function escapeForRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function appendBraceEnum(content: string, symbolName: string, target: string, language: string | undefined): string | null {
  const enumRe = new RegExp(`\\benum\\s+(?:class\\s+)?${escapeForRegex(symbolName)}\\b[^\\{]*\\{`, "m");
  const match = enumRe.exec(content);
  if (!match) return null;
  const openIdx = match.index + match[0].lastIndexOf("{");
  const closeIdx = findMatchingBrace(content, openIdx);
  if (closeIdx < 0) return null;

  const body = content.slice(openIdx + 1, closeIdx);
  const duplicateRe = new RegExp(`\\b${target}\\b`);
  if (duplicateRe.test(body)) return "DUPLICATE";

  const lines = body.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const indent = lines.find((line) => /^\s+/.test(line))?.match(/^\s*/)?.[0] ?? "  ";
  const php = language === "php";
  const member = php ? `case ${target};` : target;
  const trimmedBody = body.trim();
  const trailingStart = body.search(/\s*$/);
  const insertionPoint = !php && body.indexOf(";") >= 0
    ? openIdx + 1 + body.indexOf(";")
    : openIdx + 1 + (trailingStart >= 0 ? trailingStart : body.length);
  const beforeInsertion = content.slice(openIdx + 1, insertionPoint);
  const needsComma = !php && beforeInsertion.trim().length > 0 && !beforeInsertion.trimEnd().endsWith(",");
  const prefix = trimmedBody.length === 0 ? "\n" : (needsComma ? ",\n" : "\n");
  const insert = `${prefix}${indent}${member}`;
  return content.slice(0, insertionPoint) + insert + content.slice(insertionPoint);
}

function appendPythonEnum(content: string, symbolName: string, target: string): string | null {
  const classRe = new RegExp(`^([ \\t]*)class\\s+${escapeForRegex(symbolName)}\\s*\\([^)]*Enum[^)]*\\)\\s*:\\s*$`, "m");
  const match = classRe.exec(content);
  if (!match) return null;
  const classLineEnd = content.indexOf("\n", match.index);
  const insertAfter = classLineEnd >= 0 ? classLineEnd + 1 : content.length;
  const classIndent = match[1] ?? "";
  const memberIndent = `${classIndent}    `;
  const after = content.slice(insertAfter);
  const nextTopLevel = after.search(new RegExp(`\\n${classIndent}\\S`));
  const bodyEnd = nextTopLevel >= 0 ? insertAfter + nextTopLevel + 1 : content.length;
  const body = content.slice(insertAfter, bodyEnd);
  if (new RegExp(`\\b${target}\\b`).test(body)) return "DUPLICATE";
  const insert = `${memberIndent}${target} = "${target}"\n`;
  return content.slice(0, bodyEnd) + (body.endsWith("\n") || body.length === 0 ? "" : "\n") + insert + content.slice(bodyEnd);
}

// Exported for symbolRegexHardening.spec.ts, which pins the caller-tainted
// symbolName escaping without needing the guarded write stack.
export function appendEnumMember(content: string, symbolName: string, target: string, language: string | undefined): string | null {
  const python = language === "py" || language === "python";
  return python
    ? appendPythonEnum(content, symbolName, target)
    : appendBraceEnum(content, symbolName, target, language);
}

export async function applyAppendEnumMember(
  relPath: string,
  symbolName: string | undefined,
  target: string,
  workspace: GuardedWorkspaceRoot,
  allowWrite: boolean,
  handleId: string,
  lang: string | undefined,
): Promise<AppendEnumMemberResult> {
  if (!allowWrite) return { ok: false, reason: "write-not-enabled" };
  if (!symbolName) return { ok: false, reason: "intent-unsupported", next: `read_file mode=slice handle=${handleId}` };
  if (!IDENT_RE.test(target)) return { ok: false, reason: "intent-unsupported", next: "target must be an enum identifier" };
  if (looksLikeSecretFile(relPath)) return { ok: false, reason: "intent-unsupported" };

  const abs = safeResolveForWrite(relPath, workspace);
  if (!abs) return { ok: false, reason: "path-outside-workspace" };
  let realPath: string;
  try {
    realPath = fs.realpathSync(abs);
  } catch {
    return { ok: false, reason: "path-outside-workspace" };
  }
  if (!isWithin(realPath, resolveReal(workspace))) return { ok: false, reason: "path-outside-workspace" };

  let before: string;
  let beforeMode: number | undefined;
  try {
    // Stat FIRST: this call already needed the mode, and stat(2) is also the
    // only way to learn the target is a FIFO/device/oversize file WITHOUT
    // opening it (readFileSync on a workspace FIFO blocks forever). Refusal
    // throws into the existing catch, so the refusal shape is unchanged.
    beforeMode = statReadTargetSync(realPath, workspace).mode;
    before = fs.readFileSync(realPath, "utf8");
  } catch {
    return { ok: false, reason: "intent-unsupported" };
  }

  const after = appendEnumMember(before, symbolName, target, lang);
  if (after === "DUPLICATE") return { ok: false, reason: "intent-unsupported", next: "enum member already present" };
  if (!after || after === before) return { ok: false, reason: "intent-unsupported", next: "enum declaration not found" };

  // Mode preservation: see writeExistingFileAtomic's doc comment
  // (2026-08-07 chmod-reset incident).
  writeExistingFileAtomic(realPath, after, beforeMode);

  const startLine = changedLine(before, after);
  const added = Math.max(1, countLines(after) - countLines(before));
  return {
    ok: true,
    path: relPath,
    lines: formatLines(startLine, startLine + added - 1),
    delta: formatDelta(added, 0),
  };
}
