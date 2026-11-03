// constantClosure — extracted implementation; imports point to the owning modules.
import type { ConstantClosure } from "./constantResolution3.js";
import type { NamedWindow } from "./callableResolution2.js";
import type { OwnerMemberSpan } from "../evidenceClosure.js";
import type { ResolvedFacetFocal } from "./callableResolution2.js";
import { CALLER_EXPANSION_CALLABLE_KINDS } from "./callerExpansion2.js";
import { CALLER_EXPANSION_TYPE_KINDS } from "./callerExpansion2.js";
import { FileReadCache } from "./packBasics2.js";
import { MAX_CALLABLE_CHASE_DEPTH } from "./callableResolution4.js";
import { MAX_CALLEES_PER_REQUIREMENT } from "../evidenceClosure.js";
import { MAX_CONSTANT_INITIALIZER_DEPTH } from "./callableResolution4.js";
import { MAX_PLANNED_CONSTANT_WINDOWS } from "./callableResolution4.js";
import { MAX_PURE_REFERENCE_CHASE_DEPTH } from "./callableResolution4.js";
import { MAX_PURE_REFERENCE_FILES_TOTAL } from "./callableResolution4.js";
import { MAX_SCANNED_CALLEE_NAMES } from "../evidenceClosure.js";
import { bodyDeclaresLocal } from "./constantResolution3.js";
import { calleeNamesIn } from "../evidenceClosure.js";
import { constantLikeReferencesIn } from "../evidenceClosure.js";
import { constructionOnlyInitializer } from "../evidenceClosure.js";
import { declarationIsCallable } from "../evidenceClosure.js";
import { disclosableNamedSpecs } from "./constantResolution3.js";
import { escapeRegExp } from "../../search/find/findText.js";
import { exportsMemberValueReadsOwnName } from "../evidenceClosure.js";
import { findGoQualifiedPackageConstantWindow } from "./constantClosure2.js";
import { findOwnerPropertyWindow } from "../evidenceClosure.js";
import { findQualifiedConstantWindow } from "./constantClosure2.js";
import { focalParameterNames } from "../evidenceClosure.js";
import { hasHashComments } from "../callerExpansion.js";
import { hasValuePositionOccurrence } from "../evidenceClosure.js";
import { importSpecifierResolvesInWorkspace } from "./constantClosure2.js";
import { importSpecifiersNaming } from "../evidenceClosure.js";
import { importedBindingIsCallableOrType } from "./constantResolution2.js";
import { importedModuleAliasesIn } from "../evidenceClosure.js";
import { isPureReferenceInitializer } from "../evidenceClosure.js";
import { isRequireModuleInitializer } from "../evidenceClosure.js";
import { isUnresolvableConstantName } from "./constantResolution3.js";
import { kotlinScopedBindingNames } from "./constantResolution3.js";
import { languageForPath } from "../../../util/languages.js";
import { languageHasImplicitThisFields } from "./constantResolution3.js";
import { maskNonCode } from "../callerExpansion.js";
import { ownerFieldNames } from "../evidenceClosure.js";
import { propertyInitializerIsSelfContained } from "../evidenceClosure.js";
import { qualifiedConstantReferencesIn } from "./constantClosure2.js";
import { readCached } from "./packBasics2.js";
import { resolveCalleeFile } from "./callableResolution3.js";
import { resolveConstantWindow } from "./constantResolution.js";
import { resolveModuleNamespaceFile } from "./constantClosure2.js";
import { selfPropertyReferencesIn } from "../evidenceClosure.js";
import { unqualifiedSymbolTail } from "./anchorFocus3.js";

