// Tree-sitter skeletonization for @tokenlighten/mcp-server.
//
// Ported from proto/src/compress/treeSitter.ts — VSCode imports stripped.
// Output is PLAIN text: no meta envelope, no 'tokenlighten:meta' wrappers.
// Reason: docs/00-postmortem.md §2.2 — meta envelope dominated cache_write cost.
//
// Supports 12 languages + HTML + CSS via web-tree-sitter WASM (no native bindings).
// Falls back gracefully when the WASM runtime cannot be loaded.
//
// WASM resolution: npm hoists web-tree-sitter and tree-sitter-wasms to the
// monorepo root node_modules. We use createRequire(import.meta.url) so that
// Node's module resolution walks up to wherever the packages actually live,
// regardless of whether we're running from src/ (tests) or dist/ (production).

import { createRequire } from "node:module";
import { dirname, join } from "path";
import type { TreeSitterPaths } from "./types.js";

export type { TreeSitterPaths };

/** vscode languageId → tree-sitter-wasms grammar file basename. */
const GRAMMARS: Record<string, string> = {
  go: "go",
  rust: "rust",
  java: "java",
  c: "c",
  cpp: "cpp",
  ruby: "ruby",
  python: "python",
  csharp: "c_sharp",
  php: "php",
  kotlin: "kotlin",
  javascript: "javascript",
  javascriptreact: "tsx",
  typescript: "typescript",
  typescriptreact: "tsx",
  html: "html",
  css: "css",
};

type BodyStyle = "brace" | "endkw" | "colon";

interface LangRule {
  funcTypes: Set<string>;
  containerTypes: Set<string>;
  wrapperTypes: Set<string>;
  bodyField: string;
  style: BodyStyle;
}

function rule(
  funcTypes: string[],
  containerTypes: string[],
  style: BodyStyle,
  wrapperTypes: string[] = [],
): LangRule {
  return {
    funcTypes: new Set(funcTypes),
    containerTypes: new Set(containerTypes),
    wrapperTypes: new Set(wrapperTypes),
    bodyField: "body",
    style,
  };
}

const RULES: Record<string, LangRule> = {
  go: rule(["function_declaration", "method_declaration"], [], "brace"),
  rust: rule(["function_item"], ["impl_item", "trait_item"], "brace"),
  java: rule(
    ["method_declaration", "constructor_declaration"],
    ["class_declaration", "interface_declaration", "enum_declaration", "record_declaration"],
    "brace",
  ),
  c: rule(["function_definition"], [], "brace"),
  cpp: rule(["function_definition"], ["class_specifier", "struct_specifier"], "brace"),
  ruby: rule(["method", "singleton_method"], ["class", "module"], "endkw"),
  python: rule(["function_definition"], ["class_definition"], "colon", ["decorated_definition"]),
  csharp: rule(
    [
      "method_declaration",
      "constructor_declaration",
      "destructor_declaration",
      "operator_declaration",
    ],
    [
      "class_declaration",
      "interface_declaration",
      "struct_declaration",
      "record_declaration",
      "enum_declaration",
      "namespace_declaration",
    ],
    "brace",
  ),
  php: rule(
    ["function_definition", "method_declaration"],
    [
      "class_declaration",
      "interface_declaration",
      "trait_declaration",
      "enum_declaration",
      "namespace_definition",
    ],
    "brace",
  ),
  kotlin: rule(["function_declaration"], ["class_declaration", "object_declaration"], "brace"),
  javascript: rule(
    ["function_declaration", "generator_function_declaration", "method_definition"],
    ["class_declaration"],
    "brace",
    ["export_statement"],
  ),
  javascriptreact: rule(
    ["function_declaration", "generator_function_declaration", "method_definition"],
    ["class_declaration"],
    "brace",
    ["export_statement"],
  ),
  typescript: rule(
    ["function_declaration", "generator_function_declaration", "method_definition"],
    ["class_declaration", "abstract_class_declaration", "internal_module", "module"],
    "brace",
    ["export_statement"],
  ),
  typescriptreact: rule(
    ["function_declaration", "generator_function_declaration", "method_definition"],
    ["class_declaration", "abstract_class_declaration", "internal_module", "module"],
    "brace",
    ["export_statement"],
  ),
};

