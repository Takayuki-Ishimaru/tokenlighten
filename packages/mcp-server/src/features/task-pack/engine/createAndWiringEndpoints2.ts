// createAndWiringEndpoints — extracted implementation; imports point to the owning modules.
import * as fs from "fs";
import * as path from "path";
import type { ImpactSurface } from "@tokenlighten/types";
import type { PackCheckRecord } from "../../../state/session.js";
import type { TaskPackResult } from "../model.js";
import type { TaskPackSurface } from "../model.js";
import type { TaskProfile } from "@tokenlighten/types";
import { FileReadCache } from "./packBasics2.js";
import { buildLikelyEdits } from "./surfaceMaterialization2.js";
import { definedCallableNames } from "./wiringEvidence3.js";
import { deriveTokenVariants } from "../../../util/impact.js";
import { escapeRegExp } from "../../search/find/findText.js";
import { isEnumLikeQuery } from "../../../util/queryShape.js";
import { isImplementationPath } from "./changeAndReadinessEvidence2.js";
import { isTraceEnabled } from "../../../util/trace.js";
import { languageForPath } from "../../../util/languages.js";
import { projectRootOf } from "../../locator/locateTaskContext.js";
import { readCached } from "./packBasics2.js";
import { relationCodeOnly } from "./wiringEvidence3.js";
import { scanLiteral } from "../../search/find/findText.js";
import { stripModuleExtension } from "./wiringEvidence3.js";
import { stripPathSpans } from "../../../util/queryShape.js";
import { tokenizeQuery } from "../../../util/queryShape.js";
import { trace } from "../../../util/trace.js";
import { walkCodeFiles } from "../../../tools/walkRepo.js";

/** Code/test file extensions a named create target may carry. */
export const CREATE_TARGET_EXT_RE =
  /[\w./-]*[\w-]+\.(?:py|pyi|ts|tsx|js|jsx|mjs|cjs|c|cc|cpp|cxx|h|hpp|hh|go|java|rs|rb|kt|kts|swift|cs|php|scala|sh|txt|md|json|jsonc|yaml|yml|toml|xml|html|css|sql|csv|ini|cfg|env|ps1|psm1|psd1|bat|cmd|graphql|proto|tf|properties)\b/gi;

/**
 * Strip fenced code block(s) (``` ... ```, any/no language tag) out of
 * `text`. F-R14 (2026-08-22, DESIGN-v0.11 §9 residual): a create-with-
 * content task_pack query embeds the NEW file's full body inside a fenced
 * block. That body is not a locating signal — it describes a file that
 * does not exist yet — but every locator/evidence/concern/wiring consumer
 * historically searched and scored against the raw query, so the body's
 * own vocabulary (imports, namespace/class names, ...) pulled unrelated
 * sibling files sharing those tokens into evidence. Tolerates an
 * unterminated trailing fence (stripped to end-of-string — the same
 * leniency an agent's own truncated paste would need). Returns `text`
 * unchanged when it carries no fence marker at all, so a fence-less call
 * site is a pure no-op (byte-identical locatingQuery === query).
 */
export function stripFencedBlocksForLocating(text: string): string {
  if (!text.includes("```")) return text;
  let result = "";
  let cursor = 0;
  for (;;) {
    const openIdx = text.indexOf("```", cursor);
    if (openIdx === -1) {
      result += text.slice(cursor);
      break;
    }
    result += text.slice(cursor, openIdx);
    const closeIdx = text.indexOf("```", openIdx + 3);
    if (closeIdx === -1) break; // unterminated fence: drop opener..EOF
    cursor = closeIdx + 3;
  }
  return result;
}

/**
 * V1: a dotted PYTHON module path token — >=2 identifier segments joined by
 * dots (`pkg.sub.module`). Each segment must start with a letter/underscore so
 * version numbers (`1.2.3`) never match; the parent-dir-exists gate below then
 * filters prose like `e.g.`/`i.e.` and `self.method` (their leading dirs never
 * exist as directories).
 */
