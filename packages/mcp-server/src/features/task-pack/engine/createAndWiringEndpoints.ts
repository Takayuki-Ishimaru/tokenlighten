// createAndWiringEndpoints — extracted implementation; imports point to the owning modules.
import * as fs from "fs";
import * as path from "path";
import type { ImpactSurface } from "@tokenlighten/types";
import type { TaskPackSurface } from "../model.js";
import type { WiringEndpoint } from "./createAndWiringEndpoints2.js";
import { CREATE_FILE_JA_RE } from "./queryIntent4.js";
import { CREATE_OR_PLACEMENT_EN_RE } from "./queryIntent4.js";
import { CREATE_TARGET_EXT_RE } from "./createAndWiringEndpoints2.js";
import { FileReadCache } from "./packBasics2.js";
import { WIRING_DEST_ROLE_RANK } from "./createAndWiringEndpoints2.js";
import { asImpactSurface } from "./wiringEvidence2.js";
import { classifySurface } from "../../../util/impact.js";
import { definedCallableNames } from "./wiringEvidence3.js";
import { hasCallableDeclarationSibling } from "./createAndWiringEndpoints2.js";
import { hasCreateFileIntent } from "./queryIntent4.js";
import { isEligibleWiringSourceRole } from "./createAndWiringEndpoints2.js";
import { isImplementationPath } from "./changeAndReadinessEvidence2.js";
import { isUnderAncestor } from "./seedResolution.js";
import { isWiringIdentifierShape } from "./createAndWiringEndpoints2.js";
import { normIdent } from "./createAndWiringEndpoints2.js";
import { projectRootOf } from "../../locator/locateTaskContext.js";
import { resolveStructuralCreateTarget } from "./createAndWiringEndpoints2.js";
import { servedSurfaceText } from "./changeAndReadinessEvidence2.js";
import { structuralWiringDestinationRole } from "./createAndWiringEndpoints2.js";
import { structuralWiringSourceRole } from "./createAndWiringEndpoints2.js";
import { surfaceIndexForToken } from "./createAndWiringEndpoints2.js";
import { walkCodeFiles } from "../../../tools/walkRepo.js";
import { workspaceCallableDefinitionPaths } from "./wiringEvidence2.js";

export function hasCreateOrPlacementIntent(query: string): boolean {
  return hasCreateFileIntent(query)
    || CREATE_OR_PLACEMENT_EN_RE.test(query)
    || CREATE_FILE_JA_RE.test(query);
}

/**
 * True when `query` shows the same "explicit, extensioned create target"
 * shape resolveCreateTargetFromQuery's Path 1 gates on: hasCreateFileIntent
 * (or a bare JA create verb) co-occurring with at least one
 * CREATE_TARGET_EXT_RE token. F-R14 (2026-08-22, DESIGN-v0.11 §9 residual):
 * this is the gate buildTaskPackCore reuses to decide whether a query's
 * locatingQuery should have its fenced content stripped. Duplicated rather
 * than shared with resolveCreateTargetFromQuery's own inline `if` — that
 * `if` only tests the intent half (an absent extension match there is a
 * no-op empty loop, not a skip past it) — because this predicate
 * deliberately wants the stricter, combined check. Read-only /
 * side-effect-free: uses `.match()` (which always resets a global regex's
 * lastIndex), never `.test()`, on CREATE_TARGET_EXT_RE, so repeated calls
 * never race that regex's own shared lastIndex state.
 *
 * Review finding 4: `workspace` is optional and threads straight through to
 * `hasCreateFileIntent`'s extension-path alternative so THIS call site can
 * require the named path to be absent before treating it as a create target
 * — see queryNamesAbsentCreateExtension's doc comment. Omitted, this is
 * byte-identical to the pre-fix predicate (every caller before this fix
 * never passed one). The bare-JA-verb disjunct right below is untouched —
 * it mirrors Path 1's own pre-existing, out-of-scope allowance for a create
 * verb naming its target with no noun at all.
 */
export function queryNamesCreateTarget(query: string, workspace?: string): boolean {
  return (hasCreateFileIntent(query, workspace) || CREATE_FILE_JA_RE.test(query))
    && query.match(CREATE_TARGET_EXT_RE) !== null;
}

