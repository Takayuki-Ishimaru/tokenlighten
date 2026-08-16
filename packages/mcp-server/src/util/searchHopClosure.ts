import * as fs from "node:fs";
import { handleTable, shaOfText } from "./handles.js";
import { hop1ClosureEnabled } from "./flags.js";
import { safeResolve } from "./safePath.js";

const MAX_HOP1_ITEMS = 3;
const MAX_HOP1_BYTES = 6 * 1024;
const BEFORE_LINES = 3;
const AFTER_LINES = 5;

export interface Hop1Context {
  path: string;
  line: number;
  range: string;
  relation: "definition" | "reference" | "match";
  handle: string;
  code: string;
}

interface SearchFileGroup {
  path?: unknown;
  lines?: unknown;
  in_comment?: unknown;
  context?: unknown;
}

function isDefinitionLine(line: string, token: string): boolean {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\s*\\([^;{}]{0,512}\\)\\s*(?::[^{}]+)?\\{`).test(line);
}

/**
 * Adds bounded exact source windows for the first definition/call-site hop.
 * It never invents an edge: relation is classified from the matched line only.
 */
export function attachSearchHop1(
  response: object,
  workspace: string,
  token: string,
  kind: "find" | "references",
): Record<string, unknown> {
  const record = response as Record<string, unknown>;
  if (!hop1ClosureEnabled() || !/^[A-Za-z_$][\w$]*$/.test(token)) return record;
  const files = record["files"];
  if (!Array.isArray(files) || files.length === 0) return record;

  const candidates: Hop1Context[] = [];
  for (const raw of files as SearchFileGroup[]) {
    if (typeof raw.path !== "string" || !Array.isArray(raw.lines) || raw.lines.length === 0) continue;
    if (raw.context !== undefined) continue;
    const comments = Array.isArray(raw.in_comment) ? raw.in_comment : [];
    const line = raw.lines.find((value, index) =>
      typeof value === "number" && comments[index] !== true
    );
    if (typeof line !== "number") continue;
    const absolute = safeResolve(raw.path, workspace);
    if (absolute === undefined) continue;
    let content: string;
    try {
      content = fs.readFileSync(absolute, "utf8");
    } catch {
      continue;
    }
    const lines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
    const start = Math.max(1, line - BEFORE_LINES);
    const end = Math.min(lines.length, line + AFTER_LINES);
    const code = lines.slice(start - 1, end).join("\n");
    const range = `${start}-${end}`;
    const handle = handleTable.upsert({
      kind: "range",
      path: raw.path,
      range,
      workspaceRoot: workspace,
      sha: shaOfText(code),
    }).id;
    const matchedLine = lines[line - 1] ?? "";
    candidates.push({
      path: raw.path,
      line,
      range,
      relation: isDefinitionLine(matchedLine, token)
        ? "definition"
        : kind === "references" ? "reference" : "match",
      handle,
      code,
    });
  }
  candidates.sort((left, right) =>
    (left.relation === "definition" ? -1 : 0) - (right.relation === "definition" ? -1 : 0)
    || left.path.localeCompare(right.path)
    || left.line - right.line
  );

  const hop1: Hop1Context[] = [];
  for (const candidate of candidates) {
    if (hop1.length >= MAX_HOP1_ITEMS) break;
    const trial = [...hop1, candidate];
    if (Buffer.byteLength(JSON.stringify(trial), "utf8") > MAX_HOP1_BYTES) break;
    hop1.push(candidate);
  }
  if (hop1.length === 0) return record;
  return {
    ...record,
    hop1,
    ...(candidates.length > hop1.length ? { hop1_omitted: candidates.length - hop1.length } : {}),
  };
}