export const DOTTED_MODULE_TOKEN_RE = /[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+/g;

/**
 * V1: a slash path-ish token with NO dotted extension (`src/pricing/engine`) —
 * >=2 slash-joined segments. A token that carries an extension (`src/foo.py`) is
 * left to the extensioned Path 1; this pattern's segments exclude `.` so such a
 * token only partially matches and is skipped by the `includes(".")` guard.
 */
export const EXTLESS_PATH_TOKEN_RE = /[\w-]+(?:\/[\w-]+)+/g;

/** True when workspace-relative `rel` resolves to an existing directory. */
export function isExistingDirRel(workspace: string, rel: string): boolean {
  try {
    return fs.statSync(path.join(workspace, rel)).isDirectory();
  } catch {
    return false;
  }
}

/** Immediate-child sibling code files of `dir` (≤3, sorted) — the create template evidence. */
export function directorySiblingEvidence(workspace: string, dir: string): string[] {
  return walkCodeFiles(workspace, dir ? { subPath: dir } : {})
    .map((file) => file.relPath)
    .filter((rel) => path.posix.dirname(rel) === (dir || "."))
    .sort()
    .slice(0, 3);
}

/**
 * Nearest existing ancestor directory of workspace-relative `targetPath`,
 * walking up from its own parent. F-R14 (2026-08-22, DESIGN-v0.11 §9
 * residual): a create target's own directory often does not exist yet
 * (e.g. "tmp/TlProbe.cs" when "tmp/" is new) — capCreateOnlyEvidence below
 * needs an EXISTING directory to scope sibling evidence to. Returns ""
 * (the workspace root) when no ancestor exists short of the root itself,
 * matching the `dir || "."` root convention directorySiblingEvidence and
 * dominantChildExtension already use.
 */
export function nearestExistingAncestorDir(workspace: string, targetPath: string): string {
  let dir = path.posix.dirname(targetPath);
  while (dir !== "." && dir !== "" && !isExistingDirRel(workspace, dir)) {
    const parent = path.posix.dirname(dir);
    if (parent === dir) break; // safety net: dirname is idempotent at "."/"/"
    dir = parent;
  }
  return dir === "." ? "" : dir;
}

/**
 * F-R14 (2026-08-22, DESIGN-v0.11 §9 residual): for a pure create-only pack
 * (no independent edit target proven — see assertCreateRoute's own
 * independentEdit gate right above its call site), `surfaces` are meant to
 * be imitation references for the new file, not general workspace evidence.
 * Even with buildTaskPackCore's cleaned locatingQuery, a locator/role-filler
 * pass upstream of create_target resolution can still land on a low-signal
 * "everything weakly matches" state for a short/generic create request in a
 * small workspace and leave unrelated files in `surfaces`. Cap them here to
 * files living DIRECTLY in the target's own directory — or its nearest
 * existing ancestor when the target names a not-yet-created directory —
 * the exact scope directorySiblingEvidence already uses for create_target's
 * own directory_evidence. A target whose directory doesn't exist yet
 * (nearest ancestor is the workspace root) keeps no siblings: an untyped
 * project root has no established convention to imitate, so `surfaces`
 * becomes empty rather than the whole repo.
 *
 * F-V13-7 (2026-08-30, independent-verification remediation): the directory
 * filter alone carried NO COUNT LIMIT — a create target sharing its
 * directory with several existing files served every single one of them
 * (observed: a 37-byte/1-line new-file create pulled in 5 siblings, ~13KB,
 * before the file it was about to author even existed). `directorySiblingEvidence`
 * right above already caps the analogous directory_evidence at 3; this now
 * caps at `maxSiblings` (default 1 — one imitation template is enough to
 * show the convention). Selection is deterministic: sort by path (the same
 * bare `.sort()` directorySiblingEvidence itself uses) before slicing, so
 * which sibling(s) survive never depends on upstream locator ordering.
 */
export function capCreateOnlyEvidence(
  surfaces: readonly TaskPackSurface[],
  workspace: string,
  targetPath: string,
  maxSiblings = 1,
): TaskPackSurface[] {
  const scopeDir = nearestExistingAncestorDir(workspace, targetPath) || ".";
  const inScope = surfaces.filter((surface) => path.posix.dirname(surface.path) === scopeDir);
  return inScope
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .slice(0, maxSiblings);
}

/** Most common code extension among `dir`'s immediate children (e.g. ".py"), or undefined. */
export function dominantChildExtension(workspace: string, dir: string): string | undefined {
  const counts = new Map<string, number>();
  for (const file of walkCodeFiles(workspace, dir ? { subPath: dir } : {})) {
    if (path.posix.dirname(file.relPath) !== (dir || ".")) continue;
    const ext = path.posix.extname(file.relPath);
    if (ext.length > 0) counts.set(ext, (counts.get(ext) ?? 0) + 1);
  }
  let best: string | undefined;
  let bestCount = 0;
  for (const [ext, count] of counts) {
    if (count > bestCount) { best = ext; bestCount = count; }
  }
  return best;
}

/**
 * V1 (turn-economy wave 3): resolve a create target NAMED as a dotted python
 * module (`pkg.sub.module` → `pkg/sub/module.py`) or an extension-less path-ish
 * token (`src/pricing/engine` → `src/pricing/engine.<domExt>`), each gated on
 * its parent PACKAGE DIRECTORY already existing. That structural gate is the
 * safety: it disambiguates module-vs-symbol (`pkg.module.symbol` where
 * `pkg/module.py` is a FILE — not a dir — never resolves), rejects prose dots,
 * and keeps the target inside the caller's real layout. Returns the FIRST such
 * token whose target file is ABSENT (not an existing file or subpackage dir) and
 * is not already a served surface. Extension for the dotted form is `.py` (the
 * dotted-import notation is python by construction); for the slash form it is
 * inferred from the parent's dominant sibling extension (skipped when there is
 * no sibling evidence to infer from — too speculative to guess a language).
 */
export function resolveStructuralCreateTarget(
  query: string,
  workspace: string,
  servedPaths: Set<string>,
): { path: string; directory_evidence: string[] } | undefined {
  const consider = (
    target: string,
    parentDir: string,
  ): { path: string; directory_evidence: string[] } | undefined => {
    if (!isExistingDirRel(workspace, parentDir)) return undefined; // package dir must already exist
    if (fs.existsSync(path.join(workspace, target))) return undefined; // exists (file or dir) → edit/subpackage, not create
    if (servedPaths.has(target) || [...servedPaths].some((p) => p.endsWith(`/${target}`))) return undefined;
    return { path: target, directory_evidence: directorySiblingEvidence(workspace, parentDir) };
  };
  // Dotted python module: pkg.sub.mod → pkg/sub/mod.py when pkg/sub/ is a dir.
  for (const token of query.match(DOTTED_MODULE_TOKEN_RE) ?? []) {
    const segments = token.split(".");
    const parentDir = segments.slice(0, -1).join("/");
    const target = `${parentDir}/${segments[segments.length - 1]}.py`;
    const resolved = consider(target, parentDir);
    if (resolved !== undefined) return resolved;
  }
  // Extension-less path-ish token: src/foo/bar → src/foo/bar.<domExt> when src/foo/ is a dir.
  for (const m of query.matchAll(EXTLESS_PATH_TOKEN_RE)) {
    const raw = m[0];
    // D5 fix (2026-08-07): EXTLESS_PATH_TOKEN_RE's [\w-] class structurally
    // EXCLUDES dots, so a token immediately followed by a dotted/extensioned
    // continuation in the SOURCE query (e.g. "checkoutFlow.spec.ts" matches
    // only "checkoutFlow") is silently TRUNCATED rather than rejected —
    // `token.includes(".")` below can never catch this, because the
    // extracted token itself never contains the dot that got cut off.
    // Grafting an inferred extension onto that truncated prefix then mints
    // a WRONG path (observed live: "checkoutFlow.spec.ts" truncated to
    // "checkoutFlow" → synthesized "checkoutFlow.ts", dropping ".spec",
    // even though the real "checkoutFlow.spec.ts" was already a served
    // surface). A "." immediately followed by a word character in the
    // ORIGINAL query right after this match means the source text kept
    // going past a dot this char class cannot cross — skip rather than
    // guess. A bare trailing "." (ordinary sentence punctuation, nothing
    // word-like after it) is NOT this case and must keep resolving as
    // before — this is why the check is a lookahead on the original
    // string, not a property of the (necessarily dot-free) extracted token.
    if (/^\.\w/.test(query.slice(m.index! + raw.length))) continue;
    const token = raw.replace(/^\.\//, "").replace(/\/+$/, "");
    if (token.includes(".")) continue; // carries an extension → handled by Path 1
    const parentDir = path.posix.dirname(token);
    if (parentDir === "." || parentDir.length === 0) continue; // bare basename → Path 1 territory only
    const ext = dominantChildExtension(workspace, parentDir);
    if (ext === undefined) continue; // no sibling evidence → can't infer a language extension
    const resolved = consider(`${token}${ext}`, parentDir);
    if (resolved !== undefined) return resolved;
  }
  return undefined;
}

/**
 * W3: re-assert the concrete create ROUTE on a NON-artifact create-target pack
 * as the FINAL word — a prepared contract legitimately drops a discovery
 * `next`, but a create's next is the edit action itself (`tl_edit_file create:true
 * path=…`), not a discovery call, so it must survive. Called at the emit choke
 * point after all contract/route machinery. Never touches an artifact_build
 * pack (it carries its own artifact-section next) or an answer pack.
 *
 * W9 (2026-08-22): this is the SINGLE authoritative create re-assertion
 * point — it is called again just before the final contract build and once
 * more on the byte-budget fallback envelope, so it must replay EVERY field
 * the create-target block itself sets, not just route/next. A create-unaware
 * pass running between the create-target block and here can otherwise
 * overwrite the others — most concretely reconcileContentSufficiency's
 * default actionTargets rule, which (with change_contract cleared by the
 * create block) falls back to "surfaces[0] is the mandatory edit target" and
 * demotes a never-served LOCATOR hit into a needs-followup verdict, even
 * though that surface is unrelated context for a file that does not exist
 * yet.
 */
export function assertCreateRoute(result: TaskPackResult, profile: TaskProfile, workspace?: string): void {
  if (
    profile === "artifact_build"
    || result.create_target === undefined
    || result.route?.action === "answer_from_handles"
  ) {
    return;
  }
  result.coverage = "focused";
  result.coverage_reason = "single-site";
  result.missing = [];
  result.content_sufficiency = undefined;
  result.blocking_next_steps = undefined;
  delete result.next;
  // Existing surfaces are reference context for create-only tasks. Keep a
  // frontier only when the request also proves an independent edit target —
  // F-V13-7 (2026-08-30, independent-verification remediation): and even
  // then, keep ONLY that target's own evidence. Before this, ANY independent
  // edit obligation exempted the WHOLE surface set from the create-only diet
  // below (a single unrelated "also edit config.ts" clause let every locator
  // hit through uncapped). `independentEditHandles`/`independentEditPaths`
  // name exactly the wiring/obligation targets that are load-bearing for
  // that edit; every other surface remains pure imitation reference
  // material for the new file and stays subject to capCreateOnlyEvidence.
  const independentEditHandles = new Set(result.wiring?.edit_frontier ?? []);
  const independentEditPaths = new Set(
    (result.change_contract?.obligations ?? [])
      .filter((obligation) => obligation.action === "edit" && obligation.path !== result.create_target?.path)
      .map((obligation) => obligation.path),
  );
  const independentEdit = independentEditHandles.size > 0 || independentEditPaths.size > 0;
  if (!independentEdit) {
    if (result.wiring !== undefined) result.wiring.edit_frontier = [];
    if (result.change_contract !== undefined) {
      result.change_contract.obligations = result.change_contract.obligations.filter((obligation) =>
        obligation.action !== "edit" || obligation.path === result.create_target?.path);
    }
  }
  // F-R14 (2026-08-22, DESIGN-v0.11 §9 residual) + F-V13-7 (2026-08-30): a
  // create-only pack's `surfaces` are imitation references, not general
  // evidence — cap them to the target's own directory (see
  // capCreateOnlyEvidence's doc comment). A surface backing a proven
  // independent edit obligation is load-bearing for that edit, not imitation
  // material, so it is carried through untouched — never handed to the
  // directory-scoped cap — regardless of independentEdit above. This is a
  // SEPARATE decision from the wiring/change_contract clearing just above:
  // diet application and frontier clearing must never be conflated — a pack
  // can legitimately keep a real edit frontier AND still diet its unrelated
  // imitation surfaces. `workspace` is only absent for legacy direct unit
  // calls that hand-build a TaskPackResult with no real filesystem behind
  // it; skip the cap then rather than resolve directories against a
  // workspace that doesn't exist.
  //
  // F-V13-7 follow-up: a surface the CALLER explicitly named (`paths:[...]`,
  // a query-named file, or a paired header/source sibling) is load-bearing
  // for the SAME reason an independent edit target is — dropping it silently
  // desyncs reconcileCallerPathCoverage's "every existing caller path is
  // either served or named in missing" invariant, which then reports the cut
  // sibling as a genuine gap and demotes the whole pack to needs-followup
  // (observed live: `paths:[ServiceA.ts, ServiceB.ts]` + surfaceRoles:["api"]
  // on a create query kept only ServiceA.ts, and the pack fell to
  // locate_missing_surfaces over ServiceB.ts). These markers are exactly what
  // the byte-budget-shedding pass below already treats as "never silently
  // drop an explicitly requested file" — reused here, not reinvented.
  const hasExplicitCallerProvenance = (why: string | undefined): boolean =>
    why !== undefined
    && (why.includes("caller-supplied") || why.includes("query-named-file") || why.includes("header-source-pair"));
  if (workspace !== undefined && result.surfaces.length > 0) {
    const keep = new Set(
      result.surfaces.filter((surface) =>
        independentEditHandles.has(surface.handle)
        || independentEditPaths.has(surface.path)
        || hasExplicitCallerProvenance(surface.why)),
    );
    const dietable = result.surfaces.filter((surface) => !keep.has(surface));
    const cappedList = capCreateOnlyEvidence(dietable, workspace, result.create_target.path);
    const capped = new Set(cappedList);
    result.surfaces = result.surfaces.filter((surface) => keep.has(surface) || capped.has(surface));
    // I-7 (2026-08-30 forensics attribution wave): fires only when the cap
    // actually removed a candidate sibling (F-V13-7's own incident: an
    // uncapped diet once served 5 siblings/~13KB for a 37-byte new file) —
    // a pack whose dietable set already fit under maxSiblings triggers
    // nothing here. `target_dir_class` mirrors capCreateOnlyEvidence's own
    // nearestExistingAncestorDir walk: does the create target's OWN
    // immediate parent directory already exist, or is this an as-yet-uncreated
    // directory with no sibling convention to imitate.
    if (isTraceEnabled() && dietable.length > cappedList.length) {
      const targetDir = path.posix.dirname(result.create_target.path);
      trace(
        "create_evidence_diet",
        {
          candidate_siblings: dietable.length,
          kept_siblings: cappedList.length,
          kept_caller_named: keep.size,
          target_dir_class: isExistingDirRel(workspace, targetDir === "." ? "" : targetDir)
            ? "existing-dir"
            : "new-dir",
        },
        workspace,
      );
    }
  }
  result.route = {
    action: "edit_from_handles",
    reason: "requested new file resolved; create it with tl_edit_file create:true, imitating the served sibling(s)/module",
    max_additional_tl_calls: 0,
  };
  // A locator/concern-extraction pass upstream of create_target resolution can
  // treat the not-yet-existing class/file name as an "unmatched concern" (it
  // can never be found among served surfaces — it doesn't exist yet) and stamp
  // a "concern(s) not covered: <name>" check line. Telling the agent to go
  // locate/confirm the very class it is about to author is never actionable;
  // strip it once the create target is certain.
  result.checks = dropCreateTargetConcernChecks(result.checks, result.create_target.path);
  // W9 follow-up (2026-08-22): served siblings are imitation references ONLY
  // (see the route reason above) — a `likely_edits` hint on one of them (set
  // at surface-emission time, before create_target was known) tells the agent
  // to edit that EXISTING file instead of authoring the new one. The
  // actionable target already lives in `next`/`route`/`create_target`; strip
  // the stale hint from every surface every time the create route is
  // (re)asserted, so no later pass can leave one on the wire.
  for (const surface of result.surfaces) {
    if (surface.likely_edits !== undefined) {
      surface.likely_edits = undefined;
    }
  }
}

/**
 * Remove a "concern(s) not covered: …" check line's mention of the resolved
 * create target's own name — the class/file the agent is about to author can
 * never appear among served surfaces, so it is never a real gap. Drops just
 * the matching token from the comma-separated list; drops the whole line only
 * when that leaves nothing else uncovered, so a genuinely different unmatched
 * concern bundled in the same line still surfaces. A non-matching line (any
 * other check, or a concern line with no mention of the create target) is
 * returned byte-identical.
 */
export function dropCreateTargetConcernChecks(
  checks: string[] | undefined,
  createTargetPath: string,
): string[] | undefined {
  if (checks === undefined || checks.length === 0) return checks;
  // normIdent (case- AND underscore-insensitive) so a PascalCase class name
  // like "AltitudeProbe" matches a snake_case file stem like "altitude_probe"
  // — the common C++/Python convention this file's own artifact-target
  // matching (exactArtifactTargetServed) already normalizes the same way.
  const stem = normIdent(path.basename(createTargetPath, path.extname(createTargetPath)));
  const base = normIdent(path.basename(createTargetPath));
  const prefix = "concern(s) not covered: ";
  const suffix = " — locate/confirm before declaring done";
  return checks.flatMap((line) => {
    if (!line.startsWith(prefix) || !line.endsWith(suffix)) return [line];
    const tokens = line.slice(prefix.length, line.length - suffix.length).split(",").map((token) => token.trim());
    const remaining = tokens.filter((token) => {
      const normalized = normIdent(token);
      return normalized !== stem && normalized !== base;
    });
    if (remaining.length === tokens.length) return [line];
    if (remaining.length === 0) return [];
    return [`${prefix}${remaining.join(",")}${suffix}`];
  });
}

export function editIntentForRole(query: string, role: string, why?: string): string {
  // DESIGN-v0.8 §A6 deliverable 1: an exhaustive-initializer match carries
  // its own precise guidance regardless of which role it classified into
  // (aggregation-service code can land in "api" or "domain"
  // depending on the project's layout) — checked BEFORE the role-based
  // enum-like branches below so it always wins for this why, not just when
  // role happens to be "api".
  if (why === "exhaustive-initializer") {
    return "extend the existing exhaustive map with the new value; keep the local form. New runtime symbol uses need value bindings/imports in the same edit batch (import type provides no value)";
  }
  if (why === "concern-causal-layer") {
    return "this surface is the causal layer of the concern named in the task; fix the root cause here rather than compensating downstream, keeping this layer's state and units consistent";
  }

  const lower = query.toLowerCase();

  if (isEnumLikeQuery(query)) {
    if (role === "contract") return "add the value to exported enum/type/schema contracts";
    if (role === "api") return "extend validation/aggregation maps; runtime enumeration needs a value binding/import in this batch (import type provides no value)";
    if (role === "ui") return "update badges, filters, forms, and rendered labels for the value";
    if (role === "style") return "add matching design tokens and class/style mappings for the value";
  }

  if (lower.includes("rename")) {
    return "update references that intentionally name the symbol";
  }

  return "inspect this handle and apply the minimal scoped edit";
}

export function doneCheckForRole(query: string, role: string, why?: string): string {
  if (why === "exhaustive-initializer") {
    return "exhaustive initializer/aggregation map includes the new value";
  }
  if (why === "concern-causal-layer") {
    return "the concern named in the task is resolved at its causal layer and downstream layers no longer compensate for it";
  }

  const lower = query.toLowerCase();

  if (isEnumLikeQuery(query)) {
    if (role === "contract") return "new value is present in exported contract and exhaustive initializers compile";
    if (role === "api") return "validation, transitions, search/repository, and aggregate maps handle the new value";
    if (role === "ui") return "visible UI paths can render/select/filter the new value";
    if (role === "style") return "matching token/class exists for the new value";
  }

  if (lower.includes("rename")) {
    return "old intentional name references are gone and tests/imports still resolve";
  }

  return "target behavior is covered for this surface";
}

/**
 * DESIGN-v0.8 §C1 item 2: the GENERIC role fallback for edit_intent/done_check
 * — what editIntentForRole/doneCheckForRole return for ANY role once the
 * query carries no enum-like or rename shape (their final, role-independent
 * `return`). Computed by calling the same functions with an empty query
 * rather than a hardcoded string literal, so this never drifts out of sync
 * if the fallback wording in editIntentForRole/doneCheckForRole ever changes.
 * `role` does not actually affect the generic-branch result, but is threaded
 * through anyway to mirror the real call shape exactly. `why` is
 * deliberately omitted (undefined) here — the generic fallback must stay
 * why-independent so the DESIGN-v0.8 §A6 exhaustive-initializer branch above
 * always differs from it and survives the `!==` comparison at both call
 * sites.
 */
export function genericEditIntent(role: string): string {
  return editIntentForRole("", role);
}

export function genericDoneCheck(role: string): string {
  return doneCheckForRole("", role);
}

/**
 * DESIGN-v0.8 §C1 item 1: a surface is PRIMARY when it is the first surface
 * in the pack or is marked `required`. Ensures surfaces[0] always carries
 * likely_edits even when nothing in the pack is required (a free-text query
 * with no enum/rename trigger words) — emission sites already build
 * likely_edits for `required` surfaces inline, so this only needs to
 * backfill the first-surface case they cannot see (each candidate is
 * converted independently, without visibility into final array position).
 * A no-op when surfaces[0] already has likely_edits (the common case: most
 * packs' first surface is also required).
 */
export function finalizePrimarySurface(surfaces: TaskPackSurface[]): void {
  const primary = surfaces[0];
  if (!primary || primary.likely_edits !== undefined) return;
  const hints = buildLikelyEdits(primary.role, primary.handle, primary.required ? 1 : 0.5);
  if (hints.length > 0) primary.likely_edits = hints;
}

/**
 * Cap on the number of advisory `checks` strings returned.
 * DESIGN-v0.8 coverage-honesty (Part 5): raised back to 3 — the structured
 * per-role records now carry machine-verifiable closure state (a style token
 * check, a search/filter text check), which is more than one line can hold
 * without losing the load-bearing distinctions. Each line is kept ≤120 chars.
 */
export const MAX_COMPLETION_CHECKS = 3;

/** Max characters per completion-check line (Part 5). */
export const MAX_CHECK_LINE_CHARS = 120;

/**
 * DESIGN-v0.8 coverage-honesty (Part 5): extract the enum's NEW-VALUE token(s)
 * from the query, generically. Uses the SAME all-caps enum-member shape the
 * locator's style-matching already keys on (`\b[A-Z][A-Z0-9_]{1,}\b`) — query
 * tokens ONLY, never fixture vocabulary. A query like "add a BLOCKED status"
 * yields ["BLOCKED"]; a query with no all-caps token yields [].
 */
export function extractEnumValueTokens(query: string): string[] {
  return [...new Set(query.match(/\b[A-Z][A-Z0-9_]{1,}\b/g) ?? [])];
}

/** The `--<kebab>` CSS-custom-property form of an enum value token (e.g. BLOCKED → "--blocked"). */
export function kebabTokenVariant(token: string): string | undefined {
  return deriveTokenVariants(token).find((v) => v.startsWith("--"));
}

/**
 * The MATCHER form of a style-check token: the kebab variant with a SINGLE
 * leading dash. Closure satisfaction is a raw substring test, and real
 * design systems namespace their custom properties — the 2026-07-11a live
 * stylesheet defines a namespaced form like `--color-level-low`, which `--low` can never match
 * (the double dash only exists at the property head), making the registered
 * check a PERMANENT false-negative. `-low` matches both the bare form
 * (`--low`) and any `--<namespace>-low` suffix; the leading dash keeps
 * `slow`/`flow`-style incidental words from satisfying it.
 */
export function kebabCheckToken(token: string): string | undefined {
  const kebab = kebabTokenVariant(token);
  return kebab === undefined ? undefined : kebab.replace(/^--/, "-");
}

/**
 * Immediate directory of the first api-role surface, if any — used to scope a
 * search/filter text-coverage check's glob to where the api surface lives
 * (e.g. "apps/api/src/routes"), so the check only inspects the relevant tree.
 * Returns undefined when no api surface is identifiable.
 */
export function apiSurfaceDir(surfaces: TaskPackSurface[]): string | undefined {
  const api = surfaces.find((s) => s.role === "api");
  if (!api) return undefined;
  const dir = path.dirname(api.path);
  return dir === "." ? undefined : dir;
}

/**
 * Concrete identifier tokens from a query, for the WIRING co-occurrence check,
 * in QUERY WORD ORDER (directionality: "feed A into B" → A precedes B). Uses
 * tokenizeQuery("identifier") — which splits camelCase/PascalCase and
 * snake_case/kebab-case — then keeps ONLY distinctive, identifier-shaped tokens
 * (an interior case transition, an underscore, or an all-caps ≥3 run), never
 * plain English words. This is the "both identifier tokens are concrete" guard:
 * a generic word like "health" alone would NOT qualify, but "isHealthy",
 * "NAV_LINK", or "onboard_pump_health" do.
 *
 * tokenizeQuery("identifier") sorts by distinctiveness (irrelevant here — we
 * need direction, not ranking), so tokens are RE-SORTED by first appearance in
 * the raw query. A split camelCase part (e.g. "Healthy" from "isHealthy") that
 * is a substring of a co-located whole token collapses to the whole token's
 * position, keeping compound identifiers as single ordered ends.
 *
 * W9 (2026-08-22): `query` is scrubbed of generic path spans FIRST. Without
 * it, a PascalCase-shaped path segment (a repo folder like "TokenLighten"
 * mentioned inside an absolute path in prose) passes the camelCase-interior
 * filter below and is treated as a "concrete" identifier — feeding both
 * concernAnchorTokens (via this function) and this function's OWN direct
 * callers (e.g. wiringConsumerNext's wiring-dead-end `find` derivation) a
 * token that names nothing in the repository.
 */
export function concreteIdentifierTokens(query: string): string[] {
  const cleaned = stripPathSpans("", query);
  const toks = tokenizeQuery(cleaned, { minLen: 4, stopWords: new Set<string>(), mode: "identifier" }).filter((t) =>
    /[a-z][A-Z]/.test(t) ||        // camelCase interior boundary
    /_/.test(t) ||                  // snake_case
    /^[A-Z0-9]{3,}$/.test(t),       // all-caps token (NAV_LINK, CRC)
  );
  const lowerQuery = cleaned.toLowerCase();
  const posOf = (t: string): number => {
    const i = lowerQuery.indexOf(t.toLowerCase());
    return i === -1 ? Number.MAX_SAFE_INTEGER : i;
  };
  return [...toks].sort((a, b) => posOf(a) - posOf(b));
}

/** Case- and underscore-insensitive normalization for token↔surface matching (matches closure-scan normalization). */
export function normIdent(s: string): string {
  return s.toLowerCase().replace(/_/g, "");
}

/**
 * Line window for a wiring co-occurrence check. Both identifiers must land in
 * ONE consumer file within this many lines of each other — wide enough to span
 * a typical read-then-encode block, tight enough that a mention in an unrelated
 * function does not count.
 */
export const WIRING_PROXIMITY_LINES = 25;

/**
 * Closure-hardening: emit AT MOST ONE two-token co-occurrence WIRING check when
 * the query names a source-side identifier and a destination-side identifier
 * belonging to two DISTINCT, DIFFERENT-ROLE files. Pairing is ROLE-AWARE, not
 * query-word-order (see WIRING_DEST_ROLE_RANK): the destination is always the
 * {api,ui}-role end. Each end resolves to a served pack surface when one
 * covers it, else — 2026-07-10b for the destination, 2026-07-12b for the
 * source too — to a workspace file found by basename under the identical
 * conservatisms (both endpoints can now be workspace-resolved at once; see
 * the mapped/fallback composition inside the function). The check binds
 * source→destination and scopes its glob to the DESTINATION file: the check
 * is satisfied only when that file contains BOTH identifiers within
 * WIRING_PROXIMITY_LINES lines — proving the source was actually wired into
 * the consumer, not merely mentioned somewhere.
 *
 * Conservative by construction: BOTH tokens must be concrete identifiers
 * (wiringCandidateTokens) AND each end must resolve UNIQUELY (a served
 * surface, or 1-3 in-family basename matches); never fabricated from generic
 * words, and a silent no-op unless a genuine cross-role pair exists. Prefers
 * the wiring surfaces augmentNativeWiringSurface already added (their
 * symbols/paths are in the surface set the matcher scans).
 */
/**
 * Index of the FIRST surface whose `symbol` or path basename contains the
 * normalized concrete token `tok`, or -1 when none matches. Factored out of
 * buildWiringCooccurrenceCheck so item 3's wiringConsumerNext maps tokens to
 * surfaces with the IDENTICAL predicate — the two must agree on which token is
 * "the dest surface" vs "an uncovered consumer".
 */
export function surfaceIndexForToken(tok: string, surfaces: TaskPackSurface[]): number {
  const nt = normIdent(tok);
  let bestIndex = -1;
  let bestRank = Number.POSITIVE_INFINITY;
  for (let index = 0; index < surfaces.length; index++) {
    const s = surfaces[index]!;
    const sym = s.symbol ? normIdent(s.symbol) : "";
    const base = normIdent(path.basename(s.path).replace(/\.[^.]+$/, ""));
    const body = relationCodeOnly(s.code ?? s.code_unchanged ?? "");
    const escaped = tok.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const bodyHasIdentifier = isWiringIdentifierShape(tok)
      && new RegExp(`\\b${escaped}\\b`).test(body);
    const callableDefinition = definedCallableNames(body)
      .some((name) => normIdent(name) === nt);
    const matches = (sym !== "" && sym.includes(nt))
      || (base !== "" && base.includes(nt))
      || (nt.includes(base) && base.length >= 4)
      || bodyHasIdentifier;
    if (!matches) continue;
    // A callable/symbol definition is stronger than a same-stem header, and
    // executable code is the useful insertion-side surface when both header
    // and implementation were seeded. This is structural and language/file
    // based; no subsystem vocabulary participates in the tie-break.
    const implementation = isImplementationPath(s.path);
    const rank = implementation && (sym === nt || callableDefinition)
      ? 0
      : implementation && bodyHasIdentifier
        ? 1
        : implementation && sym !== "" && sym.includes(nt)
          ? 2
          : implementation
            ? 3
            : sym === nt
              ? 4
              : bodyHasIdentifier
                ? 5
                : sym !== "" && sym.includes(nt)
                  ? 6
                  : 7;
    if (rank < bestRank) {
      bestRank = rank;
      bestIndex = index;
    }
  }
  return bestIndex;
}

/**
 * 2026-07-10c: candidate identifier pool for the wiring check. The shape-only
 * concreteIdentifierTokens filter starved the check to death in practice —
 * both live wiring queries yielded ZERO qualifying tokens (a 3-char acronym
 * like "PLL" dies on the shared minLen:4 cutoff before its ALL-CAPS shape is
 * even tested; a caps-run word like "PLLsync" has no lowercase→uppercase
 * transition; a hyphenated "link-status" fails the /_/ regex) — so
 * registration never happened and mode=closure stayed
 * the total:0 no-op. A query word is therefore ALSO concrete when the
 * WORKSPACE says so: its normalized form (lowercase, _- stripped) equals, or
 * is a >=3-char prefix of, a walked file's basename (PLL → pll.hpp,
 * PLLsync → pll_sync_driver.hpp). Grounding only ADMITS tokens into the
 * candidate pool — every downstream conservatism (source must map to a
 * served surface, destination must resolve uniquely, roles must differ, at
 * most one check) still applies unchanged. Ordered by query position,
 * deduped on normalized form, capped so the destination scan stays bounded.
 */
export const WIRING_TOKEN_POOL_CAP = 8;

export function isWiringIdentifierShape(token: string): boolean {
  return /^[A-Z][A-Z0-9_]{2,}$/.test(token)
    || /[_-]/.test(token)
    || /[a-z0-9][A-Z]/.test(token);
}

export function identifierVocabulary(value: string): string[] {
  const separated = value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_\-.\/]+/g, " ");
  return [value, ...separated.split(/\s+/)]
    .map((token) => token.toLowerCase().replace(/[^a-z0-9]/g, ""))
    .filter((token) => token.length >= 2);
}

