// constantResolution — extracted implementation; imports point to the owning modules.
import * as path from "path";
import type { ImportSpecifier } from "../evidenceClosure.js";
import type { NamedWindow } from "./callableResolution2.js";
import { FileReadCache } from "./packBasics2.js";
import { MAX_CONSTANT_WINDOW_LINES } from "../evidenceClosure.js";
import { declarationRealExtent } from "../evidenceClosure.js";
import { escapeRegExp } from "../../search/find/findText.js";
import { findModuleConstantWindow } from "../evidenceClosure.js";
import { hasHashComments } from "../callerExpansion.js";
import { importSpecifiersNaming } from "../evidenceClosure.js";
import { isProseAcronym } from "../concernRecovery.js";
import { isTestConcernPath } from "./literalAndConcernSeeds.js";
import { maskNonCode } from "../callerExpansion.js";
import { ownerBraceExtentEnd } from "./constantClosure2.js";
import { readCached } from "./packBasics2.js";
import { resolveRustModulePath } from "./constantClosure2.js";
import { rustUseBindings } from "../evidenceClosure.js";
import { scanLiteral } from "../../search/find/findText.js";
import { walkCodeFiles } from "../../../tools/walkRepo.js";

/**
 * R2-T3 (P0-4): the WORK bound of ONE Go same-package sibling scan -- source
 * CHARACTERS read across the package's files (the walk already refuses any
 * single file over 1 MB, so this admits eight-odd maximum-size files or
 * thousands of ordinary ones; real packages, generated code included, sit far
 * below it). The bound is deliberately a function of the package's CONTENT
 * (deterministic, never of elapsed time -- FACET_CLOSURE_EMERGENCY_BUDGET_MS's
 * own rule) and generous enough that hitting it means "this package really is
 * too large to read whole", which callers disclose.
 */
export const MAX_GO_PACKAGE_SCAN_BYTES = 8 * 1024 * 1024;

/** The `package` name a Go file declares (`package poll`), or `undefined` when its text names none. */
export function goPackageClause(content: string | undefined): string | undefined {
  return content === undefined ? undefined : /^[ \t]*package[ \t]+([A-Za-z_]\w*)/m.exec(content)?.[1];
}

export const goPackageSiblingMemo = new WeakMap<FileReadCache, Map<string, readonly string[]>>();

/**
 * The files that share `ownerPath`'s Go package (`package poll` in every one)
 * and its directory, `ownerPath` itself excluded, in path order: the direct
 * `.go` children of the owner's directory -- listed through the shared walk
 * (so `.tokenlightenignore`/default exclusions hold) but filtered BEFORE any
 * bound is applied, so a nested directory sorting ahead of the siblings can
 * never crowd them out. A non-test owner never sees a `_test.go`/test-directory
 * file (a constant that lives only in a test is not visible to package code); an
 * owner that IS a test file sees them all.
 */
export function goPackageSiblingFiles(ownerPath: string, workspace: string, cache: FileReadCache): readonly string[] {
  let byOwner = goPackageSiblingMemo.get(cache);
  if (byOwner === undefined) {
    byOwner = new Map();
    goPackageSiblingMemo.set(cache, byOwner);
  }
  const memo = byOwner.get(ownerPath);
  if (memo !== undefined) return memo;
  const dir = path.posix.dirname(ownerPath.replace(/\\/g, "/"));
  const ownerIsTest = isTestConcernPath(ownerPath);
  const files: string[] = [];
  for (const file of walkCodeFiles(workspace, { subPath: dir })) {
    if (file.relPath === ownerPath || path.extname(file.relPath) !== ".go") continue;
    if (path.posix.dirname(file.relPath.replace(/\\/g, "/")) !== dir) continue;
    if (!ownerIsTest && isTestConcernPath(file.relPath)) continue;
    files.push(file.relPath);
  }
  byOwner.set(ownerPath, files);
  return files;
}

/**
 * Visits every readable package-mate of `ownerPath` (`goPackageSiblingFiles`)
 * in path order until `visit` returns a value, spending at most `byteBudget`
 * characters of source. A sibling that declares a DIFFERENT package
 * (`//go:build ignore` generators are `package main`, external tests
 * `package poll_test`) is not part of this package and is skipped -- its
 * constants are invisible to the owner. `bounded` is true when the scan ended
 * without a hit but did not cover the package: the byte budget ran out, or a
 * sibling could not be read at all -- "not found" then means "not found in
 * what could be read", which is not absence.
 */