export function treeSitterSupports(language: string): boolean {
  const key = language.toLowerCase();
  return key === "html" || key === "css" || key in RULES;
}

// Structural type — avoids coupling to a specific web-tree-sitter .d.ts version.
export type TreeSitterNode = {
  type: string;
  startIndex: number;
  endIndex: number;
  startPosition?: { row: number; column: number };
  endPosition?: { row: number; column: number };
  namedChildCount: number;
  namedChild(i: number): TreeSitterNode | null;
  childForFieldName(name: string): TreeSitterNode | null;
};

type AnyNode = TreeSitterNode;

let initPromise: Promise<void> | null = null;
const langCache = new Map<string, unknown>();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let cachedParserCtor: any;

/**
 * Resolve the web-tree-sitter Parser class exactly once and cache it, so
 * every caller below reuses the SAME reference instead of each doing its
 * own `import("web-tree-sitter")`.
 *
 * web-tree-sitter ships as a dual CJS/UMD module. Verified empirically:
 * once esbuild bundles it for dynamic `import("web-tree-sitter")`, a
 * SECOND call site for the identical specifier is not guaranteed to
 * observe the fully-initialized shape — it can see the raw, pre-init
 * Emscripten `Module` object instead of the `Parser` class with its
 * `.Language`/`.init` statics attached, even though the exact same import
 * works correctly unbundled and a single call site works fine bundled.
 * (packages/vscode-extension/scripts/bundle-cli.mjs bundles this module;
 * this file previously had three separate `import("web-tree-sitter")`
 * call sites, which reproduced the corrupted-shape failure — silently, via
 * loadLanguage's catch — turning every skeleton request into the regex
 * fallback.) Resolving once and reusing the reference sidesteps that.
 *
 * Exported so ../core2/syntax.ts's Parser bootstrap can reuse this SAME
 * resolved reference too, instead of adding another
 * `import("web-tree-sitter")` call site that would reproduce the exact
 * bundling risk described above (both files land in the same bundled
 * mcp-server bin.js — see bundle-cli.mjs).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function getParserCtor(): Promise<any> {
  if (!cachedParserCtor) {
    const mod = await import("web-tree-sitter");
    cachedParserCtor = mod.default;
  }
  return cachedParserCtor;
}

// Pre-resolve WASM paths once via createRequire so Node's module resolution
// walks up to whichever node_modules actually holds these packages (monorepo
// root when npm hoists, package-local otherwise). Cached at module load time.
const _require = createRequire(import.meta.url);

function resolveRuntimeWasmDefault(): string {
  try {
    const pkgJson = _require.resolve("web-tree-sitter/package.json");
    return join(dirname(pkgJson), "tree-sitter.wasm");
  } catch {
    return "tree-sitter.wasm"; // last-resort: let web-tree-sitter try its default
  }
}

function resolveGrammarDirDefault(): string {
  try {
    const pkgJson = _require.resolve("tree-sitter-wasms/package.json");
    return join(dirname(pkgJson), "out");
  } catch {
    return "out";
  }
}

const _defaultRuntimeWasm: string = resolveRuntimeWasmDefault();
const _defaultGrammarDir: string = resolveGrammarDirDefault();

function resolveRuntimeWasm(paths: TreeSitterPaths): string {
  return paths.runtimeWasm ?? _defaultRuntimeWasm;
}

function resolveGrammarDir(paths: TreeSitterPaths): string {
  return paths.grammarDir ?? _defaultGrammarDir;
}

async function ensureInit(runtimeWasm: string): Promise<void> {
  if (!initPromise) {
    const Parser = await getParserCtor();
    initPromise = Parser.init({ locateFile: (name: string) => name === 'tree-sitter.wasm' ? runtimeWasm : name });
  }
  await initPromise;
}

async function loadLanguage(key: string, paths: TreeSitterPaths): Promise<unknown | undefined> {
  try {
    const runtimeWasm = resolveRuntimeWasm(paths);
    await ensureInit(runtimeWasm);
    const cached = langCache.get(key);
    if (cached) return cached;
    const Parser = await getParserCtor();
    const grammar = GRAMMARS[key];
    if (!grammar) return undefined;
    const wasmPath = join(resolveGrammarDir(paths), `tree-sitter-${grammar}.wasm`);
    const lang = await Parser.Language.load(wasmPath);
    langCache.set(key, lang);
    return lang;
  } catch {
    return undefined;
  }
}

const KEEP_COMMENT = /^\s*(\/\/\/|\/\*\*)|\b(TODO|FIXME|HACK|SECURITY|WARNING|@deprecated)\b/i;

function rtrim(s: string): string {
  return s.replace(/\s+$/, "");
}

function indentText(s: string, n: number): string {
  const pad = " ".repeat(n);
  return s
    .split("\n")
    .map((l) => (l.length ? pad + l : l))
    .join("\n");
}

function funcSkeleton(sig: string, style: BodyStyle): string {
  if (style === "brace") return `${sig} { ... }`;
  if (style === "endkw") return `${sig}\n  # ...\nend`;
  return `${sig} ...`;
}

function containerSkeleton(header: string, members: string[], style: BodyStyle): string {
  const body = members.join("\n");
  if (style === "brace") return `${header} {\n${body}\n}`;
  if (style === "endkw") return `${header}\n${body}\nend`;
  return `${header}\n${body}`;
}

function terminator(style: BodyStyle): string {
  return style === "brace" ? ";" : "";
}

function trailingSemicolon(src: string, node: AnyNode): string {
  let i = node.endIndex;
  while (i < src.length && (src[i] === " " || src[i] === "\t")) i++;
  return src[i] === ";" ? ";" : "";
}

function namedChildren(node: AnyNode): AnyNode[] {
  const out: AnyNode[] = [];
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i);
    if (c) out.push(c);
  }
  return out;
}

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
  "enum_class_body",
]);

function findBody(node: AnyNode, bodyField: string): AnyNode | null {
  const f = node.childForFieldName(bodyField);
  if (f) return f;
  for (let i = node.namedChildCount - 1; i >= 0; i--) {
    const c = node.namedChild(i);
    if (c && BODY_TYPES.has(c.type)) return c;
  }
  return null;
}

function renderChildren(nodes: AnyNode[], src: string, r: LangRule): string[] {
  const rendered: string[] = new Array(nodes.length).fill("");
  let attachRight = false;
  for (let i = nodes.length - 1; i >= 0; i--) {
    const node = nodes[i]!;
    if (node.type.includes("comment")) {
      const t = src.slice(node.startIndex, node.endIndex);
      const keep: boolean = KEEP_COMMENT.test(t) || attachRight;
      rendered[i] = keep ? rtrim(t) : "";
      attachRight = keep;
    } else {
      const out = renderNode(node, src, r);
      rendered[i] = out;
      attachRight = out.length > 0;
    }
  }
  return rendered.filter((x) => x.length > 0);
}

function renderNode(node: AnyNode, src: string, r: LangRule): string {
  const type = node.type;

  if (r.wrapperTypes.has(type)) {
    const inner = namedChildren(node).find(
      (c) => r.funcTypes.has(c.type) || r.containerTypes.has(c.type),
    );
    if (inner) {
      const gap = src.slice(node.startIndex, inner.startIndex);
      const prefix = rtrim(gap);
      const sep = gap.includes("\n") ? "\n" : " ";
      const body = renderNode(inner, src, r);
      return prefix ? `${prefix}${sep}${body}` : body;
    }
    return rtrim(src.slice(node.startIndex, node.endIndex));
  }

  if (r.funcTypes.has(type)) {
    const body = findBody(node, r.bodyField);
    const sigEnd = body ? body.startIndex : node.endIndex;
    const sig = rtrim(src.slice(node.startIndex, sigEnd));
    return body ? funcSkeleton(sig, r.style) : `${sig}${terminator(r.style)}`;
  }

  if (r.containerTypes.has(type)) {
    const body = findBody(node, r.bodyField);
    const header = rtrim(src.slice(node.startIndex, body ? body.startIndex : node.endIndex));
    if (!body) return `${header}${terminator(r.style)}`;
    const members = renderChildren(namedChildren(body), src, r).map((m) =>
      indentText(m, 2),
    );
    return containerSkeleton(header, members, r.style) + trailingSemicolon(src, node);
  }

  if (type.includes("comment")) {
    const t = src.slice(node.startIndex, node.endIndex);
    return KEEP_COMMENT.test(t) ? rtrim(t) : "";
  }

  if (type === "access_specifier") {
    const t = rtrim(src.slice(node.startIndex, node.endIndex));
    return t.endsWith(":") ? t : `${t}:`;
  }

  return rtrim(src.slice(node.startIndex, node.endIndex));
}

// --- HTML skeleton -----------------------------------------------------------

const HTML_KEEP_ATTR = /^(id|class)\b/i;
const HTML_MAX_LINES = 400;
const HTML_ELEMENTS = new Set(["element", "script_element", "style_element"]);

function childByType(node: AnyNode, type: string): AnyNode | null {
  for (const c of namedChildren(node)) if (c.type === type) return c;
  return null;
}

function htmlTagInfo(tag: AnyNode, src: string): { name: string; attrs: string } {
  let name = "?";
  const kept: string[] = [];
  for (const c of namedChildren(tag)) {
    if (c.type === "tag_name") name = src.slice(c.startIndex, c.endIndex);
    else if (c.type === "attribute") {
      const txt = src.slice(c.startIndex, c.endIndex);
      if (HTML_KEEP_ATTR.test(txt)) kept.push(txt);
    }
  }
  return { name, attrs: kept.length ? " " + kept.join(" ") : "" };
}

function renderHtml(root: AnyNode, src: string): string {
  const lines: string[] = [];
  const visit = (node: AnyNode, depth: number): void => {
    if (lines.length >= HTML_MAX_LINES) return;
    if (HTML_ELEMENTS.has(node.type)) {
      const start = childByType(node, "start_tag") ?? childByType(node, "self_closing_tag");
      if (!start) return;
      const { name, attrs } = htmlTagInfo(start, src);
      const pad = "  ".repeat(Math.min(depth, 12));
      const childEls = namedChildren(node).filter((c) => HTML_ELEMENTS.has(c.type));
      if (childEls.length === 0) {
        const hasEnd = !!childByType(node, "end_tag");
        lines.push(hasEnd ? `${pad}<${name}${attrs}>…</${name}>` : `${pad}<${name}${attrs}>`);
      } else {
        lines.push(`${pad}<${name}${attrs}>`);
        for (const c of childEls) visit(c, depth + 1);
        lines.push(`${pad}</${name}>`);
      }
    } else {
      for (const c of namedChildren(node)) visit(c, depth);
    }
  };
  for (const c of namedChildren(root)) visit(c, 0);
  return lines.join("\n");
}

// --- CSS custom-property capture (A9) ---------------------------------------
//
// CSS declarations (`--foo-bar: value;`) don't fit the func/class RULES model
// (no signature+body shape), so CSS gets its own lightweight visitor instead
// of being shoehorned into renderChildren. Only custom properties (name
// starts with "--") are captured — regular declarations (`color: red;`) are
// noise for style-surface resolution and are skipped.

export interface CssCustomProperty {
  /** Property name including the leading "--" (e.g. "--color-priority-critical"). */
  name: string;
  /** 1-based line number of the declaration. */
  line: number;
  /** Trimmed declaration text (e.g. "--color-priority-critical: #ffcc00;"), capped at 120 chars. */
  text: string;
}

