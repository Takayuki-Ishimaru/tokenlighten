// lightAnswer.ts — the file-local half of the light answer path's
// applicability test (TL_EFF_LIGHT_ANSWER, util/flags.ts `effLightAnswerEnabled`,
// class (B), default OFF).
//
// THE PATH. readCodeTaskPack.ts's `lightAnswerTarget` / `buildLightAnswerPack`
// answer a question about ONE small file from that file: the request skips the
// pathless locator (source-index build and its git calls, symbol search,
// reference scan, the answer builder's own augmentation passes) and is built by
// the same seeded builder and certification tail a caller-supplied target
// takes, so the readiness obligations, the facet plan, the dependency closure
// and the decision come from the code the full pipeline certifies with. The
// response then leaves out the optional members that carry nothing for one
// whole file served whole (the evidence row's `why` and `symbol`).
//
// THIS MODULE decides from the file's own text whether it can answer by
// itself: small (LIGHT_ANSWER_MAX_BYTES / LIGHT_ANSWER_MAX_LINES), written in
// one of the languages the differential spec covers
// (`smallTaskLightAnswerDifferential.spec.ts`: TypeScript, JavaScript, Python,
// Go, Rust, Ruby), and naming no other module. The dependency test is
// deliberately blunt: ANY line that looks like an import, require, use, mod,
// include, mixin or cross-module path, anywhere in the file, disqualifies it.
// A false positive only sends the request down the full pipeline, which is
// always correct; a false negative is what the differential spec guards.

import * as path from "node:path";

/** A light answer file is at most this many bytes… */
export const LIGHT_ANSWER_MAX_BYTES = 4096;
/** …and at most this many lines (the whole file is served as one evidence row). */
export const LIGHT_ANSWER_MAX_LINES = 120;

/** Extension → language, for the languages the differential spec covers. */
const LIGHT_ANSWER_LANGUAGES: Readonly<Record<string, string>> = {
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".js": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".py": "python",
  ".go": "go",
  ".rs": "rust",
  ".rb": "ruby",
};

/** The light-answer language of `relPath`, or undefined when the path is out of scope. */
export function lightAnswerLanguage(relPath: string): string | undefined {
  const ext = path.posix.extname(relPath.replace(/\\/g, "/")).toLowerCase();
  if (relPath.toLowerCase().endsWith(".d.ts")) return undefined;
  return LIGHT_ANSWER_LANGUAGES[ext];
}

const JS_DEPENDENCY_LINES: readonly RegExp[] = [
  /^\s*import\b/u,
  /\bimport\s*\(/u,
  /\brequire\s*\(/u,
  /^\s*export\s+(?:type\s+)?(?:\*|\{)[^;]*\bfrom\b/u,
  /^\s*\/\/\/\s*<reference\b/u,
];

const DEPENDENCY_LINES: Readonly<Record<string, readonly RegExp[]>> = {
  typescript: JS_DEPENDENCY_LINES,
  javascript: JS_DEPENDENCY_LINES,
  python: [
    /^\s*(?:import|from)\s+\S/u,
    /\b__import__\s*\(/u,
    /\bimportlib\b/u,
  ],
  go: [
    /^\s*import\b/u,
  ],
  rust: [
    /^\s*(?:pub(?:\s*\([^)]*\))?\s+)?use\s/u,
    /^\s*(?:pub(?:\s*\([^)]*\))?\s+)?mod\s+[A-Za-z_]\w*\s*;/u,
    /^\s*extern\s+crate\b/u,
    /\b(?:crate|super)::/u,
    /\binclude(?:_str|_bytes)?!\s*\(/u,
  ],
  ruby: [
    /^\s*(?:require|require_relative|load|autoload)\b/u,
    /^\s*(?:include|extend|prepend)\s+[A-Z]/u,
  ],
};

/**
 * The 1-based number of the first line of `text` that names another module
 * (an import, require, use, mod, include, mixin or crate/super path), or
 * undefined when there is none. An unknown language always answers line 1:
 * nothing is known about how it names other modules.
 */
export function lightAnswerDependencyLine(text: string, language: string): number | undefined {
  const patterns = DEPENDENCY_LINES[language];
  if (patterns === undefined) return 1;
  const lines = text.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (patterns.some((pattern) => pattern.test(line))) return index + 1;
  }
  return undefined;
}

/** Number of lines in `text` (a trailing newline does not open a line). */
export function lightAnswerLineCount(text: string): number {
  if (text.length === 0) return 0;
  const breaks = text.match(/\n/gu)?.length ?? 0;
  return text.endsWith("\n") ? breaks : breaks + 1;
}

/** True when `identifier` occurs in `text` as a whole identifier (not inside a longer one). */
export function lightAnswerHasWholeIdentifier(text: string, identifier: string, caseInsensitive = false): boolean {
  if (identifier.length === 0) return false;
  const escaped = identifier.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`(?<![A-Za-z0-9_$])${escaped}(?![A-Za-z0-9_$])`, caseInsensitive ? "iu" : "u").test(text);
}
