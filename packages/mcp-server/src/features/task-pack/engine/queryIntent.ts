// queryIntent — extracted implementation; imports point to the owning modules.
import * as fs from "fs";
import * as path from "path";
import type { ImpactCandidate } from "@tokenlighten/types";
import type { ImpactSurface } from "@tokenlighten/types";
import type { TaskPackSurface } from "../model.js";
import { EXTRA_EVIDENCE_NAMED_PATH_CAP_MULTIPLIER } from "./queryIntent4.js";
import { FileReadCache } from "./packBasics2.js";
import { MAX_SURFACES_DISTINCT } from "./packBasics2.js";
import { RELATION_VERIFIED_EXTRA_WHY_RE } from "./queryIntent4.js";
import { REQUEST_ANCHOR_DEFINITION_WHY } from "./roleAndConcernScope3.js";
import { ROLE_FILL_QUERY_HINTS } from "./queryIntent2.js";
import { SIBLING_SEED_WEAK_WHY } from "../../locator/locateTaskContext.js";
import { STYLE_EXTRA_EXTS } from "./queryIntent2.js";
import { anchorFocusForLocatorCandidate } from "./anchorFocus4.js";
import { attachAnchorFocusAffordance } from "./anchorFocus4.js";
import { candidateToSurface } from "./surfaceMaterialization.js";
import { classifySurface } from "../../../util/impact.js";
import { concernAnchorTokens } from "./roleAndConcernScope3.js";
import { concreteIdentifierTokens } from "./createAndWiringEndpoints2.js";
import { containsWholeIdentifier } from "../wholeIdentifier.js";
import { countLines } from "../../../util/countLines.js";
import { deriveTokenVariants } from "../../../util/impact.js";
import { dominantRootOf } from "./surfaceMaterialization.js";
import { explicitCodeIdentifiers } from "./anchorFocus2.js";
import { extractEnumValueTokens } from "./createAndWiringEndpoints2.js";
import { handleTable } from "../../../util/handles.js";
import { isEnumLikeQueryShaped } from "./roleAndConcernScope2.js";
import { isNativeExtPath } from "../../../util/nativeSymbolRange.js";
import { isUnderAncestor } from "./seedResolution.js";
import { isUnderAnyPrefix } from "./roleAndConcernScope.js";
import { isWithinRoleSearchScope } from "../../locator/locateTaskContext.js";
import { languageForPath } from "../../../util/languages.js";
import { locateTaskContext } from "../../locator/locateTaskContext.js";
import { looksLikeMarkupOrCssWindow } from "./readinessFalsification.js";
import { normIdent } from "./createAndWiringEndpoints2.js";
import { noteUnreadableNamedPath } from "./queryIntent3.js";
import { orderedUniqueTokens } from "./roleAndConcernScope2.js";
import { probeFileText } from "./readinessFalsification.js";
import { projectRootOf } from "../../locator/locateTaskContext.js";
import { queryNamedWorkspaceFiles } from "./queryIntent3.js";
import { queryNamedWorkspaceFilesKeepingSharedBasenames } from "./queryIntent3.js";
import { readCached } from "./packBasics2.js";
import { roleInventoryUnder } from "./roleAndConcernScope.js";
import { roleSearchScope } from "./roleAndConcernScope.js";
import { roleSearchScopePrefixes } from "../../locator/locateTaskContext.js";
import { statedRelationToNamedPath } from "./readinessFalsification.js";
import { stillMissingRequiredRoles } from "./queryIntent2.js";
import { surfaceGroundedInQuery } from "./roleAndConcernScope3.js";
import { unqualifiedSymbolTail } from "./anchorFocus3.js";
import { walkCodeFiles } from "../../../tools/walkRepo.js";
import { whySummary } from "./surfaceMaterialization2.js";

export const NATIVE_EXTS = new Set([".c", ".cc", ".cpp", ".cxx", ".h", ".hpp", ".hh", ".hxx"]);

export const NATIVE_HEADER_EXTS = new Set([".h", ".hpp", ".hh", ".hxx"]);

export const NATIVE_SOURCE_EXTS = [".cpp", ".cc", ".cxx", ".c"];

export const NATIVE_PAIR_HEADER_EXTS = [".h", ".hpp", ".hh", ".hxx"];

// isNativeExtPath (DESIGN-v0.8 §A5 deliverable 1: true for a C/C++
// source/header path — a bug-fix pack whose domain/contract surface is a
// NATIVE_EXTS file routinely arrives at low locator confidence even though
// the file IS the fix site, so it forces the embed gate at both
// candidateToSurface and buildPartialPack regardless of confidence score)
// now lives in util/nativeSymbolRange.ts, imported above. NATIVE_EXTS stays
// local here — nativePairCandidates below still needs the raw set for
// header/source pairing, which is out of scope for that consolidation.

export function nativePairCandidates(relPath: string): string[] {
  const ext = path.extname(relPath).toLowerCase();
  if (!NATIVE_EXTS.has(ext)) return [];

  const base = relPath.slice(0, relPath.length - ext.length);
  const pairExts = NATIVE_HEADER_EXTS.has(ext) ? NATIVE_SOURCE_EXTS : NATIVE_PAIR_HEADER_EXTS;
  const bases = new Set<string>([base]);
  if (base.includes("/include/")) bases.add(base.replace("/include/", "/src/"));
  if (base.includes("/src/")) bases.add(base.replace("/src/", "/include/"));

  const out: string[] = [];
  for (const b of bases) {
    for (const e of pairExts) out.push(`${b}${e}`);
  }
  return out;
}

/**
 * R0 (2026-08-21, W4-A): `TaskPackSurface.why` is whySummary's HUMAN-READABLE
 * rendering of the locator's raw ImpactCandidate.why code, not the code
 * itself — most SIBLING_SEED_WEAK_WHY entries (e.g. "variant-text" ->
 * "variant token match") get rewritten by it, so comparing a surface's `why`
 * directly against SIBLING_SEED_WEAK_WHY's raw codes silently matches almost
 * nothing. Deriving the comparison set by running whySummary over each raw
 * code keeps ONE definition of "weak evidence" (SIBLING_SEED_WEAK_WHY) as the
 * source of truth instead of hand-duplicating its summarized spellings.
 * whySummary ignores its optional symbol/role params for every entry in this
 * particular set, so calling it with just the raw code is exact, not a guess.
 */
export const SIBLING_SEED_WEAK_WHY_SUMMARIZED: ReadonlySet<string> = new Set(
  [...SIBLING_SEED_WEAK_WHY].map((raw) => whySummary(raw)),
);

/**
 * R0 (2026-08-21, W4-A pack-augmentation-pollution forensics): the paths of
 * this pack's TRUSTWORTHY surfaces — required, or reached through a
 * targeted (not SIBLING_SEED_WEAK_WHY-tagged, i.e. not a plain full-text/
 * variant/reference hit) match. Feeds `roleSearchScopePrefixes` for any
 * augmenter that must confine itself to the task's own project root(s)
 * WITHOUT letting a weakly-sourced, possibly-wrong-root surface (a
 * near-zero-confidence text hit that survived role-diversity selection —
 * see readCodeTaskPack.ts's R0 fixes) count as a root vote of its own. A
 * repo hosting many independent projects under one shared parent (routinely
 * true for `bench/fixtures/`) makes this distinction load-bearing: a weak
 * hit's own root is exactly the wrong-root noise the confinement exists to
 * keep OUT of the scope, so it must not also be trusted to WIDEN that scope.
 */