export function scanGoPackageSiblings<T>(
  ownerPath: string,
  workspace: string,
  cache: FileReadCache,
  visit: (relPath: string, content: string) => T | undefined,
  opts: {
    byteBudget?: number;
    /** A cheap NECESSARY condition on the raw text: a file it rejects is neither visited nor asked for its package clause (its characters still count against the budget -- they were read). */
    mightMatch?: (content: string) => boolean;
  } = {},
): { hit: T | undefined; bounded: boolean } {
  const byteBudget = opts.byteBudget ?? MAX_GO_PACKAGE_SCAN_BYTES;
  const ownerPackage = goPackageClause(readCached(workspace, ownerPath, cache));
  let spent = 0;
  let bounded = false;
  for (const relPath of goPackageSiblingFiles(ownerPath, workspace, cache)) {
    const content = readCached(workspace, relPath, cache);
    if (content === undefined) { bounded = true; continue; }
    spent += content.length;
    if (spent > byteBudget) { bounded = true; break; }
    if (opts.mightMatch !== undefined && !opts.mightMatch(content)) continue;
    const clause = goPackageClause(content);
    if (ownerPackage !== undefined && clause !== undefined && clause !== ownerPackage) continue;
    const hit = visit(relPath, content);
    if (hit !== undefined) return { hit, bounded: false };
  }
  return { hit: undefined, bounded };
}

/**
 * B4 (round-8 fable finding, rustUseConstPlain): a Rust `use path::to::NAME;`
 * statement binds NAME directly (the body reads it BARE — `let timeout =
 * TIMEOUT_MS;`, no qualifier at the use site at all) — `rustUseBindings`
 * already parses this exact shape (`NAME -> [...modulePath, "NAME"]`); the
 * MODULE is the path's own PARENT (every segment but the last), resolved
 * the identical way `resolveModuleNamespaceFile`'s Rust branch already
 * resolves a `use`d NAMESPACE, then `name` is looked up at that module's
 * own top level. A `mod name;` binding (`["self", name]`, no further
 * segments once the name itself is dropped) legitimately yields
 * `"workspace-module-unresolved"` here — `resolveRustModulePath`'s own
 * `rest.length === 0` rule — silently returned as `undefined`: `mod`
 * declarations name a whole module, never a single constant, so this path
 * simply does not apply to one and the ordinary candidate scan continues.
 */
export async function resolveRustUseConstantWindow(
  name: string,
  ownerLines: readonly string[],
  ownerPath: string,
  workspace: string,
  cache: FileReadCache,
): Promise<{ path: string; start: number; end: number; truncated: boolean } | undefined> {
  if (path.extname(ownerPath) !== ".rs") return undefined;
  const segments = rustUseBindings(ownerLines, false).get(name);
  if (segments === undefined || segments.length < 2) return undefined;
  const resolvedModule = await resolveRustModulePath(segments.slice(0, -1), ownerPath, workspace, cache);
  if (resolvedModule === undefined || resolvedModule === "workspace-module-unresolved") return undefined;
  const moduleLines = resolvedModule.content.split(/\r?\n/);
  // FIX-ALIAS (eval-0929 §4): `use a::A as B;` binds `name` ("B") to the
  // segments' OWN last element ("A") — `rustUseBindings` already records the
  // real path (`segments`), so the module declares whatever `segments`' own
  // last segment names, never `name` itself when the two differ (the alias
  // case). Non-aliased `use a::NAME;` binds `NAME` to `[...prefix, NAME]`, so
  // `segments[segments.length - 1] === name` there and this is unchanged.
  const realName = segments[segments.length - 1]!;
  const window = findModuleConstantWindow(moduleLines, realName, false);
  return window ? { path: resolvedModule.path, start: window.start, end: window.end, truncated: window.truncated } : undefined;
}

/**
 * Shared by B2's Kotlin package-wildcard SHOULD case and (round-9)
 * `findJvmImportedConstantWindow`'s lower-case-package branch: a TOP-LEVEL
 * declaration of `name` in a file declaring `package packagePath` exactly
 * (Kotlin/Scala convention — `findModuleConstantWindow`'s own column-0
 * shapes), restricted to files matching `extRe`. First match, in scan order,
 * wins; `undefined` when no file declares that exact package, or none of
 * those that do declares `name` at its own top level.
 */
