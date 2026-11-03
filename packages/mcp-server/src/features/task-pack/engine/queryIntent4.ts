// queryIntent — extracted implementation; imports point to the owning modules.
import * as fs from "fs";
import * as path from "path";
import type { NamedCallableDefinitions } from "./queryIntent3.js";
import type { TaskPackArgs } from "../model.js";
import type { TaskPackResult } from "../model.js";
import type { TaskPackSurface } from "../model.js";
import type { UnreadableNamedPathProvenance } from "./queryIntent3.js";
import { CONCERN_NOISE_WORDS } from "./roleAndConcernScope2.js";
import { CREATE_TARGET_EXT_RE } from "./createAndWiringEndpoints2.js";
import { FileReadCache } from "./packBasics2.js";
import { HIGH_CONFIDENCE_THRESHOLD } from "./packBasics2.js";
import { READINESS_PROBE_MAX_BYTES } from "./changeAndReadinessEvidence2.js";
import { READINESS_PROBE_MAX_FILES } from "./changeAndReadinessEvidence2.js";
import { candidateToSurface } from "./surfaceMaterialization.js";
import { capitalizationNamesSubject } from "../requestItems.js";
import { concernTokenMatchesSurface } from "./roleAndConcernScope3.js";
import { escapeRegExp } from "../../search/find/findText.js";
import { explicitCodeIdentifiers } from "./anchorFocus2.js";
import { filesNamedByPathToken } from "./queryIntent3.js";
import { hasHashComments } from "../callerExpansion.js";
import { hasServedCode } from "./wiringEvidence2.js";
import { isImplementationPath } from "./changeAndReadinessEvidence2.js";
import { languageForPath } from "../../../util/languages.js";
import { normIdent } from "./createAndWiringEndpoints2.js";
import { queryNamedPathTokens } from "./queryIntent3.js";
import { readCached } from "./packBasics2.js";
import { relationCodeOnly } from "./wiringEvidence3.js";
import { scanLiteral } from "../../search/find/findText.js";
import { symbolIsCallable } from "./focalFlow.js";
import { unqualifiedSymbolTail } from "./anchorFocus3.js";
import { unreadableNamedPathStorage } from "./queryIntent3.js";
import { walkCodeFiles } from "../../../tools/walkRepo.js";
import { walkedFilesForQueryNamedResolution } from "./queryIntent3.js";

/**
 * The implementation files that define the first callable `query` names
 * explicitly (`explicitCodeIdentifiers`) which `relPath` defines: `relPath`
 * first, then the others. Two packages that both define `Sum` leave a bare
 * `Sum` ambiguous.
 *
 * `complete` is false past the readiness probe's own budgets
 * (`READINESS_PROBE_MAX_FILES` / `_BYTES`) or for an unreadable file, so a
 * caller never reads "unique" into a probe that stopped early. The definition
 * test is the name's own (`definedCallableNames`' two shapes, not that
 * helper's first-twelve-names list); a method of that name or a call before a
 * block also satisfies it, which only withholds a uniqueness claim.
 */