const CSS_DECLARATION_TYPES = new Set(["declaration"]);
const CSS_MAX_TEXT_CHARS = 120;

function cssLineOf(node: AnyNode, src: string): number {
  if (node.startPosition) return node.startPosition.row + 1;
  let line = 1;
  for (let i = 0; i < node.startIndex && i < src.length; i++) {
    if (src[i] === "\n") line++;
  }
  return line;
}

function walkCssDeclarations(node: AnyNode, src: string, out: CssCustomProperty[]): void {
  if (CSS_DECLARATION_TYPES.has(node.type)) {
    const propertyName = node.childForFieldName("property_name") ??
      namedChildren(node).find((c) => c.type === "property_name");
    if (propertyName) {
      const name = src.slice(propertyName.startIndex, propertyName.endIndex).trim();
      if (name.startsWith("--")) {
        const raw = src.slice(node.startIndex, node.endIndex).trim().replace(/\s+/g, " ");
        out.push({
          name,
          line: cssLineOf(node, src),
          text: raw.length > CSS_MAX_TEXT_CHARS ? raw.slice(0, CSS_MAX_TEXT_CHARS - 1) + "…" : raw,
        });
      }
    }
    return; // declarations do not nest further declarations.
  }
  for (const c of namedChildren(node)) walkCssDeclarations(c, src, out);
}

