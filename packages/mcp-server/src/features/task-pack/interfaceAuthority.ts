import * as fs from "node:fs";
import * as path from "node:path";
import { handleTable, shaOfText } from "../../util/handles.js";
import { isWithin, resolveReal, safeResolve } from "../../util/safePath.js";
import type { TaskPackSurface } from "./model.js";

/** Maximum serialized contribution of code-bearing interface declarations. */
export const INTERFACE_AUTHORITY_BODY_BUDGET_BYTES = 8 * 1024;

/** Hard cap on authority surfaces (bodies + handle-only tails combined). */
export const INTERFACE_AUTHORITY_MAX_SURFACES = 16;

/**
 * Blanks block and line comments while preserving every offset and newline,
 * so line numbers computed against the shadow still address the original.
 * Comment prose ("most values are below the threshold and …") must anchor
 * nothing: the first real-aeroctl repro extracted English words as
 * identifiers and attached 188 pseudo-declaration surfaces to one pack.
 */
function stripCommentText(source: string): string {
  let out = "";
  let inBlock = false;
  for (let index = 0; index < source.length; index++) {
    const pair = source.slice(index, index + 2);
    if (inBlock) {
      if (pair === "*/") { inBlock = false; index++; out += "  "; continue; }
      out += source[index] === "\n" ? "\n" : " ";
      continue;
    }
    if (pair === "/*") { inBlock = true; index++; out += "  "; continue; }
    if (pair === "//") {
      const newline = source.indexOf("\n", index);
      const end = newline === -1 ? source.length : newline;
      out += " ".repeat(end - index);
      index = end - 1;
      continue;
    }
    out += source[index];
  }
  return out;
}

const NATIVE_SOURCE_RE = /\.(?:c|cc|cp|cpp|cxx|h|hh|hpp|hxx)$/i;
const INCLUDE_RE = /^\s*#\s*include\s*[<"]([^">]+)[">]/gm;
const IDENTIFIER_RE = /\b[A-Za-z_]\w*\b/g;
const TYPE_KEYWORDS = new Set([
  "alignas", "alignof", "auto", "bool", "break", "case", "char", "class",
  "const", "constexpr", "continue", "double", "else", "enum", "extern",
  "false", "float", "for", "if", "inline", "int", "long", "namespace",
  "return", "short", "signed", "static", "struct", "template", "true",
  "typedef", "union", "unsigned", "using", "void", "volatile", "while",
]);

export interface InterfaceAuthorityInput {
  workspace: string;
  frontier: readonly Pick<TaskPackSurface, "path" | "code" | "symbol">[];
}

interface DeclarationCandidate {
  path: string;
  range: string;
  symbol: string;
  code: string;
}

function normalizedPath(value: string): string {
  return value.split(path.sep).join("/");
}

function isNativeSource(pathname: string): boolean {
  return NATIVE_SOURCE_RE.test(pathname);
}

function exactIdentifiers(source: string, symbol?: string): string[] {
  const found = new Set<string>();
  if (symbol && /^[A-Za-z_]\w*$/.test(symbol)) found.add(symbol);
  for (const match of stripCommentText(source).matchAll(IDENTIFIER_RE)) {
    const token = match[0]!;
    if (token.length >= 3 && !TYPE_KEYWORDS.has(token)) found.add(token);
  }
  return [...found].sort((left, right) => left.localeCompare(right));
}

function readProjectFile(workspace: string, rootReal: string, relPath: string): string | undefined {
  const absolute = safeResolve(relPath, workspace);
  if (absolute === undefined) return undefined;
  try {
    const real = fs.realpathSync(absolute);
    if (!isWithin(real, rootReal) || !fs.statSync(real).isFile()) return undefined;
    return fs.readFileSync(real, "utf8");
  } catch {
    return undefined;
  }
}