export async function namedCallableDefinitions(
  query: string,
  workspace: string,
  relPath: string,
  cache: FileReadCache,
): Promise<NamedCallableDefinitions | undefined> {
  const content = readCached(workspace, relPath, cache);
  if (content === undefined) return undefined;
  // A prose-cased name ("Fix Sum so …") is no explicit identifier, but a
  // callable of the located file spelled exactly so in the middle of a clause
  // is the one the request means (`editContextCandidates`' `spelled` rule;
  // requestItems.ts's `capitalizationNamesSubject` keeps a sentence's opening
  // verb, "Add a check …", out).
  const lang = languageForPath(relPath);
  const lines = content.split(/\r?\n/);
  const spelled = lang === undefined ? [] : ((await cache.parsedSymbols(content, lang, relPath)) ?? [])
    .filter((symbol) => symbolIsCallable(symbol, lines, hasHashComments(relPath)))
    .map((symbol) => unqualifiedSymbolTail(symbol.name))
    .filter((name) => name.length >= 3
      && new RegExp(`(?<![A-Za-z0-9_$])${escapeRegExp(name)}(?![A-Za-z0-9_$])`).test(query)
      && capitalizationNamesSubject(name, query));
  for (const identifier of [...new Set([...explicitCodeIdentifiers(query), ...spelled])].slice(0, 4)) {
    const escaped = identifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const defines = new RegExp(
      `\\b(?:def|fn|func|function)\\s+${escaped}\\s*\\(|(?<![A-Za-z0-9_$.])${escaped}\\s*\\([^;{}]*\\)\\s*(?:const\\s*)?\\{`,
    );
    if (!defines.test(relationCodeOnly(content))) continue;
    let mentioning: string[];
    try {
      mentioning = [...new Set(scanLiteral(identifier, workspace, { caseInsensitive: false }).map((match) => match.path))]
        .filter((candidate) => candidate !== relPath && isImplementationPath(candidate));
    } catch {
      return { identifier, paths: [relPath], complete: false };
    }
    const paths = [relPath];
    let complete = mentioning.length < READINESS_PROBE_MAX_FILES;
    let bytes = 0;
    for (const other of mentioning.slice(0, READINESS_PROBE_MAX_FILES)) {
      const text = readCached(workspace, other, cache);
      if (text === undefined) {
        complete = false;
        continue;
      }
      bytes += Buffer.byteLength(text, "utf8");
      if (bytes > READINESS_PROBE_MAX_BYTES) {
        complete = false;
        break;
      }
      if (defines.test(relationCodeOnly(text))) paths.push(other);
    }
    return { identifier, paths, complete };
  }
  return undefined;
}

/** How many other files defining the named callable are served beside the located one. */
export const MAX_SAME_NAME_DEFINITION_CANDIDATES = 3;

export const SAME_NAME_DEFINITION_MAX_WINDOW_BYTES = 2_000;

/**
 * Serves each other file whose PARSED symbols declare the named callable as a
 * candidate of the pack's choice (`why: "same-name definition: <name>"`), and
 * drops the located file's edit context, which belongs to one of the choices.
 * A file whose spelling only looked like a definition (a call before a block)
 * is no candidate.
 */
export async function addSameNameDefinitionCandidates(
  surfaces: TaskPackSurface[],
  definitions: NamedCallableDefinitions,
  workspace: string,
  requiredRoles: string[],
  query: string,
  cache: FileReadCache,
): Promise<void> {
  const added: TaskPackSurface[] = [];
  for (const other of definitions.paths.slice(1)) {
    if (added.length >= MAX_SAME_NAME_DEFINITION_CANDIDATES) break;
    if (surfaces.some((surface) => surface.path === other && !String(surface.why ?? "").startsWith("edit-context:"))) continue;
    const content = readCached(workspace, other, cache);
    const lang = languageForPath(other);
    if (content === undefined || lang === undefined) continue;
    const lines = content.split(/\r?\n/);
    const symbol = ((await cache.parsedSymbols(content, lang, other)) ?? []).find((entry) =>
      unqualifiedSymbolTail(entry.name) === definitions.identifier && symbolIsCallable(entry, lines, hasHashComments(other)));
    if (symbol === undefined) continue;
    if (Buffer.byteLength(lines.slice(symbol.startLine - 1, symbol.endLine).join("\n"), "utf8") > SAME_NAME_DEFINITION_MAX_WINDOW_BYTES) continue;
    const surface = await candidateToSurface({
      path: other, line: symbol.startLine, range: `${symbol.startLine}-${symbol.endLine}`, callerRange: true,
      symbol: definitions.identifier, surface: "unknown", why: `same-name definition: ${definitions.identifier}`,
      confidence: Math.max(HIGH_CONFIDENCE_THRESHOLD, 0.9), required: true,
    }, workspace, requiredRoles, query, cache);
    if (!hasServedCode(surface)) continue;
    added.push(surface);
  }
  if (added.length === 0) return;
  for (let index = surfaces.length - 1; index >= 0; index--) {
    if (String(surfaces[index]!.why ?? "").startsWith("edit-context:")) surfaces.splice(index, 1);
  }
  surfaces.push(...added);
}

/**
 * v0.15.1 runtime review TL-REVIEW-3: true when one of `query`'s path tokens
 * names `relPath` and no other workspace file. A bare basename two project
 * roots share (`a/http.ts`, `b/http.ts`) names neither uniquely, so a
 * question carrying it keeps whatever coverage the locator gave it.
 */