export async function findPackageTopLevelDeclarationWindow(
  packagePath: string,
  name: string,
  extRe: RegExp,
  workspace: string,
  cache: FileReadCache,
): Promise<{ path: string; start: number; end: number; truncated: boolean } | undefined> {
  let scanned: ReturnType<typeof scanLiteral>;
  try {
    // Exact package only: `\b` also matched `package cfg.aaa` for `cfg`, and a
    // sub-package's same-named constant is neither imported nor visible.
    // (scanLiteral's safe-regex guard refuses lookaheads, hence no `(?!…)`.)
    scanned = scanLiteral(`^package\\s+${escapeRegExp(packagePath)}(?:\\s|;|$)`, workspace, { regex: true, caseInsensitive: false });
  } catch {
    return undefined;
  }
  for (const match of scanned) {
    if (!extRe.test(match.path) || isTestConcernPath(match.path)) continue;
    const fileContent = readCached(workspace, match.path, cache);
    if (fileContent === undefined) continue;
    const window = findModuleConstantWindow(fileContent.split(/\r?\n/), name, false);
    if (window) return { path: match.path, start: window.start, end: window.end, truncated: window.truncated };
  }
  return undefined;
}

/**
 * B3 (round-9 fable finding, javaStaticStarWrongOwner/csUsingStaticWrongOwner):
 * the member-window search behind a TYPE wildcard import (`import
 * a.b.C.*` Kotlin/Java, `import static a.b.C.*` Java, `using static A.B.C;`
 * C#) — UNLIKE `findQualifiedConstantWindow`'s general "exactly one OTHER
 * declaring file is still unambiguous" priority 3 (correct for an ORDINARY
 * qualified reference, where the workspace usually declares the referenced
 * type only once), a wildcard import's own specifier already NAMES the
 * owner's full package/namespace path (`a.b`, `A.B`) — so "there happens to
 * be only one OTHER class named C in the whole workspace" is not evidence
 * this import resolved to THAT class. Own reproduction: an external `import
 * static lib.external.Config.*` next to a local `app.Config` wrongly served
 * the LOCAL class's field as though the WILDCARD import had named it. Only a
 * file that BOTH declares `class|object|struct|… C` AND its own
 * `package`/`namespace` line matches `packagePath` EXACTLY is a candidate;
 * none such -> `undefined` (never a fallback to "the only other same-named
 * class"), which the caller then leaves as "not from that import", exactly
 * like an ordinary miss.
 */
export async function findPackageQualifiedOwnerMemberWindow(
  ownerLastSegment: string,
  packagePath: string,
  member: string,
  isCSharp: boolean,
  workspace: string,
  cache: FileReadCache,
): Promise<{ path: string; start: number; end: number; truncated: boolean } | undefined> {
  let scanned: ReturnType<typeof scanLiteral>;
  try {
    scanned = scanLiteral(`\\b(?:class|object|struct|enum|interface|namespace|module|record|type)\\s+${escapeRegExp(ownerLastSegment)}\\b`, workspace, { regex: true, caseInsensitive: false });
  } catch {
    return undefined;
  }
  const packageRe = isCSharp
    ? new RegExp(`^\\s*namespace\\s+${escapeRegExp(packagePath)}\\s*(?:;|\\{|$)`)
    : new RegExp(`^\\s*package\\s+${escapeRegExp(packagePath)}\\s*(?:;|$)`);
  const memberRe = new RegExp(`^\\s*(?:(?:export|public|private|protected|internal|static|readonly|final|const|val|var|let|def)\\s+|[A-Za-z_][\\w<>\\[\\],.?]*\\s+)*${escapeRegExp(member)}\\b\\s*(?::[^=;]*)?(?:=(?!=)|,|\\(|$)`);
  for (const match of scanned) {
    const content = readCached(workspace, match.path, cache);
    if (content === undefined) continue;
    const lines = content.split(/\r?\n/);
    const hashComment = hasHashComments(match.path);
    if (!lines.some((line) => packageRe.test(maskNonCode(line, hashComment, match.path)))) continue;
    const bodyEnd = Math.min(ownerBraceExtentEnd(lines, match.line, hashComment), lines.length);
    for (let i = match.line - 1; i < bodyEnd; i++) {
      if (!memberRe.test(maskNonCode(lines[i]!, hashComment, match.path))) continue;
      const start = i + 1;
      const realEnd = declarationRealExtent(lines, start, hashComment).end;
      const end = Math.min(realEnd, start + MAX_CONSTANT_WINDOW_LINES - 1, bodyEnd);
      return { path: match.path, start, end, truncated: end < realEnd };
    }
  }
  return undefined;
}

