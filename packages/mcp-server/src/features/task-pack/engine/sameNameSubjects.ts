// sameNameSubjects — extracted implementation; imports point to the owning modules.
import * as path from "path";
import type { ContinuationCall } from "./packBasics.js";
import type { ExplicitIdentifierAbsence } from "./identifierAbsence2.js";
import type { ImpactCandidate } from "@tokenlighten/types";
import type { ImportSpecifier } from "../evidenceClosure.js";
import type { RankedAnswerEvidenceCandidate } from "./roleAndConcernScope3.js";
import type { TaskPackArgs } from "../model.js";
import type { TaskPackResult } from "../model.js";
import type { TaskPackSurface } from "../model.js";
import type { TaskReadinessObligation } from "@tokenlighten/types";
import { CALLER_EXPANSION_TYPE_KINDS } from "./callerExpansion2.js";
import { FileReadCache } from "./packBasics2.js";
import { MAX_SAME_NAME_CANDIDATES } from "./callableResolution2.js";
import { asksForStructureMap } from "../structureMap.js";
import { capWords } from "./requestItemAbsence2.js";
import { classifyCommentLines } from "../../../util/lineClassify.js";
import { classifySurface } from "../../../util/impact.js";
import { codePortionOfLine } from "./seedAdmission.js";
import { codeTaskPackSurfaces } from "../artifactSections.js";
import { commentSyntaxIsKnown } from "../../../util/lineClassify.js";
import { commentSyntaxLanguageForPath } from "../../../util/lineClassify.js";
import { containsWholeIdentifier } from "../wholeIdentifier.js";
import { declarationHeaderLine } from "./focalFlow.js";
import { epochServedEvidence } from "./epochContract2.js";
import { explicitCodeIdentifiers } from "./anchorFocus2.js";
import { extractFacetRequirements } from "./packBasics2.js";
import { filesNamedByPathToken } from "./queryIntent3.js";
import { goImportPathAliasesIn } from "../evidenceClosure.js";
import { hasHashComments } from "../callerExpansion.js";
import { hasServedCode } from "./wiringEvidence2.js";
import { importSpecifiersNaming } from "../evidenceClosure.js";
import { isDeclarationShapedMatchText } from "./callableResolution4.js";
import { isGoLanguage } from "../callerExpansion.js";
import { isTestConcernPath } from "./literalAndConcernSeeds.js";
import { languageForPath } from "../../../util/languages.js";
import { languageForPathWithContent } from "../../../util/languages.js";
import { mentionExplainedByImportExportLine } from "./callerExpansion2.js";
import { packHeldToCeilingWithoutPreview } from "./answerPackBuilder3.js";
import { pathClassCanCarryCode } from "./seedAdmission.js";
import { queryNamedPathTokens } from "./queryIntent3.js";
import { queryNamedWorkspaceFiles } from "./queryIntent3.js";
import { queryNamedWorkspaceFilesKeepingSharedBasenames } from "./queryIntent3.js";
import { readCached } from "./packBasics2.js";
import { readinessEvidence } from "./changeAndReadinessEvidence2.js";
import { resolveImportSpecifierFile } from "./callableResolution4.js";
import { scanLiteral } from "../../search/find/findText.js";
import { servedSurfaceText } from "./changeAndReadinessEvidence2.js";
import { surfaceBodyCoversRange } from "./seedResolution.js";
import { tokenizeForEpoch } from "../../../state/session.js";
import { unqualifiedSymbolTail } from "./anchorFocus3.js";
import { walkedFilesForQueryNamedResolution } from "./queryIntent3.js";
import { wholeIdentifierOffsets } from "../wholeIdentifier.js";
import { wholeIdentifierOnHitLine } from "./identifierAbsence2.js";

// ---------------------------------------------------------------------------
// WP-O (eval-0929 §8, 2026-09-29) — "EXPLAIN X" IS ANSWERED FROM X'S OWN
// DECLARATION — THE ONE THE QUESTION MEANS WHEN X IS DECLARED IN SEVERAL
// FILES — AND NEVER FROM X'S CALL SITES.
//
// Measured (v0.14.4 and this wave's tree, byte-identical): "Explain
// checkQuota's expiry check." over a workspace declaring `checkQuota` in
// `src/auth.ts` AND in an unrelated `src/legacy.ts`, with forty handler files
// calling it, ended in `act.answer` on its second hop with
// `identifier:checkQuota` (+ `analysis-source` / `behavior-body`) proved and
// no gap — the evidence was three CALL SITES; neither declaration's body ever
// reached the client. Two arms, both pre-existing:
//  (A) the FIRST pack — `recoverExplicitIdentifierAnswerCandidates`' guard
//      gives up whenever its definition-shaped hits span != 1 file: a genuine
//      second declaration, but equally a caller whose line merely carries a
//      declaration keyword before the call (`const r = X(...)`, which that
//      function's keyword-anywhere test reads as "definition-shaped"), so a
//      SINGLE declaration met the same fate. The pack then fell back to the
//      locator's call-site candidates, and its `discover` re-packed exactly
//      those call sites;
//  (B) EVERY pack — `identifier:X` is proved by any served occurrence of X
//      (`exactIdentifierEvidence`), so the re-pack of three call sites
//      certified the explain question.
//
// THE RULE. For a question whose subject is an explicitly named X (explain /
// how / why / what does X do / X's value or condition — anything but a
// usage-only question, `usageOnlyExplicitIdentifiers`), `act.answer` needs X's
// OWN declaration on the wire. When X is declared in >= 2 FILES, the
// declaration the question means is bound by evidence in WP-F's order
// (`findDeclaredCallableAmong`): (a) a file the request names (a path in the
// question, `args.path`, a caller-supplied target) that declares X; (b) an
// import relation — from a named file / target, else from X's callers, which
// must ALL resolve to the same declaring file (a caller of each is "callers of
// both", never a vote); (c) the same file as another subject of the question.
// Otherwise the question is AMBIGUOUS: every declaration (bounded) is served
// and the ambiguity is disclosed by name (X and the declaring files). A call
// site or mention of X never proves `identifier:X`, `behavior-body` or
// `analysis-source` for such a subject.
//
// SCOPE — byte-identical elsewhere. X declared in ONE file keeps today's
// behaviour everywhere except arm (A)'s false give-up, which now serves that
// one declaration exactly as the guard's own unique-owner path always did. A
// usage-only question ("who calls X", "where is X used", 「X の呼び出し元」) is
// untouched: its call sites ARE the answer. Declarations are parsed symbols of
// exactly X's name (every language the tree-sitter layer parses); the import
// relation reuses `importSpecifiersNaming` + `resolveImportSpecifierFile`
// (TS/JS named, aliased, namespace, default, require and re-export imports,
// Python `from`/`import`, Kotlin member and Java static imports) plus Go's
// package-path aliases. A caller this cannot attribute (a receiver method call
// in Java/Kotlin/C#, an unresolvable path alias) never binds anything — it
// leaves the question ambiguous, which is disclosed, never guessed.
// ---------------------------------------------------------------------------

