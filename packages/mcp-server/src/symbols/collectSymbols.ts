import { withTreeSitterRoot, type TreeSitterNode } from "../skeleton/treeSitter.js";
import type { TreeSitterPaths } from "../skeleton/types.js";

export type CollectedSymbolKind =
  | "function"
  | "method"
  | "class"
  | "interface"
  | "type"
  | "enum"
  | "const"
  | "let"
  | "var";

export interface CollectedSymbol {
  name: string;
  kind: CollectedSymbolKind;
  startLine: number;
  endLine: number;
  startIndex: number;
  endIndex: number;
  signatureStartIndex: number;
  signatureEndIndex: number;
  signatureStartLine: number;
  signatureEndLine: number;
  enclosingSymbol?: {
    name: string;
    startLine: number;
    endLine: number;
    /**
     * DESIGN-v0.8 B4.1: the enclosing symbol's OWN bare-declaration line —
     * mirrors CollectedSymbol.signatureStartLine (see makeSymbol's doc
     * comment). `startLine` above may now be widened to include the
     * enclosing symbol's own leading doc comment; a consumer rendering
     * "the enclosing class's header line" (e.g. getSymbolWithContext.ts's
     * `enclosing scope:` block) wants the bare `class Foo {` line, not the
     * doc comment above it.
     */
    signatureStartLine: number;
  };
  docComment?: {
    startLine: number;
    endLine: number;
    lines: string[];
  };
}

interface VisitContext {
  enclosingSymbol?: CollectedSymbol["enclosingSymbol"];
  rangeNode?: TreeSitterNode;
}

const COLLECTOR_LANGS = new Set([
  "javascript",
  "typescript",
  "typescriptreact",
  "python",
  "go",
  "rust",
  "java",
  "c",
  "cpp",
  "ruby",
  "csharp",
  "php",
  "kotlin",
]);

const FUNCTION_TYPES = new Set([
  "function_declaration",
  "generator_function_declaration",
  "function_definition",
  "function_item",
  "method",
  "singleton_method",
]);

const CLASS_TYPES = new Set([
  "class_declaration",
  "abstract_class_declaration",
  "class_definition",
  "class",
  "module",
  "class_specifier",
  "struct_specifier",
  "struct_item",
  "struct_declaration",
  "record_declaration",
  "object_declaration",
]);

const METHOD_TYPES = new Set([
  "method_definition",
  "method_declaration",
  "constructor_declaration",
  "destructor_declaration",
  "operator_declaration",
]);
const INTERFACE_TYPES = new Set(["interface_declaration", "trait_item"]);
const TYPE_ALIAS_TYPES = new Set(["type_alias_declaration", "type_spec", "type_item"]);
const ENUM_TYPES = new Set(["enum_declaration", "enum_item"]);
const VARIABLE_DECL_TYPES = new Set(["lexical_declaration", "variable_declaration"]);
const VARIABLE_DECLARATOR_TYPES = new Set(["variable_declarator"]);
const WRAPPER_TYPES = new Set(["export_statement", "decorated_definition"]);
const BODY_TYPES = new Set([
  "block",
  "statement_block",
  "compound_statement",
  "declaration_list",
  "class_body",
  "function_body",
  "body_statement",
  "field_declaration_list",
  "enum_body",
  "interface_body",
]);

function namedChildren(node: TreeSitterNode): TreeSitterNode[] {
  const out: TreeSitterNode[] = [];
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child) out.push(child);
  }
  return out;
}

function computeLineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") starts.push(i + 1);
  }
  return starts;
}

function lineForIndex(lineStarts: number[], index: number): number {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const start = lineStarts[mid]!;
    const next = lineStarts[mid + 1] ?? Number.POSITIVE_INFINITY;
    if (index >= start && index < next) return mid + 1;
    if (index < start) hi = mid - 1;
    else lo = mid + 1;
  }
  return Math.max(1, lineStarts.length);
}

function startLine(node: TreeSitterNode, lineStarts: number[]): number {
  return node.startPosition ? node.startPosition.row + 1 : lineForIndex(lineStarts, node.startIndex);
}

function endLine(node: TreeSitterNode, lineStarts: number[]): number {
  return node.endPosition ? node.endPosition.row + 1 : lineForIndex(lineStarts, Math.max(0, node.endIndex - 1));
}