/**
 * Extract `--custom-property: value;` declarations from a parsed CSS root,
 * in source order. Used for A9 style-surface discoverability (e.g. finding
 * `--color-priority-critical` when a task references PRIORITY_CRITICAL).
 */
function extractCssCustomPropertiesFromRoot(root: AnyNode, src: string): CssCustomProperty[] {
  const out: CssCustomProperty[] = [];
  walkCssDeclarations(root, src, out);
  return out;
}

/** Compact textual skeleton for CSS: one line per custom-property declaration. */
function renderCssCustomProperties(root: AnyNode, src: string): string {
  const props = extractCssCustomPropertiesFromRoot(root, src);
  return props.map((p) => p.text).join("\n");
}

/**
 * Parse `text` as CSS and return its `--custom-property` declarations.
 * Returns [] when the CSS grammar cannot be loaded (WASM missing, parse
 * failure) rather than throwing — callers should treat that as "no
 * structural signal available" and fall back to lexical search.
 */
export async function extractCssCustomProperties(
  text: string,
  paths: TreeSitterPaths = {},
): Promise<CssCustomProperty[]> {
  const result = await withTreeSitterRoot(text, "css", paths, (root, key) =>
    key === "css" ? extractCssCustomPropertiesFromRoot(root, text) : [],
  );
  return result ?? [];
}