export async function constantClosureForFocal(
  focal: ResolvedFacetFocal,
  workspace: string,
  cache: FileReadCache,
  deadline: number,
  /**
   * Copilot retest review (2026-10-02): the callee windows the value/condition
   * closure requires (`calleeDefinitionsForFocal`, both layers). When given,
   * their bodies are scanned for constants instead of re-resolving the focal's
   * direct callee names, so a required second-layer callee never arrives
   * without its constants and no name is resolved twice. Omitted: the
   * direct-callee name walk below (a non-callable focal).
   */
  calleeWindows?: readonly NamedWindow[],
): Promise<ConstantClosure> {
  const out: NamedWindow[] = [];
  const unresolved: string[] = [];
  const unresolvedPackages: Record<string, string> = {};
  const unresolvedProperties: string[] = [];
  const constructedValues: Record<string, string> = {};
  const constantCandidates: Record<string, readonly string[]> = {};
  const dependencyDisclosures: Record<string, string> = {};
  /** R2-T3: names whose declaration search ended for want of its own work bound (see `resolveConstantWindow`'s `onSearchBounded`) -- an unresolved read of one is undetermined, never absent. */
  const searchBoundedNames = new Set<string>();
  let complete = true;
  const content = readCached(workspace, focal.path, cache);
  if (content === undefined) {
    return {
      windows: out, ownCount: 0, unresolved, unresolvedPackages, unresolvedProperties,
      unresolvedConstructedValues: constructedValues, unresolvedConstantCandidates: constantCandidates,
      unresolvedDependencies: dependencyDisclosures, complete,
    };
  }
  const lines = content.split(/\r?\n/);
  const hashComment = hasHashComments(focal.path);
  const bodyLines = lines.slice(focal.startLine - 1, focal.endLine);
  // B1 (round-8 fable finding, cppScopedConst/pyStarImportLowerConst/
  // csUsingStaticPascalConst): never a candidate for a MODULE-constant
  // resolution/disclosure — the focal's own type (a bare `::`-qualified
  // owner token, e.g. `Client` in `Client::request` reading `Config::X`,
  // stays a candidate through `constantLikeReferencesIn`'s own `::`-member
  // exception unless excluded here too), and the focal's own parameters —
  // see `focalParameterNames`'s own doc. THE ROUND-9 LESSON (binding,
  // pyKwargSameNameImportedConst/rustMatchArmConstCondition): every OTHER
  // transient-binding shape (loop/catch/except/lambda/arrow/Kotlin-lambda/
  // keyword-argument NAME) used to be excluded here too, by NAME, across the
  // WHOLE body (`transientBindingNamesIn`) — round 8's own fix for a
  // DIFFERENT bug (an accidental collision with `namesDeclaredWithin`'s
  // locals). That NAME-level exclusion is over-broad: a keyword argument's
  // NAME token (`timeout=`) and its VALUE token (`=timeout`) are the SAME
  // string, so excluding the name everywhere ALSO dropped the value-side
  // read of an imported/module constant that happens to share the
  // parameter's name (`fetch(url, timeout=timeout)` reading an imported
  // `timeout`); a Rust `match`/C#-switch-expression pattern arm
  // (`RETRY_LIMIT => …`) is syntactically identical to a bare arrow-lambda
  // parameter (`x => …`), so the SAME name-level rule silently dropped a
  // genuine constant used as a match pattern. Exclusion is now POSITIONAL
  // (only the exact kwarg-NAME token, gated to Python/Kotlin/Scala —
  // `constantLikeReferencesIn`'s own `isKeywordArgumentNamePosition` check)
  // — never a whole-body name drop — except for the focal's OWN parameters
  // and own type immediately below, which the language itself binds for the
  // entire body, no positional ambiguity possible. A loop/catch/lambda
  // variable that fails to resolve as a module constant (the common case)
  // simply costs one harmless failed lookup, exactly as any other
  // non-resolving candidate already does.
  const excludeNames = new Set<string>([
    focal.name,
    ...(focal.typeName ? [focal.typeName] : []),
    ...focalParameterNames(bodyLines, hashComment, focal.name, focal.path),
  ]);
  // R6-C (eval-0927 review-r5 P1-3): `focal.path` lets `constantLikeReferencesIn`
  // keep a constant visible inside a C#/Kotlin/Swift/Ruby interpolated string
  // or past a JS/TS regex literal (csInterpolatedConst/ktTemplateConst/
  // tsRegexQuoteConst) instead of silently masking it away.
  const candidates = constantLikeReferencesIn(bodyLines, hashComment, focal.name, excludeNames, focal.path);
  const visitedConstantNames = new Set<string>([`${focal.path}\0${focal.name}`]);
  const resolvedConstantBindings = new Set<string>();
  // V3 (round-7 fable finding, goCrossPackageConst): lowercase MODULE/PACKAGE
  // aliases this FILE imports (Go package, Python module, Rust/C++
  // namespace) -- `qualifiedConstantReferencesIn` accepts a lowercase owner
  // ONLY when it is in this set, so an ordinary lowercase property chain
  // (`response.status`) is never mistaken for a constant reference.
  const moduleAliases = importedModuleAliasesIn(lines, hashComment);
  // V3: qualified references (`Owner.member`/`Owner::member`) already pushed
  // or disclosed, across every depth this closure visits -- avoids a repeat
  // disclosure/lookup for the SAME qualified name reached from two different
  // reading contexts (the focal's own body AND a chased window's text).
  const visitedQualifiedNames = new Set<string>();
  // WP-A2 (eval-0929 §4/§8, defect (c) -- WP-A's deferred item): a
  // PURE-REFERENCE hop (`chaseConstant`'s `isPureReference`, computed from
  // `isPureReferenceInitializer`) has served no literal at all, so it keeps
  // being chased past MAX_CONSTANT_INITIALIZER_DEPTH under this SEPARATE,
  // still-bounded budget -- `pureReferenceFilesVisited` mirrors
  // MAX_REEXPORT_FILES_TOTAL's own total-files cap (a distinct walk, its own
  // ceiling), and `pureReferenceOpenStack` holds the names whose OWN
  // pure-reference chase is still open on the CURRENT call stack, so a cycle
  // among nothing-but-references (`A = B; B = A;`) is recognized as never
  // bottoming out in a value instead of the ordinary same-closure dedup
  // (`visitedConstantNames`) silently reporting it "already resolved".
  const pureReferenceFilesVisited = new Set<string>();
  const pureReferenceOpenStack = new Set<string>();

  /**
   * FIX-FAB item 5 (eval-0927 review #8, twoConstants): resolves `name`
   * against `ownerLines`/`ownerPath` (same file, then barrel/re-export
   * chase, then Go same-package sibling — items 3/4), pushes its window,
   * then — within MAX_CONSTANT_INITIALIZER_DEPTH — scans the window's OWN
   * served text for further constant-like references and chases those too
   * (`TOTAL_BUDGET_MS = BASE_TIMEOUT_MS * MAX_ATTEMPTS` reads two more
   * constants a depth-0-only resolution never saw). A TRUNCATED window's own
   * tail is never scanned for further references — item 6: the tail wasn't
   * served, so a reference inside it isn't served either, and the facet
   * stays open on the truncation itself first (facetGate.ts's continuation).
   * `depth === 0` is the focal's own direct read, the only depth
   * `unresolved[]` is reported for — a depth>=1 miss is a constant's OWN
   * dependency, not something the original clause named, and disclosing it
   * under the SAME identifier would mislabel whose read it is.
   */
  // Round-9 review P1-2 (ktSiblingShadowedByField/ktLoopVarShadowsSibling):
  // names the Kotlin/Scala focal binds itself or reads as a field of its own
  // class never resolve to a same-package top-level declaration elsewhere.
  let focalOwnBindings: Set<string> | undefined;
  async function focalBindsItself(name: string): Promise<boolean> {
    if (focalOwnBindings === undefined) {
      focalOwnBindings = kotlinScopedBindingNames(bodyLines, hashComment, focal.path);
      if (focal.hasRealType && content !== undefined) {
        const lang = languageForPath(focal.path);
        const parsed = (lang ? await cache.parsedSymbols(content, lang, focal.path) : null) ?? [];
        const classSymbol = parsed.find((s) =>
          CALLER_EXPANSION_TYPE_KINDS.has(s.kind)
          && unqualifiedSymbolTail(s.name) === focal.typeName
          && s.startLine <= focal.startLine && s.endLine >= focal.endLine);
        if (classSymbol !== undefined) {
          const methodSpans: OwnerMemberSpan[] = parsed
            .filter((s) => CALLER_EXPANSION_CALLABLE_KINDS.has(s.kind) && s.startLine >= classSymbol.startLine && s.endLine <= classSymbol.endLine)
            .map((s) => ({ start: s.startLine, end: s.endLine, name: unqualifiedSymbolTail(s.name) }));
          for (const field of ownerFieldNames(lines, classSymbol.startLine, classSymbol.endLine, methodSpans, hashComment)) focalOwnBindings.add(field);
        }
      }
    }
    return focalOwnBindings.has(name);
  }

  // Round-9 orchestrator check (o9RustAssocConst): a constant the focal reads
  // through its OWN type with `::` — Rust `Self::X` / `Type::X` (declared in
  // an `impl Type` block), PHP `self::X` / `static::X`, C++ `Type::X` inside
  // Type — lives in that type's body, not at module level; it used to be
  // disclosed as "could not be resolved" while sitting in the same file.
  async function ownTypeScopedConstantWindow(name: string): Promise<{ path: string; start: number; end: number; truncated: boolean } | undefined> {
    const typeName = focal.typeName;
    if (typeName === undefined || typeName.length === 0) return undefined;
    const ownRead = new RegExp(`(?:\\bSelf|\\bself|\\bstatic|(?<![\\w$])${escapeRegExp(typeName)})\\s*::\\s*${escapeRegExp(name)}(?![\\w$])`);
    if (!bodyLines.some((line) => ownRead.test(maskNonCode(line, hashComment, focal.path)))) return undefined;
    const found = await findQualifiedConstantWindow(typeName, name, focal.path, lines, workspace, cache);
    const window = found.window;
    return window === undefined ? undefined : { path: window.path, start: window.start, end: window.end, truncated: window.truncated === true };
  }

  /**
   * FIX-ALIAS (eval-0929 §4, root cause 2, requirement (b)): `depName` is a
   * name `readLines` (the SPECIFIC text that read it — a resolved window's
   * own initializer, a qualified reference's own window, a callee's body, a
   * self-property's initializer) reads, that `chaseConstant` just failed to
   * resolve. Disclosed — attributed to `readByName`/`ownerPath`, never to
   * `focal.name` (the plain `unresolved` list's own attribution, which would
   * mislabel whose read this is, per `chaseConstant`'s own doc) — under the
   * SAME predicate depth 0 already uses (constant-shaped, or a name this
   * OWNER file plainly imports and reads in a value position): a name that
   * is neither is left silent exactly as a depth-0 miss would be (a called
   * function reached but not itself resolvable is not a missing VALUE).
   * A name already in `unresolved` (depth 0 already owns it) or already
   * disclosed here is left alone — never double-attributed.
   */
  async function discloseUnresolvedDependency(
    depName: string,
    ownerLines: readonly string[],
    ownerPath: string,
    ownerHashComment: boolean,
    readLines: readonly string[],
    readByName: string,
  ): Promise<void> {
    if (unresolved.includes(depName) || Object.prototype.hasOwnProperty.call(dependencyDisclosures, depName)) return;
    const specs = importSpecifiersNaming(ownerLines, depName, ownerHashComment, ownerPath);
    const namedSpecs = disclosableNamedSpecs(depName, specs);
    const packageSpec = namedSpecs.find((spec) => !spec.relative && spec.packageEligible === true);
    // 2026-10-06 v0.15.1 review follow-up: the depth-0 package-namespace rule
    // (see `packageNamespaceMembersOnly` in the focal pass below) holds for a
    // dependency too. A class focal reaches its methods' bodies through this
    // path, so `vscode.workspace.workspaceFolders` read by `isTracked` was
    // disclosed "vscode (read by isTracked in src/watcher.ts) could not be
    // resolved" beside a pack that served the whole file. The alias set is
    // the OWNER file's, which is where the import lives.
    const ownerModuleAliases = ownerPath === focal.path ? moduleAliases : importedModuleAliasesIn(ownerLines, ownerHashComment);
    const packageNamespaceMembersOnly = ownerModuleAliases.has(depName)
      && !hasValuePositionOccurrence(readLines, ownerHashComment, depName, ownerPath, packageSpec !== undefined ? true : "calls");
    const importedValueRead = namedSpecs.length > 0 && !packageNamespaceMembersOnly
      && hasValuePositionOccurrence(readLines, ownerHashComment, depName, ownerPath);
    // R2-T3: a search that ended for want of its own work bound (a Go package
    // too large to read whole, a re-export graph wider than the file budget)
    // proves nothing about a value read of this name -- undetermined, not absent.
    // (A module/package alias -- Go `time`, Python `os` -- names no constant.)
    const boundedValueRead = searchBoundedNames.has(depName) && !moduleAliases.has(depName) && hasValuePositionOccurrence(readLines, ownerHashComment, depName, ownerPath);
    if ((isUnresolvableConstantName(depName, packageSpec !== undefined) || importedValueRead || boundedValueRead)
      // Copilot standard-setup evaluation (2026-10-02): an import proven to
      // be a function/class/type is not a missing VALUE.
      && !(namedSpecs.length > 0 && await importedBindingIsCallableOrType(depName, namedSpecs, ownerPath, workspace, cache))) {
      dependencyDisclosures[depName] = `read by ${readByName} in ${ownerPath}`;
    }
  }

  /** Returns true when `name` is (now, or already) resolved to a servable window -- a dedup of an EARLIER visit counts (P2-7), not only a fresh push. */
  async function chaseConstant(
    name: string,
    ownerLines: readonly string[],
    ownerPath: string,
    depth: number,
    callableDepth = 0,
    pureRefDepth = 0,
  ): Promise<boolean> {
    const bindingKey = `${ownerPath}\0${name}`;
    const resolvedBinding = (ok: boolean): boolean => {
      if (ok) resolvedConstantBindings.add(bindingKey);
      return ok;
    };
    if (out.length >= MAX_PLANNED_CONSTANT_WINDOWS || Date.now() >= deadline) { complete = false; return false; }
    if (visitedConstantNames.has(bindingKey)) {
      // WP-A2 (eval-0929 §4/§8, defect (c)): re-entering a name whose OWN
      // pure-reference chase is still OPEN on this very call stack (`A =
      // B; B = A;`) is a genuine cycle that never bottoms out in a real
      // value -- the window(s) already pushed for it are themselves
      // nothing but further references, so reporting "already resolved"
      // here would be exactly the silent cover this fix exists to close.
      // `false` lets the CALLER's own existing dependency-disclosure branch
      // (the `inner` loop below) name it exactly like any other unresolved
      // reference, attributed to whichever window's text closed the loop.
      if (pureReferenceOpenStack.has(bindingKey)) return false;
      // P2-7 (round-7 fable finding, classMethodSharedConstProp/
      // classMethodTwoPropsSameConst): a name a SECOND reading context (a
      // sibling property's own initializer, or the focal's own body reading
      // it directly too) also references may already have been resolved by
      // an EARLIER visit this same closure made -- returning here without
      // pushing a SECOND window for it is a dedup, not a miss: `out` already
      // carries the resolved window under this exact name (or the earlier
      // visit reached one through a callable hop -- the SAME
      // `innerResolvedAny` fold below computes a fresh visit's own "resolved"
      // fact identically).
      return resolvedConstantBindings.has(bindingKey);
    }
    visitedConstantNames.add(bindingKey);
    const allowPackageSibling = !(depth === 0 && ownerPath === focal.path && /\.(?:kt|kts|scala|sc)$/.test(ownerPath) && await focalBindsItself(name));
    let searchBounded = false;
    const resolved: Awaited<ReturnType<typeof resolveConstantWindow>> = await resolveConstantWindow(name, ownerLines, ownerPath, workspace, cache, false, {
      allowPackageSibling,
      onSearchBounded: () => { searchBounded = true; },
    })
      ?? (depth === 0 ? await ownTypeScopedConstantWindow(name) : undefined);
    if (resolved === undefined) {
      // R2-T3: remembered for the caller's dependency disclosure too (a
      // depth >= 1 miss is judged by `discloseUnresolvedDependency`).
      if (searchBounded) searchBoundedNames.add(name);
      if (depth === 0 && !bodyDeclaresLocal(bodyLines, name, hashComment)) {
        // P2-13 (round-4/5 fable finding, externalPackageConst): a name this
        // FILE names through a non-relative (package) import specifier but
        // could not resolve to any workspace file is disclosed whatever its
        // case — see `isUnresolvableConstantName`'s own doc for why this is
        // gated on import-origin, never a bare naming relaxation.
        // P2-10 (round-6 fable finding, externalPackageConst): the PACKAGE
        // specifier itself (`@acme/http-defaults`) is recorded here, the one
        // place this scan still holds it, so the gate can name it.
        const specs = importSpecifiersNaming(ownerLines, name, hashComment, ownerPath);
        // B1 (round-8 fable finding, pyStarImportLowerConst/
        // csUsingStaticPascalConst/cppScopedConst): a WILDCARD spec (Python
        // `from x import *`, C# `using static`, a quoted #include, a TS/JS
        // `export * from`, Java/Kotlin `.*`) does not NAME `name` at all --
        // `resolveConstantWindow` may still resolve THROUGH it (already
        // tried above, and failed, by the time this branch runs), but it
        // never proves the file "imports" this exact identifier the way
        // V1 requires, so both the package-wording gate and the value-read
        // disclosure below only ever look at a NAMED (non-wildcard) spec —
        // see `ImportSpecifier.wildcard`'s own doc.
        const namedSpecs = disclosableNamedSpecs(name, specs);
        const packageSpec = namedSpecs.find((spec) => !spec.relative && spec.packageEligible === true);
        // V1 (round-7 fable finding, orchestrator generalization): ANY name
        // this FILE imports (relative or package, any case) that this body
        // reads in a VALUE position (not call-only -- `hasValuePositionOccurrence`)
        // and could not resolve is ALSO disclosed, whatever its spelling --
        // being explicitly imported is itself the proof this is a real
        // binding, not noise; a call-only import is a CALLEE this scan may
        // still chase through when it DOES resolve (P0-4), so a FAILED
        // call-only resolution is never disclosed as missing VALUE evidence.
        //
        // v0.15.1 runtime review (2026-10-06): a PACKAGE module/namespace alias
        // reached only through its members (`import * as https from
        // "node:https"` + `https.get(...)`, `import * as vscode from "vscode"`
        // + `vscode.workspace.workspaceFolders`) is an external API the body
        // calls, never a value it computes with — disclosing it as an
        // undetermined value ("https is imported from package node:https; its
        // declaration could not be resolved") gave "the timeout and maximum
        // response size used by fetchLatestRelease" a gap no read could close.
        // A qualified constant through the alias (`cfg.TIMEOUT_MS`) is judged
        // by the qualified-reference pass below, and a bare value read of the
        // alias itself still discloses.
        const packageNamespaceMembersOnly = moduleAliases.has(name)
          && !hasValuePositionOccurrence(bodyLines, hashComment, name, focal.path, packageSpec !== undefined ? true : "calls");
        const importedValueRead = namedSpecs.length > 0 && depth === 0 && !packageNamespaceMembersOnly
          && hasValuePositionOccurrence(bodyLines, hashComment, name, focal.path);
        // R2-T3 (eval-0929 final review, P0-4's cap ruling): the search for
        // this name's declaration ended for want of its own WORK bound (a Go
        // package too large to read whole, a module graph wider than the
        // file budget) -- "not found" is then not "not declared", so a value
        // read of it is undetermined whatever its spelling. Still only a
        // VALUE read: a call is a callee, a type position a type.
        const boundedValueRead = searchBounded && !moduleAliases.has(name) && hasValuePositionOccurrence(bodyLines, hashComment, name, focal.path);
        // Copilot standard-setup evaluation (2026-10-02): a name its import
        // proves to be a FUNCTION/CLASS/TYPE (`importedBindingIsCallableOrType`)
        // read as a value -- a callback, an array element, a cast -- is not a
        // constant this facet is missing, whatever triggered the disclosure.
        if ((isUnresolvableConstantName(name, packageSpec !== undefined) || importedValueRead || boundedValueRead)
          && !(namedSpecs.length > 0 && await importedBindingIsCallableOrType(name, namedSpecs, ownerPath, workspace, cache))) {
          unresolved.push(name);
          // V3 follow-up (MUST, orchestrator round-7 probe, oPyModuleAlias/
          // oPyStarReexport): a specifier that resolves to a real workspace
          // file (a Python absolute package import, `from app import
          // settings`, IS `app/__init__.py` here) is not a package; it keeps
          // the generic "could not be resolved" wording.
          if (packageSpec !== undefined && !(await importSpecifierResolvesInWorkspace(ownerPath, packageSpec, workspace, cache))) {
            unresolvedPackages[name] = packageSpec.specifier;
          }
        }
      }
      return false;
    }
    const winLines = resolved.path === ownerPath ? ownerLines : readCached(workspace, resolved.path, cache)?.split(/\r?\n/);
    // P0-4 (round-4 fable finding, 2026-09-28; supersedes P2-11(b)'s r2 rule):
    // `name` matched a module-binding SHAPE. When its initializer is itself
    // CALLABLE (`declarationIsCallable`: a function/arrow/class binding —
    // `export const shouldRetry = (status) => RETRYABLE_STATUSES.has(status)`)
    // it is not itself a required VALUE (never `unresolved` either: it
    // resolved fine, it is simply not what this facet needs) — but it is
    // exactly the "callee path" this facet must still walk THROUGH: skip
    // only the PUSH below, never the recursion, so the callable's own body
    // is scanned for further constant-like references the SAME way any other
    // resolved window's is (this is how `RETRYABLE_STATUSES` is reached one
    // hop past `shouldRetry`). Every other resolved binding — computed by a
    // call, built by a call, an object with a function-valued member, `new
    // X(...)` — is pushed as a required window exactly as before. A
    // truncated window's own tail was never served, so it is judged exactly
    // as before (never silently dropped by a check run on a partial slice —
    // item 6's own concern) — `declarationIsCallable` is never even asked
    // about a truncated window's OWN callable-ness, mirroring the
    // pre-existing truncated-always-pushed rule.
    //
    // CORRECTION (B3, round-8 fable finding, cjsRequireModuleConst): this
    // comment used to list `require(...)` among the "pushed as a required
    // window exactly as before" shapes — confirmed wrong (eval-0927 review
    // round 7 #4, own reproduction): `const config = require("./config");`
    // is a MODULE alias, and its specifier string is not a value any
    // value/condition question can use; serving this line as the answer is
    // exactly the P3 violation ("certified `covered` while never served")
    // the review found. `isRequireModuleInitializer` below is checked
    // BEFORE `isCallableBinding`/`constructedExpr` and returns immediately:
    // never pushed as a window, never disclosed as a V4 "construction this
    // pack did not follow" either — `config.TIMEOUT_MS` resolves instead
    // through the qualified-alias branch (`importedModuleAliasesIn` /
    // `resolveModuleNamespaceFile`'s own CJS/default-import shapes).
    const isModuleAliasInitializer = !resolved.truncated && winLines !== undefined
      && isRequireModuleInitializer(winLines.slice(resolved.start - 1, resolved.end), hasHashComments(resolved.path));
    if (isModuleAliasInitializer) return resolvedBinding(true);
    const isCallableBinding = !resolved.truncated && winLines !== undefined
      && declarationIsCallable(winLines.slice(resolved.start - 1, resolved.end), hasHashComments(resolved.path));
    // V4 (round-7 fable finding, valueBehindConfigAccessor): a resolved,
    // non-callable window with NO literal anywhere whose value is NOTHING
    // BUT a construction/call (`new Settings()`) answers nothing a value
    // question needs -- never pushed (never silently "covered", P3);
    // disclosed by name with the exact expression instead.
    const constructedExpr = !isCallableBinding && !resolved.truncated && winLines !== undefined
      ? constructionOnlyInitializer(winLines.slice(resolved.start - 1, resolved.end), hasHashComments(resolved.path))
      : undefined;
    if (!isCallableBinding && constructedExpr === undefined) {
      out.push(...(resolved.bindings ?? []));
      out.push({
        path: resolved.path, start: resolved.start, end: resolved.end, name,
        ...(resolved.truncated ? { truncated: true } : {}),
      });
    } else if (constructedExpr !== undefined && !(name in constructedValues)) {
      constructedValues[name] = constructedExpr;
    }
    // P1-4 (round-4/5 fable finding, arrowChainDepth3): a CALLABLE hop is
    // judged against MAX_CALLABLE_CHASE_DEPTH (nothing was pushed for it
    // above, so the chase has not yet reached a real value); every other
    // hop (a genuine VALUE, already pushed above) keeps the SAME smaller
    // MAX_CONSTANT_INITIALIZER_DEPTH bound on its OWN further nested-
    // reference scan as before this fix. Stopping a callable chain before
    // it reaches a value is never silent — `complete` goes false, so the
    // gate's existing `constantsComplete === false` check disclosures this
    // as undetermined instead of falling through to a value that happens to
    // be `covered` merely because some UNRELATED value elsewhere already
    // filled `out`. Stopping a value's OWN further nesting is not this: the
    // value itself is already served, so leaving its own sub-references
    // unchased is a bounded, honest depth choice, never a miss --
    //
    // WP-A2 (eval-0929 §4/§8, defect (c), WP-A's own deferred item): ...
    // EXCEPT when the pushed window is a PURE REFERENCE
    // (`isPureReferenceInitializer` -- nothing but a name/qualified name, or
    // an aggregate of only names, no literal anywhere). Nothing was
    // actually served there, so it must keep being chased past this
    // ordinary cap under its OWN separate, still-bounded budget
    // (`pureRefDepth`/MAX_PURE_REFERENCE_CHASE_DEPTH, and a files-visited
    // cap mirroring MAX_REEXPORT_FILES_TOTAL) -- and if THAT budget runs out
    // before reaching a real value, the name(s) still unread are disclosed
    // exactly like any other unresolved dependency, never silently left as
    // though this window already held the value.
    const depthForCap = isCallableBinding ? callableDepth : depth;
    const cap = isCallableBinding ? MAX_CALLABLE_CHASE_DEPTH : MAX_CONSTANT_INITIALIZER_DEPTH;
    const isPureReference = !isCallableBinding && !resolved.truncated && winLines !== undefined
      && isPureReferenceInitializer(winLines.slice(resolved.start - 1, resolved.end), hasHashComments(resolved.path));
    const pureRefExhausted = pureRefDepth >= MAX_PURE_REFERENCE_CHASE_DEPTH || pureReferenceFilesVisited.size >= MAX_PURE_REFERENCE_FILES_TOTAL;
    const stopHere = resolved.truncated || (isPureReference ? pureRefExhausted : depthForCap >= cap);
    if (stopHere) {
      if (isCallableBinding && depthForCap >= cap && !resolved.truncated) complete = false;
      if (isPureReference && winLines !== undefined) {
        // The pure-reference budget (never the truncation guard, already
        // covered by `resolved.truncated` above) is what stopped this
        // window's own further reference(s) from ever being read --
        // disclose each one now, attributed to THIS window (`name`), never
        // to the focal, which may never mention it directly.
        const winHashComment = hasHashComments(resolved.path);
        const initializerLines = winLines.slice(resolved.start - 1, resolved.end);
        for (const innerName of constantLikeReferencesIn(initializerLines, winHashComment, name, new Set(), undefined, resolved.path)) {
          await discloseUnresolvedDependency(innerName, winLines, resolved.path, winHashComment, initializerLines, name);
        }
        complete = false;
      }
      return resolvedBinding(constructedExpr === undefined);
    }
    if (winLines === undefined) return resolvedBinding(constructedExpr === undefined);
    if (isPureReference) {
      pureReferenceFilesVisited.add(resolved.path);
      pureReferenceOpenStack.add(bindingKey);
    }
    const winHashComment = hasHashComments(resolved.path);
    const initializerLines = winLines.slice(resolved.start - 1, resolved.end);
    const inner = constantLikeReferencesIn(initializerLines, winHashComment, resolved.declaredName ?? name, new Set(), undefined, resolved.path);
    let innerResolvedAny = false;
    for (const innerName of inner) {
      if (out.length >= MAX_PLANNED_CONSTANT_WINDOWS || Date.now() >= deadline) { complete = false; break; }
      const ok = await chaseConstant(
        innerName, winLines, resolved.path,
        isCallableBinding || isPureReference ? depth : depth + 1,
        isCallableBinding ? callableDepth + 1 : callableDepth,
        isPureReference ? pureRefDepth + 1 : pureRefDepth,
      );
      if (ok) innerResolvedAny = true;
      // FIX-ALIAS (root cause 2): `innerName` is a dependency of THIS window's
      // own served value (`name`'s initializer) -- a resolution miss here
      // must not silently leave the outer window certified `covered` while
      // the literal behind it never reached the client.
      else await discloseUnresolvedDependency(innerName, winLines, resolved.path, winHashComment, initializerLines, name);
    }
    // V3 (round-7 fable finding): the SAME qualified-reference scan the
    // focal's own body gets (below, depth 0) also runs on THIS resolved
    // window's own text -- a Java field initializer (`= Defaults.
    // DEFAULT_TIMEOUT_MS`), a re-exported `const TIMEOUT = Config.TIMEOUT_MS`
    // module init -- at every depth this chase reaches, not only the top.
    if (out.length < MAX_PLANNED_CONSTANT_WINDOWS && Date.now() < deadline) {
      const qualifiedOk = await resolveQualifiedReferencesIn(initializerLines, winHashComment, resolved.path);
      if (qualifiedOk) innerResolvedAny = true;
    }
    if (isPureReference) pureReferenceOpenStack.delete(bindingKey);
    return resolvedBinding(constructedExpr === undefined || innerResolvedAny);
  }

  /**
   * V3 (round-7 fable finding): `Owner.member`/`Owner::member` references in
   * `scanLines` (the focal's own body at qualDepth 0, or ANY chased window's
   * text at qualDepth >= 1 -- `chaseConstant` calls this too). P2-8 (round-7
   * fable finding, asConstObjectQualified): `ref.owner` may already be
   * resolved as an ordinary PLAIN candidate (`const Config = {...}`,
   * `chaseConstant`'s own first-loop resolution) -- its FULL window already
   * carries `ref.member`'s value, so a SEPARATE "declaration not found"
   * disclosure for the class/struct-only lookup below would flatly
   * contradict a window already served; reconciled BEFORE that lookup runs.
   * Returns true when at least one reference resolved (or was already
   * covered by an owner's own full window).
   */
  async function resolveQualifiedReferencesIn(
    scanLines: readonly string[],
    scanHashComment: boolean,
    scanPath: string,
    qualDepth = 0,
  ): Promise<boolean> {
    let resolvedAny = false;
    if (Date.now() >= deadline) return false;
    const refs = qualifiedConstantReferencesIn(scanLines, scanHashComment, scanPath, focal.typeName, moduleAliases).slice(0, MAX_CALLEES_PER_REQUIREMENT);
    for (const ref of refs) {
      if (out.length >= MAX_PLANNED_CONSTANT_WINDOWS || Date.now() >= deadline) { complete = false; break; }
      const qualified = `${ref.owner}.${ref.member}`;
      if (out.some((w) => w.name === ref.owner)) { resolvedAny = true; continue; }
      if (visitedQualifiedNames.has(qualified)) {
        if (out.some((w) => w.name === qualified)) resolvedAny = true;
        continue;
      }
      visitedQualifiedNames.add(qualified);
      // V3 (goCrossPackageConst): a Go package alias is resolved through the
      // package's OWN files (never through the class/struct/enum owner-body
      // mechanism below, which simply does not apply to a package
      // qualifier) — `findGoQualifiedPackageConstantWindow` resolves the
      // import PATH via go.mod first, `scanPath`'s own imports (never the
      // outer focal's, since a deeper hop may be scanning a different file).
      if (ref.viaAlias && /\.go$/.test(scanPath)) {
        const goResolution = await findGoQualifiedPackageConstantWindow(ref.owner, ref.member, scanPath, workspace, cache);
        const goWindow = goResolution.window;
        if (goWindow !== undefined) {
          if (!out.some((existing) => existing.path === goWindow.path && existing.start === goWindow.start)) {
            out.push({ ...goWindow, name: qualified });
          }
          resolvedAny = true;
          if (qualDepth < MAX_CONSTANT_INITIALIZER_DEPTH && !goWindow.truncated) {
            const bareOk = await chaseInitializerReferences(goWindow, ref.owner, ref.member, qualDepth);
            if (bareOk) resolvedAny = true;
          }
          continue;
        }
        // FIX-GOALIAS (eval-0929 §4/§8, WP-K): a miss is now disclosed
        // exactly like every OTHER language's alias-miss branch here
        // (`unresolved`/`unresolvedPackages`) — never silently skipped. An
        // import path outside this workspace/module is named
        // (`unresolvedPackages`, the same "imported from package …; its
        // declaration could not be resolved" wording an external TS/Python
        // package import already gets); an in-workspace miss (resolved
        // package, member not found — or no go.mod/binding to resolve
        // against at all) keeps the generic "could not be resolved" wording.
        if (!unresolved.includes(ref.owner) && !unresolved.includes(qualified)) {
          unresolved.push(qualified);
          if (goResolution.external !== undefined) unresolvedPackages[qualified] = goResolution.external;
        }
        continue;
      }
      // V3 follow-up (SHOULD, orchestrator round-7 probe: oPyModuleAlias/
      // oPyStarReexport/oTsNamespaceImport/oRustModuleConst): a non-Go
      // module-namespace alias resolves through the alias's OWN defining
      // file (TS `import * as ns from`, Python `from pkg import mod` /
      // `import pkg.mod`, Rust `use …::mod;` / `mod mod;`), the member
      // looked up at that module's own top level (`resolveConstantWindow`,
      // the SAME one-hop re-export chase an ordinary bare candidate gets —
      // this is how `oPyStarReexport`'s `from .defaults import *` is
      // followed). `nsFile === undefined` means `owner` names NO workspace
      // module at all (stdlib/external, `os`, `node:path`) — stays the
      // silent skip today's behaviour already has, since asserting
      // anything about it would be a guess this scan cannot back up.
      if (ref.viaAlias) {
        const nsFile = await resolveModuleNamespaceFile(ref.owner, focal.path, lines, workspace, cache);
        if (nsFile === undefined) continue;
        if (nsFile === "workspace-module-unresolved") {
          if (!unresolved.includes(ref.owner) && !unresolved.includes(qualified)) unresolved.push(qualified);
          continue;
        }
        // MUST (item 1's general form): the owner DOES resolve to a
        // workspace module -- never ALSO left disclosed "declared outside
        // the workspace" as a bare candidate (`chaseConstant`'s own
        // depth-0 loop may have already tagged it before this qualified
        // reference was reached).
        const ownerIdx2 = unresolved.indexOf(ref.owner);
        if (ownerIdx2 !== -1) { unresolved.splice(ownerIdx2, 1); delete unresolvedPackages[ref.owner]; }
        const nsLines = nsFile.content.split(/\r?\n/);
        // B4(a) (round-9 fable finding): this IS the module-alias-member
        // lookup `resolveConstantWindow`'s own `preferExportsMember` param
        // exists for -- `ref.owner` is a module alias (`config`), `nsFile`
        // its resolved file, `ref.member` the key actually read off it.
        const memberWindow = await resolveConstantWindow(ref.member, nsLines, nsFile.path, workspace, cache, true);
        if (memberWindow === undefined) {
          // SHOULD's own explicit rule: a module that DOES resolve but
          // whose member does not is disclosed, never silently skipped —
          // only a miss on the MODULE ITSELF (stdlib/external) stays silent.
          if (!unresolved.includes(qualified)) unresolved.push(qualified);
          continue;
        }
        if (!out.some((existing) => existing.path === memberWindow.path && existing.start === memberWindow.start)) {
          out.push({ ...memberWindow, name: qualified });
        }
        resolvedAny = true;
        // Round-9 review P0-1 (cjsExplicitSelfKey): a self-named key
        // (`module.exports = { TIMEOUT_MS: TIMEOUT_MS }`, `exports.TIMEOUT_MS =
        // TIMEOUT_MS`) holds no value itself; its value side reads the
        // module's own `TIMEOUT_MS`, which the initializer chase below skips as
        // the key's own name. Resolve that binding (same file, then the
        // module's own imports); if nothing resolves, the member is disclosed
        // instead of certified by the key line alone.
        if (exportsMemberValueReadsOwnName(nsLines, memberWindow, ref.member, hasHashComments(nsFile.path))) {
          const binding = await resolveConstantWindow(ref.member, nsLines, nsFile.path, workspace, cache, false, { skipExportsMember: true });
          if (binding === undefined) {
            if (!unresolved.includes(qualified)) unresolved.push(qualified);
          } else {
            if (!out.some((existing) => existing.path === binding.path && existing.start === binding.start)) {
              out.push({ ...binding, name: qualified });
            }
            if (qualDepth < MAX_CONSTANT_INITIALIZER_DEPTH && !binding.truncated) {
              await chaseInitializerReferences(binding, ref.owner, ref.member, qualDepth);
            }
          }
        }
        if (qualDepth < MAX_CONSTANT_INITIALIZER_DEPTH && !memberWindow.truncated) {
          const bareOk = await chaseInitializerReferences(memberWindow, ref.owner, ref.member, qualDepth);
          if (bareOk) resolvedAny = true;
        }
        continue;
      }
      const resolution = await findQualifiedConstantWindow(ref.owner, ref.member, focal.path, lines, workspace, cache);
      if (resolution.window === undefined) {
        // P2-10/V3 interaction (round-7 fable finding, own reproduction --
        // externalPackageConst/GATEWAYDEFAULTS): when the BARE owner is
        // ALREADY disclosed unresolved (V1's own widening -- typically a
        // package-external import, `unresolvedPackages` already names it),
        // a SEPARATE `Owner.member` disclosure would poison facetGate.ts's
        // "every unresolved name traces to a package" wording (the
        // qualified string carries no package tag of its own) for no new
        // information: the bare disclosure already covers this binding.
        if (!unresolved.includes(ref.owner) && !unresolved.includes(qualified)) unresolved.push(qualified);
        // P1-4: several files declare `ref.owner` and neither priority (1)
        // nor (2) proved one -- name the candidates instead of the generic
        // "could not be resolved" wording (never silently picks one, P1).
        if (resolution.ambiguousCandidates !== undefined) constantCandidates[qualified] = resolution.ambiguousCandidates;
        continue;
      }
      // V1/V3 reconciliation (round-7 fable finding, own reproduction --
      // otherClassStaticLowerProp/qualifiedConstObjectMember/pyEnumValueAccess):
      // the OWNER (a real workspace class/object/enum, e.g. `Settings`) may
      // already have been wrongly disclosed unresolved as a BARE candidate
      // -- `findModuleConstantWindow` only recognizes a `const Owner = ...`
      // shape, never a `class Owner {...}` declaration, so the bare
      // resolution attempt legitimately fails even though `Owner.member`
      // resolves fine right here. Un-disclose it: it is not "unresolved",
      // it is a type accessed through a qualified member.
      const ownerIdx = unresolved.indexOf(ref.owner);
      if (ownerIdx !== -1) { unresolved.splice(ownerIdx, 1); delete unresolvedPackages[ref.owner]; }
      if (!out.some((existing) => existing.path === resolution.window!.path && existing.start === resolution.window!.start)) {
        out.push({ ...resolution.window, name: qualified });
      }
      resolvedAny = true;
      if (qualDepth < MAX_CONSTANT_INITIALIZER_DEPTH && resolution.window.truncated !== true) {
        const bareOk = await chaseInitializerReferences(resolution.window, ref.owner, ref.member, qualDepth);
        if (bareOk) resolvedAny = true;
      }
    }
    return resolvedAny;
  }

  /**
   * V3: a qualified reference's OWN resolved window may itself read further
   * bare/qualified names (`otherClassStaticLowerProp`: `Settings.defaults`
   * resolves to `static readonly defaults: Options = DEFAULT_OPTIONS;`,
   * which then needs `DEFAULT_OPTIONS` chased too) -- the SAME
   * one-hop-further scan `chaseConstant` runs on an ordinary resolved
   * window's initializer, shared here for a qualified one.
   *
   * `ownerName`/`memberName` are the QUALIFIED reference's own two parts
   * (`Presets`/`FLUSH_MS`), passed SEPARATELY and excluded as BARE names --
   * never the joined `"Owner.member"` string, which would fail to exclude
   * the window's own bare member name from `constantLikeReferencesIn`'s
   * candidate scan. Confirmed root cause (2026-09-28, own reproduction): two
   * classes in one file both declare a field of the SAME name
   * (`Presets.FLUSH_MS` / `LegacyPresets.FLUSH_MS`) -- passing the joined
   * string left the window's OWN "FLUSH_MS" token unexcluded, so it became
   * a candidate `chaseConstant` re-resolved via the UNSCOPED
   * `findModuleConstantWindow` (whose Java/C#-style static-field shape is
   * not owner-body-scoped), landing on the WRONG sibling class's
   * same-named field.
   */
  async function chaseInitializerReferences(
    win: { path: string; start: number; end: number },
    ownerName: string,
    memberName: string,
    qualDepth: number,
  ): Promise<boolean> {
    const winLines = readCached(workspace, win.path, cache)?.split(/\r?\n/);
    if (winLines === undefined) return false;
    const winHashComment = hasHashComments(win.path);
    const initializerLines = winLines.slice(win.start - 1, win.end);
    const bareInner = constantLikeReferencesIn(initializerLines, winHashComment, memberName, new Set([ownerName]), undefined, win.path);
    let resolvedAny = false;
    for (const innerName of bareInner) {
      if (out.length >= MAX_PLANNED_CONSTANT_WINDOWS || Date.now() >= deadline) { complete = false; break; }
      const ok = await chaseConstant(innerName, winLines, win.path, qualDepth + 1);
      if (ok) resolvedAny = true;
      // FIX-ALIAS (root cause 2): a dependency of `ownerName.memberName`'s
      // own served window, never silently dropped.
      else await discloseUnresolvedDependency(innerName, winLines, win.path, winHashComment, initializerLines, `${ownerName}.${memberName}`);
    }
    if (out.length < MAX_PLANNED_CONSTANT_WINDOWS && Date.now() < deadline) {
      const ok = await resolveQualifiedReferencesIn(initializerLines, winHashComment, win.path, qualDepth + 1);
      if (ok) resolvedAny = true;
    }
    return resolvedAny;
  }

  // Copilot retest review (2026-10-02): every walk below that stops at
  // MAX_PLANNED_CONSTANT_WINDOWS with names still unchased reports
  // `complete:false` -- now that callee constants are required, a hub reading
  // more constants than the cap must never be certified from the ones that fit.
  for (const name of candidates) {
    if (out.length >= MAX_PLANNED_CONSTANT_WINDOWS) { complete = false; break; }
    if (Date.now() >= deadline) { complete = false; break; }
    await chaseConstant(name, lines, focal.path, 0);
  }
  const ownCount = out.length;

  // A callee body (one layer or two) whose constants this walk chases.
  const chaseCalleeBody = async (calleeName: string, calleePath: string, calleeLines: readonly string[], calleeBody: readonly string[]): Promise<boolean> => {
    const calleeHashComment = hasHashComments(calleePath);
    // R6-C: see the focal-body call above — same P1-3 dialect coverage, one hop out.
    const innerCandidates = constantLikeReferencesIn(calleeBody, calleeHashComment, calleeName,
      new Set([calleeName, ...focalParameterNames(calleeBody, calleeHashComment, calleeName, calleePath)]), calleePath);
    for (const name of innerCandidates) {
      if (out.length >= MAX_PLANNED_CONSTANT_WINDOWS) { complete = false; return false; }
      if (Date.now() >= deadline) { complete = false; return false; }
      const ok = await chaseConstant(name, calleeLines, calleePath, 1);
      // FIX-ALIAS (root cause 2): a dependency of the callee `calleeName`'s
      // own body, never silently dropped.
      if (!ok) await discloseUnresolvedDependency(name, calleeLines, calleePath, calleeHashComment, calleeBody, calleeName);
    }
    return true;
  };

  if (Date.now() >= deadline) complete = false;
  else if (calleeWindows !== undefined) {
    // Copilot retest review (2026-10-02): exactly the callee windows the
    // closure requires, so the constants of a required second-layer callee
    // are required too.
    for (const win of calleeWindows) {
      if (win.binding === true) continue;
      const calleeLines = readCached(workspace, win.path, cache)?.split(/\r?\n/);
      if (calleeLines === undefined) continue;
      if (!await chaseCalleeBody(win.name, win.path, calleeLines, calleeLines.slice(win.start - 1, win.end))) break;
    }
  } else {
    // Copilot retest (2026-10-02): every direct callee up to the scan
    // ceiling, never only the first MAX_CALLEES_PER_REQUIREMENT.
    const callees = calleeNamesIn(bodyLines, hashComment, focal.name, excludeNames).slice(0, MAX_SCANNED_CALLEE_NAMES);
    for (const calleeName of callees) {
      if (Date.now() >= deadline) { complete = false; break; }
      // R2-T3: a Go package too large to read whole, callee not found in
      // what was read -- the callee hop is unfinished, never "no callee"
      // (the same `complete = false` every other unfinished chain sets).
      const calleeFile = await resolveCalleeFile(calleeName, focal, lines, hashComment, workspace, cache, () => { complete = false; });
      if (calleeFile === undefined) continue;
      const calleeLines = calleeFile.content.split(/\r?\n/);
      const calleeBody = calleeFile.symbol
        ? calleeLines.slice(calleeFile.symbol.startLine - 1, calleeFile.symbol.endLine)
        : calleeLines;
      if (!await chaseCalleeBody(calleeName, calleeFile.path, calleeLines, calleeBody)) break;
    }
  }

  // P0-3 (round-4/5 fable finding, classMethod/classMethodCtorDefault/
  // classMethodField/classMethodAssign/classMethodPy): a member focal's OWN
  // instance-property reads (`this.options.timeoutMs`, `self.timeout`) are
  // invisible to `constantLikeReferencesIn` above BY DESIGN (a `.`-prefixed
  // token is a property access, never a bare module name) — so nothing ever
  // followed `this.p`/`self.p` to the constant its OWNER assigns it from.
  // One further hop, the SAME shape as the one-hop callee walk directly
  // above: find `p`'s own declaration site within the enclosing class
  // (`findOwnerPropertyWindow` — field initializer, constructor parameter
  // default, or constructor assignment, itself chasing a bare-name
  // assignment one hop further into the constructor's own same-named
  // parameter default), then scan THAT site for constant-like references
  // the ordinary way. Only for a resolved MEMBER focal with a real enclosing
  // type — a class-itself focal's body already covers its own ctor/field
  // lines directly (no property indirection to resolve).
  if (out.length < MAX_PLANNED_CONSTANT_WINDOWS && Date.now() < deadline && focal.hasRealType) {
    // P0-2 (round-6 fable finding, classMethodStaticProp): `focal.typeName`
    // widens the match to a bare qualified self-reference too
    // (`HttpClient.DEFAULTS`) -- exactly as much "this callable's own type's
    // state" as `this.p`, just spelled without an instance. V2 (round-7
    // fable finding, classMethodPyClassmethodCls/classMethodBracketThis):
    // `focal.path` ALSO recognizes Python `cls.p`, Ruby `@p`, and
    // `this["p"]`/`self['p']` bracket notation (language-gated inside
    // `selfPropertyReferencesIn` itself).
    const qualifiedSelfProps = selfPropertyReferencesIn(bodyLines, hashComment, focal.typeName, focal.path);
    // V2 (round-7 fable finding, classMethodJavaBareField/ktBareFieldConst):
    // a BARE candidate the ordinary module-constant loop above already
    // tried and FAILED to resolve (it is neither a module binding nor,
    // usually, CONST_CASE-shaped, so it fell through silently) may still be
    // an IMPLICIT-`this` field read -- Java/Kotlin/C#/C++/Swift/Scala/Dart
    // only (TS/JS/Python require an explicit qualifier, never reached here).
    const bareFieldCandidates = languageHasImplicitThisFields(focal.path)
      ? candidates.filter((name) => !out.some((w) => w.name === name))
      : [];
    if (qualifiedSelfProps.length > 0 || bareFieldCandidates.length > 0) {
      const lang = languageForPath(focal.path);
      const parsed = (lang ? await cache.parsedSymbols(content, lang, focal.path) : null) ?? [];
      const classSymbol = parsed.find((s) =>
        CALLER_EXPANSION_TYPE_KINDS.has(s.kind)
        && unqualifiedSymbolTail(s.name) === focal.typeName
        && s.startLine <= focal.startLine && s.endLine >= focal.endLine);
      if (classSymbol !== undefined) {
        const methodSpans: OwnerMemberSpan[] = parsed
          .filter((s) => CALLER_EXPANSION_CALLABLE_KINDS.has(s.kind) && s.startLine >= classSymbol.startLine && s.endLine <= classSymbol.endLine)
          .map((s) => ({ start: s.startLine, end: s.endLine, name: unqualifiedSymbolTail(s.name) }));
        const implicitFieldNames = bareFieldCandidates.length > 0
          ? ownerFieldNames(lines, classSymbol.startLine, classSymbol.endLine, methodSpans, hashComment)
          : new Set<string>();
        const selfProps = [...qualifiedSelfProps];
        for (const name of bareFieldCandidates) {
          if (implicitFieldNames.has(name) && !selfProps.includes(name)) selfProps.push(name);
        }
        for (const propName of selfProps.slice(0, MAX_CALLEES_PER_REQUIREMENT)) {
          if (out.length >= MAX_PLANNED_CONSTANT_WINDOWS || Date.now() >= deadline) { complete = false; break; }
          // P0-2 (round-6 fable finding, classMethodInherited/ParamNoDefault/
          // Setter/Getter/StaticProp/JavaField/PyInherited): whether the
          // owner declaration was never found at all (inherited from a base
          // class in a different file, assigned by a non-getter method,
          // a no-default constructor/method parameter) or it WAS found but
          // its own initializer resolved to nothing servable (e.g. a
          // qualified `Owner.CONST` reference `constantLikeReferencesIn`
          // does not chase — the Java typed-field case), the effect is the
          // same: this property contributes NO window to `out`. A before/
          // after count over BOTH branches is the one check that catches
          // both causes uniformly, so the value/condition facet can never
          // fall through to "covered" merely because the focal's own body
          // happens to hold an unrelated numeric literal (facetGate.ts's
          // `lineHasLiteral`, P3) — recorded, never silently dropped.
          //
          // P2-7 (round-7 fable finding): `beforeCount` alone reads a DEDUP
          // (the SAME constant another property, or the focal's own body,
          // already resolved -- `chaseConstant`'s own `visitedConstantNames`
          // guard then adds nothing new to `out`) as if it were a miss;
          // `resolvedThroughChase` (each chase call's own return value) is
          // the fact that actually distinguishes the two.
          const beforeCount = out.length;
          let resolvedThroughChase = false;
          const propWindow = findOwnerPropertyWindow(lines, classSymbol.startLine, classSymbol.endLine, methodSpans, propName, hashComment);
          let selfContained = false;
          if (propWindow !== undefined) {
            const propLines = lines.slice(propWindow.start - 1, propWindow.end);
            selfContained = !propWindow.truncated
              && propertyInitializerIsSelfContained(propLines, propName, hashComment)
              && !declarationIsCallable(propLines, hashComment);
            const inner = constantLikeReferencesIn(propLines, hashComment, propName, new Set([focal.name]), undefined, focal.path);
            for (const innerName of inner) {
              if (out.length >= MAX_PLANNED_CONSTANT_WINDOWS || Date.now() >= deadline) { complete = false; break; }
              const ok = await chaseConstant(innerName, lines, focal.path, 1);
              if (ok) resolvedThroughChase = true;
              // FIX-ALIAS (root cause 2): a dependency of this property's own
              // initializer, never silently dropped.
              else await discloseUnresolvedDependency(innerName, lines, focal.path, hashComment, propLines, propName);
            }
            // V3 (round-7 fable finding, classMethodJavaBareField/
            // ktBareFieldConst): the property's own initializer may read a
            // QUALIFIED name (`Defaults.DEFAULT_TIMEOUT_MS`) rather than a
            // bare one -- the SAME scan the focal's own body gets, applied
            // to this property's declaration text.
            if (out.length < MAX_PLANNED_CONSTANT_WINDOWS && Date.now() < deadline) {
              const qualifiedOk = await resolveQualifiedReferencesIn(propLines, hashComment, focal.path, 1);
              if (qualifiedOk) resolvedThroughChase = true;
            }
          }
          if (out.length === beforeCount && !resolvedThroughChase) {
            // Round-9 orchestrator check (o9TsLiteralField & co.): a property
            // whose own declaration holds a literal (`private timeoutMs =
            // 2000`, `self.timeout = 6.5`) IS the value; only one whose value
            // side reads something unresolved stays disclosed.
            if (propWindow !== undefined && selfContained) {
              out.push({ path: focal.path, start: propWindow.start, end: propWindow.end, truncated: propWindow.truncated, name: propName });
            } else {
              unresolvedProperties.push(propName);
            }
          }
          // A bare candidate the module-level pass already disclosed (a
          // Kotlin `companion object` constant read as `TIMEOUT_MS`, CONST_CASE
          // so it was listed unresolved) is resolved now as the class's own
          // member: never also disclosed as unresolved (o9KtCompanionConst).
          if (out.length > beforeCount || resolvedThroughChase) {
            const stale = unresolved.indexOf(propName);
            if (stale !== -1) { unresolved.splice(stale, 1); delete unresolvedPackages[propName]; }
          }
        }
      } else if (qualifiedSelfProps.length > 0) {
        // Defensive (should not normally happen when `focal.hasRealType` is
        // true): the enclosing type itself could not be re-parsed here --
        // never silently drop the self-property reads this focal is known
        // to make. Bare-field candidates are NOT pushed here: without a
        // parsed class body nothing PROVED they are fields at all (unlike a
        // qualified `this.p`, whose syntax alone proves a property read was
        // intended).
        unresolvedProperties.push(...qualifiedSelfProps);
      }
    }
  }
  // Orchestrator (round 6, csInterpolatedConst) / V3 (round-7 fable
  // finding): a constant read through ANOTHER type's name
  // (`Config.API_BASE`, `Defaults.TIMEOUT_MS`) or a module/package alias
  // (`config.DefaultTimeout`) is a `.`/`::`-qualified token
  // `constantLikeReferencesIn` never surfaces on its own, so it was dropped
  // silently and the facet could still be certified on an unrelated inline
  // literal (P3). Its declaration is served when found; otherwise it is
  // unresolved — disclosed, never ignored (alias failures excepted, see
  // `resolveQualifiedReferencesIn`'s own doc).
  if (Date.now() < deadline) {
    await resolveQualifiedReferencesIn(bodyLines, hashComment, focal.path);
  }
  reconcileQualifiedMemberDisclosures(bodyLines, hashComment, focal.path, out, unresolved, unresolvedPackages);
  return {
    windows: out, ownCount, unresolved, unresolvedPackages, unresolvedProperties,
    unresolvedConstructedValues: constructedValues, unresolvedConstantCandidates: constantCandidates,
    unresolvedDependencies: dependencyDisclosures, complete,
  };
}

