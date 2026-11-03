// constantResolution — extracted implementation; imports point to the owning modules.
import * as path from "path";
import type { ImportSpecifier } from "../evidenceClosure.js";
import { DECLARATION_HEAD_LINES } from "./constantResolution3.js";
import { FileReadCache } from "./packBasics2.js";
import { MAX_REEXPORT_FILES_TOTAL } from "./callableResolution4.js";
import { MAX_REEXPORT_HOPS } from "./callableResolution4.js";
import { declarationCarriesNoConstantValue } from "../evidenceClosure.js";
import { escapeRegExp } from "../../search/find/findText.js";
import { findModuleConstantWindow } from "../evidenceClosure.js";
import { hasHashComments } from "../callerExpansion.js";
import { importSpecifiersNaming } from "../evidenceClosure.js";
import { languageForPath } from "../../../util/languages.js";
import { resolveImportSpecifierFile } from "./callableResolution4.js";
import { scanGoPackageSiblings } from "./constantResolution3.js";

/**
 * R2-T3: `content.split(/\r?\n/)` of `relPath`, once per `cache` -- the
 * per-file line indexes `findModuleConstantWindow`/`importSpecifiersNaming`
 * keep are keyed by the lines ARRAY, so handing every name lookup a fresh
 * split threw the index away each time (the closure asks once per candidate
 * name, and a package/re-export search may now touch dozens of files).
 */
export const cachedFileLinesMemo = new WeakMap<FileReadCache, Map<string, { content: string; lines: string[] }>>();

export function cachedFileLines(cache: FileReadCache, relPath: string, content: string): string[] {
  let byPath = cachedFileLinesMemo.get(cache);
  if (byPath === undefined) {
    byPath = new Map();
    cachedFileLinesMemo.set(cache, byPath);
  }
  const hit = byPath.get(relPath);
  // `content` is the cache's own memoized string (same reference each call),
  // so this is O(1); a `reseed`ed replacement simply splits again.
  if (hit !== undefined && hit.content === content) return hit.lines;
  const lines = content.split(/\r?\n/);
  byPath.set(relPath, { content, lines });
  return lines;
}

/**
 * FIX-FAB item 3 (eval-0927 review #6, golang): Go's PACKAGE-level
 * (same-directory) constant/var visibility — `DefaultTimeout`,
 * `retryableStatuses` declared in SIBLING `.go` files of the same package,
 * never through an import (Go has no per-name import for a package-local
 * binding — `importSpecifiersNaming`'s own stated limitation). Mirrors
 * `resolveCalleeFile`'s existing Go same-directory fallback, with the
 * ADDITIONAL test-file exclusion item 3 asks for: a non-test owner never
 * resolves a constant that lives only in a sibling `_test.go` file, while an
 * owner that is ITSELF in a test file may still read one.
 *
 * R2-T3 (eval-0929 final review, P0-4 -- goSib2direct/goSib4direct/goSib8direct/
 * goSib2chain): the scan used to stop after MAX_IMPORT_RESOLVED_FILES_PER_FOCAL
 * (2) sibling files IN DIRECTORY ORDER, and PascalCase/camelCase names never
 * reach a disclosure (`isUnresolvableConstantName` needs CONST_CASE), so a
 * package with three or more other files lost `StepBaseMs` whenever it sorted
 * behind the second one: a false `request-item-empty` for a direct read, and a
 * pure-reference hop (`const stepRefMs = StepBaseMs`) certified `covered` with
 * the literal never served. A Go package is EXACTLY the non-test `.go` files of
 * one directory, so the declaration is now searched in every one of them
 * (`scanGoPackageSiblings`) -- bounded by BYTES READ, never by file count or
 * directory order. Only when that byte bound is really hit before the
 * declaration is found is the miss reported (`onBounded`), so the caller
 * discloses the name as undetermined instead of absent.
 */