/**
 * B2 (round-8 fable finding, ktStarImportLowerConst/javaStaticStarImportConst/
 * csUsingStaticPascalConst's TimeoutMs): a TYPE wildcard this file imports
 * (`import a.b.C.*` Kotlin/Java, `import static a.b.C.*` Java, `using
 * static A.B.C;` C#) makes every one of C's own members reachable under its
 * BARE name — an otherwise-unresolved bare `name` is looked up as `C.name`,
 * package-checked (B3, round-9: `findPackageQualifiedOwnerMemberWindow`,
 * replacing the old, over-permissive `findQualifiedConstantWindow` call —
 * see that function's own doc for why); several wildcard imports are tried
 * in the order they appear, first match wins; not found there -> "not from
 * that import" (never disclosed as if it were — `chaseConstant`'s own
 * `namedSpecs` filter already excludes every wildcard spec from that
 * wording). A specifier whose last dotted segment is lower-case names a
 * PACKAGE, not a type — Kotlin is the one family here where a top-level
 * (non-member) constant is reachable this way at all (Java/C# always
 * require a class qualifier even under a package wildcard), so this SHOULD
 * case is scoped to `.kt`/`.kts` files.
 */
export async function findWildcardImportedConstantWindow(
  name: string,
  ownerLines: readonly string[],
  ownerPath: string,
  hashComment: boolean,
  workspace: string,
  cache: FileReadCache,
): Promise<{ path: string; start: number; end: number; truncated: boolean } | undefined> {
  const specs = importSpecifiersNaming(ownerLines, name, hashComment, ownerPath).filter((spec) => spec.wildcard === true);
  const typeSpecs = specs.filter((spec) => /^[A-Z]/.test(spec.specifier.split(".").pop() ?? ""));
  const isCSharp = /\.cs$/.test(ownerPath);
  for (const spec of typeSpecs) {
    const segments = spec.specifier.split(".");
    const owner = segments.pop()!;
    const packagePath = segments.join(".");
    const resolution = await findPackageQualifiedOwnerMemberWindow(owner, packagePath, name, isCSharp, workspace, cache);
    if (resolution !== undefined) return resolution;
  }
  if (!/\.kts?$/.test(ownerPath)) return undefined;
  const packageSpecs = specs.filter((spec) => !/^[A-Z]/.test(spec.specifier.split(".").pop() ?? ""));
  for (const spec of packageSpecs) {
    const window = await findPackageTopLevelDeclarationWindow(spec.specifier, name, /\.kts?$/, workspace, cache);
    if (window) return window;
  }
  return undefined;
}

/**
 * B2 (round-9 fable finding, ktImportedTopLevelConst/ktImportedObjectMemberConst):
 * a JVM (Kotlin/Scala) bare, non-wildcard member import `import a.b.NAME` —
 * syntactically identical to Python's `import a.b [as x]`, so
 * `importSpecifiersNaming`'s Python shape is now gated OFF for these
 * extensions (evidenceClosure.ts's own B2 fix) and this is the JVM-specific
 * resolution instead. The segment immediately before NAME decides the shape:
 * CAPITALISED -> an owner TYPE (`import cfg.Settings.TIMEOUT_MS` ->
 * `Settings.TIMEOUT_MS`, package-checked exactly like B3's wildcard-owner
 * fix — `findPackageQualifiedOwnerMemberWindow`); lower-case -> a PACKAGE
 * only (`import cfg.TIMEOUT_MS` -> a top-level declaration of package `cfg`
 * — `findPackageTopLevelDeclarationWindow`, the SAME lookup B2's Kotlin
 * package-wildcard SHOULD case already uses). Java is deliberately excluded:
 * a plain (non-`static`) Java import always names a TYPE, never a field —
 * Java's own per-member mechanism (`import static pkg.Class.NAME;`) is a
 * DIFFERENT shape `importSpecifiersNaming`'s `javaStatic` regex already
 * resolves untouched. `undefined` when this file names no such import at
 * all, or the owner/package it names does not declare `NAME` — the ordinary
 * "could not be resolved" disclosure follows exactly as for any other miss.
 */
