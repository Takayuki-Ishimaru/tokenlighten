// constantClosure — extracted implementation; imports point to the owning modules.
import * as path from "path";
import type { ImportSpecifier } from "../evidenceClosure.js";
import { FileReadCache } from "./packBasics2.js";
import { MAX_CALLER_FILES_EXAMINED } from "../callerExpansion.js";
import { MAX_CONSTANT_REAL_EXTENT_LINES } from "../evidenceClosure.js";
import { MAX_CONSTANT_WINDOW_LINES } from "../evidenceClosure.js";
import { candidateRelativePaths } from "./callableResolution4.js";
import { declarationRealExtent } from "../evidenceClosure.js";
import { escapeRegExp } from "../../search/find/findText.js";
import { findModuleConstantWindow } from "../evidenceClosure.js";
import { goImportPathAliasesIn } from "../evidenceClosure.js";
import { hasHashComments } from "../callerExpansion.js";
import { importSpecifiersNaming } from "../evidenceClosure.js";
import { isTestConcernPath } from "./literalAndConcernSeeds.js";
import { maskNonCode } from "../callerExpansion.js";
import { readCached } from "./packBasics2.js";
import { resolveImportSpecifierFile } from "./callableResolution4.js";
import { runtimeValueLines } from "../evidenceClosure.js";
import { rustUseBindings } from "../evidenceClosure.js";
import { scanLiteral } from "../../search/find/findText.js";
import { walkCodeFiles } from "../../../tools/walkRepo.js";

/** Standard-library namespaces whose upper-case members are language constants, never workspace values. */
export const BUILTIN_CONSTANT_OWNERS: ReadonlySet<string> = new Set([
  "Math", "Number", "JSON", "Object", "Array", "String", "Symbol", "Date", "Reflect", "Promise", "Error", "BigInt",
  "Integer", "Long", "Double", "Float", "Short", "Byte", "Character", "Boolean", "System", "Console", "Environment",
  "StandardCharsets", "TimeUnit", "ChronoUnit", "Int", "UInt", "Int32", "Int64", "UInt32", "UInt64", "Decimal",
]);

/**
 * `Owner.MEMBER` / `Owner::MEMBER` value reads in `bodyLines`: EITHER a
 * Capitalized owner other than the focal's own type and not a builtin
 * namespace (`isType`), OR a lowercase name `moduleAliases` proves this file
 * imports as a module/package/namespace (`viaAlias`) — V3 (round-7 fable
 * finding, otherC lassStaticLowerProp/goCrossPackageConst/csPascalQualifiedConst/
 * pyEnumValueAccess/pure `Config::kTimeoutMs`/`config::TIMEOUT_MS`). Member of
 * ANY case; a chain continuation after the first member (`.next`, further
 * `.prop`, a call) is allowed -- excluded ONLY when the FIRST member is
 * itself directly called (`Owner.method(`), which is a call, never a value
 * read of `Owner.method`.
 */
