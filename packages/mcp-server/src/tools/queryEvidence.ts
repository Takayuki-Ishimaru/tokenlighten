import * as path from "path";

export type QueryEvidenceKind = "test-block" | "json-key" | "text-window";

export interface QueryEvidence {
  range: string;
  line: number;
  content: string;
  kind: QueryEvidenceKind;
  score: number;
  margin: number;
  matchedTerms: string[];
  missingTerms: string[];
}

export interface QueryEvidenceOptions {
  path?: string;
  preferTestBlocks?: boolean;
  windowLines?: number;
}

const QUERY_STOP_WORDS = new Set([
  "the", "and", "for", "with", "from", "into", "when", "where", "which", "what", "how",
  "this", "that", "these", "those", "does", "did", "can", "could", "would", "should",
  "explain", "trace", "identify", "find", "show", "report", "exact", "exactly", "current",
  "implementation", "path", "file", "files", "query", "semantic", "large", "mode", "returns",
  "return", "instead", "why", "whose", "such", "including", "especially", "another",
]);

/**
 * Protocol literals are valuable exact-text evidence, but converting them to
 * camelCase symbol lookups produces generic helpers such as readFile.
 */
const PROTOCOL_SYMBOL_SEARCH_TOKENS = new Set([
  "read_file",
  "edit_file",
  "search_files",
  "task_pack",
  "execution_contract",
  "next_call",
  "answer_ready",
  "edit_ready",
  "needs_followup",
]);

const GENERIC_TOOL_SYMBOL_TOKENS = new Set([
  "read_file",
  "edit_file",
  "search_files",
  "task_pack",
]);

const TEST_INTENT_RE = /\b(test|tests|testing|regression|spec|assert|assertion|verifier)\b/i;
const TEST_MARKER_RE = /\b(?:it|test|describe)\s*\(|\b(?:expect|assert(?:Equal|True|False|That)?)\s*\(/;
const GENERIC_HELPER_RE = /\b(?:function|const|let|var)\s+(?:readFile|writeFile|parse|read|write|setup|mkDir|fixture)\b/;

interface WeightedTerm {
  value: string;
  weight: number;
  exactLiteral: boolean;
}

interface ScoredWindow {
  start: number;
  end: number;
  line: number;
  score: number;
  matchedTerms: string[];
  hasTestMarker: boolean;
  isJsonKey: boolean;
}

function splitIdentifier(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[_$.-]+|\s+/)
    .map((part) => part.toLowerCase())
    .filter((part) => part.length >= 3 && !QUERY_STOP_WORDS.has(part));
}

function queryTerms(query: string): WeightedTerm[] {
  const raw = query.match(/[A-Za-z_$][A-Za-z0-9_$.-]*/g) ?? [];
  const byValue = new Map<string, WeightedTerm>();
  const add = (term: WeightedTerm): void => {
    const current = byValue.get(term.value);
    if (!current || term.weight > current.weight) byValue.set(term.value, term);
  };

  for (const token of raw) {
    const lower = token.toLowerCase();
    if (QUERY_STOP_WORDS.has(lower)) continue;
    const structured = /[_$.-]/.test(token) || /[a-z][A-Z]/.test(token);
    if (lower.length >= 3) {
      add({
        value: lower,
        weight: PROTOCOL_SYMBOL_SEARCH_TOKENS.has(lower) ? 5 : structured ? 4 : 2,
        exactLiteral: PROTOCOL_SYMBOL_SEARCH_TOKENS.has(lower) || structured,
      });
    }
    if (!PROTOCOL_SYMBOL_SEARCH_TOKENS.has(lower)) {
      for (const part of splitIdentifier(token)) {
        add({ value: part, weight: 1.5, exactLiteral: false });
      }
    }
  }

  if (/\bconfidence\s+interval\b/i.test(query)) {
    add({ value: "ci", weight: 2.5, exactLiteral: false });
  }

  return [...byValue.values()]
    .sort((a, b) => b.weight - a.weight || b.value.length - a.value.length)
    .slice(0, 16);
}

function lineContainsTerm(line: string, term: WeightedTerm): boolean {
  if (term.exactLiteral) return line.includes(term.value);
  if (term.value.length <= 3) {
    return new RegExp(`(?:^|[^a-z0-9])${term.value}(?:$|[^a-z0-9])`, "i").test(line);
  }
  return line.includes(term.value);
}

function scoreWindow(
  lines: string[],
  lowerLines: string[],
  terms: WeightedTerm[],
  documentFrequency: ReadonlyMap<string, number>,
  centerIndex: number,
  radius: number,
  preferTestBlocks: boolean,
  jsonPath: boolean,
): ScoredWindow {
  const startIndex = Math.max(0, centerIndex - radius);
  const endIndex = Math.min(lines.length - 1, centerIndex + radius);
  const lowerWindow = lowerLines.slice(startIndex, endIndex + 1).join("\n");
  const rawWindow = lines.slice(startIndex, endIndex + 1).join("\n");
  const matchedTerms: string[] = [];
  let score = 0;

  for (const term of terms) {
    if (!lineContainsTerm(lowerWindow, term)) continue;
    matchedTerms.push(term.value);
    const df = documentFrequency.get(term.value) ?? 1;
    const rarity = Math.min(3, 1 + Math.log((lines.length + 1) / (df + 1)));
    score += term.weight * rarity;
  }

  const hasTestMarker = TEST_MARKER_RE.test(rawWindow);
  if (preferTestBlocks && hasTestMarker) score += 7;
  if (preferTestBlocks && GENERIC_HELPER_RE.test(lines[centerIndex] ?? "") && !hasTestMarker) score -= 8;

  const center = lines[centerIndex]?.trim() ?? "";
  const isJsonKey = jsonPath && /^"[^"]+"\s*:/.test(center);
  if (isJsonKey) score += 5;

  return {
    start: startIndex + 1,
    end: endIndex + 1,
    line: centerIndex + 1,
    score,
    matchedTerms,
    hasTestMarker,
    isJsonKey,
  };
}