export function queryNamesWorkspaceFileUniquely(query: string, workspace: string, relPath: string): boolean {
  const tokens = queryNamedPathTokens(query);
  if (tokens.length === 0) return false;
  const walked = walkedFilesForQueryNamedResolution(workspace, false);
  return tokens.some((token) => {
    const named = filesNamedByPathToken(token, walked, query);
    return named.length === 1 && named[0] === relPath;
  });
}

/** BLOCKER 25: this call's unreadable files, deterministically ordered. */
export function unreadableNamedPathRows(): Array<{
  path: string;
  reason: "unreadable" | "undecodable";
  provenance: UnreadableNamedPathProvenance;
}> {
  const store = unreadableNamedPathStorage.getStore();
  if (store === undefined || store.size === 0) return [];
  return [...store.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([relPath, row]) => ({ path: relPath, reason: row.reason, provenance: row.provenance }));
}

/**
 * BLOCKER 25: the `result.missing` row spelling — one vocabulary, parsed by
 * `canonicalDecision.ts`'s `parseLedgerMissingRow`.
 *
 * Exported (SHOULD-FIX 32, 2026-09-14) only so `readCodeTaskPack.spec.ts` can
 * pin `parseUnreadableNamedPathRow`'s round trip against this exact prefix.
 */
export const UNREADABLE_NAMED_PATH_PREFIX = "unreadable-named-path:";

/**
 * BLOCKER 62 (AC1, 2026-09-14, review round 12) — the `result.missing` spelling
 * for "this request asks to change a file this release cannot write".
 *
 * Same producer/parser discipline as `UNREADABLE_NAMED_PATH_PREFIX`: minted only
 * here, parsed only by `canonicalDecision.ts`'s `parseLedgerMissingRow`. Round 11
 * measured `act.edit` + a writable frontier over a NUL-STRIPPED file whose edit
 * `detectWriteEncodingRisk` refuses unconditionally, with `retry:"call"` and no
 * `edits[]` shape that can succeed. `writeAuthorityVeto` now declines the
 * authority; this is the other half the mandate requires — the response SAYS
 * why, instead of silently degrading to a frontier-less `await_input`.
 */
export const UNWRITABLE_ENCODING_RISK_PREFIX = "unwritable-encoding-risk:";

/**
 * TL142-05 (2026-09-13): size cap, documented constant. When the request
 * names explicit path(s), the report's own acceptance bound is "total
 * `content[0].text` ≤ 1.25 × the two named files' byte sizes" — this is the
 * server-side proxy for that bound (the response's OWN serialization
 * overhead is outside this function's reach; capping surface CODE bytes,
 * which dominate response size, against the SAME 1.25x multiplier is the
 * enforceable half of it). Runs LAST, after every other extra-evidence gate
 * (the relation gate above, the counterexample relation gate in
 * runInternalReadinessFalsification, and the post-trim import/anchor
 * augmenters) — a defensive numeric backstop, not a substitute for the
 * qualitative relation checks: a RELATION-VERIFIED extra can still be capped
 * here if the named files alone are small and the extra is large. Fails
 * toward dropping the extra evidence: never removes a named-path surface,
 * and never removes a `required` surface (a different mechanism already
 * decided that one is essential — e.g. this same wave's own named-path
 * `required:true` stamp, or augmentExplicitAnswerImportSurfaces' own). A
 * no-op when the query names no explicit path, matching every other
 * TL142-05 gate's scope. Answer-profile only (called from
 * buildAnswerTaskPack): an edit-shaped query names its target file just as
 * routinely, and that profile's import-neighbour/sibling augmentation serves
 * a real, separately-tested safety purpose this report never asked to
 * constrain.
 *
 * C26 (chip wave, 2026-09-14): the drop order is WEAKEST-RELATION FIRST
 * (see RELATION_VERIFIED_EXTRA_WHY_RE below), not merely last-in-`surfaces[]`
 * first — a relation-VERIFIED extra (an import/call/config/test relation
 * `statedRelationToNamedPath` already proved, stamped onto `why` by the
 * relation gate above or by `runInternalReadinessFalsification`'s
 * counterexample gate) must survive over a bare/lexical extra purely because
 * of where it happened to land in the array. Exported so this drop order can
 * be pinned directly — see readCodeTaskPack.spec.ts's
 * "capExtraEvidenceRelativeToNamedPaths: drop order" describe.
 *
 * WP-B (eval-0929 §5, 2026-09-29): `keep` is the third "a different mechanism
 * already decided that one is essential" exemption, beside named paths and
 * `required`. This cap runs AFTER the certificate was minted, so a surface
 * that carries evidence the certificate cites (a value/condition window the
 * facet gate required, the last surface showing a certified identifier) is
 * not incidental: removing it shipped "In src/policy.ts, explain … the actual
 * values in TRANSIENT_CODES" as `act.answer` with the value surface gone. A
 * path named in the question is the answer's FOCUS, never a constraint that
 * cuts the dependencies the answer needs — so the pack may stay over the 1.25x
 * bound by exactly that evidence. `buildAnswerTaskPack` passes the predicate
 * (`certificateWireInvariant.ts`'s `wouldIntroduceBreach`); omitted, the drop
 * order is exactly C26's.
 */