export function trustworthySurfaceAnchorPaths(surfaces: readonly TaskPackSurface[]): string[] {
  return surfaces
    .filter((s) => s.required === true || !SIBLING_SEED_WEAK_WHY_SUMMARIZED.has(s.why ?? ""))
    .map((s) => s.path);
}

export async function augmentNativeSurfaceClosure(
  surfaces: TaskPackSurface[],
  workspace: string,
  query: string,
  requiredRoles: string[],
  cache?: FileReadCache,
): Promise<void> {
  const seen = new Set(surfaces.map((s) => s.path));
  // R0 (2026-08-21, W4-A pack-augmentation-pollution forensics): confine
  // header/source-pair expansion to the same project root as this task's
  // TRUSTWORTHY surfaces — required, or reached through a targeted (not
  // SIBLING_SEED_WEAK_WHY-tagged, i.e. not a plain full-text/variant/
  // reference hit) match. Defense-in-depth alongside the matching
  // locate-layer fix (locateTaskContext.ts's Layer 6): a native surface that
  // only entered `surfaces` through a weak or foreign-root hit must not
  // cascade into MORE same-(wrong-)root siblings here. `roleSearchScopePrefixes`
  // returns null when no trustworthy anchor exists at all, and
  // `isWithinRoleSearchScope` treats null as unconfined — the same safe,
  // conservative default `augmentStyleSurface`'s anchorPaths already uses.
  const nativeScopePrefixes = roleSearchScopePrefixes(trustworthySurfaceAnchorPaths(surfaces));
  for (const surface of [...surfaces]) {
    if (surfaces.length >= MAX_SURFACES_DISTINCT) return;
    const ext = path.extname(surface.path).toLowerCase();
    if (!NATIVE_EXTS.has(ext)) continue;
    if (!isWithinRoleSearchScope(surface.path, nativeScopePrefixes)) continue;
    for (const pairPath of nativePairCandidates(surface.path)) {
      if (seen.has(pairPath)) continue;
      if (!isWithinRoleSearchScope(pairPath, nativeScopePrefixes)) continue;
      try {
        fs.statSync(path.join(workspace, pairPath));
      } catch {
        continue;
      }
      seen.add(pairPath);
      const surf = classifySurface(pairPath, undefined);
      const fallbackSurface: ImpactSurface = NATIVE_HEADER_EXTS.has(path.extname(pairPath).toLowerCase())
        ? "contract"
        : "domain";
      // DESIGN-v0.8 §A5 deliverable 2: the base "1-30" window below is only
      // a SEED for widenNativeSymbolRange's matchLine anchor (candidateToSurface
      // widens any non-symbol NATIVE_EXTS candidate automatically) — it is
      // no longer the shipped range. A pair surface has no real text match
      // (it was found via header/source pairing, not a query hit), so
      // widenNativeSymbolRange's own fallback (generous ±MAX_NATIVE_SYMBOL_LINES/2
      // window when no enclosing symbol contains the anchor) is what
      // actually recovers content like a file-scope sign table that sits
      // outside any function/class — see its doc comment.
      const pairSurface = await candidateToSurface({
        path: pairPath,
        line: 1,
        range: "1-30",
        surface: surf === "unknown" ? fallbackSurface : surf,
        why: "header-source-pair",
        confidence: 0.65,
        required: false,
      }, workspace, requiredRoles, query, cache);
      const insertAt = Math.min(surfaces.indexOf(surface) + 1, surfaces.length);
      surfaces.splice(insertAt, 0, pairSurface);
      break;
    }
  }
}

/** Global-variable identifier convention: a `g_`-prefixed name (project-agnostic firmware/C convention). */
export const GLOBAL_IDENT_RE = /\bg_[A-Za-z_][A-Za-z0-9_]*\b/g;

/** An `extern <type...> <name>;` declaration — the NAME is the shared global whose DEFINITION lives elsewhere. */
export const EXTERN_DECL_RE = /\bextern\b[^;{]*?\b([A-Za-z_][A-Za-z0-9_]*)\s*(?:\[[^\]]*\])?\s*;/g;

/** Max native files scanned when hunting for a global's definition (bounds the extra walk). */
export const WIRING_SCAN_FILE_CAP = 400;

/**
 * Collect the shared-global identifier candidates named by a native surface:
 * every `g_*` reference in its content, plus every name declared `extern` in
 * it (a header's `extern` decl names a global DEFINED in some .c/.cpp). Reads
 * the surface's whole file (not just its embedded `code` slice, which is
 * range-bounded) so a reference outside the shown window still counts.
 */
export function nativeSurfaceGlobals(workspace: string, relPath: string, cache?: FileReadCache): Set<string> {
  const out = new Set<string>();
  const raw = readCached(workspace, relPath, cache);
  if (raw === undefined) return out;
  for (const m of raw.matchAll(GLOBAL_IDENT_RE)) out.add(m[0]);
  if (NATIVE_HEADER_EXTS.has(path.extname(relPath).toLowerCase())) {
    for (const m of raw.matchAll(EXTERN_DECL_RE)) {
      if (m[1]) out.add(m[1]);
    }
  }
  return out;
}