export function qualifiedConstantReferencesIn(
  bodyLines: readonly string[],
  hashComment: boolean,
  relPath: string,
  ownTypeName: string | undefined,
  moduleAliases: ReadonlySet<string> = new Set(),
): Array<{ owner: string; member: string; viaAlias: boolean }> {
  const out: Array<{ owner: string; member: string; viaAlias: boolean }> = [];
  const seen = new Set<string>();
  // Own reproduction (2026-09-28, GATEWAYDEFAULTS/AbortSignal.timeout): the
  // trailing `\b` BEFORE the negative lookahead is load-bearing, not
  // decorative -- without it, a member immediately followed by `(`
  // (`AbortSignal.timeout(...)`, correctly excluded: a call, not a value
  // read) let the engine BACKTRACK the greedy member capture by one
  // character (member="timeou", next char "t" is not "(") to satisfy
  // `(?!\s*\()`, silently truncating the captured member instead of
  // rejecting the match outright. `\b` immediately after the capture
  // forbids a backtrack that lands mid-word (no word boundary between two
  // letters), so a call-shaped member now correctly fails the WHOLE match
  // at this position instead of matching a mangled substring.
  // Own reproduction (2026-09-28, oRustModuleConst-derived, Rust `0..limits::MAX`
  // range syntax): the owner lookbehind excluded ANY identifier preceded by a
  // single "." as "already a property access" -- but Rust's `..`/`..=` range
  // operator ALSO leaves a "." immediately before the next identifier, so
  // `0..limits::MAX_RETRIES` wrongly excluded "limits" as an owner start.
  // `(?<!(?<!\.)\.)` excludes a LONE "." only (not itself preceded by
  // another "."), so a genuine property access (`a.b`, one dot) stays
  // excluded while a range operator's second dot (`0..limits`) does not.
  const ownerMemberRe = /(?<![\w$:])(?<!(?<!\.)\.)([A-Za-z_][A-Za-z0-9_]*)(?:\.|::)([A-Za-z_][A-Za-z0-9_]*)\b(?!\s*\()/g;
  for (const line of runtimeValueLines(bodyLines, relPath)) {
    const masked = maskNonCode(line, hashComment, relPath);
    for (const match of masked.matchAll(ownerMemberRe)) {
      const owner = match[1]!;
      const member = match[2]!;
      // Rust `Self::X` names the focal's own type, like `ownTypeName::X`:
      // its member is chased as a bare candidate in the focal's own file.
      const isType = /^[A-Z]/.test(owner) && owner !== ownTypeName && owner !== "Self" && !BUILTIN_CONSTANT_OWNERS.has(owner);
      const isAlias = !isType && moduleAliases.has(owner);
      if (!isType && !isAlias) continue;
      const key = `${owner}.${member}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ owner, member, viaAlias: isAlias });
    }
  }
  return out;
}

/**
 * P1-4 (round-7 fable finding): the body extent of a `class`/`struct`/etc.
 * header at `headerLine` (1-based) in a PYTHON file -- indentation-bounded
 * (Python has no braces), unlike `declarationRealExtent`'s brace-depth scan,
 * which would wrongly close on the header line's OWN parens
 * (`class Timeouts(Enum):`). Extends while a subsequent non-blank line is
 * indented MORE than the header; a blank line inside the block is included
 * provisionally, trimmed away only by the NEXT less-indented line ending the
 * scan (a mild, harmless over-extension into trailing blank lines never
 * affects member-search correctness, only the search's upper bound).
 */
export function pythonBlockExtent(lines: readonly string[], headerLine: number): { start: number; end: number } {
  const indentOf = (s: string): number => /^[ \t]*/.exec(s)?.[0].length ?? 0;
  const headerIndent = indentOf(lines[headerLine - 1] ?? "");
  let end = headerLine;
  for (let i = headerLine; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    if (raw.trim() === "") { end = i + 1; continue; }
    if (indentOf(raw) <= headerIndent) break;
    end = i + 1;
  }
  return { start: headerLine, end };
}

/**
 * P1-4 (round-7 fable finding, own reproduction — qualifiedConstant.spec.ts's
 * pre-existing csInterpolatedConst case): the body extent of a brace-bodied
 * owner header at `headerLine` whose OPENING brace may be on a LATER line
 * (Allman style, `public static class Config\n{\n...`, common in C#, legal
 * in Java/C++ too) — `declarationRealExtent`'s own depth scan starts
 * counting AT `headerLine` and stops the FIRST time depth returns to 0,
 * which is already true (depth starts at 0) when the header line itself
 * opens no bracket at all — an Allman-style header would wrongly report a
 * ONE-LINE extent, never reaching the real body. This scans forward,
 * bracket-depth aware, and never stops at depth 0 until at least one
 * bracket has opened; a header whose brace never opens within the bound
 * (an interface/forward-declaration with no body, or a malformed file)
 * degrades to the bound itself, never an unbounded scan.
 */
export function ownerBraceExtentEnd(lines: readonly string[], headerLine: number, hashComment: boolean): number {
  let depth = 0;
  let opened = false;
  const limit = Math.min(lines.length, headerLine + MAX_CONSTANT_REAL_EXTENT_LINES);
  for (let line = headerLine; line <= limit; line++) {
    const masked = maskNonCode(lines[line - 1] ?? "", hashComment);
    for (const ch of masked) {
      if (ch === "{" || ch === "(" || ch === "[") { depth++; opened = true; }
      else if (ch === "}" || ch === ")" || ch === "]") depth = Math.max(0, depth - 1);
    }
    if (opened && depth === 0) return line;
  }
  return limit;
}

/**
 * P1-4 (round-7 fable finding, item 4): owner resolution PREFERS (1) the
 * focal's own file, (2) a file the focal's file imports `owner` from
 * (relative specifiers resolved), then (3) other declaring files -- a
 * SINGLE remaining candidate is still unambiguous even though neither (1)
 * nor (2) proved it; SEVERAL with neither proving one is reported
 * `ambiguousCandidates`, never silently picked (qualifiedConstTwoOwnersImportLegacy/
 * ImportRoot/TwoClassesOneFile). The member is searched ONLY inside the
 * resolved owner's OWN body span (Python: indentation; every other language:
 * brace/paren/bracket depth) — never anywhere else in the file
 * (qualifiedConstTwoClassesOneFile's `LegacyConfig`/`Config` sharing one
 * file).
 */
export async function findQualifiedConstantWindow(
  owner: string,
  member: string,
  focalPath: string,
  focalLines: readonly string[],
  workspace: string,
  cache: FileReadCache,
): Promise<{ window?: { path: string; start: number; end: number; truncated?: boolean }; ambiguousCandidates?: readonly string[] }> {
  let scanned: ReturnType<typeof scanLiteral>;
  try {
    scanned = scanLiteral(`\\b(?:class|object|struct|enum|interface|namespace|module|record|type)\\s+${escapeRegExp(owner)}\\b`, workspace, { regex: true, caseInsensitive: false });
  } catch {
    return {};
  }
  if (scanned.length === 0) return {};
  const memberRe = new RegExp(`^\\s*(?:(?:export|public|private|protected|internal|static|readonly|final|const|val|var|let|def)\\s+|[A-Za-z_][\\w<>\\[\\],.?]*\\s+)*${escapeRegExp(member)}\\b\\s*(?::[^=;]*)?(?:=(?!=)|,|\\(|$)`);
  // B4 (round-8 fable finding, rustImplConstOtherType): a Rust type's OWN
  // body (`struct Owner { … }`) never carries its associated constants —
  // those live in a SEPARATE `impl Owner { … }` / `impl Trait for Owner {
  // … }` block elsewhere in the same file. Tried only for `.rs`, only after
  // the struct/enum's own body missed the member: every `impl [… for]
  // Owner {` header in this file is a second owner body, searched the
  // identical member-line way. Without this, `Defaults::TIMEOUT_MS` (member
  // declared in `impl Defaults`, not in `struct Defaults`'s own braces)
  // fails to resolve, and the bare `TIMEOUT_MS` member half — kept as a
  // candidate by `constantLikeReferencesIn`'s own `::`-member exception —
  // is disclosed SEPARATELY alongside the qualified `Defaults.TIMEOUT_MS`
  // (a double disclosure); fixing resolution here also fixes that, since
  // `reconcileQualifiedMemberDisclosures` already drops the bare half once
  // the qualified window is actually served.
  const rustImplMemberWindow = (path: string, lines: readonly string[], hashComment: boolean): { path: string; start: number; end: number; truncated?: boolean } | undefined => {
    const implHeaderRe = new RegExp(`^\\s*impl(?:<[^>]*>)?\\s+(?:[\\w:<>,\\s]+\\s+for\\s+)?${escapeRegExp(owner)}\\b`);
    for (let i = 0; i < lines.length; i++) {
      if (!implHeaderRe.test(maskNonCode(lines[i]!, hashComment, path))) continue;
      const implBodyEnd = Math.min(ownerBraceExtentEnd(lines, i + 1, hashComment), lines.length);
      for (let j = i; j < implBodyEnd; j++) {
        if (!memberRe.test(maskNonCode(lines[j]!, hashComment, path))) continue;
        const start = j + 1;
        const realEnd = declarationRealExtent(lines, start, hashComment).end;
        const end = Math.min(realEnd, start + MAX_CONSTANT_WINDOW_LINES - 1, implBodyEnd);
        return { path, start, end, ...(end < realEnd ? { truncated: true } : {}) };
      }
    }
    return undefined;
  };
  const windowFor = (path: string, headerLine: number): { path: string; start: number; end: number; truncated?: boolean } | undefined => {
    const content = readCached(workspace, path, cache);
    if (content === undefined) return undefined;
    const lines = content.split(/\r?\n/);
    const hashComment = hasHashComments(path);
    const bodyEnd = /\.py$/.test(path) ? pythonBlockExtent(lines, headerLine).end : ownerBraceExtentEnd(lines, headerLine, hashComment);
    const limit = Math.min(bodyEnd, lines.length);
    for (let i = headerLine - 1; i < limit; i++) {
      if (!memberRe.test(maskNonCode(lines[i]!, hashComment, path))) continue;
      const start = i + 1;
      const realEnd = declarationRealExtent(lines, start, hashComment).end;
      const end = Math.min(realEnd, start + MAX_CONSTANT_WINDOW_LINES - 1, bodyEnd);
      return { path, start, end, ...(end < realEnd ? { truncated: true } : {}) };
    }
    return /\.rs$/.test(path) ? rustImplMemberWindow(path, lines, hashComment) : undefined;
  };
  // Priority 1: the focal's own file.
  const ownFile = scanned.find((m) => m.path === focalPath);
  if (ownFile !== undefined) return { window: windowFor(ownFile.path, ownFile.line) };
  // Priority 2: a file the focal's file imports `owner` from.
  for (const spec of importSpecifiersNaming(focalLines, owner, hasHashComments(focalPath), focalPath)) {
    const resolved = await resolveImportSpecifierFile(focalPath, spec, workspace, cache);
    if (resolved === undefined) continue;
    const match = scanned.find((m) => m.path === resolved.path);
    if (match !== undefined) return { window: windowFor(match.path, match.line) };
  }
  // Priority 3: exactly one OTHER declaring file is still unambiguous.
  const candidatePaths = [...new Set(scanned.map((m) => m.path))].slice(0, 3);
  if (candidatePaths.length > 1) return { ambiguousCandidates: candidatePaths };
  const only = scanned.find((m) => m.path === candidatePaths[0]);
  return only === undefined ? {} : { window: windowFor(only.path, only.line) };
}

/**
 * FIX-GOALIAS (eval-0929 §4/§8, WP-K): the nearest go.mod at or above
 * `filePath`'s own directory -- its `module` line's path text, and the
 * go.mod's own directory (workspace-relative, "." for the workspace root,
 * matching `path.posix.dirname`'s own convention for a root-level file, the
 * SAME convention `findGoPackageConstantWindow`'s `dir` already uses).
 * `undefined` when no go.mod is found within a bounded number of parent
 * levels (mirrors `rustCrateRootDir`'s own bound) or the found go.mod has no
 * parseable `module` line -- a workspace with no go.mod committed at all
 * (common in a small fixture/example) falls back to the caller's own
 * by-declared-package-name scan rather than asserting anything here.
 */
export async function nearestGoModule(
  filePath: string,
  workspace: string,
  cache: FileReadCache,
): Promise<{ modulePath: string; rootDir: string; goModContent: string } | undefined> {
  let dir = path.posix.dirname(filePath.replace(/\\/g, "/"));
  for (let level = 0; level < 32; level++) {
    const goModPath = dir === "." ? "go.mod" : `${dir}/go.mod`;
    const content = readCached(workspace, goModPath, cache);
    if (content !== undefined) {
      const match = /^\s*module\s+(\S+)/m.exec(content);
      return match ? { modulePath: match[1]!, rootDir: dir, goModContent: content } : undefined;
    }
    if (dir === "." || dir === "/") return undefined;
    const parent = path.posix.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
  return undefined;
}

/**
 * FIX-GOALIAS: cheap `replace <old-module> => <relative-path>` directives in
 * a go.mod's own text -- old module path -> the relative target text, kept
 * to a LOCAL filesystem target only (never a version-qualified module
 * replacement, which would need an actual module cache/network fetch this
 * read-only scan will never perform). "Cheap" per this fix's own required
 * behaviour: a regex over the go.mod text, no semver/module resolution.
 */
export function goModReplacements(goModContent: string): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  const re = /^\s*replace\s+(\S+)(?:\s+\S+)?\s*=>\s*(\.\.?\/\S*)/gm;
  for (const m of goModContent.matchAll(re)) out.set(m[1]!, m[2]!);
  return out;
}

/**
 * FIX-GOALIAS: `importPath` resolved to a workspace directory (never
 * escaping the workspace root) using `mod`'s own module path prefix first,
 * then its go.mod's cheap `replace` directives -- either one PROVES this
 * import is a workspace package (a member search that comes up empty there
 * is a genuine "not found", never "external"). A plain `vendor/` mirror (the
 * pre-modules Go convention, still common) is a much weaker signal -- an
 * ordinary external dependency with no vendor directory at all would
 * otherwise wrongly commit to a directory that simply does not exist --  so
 * it comes back `tentative: true`: the caller only accepts it once a member
 * search there actually finds something, falling back to an EXTERNAL
 * disclosure otherwise. `undefined` means none of these place it inside the
 * workspace at all.
 */
export function resolveGoImportDir(
  importPath: string,
  mod: { modulePath: string; rootDir: string; goModContent: string },
): { dir: string; tentative?: boolean } | undefined {
  const under = (base: string, rel: string): string => {
    const joined = path.posix.normalize(base === "." ? rel : `${base}/${rel}`);
    return joined === "." || joined.startsWith("../") || joined === ".." ? "" : joined;
  };
  if (importPath === mod.modulePath) return { dir: mod.rootDir };
  const prefix = `${mod.modulePath}/`;
  if (importPath.startsWith(prefix)) {
    const dir = under(mod.rootDir, importPath.slice(prefix.length));
    if (dir !== "") return { dir };
  }
  for (const [oldPath, relTarget] of goModReplacements(mod.goModContent)) {
    if (importPath !== oldPath && !importPath.startsWith(`${oldPath}/`)) continue;
    const suffix = importPath.slice(oldPath.length).replace(/^\//, "");
    const targetBase = under(mod.rootDir, relTarget);
    if (targetBase === "") continue;
    return { dir: suffix === "" ? targetBase : under(targetBase, suffix) };
  }
  const vendorDir = under(mod.rootDir, `vendor/${importPath}`);
  return vendorDir === "" ? undefined : { dir: vendorDir, tentative: true };
}

/**
 * V3 (round-7 fable finding, goCrossPackageConst), reworked FIX-GOALIAS
 * (eval-0929 §4/§8, WP-K -- confirmed false "verified empty": an ALIASED Go
 * import, `import lim "example.com/app/limits"`, has an alias that need not
 * match the package's own `package limits` declaration at all, so the
 * ORIGINAL by-declared-name text scan below (V3's own design, kept only as a
 * fallback now) silently found nothing and the caller treated that miss as
 * "nothing to disclose" -- the confirmed bug. This now resolves the import
 * PATH (`goImportPathAliasesIn`, `scanPath`'s own imports) through the
 * nearest go.mod's `module` line to a workspace DIRECTORY first -- Go
 * packages are exactly one directory, so once the directory is known the
 * member is searched across every non-test `.go` file in it directly (test
 * files included only when `scanPath` -- the reader -- is itself a test
 * file, `findGoPackageConstantWindow`'s own convention), never guessed from
 * an unrelated same-named package elsewhere in the workspace. `external`
 * names the import path when it resolves outside this workspace/module
 * (or no go.mod exists to resolve against) -- the caller discloses it
 * ("imported from package …"), never silent. The plain by-name scan remains
 * the fallback when `scanPath`'s own imports do not bind `packageAlias` at
 * all (a qualified reference chased into a DIFFERENT file during a deeper
 * hop -- `resolveQualifiedReferencesIn`'s pre-existing, shared-with-every-
 * language scope limit: `moduleAliases` is computed once from the OUTER
 * focal's own file) -- still correct whenever the alias equals the real
 * package name, the common, unaliased convention.
 */
export async function findGoQualifiedPackageConstantWindow(
  packageAlias: string,
  member: string,
  scanPath: string,
  workspace: string,
  cache: FileReadCache,
): Promise<{ window?: { path: string; start: number; end: number; truncated: boolean }; external?: string }> {
  const readerIsTest = isTestConcernPath(scanPath);
  const searchDir = (dir: string): { path: string; start: number; end: number; truncated: boolean } | undefined => {
    for (const file of walkCodeFiles(workspace, { subPath: dir }).slice(0, MAX_CALLER_FILES_EXAMINED)) {
      if (path.extname(file.relPath) !== ".go") continue;
      if (path.posix.dirname(file.relPath.replace(/\\/g, "/")) !== dir) continue;
      if (!readerIsTest && isTestConcernPath(file.relPath)) continue;
      const content = readCached(workspace, file.relPath, cache);
      if (content === undefined) continue;
      const window = findModuleConstantWindow(content.split(/\r?\n/), member, false);
      if (window) return { path: file.relPath, start: window.start, end: window.end, truncated: window.truncated };
    }
    return undefined;
  };
  const scanPathContent = readCached(workspace, scanPath, cache);
  const importPath = scanPathContent === undefined
    ? undefined
    : goImportPathAliasesIn(scanPathContent.split(/\r?\n/), false).get(packageAlias);
  if (importPath !== undefined) {
    const mod = await nearestGoModule(scanPath, workspace, cache);
    if (mod !== undefined) {
      const resolved = resolveGoImportDir(importPath, mod);
      if (resolved === undefined) return { external: importPath };
      const window = searchDir(resolved.dir);
      // A `tentative` (vendor-guess) directory that yielded nothing is not
      // proof this import lives in the workspace at all -- disclose it as
      // external rather than claim a confident (if empty) local miss.
      if (window === undefined && resolved.tentative === true) return { external: importPath };
      return { window };
    }
  }
  // Fallback: no go.mod to resolve against, or `scanPath`'s own imports do
  // not bind `packageAlias` (the cross-file scope limit above) -- the
  // original by-declared-package-name scan.
  let scanned: ReturnType<typeof scanLiteral>;
  try {
    scanned = scanLiteral(`^package\\s+${escapeRegExp(packageAlias)}\\b`, workspace, { regex: true, caseInsensitive: false });
  } catch {
    return {};
  }
  for (const match of scanned) {
    if (path.extname(match.path) !== ".go" || (!readerIsTest && isTestConcernPath(match.path))) continue;
    const fileContent = readCached(workspace, match.path, cache);
    if (fileContent === undefined) continue;
    const window = findModuleConstantWindow(fileContent.split(/\r?\n/), member, false);
    if (window) return { window: { path: match.path, start: window.start, end: window.end, truncated: window.truncated } };
  }
  return {};
}

/** A Rust file's own module directory: `mod.rs`/`lib.rs`/`main.rs` own their directory, `a/b.rs` owns `a/b/`. */
export function rustModuleDir(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/");
  const base = path.posix.basename(normalized);
  const dir = path.posix.dirname(normalized);
  if (base === "mod.rs" || base === "lib.rs" || base === "main.rs") return dir;
  return rustJoin(dir, base.replace(/\.rs$/, ""));
}

export function rustJoin(dir: string, rel: string): string {
  return dir === "." || dir === "" ? rel : `${dir}/${rel}`;
}

/** The nearest directory at or above `filePath`'s own that holds a crate root (`lib.rs` or `main.rs`). */
export function rustCrateRootDir(filePath: string, workspace: string, cache: FileReadCache): string | undefined {
  let dir = path.posix.dirname(filePath.replace(/\\/g, "/"));
  for (let level = 0; level < 32; level++) {
    if (readCached(workspace, rustJoin(dir, "lib.rs"), cache) !== undefined) return dir;
    if (readCached(workspace, rustJoin(dir, "main.rs"), cache) !== undefined) return dir;
    if (dir === "." || dir === "" || dir === "/") return undefined;
    dir = path.posix.dirname(dir);
  }
  return undefined;
}

/**
 * The file of the Rust module a `use`/`mod` path names (`rustUseBindings`):
 * `crate::…` from the crate root, `self::…` from the focal's own module
 * directory, `super::…` from its parent, a leading plain name only when it
 * is a child module of the focal's own module -- otherwise it is an
 * external crate (`undefined`, nothing about it is asserted). A path that
 * starts inside this crate but has no `name.rs`/`name/mod.rs` (an inline
 * `mod name { … }`, a `#[path]` attribute) is `"workspace-module-unresolved"`:
 * disclosed, never skipped, and never guessed from a same-named file
 * elsewhere (two crates, or `crate::config` and `crate::net::config`,
 * routinely share a basename).
 */
export async function resolveRustModulePath(
  segments: readonly string[],
  focalPath: string,
  workspace: string,
  cache: FileReadCache,
): Promise<{ path: string; content: string } | "workspace-module-unresolved" | undefined> {
  const head = segments[0];
  if (head === undefined) return undefined;
  let base: string | undefined;
  let rest: readonly string[];
  if (head === "crate") {
    base = rustCrateRootDir(focalPath, workspace, cache);
    rest = segments.slice(1);
  } else if (head === "self" || head === "super") {
    let dir = rustModuleDir(focalPath);
    let index = 0;
    for (; segments[index] === "self" || segments[index] === "super"; index++) {
      if (segments[index] === "super") dir = path.posix.dirname(dir);
    }
    base = dir;
    rest = segments.slice(index);
  } else {
    const modDir = rustModuleDir(focalPath);
    const isChildModule = readCached(workspace, rustJoin(modDir, `${head}.rs`), cache) !== undefined
      || readCached(workspace, rustJoin(modDir, `${head}/mod.rs`), cache) !== undefined;
    if (!isChildModule) return undefined;
    base = modDir;
    rest = segments;
  }
  if (base === undefined || rest.length === 0) return "workspace-module-unresolved";
  const dir = rest.slice(0, -1).reduce((acc, segment) => rustJoin(acc, segment), base);
  const leaf = rest[rest.length - 1]!;
  for (const candidate of [rustJoin(dir, `${leaf}.rs`), rustJoin(dir, `${leaf}/mod.rs`)]) {
    const content = readCached(workspace, candidate, cache);
    if (content !== undefined) return { path: candidate, content };
  }
  return "workspace-module-unresolved";
}

/**
 * V3 follow-up (round-7 orchestrator probe): resolves a MODULE-NAMESPACE
 * alias's own defining file -- `owner` is a bare name `importedModuleAliasesIn`
 * already proved is a module alias, but that set only carries the name, not
 * WHICH import shape produced it (a Python submodule `from pkg import mod`
 * differs from a plain package `import pkg`; a TS namespace import differs
 * from either). Re-derives the shape from `focalLines` directly. Every
 * shape's own failure falls through to the NEXT line/shape (never throws,
 * never guesses): `undefined` overall means `owner` names no workspace
 * module this scan could find, the SAME "stdlib/external" signal the
 * caller's silent-skip already keys on. A Rust path that provably starts
 * inside this crate but whose file was not found is
 * `"workspace-module-unresolved"` (`resolveRustModulePath`), which the
 * caller discloses.
 */
export async function resolveModuleNamespaceFile(
  owner: string,
  focalPath: string,
  focalLines: readonly string[],
  workspace: string,
  cache: FileReadCache,
): Promise<{ path: string; content: string } | "workspace-module-unresolved" | undefined> {
  if (path.extname(focalPath) === ".rs") {
    const segments = rustUseBindings(focalLines, false).get(owner);
    return segments === undefined ? undefined : resolveRustModulePath(segments, focalPath, workspace, cache);
  }
  const escapedOwner = escapeRegExp(owner);
  const baseDir = path.posix.dirname(focalPath.replace(/\\/g, "/"));
  for (const rawLine of focalLines) {
    const trimmed = rawLine.trim();
    // TS/JS: import * as owner from "spec"
    const tsNs = new RegExp(`^import\\s+\\*\\s+as\\s+${escapedOwner}\\s+from\\s+["']([^"']+)["']`).exec(trimmed);
    if (tsNs) {
      const specifier = tsNs[1]!;
      const resolved = await resolveImportSpecifierFile(focalPath, { specifier, relative: specifier.startsWith(".") || specifier.startsWith("/") }, workspace, cache);
      if (resolved !== undefined) return resolved;
      continue;
    }
    // B3 (round-8 fable finding, cjsRequireModuleConst/tsDefaultImportObjectConst):
    // CJS `const|let|var owner = require("spec")`, TS `import owner =
    // require("spec")`, and a TS/JS DEFAULT import `import owner from
    // "spec"` all bind `owner` to that MODULE's own exports object --
    // resolved via the SAME specifier-file lookup `resolveImportSpecifierFile`
    // already gives every other import shape here.
    const cjsRequire = new RegExp(`^(?:const|let|var)\\s+${escapedOwner}\\s*=\\s*require\\(\\s*["']([^"']+)["']\\s*\\)`).exec(trimmed);
    const tsImportEqualsRequire = new RegExp(`^import\\s+${escapedOwner}\\s*=\\s*require\\(\\s*["']([^"']+)["']\\s*\\)`).exec(trimmed);
    const tsDefaultImport = new RegExp(`^import\\s+${escapedOwner}\\s*(?:,\\s*\\{[^}]*\\})?\\s*from\\s*["']([^"']+)["']`).exec(trimmed);
    const moduleAliasMatch = cjsRequire ?? tsImportEqualsRequire ?? tsDefaultImport;
    if (moduleAliasMatch) {
      const specifier = moduleAliasMatch[1]!;
      const resolved = await resolveImportSpecifierFile(focalPath, { specifier, relative: specifier.startsWith(".") || specifier.startsWith("/") }, workspace, cache);
      if (resolved !== undefined) return resolved;
      continue;
    }
    // Python: from X import owner [as owner] -- owner is the ALREADY-bound
    // name we were given, so match whichever item (plain or "as") bound it,
    // then resolve owner as X's own submodule (`X/owner.py` or
    // `X/owner/__init__.py`), never X's OWN file (a DIFFERENT module).
    const pyFrom = /^from\s+([.\w]+)\s+import\s+(.+)$/.exec(trimmed);
    if (pyFrom) {
      const items = pyFrom[2]!.split(",").map((s) => s.trim()).filter(Boolean);
      let originalName: string | undefined;
      for (const item of items) {
        if (item === "*") continue;
        const asMatch = /^([A-Za-z_]\w*)\s+as\s+([A-Za-z_]\w*)$/.exec(item);
        const bound = asMatch ? asMatch[2]! : item;
        if (bound === owner) { originalName = asMatch ? asMatch[1]! : item; break; }
      }
      if (originalName !== undefined) {
        const packageBase = pyFrom[1]!;
        const pkgDirs = packageBase.startsWith(".")
          ? candidateRelativePaths(focalPath, { specifier: packageBase, relative: true }).filter((p) => p.endsWith("__init__.py")).map((p) => p.replace(/\/__init__\.py$/, ""))
          : [packageBase.replace(/\./g, "/"), path.posix.normalize(path.posix.join(baseDir, packageBase.replace(/\./g, "/")))];
        for (const dir of pkgDirs) {
          for (const candidate of [`${dir}/${originalName}.py`, `${dir}/${originalName}/__init__.py`]) {
            const content = readCached(workspace, candidate, cache);
            if (content !== undefined) return { path: candidate, content };
          }
        }
      }
      continue;
    }
    // Python: import owner [as owner] / import x.owner [as owner]
    const pyImport = /^import\s+([\w.]+)(?:\s+as\s+([A-Za-z_]\w*))?\s*$/.exec(trimmed);
    if (pyImport) {
      const alias = pyImport[2];
      const dotted = pyImport[1]!;
      const bound = alias ?? dotted.split(".")[0]!;
      if (bound === owner) {
        const asPath = dotted.replace(/\./g, "/");
        for (const root of ["", "src/"]) {
          for (const candidate of [`${root}${asPath}.py`, `${root}${asPath}/__init__.py`]) {
            const content = readCached(workspace, candidate, cache);
            if (content !== undefined) return { path: candidate, content };
          }
        }
      }
      continue;
    }
  }
  return undefined;
}

/**
 * V3 follow-up (MUST, orchestrator round-7 probe): true when `spec` resolves
 * to a real file somewhere in the workspace -- `chaseConstant`'s own
 * package-wording gate: an import specifier that DOES resolve (a Python
 * absolute package `from app import settings`, where `app` is
 * `app/__init__.py`) is never named as a package; only a specifier that
 * resolves to no workspace file is. Tries
 * `resolveImportSpecifierFile` first (TS/JS packages -- a bare
 * `node_modules`-shaped candidate simply will not exist as a workspace
 * file; Python dotted-RELATIVE specifiers, via that helper's own
 * `__init__.py` convention), then a Python ABSOLUTE package/module
 * convention (workspace root, then a `src/` root) that helper does not
 * cover (its Python `__init__.py` fallback is gated to a DOTTED-RELATIVE
 * specifier only).
 */
export async function importSpecifierResolvesInWorkspace(
  ownerPath: string,
  spec: ImportSpecifier,
  workspace: string,
  cache: FileReadCache,
): Promise<boolean> {
  if (await resolveImportSpecifierFile(ownerPath, spec, workspace, cache) !== undefined) return true;
  if (spec.relative) return false;
  const base = spec.specifier.replace(/\./g, "/");
  for (const root of ["", "src/"]) {
    if (readCached(workspace, `${root}${base}.py`, cache) !== undefined) return true;
    if (readCached(workspace, `${root}${base}/__init__.py`, cache) !== undefined) return true;
  }
  return false;
}