export async function findGoPackageConstantWindow(
  ownerPath: string,
  name: string,
  workspace: string,
  cache: FileReadCache,
  opts: { byteBudget?: number; onBounded?: () => void } = {},
): Promise<{ path: string; start: number; end: number; truncated: boolean } | undefined> {
  if (path.extname(ownerPath) !== ".go") return undefined;
  // A Go declaration of `name` -- `const|var NAME`, or a member of a grouped
  // `const (`/`var (` block -- starts a line with the name (after indentation
  // and an optional keyword): a necessary condition, tested on the raw text
  // BEFORE any file is split and token-indexed. Without it every sibling that
  // merely MENTIONS a common name (`time`, `err`) was indexed for nothing.
  const declaration = new RegExp(`(?:^|\\n)[ \\t]*(?:(?:const|var)[ \\t]+)?${escapeRegExp(name)}\\b`);
  const { hit, bounded } = scanGoPackageSiblings(ownerPath, workspace, cache, (relPath, content) => {
    const window = findModuleConstantWindow(cachedFileLines(cache, relPath, content), name, false);
    return window ? { path: relPath, start: window.start, end: window.end, truncated: window.truncated } : undefined;
  }, { byteBudget: opts.byteBudget, mightMatch: (content) => content.includes(name) && declaration.test(content) });
  if (hit === undefined && bounded) opts.onBounded?.();
  return hit;
}

/**
 * Copilot standard-setup evaluation (2026-10-02): true when `name`, imported
 * through one of `namedSpecs` (the reading file's NAMED, non-wildcard
 * specs), reaches a workspace file -- the spec's own target, or a barrel it
 * re-exports through, on the same bounded walk `findConstantAcrossReexports`
 * takes (MAX_REEXPORT_HOPS / MAX_REEXPORT_FILES_TOTAL) -- whose every own
 * top-level declaration of the imported binding carries no constant value
 * (`declarationCarriesNoConstantValue`: a function, a const bound to one, a
 * type alias, an interface, a trait). A value-position read of such a name
 * (a callback `rows.map(normalize)`, an array element `[handler]`, a cast
 * `x as Shape`) reads a callable or a type, never a constant whose value
 * the facet still needs, so its failed CONSTANT resolution is not missing
 * evidence. Measured: `quote` imported the function `shipping` and the pack
 * disclosed "shipping is read by quote but its declaration could not be
 * resolved" while shipping.ts sat in the same response. Never true for what
 * the walk cannot prove: a package import, a default export, a file it
 * cannot parse, or a binding with any declaration that may hold a value --
 * a class, enum, struct or object (`Limits.MAX`, `Status.PAID`; review
 * 2026-10-02), or a const merged with a same-named interface.
 */
export async function importedBindingIsCallableOrType(
  name: string,
  namedSpecs: readonly ImportSpecifier[],
  ownerPath: string,
  workspace: string,
  cache: FileReadCache,
): Promise<boolean> {
  const visited = new Set<string>([ownerPath]);
  let frontier: Array<{ path: string; specs: readonly ImportSpecifier[]; seek: string }> = [{ path: ownerPath, specs: namedSpecs, seek: name }];
  let filesVisited = 0;
  for (let hop = 0; hop < MAX_REEXPORT_HOPS && frontier.length > 0; hop++) {
    const nextFrontier: typeof frontier = [];
    for (const { path: fromPath, specs, seek } of frontier) {
      for (const spec of specs) {
        if (filesVisited >= MAX_REEXPORT_FILES_TOTAL) return false;
        const target = await resolveImportSpecifierFile(fromPath, spec, workspace, cache);
        if (target === undefined || visited.has(target.path)) continue;
        visited.add(target.path);
        filesVisited += 1;
        const declared = spec.exportedName ?? seek;
        if (declared === "default") continue;
        const lang = languageForPath(target.path);
        const parsed = (lang ? await cache.parsedSymbols(target.content, lang, target.path) : null) ?? [];
        const own = parsed.filter((symbol) => symbol.enclosingSymbol === undefined && symbol.name === declared);
        const targetLines = cachedFileLines(cache, target.path, target.content);
        const targetHashComment = hasHashComments(target.path);
        if (own.length > 0) {
          return own.every((symbol) => {
            const start = Math.max(0, symbol.startLine - 1);
            const end = Math.min(Math.max(symbol.endLine, symbol.startLine), start + DECLARATION_HEAD_LINES);
            return declarationCarriesNoConstantValue(symbol.kind, targetLines.slice(start, end), targetHashComment);
          });
        }
        nextFrontier.push({
          path: target.path,
          specs: importSpecifiersNaming(targetLines, declared, targetHashComment, target.path),
          seek: declared,
        });
      }
    }
    frontier = nextFrontier;
  }
  return false;
}