/**
 * A request that names a file AND frames a plain word as a declaration — "yaml.v3/decode.go の
 * decoder 型", "the Transport struct in net/http/transport.go" — means that word's declaration IN
 * that file. Nothing else says so: `decoder` is also a variable of other files (`var decoder …`,
 * `decoder := …`), which the identifier recovery reads as definitions of the name (measured: the
 * request above recovered yaml/yamlfmt/yamlfmt.go 16-236, a function that declares such a variable,
 * not the struct of the file it names). The type (class, interface, enum or type kind) named exactly
 * `identifier`, spelled as the request spells it, declared in exactly ONE of the files the request
 * names; undefined otherwise — a word the request does not give a file for, or declares in two, is
 * left to the scan and its ambiguity guard.
 */
export async function framedTypeInNamedFiles(
  identifier: string,
  query: string,
  workspace: string,
  cache: FileReadCache,
): Promise<{ readonly path: string; readonly startLine: number; readonly endLine: number } | undefined> {
  const found: Array<{ path: string; startLine: number; endLine: number }> = [];
  for (const file of queryNamedWorkspaceFilesKeepingSharedBasenames(query, workspace)) {
    const content = readCached(workspace, file, cache);
    const lang = languageForPath(file);
    const parsed = content === undefined || !lang ? null : await cache.parsedSymbols(content, lang, file);
    const declarations = (parsed ?? []).filter((symbol) => CALLER_EXPANSION_TYPE_KINDS.has(symbol.kind) && unqualifiedSymbolTail(symbol.name) === identifier);
    if (declarations.length === 0) continue;
    // A C struct is also a one-line symbol wherever it is mentioned: the largest range is the definition.
    const widest = declarations.reduce((best, symbol) => (symbol.endLine - symbol.startLine > best.endLine - best.startLine ? symbol : best));
    found.push({ path: file, startLine: widest.startLine, endLine: widest.endLine });
  }
  return found.length === 1 ? found[0] : undefined;
}

/** One declaring file of a same-name subject: its first declaration of exactly that name. */
export interface SameNameDeclaration {
  readonly path: string;
  /** The parsed symbol's own name (possibly qualified, `Owner.member`). */
  readonly name: string;
  readonly startLine: number;
  readonly endLine: number;
}

/** WP-O: an explicitly named subject declared in >= 2 files, and the declaration evidence binds. */
export interface SameNameSubject {
  readonly identifier: string;
  /** One per declaring FILE (<= MAX_SAME_NAME_CANDIDATES), workspace-walk order. */
  readonly declarations: readonly SameNameDeclaration[];
  /** More declaring files may exist than `declarations` lists (a scan cap was hit). */
  readonly capped: boolean;
  /** The declaration the question means; absent = AMBIGUOUS — every listed declaration is required and the ambiguity is disclosed. */
  readonly bound?: SameNameDeclaration;
}

/** Declaring-file parses per subject (the line-shape pre-filter keeps this far below the cap in practice). */
export const MAX_SAME_NAME_DECLARATION_PARSES = 12;

/** Caller files examined for rule (b)'s unanimity; more callers than this never bind (unexamined callers could be callers of another declaration). */
export const MAX_SAME_NAME_CALLER_FILES = 64;

/** Re-export hops followed from an import to the declaring file (a barrel re-exporting a barrel). */
export const MAX_SAME_NAME_REEXPORT_HOPS = 2;

/** `request_item_absences` id prefix of the ambiguity disclosure — never `identifier:` (SHOULD-FIX 28's withdrawal test drops those whenever a served body mentions the name, which is exactly the served-declarations case). */
export const SAME_NAME_DISCLOSURE_PREFIX = "same-name:";

/**
 * Same-name subjects ride OUTSIDE the wire envelope, keyed by the result object
 * exactly like `identifierAbsenceByResult` (trim/dedupe mutate in place; the
 * builders re-record onto a distinct final object). Recomputed by every pack
 * build of the query — never carried from an earlier hop.
 */
export const sameNameSubjectsByResult = new WeakMap<object, ReadonlyMap<string, SameNameSubject>>();

export const NO_SAME_NAME_SUBJECTS: ReadonlyMap<string, SameNameSubject> = new Map();

