// constantResolution — extracted implementation; imports point to the owning modules.
import type { NamedWindow } from "./callableResolution2.js";
import { FileReadCache } from "./packBasics2.js";
import { MAX_REEXPORT_FILES_TOTAL } from "./callableResolution4.js";
import { MAX_REEXPORT_HOPS } from "./callableResolution4.js";
import { cachedFileLines } from "./constantResolution2.js";
import { findGoPackageConstantWindow } from "./constantResolution2.js";
import { findJvmImportedConstantWindow } from "./constantResolution3.js";
import { findJvmPackageSiblingConstantWindow } from "./constantResolution3.js";
import { findModuleConstantWindow } from "../evidenceClosure.js";
import { findModuleExportsMemberWindow } from "../evidenceClosure.js";
import { findWildcardImportedConstantWindow } from "./constantResolution3.js";
import { hasHashComments } from "../callerExpansion.js";
import { importSpecifiersNaming } from "../evidenceClosure.js";
import { isRequireMemberInitializer } from "../evidenceClosure.js";
import { resolveImportSpecifierFile } from "./callableResolution4.js";
import { resolveRustUseConstantWindow } from "./constantResolution3.js";

/**
 * FIX-FAB item 4 (barrel): `name`'s declaration may not be in the FIRST
 * import-resolved file at all — a TS/JS barrel (`export { X } from
 * "./defaults"`, `export { Y as X } from "./defaults"`, a wildcard `export *
 * from "./defaults"`) only re-points to yet another file.
 * `importSpecifiersNaming` (evidenceClosure.ts) recognizes those re-export
 * shapes exactly like an import line, so following them is the SAME
 * one-hop resolution repeated up to MAX_REEXPORT_HOPS hops beyond the
 * starting one. Python/Go/Java/C# never reach a second hop here: their
 * import shapes always name the declaring file directly (or, for Go, name
 * nothing at all — `findGoPackageConstantWindow` below is the fallback for
 * that), so the search finds nothing to chase past hop 1 and returns
 * `undefined`, the same "give up" this had before this fix.
 *
 * P1-5 (eval-0927 review r2 finding 5, barrelStar2): a barrel commonly
 * re-exports through SEVERAL wildcard specifiers on the SAME line set
 * (`export * from "./env"; export * from "./defaults";`) — the declaration
 * can be in ANY of them, so every hop must try EVERY specifier of EVERY
 * file reached so far (a real breadth-first search over the frontier of
 * files reached at this hop) before giving up, never stop advancing past
 * the FIRST specifier that merely happens to RESOLVE to a real file
 * (resolving to a file that itself lacks the name is not "the declaration
 * wins", it is one dead end among several siblings still unexamined this
 * same hop). First declaration found, in breadth-first order, wins; bounded
 * by MAX_REEXPORT_HOPS hops and MAX_REEXPORT_FILES_TOTAL files total so a
 * pathological fan-out still terminates.
 */