/**
 * The member half of a `::`-qualified read (`config::TIMEOUT_MS`) is also a
 * bare candidate (`constantLikeReferencesIn`), so a CONST_CASE member that
 * no bare lookup found is disclosed even when its qualified read resolved.
 * Drops exactly that disclosure: a bare unresolved name every occurrence of
 * which in the focal body is qualified by an owner whose `Owner.member`
 * window was served. Any bare or differently-qualified occurrence keeps it.
 */
export function reconcileQualifiedMemberDisclosures(
  bodyLines: readonly string[],
  hashComment: boolean,
  relPath: string,
  windows: readonly NamedWindow[],
  unresolved: string[],
  unresolvedPackages: Record<string, string>,
): void {
  for (let i = unresolved.length - 1; i >= 0; i--) {
    const name = unresolved[i]!;
    if (name.includes(".")) continue;
    const occurrenceRe = new RegExp(`(?<![\\w$])${escapeRegExp(name)}(?![\\w$])`, "g");
    let occurrences = 0;
    let everyOccurrenceResolved = true;
    for (const line of bodyLines) {
      const masked = maskNonCode(line, hashComment, relPath);
      for (const match of masked.matchAll(occurrenceRe)) {
        occurrences++;
        const owner = /([A-Za-z_][A-Za-z0-9_]*)(?:\.|::)$/.exec(masked.slice(0, match.index))?.[1];
        if (owner === undefined || !windows.some((w) => w.name === `${owner}.${name}`)) {
          everyOccurrenceResolved = false;
          break;
        }
      }
      if (!everyOccurrenceResolved) break;
    }
    if (occurrences > 0 && everyOccurrenceResolved) {
      unresolved.splice(i, 1);
      delete unresolvedPackages[name];
    }
  }
}