function resolveProjectInclude(
  workspace: string,
  rootReal: string,
  owner: string,
  include: string,
): string | undefined {
  if (path.isAbsolute(include) || include.includes("\0")) return undefined;
  const candidates: string[] = [];
  const seenCandidates = new Set<string>();
  const push = (candidate: string): void => {
    if (!seenCandidates.has(candidate)) {
      seenCandidates.add(candidate);
      candidates.push(candidate);
    }
  };
  const ownerDir = path.posix.dirname(normalizedPath(owner));
  // Quote-style relative includes resolve against the owner's directory.
  push(ownerDir === "." ? include : path.posix.join(ownerDir, include));
  // Project include roots are discovered by walking from the owner's
  // directory up to the workspace root: each ancestor may itself be the
  // include root, or carry an include/ child. A workspace-root-only anchor
  // misses nested projects (<project>/include/<ns>/x.hpp) — the exact miss
  // that stopped Probe-2 Phase 1a on aeroctl (owner
  // aeroctl/firmware/src/estimator/ekf.cpp, include <estimator/ekf.hpp>,
  // real header aeroctl/firmware/include/estimator/ekf.hpp). Nearest
  // ancestor wins, matching how compilers prefer the closest include root.
  for (let ancestor = ownerDir; ; ancestor = path.posix.dirname(ancestor)) {
    const base = ancestor === "." ? "" : ancestor;
    push(base === "" ? include : path.posix.join(base, include));
    push(base === "" ? path.posix.join("include", include) : path.posix.join(base, "include", include));
    if (base === "") break;
  }
  for (const candidate of candidates) {
    const absolute = safeResolve(candidate, workspace);
    if (absolute === undefined) continue;
    try {
      const real = fs.realpathSync(absolute);
      if (!isWithin(real, rootReal) || !fs.statSync(real).isFile()) continue;
      const relative = path.relative(rootReal, real);
      if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) continue;
      return normalizedPath(relative);
    } catch {
      // An unresolvable include is not project-local authority.
    }
  }
  return undefined;
}

function directProjectIncludes(
  workspace: string,
  rootReal: string,
  owner: string,
  source: string,
): string[] {
  const includes = new Set<string>();
  for (const match of source.matchAll(INCLUDE_RE)) {
    const resolved = resolveProjectInclude(workspace, rootReal, owner, match[1]!);
    if (resolved !== undefined && NATIVE_SOURCE_RE.test(resolved)) includes.add(resolved);
  }
  return [...includes].sort((left, right) => left.localeCompare(right));
}

function declarationRange(lines: readonly string[], lineIndex: number, symbol: string): [number, number] | undefined {
  let start = lineIndex;
  for (let index = lineIndex; index >= Math.max(0, lineIndex - 128); index--) {
    const trimmed = lines[index]!.trimStart();
    if (trimmed.startsWith("typedef ")) {
      start = index;
      break;
    }
    if (
      trimmed.startsWith("struct " + symbol)
      || trimmed.startsWith("class " + symbol)
      || trimmed.startsWith("enum " + symbol)
      || trimmed.startsWith("union " + symbol)
    ) {
      start = index;
      break;
    }
    if (index < lineIndex && !lines[lineIndex]!.includes("}") && trimmed.endsWith(";")) {
      start = index + 1;
      break;
    }
  }
  let braces = 0;
  let sawBrace = false;
  for (let index = start; index < Math.min(lines.length, start + 256); index++) {
    const line = lines[index]!;
    for (const character of line) {
      if (character === "{") { braces++; sawBrace = true; }
      if (character === "}") braces--;
    }
    if (line.trimEnd().endsWith(";") && (!sawBrace || braces <= 0)) return [start + 1, index + 1];
  }
  return undefined;
}
function isIdentifierCharacter(value: string | undefined): boolean {
  return value !== undefined && (
    (value >= "A" && value <= "Z")
    || (value >= "a" && value <= "z")
    || (value >= "0" && value <= "9")
    || value === "_"
  );
}

function hasExactIdentifier(source: string, symbol: string): boolean {
  let offset = source.indexOf(symbol);
  while (offset >= 0) {
    const before = source[offset - 1];
    const after = source[offset + symbol.length];
    if (!isIdentifierCharacter(before) && !isIdentifierCharacter(after)) return true;
    offset = source.indexOf(symbol, offset + symbol.length);
  }
  return false;
}