export async function findJvmImportedConstantWindow(
  name: string,
  ownerLines: readonly string[],
  ownerPath: string,
  workspace: string,
  cache: FileReadCache,
): Promise<{ path: string; start: number; end: number; truncated: boolean } | undefined> {
  if (!/\.(?:kt|kts|scala|sc)$/.test(ownerPath)) return undefined;
  const importRe = new RegExp(`^\\s*import\\s+([\\w.]+)\\.${escapeRegExp(name)}\\s*;?\\s*$`);
  // FIX-ALIAS (eval-0929 §4): `import a.b.NAME as alias` binds `alias`
  // locally to the SAME member a plain (non-aliased) import above binds
  // under its own name -- this hook never goes through `importSpecifiersNaming`
  // (a dotted JVM package path is not a file `resolveImportSpecifierFile`
  // can resolve at all, unlike `findConstantAcrossReexports`'s relative-file
  // hops), so the alias shape is matched directly here, keyed by the REAL
  // member name instead of `name`.
  const importAliasRe = new RegExp(`^\\s*import\\s+([\\w.]+)\\.([a-z_]\\w*)\\s+as\\s+${escapeRegExp(name)}\\s*;?\\s*$`);
  for (const rawLine of ownerLines) {
    const m = importRe.exec(rawLine);
    const aliasM = m ? undefined : importAliasRe.exec(rawLine);
    const dotted = m?.[1] ?? aliasM?.[1];
    const member = m ? name : aliasM?.[2];
    if (dotted === undefined || member === undefined) continue;
    const segments = dotted.split(".");
    const prev = segments[segments.length - 1];
    if (prev === undefined || prev.length === 0) continue;
    if (/^[A-Z]/.test(prev)) {
      const packagePath = segments.slice(0, -1).join(".");
      const resolution = await findPackageQualifiedOwnerMemberWindow(prev, packagePath, member, false, workspace, cache);
      if (resolution !== undefined) return resolution;
    } else {
      const packagePath = segments.join(".");
      const window = await findPackageTopLevelDeclarationWindow(packagePath, member, /\.(?:kt|kts|java|scala|sc)$/, workspace, cache);
      if (window) return window;
    }
  }
  return undefined;
}

/**
 * Round-9 review P1-2 (ktLoopVarShadowsSibling): names a Kotlin/Scala body
 * binds itself — a `for (x in …)` / `for ((a, b) in …)` / `for (x <- …)`
 * variable, a `catch (e: …)` parameter, a `{ a, b -> … }` lambda parameter.
 * Such a name read in that body is the local binding, never a same-package
 * top-level declaration, so `findJvmPackageSiblingConstantWindow` (the
 * broadest, name-only lookup) is not tried for it.
 */