export const EXTRA_EVIDENCE_NAMED_PATH_CAP_MULTIPLIER = 1.25;

/**
 * Matches the exact relation-verb prefixes `statedRelationToNamedPath` can
 * return ("imports "/"is imported by "/"calls "/"is called by "/"config
 * declares "/"test references "), which both its call sites stamp onto
 * `surf.why` verbatim (only the trailing "(...)" tag differs between the two
 * call sites) — C26's relevance signal for the drop order below.
 */
export const RELATION_VERIFIED_EXTRA_WHY_RE = /^(?:imports |is imported by |calls |is called by |config declares |test references )/;

// ---------------------------------------------------------------------------
// Item 4 (create-target note): the task may genuinely require a NEW file,
// not an edit to an existing one. Conservative and honest by construction —
// never fabricates a path, only reports that nothing existing names the
// token.
// ---------------------------------------------------------------------------

/** Minimum length for a query token to be considered a plausible module/file name (see moduleShapedQueryTokens). */
export const MODULE_TOKEN_MIN_LEN = 6;

/**
 * Whole (never fragmented) snake_case/camelCase identifier-shaped tokens
 * from `query`, length >= MODULE_TOKEN_MIN_LEN, excluding CONCERN_NOISE_WORDS
 * (generic dev nouns like "wiring"/"task"/"file" must not be mistaken for an
 * intended module name). Deliberately whole-word only (unlike
 * tokenizeQuery's "identifier" mode, which also emits camelCase/snake_case
 * FRAGMENTS) — a fragment like "Estimator" out of "positionEstimator" is a
 * weaker, less precise signal than the compound identifier itself, and this
 * note's whole point is to name the ONE token that plausibly IS a file/module
 * name. Order-preserving, deduped case-insensitively.
 */
export function moduleShapedQueryTokens(query: string): string[] {
  const words = query.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const w of words) {
    if (w.length < MODULE_TOKEN_MIN_LEN) continue;
    if (!(/_/.test(w) || /[a-z][A-Z]/.test(w))) continue; // snake_case, camelCase, or PascalCase
    const key = w.toLowerCase();
    if (CONCERN_NOISE_WORDS.has(key) || seen.has(key)) continue;
    seen.add(key);
    out.push(w);
  }
  return out;
}

/**
 * True when `token` names neither an existing surface (path/symbol —
 * concernTokenMatchesSurface, the same match rule the concern-token gate
 * already uses) NOR appears inside any served surface's ALREADY-READ
 * embedded code. The `code` check is deliberately included here (unlike
 * concernTokenMatchesSurface's own callers, which stay path/symbol-only to
 * avoid over-loose coverage GATING) — this is a purely advisory note, so the
 * extra check only makes it MORE conservative (fewer false "go create a new
 * module" suggestions when the concept already exists inside a broader file).
 */
export function tokenAbsentFromSurfaces(token: string, surfaces: TaskPackSurface[]): boolean {
  const lowerToken = token.toLowerCase();
  const nt = normIdent(token);
  return !surfaces.some(
    (s) => concernTokenMatchesSurface(lowerToken, s) || (s.code !== undefined && normIdent(s.code).includes(nt)),
  );
}

/**
 * Item 4: when a module-shaped query token matches NEITHER a walked file's
 * basename/stem ANYWHERE in the workspace (deliberately unconfined —
 * confining the "does this exist at all" check to the pack's own scope would
 * risk a false "create a new module" note for a file that genuinely exists
 * just outside that scope, which is not an honest claim) NOR any served
 * surface, the task may require creating a new module. Bounded to at most
 * one note — the longest qualifying token, the strongest single signal —
 * and never fabricates a path in the CREATE case. 2026-07-12d: before
 * settling on "create", the same unconfined discipline is applied to a
 * cheap workspace-wide literal-content probe (scanLiteral) — a token whose
 * SYMBOL already exists in a differently-named file yields an honest
 * redirect note instead (see the function body for both shapes).
 */
