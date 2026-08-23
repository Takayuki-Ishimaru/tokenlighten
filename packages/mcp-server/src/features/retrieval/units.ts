/**
 * retrieval/units.ts — V10-08 Hybrid Retrieval v1: in-memory index units.
 *
 * DESIGN-v0.10-expansion-plan-v1.3.md V10-08: "BM25F index unitをfile
 * metadata、symbol declaration、symbol body、markdown section、config
 * object、test caseとする。" Built LAZILY per locate() call, entirely in
 * memory, from sources the server already has (the shared per-call
 * WalkCache file list, util/markdownSections.ts's existing heading parser,
 * symbols/collectSymbols.ts's existing tree-sitter collector) — no new
 * on-disk store, no new npm dependency.
 *
 * Symbol units (declaration + body) are sourced EXCLUSIVELY from
 * collectSymbols (tree-sitter, real declarations). PI-06 (see
 * pi06SymbolPurity.spec.ts's T-PI06-02) proved the OTHER symbol source in
 * this codebase — searchSymbols / skeleton-engine's indexStore.ts — is,
 * today, unconditionally regex-based (extractSymbolsRegex) for every
 * language, never parser-verified. Building this module's symbol units off
 * that source instead would silently launder regex-fallback hits as
 * "symbol" units indistinguishable from a real declaration; sourcing them
 * from collectSymbols instead means an unsupported-language file simply
 * contributes zero symbol units (collectSymbols returns `[]`) rather than a
 * false-confidence regex guess — "PI-06を満たさないsymbol fallbackはdirect
 * バケットへ入れない" by construction, not by a post-hoc filter.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { isTestPath } from "@tokenlighten/skeleton-engine";
import { isMarkdownPath, parseMarkdownHeadings } from "../../util/markdownSections.js";
import { languageForPathWithContent } from "../../util/languages.js";
import { collectSymbols, type CollectedSymbol } from "../../symbols/collectSymbols.js";
import { decomposeIdentifier, tokenizeText } from "./tokenize.js";
import type { FoundFile } from "../../tools/walkRepo.js";

export type UnitKind =
  | "file-metadata"
  | "symbol-declaration"
  | "symbol-body"
  | "markdown-section"
  | "config-object"
  | "test-case";

/** DESIGN-v0.10-expansion-plan-v1.3.md V10-08's six named fields. */
export type FieldName = "qualifiedSymbol" | "symbolName" | "path" | "signature" | "doc" | "body";

export interface IndexUnit {
  /** `${path}:${line}` — the SAME key shape locateTaskContext.ts's own `${c.path}:${c.line}` candidate dedup uses, so units and Candidates cross-reference without translation. */
  key: string;
  kind: UnitKind;
  path: string;
  line: number;
  endLine?: number;
  symbol?: string;
  fields: Partial<Record<FieldName, string[]>>;
}

// ---------------------------------------------------------------------------
// Bounds — this module is flag-gated experimental cost, but still bounded so
// a huge workspace cannot turn one locate() call into a full-repo tree-sitter
// sweep (design doc's own named risk: "indexサイズ、CPU、cold startが増える").
// ---------------------------------------------------------------------------

const MAX_BODY_CHARS = 600;
export const MAX_MARKDOWN_FILES = 60;
export const MAX_CONFIG_FILES = 40;
export const MAX_TEST_FILES = 40;
export const MAX_SYMBOL_FILES = 40;

function readTextSafe(absPath: string): string | null {
  try {
    return fs.readFileSync(absPath, "utf8");
  } catch {
    return null;
  }
}

function pathFields(relPath: string): string[] {
  const out: string[] = [];
  for (const seg of relPath.split("/")) out.push(...decomposeIdentifier(seg));
  return out;
}

// ---------------------------------------------------------------------------
// 1. file-metadata — one unit per file already in the caller's scoped list.
//    No I/O: path tokens only.
// ---------------------------------------------------------------------------

export function buildFileMetadataUnits(files: readonly FoundFile[]): IndexUnit[] {
  return files.map((f) => ({
    key: `${f.relPath}:1`,
    kind: "file-metadata",
    path: f.relPath,
    line: 1,
    fields: {
      path: pathFields(f.relPath),
      symbolName: decomposeIdentifier(path.basename(f.relPath, path.extname(f.relPath))),
    },
  }));
}