export function isProtocolSymbolSearchToken(token: string): boolean {
  return GENERIC_TOOL_SYMBOL_TOKENS.has(token.toLowerCase());
}

export function queryRequestsTestEvidence(query: string): boolean {
  return TEST_INTENT_RE.test(query);
}

/**
 * Select one bounded, query-local evidence window from content already held in
 * memory. It is deliberately lexical and deterministic: ambiguity falls back
 * to the caller's existing skeleton/prefix behavior.
 */
export function selectQueryEvidence(
  content: string,
  query: string,
  options: QueryEvidenceOptions = {},
): QueryEvidence | undefined {
  if (query.trim().length === 0 || content.length === 0) return undefined;
  const terms = queryTerms(query);
  if (terms.length === 0) return undefined;

  const lines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const lowerLines = lines.map((line) => line.toLowerCase());
  const documentFrequency = new Map<string, number>();
  for (const term of terms) {
    let count = 0;
    for (const line of lowerLines) if (lineContainsTerm(line, term)) count++;
    documentFrequency.set(term.value, count);
  }

  const candidateLines = new Set<number>();
  for (let index = 0; index < lowerLines.length; index++) {
    if (terms.some((term) => lineContainsTerm(lowerLines[index]!, term))) candidateLines.add(index);
  }
  if (candidateLines.size === 0) return undefined;

  const preferTestBlocks = options.preferTestBlocks === true || queryRequestsTestEvidence(query);
  const jsonPath = path.extname(options.path ?? "").toLowerCase() === ".json";
  const radius = Math.max(4, Math.min(24, options.windowLines ?? 12));
  const scored = [...candidateLines]
    .map((index) => scoreWindow(
      lines,
      lowerLines,
      terms,
      documentFrequency,
      index,
      radius,
      preferTestBlocks,
      jsonPath,
    ))
    .filter((candidate) => candidate.matchedTerms.length > 0)
    .sort((a, b) => b.score - a.score || a.line - b.line);

  if (scored.length === 0) return undefined;
  const best = scored[0]!;
  if (best.score < 3) return undefined;
  if (preferTestBlocks && !best.hasTestMarker) return undefined;

  const runnerUp = scored.find((candidate) =>
    candidate.end < best.start || candidate.start > best.end
  );
  const margin = runnerUp === undefined ? best.score : best.score - runnerUp.score;
  const matched = new Set(best.matchedTerms);
  const missingTerms = terms
    .map((term) => term.value)
    .filter((term) => !matched.has(term));

  return {
    range: `${best.start}-${best.end}`,
    line: best.line,
    content: lines.slice(best.start - 1, best.end).join("\n"),
    kind: best.hasTestMarker ? "test-block" : best.isJsonKey ? "json-key" : "text-window",
    score: Number(best.score.toFixed(3)),
    margin: Number(margin.toFixed(3)),
    matchedTerms: [...matched],
    missingTerms,
  };
}