export function buildCreateTargetNote(query: string, surfaces: TaskPackSurface[], workspace: string): string | undefined {
  const candidates = moduleShapedQueryTokens(query);
  if (candidates.length === 0) return undefined;

  const walkedStems = walkCodeFiles(workspace, {}).map((f) =>
    normIdent(path.basename(f.relPath).replace(/\.[^.]+$/, "")),
  );
  const unmatched = candidates.filter((token) => {
    const nt = normIdent(token);
    if (walkedStems.some((stem) => stem.includes(nt))) return false;
    return tokenAbsentFromSurfaces(token, surfaces);
  });
  if (unmatched.length === 0) return undefined;

  const longest = [...unmatched].sort((a, b) => b.length - a.length)[0]!;

  // 2026-07-12d create-note strengthening: a token absent from file
  // BASENAMES and from the pack's own surfaces may still be a real symbol
  // living in a DIFFERENTLY-NAMED file (query names "calculatePriceEstimate"
  // but the function actually lives in pricing.ts) — suggesting "create a
  // new module" there is actively wrong, worse than no note at all. Reuse
  // scanLiteral (the same bounded, already-imported content-probe the
  // find/closure paths use) as a cheap whole-workspace grep for the token's
  // literal text — a symbol definition necessarily contains its own name, so
  // a text hit is a reliable (if slightly over-inclusive) stand-in for "the
  // symbol exists here" without paying for a full parse/skeleton pass.
  // Surfaces already IN the pack are excluded from the hit set — the agent
  // already holds a handle for those, a redirect note would be noise.
  const surfacePaths = new Set(surfaces.map((s) => s.path));
  const contentHits = scanLiteral(longest, workspace, { caseInsensitive: true })
    .map((m) => m.path)
    .filter((p) => !surfacePaths.has(p));
  if (contentHits.length > 0) {
    const nearest = [...new Set(contentHits)].sort(
      (a, b) => a.length - b.length || (a < b ? -1 : 1),
    )[0]!;
    return `"${longest}" exists in ${nearest} — likely extend it rather than create a new module`;
  }

  return `no existing file matches "${longest}" — the task may require creating a new module`;
}

