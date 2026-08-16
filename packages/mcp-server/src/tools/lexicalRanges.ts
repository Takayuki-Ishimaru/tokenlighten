import { treeSitterSupports, withTreeSitterRoot, type TreeSitterNode } from "../skeleton/treeSitter.js";

export type LexicalKind = "comment" | "string";

export interface LexicalSegment {
  line: number;
  startCol: number;
  endCol: number;
  kind: LexicalKind;
}

function namedChildren(node: TreeSitterNode): TreeSitterNode[] {
  const out: TreeSitterNode[] = [];
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child) out.push(child);
  }
  return out;
}

function kindForNode(type: string): LexicalKind | undefined {
  const lower = type.toLowerCase();
  if (lower.includes("comment")) return "comment";
  if (
    lower.includes("string") ||
    lower.includes("template") ||
    lower === "char_literal" ||
    lower === "character_literal" ||
    lower === "interpreted_string_literal" ||
    lower === "raw_string_literal"
  ) {
    return "string";
  }
  return undefined;
}

function pushNodeSegments(out: LexicalSegment[], node: TreeSitterNode, kind: LexicalKind): void {
  const start = node.startPosition;
  const end = node.endPosition;
  if (!start || !end) return;

  const startLine = start.row + 1;
  const endLine = end.row + 1;
  for (let line = startLine; line <= endLine; line++) {
    out.push({
      line,
      startCol: line === startLine ? start.column : 0,
      endCol: line === endLine ? end.column : Number.MAX_SAFE_INTEGER,
      kind,
    });
  }
}

export async function collectLexicalSegments(
  text: string,
  language: string,
): Promise<Map<number, LexicalSegment[]>> {
  if (!treeSitterSupports(language)) return new Map();

  const segments = await withTreeSitterRoot(text, language, {}, (root) => {
    const out: LexicalSegment[] = [];
    const visit = (node: TreeSitterNode): void => {
      const kind = kindForNode(node.type);
      if (kind) {
        pushNodeSegments(out, node, kind);
        return;
      }
      for (const child of namedChildren(node)) visit(child);
    };
    visit(root);
    return out;
  });

  const byLine = new Map<number, LexicalSegment[]>();
  for (const segment of segments ?? []) {
    const existing = byLine.get(segment.line) ?? [];
    existing.push(segment);
    byLine.set(segment.line, existing);
  }
  for (const lineSegments of byLine.values()) {
    lineSegments.sort((a, b) => a.startCol - b.startCol || a.endCol - b.endCol);
  }
  return byLine;
}

export function segmentKindAt(
  segments: Map<number, LexicalSegment[]>,
  line: number,
  column: number,
): LexicalKind | undefined {
  for (const segment of segments.get(line) ?? []) {
    if (column >= segment.startCol && column < segment.endCol) return segment.kind;
  }
  return undefined;
}
