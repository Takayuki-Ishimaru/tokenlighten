/** Bounded source context, NOT a whole-file no-change or runtime-correctness proof. */
import { createHash } from "node:crypto";
import { withTreeSitterRoot, type TreeSitterNode } from "../../skeleton/treeSitter.js";

const MAX_SOURCE_BYTES = 96 * 1024;
const MAX_AST_NODES = 12_000;
const MAX_CANDIDATE_SITES = 24;
const MAX_WINDOW_LINES = 8;
const MAX_USE_LINES = 16;
const MAX_PATHS = 4;
const MAX_WINDOWS = 12;
const MAX_CONTEXT_BYTES = 2048;

type Node = TreeSitterNode;
export interface EnumContextWindow {
  readonly start: number;
  readonly end: number;
  /** Exact lines from body, retaining CR characters when the input uses CRLF. */
  readonly text: string;
}
export interface EnumContextPair {
  readonly subject: string;
  readonly local: string;
  readonly binding: "value" | "type-only";
  readonly accessor: "values" | "keys" | "entries";
  readonly importWindow: EnumContextWindow;
  readonly useWindows: readonly EnumContextWindow[];
  readonly accessorRange: Readonly<{ start: number; end: number }>;
}
export interface EnumConsumerContext {
  readonly path: string;
  readonly sourceSha: string;
  readonly rank: number;
  /** type-only if ANY included runtime accessor has only a type import. */
  readonly binding: "value" | "type-only";
  readonly pairs: readonly EnumContextPair[];
  readonly windows: readonly EnumContextWindow[];
}

function sha(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex");
}
function relativeSourcePath(path: string): boolean {
  return path.length > 0 && !path.includes("\\") && !path.includes("\0")
    && !path.startsWith("/") && !/^[A-Za-z]:/.test(path)
    && path.split("/").every(part => part !== "" && part !== "." && part !== "..");
}
function language(path: string): string | undefined {
  if (/\.(?:ts|mts|cts)$/i.test(path)) return "typescript";
  if (/\.tsx$/i.test(path)) return "typescriptreact";
  if (/\.(?:js|mjs|cjs)$/i.test(path)) return "javascript";
  if (/\.jsx$/i.test(path)) return "javascriptreact";
  return undefined;
}
function children(node: Node): Node[] {
  const out: Node[] = [];
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child) out.push(child);
  }
  return out;
}
function errorFlag(node: Node, key: "hasError" | "isMissing"): boolean {
  const value = (node as Node & Record<typeof key, boolean | (() => boolean)>)[key];
  return typeof value === "function" ? value.call(node) : value === true;
}
function identifierNames(node: Node | null): string[] {
  if (!node) return [];
  const out: string[] = [];
  const queue = [node];
  while (queue.length) {
    const current = queue.pop()!;
    if (current.type === "identifier" || current.type === "type_identifier" || current.type === "shorthand_property_identifier_pattern") {
      out.push(`${current.startIndex}:${current.endIndex}`);
    } else if (!/type_annotation|type_arguments/.test(current.type)) queue.push(...children(current));
  }
  return out;
}
function splitWindow(lines: readonly string[], start: number, end: number): EnumContextWindow[] {
  const out: EnumContextWindow[] = [];
  for (let line = start; line <= end; line += MAX_WINDOW_LINES) {
    const last = Math.min(line + MAX_WINDOW_LINES - 1, end);
    out.push({ start: line, end: last, text: lines.slice(line - 1, last).join("\n") });
  }
  return out;
}
function unionWindows(lines: readonly string[], windows: readonly EnumContextWindow[]): EnumContextWindow[] {
  const spans = windows.map(({ start, end }) => ({ start, end })).sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: Array<{ start: number; end: number }> = [];
  for (const span of spans) {
    const last = merged[merged.length - 1];
    if (last && span.start <= last.end + 1) last.end = Math.max(last.end, span.end);
    else merged.push({ ...span });
  }
  return merged.flatMap(({ start, end }) => splitWindow(lines, start, end));
}
const EXPRESSION_WRAPPERS = new Set([
  "call_expression", "member_expression", "subscript_expression", "parenthesized_expression",
  "as_expression", "satisfies_expression", "non_null_expression", "ternary_expression",
  "binary_expression", "unary_expression", "await_expression", "array", "object", "pair",
  "jsx_expression", "jsx_attribute", "variable_declarator", "lexical_declaration",
  "variable_declaration", "return_statement", "expression_statement",
]);
const FUNCTION_BOUNDARIES = new Set([
  "function_declaration", "function_expression", "generator_function_declaration",
  "generator_function", "arrow_function", "method_definition", "program",
]);