export function resolveExplicitArtifactCreateTarget(
  args: TaskPackArgs,
  query: string,
  workspace: string,
): TaskPackResult["create_target"] {
  const match = query.match(
    /([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*\/)\s*(?:に|へ|under\b|in\b|at\b|to\b)\s*([A-Za-z_$][A-Za-z0-9_$.-]*\.(?:c|cc|cpp|cxx|go|java|js|jsx|py|rs|ts|tsx))/i,
  );
  if (!match) return undefined;
  const requestedDir = match[1]!.replace(/^\.\//, "").replace(/\/$/, "");
  const fileName = path.posix.basename(match[2]!);
  const scopedFiles = walkCodeFiles(workspace, args.path ? { subPath: args.path } : {});
  const matchingDirs = [...new Set(scopedFiles
    .map((file) => path.posix.dirname(file.relPath))
    .filter((directory) => directory === requestedDir || directory.endsWith(`/${requestedDir}`)))];
  if (matchingDirs.length !== 1) return undefined;
  const directory = matchingDirs[0]!;
  const targetPath = path.posix.join(directory, fileName);
  if (fs.existsSync(path.join(workspace, targetPath))) return undefined;
  const directoryEvidence = scopedFiles
    .map((file) => file.relPath)
    .filter((filePath) => path.posix.dirname(filePath) === directory)
    .sort()
    .slice(0, 3);
  if (directoryEvidence.length === 0) return undefined;
  return { path: targetPath, directory_evidence: directoryEvidence };
}

/**
 * W3 (turn-economy wave 2): does the query express intent to CREATE a new file
 * (a real create verb + a file-shaped noun)? Deliberately conservative — bare
 * "new" is excluded (it appears in "new value"/"new behavior"); a create verb
 * must co-occur with a file noun, OR the JA create markers with a file noun.
 */
export const CREATE_FILE_VERB_EN_RE = /\b(?:add|create|write|introduce|generate|scaffold|author|make)\b/i;

export const CREATE_FILE_NOUN_EN_RE = /\b(?:new\s+)?(?:file|module|test|tests|spec|script|component|fixture|migration|stub)\b/i;

export const CREATE_FILE_JA_RE = /(?:作成|新規|新し[いく]|新た(?:に|な)|追加)/;

export const CREATE_FILE_NOUN_JA_RE = /(?:ファイル|モジュール|テスト|クラス|スクリプト|フィクスチャ)/;

/**
 * Review finding 4 (2026-09-08, v0.14.1 hands-on report follow-up):
 * `hasCreateFileIntent`'s extension-path alternative (below) is a STRONG
 * "this is a file" signal only when the named path is not already a real
 * file in the workspace — "Add error handling to src/cache.ts. Current
 * code: ```…```" names an EXISTING path, so it is an ordinary edit, not a
 * create, and must not satisfy the gate that strips the query's pasted
 * fenced code (the strongest locating signal it carries) before locating.
 * The strict noun form (`CREATE_FILE_NOUN_EN_RE`) is unaffected by this —
 * it keeps firing regardless of existence, exactly as before.
 *
 * Fails OPEN (every extension token counts, exactly the pre-fix behaviour)
 * when `workspace` is omitted, so every caller that does not pass one is
 * byte-for-byte unaffected: `resolveCreateTargetFromQuery`'s Path 1 already
 * re-validates existence itself per matched candidate (`fs.existsSync`
 * right in its own loop), and `hasCreateOrPlacementIntent` never had an
 * existence check at all. Only `queryNamesCreateTarget` — the gate
 * `buildTaskPackCore` uses to decide whether to strip fenced blocks —
 * passes a real `workspace` through.
 */
export function queryNamesAbsentCreateExtension(query: string, workspace: string | undefined): boolean {
  const matches = query.match(CREATE_TARGET_EXT_RE);
  if (matches === null) return false;
  if (workspace === undefined) return true;
  return matches.some((raw) => !fs.existsSync(path.join(workspace, raw.replace(/^\.\//, ""))));
}

export function hasCreateFileIntent(query: string, workspace?: string): boolean {
  // P2-3(2) (hands-on report, 2026-09): an explicit, extensioned path
  // ("src/answer.ts") is a STRONGER "this is a file" signal than any of the
  // generic nouns below — "Create src/answer.ts with the content: ..." names
  // its target unambiguously without ever saying the word "file". Additive
  // only: every query that already satisfied the noun gate is unaffected;
  // this only flips currently-false cases where an extensioned path is
  // already present and (per review finding 4, when `workspace` is known)
  // that path does not already exist. CREATE_TARGET_EXT_RE carries the /g
  // flag, so `queryNamesAbsentCreateExtension` uses `.match()` (always
  // resets lastIndex), never `.test()`, per that regex's own documented
  // convention (see queryNamesCreateTarget's comment below).
  const en = CREATE_FILE_VERB_EN_RE.test(query)
    && (CREATE_FILE_NOUN_EN_RE.test(query) || queryNamesAbsentCreateExtension(query, workspace));
  const ja = CREATE_FILE_JA_RE.test(query) && CREATE_FILE_NOUN_JA_RE.test(query);
  return en || ja;
}

/**
 * turn-economy wave 3 (V1): create OR PLACEMENT intent — broader than
 * hasCreateFileIntent. Also fires on a placement question ("where should X
 * live/go/belong", "where to put X") and on a bare create verb or "new". This
 * looser gate is used ONLY for the STRUCTURALLY-verified dotted-module /
 * extension-less create-target resolution below, whose parent-directory-exists +
 * target-absent + not-an-existing-dir checks are the real safety net — so the
 * gate's job is merely to exclude a pure explain/answer query, not to carry the
 * confidence alone (unlike the prose-extension Path 1, which keeps the stricter
 * verb+noun gate to avoid firing on incidental filenames in explanatory prose).
 */
export const CREATE_OR_PLACEMENT_EN_RE =
  /\bwhere\s+(?:should|shall|does|do|to|would|is|are|can|will|might)\b|\b(?:new|add|create|introduce|scaffold|author|generate|write|make|place|put|host|home|belongs?|resides?|lives?|goes?)\b/i;