export async function findConstantAcrossReexports(
  startLines: readonly string[],
  startPath: string,
  name: string,
  workspace: string,
  cache: FileReadCache,
  /**
   * R2-T3 (eval-0929 final review, P0-4's "a cap never becomes a silent
   * empty/covered" ruling): called once when the search ended WITHOUT finding
   * the declaration but was cut short by its own work bounds
   * (MAX_REEXPORT_FILES_TOTAL files, MAX_REEXPORT_HOPS hops) while a
   * workspace module the name could still come from was left unexplored --
   * `chaseConstant` then treats the miss as undetermined instead of absent.
   * Only a MODULE-graph specifier (`packageEligible`: a TS/JS/Python
   * re-export or star import) counts; a C/C++ quoted `#include` makes every
   * local header a candidate for every name by this module's own design, so
   * "not found in the first headers" says nothing about `NULL`/`size_t`.
   */
  onBounded?: () => void,
): Promise<{ path: string; start: number; end: number; truncated: boolean; bindings?: NamedWindow[]; declaredName?: string } | undefined> {
  const visited = new Set<string>([`${startPath}\0${name}`]);
  // FIX-ALIAS (eval-0929 §4, root cause 1): each frontier entry carries the
  // name to search for IN THAT FILE, never a single closure-wide `name` —
  // a rename at hop N (`import { A as B }`) means hop N+1 must look up `A`,
  // the name the FILE AT hop N ACTUALLY DECLARES, never the LOCAL alias `B`
  // hop N's own file happened to spell it with. Every non-aliased spec keeps
  // `exportedName` undefined, so `spec.exportedName ?? seek` is `seek`
  // unchanged — byte-for-byte the prior single-`name` behaviour whenever no
  // hop renames anything.
  let frontier: Array<{ lines: readonly string[]; path: string; name: string; bindings: NamedWindow[]; aliased: boolean }> = [{ lines: startLines, path: startPath, name, bindings: [], aliased: false }];
  let filesVisited = 0;
  let bounded = false;
  for (let hop = 0; hop < MAX_REEXPORT_HOPS && frontier.length > 0; hop++) {
    const nextFrontier: typeof frontier = [];
    for (const { lines, path: filePath, name: seek, bindings, aliased } of frontier) {
      let specifiers = importSpecifiersNaming(lines, seek, hasHashComments(filePath), filePath, true);
      // B4(b) (round-9 fable finding, pyTwoStarImportsLastWins): Python's
      // `from x import *` re-binds the module namespace every time it runs
      // -- when SEVERAL star-import lines in the SAME file could define
      // `name`, the LAST one (source order) is the one whose binding
      // survives at runtime, never the first. This BFS otherwise tries
      // specifiers in source order and returns on the FIRST hit; reversing
      // only the WILDCARD candidates for a Python file makes "first hit"
      // coincide with "last declared" — a NAMED import already pins one
      // exact file (only one can ever name `name` this way), so its
      // position is untouched.
      if (/\.py$/.test(filePath)) {
        const wildcards = specifiers.filter((s) => s.wildcard === true).reverse();
        const named = specifiers.filter((s) => s.wildcard !== true);
        specifiers = [...named, ...wildcards];
      }
      // R2-T3 (eval-0929 final review, P0-4): the per-file
      // `specifiers.slice(0, MAX_IMPORT_RESOLVED_FILES_PER_FOCAL)` that stood
      // here dropped every specifier past the second WITHOUT a word -- a
      // barrel with three `export *` lines, a Python module with three star
      // imports, a C file with three local includes lost the declaration in
      // the third for good, and (when the name is not CONST_CASE and not
      // named-imported) the value facet certified `request-item-empty`. The
      // only work bounds left are the ones that already bound the WHOLE
      // search -- MAX_REEXPORT_FILES_TOTAL files and MAX_REEXPORT_HOPS hops --
      // and reaching either with a module-graph file still unexplored is
      // reported through `onBounded` (see its doc), never swallowed.
      for (const spec of specifiers) {
        if (filesVisited >= MAX_REEXPORT_FILES_TOTAL && spec.packageEligible !== true) continue;
        const resolved = await resolveImportSpecifierFile(filePath, spec, workspace, cache);
        const targetName = spec.exportedName ?? seek;
        const bindingKey = `${resolved?.path}\0${targetName}`;
        if (resolved === undefined || visited.has(bindingKey)) continue;
        if (filesVisited >= MAX_REEXPORT_FILES_TOTAL) { bounded = true; continue; }
        visited.add(bindingKey);
        filesVisited += 1;
        const resolvedLines = cachedFileLines(cache, resolved.path, resolved.content);
        const resolvedHashComment = hasHashComments(resolved.path);
        // FIX-ALIAS: `spec.exportedName` (set only for a rename) is the name
        // THIS resolved file declares — searching it under `seek` (the LOCAL
        // alias the PREVIOUS file happened to import it as) is exactly the
        // confirmed miss (`timeoutMs: DEFAULT_MS` never reaching `7231`).
        const nextBindings = spec.binding === undefined ? bindings : [...bindings,
          { path: filePath, start: spec.binding.start, end: spec.binding.end, name: seek, binding: true }];
        const window = findModuleConstantWindow(resolvedLines, targetName, resolvedHashComment)
          // B3 (round-8 fable finding, cjsDestructureConst): `const { NAME } =
          // require("./config")` already resolves the FILE via the `req`
          // shape above -- the member itself may still be an EXPORTS-OBJECT
          // key (`module.exports = { NAME: ... }`), not a plain top-level
          // declaration, so this module's own export-member search is tried
          // too before giving up on this file.
          ?? findModuleExportsMemberWindow(resolvedLines, targetName, resolvedHashComment);
        // R2-T3: `const RAW = require("./other").X` is itself an IMPORT
        // binding (`importSpecifiersNaming`'s member form), never the
        // declaration -- its line holds no value, so the search goes on
        // INTO `./other` (next hop) exactly as through a barrel.
        if (window && !isRequireMemberInitializer(resolvedLines.slice(window.start - 1, window.end), resolvedHashComment)) {
          return { path: resolved.path, start: window.start, end: window.end, truncated: window.truncated,
            bindings: aliased || spec.exportedName !== undefined ? nextBindings : [], declaredName: targetName };
        }
        nextFrontier.push({ lines: resolvedLines, path: resolved.path, name: targetName, bindings: nextBindings,
          aliased: aliased || spec.exportedName !== undefined });
      }
    }
    frontier = nextFrontier;
  }
  // The hop bound: files reached on the LAST hop were never searched for
  // re-exports of their own. A module-graph specifier there that resolves to
  // a workspace file nobody visited means the search stopped short.
  if (!bounded) {
    for (const { lines, path: filePath, name: seek } of frontier) {
      for (const spec of importSpecifiersNaming(lines, seek, hasHashComments(filePath), filePath, true)) {
        if (spec.packageEligible !== true) continue;
        const resolved = await resolveImportSpecifierFile(filePath, spec, workspace, cache);
        if (resolved !== undefined && !visited.has(`${resolved.path}\0${spec.exportedName ?? seek}`)) { bounded = true; break; }
      }
      if (bounded) break;
    }
  }
  if (bounded) onBounded?.();
  return undefined;
}