// ---------------------------------------------------------------------------
// 2/3. symbol-declaration + symbol-body — collectSymbols (tree-sitter) over a
//      CALLER-BOUNDED file set (already deduped/capped by the orchestrator;
//      this function applies MAX_SYMBOL_FILES as a second, defensive cap).
// ---------------------------------------------------------------------------

export interface SymbolUnitsResult {
  units: IndexUnit[];
  /**
   * path -> parser-verified declarations. Reused by the orchestrator as the
   * "parser-proven symbol" hard-floor ranker's ground truth — a SECOND
   * collectSymbols pass is never needed for the same file set.
   */
  byPath: Map<string, CollectedSymbol[]>;
}

export async function buildSymbolUnits(
  workspace: string,
  candidateFiles: readonly string[],
): Promise<SymbolUnitsResult> {
  const units: IndexUnit[] = [];
  const byPath = new Map<string, CollectedSymbol[]>();
  const bounded = candidateFiles.slice(0, MAX_SYMBOL_FILES);

  for (const relPath of bounded) {
    const text = readTextSafe(path.join(workspace, relPath));
    if (text === null) continue;
    const lang = languageForPathWithContent(relPath, text);
    if (!lang) continue; // unsupported language: zero symbol units, never a regex guess.

    let symbols: CollectedSymbol[];
    try {
      symbols = await collectSymbols(text, lang, {});
    } catch {
      continue;
    }
    if (symbols.length === 0) continue;
    byPath.set(relPath, symbols);

    for (const sym of symbols) {
      const qualified = sym.enclosingSymbol ? `${sym.enclosingSymbol.name}.${sym.name}` : sym.name;
      const signatureText = text.slice(sym.signatureStartIndex, sym.signatureEndIndex);
      const bodyText = text.slice(sym.startIndex, Math.min(sym.endIndex, sym.startIndex + MAX_BODY_CHARS));
      const docText = sym.docComment ? sym.docComment.lines.join(" ") : "";

      units.push({
        key: `${relPath}:${sym.signatureStartLine}`,
        kind: "symbol-declaration",
        path: relPath,
        line: sym.signatureStartLine,
        endLine: sym.endLine,
        symbol: sym.name,
        fields: {
          qualifiedSymbol: decomposeIdentifier(qualified),
          symbolName: decomposeIdentifier(sym.name),
          path: pathFields(relPath),
          signature: tokenizeText(signatureText),
          doc: tokenizeText(docText),
        },
      });
      units.push({
        key: `${relPath}:${sym.startLine}`,
        kind: "symbol-body",
        path: relPath,
        line: sym.startLine,
        endLine: sym.endLine,
        symbol: sym.name,
        fields: {
          qualifiedSymbol: decomposeIdentifier(qualified),
          symbolName: decomposeIdentifier(sym.name),
          path: pathFields(relPath),
          body: tokenizeText(bodyText),
        },
      });
    }
  }
  return { units, byPath };
}

// ---------------------------------------------------------------------------
// 4. markdown-section — reuses util/markdownSections.ts's own heading parser
//    (the same one addMarkdownContractCandidates and mode=slice
//    sections=[...] addressing already rely on) rather than a new parser.
// ---------------------------------------------------------------------------

export function buildMarkdownUnits(workspace: string, files: readonly FoundFile[]): IndexUnit[] {
  const mdFiles = files.filter((f) => isMarkdownPath(f.relPath)).slice(0, MAX_MARKDOWN_FILES);
  const units: IndexUnit[] = [];
  for (const f of mdFiles) {
    const text = readTextSafe(path.join(workspace, f.relPath));
    if (text === null) continue;
    const lines = text.split(/\r\n|\r|\n/);
    for (const heading of parseMarkdownHeadings(text)) {
      const bodyEnd = Math.min(heading.endLine, heading.line + 40);
      const body = lines.slice(heading.line, bodyEnd).join("\n").slice(0, MAX_BODY_CHARS);
      units.push({
        key: `${f.relPath}:${heading.line}`,
        kind: "markdown-section",
        path: f.relPath,
        line: heading.line,
        endLine: heading.endLine,
        symbol: heading.text,
        fields: {
          qualifiedSymbol: tokenizeText(heading.path),
          symbolName: tokenizeText(heading.text),
          path: pathFields(f.relPath),
          body: tokenizeText(body),
        },
      });
    }
  }
  return units;
}