// --- CSS structural outline (selectors + at-rules) --------------------------
//
// Bounded, no cascade semantics: one line per top-level rule_set's selector
// text, and one line per at-rule's prelude, recursing exactly ONE level into
// an at-rule's own nested rules (or, for @keyframes, its keyframe_blocks —
// the grammar's keyframe-specific analog of a nested rule_set; see
// cssKeyframeSelectorText). Declaration bodies are never rendered here —
// that stays out of scope for an outline; the one declaration shape this
// module DOES surface is the existing `--custom-property` capture above.
//
// Node type names below were confirmed empirically against the shipped
// tree-sitter-wasms css grammar (childForFieldName() returns nothing for
// this WASM build's field metadata, same as walkCssDeclarations' own
// fallback above, so matching is by child TYPE throughout — not by field).

/** Child-node types that hold an at-rule's own body block. `block` covers
 * every at-rule except `@keyframes`, whose body is a `keyframe_block_list`. */
const CSS_BLOCK_TYPES = new Set(["block", "keyframe_block_list"]);

/** Nested-rule node types this outline recurses ONE level into: a plain
 * `rule_set` (e.g. `.card { ... }` inside `@media`), or a `keyframe_block`
 * (e.g. `from { ... }` / `50% { ... }` inside `@keyframes`). */
const CSS_NESTED_RULE_TYPES = new Set(["rule_set", "keyframe_block"]);