export function kotlinScopedBindingNames(bodyLines: readonly string[], hashComment: boolean, relPath: string): Set<string> {
  const out = new Set<string>();
  const loopRe = /\bfor\s*\(\s*\(?\s*([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*)\s*\)?\s*(?::\s*[\w.<>?, ]+?)?\s+(?:in\b|<-)/g;
  const catchRe = /\bcatch\s*\(\s*([A-Za-z_]\w*)\s*:/g;
  const lambdaRe = /\{\s*([A-Za-z_]\w*(?:\s*:\s*[\w.<>?]+)?(?:\s*,\s*[A-Za-z_]\w*(?:\s*:\s*[\w.<>?]+)?)*)\s*->/g;
  for (const raw of bodyLines) {
    const masked = maskNonCode(raw, hashComment, relPath);
    for (const re of [loopRe, catchRe, lambdaRe]) {
      for (const m of masked.matchAll(re)) {
        // `when (x) { FAST -> … }` is a branch on a value, not a lambda.
        if (re === lambdaRe && /\bwhen\b[^{]*$/.test(masked.slice(0, m.index))) continue;
        for (const part of m[1]!.split(",")) {
          const name = /^\s*([A-Za-z_]\w*)/.exec(part)?.[1];
          if (name !== undefined && name !== "_") out.add(name);
        }
      }
    }
  }
  return out;
}

/**
 * B2 (round-9 fable finding, P2-11 residual): Kotlin/Scala SAME-PACKAGE
 * top-level visibility — a constant declared in a SIBLING file that declares
 * the identical `package a.b` line is readable with NO import at all
 * (mirroring Go's own same-directory package visibility, item 3 — but a JVM
 * package is a declared NAME, not a directory, so this scans by that
 * declared name workspace-wide via `findPackageTopLevelDeclarationWindow`,
 * the same convention `findGoQualifiedPackageConstantWindow` already uses
 * for Go). `undefined` when `ownerPath` itself declares no `package` line
 * (nothing to match against — by the time this runs, `resolveConstantWindow`
 * already tried `ownerPath`'s own top level and found nothing, so revisiting
 * it here is harmless) or no sibling resolves the name.
 */
export async function findJvmPackageSiblingConstantWindow(
  ownerPath: string,
  ownerLines: readonly string[],
  name: string,
  workspace: string,
  cache: FileReadCache,
): Promise<{ path: string; start: number; end: number; truncated: boolean } | undefined> {
  if (!/\.(?:kt|kts|scala|sc)$/.test(ownerPath)) return undefined;
  const ownPackage = /^\s*package\s+([\w.]+)/m.exec(ownerLines.join("\n"))?.[1];
  if (ownPackage === undefined) return undefined;
  return findPackageTopLevelDeclarationWindow(ownPackage, name, /\.(?:kt|kts|scala|sc)$/, workspace, cache);
}

/**
 * FIX-G: a constant-shaped name that — unresolved — makes a value/condition
 * facet honestly undetermined: CONST_CASE with at least one underscore (the
 * conventional module-constant spelling). A bare all-caps word (`JSON`, `URL`,
 * `PORT`) or a Capitalized type/class name never qualifies: those are far more
 * often globals, acronyms or types than an unresolved module constant, and a
 * false "undetermined" disclosure is noise the caller cannot act on.
 *
 * P2-13 (round-4/5 fable finding, externalPackageConst): the underscore
 * requirement alone missed a bare ALL-CAPS name with NO underscore
 * (`DEFAULTS`) imported from an external PACKAGE (a non-relative specifier,
 * `chaseConstant`'s own caller supplies `importedFromPackage`) — "whatever
 * its spelling" (brief). Widened to accept ANY all-caps/digit/underscore run
 * (no underscore required) ONLY when the caller can show the name was named
 * by a non-relative import specifier in this same file: a bare mixed-case
 * name (a called function like `createSlice`, however unresolvable) never
 * matches this branch regardless of import origin — this is exactly the
 * noise the original all-caps-word restriction above guards against, so a
 * value/condition question about a focal that merely CALLS some unrelated
 * imported function stays silent exactly as before. A same-workspace
 * relative import that simply could not be found still needs the stricter
 * underscored shape (second branch, unchanged).
 */
export function isUnresolvableConstantName(name: string, importedFromPackage = false): boolean {
  if (importedFromPackage && /^[A-Z][A-Z0-9_]*$/u.test(name)) return true;
  return /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/u.test(name);
}

/**
 * The import specifiers of `name` that make an UNRESOLVED read of it worth
 * disclosing (V1's "a name this file explicitly imports and reads is a real
 * binding"): the NAMED (non-wildcard) ones, except that a bare ALL-CAPS word
 * that is also ordinary prose/platform vocabulary (`isProseAcronym` --
 * `URL`, `API`, `TTL`, `JSON`...) counts only when it is imported from a
 * WORKSPACE file (a relative specifier). Such a name IS looked up as a
 * candidate now (`evidenceClosure.ts`'s `looksLikeConstantReference`: a module
 * constant may be called `TTL`), but `import { URL } from "node:url"` names a
 * platform global, and disclosing every unresolved one of those as a missing
 * constant would be the noise `isUnresolvableConstantName`'s own doc warns
 * about. Everything else keeps the exact behaviour it always had.
 */
export function disclosableNamedSpecs(name: string, specs: readonly ImportSpecifier[]): ImportSpecifier[] {
  const named = specs.filter((spec) => spec.wildcard !== true);
  return isProseAcronym(name) ? named.filter((spec) => spec.relative) : named;
}

/** Lines of a resolved declaration `declarationCarriesNoConstantValue` reads: its head, and a const's initializer opening. */
export const DECLARATION_HEAD_LINES = 40;

/** FIX-G: true when `bodyLines` itself declares `name` (a local `const X =`, a Python/Go local assignment) — its value is in the served body, so it is neither a module constant to fetch nor an unresolved one. */
export function bodyDeclaresLocal(bodyLines: readonly string[], name: string, hashComment: boolean): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const declRe = new RegExp(`(?:\\b(?:const|let|var|val|final|auto)\\s+(?:[\\w<>\\[\\],\\s]+\\s+)?${escaped}\\b)|(?:^\\s*${escaped}\\s*(?::[^=]*)?:?=(?!=))`, "u");
  return bodyLines.some((line) => declRe.test(maskNonCode(line, hashComment)));
}

/** V2 (round-7 fable finding, classMethodJavaBareField/ktBareFieldConst): languages with IMPLICIT `this`/`self` member access -- a bare identifier inside a method body that also names a field the owner type declares is a self-property read with NO qualifier at all. TS/JS/Python explicitly excluded: both require an explicit `this.`/`self.` for a property read (a bare name there is a local/parameter, never a field) -- applying this to them would misattribute an ordinary same-named parameter. */
export function languageHasImplicitThisFields(relPath: string): boolean {
  return /\.(?:java|kt|kts|cs|cpp|cc|cxx|hpp|hh|h|swift|scala|dart)$/.test(relPath);
}

export interface ConstantClosure {
  /** Every constant window found, in serving order (the hook serves and requires all of them). */
  readonly windows: NamedWindow[];
  /** How many leading `windows` are the FOCAL's own constants (the rest were read by one-hop callees). */
  readonly ownCount: number;
  /** Constant-shaped names the FOCAL's own body reads with no declaration found (same file or one import hop). */
  readonly unresolved: string[];
  /** `unresolved` names resolved to a non-relative IMPORT specifier (P2-10, round-6 fable finding, externalPackageConst): name -> the package specifier that named it, so the gate can name the package in its disclosure. */
  readonly unresolvedPackages: Readonly<Record<string, string>>;
  /** P0-2 (round-6 fable finding): instance/static property names (`this.p`/`self.p`/`Owner.P`) the focal reads whose value this scan could not resolve to any served window -- the owner declaration was not found in the class body at all, OR it was found but its own initializer resolved to nothing servable (e.g. a qualified `Owner.CONST` reference `constantLikeReferencesIn` does not chase). Never covered by an inline literal alone (facetGate.ts, P3). */
  readonly unresolvedProperties: string[];
  /** V4 (round-7 fable finding, valueBehindConfigAccessor): name -> the exact construction/call expression (`new Settings()`) for a resolved binding whose own text carries no literal and is nothing but that one call -- `chaseConstant`'s `constructionOnlyInitializer` check. Never pushed to `windows` (P3: never silently "covered"); disclosed with this exact expression text. */
  readonly unresolvedConstructedValues: Readonly<Record<string, string>>;
  /** P1-4 (round-7 fable finding, item 4): `unresolved` qualified names (`Owner.member`) for which SEVERAL files declare `Owner` and neither the focal's own file nor its own imports proved which one -- `findQualifiedConstantWindow`'s own `ambiguousCandidates`, name -> the candidate file paths, so the gate can name them instead of the generic "could not be resolved" wording (never silently picks one, P1). */
  readonly unresolvedConstantCandidates: Readonly<Record<string, readonly string[]>>;
  /**
   * FIX-ALIAS (eval-0929 §4, root cause 2): name -> a short attribution
   * ("read by CLIENT_DEFAULTS in src/defaults.ts") for a constant-shaped or
   * plainly-imported name a SERVED window's own text reads (depth >= 1 —
   * a dependency of that window's OWN value, never the focal's direct read)
   * that this scan could not resolve. `chaseConstant` used to record a
   * miss's name in `unresolved` ONLY at depth 0 — a depth>=1 miss is a
   * constant's OWN dependency, not something the focal's body itself named,
   * and folding it into the plain `unresolved` list would have facetGate.ts
   * say "read by ${focal.name}", mislabeling whose read it actually is (the
   * confirmed bug: `getTimeout` -> `CLIENT_DEFAULTS` -> `DEFAULT_MS`, an
   * alias for `BASE_TIMEOUT` — 7231 never served, no gap disclosed either).
   * Distinct key space from `unresolved`/`unresolvedProperties`: a name here
   * is never ALSO pushed to those.
   */
  readonly unresolvedDependencies: Readonly<Record<string, string>>;
  /** False when the scan stopped at `deadline`. */
  readonly complete: boolean;
}