/**
 * The same subjects, keyed by the pack build's own `FileReadCache` — the one
 * object the facet closure's focal resolution (`findDeclaredCallableAmong`)
 * already receives — so a value/condition facet asked of a bound same-name
 * subject settles on the SAME declaration its `identifier:X` does, instead of
 * disclosing an ambiguity the callers' imports already resolved.
 */
export const sameNameSubjectsByCache = new WeakMap<FileReadCache, ReadonlyMap<string, SameNameSubject>>();

export function recordSameNameSubjects(result: object, subjects: ReadonlyMap<string, SameNameSubject>): void {
  if (subjects.size === 0) return;
  const merged = new Map(sameNameSubjectsByResult.get(result) ?? []);
  for (const [identifier, subject] of subjects) merged.set(identifier, subject);
  sameNameSubjectsByResult.set(result, merged);
}

export function sameNameSubjectsFor(result: object): ReadonlyMap<string, SameNameSubject> {
  return sameNameSubjectsByResult.get(result) ?? NO_SAME_NAME_SUBJECTS;
}

/** The declarations a same-name subject's `identifier:X` needs on the wire: the bound one, or every listed one when ambiguous. */
export function sameNameRequiredDeclarations(subject: SameNameSubject): readonly SameNameDeclaration[] {
  return subject.bound !== undefined ? [subject.bound] : subject.declarations;
}

/** Does `surface` ship the head line of `declaration` (not a hole of it)? */
export function surfaceServesSameNameDeclaration(surface: TaskPackSurface, declaration: SameNameDeclaration): boolean {
  return surface.path === declaration.path
    && hasServedCode(surface)
    && surfaceBodyCoversRange(surface, `${declaration.startLine}-${declaration.startLine}`);
}

/** The served rows that carry one of the subject's REQUIRED declarations — the only rows that may prove it (a call site or mention never does). */
export function sameNameDeclarationRows(subject: SameNameSubject, served: readonly TaskPackSurface[]): TaskPackSurface[] {
  const required = sameNameRequiredDeclarations(subject);
  return served.filter((surface) => required.some((declaration) => surfaceServesSameNameDeclaration(surface, declaration)));
}

/** The subject's required declarations no row of `served` carries. */
export function unservedSameNameDeclarations(subject: SameNameSubject, served: readonly TaskPackSurface[]): SameNameDeclaration[] {
  return sameNameRequiredDeclarations(subject)
    .filter((declaration) => !served.some((surface) => surfaceServesSameNameDeclaration(surface, declaration)));
}

export function sameNameDeclarationList(subject: SameNameSubject): string {
  return `${subject.identifier} is declared in ${subject.capped ? "at least " : ""}${subject.declarations.length} files (${subject.declarations.map((declaration) => declaration.path).join(", ")})`;
}

/**
 * Explicit identifiers the request asks about ONLY as a usage subject — every
 * occurrence of X in the query sits inside a clause whose facet is `callers`
 * ("who calls X", "where is X used", "the callers of X", 「X の呼び出し元」), and
 * no other facet or clause names X. Their call sites ARE the answer, so WP-O
 * never applies to them (rule 3/4: byte-identical). A clause that names X
 * outside every callers clause ("Explain X and list its callers": the lead
 * clause) makes X a subject again. Reads `extractFacetRequirements`' own clause
 * split, so EN and JA are classified by the same vocabulary the facet gate uses.
 */
export function usageOnlyExplicitIdentifiers(query: string, identifiers: readonly string[]): ReadonlySet<string> {
  const out = new Set<string>();
  if (identifiers.length === 0) return out;
  const requirements = extractFacetRequirements(query);
  const callers = requirements.filter((requirement) => requirement.facet === "callers");
  if (callers.length === 0) return out;
  let outside = query;
  for (const requirement of callers) {
    const at = outside.indexOf(requirement.clause);
    if (at < 0) continue;
    outside = `${outside.slice(0, at)}${" ".repeat(requirement.clause.length)}${outside.slice(at + requirement.clause.length)}`;
  }
  for (const identifier of identifiers) {
    if (!callers.some((requirement) => requirement.subjectIdentifiers.includes(identifier))) continue;
    if (requirements.some((requirement) => requirement.facet !== "callers" && requirement.subjectIdentifiers.includes(identifier))) continue;
    if (containsWholeIdentifier(outside, identifier)) continue;
    out.add(identifier);
  }
  return out;
}

/** Cheap line-shape pre-filter for "this line may DECLARE `identifier`" — only ever decides which files get parsed; the parser decides. */
export function lineMayDeclareIdentifier(line: string, offset: number, identifier: string, includeKeywordlessMembers = false): boolean {
  if (isDeclarationShapedMatchText(line, identifier)) return true;
  // Keywordless class methods (JS/TS) still declare a subject. This is only a
  // parse prefilter: a bare call can enter, but parsed symbols must confirm it.
  if (includeKeywordlessMembers && /^\s*(?:(?:static|async|get|set)\s+)*$/.test(line.slice(0, offset))
    && /^\s*\(/.test(line.slice(offset + identifier.length))) return true;
  // A keyword-less top-level binding (`X = …`, `X: T = …` — Python, Ruby, …).
  return /^\s*$/.test(line.slice(0, offset))
    && /^\s*(?::[^=\n]*)?=(?!=)/.test(line.slice(offset + identifier.length));
}

/** 1-based lines of `content` holding `identifier` whole in CODE (never a comment line or a trailing comment). */
export function codeLinesNamingIdentifier(content: string, relPath: string, identifier: string): number[] {
  const language = commentSyntaxLanguageForPath(relPath, languageForPathWithContent(relPath, content));
  if (!commentSyntaxIsKnown(language)) return [];
  const commentFlags = classifyCommentLines(content, language!);
  const out: number[] = [];
  const lines = content.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    if (commentFlags[index] === true) continue;
    if (containsWholeIdentifier(codePortionOfLine(lines[index]!, language!), identifier)) out.push(index + 1);
  }
  return out;
}