/** At-rule statement types with a dedicated grammar node (each maps 1:1 to
 * one at-rule keyword). */
const CSS_AT_RULE_STATEMENT_TYPES = new Set([
  "media_statement", // @media
  "supports_statement", // @supports
  "keyframes_statement", // @keyframes
  "import_statement", // @import
]);

/** `@layer` and `@font-face` have NO dedicated grammar node — both parse as
 * the grammar's generic `at_rule` fallback, shared with every OTHER at-rule
 * (`@page`, `@property`, `@container`, `@scope`, `@counter-style`,
 * `@viewport`, ...). Disambiguated here by the node's own `at_keyword` text
 * so only these two verified-shape keywords are recognized; any other
 * generic at-rule is intentionally left out of the outline (unverified
 * shape — out of this bounded pass's scope). */
const CSS_GENERIC_AT_KEYWORDS = new Set(["@layer", "@font-face"]);

/** True when `node` is one of the six at-rule kinds this outline recognizes. */
function isRecognizedCssAtRule(node: AnyNode, src: string): boolean {
  if (CSS_AT_RULE_STATEMENT_TYPES.has(node.type)) return true;
  if (node.type !== "at_rule") return false;
  const keyword = namedChildren(node).find((c) => c.type === "at_keyword");
  if (!keyword) return false;
  return CSS_GENERIC_AT_KEYWORDS.has(src.slice(keyword.startIndex, keyword.endIndex).toLowerCase());
}

/** Trim, collapse internal whitespace (including newlines) to single spaces,
 * and cap length — same shape CssCustomProperty.text already uses above. */
function collapseCssText(raw: string, maxChars: number = CSS_MAX_TEXT_CHARS): string {
  const collapsed = raw.trim().replace(/\s+/g, " ");
  return collapsed.length > maxChars ? collapsed.slice(0, maxChars - 1) + "…" : collapsed;
}

/** `node`'s own body-block child (a "block", or a keyframes' own
 * "keyframe_block_list"), or undefined for a bodyless statement
 * (`@import ...;`, a bare `@layer name;`, etc). */
function cssBlockChild(node: AnyNode): AnyNode | undefined {
  return namedChildren(node).find((c) => CSS_BLOCK_TYPES.has(c.type));
}

/** A rule_set's own selector text (e.g. ".card, .card--active"), one line,
 * whitespace-collapsed, capped. Falls back to the rule_set's own header text
 * (up to its block) when no "selectors" child is found — defensive; every
 * observed grammar build always has one. */
function cssSelectorText(ruleSet: AnyNode, src: string): string {
  const selectors = namedChildren(ruleSet).find((c) => c.type === "selectors");
  if (selectors) return collapseCssText(src.slice(selectors.startIndex, selectors.endIndex));
  const block = cssBlockChild(ruleSet);
  const end = block ? block.startIndex : ruleSet.endIndex;
  return collapseCssText(src.slice(ruleSet.startIndex, end));
}

/** A keyframe_block's own selector text (e.g. "from", "50%") — everything up
 * to its own nested "block" child, same shape as cssSelectorText. */
function cssKeyframeSelectorText(block: AnyNode, src: string): string {
  const body = namedChildren(block).find((c) => c.type === "block");
  const end = body ? body.startIndex : block.endIndex;
  return collapseCssText(src.slice(block.startIndex, end));
}

/** An at-rule's own prelude text (e.g. "@media (max-width: 600px)",
 * "@keyframes spin", "@layer base", "@font-face"): everything up to its body
 * block, or the whole statement when it has none. */
function cssPreludeText(node: AnyNode, src: string): string {
  const block = cssBlockChild(node);
  const end = block ? block.startIndex : node.endIndex;
  return collapseCssText(src.slice(node.startIndex, end));
}

/**
 * Render one top-level CSS construct as an outline entry (possibly multi-line
 * for a container at-rule). Returns undefined for anything that is neither a
 * rule_set nor a recognized at-rule (comments, ERROR nodes, unrecognized
 * generic at-rules — all silently omitted, not an error).
 */