/** Syntax-backed import + accessor windows. Undefined means abstention, never absence proof. */
export async function analyzeEnumConsumerContext(
  path: string, body: string, subjectNames: string[], rank: number,
): Promise<EnumConsumerContext | undefined> {
  const lang = language(path);
  if (!relativeSourcePath(path) || !lang || !Number.isFinite(rank)
    || Buffer.byteLength(body, "utf8") > MAX_SOURCE_BYTES || body.includes("\0")) return undefined;
  const subjects = new Set(subjectNames.filter(name => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)));
  if (subjects.size === 0 || subjects.size > 32) return undefined;
  const lines = body.split("\n");
  const starts = [0];
  for (let i = 0; i < body.length; i++) if (body[i] === "\n") starts.push(i + 1);
  const lineAt = (offset: number): number => {
    let lo = 0, hi = starts.length;
    while (lo + 1 < hi) { const mid = (lo + hi) >>> 1; if (starts[mid]! <= offset) lo = mid; else hi = mid; }
    return lo + 1;
  };
  const span = (node: Node): { start: number; end: number } => ({
    start: lineAt(node.startIndex), end: lineAt(Math.max(node.startIndex, node.endIndex - 1)),
  });
  const text = (node: Node): string => body.slice(node.startIndex, node.endIndex);
  return withTreeSitterRoot(body, lang, {}, root => {
    if (errorFlag(root, "hasError")) return undefined;
    const nodes: Node[] = [];
    const parent = new Map<Node, Node>();
    const queue = [root];
    while (queue.length) {
      const node = queue.pop()!;
      if (nodes.length >= MAX_AST_NODES || node.type === "ERROR" || errorFlag(node, "isMissing")) return undefined;
      nodes.push(node);
      for (const child of children(node)) { parent.set(child, node); queue.push(child); }
    }
    type Binding = { subject: string; local: string; binding: "value" | "type-only"; declaration: Node };
    const bindings = new Map<string, Binding>();
    const allImports = new Map<string, number>();
    for (const statement of nodes.filter(node => node.type === "import_statement")) {
      const requireClause = children(statement).find(node => node.type === "import_require_clause");
      const requireLocal = requireClause && children(requireClause).find(node => node.type === "identifier");
      if (requireLocal) allImports.set(text(requireLocal), (allImports.get(text(requireLocal)) ?? 0) + 1);
      const clause = children(statement).find(node => node.type === "import_clause");
      if (!clause) continue;
      const stripPrefixComments = (value: string): string => value.replace(/\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g, " ");
      const clauseTypeOnly = /^import\s+type\b/.test(stripPrefixComments(body.slice(statement.startIndex, clause.startIndex)));
      const parts = children(clause);
      for (const part of parts) {
        if (part.type === "identifier") allImports.set(text(part), (allImports.get(text(part)) ?? 0) + 1);
        if (part.type === "namespace_import") {
          const id = children(part).find(node => node.type === "identifier");
          if (id) allImports.set(text(id), (allImports.get(text(id)) ?? 0) + 1);
        }
        if (part.type !== "named_imports") continue;
        for (const specifier of children(part)) {
          if (specifier.type !== "import_specifier") continue;
          const name = specifier.childForFieldName("name");
          const alias = specifier.childForFieldName("alias");
          if (!name || name.type !== "identifier" || (alias && alias.type !== "identifier")) continue;
          const local = text(alias ?? name);
          allImports.set(local, (allImports.get(local) ?? 0) + 1);
          if (subjects.has(text(name))) bindings.set(local, {
            subject: text(name), local, declaration: statement,
            binding: clauseTypeOnly || /^type\s/.test(stripPrefixComments(text(specifier))) ? "type-only" : "value",
          });
        }
      }
    }
    if (bindings.size === 0 || allImports.has("Object")) return undefined;
    if ([...bindings.keys()].some(name => allImports.get(name) !== 1)) return undefined;
    const watched = new Set(["Object", ...bindings.keys()]);
    const patternHasWatched = (pattern: Node | null): boolean => identifierNames(pattern).some(position => {
      const [start, end] = position.split(":").map(Number);
      return watched.has(body.slice(start!, end!));
    });
    // Deliberately conservative across the whole file, including unrelated scopes.
    for (const node of nodes) {
      let declaration: Node | null = null;
      if (node.type === "variable_declarator") declaration = node.childForFieldName("name");
      else if (node.type === "formal_parameters") declaration = node;
      else if (["required_parameter", "optional_parameter"].includes(node.type)) {
        declaration = node.childForFieldName("pattern") ?? node.childForFieldName("name") ?? children(node)[0] ?? null;
      } else if (node.type === "arrow_function") declaration = node.childForFieldName("parameter");
      else if (node.type === "catch_clause") declaration = node.childForFieldName("parameter");
      else if (["function_declaration", "function_expression", "generator_function_declaration", "generator_function",
        "class_declaration", "class", "enum_declaration", "interface_declaration", "type_alias_declaration", "type_parameter", "internal_module", "module"].includes(node.type)) {
        declaration = node.childForFieldName("name");
      } else if (["assignment_expression", "augmented_assignment_expression", "for_in_statement"].includes(node.type)) declaration = node.childForFieldName("left");
      else if (node.type === "update_expression") declaration = node.childForFieldName("argument");
      if (patternHasWatched(declaration)) return undefined;
    }
    const pairs: EnumContextPair[] = [];
    const calls = nodes.filter(node => node.type === "call_expression").sort((a, b) => a.startIndex - b.startIndex);
    for (const call of calls) {
      const fn = call.childForFieldName("function");
      const args = call.childForFieldName("arguments");
      if (!fn || fn.type !== "member_expression" || !args) continue;
      const receiver = fn.childForFieldName("object"), method = fn.childForFieldName("property");
      if (!receiver || receiver.type !== "identifier" || text(receiver) !== "Object" || !method
        || !["values", "keys", "entries"].includes(text(method))) continue;
      // Reject optional/computed variants; this helper has a deliberately narrow syntax contract.
      if (!/^Object\s*\.\s*(values|keys|entries)$/.test(text(fn))) continue;
      const argumentsList = children(args).filter(node => node.type !== "comment");
      if (argumentsList.length !== 1 || argumentsList[0]!.type !== "identifier") continue;
      const binding = bindings.get(text(argumentsList[0]!));
      if (!binding) continue;
      if (pairs.length >= MAX_CANDIDATE_SITES) return undefined;
      const importSpan = span(binding.declaration);
      if (importSpan.end - importSpan.start + 1 > MAX_WINDOW_LINES) return undefined;
      let outer = call;
      while (parent.has(outer) && EXPRESSION_WRAPPERS.has(parent.get(outer)!.type)) outer = parent.get(outer)!;
      let useSpan = span(outer);
      if (useSpan.end - useSpan.start + 1 > MAX_USE_LINES) return undefined;
      for (let ancestor = parent.get(outer); ancestor && !FUNCTION_BOUNDARIES.has(ancestor.type); ancestor = parent.get(ancestor)) {
        if (ancestor.type !== "if_statement") continue;
        const ifSpan = span(ancestor);
        if (ifSpan.end - ifSpan.start + 1 <= MAX_USE_LINES) useSpan = ifSpan;
        break;
      }
      pairs.push({
        subject: binding.subject, local: binding.local, binding: binding.binding,
        accessor: text(method) as EnumContextPair["accessor"],
        importWindow: splitWindow(lines, importSpan.start, importSpan.end)[0]!,
        useWindows: splitWindow(lines, useSpan.start, useSpan.end), accessorRange: span(call),
      });
    }
    if (pairs.length === 0) return undefined;
    const windows = unionWindows(lines, pairs.flatMap(pair => [pair.importWindow, ...pair.useWindows]));
    return { path, sourceSha: sha(body), rank, binding: pairs.some(pair => pair.binding === "type-only") ? "type-only" : "value", pairs, windows };
  });
}