export function observedRepositoryVocabulary(
  walkedRelPaths: ReadonlyArray<string>,
  surfaces: ReadonlyArray<TaskPackSurface>,
): Set<string> {
  const observed = new Set<string>();
  const add = (value: string): void => {
    for (const token of identifierVocabulary(value)) observed.add(token);
  };
  for (const relPath of walkedRelPaths) add(path.basename(relPath, path.extname(relPath)));
  for (const surface of surfaces) {
    if (surface.symbol) add(surface.symbol);
    const body = (surface.code ?? surface.code_unchanged ?? "").slice(0, 8192);
    for (const line of body.split(/\r?\n/).filter((candidate) =>
      /^\s*(?:import\b|#\s*include\b|use\b|from\b)/.test(candidate)
    ).slice(0, 24)) {
      for (const identifier of line.match(/[A-Za-z_$][A-Za-z0-9_$]*/g) ?? []) add(identifier);
    }
    for (const call of body.matchAll(/\b([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g)) {
      add(call[1]!);
    }
  }
  return observed;
}

/**
 * Emit-time invariant (2026-07-31 T13 rep0 forensics): a response that still
 * reports missing wiring endpoint(s) must either carry a concrete endpoint
 * sweep (a continuation/next_call whose purpose is "locate wiring …") or say
 * WHY none was planned. The silent coverage:"complete" +
 * "missing wiring endpoint(s): destination" contradiction — with a stopword
 * sweep or no sweep at all — is what pushed solvers off TL for the rest of
 * the cell. Runs at the finalizer because trim/reconcile can strip a sweep
 * planned earlier in the pipeline.
 */
export function annotateUnsweptWiringEndpoints(result: TaskPackResult): void {
  const wiring = result.wiring;
  if (wiring === undefined || wiring.missing.length === 0 || wiring.note !== undefined) return;
  const isSweep = (call: { tool?: unknown; arguments?: Record<string, unknown> } | undefined): boolean =>
    call?.tool === "tl_search_files"
    && (call.arguments?.["action"] === "find" || call.arguments?.["action"] === "references");
  const stages = result.continuation?.stages ?? [];
  const stageSweep = stages.some((stage) => (stage.calls ?? []).some((call) => isSweep(call)));
  const contractSweep = isSweep(
    result.execution_contract?.next_call as { tool?: unknown; arguments?: Record<string, unknown> } | undefined,
  );
  if (stageSweep || contractSweep) return;
  result.wiring = {
    ...wiring,
    note: "wiring endpoint(s) " + wiring.missing.join(",")
      + " not re-derived from this query (fully-served pack or no identifier-shaped endpoint token);"
      + " the route reflects what this pack served — previously served wiring surfaces stay authoritative",
  };
}

export function wiringCandidateTokens(
  query: string,
  walkedRelPaths: ReadonlyArray<string>,
  surfaces: ReadonlyArray<TaskPackSurface> = [],
): string[] {
  // W9 (2026-08-22): scrub generic path spans from `query` FIRST — this
  // function's `shapeConcrete` phase pools raw `.match()`/`tokenizeQuery()`
  // extractions directly, ungrounded against repository vocabulary (that
  // grounding only gates the SECOND, fallback phase below), so a path
  // segment mentioned in prose (e.g. a PascalCase repo folder name) could
  // otherwise be admitted straight into the wiring token pool and become a
  // `find`/`references` `next` for a wiring-source/consumer/insertion gap.
  const cleanedQuery = stripPathSpans("", query);
  const normHere = (s: string): string => s.toLowerCase().replace(/[_-]/g, "");
  const observed = observedRepositoryVocabulary(walkedRelPaths, surfaces);
  const grounded = (tok: string): boolean => {
    const nt = normHere(tok);
    if (nt.length < 3) return false;
    if (observed.has(nt)) return true;
    for (const candidate of observed) {
      if (candidate.startsWith(nt)) return true;
    }
    return false;
  };
  // Two-phase pool: whole shape-concrete identifiers first (the original,
  // highest-quality signal — camelCase/snake/ALLCAPS words the caller typed
  // as identifiers), then workspace-grounded extras. The grounded pass must
  // not admit camel-hump FRAGMENTS of tokens already in the pool: the
  // minLen:3 tokenizer emits both "encodeLinkStatus" and its "Link" fragment,
  // and "Link" grounds against a link_status basename — which silently
  // replaced the precise ["isLocked","encodeLinkStatus"] pair with
  // ["PLL","Link"]. A grounded candidate whose normalized form is a substring
  // of any pooled token is that token's fragment, not new information.
  const lowerQuery = cleanedQuery.toLowerCase();
  const posOf = (t: string): number => {
    const i = lowerQuery.indexOf(t.toLowerCase());
    return i === -1 ? Number.MAX_SAFE_INTEGER : i;
  };
  const seen = new Set<string>();
  const out: string[] = [];
  const admit = (tok: string): boolean => {
    const nt = normHere(tok);
    if (seen.has(nt)) return false;
    for (const existing of seen) {
      if (existing.includes(nt)) return false; // fragment of a pooled token
    }
    seen.add(nt);
    out.push(tok);
    return out.length >= WIRING_TOKEN_POOL_CAP;
  };
  const rawIdentifiers = cleanedQuery.match(/\b[A-Za-z_$][A-Za-z0-9_$-]*\b/g) ?? [];
  const shapeConcrete = [
    ...concreteIdentifierTokens(cleanedQuery),
    ...rawIdentifiers.filter(isWiringIdentifierShape),
  ].filter((token, index, all) =>
    all.findIndex((candidate) => normHere(candidate) === normHere(token)) === index
  ).sort((a, b) => posOf(a) - posOf(b));
  for (const tok of shapeConcrete) {
    if (admit(tok)) return out;
  }
  const raw = tokenizeQuery(cleanedQuery, { minLen: 3, stopWords: new Set<string>(), mode: "identifier" });
  for (const tok of [...raw].sort((a, b) => posOf(a) - posOf(b))) {
    if (!grounded(tok)) continue;
    if (admit(tok)) return out;
  }
  return out;
}

export interface ExplicitWiringRoles {
  source?: string;
  consumer?: string;
  adapter?: string;
}

/**
 * Extract directional roles only from explicit wiring grammar. Repository
 * validation still decides whether each token is a unique callable.
 */
export function explicitWiringRoles(query: string): ExplicitWiringRoles {
  const identifier = "([A-Za-z_$][A-Za-z0-9_$]*)";
  const wire = new RegExp(
    "\\bwire\\s+" + identifier + "[\\s\\S]*?\\binto\\s+" + identifier
      + "[\\s\\S]*?\\busing\\s+(?:the\\s+)?(?:existing\\s+)?" + identifier,
    "i",
  ).exec(query);
  if (wire !== null) {
    return { source: wire[1], consumer: wire[2], adapter: wire[3] };
  }
  const replace = new RegExp(
    "\\busing\\s+" + identifier + "[\\s\\S]*?\\bin\\s+" + identifier
      + "[\\s\\S]*?\\bfrom\\s+" + identifier,
    "i",
  ).exec(query);
  return replace === null
    ? {}
    : { adapter: replace[1], consumer: replace[2], source: replace[3] };
}

/** Destination-role DISCIPLINE for the wiring check (both branches).
 *
 * Preference order within the allowed set: api first, then ui (10c shape:
 * "… uplink PLLsync …" must pick the uplink task impl over the protocol header).
 *
 * HARD GATE (2026-07-11b): a destination outside {api, ui} does not
 * register at all. That run's inverted check — "the protocol signal must
 * reach the filter in its own definition header" — anchored the
 * destination on the moving signal's own DEFINITION file (domain role) and
 * rode 33 edit echoes without ever being closable; the integration layer
 * the wiring actually lands in was not
 * derivable from that query's tokens, and the honest outcome there is
 * SILENCE, not a born-dead check. Every legitimate registration observed
 * across runs/corpus has an api-layer destination (task-loop impls,
 * encoder impls, routers); ui covers presentation-destination
 * tasks. domain/contract/config/doc destinations are conservative
 * casualties by design. */
export const WIRING_DEST_ROLE_RANK: Record<string, number> = { api: 0, ui: 1 };

// 2026-08-07 (D3 fix): roles that must NEVER be treated as a wiring SOURCE,
// even though they are not {api,ui} destinations. Every per-function local
// `isDestRole` below is a NEGATIVE destination gate — config/data/domain/
// contract/unknown all pass `!isDestRole(role)`, which is correct for those
// roles (legitimate producer roles) but WRONG for "test"/"doc": a query that
// merely NAMES a real *.spec.ts or doc file (e.g. "make sure this does not
// break checkoutFlow.spec.ts") must not promote that file into a
// source-side wiring obligation just because it is not {api,ui}. Route
// every wiring SOURCE eligibility check through isEligibleWiringSourceRole —
// never re-add a bare `!isDestRole(...)` source check.
export const WIRING_SOURCE_INELIGIBLE_ROLES = new Set<string>(["test", "doc"]);

export function isEligibleWiringSourceRole(role: string): boolean {
  return WIRING_DEST_ROLE_RANK[role] === undefined && !WIRING_SOURCE_INELIGIBLE_ROLES.has(role);
}

export function structuralWiringDestinationRole(
  relPath: string,
  classified: ImpactSurface,
): ImpactSurface | undefined {
  if (WIRING_DEST_ROLE_RANK[classified] !== undefined) return classified;
  // A query-selected executable implementation can be the integration edge
  // even when its directory has an unseen project-specific name. This role
  // is local to wiring direction; classifySurface remains domain-agnostic.
  return classified === "unknown" && isImplementationPath(relPath) ? "api" : undefined;
}

export function structuralWiringSourceRole(
  relPath: string,
  classified: ImpactSurface,
  walked: ReadonlyArray<string>,
): ImpactSurface {
  if (classified !== "unknown" || !isImplementationPath(relPath)) return classified;
  const stem = path.basename(stripModuleExtension(relPath));
  const root = projectRootOf(relPath);
  const hasDeclarationSibling = walked.some((candidate) =>
    candidate !== relPath
    && path.basename(stripModuleExtension(candidate)) === stem
    && !isImplementationPath(candidate)
    && projectRootOf(candidate) === root
  );
  // A declaration+implementation pair is definition evidence. An otherwise
  // unclassified executable-only file is conservatively treated as the
  // integration side during workspace fallback.
  return hasDeclarationSibling ? "contract" : "api";
}

/**
 * One resolved end of a wiring pair, regardless of HOW it was resolved (a
 * served pack surface, or a workspace file found by basename) — the uniform
 * shape both the mapped-surface path and the two workspace-fallback paths
 * (destination: 2026-07-10b, source: 2026-07-12b) produce, so the pairing
 * logic downstream never needs to know which one supplied an endpoint.
 */
export type WiringEndpoint = { token: string; path: string; role: ImpactSurface };

/**
 * 2026-07-12b: resolve the SOURCE against the workspace when NO mapped token
 * qualifies as one — `mapped` is empty (neither end reached a served
 * surface: the live dir-seeded shape, e.g. a pack whose surfaces are
 * boot/init files and secondary headers, never the source or consumer module)
 * or every mapped token is ITSELF dest-role (a served api/ui surface exists
 * but nothing non-dest-role does — see bestMappedWiringDest). Mirrors
 * findWiringDestFallback with the two differences wiring direction demands:
 * EARLIEST-mentioned candidate token first (head-first — a source is
 * announced before its consumer in "feed A into B" phrasing; if that token
 * resolves to a dest-role file, it is not a valid source and the next
 * candidate is tried), and the role gate is INVERTED — source must NEVER be
 * {api,ui} (WIRING_DEST_ROLE_RANK; wiring direction is domain/contract/etc.
 * INTO the executable integration layer, never the reverse). A token already
 * tried as a mapped surface is skipped: in this branch that only ever means
 * it mapped to a dest-role surface, which would fail the role gate again.
 */
export function hasCallableDeclarationSibling(
  token: string,
  definitionPath: string,
  workspace: string,
  cache?: FileReadCache,
): boolean {
  const declarationStem = stripModuleExtension(definitionPath);
  return [
    `${declarationStem}.d.ts`,
    `${declarationStem}.d.mts`,
    `${declarationStem}.d.cts`,
    `${declarationStem}.d.tsx`,
  ].some((declarationPath) =>
    definedCallableNames(readCached(workspace, declarationPath, cache) ?? "")
      .some((name) => normIdent(name) === normIdent(token))
  );
}

/**
 * buildWiringCooccurrenceCheck's own return shape: PackCheckRecord (minus
 * `id`, assigned by buildCheckRecords' `push`) PLUS `sourceDir` — the SOURCE
 * endpoint's workspace-relative module directory. Consumed by
 * closureTracking.ts's wiringCheckSatisfied (2026-07-12b satisfaction
 * redesign: a wiring check now closes on a non-comment reference to the
 * source token OUTSIDE this directory, not on dest-file token proximity).
 *
 * `sourceDir` is intentionally NOT added to PackCheckRecord's own declaration
 * (session.ts is owned by a concurrent change this wave, so it is out of
 * scope here) — it rides through session.ts's recordPackChecks/
 * getPackChecks/_mergeCheckRecords as an ordinary extra object property (all
 * three are pass-through — `[...records]`, `byId.set(r.id, r)`, and a direct
 * return of the stored state — none reconstructs a record field-by-field),
 * and buildCheckRecords' `push` (below) forwards it via `{ id, ...r }`, which
 * TypeScript's excess-property check does not apply to (spread-derived
 * properties are exempt). `deriveCheckId` (session.ts) only reads
 * token/tokens/role/glob/desc off its argument, so this field changes NO
 * existing check id.
 */
export type WiringCheckDraft = Omit<PackCheckRecord, "id"> & { sourceDir: string };

/** `languageForPath` families where an absent `export` keyword reliably means "cannot be imported elsewhere" — every other language's own visibility rules are out of scope here. */
export const WIRING_EXPORT_AWARE_LANGS: ReadonlySet<string> = new Set([
  "typescript", "typescriptreact", "javascript", "javascriptreact",
]);

/**
 * W2A-2 (2026-08-21 wiring false-positive): is `token` — defined in
 * `definingPath` — ALREADY disqualified from a fresh "must be consumed
 * elsewhere" obligation, either because it is a TS/JS symbol with no
 * `export` anywhere in its own file (so no other module could ever import
 * it — the whole "consumed outside <dir>" framing is unsatisfiable by
 * construction) or because a workspace-wide literal scan already finds it
 * CALLED — `token(` — on some line that is not its own declaration?
 *
 * Repro: `bindTaskProfile`, a plain (non-`export`) helper private to
 * readCodeTaskPack.ts with 4 real in-file call sites, produced "wiring:
 * bindTaskProfile must be consumed in non-comment code outside
 * features/task-pack — e.g. in sentinelComment.ts" after an unrelated
 * one-line edit near its signature. The obligation-emission sites below only
 * ever consulted `surfaces`/`mapped` — the handful of files THIS pack
 * happened to have already served as evidence — never the repository at
 * large, so a private helper with every one of its real consumers outside
 * that small set reads as having none. This check is a genuine
 * workspace-wide answer instead.
 *
 * Deliberately narrow so it cannot re-suppress an existing true positive
 * (readCodeTaskPack.spec.ts's QKF/g_config wiring fixtures): the export
 * check only fires for TS/JS (a C++ class with no `export` keyword at all
 * must not be waved through), and the consumer check requires call syntax —
 * `Type.field`/`Type::method` access, a type annotation, or the symbol's own
 * `function token(`/`class token`/`const token =` declaration line never
 * qualifies. A scan that finds NEITHER disqualifying fact stays silent (the
 * caller keeps evaluating candidates, never a false "unconsumed" claim), and
 * a freshly added symbol with zero real call sites anywhere keeps its
 * obligation — the true-positive path this guard must not touch.
 */
export function wiringSourceAlreadyResolved(
  token: string,
  definingPath: string,
  workspace: string,
  cache?: FileReadCache,
  // W7 integration fix (2026-08-21): the destination path THIS check draft
  // is about to name as "where consumption is missing", when known. A call
  // site living there is not evidence the wiring is "already resolved
  // ELSEWHERE" — it IS the very connection this check exists to confirm (an
  // "answer"/"fix"-shaped wiring query about an EXISTING producer/consumer
  // relationship, e.g. "fix transmitPacket when sampleSignal returns the
  // wrong boolean", regressed to the weak query-token-only fallback because
  // sampleSignal's own call inside packet_sender.ts — the exact destination
  // this check would report — was counted as disqualifying "already
  // resolved" evidence). A call site in any OTHER file is unaffected and
  // still disqualifies, preserving the original W2A-2 fix intact.
  excludePath?: string,
): boolean {
  const definingLang = languageForPath(definingPath);
  if (definingLang === undefined || !WIRING_EXPORT_AWARE_LANGS.has(definingLang)) {
    // TS/JS only: `function foo(`/`class Foo`/`const foo =`/… reliably marks
    // a DECLARATION line, so a bare `token(` scan can subtract it and count
    // only real call sites. A C-family method has no such marker — an
    // out-of-class definition ("Type::method(") and a header prototype
    // ("returnType method();") both match `token(` with nothing comparably
    // reliable to exclude — so this guard stays silent for every other
    // language rather than misread a declaration/definition pair as
    // consumption (readCodeTaskPack.spec.ts's QKF/isHealthy C++ fixtures are
    // exactly that: a header declaration + one out-of-line definition, zero
    // real callers, and the obligation MUST still fire for them).
    return false;
  }
  const escaped = escapeRegExp(token);
  const definingText = readCached(workspace, definingPath, cache);
  if (definingText !== undefined) {
    const exportedPattern = new RegExp(
      `export\\s+(?:default\\s+)?(?:declare\\s+)?(?:async\\s+)?`
        + `(?:function\\*?|class|const|let|var|interface|type|enum|namespace)\\s+${escaped}\\b`
        + `|export\\s*\\{[^}]*\\b${escaped}\\b[^}]*\\}`,
    );
    if (!exportedPattern.test(definingText)) return true;
  }
  const declarationShape = new RegExp(
    `\\b(?:function\\*?|class|interface|type|enum|namespace|const|let|var)\\s+${escaped}\\b`,
  );
  const callShape = new RegExp(`\\b${escaped}\\s*\\(`);
  const matches = scanLiteral(token, workspace, { caseInsensitive: false });
  return matches.some((match) =>
    match.path !== excludePath
      && typeof match.text === "string"
      && callShape.test(match.text)
      && !declarationShape.test(match.text),
  );
}