function renderCssOutlineNode(node: AnyNode, src: string): string | undefined {
  if (node.type === "rule_set") return cssSelectorText(node, src);
  if (!isRecognizedCssAtRule(node, src)) return undefined;

  const prelude = cssPreludeText(node, src);
  const block = cssBlockChild(node);
  if (!block) return prelude; // bodyless: `@import ...;` / bare `@layer name;`

  const nested = namedChildren(block).filter((c) => CSS_NESTED_RULE_TYPES.has(c.type));
  if (nested.length === 0) return `${prelude} { ... }`; // has a body, but no nested rule to show (e.g. @font-face's declarations)

  const lines = nested.map((n) =>
    n.type === "keyframe_block" ? cssKeyframeSelectorText(n, src) : cssSelectorText(n, src),
  );
  return containerSkeleton(prelude, lines.map((l) => indentText(l, 2)), "brace");
}

/**
 * Compact structural outline of a parsed CSS root: one line per top-level
 * rule_set selector, one prelude line per recognized at-rule (recursing one
 * level into its own nested rule_sets/keyframe_blocks). Source order
 * preserved, matching every other language's renderer in this file.
 */
function renderCssOutline(root: AnyNode, src: string): string {
  const lines: string[] = [];
  for (const child of namedChildren(root)) {
    const rendered = renderCssOutlineNode(child, src);
    if (rendered) lines.push(rendered);
  }
  return lines.join("\n");
}

/**
 * Combined CSS skeleton: the structural outline above, followed by the
 * existing `--custom-property` capture, each as its own block — mirrors the
 * "\n\n"-joined block convention renderChildren() uses for func/class
 * languages. Either half may be empty (e.g. a stylesheet with no custom
 * properties, or one with only declarations and no rule_sets/at-rules); an
 * empty half is dropped rather than leaving a bare blank line.
 */
function renderCssSkeleton(root: AnyNode, src: string): string {
  const blocks = [renderCssOutline(root, src), renderCssCustomProperties(root, src)].filter(
    (b) => b.length > 0,
  );
  return blocks.join("\n\n");
}

/**
 * Parse source and expose the root node while the underlying Tree is alive.
 * Returns undefined when the language is unsupported, WASM cannot load, parsing
 * fails, or the visitor throws.
 */
export async function withTreeSitterRoot<T>(
  text: string,
  language: string,
  paths: TreeSitterPaths = {},
  visit: (root: TreeSitterNode, normalizedLanguage: string) => T | Promise<T>,
): Promise<T | undefined> {
  const key = language.toLowerCase();
  if (key !== "html" && key !== "css" && !RULES[key]) return undefined;

  const lang = await loadLanguage(key, paths);
  if (!lang) return undefined;

  type ParsedTree = { rootNode: TreeSitterNode; delete?: () => void };
  type ParserInstance = { setLanguage: (language: unknown) => void; parse: (source: string) => ParsedTree | undefined; delete?: () => void };
  let tree: ParsedTree | undefined;
  let parser: ParserInstance | undefined;
  try {
    const Parser = await getParserCtor();
    const activeParser = new Parser() as ParserInstance;
    parser = activeParser;
    activeParser.setLanguage(lang);
    tree = activeParser.parse(text);
    if (!tree) return undefined;
    return await visit(tree.rootNode, key);
  } catch {
    return undefined;
  } finally {
    tree?.delete?.();
    parser?.delete?.();
  }
}

/**
 * Produce a skeleton of `text` in `language` using Tree-sitter WASM.
 * Returns undefined if language is unsupported or the grammar cannot be loaded.
 */
export async function treeSitterSkeleton(
  text: string,
  language: string,
  paths: TreeSitterPaths = {},
): Promise<string | undefined> {
  return withTreeSitterRoot(text, language, paths, (root, key) => {
    if (key === "html") return renderHtml(root, text);
    if (key === "css") return renderCssSkeleton(root, text);
    return renderChildren(namedChildren(root), text, RULES[key]!).join("\n\n");
  });
}