/**
 * Every file that DECLARES `identifier` — a parsed symbol of exactly that name
 * (P0-3's exact identity rule: case-sensitive, never a normalized or fuzzy
 * match) — one declaration per file (its first), up to MAX_SAME_NAME_CANDIDATES
 * files, plus every file holding a whole occurrence of it (the callers rule
 * (b) examines). A same-named test double is dropped when a real declaration
 * exists and the question is not about tests. `undefined` when the scan failed.
 */
export async function sameNameDeclaringFiles(
  identifier: string,
  args: TaskPackArgs,
  query: string,
  workspace: string,
  cache: FileReadCache,
): Promise<{ declarations: SameNameDeclaration[]; capped: boolean; occurrencePaths: string[] } | undefined> {
  const mapMemberBinding = packHeldToCeilingWithoutPreview() && asksForStructureMap(query);
  let scanned: ReturnType<typeof scanLiteral>;
  try {
    scanned = scanLiteral(identifier, workspace, { caseInsensitive: false, ...(args.path ? { path: args.path } : {}) });
  } catch {
    return undefined;
  }
  const occurrencePaths: string[] = [];
  const occurrenceSeen = new Set<string>();
  const shapedPaths: string[] = [];
  const shapedSeen = new Set<string>();
  const linesByPath = new Map<string, readonly string[] | undefined>();
  for (const match of scanned) {
    if (wholeIdentifierOnHitLine(workspace, match, identifier, cache) === undefined) continue;
    if (!occurrenceSeen.has(match.path)) {
      occurrenceSeen.add(match.path);
      occurrencePaths.push(match.path);
    }
    if (shapedSeen.has(match.path)) continue;
    if (!linesByPath.has(match.path)) linesByPath.set(match.path, readCached(workspace, match.path, cache)?.split(/\r?\n/));
    const line = linesByPath.get(match.path)?.[match.line - 1];
    if (line === undefined) continue;
    const offset = wholeIdentifierOffsets(line, identifier)[0];
    if (offset === undefined || !lineMayDeclareIdentifier(line, offset, identifier, mapMemberBinding)) continue;
    shapedSeen.add(match.path);
    shapedPaths.push(match.path);
  }
  // Explicit file anchors must survive the parse cap for a common member
  // name. Otherwise earlier unrelated methods consume every parse first.
  if (mapMemberBinding) {
    const namedPaths = new Set([
      ...queryNamedWorkspaceFilesKeepingSharedBasenames(query, workspace),
      ...(args.path ? [args.path] : []),
    ]);
    shapedPaths.sort((a, b) => Number(namedPaths.has(b)) - Number(namedPaths.has(a)));
  }
  let declarations: SameNameDeclaration[] = [];
  let capped = false;
  let parses = 0;
  for (const relPath of shapedPaths) {
    if (declarations.length >= MAX_SAME_NAME_CANDIDATES || parses >= MAX_SAME_NAME_DECLARATION_PARSES) {
      capped = true;
      break;
    }
    parses += 1;
    const content = readCached(workspace, relPath, cache);
    if (content === undefined) continue;
    const lang = languageForPath(relPath);
    const parsed = (lang ? await cache.parsedSymbols(content, lang, relPath) : null) ?? [];
    const symbol = parsed
      .filter((entry) => unqualifiedSymbolTail(entry.name) === identifier)
      .sort((a, b) => a.startLine - b.startLine)[0];
    if (symbol === undefined) continue;
    // Parsers can attach a leading doc block to a method. The declaration
    // proof names its first code line, which survives the comment policy.
    const startLine = mapMemberBinding
      ? declarationHeaderLine(content.split(/\r?\n/), symbol.startLine, symbol.endLine) ?? symbol.startLine
      : symbol.startLine;
    declarations.push({ path: relPath, name: symbol.name, startLine, endLine: symbol.endLine });
  }
  if (!/\b(?:tests?|specs?|fixtures?|mocks?|fakes?|stubs?)\b|テスト/iu.test(query)) {
    const real = declarations.filter((declaration) => !isTestConcernPath(declaration.path));
    if (real.length > 0) declarations = real;
  }
  return { declarations, capped, occurrencePaths };
}