// ---------------------------------------------------------------------------
// 5. config-object — top-level keys of JSON config files (parsed) and
//    YAML-ish config files (top-level, non-indented `key:` lines — no new
//    YAML-parser dependency; nested keys are out of scope for this v1).
// ---------------------------------------------------------------------------

const CONFIG_BASENAME_RE = /^(?:package\.json|tsconfig.*\.json|.*\.config\.(?:js|ts|mjs|cjs|json)|.*\.ya?ml|.*\.toml)$/i;

function isConfigPath(relPath: string): boolean {
  const basename = relPath.split("/").pop() ?? relPath;
  return CONFIG_BASENAME_RE.test(basename);
}

interface ConfigEntry {
  key: string;
  line: number;
  valuePreview: string;
}

function extractJsonTopLevelKeys(text: string): ConfigEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return [];
  const lines = text.split(/\r?\n/);
  const out: ConfigEntry[] = [];
  for (const key of Object.keys(parsed as Record<string, unknown>)) {
    const needle = JSON.stringify(key);
    let line = 1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i]!.includes(needle + ":")) {
        line = i + 1;
        break;
      }
    }
    const value = (parsed as Record<string, unknown>)[key];
    const valuePreview = value !== null && typeof value === "object" ? "" : String(value).slice(0, 80);
    out.push({ key, line, valuePreview });
  }
  return out;
}

function extractYamlTopLevelKeys(text: string): ConfigEntry[] {
  const lines = text.split(/\r?\n/);
  const out: ConfigEntry[] = [];
  const re = /^([A-Za-z0-9_.-]+):\s*(.*)$/;
  lines.forEach((line, i) => {
    if (/^\s/.test(line) || line.trim().startsWith("#") || line.trim().length === 0) return;
    const m = re.exec(line);
    if (m) out.push({ key: m[1]!, line: i + 1, valuePreview: (m[2] ?? "").slice(0, 80) });
  });
  return out;
}

export function buildConfigUnits(workspace: string, files: readonly FoundFile[]): IndexUnit[] {
  const configFiles = files.filter((f) => isConfigPath(f.relPath)).slice(0, MAX_CONFIG_FILES);
  const units: IndexUnit[] = [];
  for (const f of configFiles) {
    const text = readTextSafe(path.join(workspace, f.relPath));
    if (text === null) continue;
    const isJson = f.relPath.toLowerCase().endsWith(".json");
    const entries = isJson ? extractJsonTopLevelKeys(text) : extractYamlTopLevelKeys(text);
    for (const entry of entries) {
      units.push({
        key: `${f.relPath}:${entry.line}`,
        kind: "config-object",
        path: f.relPath,
        line: entry.line,
        symbol: entry.key,
        fields: {
          qualifiedSymbol: decomposeIdentifier(entry.key),
          symbolName: decomposeIdentifier(entry.key),
          path: pathFields(f.relPath),
          body: tokenizeText(entry.valuePreview),
        },
      });
    }
  }
  return units;
}

// ---------------------------------------------------------------------------
// 6. test-case — describe/it/test string-literal names out of test files
//    (skeleton-engine's own isTestPath, already the codebase's one
//    definition of "this is a test file").
// ---------------------------------------------------------------------------

const TEST_CALL_RE = /\b(?:describe|it|test)(?:\.\w+)?\s*\(\s*(['"`])((?:\\.|(?!\1).)*)\1/g;

function computeLineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1);
  return starts;
}

function lineOfIndex(lineStarts: readonly number[], index: number): number {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStarts[mid]! <= index) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

export function buildTestCaseUnits(workspace: string, files: readonly FoundFile[]): IndexUnit[] {
  const testFiles = files.filter((f) => isTestPath(f.relPath)).slice(0, MAX_TEST_FILES);
  const units: IndexUnit[] = [];
  for (const f of testFiles) {
    const text = readTextSafe(path.join(workspace, f.relPath));
    if (text === null) continue;
    const lineStarts = computeLineStarts(text);
    TEST_CALL_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = TEST_CALL_RE.exec(text)) !== null) {
      const name = m[2] ?? "";
      if (name.length === 0) continue;
      const line = lineOfIndex(lineStarts, m.index);
      units.push({
        key: `${f.relPath}:${line}`,
        kind: "test-case",
        path: f.relPath,
        line,
        symbol: name,
        fields: {
          symbolName: tokenizeText(name),
          path: pathFields(f.relPath),
        },
      });
    }
  }
  return units;
}