function declarationsForHeader(headerPath: string, text: string, identifiers: readonly string[]): DeclarationCandidate[] {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized.split("\n");
  // Identifiers are matched against a comment-blanked shadow (offsets
  // preserved); the served code still comes from the original lines.
  const matchLines = stripCommentText(normalized).split("\n");
  const candidates = new Map<string, DeclarationCandidate>();
  for (const symbol of identifiers) {
    for (let index = 0; index < lines.length; index++) {
      if (!hasExactIdentifier(matchLines[index] ?? "", symbol)) continue;
      const range = declarationRange(lines, index, symbol);
      if (range === undefined) continue;
      const matchCode = matchLines.slice(range[0] - 1, range[1]).join("\n");
      if (!hasExactIdentifier(matchCode, symbol)) continue;
      const code = lines.slice(range[0] - 1, range[1]).join("\n");
      const rangeText = String(range[0]) + "-" + String(range[1]);
      const key = headerPath + "\u0000" + rangeText;
      const prior = candidates.get(key);
      if (prior === undefined || symbol.localeCompare(prior.symbol) < 0) {
        candidates.set(key, { path: headerPath, range: rangeText, symbol, code });
      }
    }
  }
  const sorted = [...candidates.values()].sort((left, right) =>
    left.path.localeCompare(right.path)
    || Number(left.range.split("-")[0]) - Number(right.range.split("-")[0])
    || left.symbol.localeCompare(right.symbol)
  );
  // A range strictly contained in another candidate of the same header is a
  // nested pseudo-declaration — the outermost declaration already carries it.
  const spans = sorted.map((candidate) => candidate.range.split("-").map(Number) as [number, number]);
  return sorted.filter((_, index) => {
    const [start, end] = spans[index]!;
    return !sorted.some((_, other) => {
      if (other === index) return false;
      const [otherStart, otherEnd] = spans[other]!;
      return otherStart <= start && end <= otherEnd && otherEnd - otherStart > end - start;
    });
  });
}
/**
 * Builds direct C/C++ declaration evidence without claiming semantic type
 * resolution. The caller decides whether its flag and task profile permit
 * attaching these surfaces.
 */
export function buildInterfaceAuthoritySurfaces(input: InterfaceAuthorityInput): TaskPackSurface[] {
  const rootReal = resolveReal(input.workspace);
  const headers = new Map<string, { text: string; identifiers: Set<string> }>();

  for (const surface of input.frontier) {
    if (!isNativeSource(surface.path) || typeof surface.code !== "string" || surface.code.length === 0) continue;
    const source = readProjectFile(input.workspace, rootReal, surface.path);
    if (source === undefined) continue;
    const identifiers = exactIdentifiers(surface.code, surface.symbol);
    if (identifiers.length === 0) continue;
    for (const headerPath of directProjectIncludes(input.workspace, rootReal, surface.path, source)) {
      const text = readProjectFile(input.workspace, rootReal, headerPath);
      if (text === undefined) continue;
      const entry = headers.get(headerPath) ?? { text, identifiers: new Set<string>() };
      for (const identifier of identifiers) entry.identifiers.add(identifier);
      headers.set(headerPath, entry);
    }
  }

  // Larger declarations first: a class/struct body carries more interface
  // authority than a one-line extern, and the count cap should spend its
  // slots on those (the real-aeroctl repro otherwise filled all slots with
  // single-line fragments from the alphabetically first header).
  const spanOf = (candidate: DeclarationCandidate): number => {
    const [start, end] = candidate.range.split("-").map(Number);
    return (end ?? 0) - (start ?? 0);
  };
  const candidates = [...headers.entries()]
    .flatMap(([headerPath, header]) => declarationsForHeader(headerPath, header.text, [...header.identifiers]))
    .sort((left, right) =>
      spanOf(right) - spanOf(left)
      || left.path.localeCompare(right.path)
      || Number(left.range.split("-")[0]) - Number(right.range.split("-")[0])
      || left.symbol.localeCompare(right.symbol)
    );

  const surfaces: TaskPackSurface[] = [];
  let serializedBodies: TaskPackSurface[] = [];
  for (const candidate of candidates) {
    if (surfaces.length >= INTERFACE_AUTHORITY_MAX_SURFACES) break;
    const handle = handleTable.upsert({
      kind: "range",
      path: candidate.path,
      range: candidate.range,
      workspaceRoot: input.workspace,
      sha: shaOfText(candidate.code),
    }).id;
    const base: TaskPackSurface = {
      role: "contract",
      handle,
      path: candidate.path,
      range: candidate.range,
      symbol: candidate.symbol,
    };
    const withBody: TaskPackSurface = {
      ...base,
      code: candidate.code,
      why: "direct project-local include with exact frontier identifier hit",
    };
    const trial = [...serializedBodies, withBody];
    if (Buffer.byteLength(JSON.stringify(trial), "utf8") <= INTERFACE_AUTHORITY_BODY_BUDGET_BYTES) {
      serializedBodies = trial;
      surfaces.push(withBody);
      continue;
    }
    surfaces.push({
      ...base,
      remaining_ranges: [candidate.range],
      content_completeness: "partial",
    });
  }
  return surfaces;
}