/** True when `text` DEFINES `ident` at file scope: a non-extern declaration/assignment naming it (e.g. `Foo g_bar = ...` or `int g_bar[4] = {...}`). Deliberately excludes `extern` re-declarations. */
export function fileDefinesGlobal(text: string, ident: string): boolean {
  const escaped = ident.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // A line that names the ident followed by `=`, `[`, `(`, or `;` and is NOT
  // an extern declaration or a bare reference. Anchored per-line to keep it
  // file-scope-ish without a full parse.
  const defRe = new RegExp(`^[^\\n]*\\b${escaped}\\b\\s*(?:\\[[^\\]]*\\])?\\s*(?:=|;|\\{)`, "m");
  for (const line of text.split(/\r?\n/)) {
    if (!line.includes(ident)) continue;
    if (/^\s*extern\b/.test(line)) continue; // extern decl — not a definition
    if (/^\s*\/\//.test(line) || /^\s*\*/.test(line)) continue; // comment line
    if (defRe.test(line)) return true;
  }
  return false;
}

/**
 * DESIGN-v0.8 §A5 deliverable (b): after native header/source pair surfaces are
 * selected, detect a SHARED GLOBAL — a `g_*` identifier (or an `extern`-declared
 * name from a selected header) referenced by ≥2 selected native surfaces — and
 * add ONE additional handle+skeleton surface (NO embedded code) for the file
 * that DEFINES it, within the same dominant project root. Bounded, generic
 * (no fixture-specific strings), and a silent no-op when nothing qualifies,
 * the caps are already full, or no defining file is found.
 */
export async function augmentNativeWiringSurface(
  surfaces: TaskPackSurface[],
  workspace: string,
  cache?: FileReadCache,
): Promise<void> {
  if (surfaces.length >= MAX_SURFACES_DISTINCT) return;
  const nativeSurfaces = surfaces.filter((s) => isNativeExtPath(s.path));
  if (nativeSurfaces.length < 2) return;

  // Count how many DISTINCT native surfaces reference each global.
  const refCount = new Map<string, number>();
  for (const s of nativeSurfaces) {
    for (const g of nativeSurfaceGlobals(workspace, s.path, cache)) {
      refCount.set(g, (refCount.get(g) ?? 0) + 1);
    }
  }
  const shared = [...refCount.entries()]
    .filter(([, n]) => n >= 2)
    .map(([g]) => g)
    .sort(); // deterministic
  if (shared.length === 0) return;

  // Confine the definition hunt to the native surfaces' dominant project root,
  // so a same-named global in an unrelated project cannot be dragged in.
  const dominantRoot = dominantRootOf(nativeSurfaces);
  const already = new Set(surfaces.map((s) => s.path));

  const subPath = dominantRoot && dominantRoot !== "." ? dominantRoot : undefined;
  const nativeFiles = walkCodeFiles(workspace, subPath ? { subPath } : {})
    .filter((f) => isNativeExtPath(f.relPath) && !already.has(f.relPath))
    .filter((f) => projectRootOf(f.relPath) === dominantRoot)
    .slice(0, WIRING_SCAN_FILE_CAP);

  for (const ident of shared) {
    for (const f of nativeFiles) {
      const text = readCached(workspace, f.relPath, cache);
      if (text === undefined) continue;
      if (!fileDefinesGlobal(text, ident)) continue;
      if (surfaces.length >= MAX_SURFACES_DISTINCT) return;
      // Handle+skeleton only (NO code embed): mint a whole-file handle so the
      // agent can slice the definition, but do not spend the pack's code
      // budget on the wiring file itself.
      // BUG FIX: was text.split(/\r?\n/).length, which counts a phantom
      // final segment for trailing-newline content and mints a whole-file
      // range one line past the end (see util/countLines.ts doc comment).
      const lineCount = countLines(text);
      const wholeRange = `1-${Math.max(1, lineCount)}`;
      const entry = handleTable.upsert({
        kind: "range",
        path: f.relPath,
        range: wholeRange,
        workspaceRoot: workspace,
      });
      const role = classifySurface(f.relPath, undefined);
      surfaces.push({
        role: role === "unknown" ? "domain" : role,
        handle: entry.id,
        path: f.relPath,
        range: wholeRange,
        why: `defines shared global ${ident} referenced by ${refCount.get(ident)} selected surfaces`,
      });
      return; // ONE additional wiring surface, per the deliverable
    }
  }
}

export async function augmentNativeIdentifierCooccurrenceSurface(
  surfaces: TaskPackSurface[],
  workspace: string,
  query: string,
  requiredRoles: string[],
  cache?: FileReadCache,
): Promise<void> {
  if (surfaces.length >= MAX_SURFACES_DISTINCT) return;
  const nativeSurfaces = surfaces.filter((s) => isNativeExtPath(s.path));
  if (nativeSurfaces.length === 0) return;

  const identifiers = orderedUniqueTokens(concreteIdentifierTokens(query))
    .filter((t) => normIdent(t).length >= 4);
  if (identifiers.length < 2) return;

  const dominantRoot = dominantRootOf(nativeSurfaces);
  const subPath = dominantRoot && dominantRoot !== "." ? dominantRoot : undefined;
  const already = new Set(surfaces.map((s) => s.path));
  const nativeFiles = walkCodeFiles(workspace, subPath ? { subPath } : {})
    .filter((f) => isNativeExtPath(f.relPath) && !already.has(f.relPath))
    .filter((f) => projectRootOf(f.relPath) === dominantRoot)
    .slice(0, WIRING_SCAN_FILE_CAP);

  let best: { file: string; line: number; tokens: string[]; score: number } | undefined;
  for (const f of nativeFiles) {
    const text = readCached(workspace, f.relPath, cache);
    if (text === undefined) continue;
    const normalizedText = normIdent(text);
    const present = identifiers.filter((t) => normalizedText.includes(normIdent(t)));
    if (present.length < 2) continue;
    const line = lineWithMostIdentifierMatches(text, present);
    const score = present.length * 100 - line;
    if (best === undefined || score > best.score) {
      best = { file: f.relPath, line, tokens: present, score };
    }
  }
  if (best === undefined) return;

  const range = `${Math.max(1, best.line - 12)}-${best.line + 12}`;
  const role = classifySurface(best.file, undefined);
  surfaces.push(await candidateToSurface(
    {
      path: best.file,
      line: best.line,
      range,
      surface: role === "unknown" ? "domain" : role,
      why: `query identifier co-occurrence (${best.tokens.slice(0, 3).join(", ")})`,
      confidence: 0.74,
    },
    workspace,
    requiredRoles,
    query,
    cache,
  ));
}

export function lineWithMostIdentifierMatches(text: string, identifiers: string[]): number {
  const lines = text.split(/\r?\n/);
  let bestLine = 1;
  let bestCount = 0;
  for (let i = 0; i < lines.length; i++) {
    const normalizedLine = normIdent(lines[i]!);
    const count = identifiers.filter((t) => normalizedLine.includes(normIdent(t))).length;
    if (count > bestCount) {
      bestCount = count;
      bestLine = i + 1;
    }
  }
  return bestLine;
}

/**
 * DESIGN-v0.8 coverage-honesty (Part 5, B-1 variant promotion): for an
 * enum-like query, promote an already-selected config/data/doc surface to
 * `required=true` when its ALREADY-READ content (via the shared FileReadCache
 * — no new walks/reads) literally contains a case/separator variant of the
 * enum's new-value token. Such a file (a JSON seed, a data fixture, a doc
 * table) that already mentions the family is a genuine edit site for the new
 * value, not optional context — marking it required pulls its code into the
 * high-confidence embed/cap tier and keeps it off the trim block.
 *
 * Scoped to config/data/doc precisely because contract/api/ui/style are
 * already handled by requiredRoles / native-embed rules; these three are the
 * roles that otherwise silently ride along as low-confidence handle-only
 * surfaces. Generic: variants come from deriveTokenVariants(TOKEN), which is
 * derived purely from the token's own shape (never fixture vocabulary).
 */
export function promoteVariantSurfaces(
  surfaces: TaskPackSurface[],
  query: string,
  workspace: string,
  cache: FileReadCache,
): void {
  // Item 5: camelCase-robust enum gate so a "TicketPriority byTicket ONHOLD"
  // query still promotes a config/data/doc surface that names the new value.
  if (!isEnumLikeQueryShaped(query)) return;
  const tokens = extractEnumValueTokens(query);
  if (tokens.length === 0) return;
  // Longer variants first so a short prefix does not shadow a longer one; only
  // meaningful variants (>=2 chars) to avoid trivial single-char matches.
  const variants = [...new Set(tokens.flatMap((t) => deriveTokenVariants(t)))].filter((v) => v.length >= 2);
  if (variants.length === 0) return;

  const promotable = new Set(["config", "data", "doc"]);
  for (const surf of surfaces) {
    if (surf.required) continue;
    if (!promotable.has(surf.role)) continue;
    const content = readCached(workspace, surf.path, cache);
    if (content === undefined) continue;
    if (variants.some((v) => content.includes(v))) {
      surf.required = true;
    }
  }
}

/**
 * Item 1 (resolve the style role to a NAMED surface): when the pack REQUIRES a
 * "style" role but no surface carries it yet, find the best style file in the
 * located surfaces' own dominant project root and add it as a real surface
 * (handle + range + role:"style" + embedded code per the normal budget rules).
 * The live forensic: the pack said `missing:["style"]` as a bare ROLE and no
 * response ever named the actual design-tokens stylesheet, so the agent hunted by a
 * class-name stem, missed, and shipped without the design token. Naming the
 * file — with an editable handle — removes the guess entirely.
 *
 * Style required implies the root HAS at least one stylesheet
 * (requiredSurfacesForTask only adds "style" when the inventory has it), so
 * this normally succeeds; the caller (resolveStyleNextIfUnresolved) handles the
 * genuinely-no-file case with a named `explore find <stem>` next instead.
 *
 * Best-file ranking (deterministic): a stylesheet whose ALREADY-read content
 * literally contains a case/separator variant of the enum's new value token or
 * one of its existing sibling members is the strongest match (it is provably
 * the family's design-token file); then a `tokens.css`/design-token-named file;
 * then alphabetical. Confined to the dominant root so host-repo CSS never leaks
 * in for a fixture-scoped task. A silent no-op when style is not required, a
 * style surface already exists, the caps are full, or no stylesheet is found.
 */
export async function augmentStyleSurface(
  surfaces: TaskPackSurface[],
  query: string,
  workspace: string,
  requiredRoles: string[],
  cache: FileReadCache,
  // B1a (2026-08-01 retrieval-scope): the ANCHOR cluster (the query's own
  // primary hits / the caller's own named paths). Omitted by legacy callers,
  // which then anchor on the running surface array as before — but that array
  // already contains earlier augmenters' picks, so one foreign surface widened
  // the scope for every augmenter after it (cascading contamination).
  anchorPaths?: readonly string[],
  callerScopes?: readonly string[],
): Promise<void> {
  if (!requiredRoles.includes("style")) return;
  if (surfaces.some((s) => s.role === "style")) return;
  if (surfaces.length >= MAX_SURFACES_DISTINCT) return;

  // One project root is a strict scope. Cross-package propagation (shared
  // contract + API + web) instead uses the anchors' ancestor-CHILD prefixes so
  // a stylesheet in the web package is not excluded merely because API supplied
  // more candidates than UI — while an unrelated SIBLING tree under the same
  // ancestor (a second product, a fixtures/ directory) stays out. The old
  // multi-root branch used the bare common ancestor, which for a no-shared-
  // ancestor cluster degenerated to "" and searched the WHOLE workspace: that
  // is the cross-tree stylesheet leak this closes.
  const anchors = anchorPaths !== undefined && anchorPaths.length > 0
    ? anchorPaths
    : surfaces.map((surface) => surface.path);
  const scope = roleSearchScope(anchors, query, workspace, callerScopes);
  if (scope === null) return;
  const already = new Set(surfaces.map((s) => s.path));
  const styleFiles = walkCodeFiles(workspace, { extraExts: STYLE_EXTRA_EXTS })
    .map((f) => f.relPath)
    .filter((p) => classifySurface(p) === "style")
    .filter((p) => !already.has(p))
    .filter((p) => isUnderAnyPrefix(p, scope))
    .sort();
  if (styleFiles.length === 0) return;

  // Variants of the enum's new value + its existing sibling members — a
  // stylesheet already naming one is the family's token file (strongest match).
  const valueTokens = extractEnumValueTokens(query);
  const memberVariants = new Set<string>(
    valueTokens.flatMap((t) => deriveTokenVariants(t)).filter((v) => v.length >= 2),
  );
  // Sibling members read from an already-selected contract/style surface's own
  // content, so a query that names only the NEW value (its siblings live in the
  // code) still ranks the right stylesheet.
  for (const s of surfaces) {
    if (s.role !== "contract") continue;
    const c = readCached(workspace, s.path, cache);
    if (c === undefined) continue;
    for (const m of c.match(/\b[A-Z][A-Z0-9_]{1,}\b/g) ?? []) {
      for (const v of deriveTokenVariants(m)) if (v.length >= 2) memberVariants.add(v);
    }
  }

  const score = (p: string): number => {
    const content = readCached(workspace, p, cache);
    if (content !== undefined && memberVariants.size > 0 && [...memberVariants].some((v) => content.includes(v))) {
      return 2; // content-confirmed family token file
    }
    return /(^|\/)(tokens|theme|variables|colors?|design-tokens)\.[^/]+$/i.test(p) ? 1 : 0;
  };
  const best = [...styleFiles].sort((a, b) => score(b) - score(a) || (a < b ? -1 : 1))[0]!;

  // B1a' (2026-08-01, rsc1 spawned-server follow-up): a marker-less workspace
  // makes roleSearchScopePrefixes' single-root branch return "" (the whole
  // workspace), so the scope filter above still admits a stylesheet from an
  // anchor-free sibling TOP-LEVEL tree (other-project/frontend/src/theme.css
  // for a packages/ + apps/ task). Outside the anchors' own top-level trees a
  // NAME-scored pick is not evidence — only a content-confirmed family token
  // file (score 2) may cross. Skipping keeps the pack honestly partial, which
  // beats serving a foreign tree's stylesheet as required:true.
  const anchorTops = new Set(anchors.map((p) => p.split("/")[0] ?? ""));
  const bestTop = best.split("/")[0] ?? "";
  if (score(best) < 2 && !anchorTops.has(bestTop)) return;

  const raw = readCached(workspace, best, cache);
  const lineCount = raw !== undefined ? Math.max(1, countLines(raw)) : 1;
  const rawLines = raw?.split(/\r?\n/) ?? [];
  const familyLine = rawLines.findIndex((line) =>
    [...memberVariants].some((variant) => line.includes(variant))
  ) + 1;
  const anchorLine = familyLine > 0 ? familyLine : 1;
  const styleSurface = await candidateToSurface(
    {
      path: best,
      line: anchorLine,
      range: `${Math.max(1, anchorLine - 12)}-${Math.min(lineCount, anchorLine + 12)}`,
      surface: "style",
      why: "style-family",
      confidence: 0.85,
      required: true,
    },
    workspace,
    requiredRoles,
    query,
    cache,
  );
  surfaces.push(styleSurface);
}

/**
 * FIX-B2: attempt to fill still-missing REQUIRED roles (other than "style")
 * IN THIS SAME pack build. Mutates `surfaces` in place (matches every other
 * augment* helper's shape); a role neither pass can find is left missing for
 * the caller's existing `missing`/`missing_required_surfaces` bookkeeping to
 * report honestly — this is an ATTEMPT, not a guarantee.
 */
export async function augmentMissingRequiredRoleSurfaces(
  surfaces: TaskPackSurface[],
  query: string,
  workspace: string,
  requiredRoles: string[],
  cache: FileReadCache,
  // 2026-07-12d confinement fix: same caller-SEEDED-flow scope parameter as
  // augmentConcernGroupSurfaces above — undefined at the other two call
  // sites (buildTaskPack, buildPartialPack), which keep today's unconfined
  // behavior. Layered ON TOP of (not replacing) the existing fillScope
  // machinery below: fillScope stays the marker-root-based search/inventory
  // hint it always was (and can legitimately be broader than `scope`, e.g.
  // a monorepo family root), but a candidate must ALSO satisfy `scope` —
  // the caller's own named territory — before it is ever pushed into
  // `surfaces`. This is what keeps a single caller-named FILE from having
  // its required-role gap silently filled from an unrelated SIBLING
  // directory that merely shares the same (or no) marker root.
  scope?: string,
  // B1a (2026-08-01 retrieval-scope): the ANCHOR cluster — see
  // roleSearchScopePrefixes. Omitted by legacy callers, which keep anchoring on
  // the running surface array (and so inherit any earlier augmenter's pick).
  anchorPaths?: readonly string[],
): Promise<void> {
  let missing = stillMissingRequiredRoles(surfaces, requiredRoles);
  if (missing.length === 0 || surfaces.length >= MAX_SURFACES_DISTINCT) return;

  // 09e pollution hardening: dominantRootOf's plurality vote is meaningless
  // exactly when it matters most — surfaces spanning several marker roots
  // (monorepo subpackages each carry their own manifest), where the OLD ""
  // fallback ran pass 1 UNSCOPED and filled a required role from a foreign
  // project (one live pack's "contract" was filled with a foreign
  // project's header). roleFillScope replaces the vote: one shared root → that
  // root; several roots → their common ancestor (the project-family root,
  // which legitimately includes SIBLING subpackages — where a missing
  // contract/api role usually lives); no anchor at all → null, and the fill
  // is SKIPPED rather than guessed workspace-wide.
  // B1a (2026-08-01 retrieval-scope): roleFillScope's single common-ancestor
  // string admitted every SIBLING tree under that ancestor — the cross-fixture
  // `test`/`style` role fills observed in run 2026-07-31-semantic-signal5-2.
  // roleSearchScope narrows the same anchor cluster to the ancestor-CHILD
  // directories that actually contain an anchor, and adds any directory the
  // query literally named.
  const fillScopes = roleSearchScope(
    anchorPaths !== undefined && anchorPaths.length > 0 ? anchorPaths : surfaces.map((s) => s.path),
    query,
    workspace,
    scope !== undefined && scope !== "" ? [scope] : undefined,
  );
  if (fillScopes === null) return;
  // Cheap short-circuit (mirrors requiredSurfacesForTask's own "never demand
  // a role that cannot exist here" discipline): do not spend a search pass
  // hunting for a role this scope structurally has no file for at all.
  // Prefix-scoped (not rootOf-equality): the scope may be a common-ancestor
  // directory that is not itself a marker root.
  const inventory = new Set<ImpactSurface>();
  for (const prefix of fillScopes) {
    for (const role of roleInventoryUnder(workspace, prefix === "." ? "" : prefix)) inventory.add(role);
  }
  missing = missing.filter((r) => inventory.has(r as ImpactSurface));
  if (missing.length === 0) return;
  // The single `path` a locate call accepts — only meaningful when the scope is
  // ONE directory; a multi-prefix scope relies on the explicit per-candidate
  // filter below (locate's own hard scope cannot express a union).
  const fillScope = fillScopes.length === 1 ? fillScopes[0]! : "";

  const seenPaths = new Set(surfaces.map((s) => s.path));

  // Pass 1: ONE combined locate call biased toward every still-missing
  // role's structural vocabulary, confined to the fill scope so it cannot
  // reintroduce cross-project noise.
  const hints = missing.map((r) => ROLE_FILL_QUERY_HINTS[r]).filter((h): h is string => h !== undefined);
  if (hints.length > 0 && query.trim().length > 0) {
    const roleQuery = [query, ...hints].join(" ").slice(0, 400);
    const located = await locateTaskContext(workspace, {
      action: "locate",
      query: roleQuery,
      ...(fillScope !== "" && fillScope !== "." ? { path: fillScope } : {}),
      limit: MAX_SURFACES_DISTINCT,
    });
    const candidates: ImpactCandidate[] = located.hit
      ? [...located.primary, ...located.related]
      : (located.candidateDetails ?? []).map((d) => ({
          path: d.path,
          line: d.line,
          range: d.range,
          ...(d.symbol ? { symbol: d.symbol } : {}),
          surface: d.surface,
          why: d.why,
          confidence: d.confidence,
        }));
    const stillMissingSet = new Set(missing);
    for (const c of [...candidates].sort((a, b) => b.confidence - a.confidence)) {
      if (surfaces.length >= MAX_SURFACES_DISTINCT) break;
      if (seenPaths.has(c.path) || !stillMissingSet.has(c.surface)) continue;
      // Defensive re-confinement (same discipline as the seeded flow):
      // locate's own hard-scope filter already restricts to fillScope when
      // set, but the boundary this pass exists to enforce stays explicit —
      // and for a multi-prefix scope it is the ONLY enforcement.
      if (!isUnderAnyPrefix(c.path, fillScopes)) continue;
      // 2026-07-12d: caller-named scope, AND'd on top of fillScope — see
      // this function's own doc comment above.
      if (scope !== undefined && !isUnderAncestor(c.path, scope)) continue;
      surfaces.push(await candidateToSurface({ ...c, required: true }, workspace, requiredRoles, query, cache));
      seenPaths.add(c.path);
      stillMissingSet.delete(c.surface);
    }
  }

  // Pass 2: classify-and-rank scan of the fill scope — issues NO further
  // locate call at all (a directory walk + classifySurface, the same
  // mechanism augmentStyleSurface already uses for "style") — for whichever
  // roles pass 1 still missed.
  missing = stillMissingRequiredRoles(surfaces, requiredRoles).filter((r) => inventory.has(r as ImpactSurface));
  if (missing.length === 0 || surfaces.length >= MAX_SURFACES_DISTINCT) return;

  const queryTokens = concernAnchorTokens(query, 8);
  const scoreOf = (p: string): number => queryTokens.filter((t) => p.toLowerCase().includes(t)).length;
  for (const role of missing) {
    if (surfaces.length >= MAX_SURFACES_DISTINCT) break;
    const candidates = walkCodeFiles(workspace, {})
      .map((f) => f.relPath)
      .filter((p) => !seenPaths.has(p))
      .filter((p) => isUnderAnyPrefix(p, fillScopes))
      .filter((p) => scope === undefined || isUnderAncestor(p, scope))
      .filter((p) => classifySurface(p) === role)
      .sort((a, b) => scoreOf(b) - scoreOf(a) || (a < b ? -1 : 1));
    const best = candidates[0];
    if (!best) continue;
    const raw = readCached(workspace, best, cache);
    const lineCount = raw !== undefined ? Math.max(1, countLines(raw)) : 1;
    surfaces.push(await candidateToSurface(
      {
        path: best,
        line: 1,
        range: `1-${lineCount}`,
        surface: role as ImpactSurface,
        why: "role-fill-scan",
        confidence: 0.6,
        required: true,
      },
      workspace,
      requiredRoles,
      query,
      cache,
    ));
    seenPaths.add(best);
  }
}

/**
 * B1c: force-include every query-named workspace file as a CONTENT-BEARING
 * surface. Uses the same anchor-focus ranging the good complete packs use
 * (anchorFocusForLocatorCandidate), so a large named file ships the region the
 * task is about instead of a fixed-width sliver of its head.
 *
 * Bounded: never exceeds MAX_SURFACES_DISTINCT, and is a no-op when the query
 * names no resolvable file (the overwhelmingly common case). Additive in the
 * common case — never reorders or drops what the flow already found — EXCEPT
 * (R0, 2026-08-21 W4-A forensics) when the budget is already full: a
 * query-named file is a STATED REQUIREMENT, not a ranked candidate (a file
 * the QUERY names by name, verbatim, with its extension), so it may evict the
 * single weakest present surface (not required, not already protected, not
 * grounded in the query at all — see surfaceGroundedInQuery) to make room,
 * rather than being silently dropped because weaker evidence happened to
 * fill the budget first. A no-op, as before, when every present surface is
 * required/protected/grounded.
 *
 * TL142-05 (2026-09-13): the candidate below is now stamped `required: true`
 * — this doc comment already called it a "STATED REQUIREMENT", but nothing
 * actually marked the surface that way, so a later byte-budget pass
 * (trimToCap) could still strip or drop it like any ordinary evidence
 * surface. A file the query names by its own full, extension-qualified path
 * must survive exactly like any other caller-explicit target.
 */
export async function augmentQueryNamedFileSurfaces(
  surfaces: TaskPackSurface[],
  query: string,
  workspace: string,
  requiredRoles: string[],
  cache: FileReadCache,
  protectedSurfaces?: Set<TaskPackSurface>,
  maxSurfaces: number = MAX_SURFACES_DISTINCT,
): Promise<void> {
  // R0 (2026-08-21, W4-A): disambiguate a bare-basename query-named token
  // (e.g. "server.ts") toward THIS task's own trustworthy root when the same
  // name exists under more than one project — see queryNamedWorkspaceFiles
  // and trustworthySurfaceAnchorPaths' own comments.
  const named = queryNamedWorkspaceFiles(query, workspace, trustworthySurfaceAnchorPaths(surfaces));
  if (named.length === 0) return;
  const already = new Set(surfaces.map((s) => s.path));
  for (const rel of named) {
    if (already.has(rel)) continue;
    if (surfaces.length >= maxSurfaces) {
      // A query-explicit file is an obligation, not another lexical-rank
      // contender. Prefer evicting an ungrounded surface, but when every
      // non-required candidate has a lexical anchor, evict one of those too:
      // lexical relevance must never exempt a surface from a named-file duty.
      const evictIndex = surfaces.findIndex((s) =>
        !s.required && !protectedSurfaces?.has(s) && !surfaceGroundedInQuery(s, query)
      ) ?? -1;
      const fallbackEvictIndex = evictIndex === -1
        ? surfaces.findIndex((s) => !s.required && !protectedSurfaces?.has(s))
        : evictIndex;
      if (fallbackEvictIndex === -1) continue;
      const [evicted] = surfaces.splice(fallbackEvictIndex, 1);
      if (evicted) already.delete(evicted.path);
    }
    // AA1 (2026-09-14, review round 10): ONE reader, ONE verdict. Rounds 4-9
    // had this door try `readCached` (strict) and then, on failure, a SECOND
    // more permissive reader (`readNamedFileTextLenient` + `classifyLenientText`)
    // so it would not disclose a file the slice route was willing to serve.
    // `FileReadCache.read` now applies the SAME `readServedText` policy every
    // other door applies, so the second attempt could only ever return the same
    // verdict: a file this returns `undefined` for is a file NO door serves.
    // `verdictFor` supplies the one fact the text cannot carry — whether a rare
    // incidental NUL was stripped — which `why` must state, exactly as before.
    const content = readCached(workspace, rel, cache);
    if (content === undefined) {
      // BLOCKER 25 (2026-09-14, review round 4): a path the QUERY named,
      // resolved by `queryNamedWorkspaceFiles`, that this server cannot serve —
      // mode 000, ENOENT, a directory, or bytes that are not text in this
      // encoding. Before this, the `continue` was silent: `namedPaths.length > 0`
      // with no named surface, and nothing downstream could say the request had
      // named a file at all. The pack then certified `act.answer` over whatever
      // weak lexical window happened to survive, with the named path disclosed
      // NOWHERE. Recorded here (the one site that holds the fact) and disclosed
      // at `dedupeTrimAndPersist`.
      // SHOULD-FIX 65 (AC1, round 12): these paths come from the QUERY's own text.
      noteUnreadableNamedPath(workspace, rel, "request");
      continue;
    }
    const queryNamedWhy = cache.verdictFor(rel)?.kind === "stripped"
      ? "query-named-file; nul-stripped"
      : "query-named-file";
    // WP-I (eval-0929 §5/§8, adopted chip from WP-F's sameNameFocal fix):
    // the query named THIS file explicitly. When it also DECLARES an
    // identifier the query names and an EARLIER surface already claims that
    // exact identifier as the primary `answer-explicit-symbol-focus` from a
    // DIFFERENT path, the named file's own declaration -- never the other
    // file's -- is the question's real focus (eval-0929's own "a path in
    // the question is focus" rule): promote it to that same label at its
    // exact declaration range, and mark the other file's claim secondary.
    // A no-op whenever the named file does not itself declare a query-named
    // identifier, or nothing else has already claimed one: this only ever
    // REASSIGNS the label between two declarations of the SAME identifier,
    // never invents a new one or drops either body.
    let explicitFocus: { symbol: string; range: string } | undefined;
    let demote: TaskPackSurface | undefined;
    const namedFileLang = languageForPath(rel);
    if (namedFileLang) {
      for (const identifier of explicitCodeIdentifiers(query)) {
        const parsed = (await cache.parsedSymbols(content, namedFileLang, rel)) ?? [];
        const declared = parsed.find((s) => unqualifiedSymbolTail(s.name) === identifier);
        if (declared === undefined) continue;
        const collidingDecoy = surfaces.find((s) =>
          s.path !== rel
          && s.why === "answer-explicit-symbol-focus"
          && s.symbol !== undefined
          && unqualifiedSymbolTail(s.symbol) === identifier
        );
        if (collidingDecoy === undefined) continue;
        explicitFocus = { symbol: unqualifiedSymbolTail(declared.name), range: `${declared.startLine}-${declared.endLine}` };
        demote = collidingDecoy;
        break;
      }
    }
    const candidate: ImpactCandidate = explicitFocus === undefined
      ? {
          path: rel,
          line: 1,
          range: `1-${Math.max(1, countLines(content))}`,
          surface: classifySurface(rel),
          why: queryNamedWhy,
          confidence: 1,
          required: true,
        }
      : {
          path: rel,
          line: Number.parseInt(explicitFocus.range.split("-", 1)[0] ?? "1", 10),
          range: explicitFocus.range,
          symbol: explicitFocus.symbol,
          surface: classifySurface(rel),
          why: "answer-explicit-symbol-focus",
          confidence: 1,
          required: true,
        };
    const anchored = await anchorFocusForLocatorCandidate(candidate, workspace, query, cache);
    const surface = await candidateToSurface(
      anchored?.candidate ?? candidate, workspace, requiredRoles, query, cache,
    );
    if (anchored) attachAnchorFocusAffordance(surface, anchored.focus, rel, workspace);
    surfaces.push(surface);
    protectedSurfaces?.add(surface);
    already.add(rel);
    if (demote !== undefined) {
      // Take over the decoy's own slot (model.ts's TaskPackSurface.likely_edits
      // doc: "the PRIMARY surface" is "the first surface in the pack, or any
      // surface marked required") so the named file's declaration -- not the
      // same-name decoy -- occupies the front position, never merely a
      // stronger `why` string buried after it.
      const demoteIndex = surfaces.indexOf(demote);
      if (demoteIndex !== -1 && demoteIndex !== surfaces.length - 1) {
        surfaces.splice(surfaces.length - 1, 1);
        surfaces.splice(demoteIndex, 0, surface);
      }
      demote.why = `${demote.why} (same-name declaration; the question named ${rel})`;
    }
  }
}

/**
 * TL142-05 (2026-09-13): when the request itself names explicit path(s) in
 * its query text (queryNamedWorkspaceFiles), the general answer-evidence
 * FALLBACK admission (`why:"answer-query-evidence-focus"` —
 * rankAnswerEvidenceCandidates' weakest tier: a surface admitted purely
 * because SOME line in it scored as lexically relevant, no symbol anchor, no
 * relation check of any kind) may no longer add an unrelated file. It
 * survives only with a stated relation to a named path (statedRelation-
 * ToNamedPath — import / is-imported-by / calls / is-called-by / config /
 * test), and its `why` is rewritten to STATE that relation — report's own
 * acceptance: "追加evidenceには質問との関係を説明できる理由を持たせる" — in
 * the shape `"<relation> (answer-query-evidence-focus)"`. An unrelated
 * surface is dropped outright (never merely trimmed later). A no-op when the
 * query names no explicit path (namedPaths.length === 0): every OTHER query
 * shape's existing fallback-admission behaviour is unchanged. Also a no-op
 * for a surface that IS itself one of the named paths (the STATED
 * REQUIREMENT, not "extra" evidence at all).
 *
 * Deliberately a POST-pass over the assembled `surfaces` array rather than a
 * change to rankAnswerEvidenceCandidates' own scoring — that ranking loop's
 * output feeds several OTHER branches (strongEvidenceAnswer,
 * exactLocatedAnswer, orderByLocatorVerdict's front-loading), so gating
 * admission there risks moving unrelated decisions; this targets exactly the
 * one `why` tag the report names, nothing else.
 *
 * SHOULD-FIX 8 (2026-09-13, review round): a PATHLESS query used to make this
 * whole function a no-op (an early `return` on `namedPaths.length === 0`),
 * so its relevance bar never ran for the far more common pathless case —
 * only `runInternalReadinessFalsification`'s counterexample admission had a
 * pathless bar. Live regression: a pathless schemaStamp query still shipped
 * an unrelated `readme.md` tagged with the bare, unexplained
 * `answer-query-evidence-focus` `why`. Fix: the pathless branch below applies
 * the SAME relevance bar the pathless counterexample already uses — the
 * window must reference an explicit query identifier or a symbol of the
 * PRIMARY evidence (the required surface, or `surfaces[0]` when none is
 * marked required — the same "primary" `runInternalReadinessFalsification`
 * uses), and a markup/CSS window never qualifies regardless. A kept extra's
 * `why` states which identifier it references
 * (`"answer-query-evidence-focus: references <name>"`); an unrelated one is
 * dropped outright, same as the named-path branch.
 */
export function gateAnswerQueryEvidenceFocusOnNamedPathRelation(
  surfaces: TaskPackSurface[],
  query: string,
  workspace: string,
  cache: FileReadCache,
): void {
  const namedPaths = queryNamedWorkspaceFiles(query, workspace, trustworthySurfaceAnchorPaths(surfaces));
  // Precomputed once, used only by the pathless branch below — cheap even
  // when unused (the named-path branch never reads either).
  const explicitIdentifiers = namedPaths.length === 0 ? explicitCodeIdentifiers(query) : [];
  const primarySymbol = namedPaths.length === 0
    ? surfaces.find((s) => s.required === true)?.symbol ?? surfaces[0]?.symbol
    : undefined;
  // 2026-09-14 (v0.14.2 eval fix wave, GATE-B, fxR3bEngagementMarking's D7
  // regression): the pathless branch below used to accept ONLY an explicit
  // query identifier or the primary surface's own symbol — unlike its
  // named-path sibling a few lines down, it never fell back to
  // `statedRelationToNamedPath`'s import/calls/is-called-by/config/test
  // check. That asymmetry starves a pathless "retain the supporting
  // context" query of any lexically-related-but-not-identifier-mentioning
  // surface (measured: FX-R3b D7's own engagement fixture — a file that
  // calls a function the primary declares, but never repeats the traced
  // identifier itself, is dropped here even though it is exactly the kind
  // of stated relation TL142-05 elsewhere treats as sufficient). Resolving
  // the primary surface's own PATH (parallel to `primarySymbol` above) lets
  // the loop below try the same relation check the named-path branch
  // already runs, as a fallback — never a replacement — for the identifier
  // match.
  const primaryPath = namedPaths.length === 0
    ? surfaces.find((s) => s.required === true)?.path ?? surfaces[0]?.path
    : undefined;
  for (let i = surfaces.length - 1; i >= 0; i--) {
    const surf = surfaces[i]!;
    if (surf.why !== "answer-query-evidence-focus") continue;
    if (namedPaths.length > 0) {
      if (namedPaths.includes(surf.path)) continue; // it IS a named path — a stated requirement, not extra evidence
      // BLOCKER 12 (review round 3, 2026-09-13): mirror the pathless
      // branch's own "never drop the last surviving surface" floor. This
      // branch's usual invariant — augmentQueryNamedFileSurfaces has
      // ALREADY guaranteed at least one required named-file surface before
      // this function ever runs — does NOT hold when the named path
      // resolves but cannot be READ (readCached returns undefined, e.g. a
      // mode-000 file): augmentQueryNamedFileSurfaces' own `if (content ===
      // undefined) continue;` leaves namedPaths.length > 0 with no named
      // surface at all, so a weak `answer-query-evidence-focus` surface can
      // be the pack's ONLY surface. Splicing it away unconditionally
      // emptied `surfaces`, and buildAnswerTaskPack's own
      // `surfaces[0]!.range` a few lines below this function's call site
      // then threw on `undefined` — a bare JSON-RPC error, no `v:1`
      // envelope at all (E2E: scratchpad/r2-ws-weak2 — src/theme.css plus a
      // chmod-000 src/locked.ts the query names by path).
      // buildAnswerTaskPack ALSO now guards an empty `surfaces[]` directly
      // at its own sink (defense in depth for any OTHER path that might
      // empty the array); this floor keeps that guard from ever needing to
      // fire here.
      //
      // BLOCKER 25 (2026-09-14, review round 4): the floor above was a bare
      // `continue`, so it skipped the markup/CSS veto AND the `why`
      // restatement the sibling pathless branch applies — the sole survivor
      // shipped under the bare, unexplained `answer-query-evidence-focus`
      // tag, and `buildAnswerTaskPack` then certified `act.answer` over it
      // because `surface-content` was the only obligation left. The two
      // branches of one gate had different honesty rules. They now share one:
      // a markup/CSS sole survivor is DROPPED (the pack degrades to a
      // structured decision through BLOCKER 12's empty-surfaces sink), and a
      // real-code sole survivor is KEPT with its `why` restated. Reaching
      // this floor at all means NO named surface exists (a named path is
      // `continue`d above, and `augmentQueryNamedFileSurfaces` otherwise
      // guarantees one) — i.e. exactly the unreadable/undecodable named-path
      // case `unreadable_named_paths` discloses, so dropping here never
      // starves a pack that had a named file to serve.
      if (surfaces.length <= 1) {
        const soleContent = surf.code ?? readCached(workspace, surf.path, cache);
        if (soleContent !== undefined && looksLikeMarkupOrCssWindow(soleContent)) {
          surfaces.splice(i, 1);
          continue;
        }
        if (surf.why === "answer-query-evidence-focus") {
          surf.why = "answer-query-evidence-focus: only candidate";
        }
        continue;
      }
      const content = surf.code ?? readCached(workspace, surf.path, cache);
      const relation = content === undefined
        ? undefined
        : statedRelationToNamedPath(surf.path, content, namedPaths, workspace, cache);
      if (relation !== undefined) {
        surf.why = `${relation} (answer-query-evidence-focus)`;
        continue;
      }
      surfaces.splice(i, 1);
      continue;
    }
    // SHOULD-FIX 8: pathless variant — same bar as the pathless
    // counterexample (runInternalReadinessFalsification): fails CLOSED
    // (drop) unless the window references a real identifier, and a
    // markup/CSS window is vetoed outright regardless of what it mentions.
    //
    // SHOULD-FIX 17 (review round 3, 2026-09-13): this used to floor at
    // `if (surfaces.length <= 1) continue;` BEFORE the markup/CSS veto
    // below, so the one shape this whole gate exists to exclude — a
    // markup/CSS window with no real identifier reference — could be the
    // SOLE surviving surface, kept with the bare, unexplained
    // `answer-query-evidence-focus` tag (E2E: scratchpad/r2-ws-weak2's
    // pathless case, src/theme.css alone). Now that buildAnswerTaskPack's
    // own sink guards an empty `surfaces[]` (BLOCKER 12) instead of
    // crashing on it, dropping a markup/CSS sole survivor is safe: the
    // caller degrades to a structured discover/await_input outcome instead
    // of serving a window this gate itself judged irrelevant.
    //
    // The identifier-match test further below is deliberately NOT applied
    // to a sole survivor: replayCorpus's own ds8_answer_profile_entry (a
    // pathless query naming a nonexistent class against a fixture with no
    // such class) requires a body-bearing answer surface even when nothing
    // in the workspace grounds the query's own identifier — dropping the
    // pack's only REAL-CODE evidence would starve a genuinely weak-but-real
    // answer of everything, trading one honesty problem for a worse one (no
    // evidence at all where some exists). A sole survivor's `why` is still
    // restated here (never left bare) either way, so the unexplained tag
    // can never reach the caller through this function.
    if (surfaces.length <= 1) {
      const soleContent = surf.code ?? readCached(workspace, surf.path, cache);
      if (soleContent !== undefined && looksLikeMarkupOrCssWindow(soleContent)) {
        surfaces.splice(i, 1);
        continue;
      }
      if (surf.why === "answer-query-evidence-focus") {
        surf.why = "answer-query-evidence-focus: only candidate";
      }
      continue;
    }
    const content = surf.code ?? readCached(workspace, surf.path, cache);
    if (content === undefined || looksLikeMarkupOrCssWindow(content)) {
      surfaces.splice(i, 1);
      continue;
    }
    // WP-N (eval-0929 §8): "references X" only for a whole-identifier
    // occurrence of the explicit identifier X — never `X_V2`/`APP_X`.
    const matchedIdentifier = explicitIdentifiers.find((identifier) => containsWholeIdentifier(content, identifier, { caseInsensitive: true }));
    const referencesPrimarySymbol = matchedIdentifier === undefined
      && primarySymbol !== undefined
      && containsWholeIdentifier(content, primarySymbol, { caseInsensitive: true });
    // Fallback (2026-09-14, GATE-B — see the `primaryPath` comment above):
    // no identifier/symbol mention, but the candidate still states one of
    // TL142-05's own relation kinds to the primary surface — the same bar
    // the named-path branch above already accepts. Only tried once neither
    // mention matched, so a real identifier hit is never shadowed by a
    // weaker relation string.
    const relation = matchedIdentifier === undefined && !referencesPrimarySymbol && primaryPath !== undefined
      ? statedRelationToNamedPath(surf.path, content, [primaryPath], workspace, cache)
      : undefined;
    if (matchedIdentifier === undefined && !referencesPrimarySymbol && relation === undefined) {
      surfaces.splice(i, 1);
      continue;
    }
    surf.why = relation !== undefined
      ? `${relation} (answer-query-evidence-focus)`
      : `answer-query-evidence-focus: references ${matchedIdentifier ?? primarySymbol}`;
  }
}

export function capExtraEvidenceRelativeToNamedPaths(
  surfaces: TaskPackSurface[],
  query: string,
  workspace: string,
  /** WP-B: true when removing `candidate` from `current` would withdraw evidence the certificate cites. */
  keep?: (candidate: TaskPackSurface, current: readonly TaskPackSurface[]) => boolean,
): void {
  // v0.15.1 runtime review (2026-10-06): every file a shared bare basename
  // names is named — the question chose none of them, so none is the
  // incidental extra this cap sheds (`b/http.ts` was dropped after
  // certification for "Explain the retry function in http.ts.", leaving an
  // answer from `a/http.ts` alone).
  const namedPaths = [...new Set([
    ...queryNamedWorkspaceFiles(query, workspace, trustworthySurfaceAnchorPaths(surfaces)),
    ...queryNamedWorkspaceFilesKeepingSharedBasenames(query, workspace),
  ])];
  if (namedPaths.length === 0) return;
  let namedBytesTotal = 0;
  for (const namedPath of namedPaths) {
    const content = probeFileText(workspace, namedPath);
    if (content !== undefined) namedBytesTotal += Buffer.byteLength(content, "utf8");
  }
  if (namedBytesTotal === 0) return; // could not size any named file — nothing to cap against
  const cap = Math.ceil(EXTRA_EVIDENCE_NAMED_PATH_CAP_MULTIPLIER * namedBytesTotal);
  let total = 0;
  for (const surf of surfaces) {
    if (typeof surf.code === "string") total += Buffer.byteLength(surf.code, "utf8");
  }
  if (total <= cap) return;
  // C26: two passes, each still last-to-first WITHIN its own tier (preserves
  // the prior tie-break when two candidates carry the same relation
  // strength) — first every candidate whose `why` does NOT state a
  // verified import/call/config/test relation, then, only if still over cap,
  // the relation-verified ones.
  for (const requireRelationVerified of [false, true]) {
    for (let i = surfaces.length - 1; i >= 0 && total > cap; i--) {
      const surf = surfaces[i]!;
      if (namedPaths.includes(surf.path)) continue;
      if (surf.required === true) continue;
      // 2026-09-14 (v0.14.2 eval fix wave, GATE-B —
      // semanticFrontierAnswerGraphE2E's "keeps explicit TS providers on the
      // first pack" regression). `namedPaths` only ever holds FILE-shaped
      // query tokens (`queryNamedWorkspaceFiles`) — a query that instead
      // names several IDENTIFIERS, each resolving to a DIFFERENT file (e.g.
      // "Trace INVOICE_TEMPLATE invoice_template.ts renderInvoice relation":
      // "renderInvoice" names no path token, but is every bit as explicit a
      // request as the literal "invoice_template.ts"), had every one of
      // those OTHER explicit matches capped away as if they were incidental
      // extra context — measured: a 3-file exact answer collapsed to 1 file,
      // silently AFTER the earlier `coverage_reason:"candidate-list"` verdict
      // had already been decided assuming all three still stood, so the wire
      // ended up naming a stale "multiple candidates" reason over a single
      // surviving surface.
      // `answer-explicit-symbol-focus`/`answer-explicit-identifier-recovery`
      // are the two `why` values this file mints ONLY for an EXACT match of a
      // query's own explicitly-named identifier (`rankAnswerEvidenceCandidates`,
      // `recoverExplicitIdentifierAnswerCandidates`) — never a weaker semantic
      // or vocabulary-only hit — so exempting them here is the identical bar
      // `namedPaths.includes`/`required===true` already apply to a
      // literally-named file, extended to a literally-named IDENTIFIER.
      if (surf.why === "answer-explicit-symbol-focus" || surf.why === "answer-explicit-identifier-recovery" || surf.why === REQUEST_ANCHOR_DEFINITION_WHY) continue;
      // 2026-10-06 (semantic-frontier `flag` case, after the review's P1-4
      // fix): a facet-closure window (`closure:<facet> …` — a call site, a
      // focal body, a constant it reads) closes a facet the QUESTION asked
      // for and was budgeted by MAX_CLOSURE_BYTES_PER_PACK when served — never
      // incidental extra context. The certificate cites it only while its
      // facet is proved, so a facet disclosed undetermined (one of its
      // subjects resolved to nothing) lost the other subjects' call sites
      // here: "Trace INVOICE_V2_FLAG invoiceVersion renderInvoice
      // src/feature_flags.ts relation …" kept render_invoice.ts's imports and
      // dropped the call `invoiceVersion(flagValue)` itself.
      if ((surf.why ?? "").startsWith("closure:")) continue;
      if (typeof surf.code !== "string") continue;
      const relationVerified = RELATION_VERIFIED_EXTRA_WHY_RE.test(surf.why ?? "");
      if (relationVerified !== requireRelationVerified) continue;
      if (keep?.(surf, surfaces) === true) continue;
      total -= Buffer.byteLength(surf.code, "utf8");
      surfaces.splice(i, 1);
    }
  }
}