/**
 * Same-file (module-level, then exports-object member — B3; B4(a), round-9:
 * a MODULE-ALIAS MEMBER lookup reverses that pair — see `preferExportsMember`
 * below), then a bare Rust `use`-bound constant (B4), then barrel/re-export
 * chase, then Go same-package sibling, then a JVM (Kotlin/Scala) same-package
 * sibling and bare member import (B2, round-9), then a wildcard-imported
 * type/package owner (B2) — the full resolution `constantClosureForFocal`
 * applies to every candidate name, whichever file currently "owns" the
 * search (the focal itself at depth 0, or a resolved constant's own
 * initializer's file at depth >=1 — item 5).
 */
export async function resolveConstantWindow(
  name: string,
  ownerLines: readonly string[],
  ownerPath: string,
  workspace: string,
  cache: FileReadCache,
  /**
   * B4(a) (round-9 fable finding, P1-8): true ONLY from
   * `resolveQualifiedReferencesIn`'s `viaAlias` branch — resolving a MODULE
   * ALIAS's member (`config.TIMEOUT_MS` reached through a `require()`/default
   * import) reads the module's OWN EXPORTS surface, so an explicit key of
   * `module.exports = { TIMEOUT_MS: 6500 }` is what a caller of `config.
   * TIMEOUT_MS` actually observes — it must win over a same-named top-level
   * declaration in the same file (`const TIMEOUT_MS = 1000`, a private local
   * the alias's member access never sees; own reproduction confirmed the
   * local 1000 being served instead). A SHORTHAND key (`{ TIMEOUT_MS }`, no
   * colon) is not matched by `findModuleExportsMemberWindow`'s own `keyRe`
   * (colon-anchored) at all, so it falls through to the top-level
   * declaration below unaffected — exactly right, since a shorthand key IS
   * that same local binding, re-exported by reference (B4(a)'s own second
   * half). The ORDINARY bare-name lookup (every other caller, this
   * parameter omitted/false) keeps the pre-existing "same file first" order
   * — a function inside config.js reading its OWN bare `TIMEOUT_MS` reads
   * the top-level declaration in its own lexical scope, never an unrelated
   * exports object assembled elsewhere in the same file.
   */
  preferExportsMember = false,
  /**
   * Round-9 review: `skipExportsMember` resolves the module's OWN binding
   * behind a self-named export key (`{ TIMEOUT_MS: TIMEOUT_MS }`) — the key
   * itself is not the value. `allowPackageSibling: false` keeps a name the
   * focal binds itself (a loop/catch/lambda variable, a field of its own
   * class) from resolving to an unrelated same-package declaration.
   *
   * R2-T3: `onSearchBounded` is called when a search this function runs
   * (the re-export/import chase, the Go same-package scan) ended empty-handed
   * BECAUSE of its own work bound -- the caller must treat a `undefined` from
   * this call as "not searched to the end", never as "not declared".
   */
  opts: { skipExportsMember?: boolean; allowPackageSibling?: boolean; onSearchBounded?: () => void } = {},
): Promise<{ path: string; start: number; end: number; truncated: boolean; bindings?: NamedWindow[]; declaredName?: string } | undefined> {
  const hashComment = hasHashComments(ownerPath);
  const sameFileRaw = findModuleConstantWindow(ownerLines, name, hashComment);
  // R2-T3 (eval-0929 final review, P1-4): `const B = require("./x").A` matches
  // the declaration shape of `B`, but it is an IMPORT binding -- its line
  // holds no value (`importSpecifiersNaming` reads it as a named spec
  // renaming `A`), so it is never returned as `B`'s own window; the chase
  // below follows it into `./x`, and a miss there is disclosed.
  const sameFile = sameFileRaw !== undefined
    && isRequireMemberInitializer(ownerLines.slice(sameFileRaw.start - 1, sameFileRaw.end), hashComment)
    ? undefined
    : sameFileRaw;
  const exportsMember = opts.skipExportsMember === true ? undefined : findModuleExportsMemberWindow(ownerLines, name, hashComment);
  if (preferExportsMember && exportsMember) {
    return { path: ownerPath, start: exportsMember.start, end: exportsMember.end, truncated: exportsMember.truncated };
  }
  if (sameFile) return { path: ownerPath, start: sameFile.start, end: sameFile.end, truncated: sameFile.truncated };
  if (exportsMember) return { path: ownerPath, start: exportsMember.start, end: exportsMember.end, truncated: exportsMember.truncated };
  const rustUse = await resolveRustUseConstantWindow(name, ownerLines, ownerPath, workspace, cache);
  if (rustUse) return rustUse;
  const chased = await findConstantAcrossReexports(ownerLines, ownerPath, name, workspace, cache, opts.onSearchBounded);
  if (chased) return chased;
  const goPkg = await findGoPackageConstantWindow(ownerPath, name, workspace, cache, { onBounded: opts.onSearchBounded });
  if (goPkg) return goPkg;
  // Kotlin resolution order: an explicit member import wins over a
  // same-package declaration (round-9 review P1-2, ktExplicitImportBeatsSibling).
  const jvmImported = await findJvmImportedConstantWindow(name, ownerLines, ownerPath, workspace, cache);
  if (jvmImported) return jvmImported;
  if (opts.allowPackageSibling !== false) {
    const jvmPkg = await findJvmPackageSiblingConstantWindow(ownerPath, ownerLines, name, workspace, cache);
    if (jvmPkg) return jvmPkg;
  }
  return findWildcardImportedConstantWindow(name, ownerLines, ownerPath, hashComment, workspace, cache);
}