/** Names bound to `identifier` under another local name (`import { X as Y }`, `from m import X as Y`, `const { X: Y } = require(…)`). */
export function localAliasesOfIdentifier(lines: readonly string[], identifier: string): string[] {
  const escaped = identifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const asAlias = new RegExp(`(?<![\\w$])${escaped}\\s+as\\s+([A-Za-z_$][\\w$]*)`, "g");
  const colonAlias = new RegExp(`(?<![\\w$])${escaped}\\s*:\\s*([A-Za-z_$][\\w$]*)`, "g");
  const out = new Set<string>();
  for (const line of lines) {
    if (!/^\s*(?:import|from|export|const|let|var)\b/.test(line)) continue;
    for (const match of line.matchAll(asAlias)) out.add(match[1]!);
    if (/\brequire\s*\(/.test(line)) for (const match of line.matchAll(colonAlias)) out.add(match[1]!);
  }
  out.delete(identifier);
  return [...out];
}

/** Qualifiers `identifier` is reached through on code lines (`ns.X`, `module.X`, Go `pkg.X`, `A::X`, `p->X`). */
export function qualifiersOfIdentifier(lines: readonly string[], identifier: string): string[] {
  const escaped = identifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const qualified = new RegExp(`([A-Za-z_$][\\w$]*)\\s*(?:\\.|::|->)\\s*${escaped}(?![\\w$])`, "g");
  const out = new Set<string>();
  for (const line of lines) for (const match of line.matchAll(qualified)) out.add(match[1]!);
  for (const receiver of ["this", "self", "super", "cls", "base"]) out.delete(receiver);
  return [...out];
}

/**
 * Rule (b) for ONE file: the declaring file that `relPath` takes
 * `identifier` from — through a named or aliased import, a module alias it
 * qualifies the name with, up to MAX_SAME_NAME_REEXPORT_HOPS re-export hops,
 * or (Go) the package path its qualifier binds / its own package directory.
 * `undefined` = this file cannot be attributed to exactly one declaration.
 */
export async function sameNameImportTarget(
  identifier: string,
  relPath: string,
  byPath: ReadonlyMap<string, SameNameDeclaration>,
  workspace: string,
  cache: FileReadCache,
  depth = 0,
): Promise<SameNameDeclaration | undefined> {
  const content = readCached(workspace, relPath, cache);
  if (content === undefined) return undefined;
  const lines = content.split(/\r?\n/);
  const hashComment = hasHashComments(relPath);
  const specs: ImportSpecifier[] = [];
  const admit = (spec: ImportSpecifier): void => {
    // A wildcard names nothing specific; only a barrel hop may follow one.
    if (spec.wildcard && depth === 0) return;
    specs.push(spec);
  };
  for (const spec of importSpecifiersNaming(lines, identifier, hashComment, relPath)) admit(spec);
  for (const alias of localAliasesOfIdentifier(lines, identifier)) {
    for (const spec of importSpecifiersNaming(lines, alias, hashComment, relPath)) {
      if ((spec.exportedName ?? alias) === identifier) admit(spec);
    }
  }
  const qualifiers = qualifiersOfIdentifier(lines, identifier);
  for (const qualifier of qualifiers) {
    for (const spec of importSpecifiersNaming(lines, qualifier, hashComment, relPath)) admit(spec);
  }
  let target: SameNameDeclaration | undefined;
  for (const spec of specs.slice(0, 6)) {
    const resolved = await resolveImportSpecifierFile(relPath, spec, workspace, cache);
    if (resolved === undefined || resolved.path === relPath) continue;
    const reached = byPath.get(resolved.path)
      ?? (depth < MAX_SAME_NAME_REEXPORT_HOPS
        ? await sameNameImportTarget(identifier, resolved.path, byPath, workspace, cache, depth + 1)
        : undefined);
    if (reached === undefined) continue;
    if (target !== undefined && target.path !== reached.path) return undefined;
    target = reached;
  }
  if (target !== undefined || !isGoLanguage(relPath)) return target;
  // Go: an import names a PACKAGE, never a binding — `pkg.X` resolves through
  // the package path its qualifier binds; an unqualified X is the file's own
  // package (its directory).
  const dirOf = (file: string): string => path.posix.dirname(file.replace(/\\/g, "/"));
  const aliases = goImportPathAliasesIn(lines, hashComment);
  const reached = new Set<string>();
  for (const qualifier of qualifiers) {
    const importPath = aliases.get(qualifier);
    if (importPath === undefined) continue;
    for (const declaration of byPath.values()) {
      const dir = dirOf(declaration.path);
      if (dir !== "." && (importPath === dir || importPath.endsWith(`/${dir}`))) reached.add(declaration.path);
    }
  }
  // Same package: only a file that actually USES the name unqualified.
  if (qualifiers.length === 0 && codeLinesNamingIdentifier(content, relPath, identifier).length > 0) {
    for (const declaration of byPath.values()) {
      if (isGoLanguage(declaration.path) && dirOf(declaration.path) === dirOf(relPath)) reached.add(declaration.path);
    }
  }
  return reached.size === 1 ? byPath.get([...reached][0]!) : undefined;
}

/**
 * Rule (b), callers form: every code file naming `identifier` (outside
 * comments) is attributed to the declaration it uses — its import, or (for a
 * declaring file) its own declaration when it uses the name outside that
 * declaration's span and outside an import/export line. Binds only when EVERY
 * caller was examined and attributed and all of them name ONE declaring file:
 * a caller of each declaration, a caller this cannot attribute, or more callers
 * than MAX_SAME_NAME_CALLER_FILES all leave the question ambiguous.
 */
export async function sameNameCallerVote(
  identifier: string,
  occurrencePaths: readonly string[],
  byPath: ReadonlyMap<string, SameNameDeclaration>,
  workspace: string,
  cache: FileReadCache,
): Promise<SameNameDeclaration | undefined> {
  const voted = new Set<string>();
  let examined = 0;
  for (const relPath of occurrencePaths) {
    if (!pathClassCanCarryCode(relPath) || languageForPath(relPath) === undefined) continue;
    const content = readCached(workspace, relPath, cache);
    if (content === undefined) return undefined;
    const codeLines = codeLinesNamingIdentifier(content, relPath, identifier);
    if (codeLines.length === 0) continue;
    examined += 1;
    if (examined > MAX_SAME_NAME_CALLER_FILES) return undefined;
    const own = byPath.get(relPath);
    if (own !== undefined) {
      const lines = content.split(/\r?\n/);
      const localUse = codeLines.some((line) =>
        (line < own.startLine || line > own.endLine)
        && !mentionExplainedByImportExportLine(lines[line - 1] ?? "", identifier, relPath));
      if (localUse) voted.add(relPath);
      continue;
    }
    const target = await sameNameImportTarget(identifier, relPath, byPath, workspace, cache);
    if (target === undefined) return undefined;
    voted.add(target.path);
    if (voted.size > 1) return undefined;
  }
  return voted.size === 1 ? byPath.get([...voted][0]!) : undefined;
}

/**
 * WP-F's binding order for a same-name subject (see the section header):
 * (a) a named file that declares it — a path the question itself writes
 * first, then a caller-supplied target; (b) an import relation from the named
 * files, else from every caller; (c) the same file as another subject of the
 * question. `undefined` = ambiguous.
 */
export async function bindSameNameSubject(
  identifier: string,
  declarations: readonly SameNameDeclaration[],
  occurrencePaths: readonly string[],
  /**
   * Files the request names, strongest first: `named` = a path written in the
   * question or `args.path`; `targets` = caller-supplied `targets`/`paths`
   * (which may be a server-bundled candidate list, so they never outrank a
   * path the question itself names).
   */
  anchors: { readonly named: readonly string[]; readonly targets: readonly string[] },
  contextPaths: readonly string[],
  workspace: string,
  cache: FileReadCache,
): Promise<SameNameDeclaration | undefined> {
  const byPath = new Map(declarations.map((declaration) => [declaration.path, declaration] as const));
  const tiers = [anchors.named, anchors.targets].map((tier) => [...new Set(tier.filter((anchor) => anchor.length > 0))]);
  for (const [index, tier] of tiers.entries()) {
    const namedDeclarations = tier.filter((anchor) => byPath.has(anchor));
    if (namedDeclarations.length === 1) return byPath.get(namedDeclarations[0]!);
    // The question writing two declaring paths means both: ambiguous. Two
    // caller-supplied targets that declare X are no verdict at all (a
    // server-bundled candidate list carries every served file, a same-name
    // counterexample included) — the import relation decides.
    if (namedDeclarations.length > 1 && index === 0) return undefined;
  }
  const namedAnchors = [...new Set(tiers.flat())];
  const anchorTargets = new Set<string>();
  for (const anchor of namedAnchors) {
    const target = await sameNameImportTarget(identifier, anchor, byPath, workspace, cache);
    if (target !== undefined) anchorTargets.add(target.path);
  }
  if (anchorTargets.size === 1) return byPath.get([...anchorTargets][0]!);
  if (anchorTargets.size === 0) {
    const vote = await sameNameCallerVote(identifier, occurrencePaths, byPath, workspace, cache);
    if (vote !== undefined) return vote;
  }
  const sameFile = [...new Set(contextPaths)].filter((contextPath) => byPath.has(contextPath));
  return sameFile.length === 1 ? byPath.get(sameFile[0]!) : undefined;
}

/** An injected declaration candidate — the SAME shape and `why` `recoverExplicitIdentifierAnswerCandidates` gives a unique definition owner. */
export function sameNameDeclarationCandidate(declaration: SameNameDeclaration): RankedAnswerEvidenceCandidate {
  return {
    candidate: {
      path: declaration.path,
      line: declaration.startLine,
      range: `${declaration.startLine}-${declaration.endLine}`,
      symbol: declaration.name,
      surface: classifySurface(declaration.path),
      why: "answer-explicit-identifier-recovery",
      confidence: 0.97,
    },
    // `recoverExplicitIdentifierAnswerCandidates`' score for a declaration
    // line of an implementation file (6 + keyword 4 + opening `(` 2 + implementation 3).
    score: 15,
    exactIdentifier: true,
    strongEvidence: true,
  };
}

/**
 * WP-O arm (A): the first pack's recovery for an explicitly named subject,
 * run right after `recoverExplicitIdentifierAnswerCandidates` on the same
 * ranked list. One bounded declaration scan per subject (<= 3; the same price
 * WP-F's facet binding pays per facet subject — a genuinely unique name finds
 * one declaration and changes nothing):
 *  - X declared in ONE file: injected only when that function itself reached X
 *    and gave up (`recoveryRan`) with no declaration located — its own
 *    unique-owner path, which a keyword-bearing CALLER line used to defeat.
 *    Otherwise nothing changes.
 *  - X declared in >= 2 files: bound by WP-F's order (`bindSameNameSubject`);
 *    the bound declaration (or, when ambiguous, every listed one) joins the
 *    pack unless already a candidate, and the subject is returned for the
 *    certificate (`recordSameNameSubjects`). It is ranked first (it IS the
 *    answer) when no OTHER subject holds an exact candidate; otherwise it is
 *    returned in `additions` for the caller's zero-displacement merge AFTER
 *    the answer-mode decision. When the binding rules out every LOCATED
 *    declaration (the locator anchored on a same-name decoy — a file name that
 *    matches a query word, say), those decoys leave the ranked list: they are
 *    never the answer's evidence. A located bound declaration keeps today's
 *    selection unchanged.
 */
export async function recoverSameNameAnswerSubjects(
  args: TaskPackArgs,
  query: string,
  workspace: string,
  ranked: RankedAnswerEvidenceCandidate[],
  cache: FileReadCache,
  absences: ReadonlyMap<string, ExplicitIdentifierAbsence>,
  recoveryRan: boolean,
): Promise<{ subjects: Map<string, SameNameSubject>; additions: ImpactCandidate[] }> {
  const subjects = new Map<string, SameNameSubject>();
  const identifiers = explicitCodeIdentifiers(query).slice(0, 3);
  if (identifiers.length === 0) return { subjects, additions: [] };
  const usageOnly = usageOnlyExplicitIdentifiers(query, identifiers);
  const declares = (entry: RankedAnswerEvidenceCandidate, identifier: string): boolean =>
    entry.candidate.symbol !== undefined && unqualifiedSymbolTail(entry.candidate.symbol) === identifier;
  // v0.15.1 runtime review (2026-10-06): a bare basename several roots share
  // names every one of them here. Resolved to one (`queryNamedWorkspaceFiles`
  // picks the alphabetically first), "What is the value of RETRY_LIMIT in
  // settings.ts?" over `a/settings.ts` (4) and `b/settings.ts` (9) bound the
  // subject to `a/` and certified 4 with no word about `b/`; naming both, the
  // binding below reads it as the ambiguity it is — every declaration served,
  // the certificate disclosing it.
  const anchors = {
    named: [
      ...queryNamedWorkspaceFilesKeepingSharedBasenames(query, workspace),
      ...(args.path ? [args.path] : []),
    ],
    targets: [],
  };
  const injected: RankedAnswerEvidenceCandidate[] = [];
  const sameNameInjected: RankedAnswerEvidenceCandidate[] = [];
  for (const identifier of identifiers) {
    if (usageOnly.has(identifier) || absences.has(identifier)) continue;
    const located = new Set(ranked.filter((entry) => declares(entry, identifier)).map((entry) => entry.candidate.path));
    const found = await sameNameDeclaringFiles(identifier, args, query, workspace, cache);
    if (found === undefined || found.declarations.length === 0) continue;
    if (found.declarations.length === 1) {
      if (recoveryRan && located.size === 0) injected.push(sameNameDeclarationCandidate(found.declarations[0]!));
      continue;
    }
    const contextPaths = ranked
      .filter((entry) => entry.exactIdentifier && !declares(entry, identifier))
      .map((entry) => entry.candidate.path);
    const bound = await bindSameNameSubject(identifier, found.declarations, found.occurrencePaths, anchors, contextPaths, workspace, cache);
    const subject: SameNameSubject = {
      identifier,
      declarations: found.declarations,
      capped: found.capped,
      ...(bound !== undefined ? { bound } : {}),
    };
    subjects.set(identifier, subject);
    for (const declaration of sameNameRequiredDeclarations(subject)) {
      if (!located.has(declaration.path)) sameNameInjected.push(sameNameDeclarationCandidate(declaration));
    }
    if (bound !== undefined && !located.has(bound.path)) {
      for (let index = ranked.length - 1; index >= 0; index--) {
        if (declares(ranked[index]!, identifier) && ranked[index]!.candidate.path !== bound.path) ranked.splice(index, 1);
      }
    }
  }
  // A question whose OTHER subjects already hold exact candidates keeps its
  // own answer-mode decision: the same-name declarations join it as a
  // strictly additive merge afterwards (the caller's `mergeConcernAdditions`,
  // the Blocker-1 contract concern recovery follows), never as one more exact
  // candidate that would turn a one-file answer into a candidate list. With no
  // other exact candidate they ARE the answer, ranked first like the unique
  // owner `recoverExplicitIdentifierAnswerCandidates` injects.
  const otherExact = [...ranked, ...injected].some((entry) => entry.exactIdentifier
    && ![...subjects.keys()].some((identifier) => declares(entry, identifier)));
  const additions = otherExact ? sameNameInjected.map((entry) => entry.candidate) : [];
  if (!otherExact) injected.push(...sameNameInjected);
  if (injected.length > 0) ranked.unshift(...injected);
  return { subjects, additions };
}

/**
 * WP-O arm (B) for a caller-supplied (seeded) answer pack: the same-name
 * subjects whose declaration none of the caller's targets carries (a target
 * that declares X binds it by rule (a) — today's answer). Nothing is served
 * here (a seeded pack never widens past the caller's own targets — see the
 * facet closure's plan-only seeded call); the certificate then refuses a call
 * site as X's proof and names the bound declaration as a ranged `next`.
 */
export async function seededSameNameSubjects(
  args: TaskPackArgs,
  query: string,
  workspace: string,
  surfaces: readonly TaskPackSurface[],
  suppliedPaths: readonly string[],
  cache: FileReadCache,
): Promise<Map<string, SameNameSubject>> {
  const subjects = new Map<string, SameNameSubject>();
  const identifiers = explicitCodeIdentifiers(query).slice(0, 3);
  if (identifiers.length === 0) return subjects;
  const usageOnly = usageOnlyExplicitIdentifiers(query, identifiers);
  const anchors = {
    named: [
      ...queryNamedWorkspaceFiles(query, workspace, suppliedPaths),
      ...(args.path ? [args.path] : []),
    ],
    targets: suppliedPaths,
  };
  for (const identifier of identifiers) {
    if (usageOnly.has(identifier)) continue;
    const declaringTargets = new Set<string>();
    for (const surface of surfaces) {
      if (!hasServedCode(surface)) continue;
      if (surface.symbol !== undefined && unqualifiedSymbolTail(surface.symbol) === identifier) {
        declaringTargets.add(surface.path);
        continue;
      }
      if (!containsWholeIdentifier(servedSurfaceText(surface), identifier)) continue;
      const content = readCached(workspace, surface.path, cache);
      const lang = languageForPath(surface.path);
      if (content === undefined || !lang) continue;
      const parsed = (await cache.parsedSymbols(content, lang, surface.path)) ?? [];
      if (parsed.some((symbol) =>
        unqualifiedSymbolTail(symbol.name) === identifier
        && surfaceBodyCoversRange(surface, `${symbol.startLine}-${symbol.startLine}`))) declaringTargets.add(surface.path);
    }
    if (declaringTargets.size === 1) continue;
    const found = await sameNameDeclaringFiles(identifier, args, query, workspace, cache);
    if (found === undefined || found.declarations.length < 2) continue;
    const bound = await bindSameNameSubject(identifier, found.declarations, found.occurrencePaths, anchors, [], workspace, cache);
    subjects.set(identifier, {
      identifier,
      declarations: found.declarations,
      capped: found.capped,
      ...(bound !== undefined ? { bound } : {}),
    });
  }
  return subjects;
}

/**
 * WP-O: `identifier:X` for a same-name subject — proved ONLY by served rows of
 * its required declarations (the bound one, or every listed one when
 * ambiguous); a call site or mention is never X's proof.
 */
export function sameNameIdentifierObligation(subject: SameNameSubject, served: readonly TaskPackSurface[]): TaskReadinessObligation {
  const rows = sameNameDeclarationRows(subject, served);
  const unserved = unservedSameNameDeclarations(subject, served);
  const proved = unserved.length === 0;
  return {
    id: `identifier:${subject.identifier}`,
    kind: "explicit-identifier",
    status: proved ? "proved" : "uncovered",
    required: true,
    evidence: rows.map(readinessEvidence).slice(0, 6),
    reason: proved
      ? subject.bound !== undefined
        ? `explicit identifier ${subject.identifier} is proved by its own declaration in ${subject.bound.path} (${sameNameDeclarationList(subject)})`
        : `${sameNameDeclarationList(subject)}; each declaration is served and the ambiguity is disclosed`
      : `${sameNameDeclarationList(subject)}; its declaration in ${unserved.map((declaration) => declaration.path).join(", ")} has not been served, and a call site or mention is not its definition`,
  };
}

/** WP-O: the certificate's disclosure of every AMBIGUOUS same-name subject its `identifier:X` proved (from every declaration). */
export function sameNameAmbiguityDisclosures(
  result: TaskPackResult,
  obligations: readonly TaskReadinessObligation[],
): Array<{ id: string; term: string; scope_complete: boolean; omitted_count: number; undetermined: true; undetermined_reason: string }> {
  const out: Array<{ id: string; term: string; scope_complete: boolean; omitted_count: number; undetermined: true; undetermined_reason: string }> = [];
  for (const subject of sameNameSubjectsFor(result).values()) {
    if (subject.bound !== undefined) continue;
    const obligation = obligations.find((entry) => entry.id === `identifier:${subject.identifier}`);
    if (obligation?.status !== "proved") continue;
    out.push({
      id: `${SAME_NAME_DISCLOSURE_PREFIX}${subject.identifier}`,
      term: subject.identifier,
      scope_complete: false,
      omitted_count: 0,
      undetermined: true,
      undetermined_reason: capWords(`${sameNameDeclarationList(subject)} and this pack could not tell which one the question means`, 28),
    });
  }
  return out;
}

export const SHARED_BASENAME_DISCLOSURE_PREFIX = "shared-basename:";

/**
 * v0.15.1 runtime review (2026-10-06): a bare basename the question writes
 * (`http.ts`) that several project roots share (`a/http.ts`, `b/http.ts`)
 * leaves the target open, and an answer served from SOME of those files
 * picked one the question never chose: 「http.ts の retry 関数について…」 over
 * two `http.ts` files was certified from `a/http.ts` alone with no word
 * about `b/http.ts`. The certificate says so instead (which files the name
 * matches, which this pack served). Silent when a root-level file carries the
 * exact name (the bare token names it), when every match is served (the
 * answer can address each), or when none is.
 */
export function sharedBasenameDisclosures(
  result: TaskPackResult,
  query: string,
  workspace: string,
): Array<{ id: string; term: string; scope_complete: boolean; omitted_count: number; undetermined: true; undetermined_reason: string }> {
  const tokens = queryNamedPathTokens(query).filter((token) => !token.includes("/"));
  if (tokens.length === 0) return [];
  const served = new Set(codeTaskPackSurfaces(result.surfaces).filter(hasServedCode).map((surface) => surface.path));
  if (served.size === 0) return [];
  const walked = walkedFilesForQueryNamedResolution(workspace, false);
  const out: Array<{ id: string; term: string; scope_complete: boolean; omitted_count: number; undetermined: true; undetermined_reason: string }> = [];
  for (const token of tokens) {
    const named = filesNamedByPathToken(token, walked, query);
    if (named.length < 2) continue;
    const servedNamed = named.filter((relPath) => served.has(relPath));
    if (servedNamed.length === 0 || servedNamed.length === named.length) continue;
    const listed = named.slice(0, 4);
    out.push({
      id: `${SHARED_BASENAME_DISCLOSURE_PREFIX}${token}`,
      term: token,
      scope_complete: false,
      omitted_count: 0,
      undetermined: true,
      undetermined_reason: capWords(
        `${token} names ${named.length} files (${listed.join(", ")}${named.length > listed.length ? ", …" : ""}); this pack served ${servedNamed.join(", ")} and the question does not say which one it means`,
        32,
      ),
    });
  }
  return out;
}

/** WP-O: the ranged, query-bearing read of a same-name subject's unserved required declarations (the `next` of its open `identifier:X`). */
export function sameNameDeclarationReadCall(
  result: TaskPackResult,
  subject: SameNameSubject,
  query: string,
  workspace: string | undefined,
): ContinuationCall | undefined {
  const served = workspace === undefined
    ? codeTaskPackSurfaces(result.surfaces).filter(hasServedCode)
    : epochServedEvidence(workspace, result, tokenizeForEpoch(query), "answer").filter(hasServedCode);
  const unserved = unservedSameNameDeclarations(subject, served);
  if (unserved.length === 0) return undefined;
  return {
    tool: "tl_read_file",
    arguments: {
      query,
      targets: unserved.slice(0, MAX_SAME_NAME_CANDIDATES).map((declaration) => ({
        path: declaration.path,
        range: `${declaration.startLine}-${declaration.endLine}`,
      })),
      content: "auto",
    },
  };
}