/** Pure admission. Each path's import/use bundle is accepted whole or omitted whole. */
export function boundEnumConsumerContexts(
  plans: readonly EnumConsumerContext[], sources: ReadonlyMap<string, string>, primaryPaths: ReadonlySet<string>,
): EnumConsumerContext[] {
  const accepted: EnumConsumerContext[] = [];
  const paths = new Set<string>();
  let windowsUsed = 0, bytesUsed = 0;
  for (const plan of [...plans].sort((a, b) => a.rank - b.rank || a.path.localeCompare(b.path))) {
    if (accepted.length >= MAX_PATHS) break;
    const body = sources.get(plan.path);
    if (!relativeSourcePath(plan.path) || primaryPaths.has(plan.path) || paths.has(plan.path)
      || !Number.isFinite(plan.rank) || body === undefined || Buffer.byteLength(body, "utf8") > MAX_SOURCE_BYTES
      || !/^[a-f0-9]{64}$/.test(plan.sourceSha) || sha(body) !== plan.sourceSha || plan.pairs.length === 0
      || plan.pairs.length > MAX_CANDIDATE_SITES) continue;
    const lines = body.split("\n");
    const valid = (window: EnumContextWindow): boolean => Number.isSafeInteger(window.start)
      && Number.isSafeInteger(window.end) && window.start > 0 && window.end >= window.start
      && window.end <= lines.length && window.end - window.start + 1 <= MAX_WINDOW_LINES
      && window.text === lines.slice(window.start - 1, window.end).join("\n");
    const pairValid = (pair: EnumContextPair): boolean => valid(pair.importWindow)
      && ["value", "type-only"].includes(pair.binding) && ["values", "keys", "entries"].includes(pair.accessor)
      && pair.useWindows.length > 0 && pair.useWindows.length <= 2 && pair.useWindows.every(valid)
      && pair.useWindows.every((window, i) => i === 0 || window.start === pair.useWindows[i - 1]!.end + 1)
      && Number.isSafeInteger(pair.accessorRange.start) && Number.isSafeInteger(pair.accessorRange.end)
      && pair.accessorRange.end >= pair.accessorRange.start
      && pair.accessorRange.start >= pair.useWindows[0]!.start
      && pair.accessorRange.end <= pair.useWindows[pair.useWindows.length - 1]!.end;
    if (!plan.pairs.every(pairValid)) continue;
    const expected = unionWindows(lines, plan.pairs.flatMap(pair => [pair.importWindow, ...pair.useWindows]));
    if (plan.windows.length !== expected.length || !plan.windows.every((window, i) => valid(window)
      && window.start === expected[i]!.start && window.end === expected[i]!.end && window.text === expected[i]!.text)
      || plan.binding !== (plan.pairs.some(pair => pair.binding === "type-only") ? "type-only" : "value")) continue;
    const bytes = expected.reduce((sum, window) => sum + Buffer.byteLength(window.text, "utf8"), 0);
    if (windowsUsed + expected.length > MAX_WINDOWS || bytesUsed + bytes > MAX_CONTEXT_BYTES) continue;
    accepted.push(plan); paths.add(plan.path); windowsUsed += expected.length; bytesUsed += bytes;
  }
  return accepted;
}
