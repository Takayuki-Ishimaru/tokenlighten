/**
 * MCP tool input/output types for read tools.
 * No meta envelope — see proto/ iter-13 postmortem and docs/components/02-mcp-server.md.
 */

export const MCP_LANGS = [
  "ts",
  "js",
  "py",
  "go",
  "java",
  "rs",
  "c",
  "cpp",
  "kt",
  "cs",
  "php",
  "rb",
] as const;

export type McpLang = typeof MCP_LANGS[number];

export const MCP_LANG_EXTS = {
  ts: [".ts", ".tsx", ".mts", ".cts"],
  js: [".js", ".jsx", ".mjs", ".cjs"],
  py: [".py", ".pyi"],
  go: [".go"],
  java: [".java"],
  rs: [".rs"],
  c: [".c", ".h"],
  cpp: [".cc", ".cpp", ".cxx", ".hpp", ".hh", ".hxx", ".h"],
  kt: [".kt", ".kts"],
  cs: [".cs"],
  php: [".php"],
  rb: [".rb"],
} as const satisfies Record<McpLang, readonly string[]>;