/**
 * W3: a create-intent query that NAMES a not-yet-existing file must answer with
 * the create route, not a contentless "go search for it" envelope. Two paths:
 *
 *  1) (wave 2, unchanged) the FIRST query-named path with an explicit code/test
 *     EXTENSION, under the strict verb+noun create gate. directory_evidence is
 *     drawn from the deepest EXISTING ancestor directory.
 *  2) (wave 3, V1) a dotted python MODULE (`pkg.sub.module`) or extension-less
 *     path-ish token, under the broader create/placement gate but structurally
 *     verified against an existing parent package directory — see
 *     resolveStructuralCreateTarget. This closes the live "Where should the new
 *     policyarc_actuary.pricing.rating_engine module live" abstain, which named
 *     no extensioned filename and carried no create VERB, so Path 1 alone left a
 *     contentless ~511-byte envelope.
 *
 * Either path resolves ONLY a target that does NOT already exist and is not
 * already a served surface (an existing name is an edit, not a create). Returns
 * undefined for any non-create/non-placement query, or when nothing resolves.
 */
export function resolveCreateTargetFromQuery(
  query: string,
  workspace: string,
  surfaces: readonly TaskPackSurface[],
): { path: string; directory_evidence: string[] } | undefined {
  const servedPaths = new Set(surfaces.map((s) => s.path));
  // Path 1 (wave 2): explicit extensioned filename under the strict create gate.
  // W9 (2026-08-22): also fire on a bare JA create verb (作成/新規/...) with NO
  // co-occurring noun, mirroring hasCreateOrPlacementIntent's own bare-JA-verb
  // disjunct below. A JA request that already names its target by an explicit
  // extensioned path (e.g. "tmp/TlProbe.cs を...作成してください") legitimately
  // omits the redundant "ファイル" noun the EN phrasing ("a new FILE
  // tmp/TlProbe.cs") supplies instead — CREATE_TARGET_EXT_RE below still
  // requires an actual extensioned token before anything can be named, and the
  // existing-path/served-surface checks in the loop are unchanged, so widening
  // this gate only lets a genuinely-named, not-yet-existing target through; it
  // never relaxes what may be resolved, only which queries may try. EN
  // behavior is byte-identical: hasCreateFileIntent alone still gates it.
  if (hasCreateFileIntent(query) || CREATE_FILE_JA_RE.test(query)) {
    const seen = new Set<string>();
    for (const raw of query.match(CREATE_TARGET_EXT_RE) ?? []) {
      const candidate = raw.replace(/^\.\//, "").replace(/^["'`(]+|["'`)]+$/g, "");
      if (candidate.length === 0 || seen.has(candidate)) continue;
      seen.add(candidate);
      // A bare basename with no directory is still a valid create target, but a
      // path-shaped token is the strong signal; both are accepted.
      if (fs.existsSync(path.join(workspace, candidate))) continue; // exists → edit, not create
      if (servedPaths.has(candidate) || [...servedPaths].some((p) => p.endsWith(`/${candidate}`))) continue;

      // Deepest existing ancestor directory → sibling evidence for the template.
      let dir = path.posix.dirname(candidate);
      if (dir === ".") dir = "";
      while (dir.length > 0 && !fs.existsSync(path.join(workspace, dir))) {
        dir = path.posix.dirname(dir);
        if (dir === ".") dir = "";
      }
      const directoryEvidence = walkCodeFiles(workspace, dir ? { subPath: dir } : {})
        .map((file) => file.relPath)
        .filter((rel) => path.posix.dirname(rel) === (dir || "."))
        .sort()
        .slice(0, 3);
      return { path: candidate, directory_evidence: directoryEvidence };
    }
  }
  // Path 2/3 (wave 3, V1): dotted-module / extension-less create target under the
  // broader create/placement gate, verified structurally against an existing dir.
  if (hasCreateOrPlacementIntent(query)) {
    const structural = resolveStructuralCreateTarget(query, workspace, servedPaths);
    if (structural !== undefined) return structural;
  }
  return undefined;
}

/**
 * Resolve ONE candidate token to a workspace file by (extension-stripped,
 * underscore-insensitive) basename match: between 1 and 3 files under
 * `inFamily` must qualify (0 = unresolvable, >3 = ambiguous — both silent),
 * `preferRoot` breaks a tie toward the file nearest that root ("" = no
 * preference, first walked-order match), and the resolved file's
 * classifySurface role must satisfy `roleOk`. Shared primitive behind BOTH
 * fallback directions (2026-07-10b destination; 2026-07-12b source) so
 * "resolvable" has exactly one definition workspace-wide; each caller only
 * supplies its own exclusion, iteration order, and role predicate.
 */
export function resolveWiringWorkspaceToken(
  tok: string,
  walked: ReadonlyArray<string>,
  excludePath: string,
  inFamily: (p: string) => boolean,
  preferRoot: string,
  roleOk: (role: ImpactSurface) => boolean,
  roleForPath: (relPath: string) => ImpactSurface | undefined = (relPath) => classifySurface(relPath),
): { path: string; role: ImpactSurface } | undefined {
  const nt = normIdent(tok);
  const matches = walked.filter(
    (p) => p !== excludePath && inFamily(p) && normIdent(path.basename(p).replace(/\.[^.]+$/, "")).includes(nt),
  );
  if (matches.length === 0 || matches.length > 3) return undefined;
  const eligible = matches
    .map((candidatePath) => ({ path: candidatePath, role: roleForPath(candidatePath) }))
    .filter((candidate): candidate is { path: string; role: ImpactSurface } =>
      candidate.role !== undefined && roleOk(candidate.role)
    );
  if (eligible.length === 0) return undefined;
  const pick = eligible.find((candidate) =>
    isUnderAncestor(candidate.path, preferRoot === "." ? "" : preferRoot)
  ) ?? eligible[0]!;
  return pick;
}

/**
 * 2026-07-10b closure-derivation gap, factored out unchanged (2026-07-12b):
 * resolve the DESTINATION against the workspace when no mapped surface
 * qualifies — a wiring check earns its keep exactly when the pack
 * UNDER-covered the destination side (live: source-side surfaces served,
 * the consumer gate absent → no check registered, mode=closure stayed the "no
 * closure checks were registered" no-op, and a leg-dropping trajectory
 * shipped unchallenged). Tries the LATEST-mentioned candidate token first
 * (tail-first — "feed A into B", B is the destination), excluding `source`'s
 * own token/file and any token already tried as a mapped surface ("had its
 * chance above"). Keeps every conservatism of the surface-resolved form:
 * concrete identifiers only, family-scoped (2026-07-11a), role must differ
 * from source's AND pass the hard {api,ui} gate (WIRING_DEST_ROLE_RANK), at
 * most one result, silent when ambiguous (>3 basename matches). Satisfaction
 * semantics are IDENTICAL (both tokens in the destination file within the
 * proximity window) — this only widens when the check can REGISTER, never
 * what CLOSES it. Shared by the mapped-source branch and the 2026-07-12b
 * source-fallback branch below, so both compose through one definition of
 * "destination resolvable" instead of two copies of this loop.
 */
export function findWiringDestFallback(
  source: WiringEndpoint,
  tokens: ReadonlyArray<string>,
  surfaces: TaskPackSurface[],
  walked: ReadonlyArray<string>,
  inFamily: (p: string) => boolean,
): WiringEndpoint | undefined {
  const isDestRole = (role: string): boolean => WIRING_DEST_ROLE_RANK[role] !== undefined;
  const srcRoot = projectRootOf(source.path);
  const sourceDir = path.dirname(source.path);
  const outsideSourceDir = (candidatePath: string): boolean =>
    inFamily(candidatePath) && !isUnderAncestor(candidatePath, sourceDir);
  type Cand = WiringEndpoint & { queryIdx: number };
  const cands: Cand[] = [];
  for (let i = tokens.length - 1; i >= 0; i--) {
    const tok = tokens[i]!;
    if (normIdent(tok) === normIdent(source.token)) continue;
    if (surfaceIndexForToken(tok, surfaces) !== -1) continue; // surface-mapped tokens had their chance above
    const res = resolveWiringWorkspaceToken(
      tok, walked, source.path, outsideSourceDir, srcRoot,
      (role) => role !== source.role && isDestRole(role),
      (relPath) => structuralWiringDestinationRole(relPath, classifySurface(relPath)),
    );
    if (res) cands.push({ token: tok, path: res.path, role: res.role, queryIdx: i });
  }
  // Rank viable destinations by executable-code preference, then by latest
  // query position (the original tail-first heuristic) as the tie-break.
  cands.sort((a, b) => {
    const ra = WIRING_DEST_ROLE_RANK[a.role] ?? 9;
    const rb = WIRING_DEST_ROLE_RANK[b.role] ?? 9;
    if (ra !== rb) return ra - rb;
    return b.queryIdx - a.queryIdx;
  });
  return cands[0];
}

export function findWiringSourceFallback(
  tokens: ReadonlyArray<string>,
  surfaces: TaskPackSurface[],
  walked: ReadonlyArray<string>,
  inFamily: (p: string) => boolean,
  workspace: string,
  cache?: FileReadCache,
): WiringEndpoint | undefined {
  const concrete = new Set(tokens.filter(isWiringIdentifierShape).map(normIdent));
  const sourceTokens = concrete.size > 0
    ? tokens.filter((token) => concrete.has(normIdent(token)))
    : tokens;
  for (const tok of sourceTokens) {
    const mappedIndex = surfaceIndexForToken(tok, surfaces);
    const mappedSurface = mappedIndex >= 0 ? surfaces[mappedIndex] : undefined;
    const mappedDefinesToken = mappedSurface !== undefined
      && isImplementationPath(mappedSurface.path)
      && definedCallableNames(servedSurfaceText(mappedSurface))
        .some((name) => normIdent(name) === normIdent(tok));
    if (
      mappedDefinesToken
      && mappedSurface !== undefined
      && !hasCallableDeclarationSibling(tok, mappedSurface.path, workspace, cache)
    ) {
      continue;
    }
    const definitionPaths = workspaceCallableDefinitionPaths(
      tok,
      walked,
      workspace,
      cache,
    ).filter(inFamily);
    if (definitionPaths.length === 1) {
      const definitionPath = definitionPaths[0]!;
      const role = structuralWiringSourceRole(
        definitionPath,
        classifySurface(definitionPath),
        walked,
      );
      const hasCallableDeclaration = hasCallableDeclarationSibling(
        tok,
        definitionPath,
        workspace,
        cache,
      );
      if (isEligibleWiringSourceRole(role) || hasCallableDeclaration) {
        return {
          token: tok,
          path: definitionPath,
          role: hasCallableDeclaration ? "contract" : role,
        };
      }
    }
    // Multiple unrelated implementation bodies are a genuine producer
    // ambiguity. Do not fall back to basename ordering for the same token.
    if (definitionPaths.length > 1) continue;
    const res = resolveWiringWorkspaceToken(
      tok,
      walked,
      "",
      inFamily,
      "",
      (role) => isEligibleWiringSourceRole(role),
      (relPath) => structuralWiringSourceRole(relPath, classifySurface(relPath), walked),
    );
    if (res) return { token: tok, path: res.path, role: res.role };
  }
  return undefined;
}

/**
 * 2026-07-12b: when `source` came from findWiringSourceFallback (no
 * non-dest-role mapped token existed), any entries STILL in `mapped` can only
 * be dest-role ones (a non-dest-role entry would have been picked as source
 * instead) — i.e. a served surface already covers the destination side ("the
 * half-mapped case": dest-role surface mapped, source unmapped). Prefer one
 * of those over ANOTHER workspace walk — it is already a located, served
 * surface — using the SAME rank/latest-query-position tie-break as the
 * mapped-source fast path's destCandidates (no need for the `tokens` array
 * itself: `mapped`'s own element order already IS the query-position order,
 * being built by iterating `tokens` and keeping only the mapped ones).
 */
export function bestMappedWiringDest(
  source: WiringEndpoint,
  mapped: ReadonlyArray<{ token: string; surfIdx: number }>,
  surfaces: TaskPackSurface[],
): WiringEndpoint | undefined {
  const isDestRole = (role: string): boolean => WIRING_DEST_ROLE_RANK[role] !== undefined;
  const cands = mapped
    .map((cand, i) => ({
      cand,
      i,
      role: structuralWiringDestinationRole(
        surfaces[cand.surfIdx]!.path,
        asImpactSurface(surfaces[cand.surfIdx]!.role),
      ),
    }))
    .filter(({ cand, role }) =>
      role !== undefined
      && isDestRole(role)
      && normIdent(cand.token) !== normIdent(source.token)
      && !isUnderAncestor(surfaces[cand.surfIdx]!.path, path.dirname(source.path))
    );
  cands.sort((a, b) => {
    const ra = WIRING_DEST_ROLE_RANK[a.role!] ?? 9;
    const rb = WIRING_DEST_ROLE_RANK[b.role!] ?? 9;
    if (ra !== rb) return ra - rb;
    return b.i - a.i;
  });
  const best = cands[0]?.cand;
  if (best === undefined) return undefined;
  const bestSurface = surfaces[best.surfIdx]!;
  return {
    token: best.token,
    path: bestSurface.path,
    role: structuralWiringDestinationRole(bestSurface.path, asImpactSurface(bestSurface.role))!,
  };
}