function fieldText(node: TreeSitterNode | null, text: string): string | undefined {
  if (!node) return undefined;
  const raw = text.slice(node.startIndex, node.endIndex).trim();
  return raw.length > 0 ? raw : undefined;
}

function firstLineOf(node: TreeSitterNode, text: string): string {
  return text.slice(node.startIndex, Math.min(node.endIndex, text.indexOf("\n", node.startIndex) === -1 ? node.endIndex : text.indexOf("\n", node.startIndex))).trim();
}

function nameOf(node: TreeSitterNode, text: string): string | undefined {
  const fromField = fieldText(node.childForFieldName("name"), text);
  if (fromField) return fromField;

  const line = firstLineOf(node, text);
  const patterns: RegExp[] = [
    /\b(?:class|interface|struct|record|trait|module)\s+([A-Za-z_$][\w$]*)/,
    /\benum(?:\s+class)?\s+([A-Za-z_$][\w$]*)/,
    /\btype\s+([A-Za-z_$][\w$]*)\b/,
    /\bfunc\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*\(/,
    /\b(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/,
    /\b(?:function|fn|fun)\s+([A-Za-z_$][\w$]*)\s*[<(]/,
    /\bdef\s+(?:self\.)?([A-Za-z_]\w*[!?=]?)\s*/,
    /^(?:public|protected|private|internal|static|final|abstract|async|override|virtual|inline|constexpr|extern|pub|open|suspend|\s)*(?:[\w:<>\[\],.?*&]+\s+)+([A-Za-z_$][\w$]*(?:::[A-Za-z_$][\w$]*)?)\s*\(/,
    /\b([A-Za-z_$][\w$]*(?:::[A-Za-z_$][\w$]*)?)\s*\([^;]*\)\s*(?:const\s*)?(?:noexcept\s*)?\{/,
  ];
  for (const pattern of patterns) {
    const match = line.match(pattern);
    if (match?.[1]) return match[1];
  }
  return undefined;
}

function declarationKeyword(node: TreeSitterNode, text: string): "const" | "let" | "var" {
  const prefix = text.slice(node.startIndex, Math.min(node.endIndex, node.startIndex + 32));
  if (/\blet\b/.test(prefix)) return "let";
  if (/\bvar\b/.test(prefix)) return "var";
  return "const";
}

function hasSingleDeclarator(node: TreeSitterNode): boolean {
  return namedChildren(node).filter((child) => VARIABLE_DECLARATOR_TYPES.has(child.type)).length === 1;
}

function splitLines(text: string): string[] {
  return text.split(/\r\n|\r|\n/);
}

function rtrim(s: string): string {
  return s.replace(/\s+$/, "");
}

/**
 * 2026-08-01 leading-comment absorption bound (measured live): docCommentBefore
 * walks single-line comment runs (#, ///) with no size bound, so a 2-line
 * Python function under a 300-line comment wall collected startLine=1 — a
 * "symbol-scoped" range covering 99% of a 304-line file, which a later
 * {handle, content} full-body replace then wiped (editCodeHandle's B4.1b
 * fixture did exactly this silently until the blast-radius guard exposed it).
 * A doc block/run is attached WHOLE or not at all: B4.1's dangling-delimiter
 * hazard exists only for PARTIAL attachment (a range starting INSIDE a
 * comment block); attaching nothing leaves the wall fully outside the range,
 * which is syntactically safe. Anything longer than this cap is treated as
 * file preamble — not the symbol's own doc — and stays out of the widened
 * range and the docComment payload alike.
 */
const MAX_DOC_COMMENT_LINES = 64;

function docCommentBefore(lines: string[], declarationStartLine: number): CollectedSymbol["docComment"] | undefined {
  let i = declarationStartLine - 2;
  while (i >= 0) {
    const trimmed = lines[i]!.trim();
    if (trimmed.startsWith("@") || trimmed.startsWith("[")) {
      i--;
      continue;
    }
    break;
  }
  if (i < 0) return undefined;

  const prev = lines[i]!.trim();
  if (prev === "") return undefined;

  if (prev.endsWith("*/")) {
    const docLines: string[] = [];
    for (let j = i; j >= 0; j--) {
      const line = lines[j]!;
      docLines.unshift(rtrim(line));
      if (line.trim().startsWith("/**")) {
        return {
          startLine: j + 1,
          endLine: i + 1,
          lines: docLines,
        };
      }
      if (line.trim() === "") return undefined;
    }
    return undefined;
  }

  if (prev.startsWith("///")) {
    const docLines: string[] = [];
    let start = i;
    for (let j = i; j >= 0; j--) {
      const line = lines[j]!;
      if (!line.trim().startsWith("///")) break;
      start = j;
      docLines.unshift(rtrim(line));
    }
    return {
      startLine: start + 1,
      endLine: i + 1,
      lines: docLines,
    };
  }

  if (prev.startsWith("#") && !prev.startsWith("#!")) {
    const docLines: string[] = [];
    let start = i;
    for (let j = i; j >= 0; j--) {
      const line = lines[j]!;
      const trimmed = line.trim();
      if (!trimmed.startsWith("#") || trimmed.startsWith("#!")) break;
      start = j;
      docLines.unshift(rtrim(line));
    }
    return {
      startLine: start + 1,
      endLine: i + 1,
      lines: docLines,
    };
  }

  return undefined;
}

function signatureEndLineFor(node: TreeSitterNode, rangeNode: TreeSitterNode, lineStarts: number[]): number {
  const body = node.childForFieldName("body") ?? namedChildren(node).find((child) => BODY_TYPES.has(child.type));
  if (body) return lineForIndex(lineStarts, Math.max(rangeNode.startIndex, body.startIndex - 1));
  return startLine(rangeNode, lineStarts);
}

function signatureEndIndexFor(node: TreeSitterNode, rangeNode: TreeSitterNode): number {
  const body = node.childForFieldName("body") ?? namedChildren(node).find((child) => BODY_TYPES.has(child.type));
  return body ? Math.max(rangeNode.startIndex, body.startIndex) : rangeNode.endIndex;
}

function makeSymbol(
  name: string,
  kind: CollectedSymbolKind,
  node: TreeSitterNode,
  rangeNode: TreeSitterNode,
  _text: string,
  lines: string[],
  lineStarts: number[],
  enclosingSymbol?: CollectedSymbol["enclosingSymbol"],
): CollectedSymbol {
  const symbolStartLine = startLine(rangeNode, lineStarts);
  const docCommentRaw = docCommentBefore(lines, symbolStartLine);
  // MAX_DOC_COMMENT_LINES: whole-or-nothing — see the constant's doc comment.
  const docComment = docCommentRaw !== undefined
    && docCommentRaw.endLine - docCommentRaw.startLine + 1 <= MAX_DOC_COMMENT_LINES
    ? docCommentRaw
    : undefined;
  // DESIGN-v0.8 B4.1: a symbol's overall [startLine,endLine]/[startIndex,
  // endIndex] range must include its own leading doc block, not just the
  // declaration node — a caller minting a handle from this range (task_pack/
  // locate's C/C++ widening, or any other collectSymbols consumer) must
  // never be handed a range that starts INSIDE a docstring/comment node,
  // because a subsequent {handle, content} range-replace on such a range
  // leaves the doc block's own closing delimiter (e.g. a Python `"""`)
  // dangling outside the replaced span — a syntax error. `signatureStart*`
  // intentionally stays pointed at the real declaration line (skeleton
  // rendering wants the bare signature, not the doc block); only the
  // handle-mintable overall range widens.
  const docStartLine = docComment ? docComment.startLine : symbolStartLine;
  const docStartIndex = docComment ? (lineStarts[docStartLine - 1] ?? rangeNode.startIndex) : rangeNode.startIndex;
  return {
    name,
    kind,
    startLine: docStartLine,
    endLine: endLine(rangeNode, lineStarts),
    startIndex: docStartIndex,
    endIndex: rangeNode.endIndex,
    signatureStartIndex: rangeNode.startIndex,
    signatureEndIndex: signatureEndIndexFor(node, rangeNode),
    signatureStartLine: symbolStartLine,
    signatureEndLine: signatureEndLineFor(node, rangeNode, lineStarts),
    ...(enclosingSymbol ? { enclosingSymbol } : {}),
    ...(docComment ? { docComment } : {}),
  };
}

function declarationChildOfWrapper(node: TreeSitterNode): TreeSitterNode | undefined {
  return namedChildren(node).find((child) =>
    FUNCTION_TYPES.has(child.type) ||
    CLASS_TYPES.has(child.type) ||
    METHOD_TYPES.has(child.type) ||
    INTERFACE_TYPES.has(child.type) ||
    TYPE_ALIAS_TYPES.has(child.type) ||
    ENUM_TYPES.has(child.type) ||
    VARIABLE_DECL_TYPES.has(child.type)
  );
}

function symbolKindForContainer(node: TreeSitterNode): CollectedSymbolKind {
  if (INTERFACE_TYPES.has(node.type)) return "interface";
  if (ENUM_TYPES.has(node.type)) return "enum";
  return "class";
}

function visitNode(
  node: TreeSitterNode,
  text: string,
  lines: string[],
  lineStarts: number[],
  out: CollectedSymbol[],
  context: VisitContext = {},
): void {
  if (WRAPPER_TYPES.has(node.type)) {
    const child = declarationChildOfWrapper(node);
    if (child) {
      visitNode(child, text, lines, lineStarts, out, { ...context, rangeNode: node });
      return;
    }
  }

  const rangeNode = context.rangeNode ?? node;

  if (FUNCTION_TYPES.has(node.type)) {
    const name = nameOf(node, text);
    if (name) {
      out.push(makeSymbol(
        name,
        context.enclosingSymbol ? "method" : "function",
        node,
        rangeNode,
        text,
        lines,
        lineStarts,
        context.enclosingSymbol,
      ));
    }
    return;
  } else if (METHOD_TYPES.has(node.type)) {
    const name = nameOf(node, text);
    if (name) out.push(makeSymbol(name, "method", node, rangeNode, text, lines, lineStarts, context.enclosingSymbol));
    return;
  } else if (CLASS_TYPES.has(node.type) || INTERFACE_TYPES.has(node.type) || ENUM_TYPES.has(node.type)) {
    const name = nameOf(node, text);
    const kind = symbolKindForContainer(node);
    const symbol = name
      ? makeSymbol(name, kind, node, rangeNode, text, lines, lineStarts, context.enclosingSymbol)
      : undefined;
    if (symbol) out.push(symbol);
    const classContext = symbol
      ? { name: symbol.name, startLine: symbol.startLine, endLine: symbol.endLine, signatureStartLine: symbol.signatureStartLine }
      : context.enclosingSymbol;
    for (const child of namedChildren(node)) {
      visitNode(child, text, lines, lineStarts, out, { enclosingSymbol: classContext });
    }
    return;
  } else if (TYPE_ALIAS_TYPES.has(node.type)) {
    const name = nameOf(node, text);
    if (name) out.push(makeSymbol(name, "type", node, rangeNode, text, lines, lineStarts, context.enclosingSymbol));
    return;
  } else if (VARIABLE_DECL_TYPES.has(node.type)) {
    const kind = declarationKeyword(node, text);
    const single = hasSingleDeclarator(node);
    for (const child of namedChildren(node)) {
      if (!VARIABLE_DECLARATOR_TYPES.has(child.type)) continue;
      const name = nameOf(child, text);
      if (!name) continue;
      out.push(makeSymbol(
        name,
        kind,
        child,
        single ? rangeNode : child,
        text,
        lines,
        lineStarts,
        context.enclosingSymbol,
      ));
    }
    return;
  }

  for (const child of namedChildren(node)) {
    visitNode(child, text, lines, lineStarts, out, { enclosingSymbol: context.enclosingSymbol });
  }
}

export async function collectSymbols(
  text: string,
  language: string,
  paths: TreeSitterPaths = {},
): Promise<CollectedSymbol[]> {
  const normalized = language.toLowerCase();
  if (!COLLECTOR_LANGS.has(normalized)) return [];

  const lineStarts = computeLineStarts(text);
  const lines = splitLines(text);
  const symbols = await withTreeSitterRoot(text, language, paths, (root) => {
    const out: CollectedSymbol[] = [];
    for (const child of namedChildren(root)) {
      visitNode(child, text, lines, lineStarts, out);
    }
    return out;
  });

  return (symbols ?? []).sort((a, b) => a.startIndex - b.startIndex || a.endIndex - b.endIndex);
}
