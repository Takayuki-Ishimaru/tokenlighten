// File-extension → language mapping for @tokenlighten/mcp-server.
//
// Ported from proto/src/core/languages.ts — VSCode-free.
// Returns language IDs compatible with tree-sitter-wasms grammar names.

/** Lowercased file extension (no dot) → language ID. */
const EXT_TO_LANGUAGE: Record<string, string> = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "typescriptreact",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "javascriptreact",
  py: "python",
  pyi: "python",
  go: "go",
  rs: "rust",
  java: "java",
  c: "c",
  h: "c",
  cc: "cpp",
  cpp: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  hh: "cpp",
  hxx: "cpp",
  rb: "ruby",
  cs: "csharp",
  php: "php",
  kt: "kotlin",
  kts: "kotlin",
  html: "html",
  htm: "html",
  css: "css",
  json: "json",
  jsonc: "jsonc",
  md: "markdown",
  markdown: "markdown",
  yml: "yaml",
  yaml: "yaml",
  toml: "toml",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
};

function extensionOf(relPath: string): string {
  const normalized = relPath.replace(/\\/g, "/");
  const base = normalized.slice(normalized.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "";
  return base.slice(dot + 1).toLowerCase();
}

/**
 * Best-effort language ID for a file path, or undefined for unknown extensions.
 */
export function languageForPath(relPath: string): string | undefined {
  return EXT_TO_LANGUAGE[extensionOf(relPath)];
}

// ---------------------------------------------------------------------------
// .h content sniff
// ---------------------------------------------------------------------------
//
// The MCP contract (packages/types/src/mcp.ts MCP_LANG_EXTS) lists `.h` under
// BOTH `c` and `cpp` — a C++ header (class/template/namespace/scope-resolution
// syntax) parsed with the C tree-sitter grammar mis-parses or silently drops
// those constructs (no classes/templates/namespaces in C), which weakens
// symbol/skeleton extraction for genuinely-C++ `.h` files repo-wide. Callers
// that already hold the file's text should call languageForPathWithContent
// instead of languageForPath so a C++-shaped `.h` resolves to "cpp" instead of
// the static "c" answer. Pure-extension callers (no content in hand) are not
// worth a dedicated read just to sniff — they keep languageForPath's "c".

/** Cheap, case-sensitive C++ signal: class/template/namespace keywords or `::`. */
const CPP_SNIFF_RE = /\bclass\s|\btemplate\s*<|\bnamespace\s|::/;

/** Sniff window — cheap regex scan over the first N chars only, not the whole file. */
const SNIFF_WINDOW_CHARS = 8192;

/**
 * Like languageForPath, but for `.h` specifically, resolves "cpp" instead of
 * "c" when the first SNIFF_WINDOW_CHARS of `text` look like C++. Every other
 * extension (including `.c`, which the contract does NOT dual-list) is
 * unaffected and returns exactly what languageForPath would.
 */
export function languageForPathWithContent(relPath: string, text: string): string | undefined {
  const lang = EXT_TO_LANGUAGE[extensionOf(relPath)];
  if (lang !== "c" || extensionOf(relPath) !== "h") return lang;
  const window = text.length > SNIFF_WINDOW_CHARS ? text.slice(0, SNIFF_WINDOW_CHARS) : text;
  return CPP_SNIFF_RE.test(window) ? "cpp" : "c";
}
