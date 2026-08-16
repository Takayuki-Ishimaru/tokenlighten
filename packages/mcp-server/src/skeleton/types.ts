// Shared types for tree-sitter integration.

export interface TreeSitterPaths {
  /** Directory holding `tree-sitter-<lang>.wasm` grammar files. */
  grammarDir?: string;
  /** Path to the web-tree-sitter runtime `tree-sitter.wasm`. */
  runtimeWasm?: string;
}
