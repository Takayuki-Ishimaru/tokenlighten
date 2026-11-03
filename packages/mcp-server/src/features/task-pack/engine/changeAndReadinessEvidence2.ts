// changeAndReadinessEvidence — extracted implementation; imports point to the owning modules.
import * as path from "path";
import type { TaskPackResult } from "../model.js";
import type { TaskPackSurface } from "../model.js";
import type { TaskReadinessEvidence } from "@tokenlighten/types";
import { countLines } from "../../../util/countLines.js";
import { dedupedSurfaceBody } from "./packState2.js";
import { isFacetDescriptorTerm } from "../requestFacets.js";
import { maskExplanationAspectPhrases } from "../requestFacets.js";
import { readCached } from "./packBasics2.js";
import { stripPathSpans } from "../../../util/queryShape.js";
import { wholeTokenOccursIn } from "../askedPathClosure.js";

export const READINESS_PROBE_MAX_FILES = 120;

export const READINESS_PROBE_MAX_BYTES = 512 * 1024;

export const READINESS_PROBE_MAX_SURFACES = 2;

export const READINESS_PROBE_GENERIC_TOKENS = new Set([
  "answer", "behavior", "build", "contract", "exactly", "execution", "explain", "followup",
  "implementation", "needs", "pack", "read", "ready", "returns", "structured", "task", "when",
]);

/**
 * W5-B (2026-08-21, falsification-scope-and-text-floor forensics): roles
 * that must never, by themselves, widen the falsification probe's fallback
 * scope (runInternalReadinessFalsification's pathless-query default). A
 * "doc" anchor commonly sits DIRECTLY at the workspace root (a top-level
 * design doc), and an "unknown"-role anchor already survived only on
 * generic lexical overlap — neither marks the task's own project root the
 * way a code-bearing surface (api/domain/contract/test/ui/style) does.
 * Left unfiltered, a mixed anchor set (one nested-package code surface +
 * one root-level doc surface) makes roleSearchScopePrefixes' shared-
 * ancestor branch degrade to a bare "" prefix — ROOT-MEMBERSHIP semantics
 * matching every file the workspace root does not delegate to a nested
 * package (bench/, scripts/, any other top-level tree) — instead of the
 * doc's own narrow location. See runInternalReadinessFalsification's
 * dominantAnchorPaths.
 */
export const FALSIFICATION_SCOPE_SUPPORT_ROLES: ReadonlySet<string> = new Set(["doc", "unknown"]);

/**
 * W5-B: a falsification counterexample is SUPPORTING negative evidence, not
 * the pack's own primary content — it must stay far under the general
 * per-surface cap (MAX_SURFACE_CODE_BYTES). The pre-fix probe window
 * (selectQueryEvidence's +-18 LINE window, uncapped in BYTES) served a
 * 9.4KB body from a file whose matched lines happened to be very long.
 * Reuses centeredSliceForCap — the same centered/graceful-truncation
 * mechanism every other oversize-surface path already uses — with this
 * smaller cap instead of inventing a second trimming mechanism.
 */
export const READINESS_PROBE_COUNTEREXAMPLE_MAX_BYTES = 2048;

export const IMPLEMENTATION_EXTS = new Set([
  ".c", ".cc", ".cpp", ".cxx", ".go", ".java", ".js", ".jsx", ".kt", ".kts",
  ".m", ".mm", ".php", ".py", ".rb", ".rs", ".swift", ".ts", ".tsx",
]);

export const BEHAVIOR_QUERY_RE = /\b(?:behavior|conditions?|flow|lifecycle|sequence|state\s*machine|transition|when|how)\b|挙動|条件|流れ|順番|ライフサイクル|遷移|ステートマシン/i;

export function servedSurfaceText(surface: TaskPackSurface): string {
  // W4: recover a deduped surface's REAL body (see dedupedSurfaceBody) for
  // server-side reasoning so proof/readiness verdicts are invariant to the
  // cross-call `code`→pointer swap; falls back to the pointer only if no real
  // body was recorded (e.g. a surface that arrived code_unchanged).
  return surface.code ?? dedupedSurfaceBody.get(surface) ?? surface.code_unchanged ?? "";
}

export function readinessEvidence(surface: TaskPackSurface): TaskReadinessEvidence {
  return {
    handle: surface.handle,
    path: surface.path,
    ...(surface.range ? { range: surface.range } : {}),
    ...(surface.symbol ? { symbol: surface.symbol } : {}),
  };
}

export function isImplementationPath(filePath: string): boolean {
  return IMPLEMENTATION_EXTS.has(path.extname(filePath).toLowerCase())
    && !/\.d\.(?:[cm]?ts|tsx)$/i.test(filePath)
    // Benchmark/sample repositories often live below a host repo's `bench/`
    // or `fixtures/` directory while still containing the real implementation
    // the agent is assigned to edit. Excluding those container segments made
    // every artifact_build/wiring proof in Signal5 treat production bodies as
    // non-implementation evidence. Only explicit test/spec subtrees are
    // non-implementation by path; fixture/bench-ness is not semantic evidence.
    && !/(?:^|\/)(?:test|tests|spec|specs)(?:\/|$)/i.test(filePath)
    // Issue #4 (2026-08-21): the directory check above only matched a path
    // SEGMENT spelled exactly "test(s)"/"spec(s)" — it never matched this
    // very workspace's own dominant Vitest convention, `__tests__/*.spec.ts`
    // (nor the sibling `*.test.ts`), because "__tests__" (underscore-wrapped)
    // and a ".spec."/".test." FILENAME suffix are both different strings
    // from a bare "test"/"spec" path segment. That left every spec file in
    // this workspace classified as "implementation" — eligible to win a
    // same-topic ranking tie-break against the production file it tests, be
    // promoted to an "api" role, or (readiness-falsification's actual
    // symptom) get force-added as a REQUIRED edit "competing implementation
    // counterexample" for a request that never touched behavior at all.
    && !/(?:^|\/)__tests?__(?:\/|$)/i.test(filePath)
    && !/\.(?:spec|test)\.[^./]+$/i.test(filePath);
}

// v0.15.1 runtime review (2026-10-06): a method's declared return type sits
// between its `)` and its `{` — `scan(paths: string[]): string[] {` (TS),
// `fun scan(): Int {` (Kotlin), `fn scan(&self) -> usize {` (Rust), `func
// scan() -> Int {` (Swift). Without it a TypeScript class whose methods all
// declare return types had no "callable body": "Explain how many files
// WorkspaceScanner in scanner.ts scans." left `behavior-body` open over the
// fully served class and sent the caller to re-read its import lines, a chain
// that ended with no decision at all.
export const CALLABLE_RETURN_TYPE_SRC = "(?:\\s*(?::|->)\\s*[^;{}=()]+?)?";

export const CALLABLE_MODIFIER_DECLARATION_RE = new RegExp(
  `\\b(?:public|private|protected|static|async|virtual|inline|constexpr)\\b[^;{}\\n]*\\b[A-Za-z_][A-Za-z0-9_]*(?:::[A-Za-z_][A-Za-z0-9_]*)?\\s*\\([^;{}]*\\)${CALLABLE_RETURN_TYPE_SRC}\\s*(?:const\\s*)?\\{`,
);

export const CALLABLE_QUALIFIED_DECLARATION_RE = new RegExp(
  `\\b[A-Za-z_][A-Za-z0-9_]*(?:::[A-Za-z_][A-Za-z0-9_]*)+\\s*\\([^;{}]*\\)${CALLABLE_RETURN_TYPE_SRC}\\s*(?:const\\s*)?\\{`,
);

export const CALLABLE_BARE_DECLARATION_RE = new RegExp(
  `\\b(?!if\\b|for\\b|while\\b|switch\\b|catch\\b)[A-Za-z_][A-Za-z0-9_]*\\s*\\([^;{}]*\\)${CALLABLE_RETURN_TYPE_SRC}\\s*\\{`,
);

export function hasCallableBody(surface: TaskPackSurface): boolean {
  if (!isImplementationPath(surface.path)) return false;
  const symbol = surface.symbol ?? "";
  if (symbol && (/::|\./.test(symbol) || /^[a-z_]/.test(symbol))) return true;
  const text = servedSurfaceText(surface);
  return /\b(?:def|fn|func|fun|function)\s+[A-Za-z_][A-Za-z0-9_]*\s*\(/.test(text)
    || CALLABLE_MODIFIER_DECLARATION_RE.test(text)
    || CALLABLE_QUALIFIED_DECLARATION_RE.test(text)
    || CALLABLE_BARE_DECLARATION_RE.test(text);
}

// ---------------------------------------------------------------------------
// R2-T1 (eval-0929 review P0-3; orchestrator ruling 2026-09-30, rule 3) —
// `behavior-body` IS NEVER PROVED BY A DECLARATION / SIGNATURE LINE ALONE.
//
// `hasCallableBody` decides whether a surface is CALLABLE evidence — by its
// symbol, or by a declaration shape in its text — which says nothing about
// whether the served lines include the callable's BODY. Measured (budget
// 8192): a first hop shipped only `import …` and `export function
// mayRetry(status, attempt) {`, and a continuation certified `behavior-body`
// over those two lines and not one of the 300 branches; the falsification
// pass's one-line import row carries the callable's SYMBOL and passed for the
// same reason.
//
// THE RULE. Every callable the question NAMES whose declaration is found in a
// file this task served must have at least one served line after its
// declaration (inside it: before the next declaration at the same or a
// shallower indent), carry its body on the declaration line itself (a
// one-liner), or have its whole extent served (an empty body has nothing
// further to show). The rule reaches ONLY a named callable whose declaration
// exists: when the question names none that can be located there — a name
// declared nowhere (its confirming search and verified absence are the
// identifier obligation's path), or a concept question — or no declaration
// can be recognized at all (a shape this scan does not know), the
// pre-existing proof stands unchanged (`undefined` below): never a ranged read
// of a body that does not exist. Measured regression this scoping closes
// (handsOnReport0142 SHOULD-FIX 37(b)): "Explain how QuoteOrchestrator uses …"
// with QuoteOrchestrator declared nowhere fell back to ANY callable, found an
// empty `refreshCachedDefinitions(): void {}`, and re-read its one line
// forever instead of certifying the verified absence.
//
// Declarations are recognized per line, language-agnostically: keyword forms
// (`function`, `def`, `fn`, `func` incl. a Go receiver, `fun`, `sub`), a
// function-valued binding (`const f = (…) =>`, `f = function`), and a
// C-family / method signature whose `{` opens on the line or the next one
// (Allman). That covers TS/JS, Python, Go, Rust, Kotlin, Java, C#, C/C++.
// ---------------------------------------------------------------------------

/** A callable declaration in a served file: 1-based `line`; the body search stops before `bound`. */
export interface CallableDeclaration {
  readonly name: string;
  readonly path: string;
  readonly line: number;
  readonly bound: number;
}

/** Words the signature patterns below can capture as a "name" that never declare a callable. */
export const CALLABLE_NAME_STOP_WORDS: ReadonlySet<string> = new Set([
  "if", "for", "while", "switch", "catch", "return", "new", "typeof", "sizeof", "else", "do", "try",
  "elif", "with", "await", "yield", "throw", "delete", "void", "super", "this", "function", "using",
  "lock", "foreach", "when", "match", "select", "assert", "print", "defer", "go", "unless", "until",
]);

/** The name `text` declares as a callable, or `undefined`. `next` is the following non-blank line (an Allman `{`). */
export function callableDeclaredOnLine(text: string, next: string | undefined): string | undefined {
  const keyword = /^\s*(?:export\s+)?(?:default\s+)?(?:(?:pub(?:\([^)]*\))?|public|private|protected|internal|static|async|override|virtual|abstract|final|suspend|inline|open|extern|unsafe|const|operator|infix|tailrec)\s+)*(?:def|fn|func|fun|function\*?|sub)\s+(?:\([^)]*\)\s*)?([A-Za-z_$][\w$]*)\s*[<([]/.exec(text);
  if (keyword !== null && !CALLABLE_NAME_STOP_WORDS.has(keyword[1]!)) return keyword[1];
  const binding = /^\s*(?:export\s+)?(?:(?:const|let|var|static|readonly|public|private|protected)\s+)*([A-Za-z_$][\w$]*)\s*(?::\s*[^=]+)?[:=]\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*(?::\s*[^=]+)?=>|[A-Za-z_$][\w$]*\s*=>)/.exec(text);
  if (binding !== null && !CALLABLE_NAME_STOP_WORDS.has(binding[1]!)) return binding[1];
  const signature = /^\s*(?:[\w$<>[\],.?*&:~@]+\s+)*?([A-Za-z_$~][\w$]*)\s*(?:<[^<>()]*>)?\s*\((?:[^()]|\([^()]*\))*\)\s*(?:(?::|->)\s*[^{;=]+|throws\s+[\w.,\s]+|const|noexcept|override|final|mutable)*\s*(\{.*)?$/.exec(text);
  if (signature !== null && !CALLABLE_NAME_STOP_WORDS.has(signature[1]!)) {
    const opensHere = signature[2] !== undefined;
    const opensNext = !opensHere && next !== undefined && /^\s*\{/.test(next) && !/;\s*$/.test(text);
    if (opensHere || opensNext) return signature[1];
  }
  return undefined;
}

/** True when a declaration line carries body text after its opener — a one-liner (`{ return x; }`, `=> x`, `def f(x): return x`). */
export function declarationCarriesInlineBody(text: string): boolean {
  const code = text.replace(/\s(?:\/\/|#).*$/u, "");
  const brace = code.lastIndexOf("{");
  if (brace >= 0) return /[^\s}]/u.test(code.slice(brace + 1));
  const arrow = code.indexOf("=>");
  if (arrow >= 0) return /\S/u.test(code.slice(arrow + 2));
  return /\)\s*(?:->\s*[^:]+)?:\s*\S/u.test(code);
}

/** A served line that is part of a body: not blank, not comment / docstring only, not bare punctuation. */
export function isCallableBodyLine(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed === "" || /^(?:\/\/|#|\/\*|\*|--|"""|''')/u.test(trimmed)) return false;
  return /[^\s{}()[\];,]/u.test(trimmed);
}

/** Per-path declaration scans, reused while the file content is unchanged (bounded). */
export const callableDeclarationCache = new Map<string, { readonly content: string; readonly declarations: readonly CallableDeclaration[] }>();

export const MAX_CALLABLE_DECLARATION_CACHE = 64;

export function callableDeclarationsIn(relPath: string, content: string): readonly CallableDeclaration[] {
  const cached = callableDeclarationCache.get(relPath);
  if (cached !== undefined && cached.content === content) return cached.declarations;
  const lines = content.split(/\r?\n/);
  // A trailing newline is not a phantom last line (the eval-0927 N+1 class):
  // `bound` must never name a line the file does not have.
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  const found: Array<{ name: string; line: number; indent: number }> = [];
  for (let index = 0; index < lines.length; index++) {
    const text = lines[index]!;
    if (text.trim() === "" || /^\s*(?:\/\/|#|\/\*|\*)/u.test(text)) continue;
    let nextIndex = index + 1;
    while (nextIndex < lines.length && lines[nextIndex]!.trim() === "") nextIndex++;
    const name = callableDeclaredOnLine(text, lines[nextIndex]);
    if (name !== undefined) found.push({ name, line: index + 1, indent: text.length - text.trimStart().length });
  }
  const declarations = found.map((declaration, position) => ({
    name: declaration.name,
    path: relPath,
    line: declaration.line,
    bound: found.slice(position + 1).find((other) => other.indent <= declaration.indent)?.line ?? lines.length + 1,
  }));
  if (callableDeclarationCache.size >= MAX_CALLABLE_DECLARATION_CACHE) {
    const oldest = callableDeclarationCache.keys().next().value;
    if (oldest !== undefined) callableDeclarationCache.delete(oldest);
  }
  callableDeclarationCache.set(relPath, { content, declarations });
  return declarations;
}

/**
 * The unshown bodies `buildReadinessObligations` found for a result, so
 * `nextCallForUnresolved` can name the exact read that shows them instead of
 * a name search (which returns the call sites, not the body).
 */
export const unshownCallableBodiesByResult = new WeakMap<TaskPackResult, readonly CallableDeclaration[]>();

export function surfaceContainsToken(surface: TaskPackSurface, token: string | undefined): boolean {
  if (!token) return false;
  const haystack = `${surface.path}\n${surface.symbol ?? ""}\n${servedSurfaceText(surface)}`.toLowerCase();
  return haystack.includes(token.toLowerCase());
}

/**
 * `surfaceContainsToken` for a QUERY FACET (`requiredQueryFacets`: a quoted or
 * slash-joined token of the question): a whole-token occurrence, camelCase-
 * segment aware, over the same haystack. 2026-11 (external A/B of v0.16.4,
 * express `res.redirect('back')`): the substring test proved the `'back'`
 * facet through `callback` and certified `behavior-body` over three unrelated
 * sibling bodies.
 */
export function surfaceContainsFacet(surface: TaskPackSurface, facet: string | undefined): boolean {
  if (!facet) return false;
  return wholeTokenOccursIn(`${surface.path}\n${surface.symbol ?? ""}\n${servedSurfaceText(surface)}`, facet);
}

// Body/symbol-scoped variant for PROOF obligations (2026-07-16a review round
// 2): a wiring producer/consumer is proved only by served CODE (or the
// symbol's own identity) containing the endpoint token — never by the file
// PATH alone; two token-free bodies inside token-named files certified
// edit-ready under the path-inclusive check. surfaceContainsToken (above)
// stays for facet COVERAGE checks, where a file dedicated to the facet is
// weak-but-acceptable evidence.
export function surfaceBodyContainsToken(surface: TaskPackSurface, token: string | undefined): boolean {
  if (!token) return false;
  const haystack = `${surface.symbol ?? ""}\n${servedSurfaceText(surface)}`.toLowerCase();
  return haystack.includes(token.toLowerCase());
}

/**
 * Proof source for finite named requirements. Kept pure and exported so the
 * complete-vs-partial authority boundary is regression-testable without
 * coupling the test to route/certificate rendering.
 */
export function isWholeAuthoritySurface(surface: TaskPackSurface, workspace?: string): boolean {
  if (surface.content_completeness === "partial" || (surface.remaining_ranges?.length ?? 0) > 0) return false;
  const range = /^(\d+)-(\d+)$/.exec(surface.range);
  if (range === null || Number(range[1]) !== 1) return false;
  const content = workspace === undefined ? undefined : readCached(workspace, surface.path);
  const total = content === undefined
    ? servedSurfaceText(surface).replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n").length
    : countLines(content);
  return Number(range[2]) >= total;
}

export const LITERAL_SURFACE_DUTY_MANIFEST_BASENAMES: ReadonlySet<string> = new Set([
  "package.json",
  "pyproject.toml",
  "cargo.toml",
  "go.mod",
  "pom.xml",
  "composer.json",
  "gemfile",
  "build.gradle",
  "build.gradle.kts",
]);

export function literalSurfaceDutyMatchesPath(surfacePath: string, facet: string): boolean {
  const lowerFacet = facet.toLowerCase();
  const basenameLower = path.basename(surfacePath).toLowerCase();
  if (lowerFacet === "manifest") {
    return LITERAL_SURFACE_DUTY_MANIFEST_BASENAMES.has(basenameLower);
  }
  if (lowerFacet === "docs" || lowerFacet === "documentation") {
    return /^(?:readme|changelog|contributing)(?:\.|$)/iu.test(basenameLower)
      || /(?:^|\/)docs?(?:\/|$)/iu.test(surfacePath);
  }
  return false;
}

export function literalSurfaceDutyEvidence(
  served: readonly TaskPackSurface[],
  facet: string,
): TaskPackSurface[] {
  return served.filter((surface) =>
    surfaceContainsToken(surface, facet)
    || literalSurfaceDutyMatchesPath(surface.path, facet));
}

/**
 * B1d (2026-08-01 retrieval-scope): does this line CALL a collaborator named
 * for `facet`?
 *
 * The two shapes that matter, language-agnostically:
 *   - the facet names the RECEIVER: `shippingService.requestLabel(...)`,
 *     `shipping_client->send(...)`, `Shipping::quote(...)`;
 *   - the facet names the CALLED MEMBER: `carrier.shippingQuote(...)`.
 *
 * Both are behavior; a bare mention (`total += shippingCost;`, a field
 * declaration, a comment) is not. Deliberately a line-shape test, never a
 * project vocabulary list.
 */
export function isFacetCallSiteLine(source: string, facet: string): boolean {
  const escaped = facet.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const ident = "[A-Za-z0-9_$]*";
  const receiver = new RegExp(`${ident}${escaped}${ident}\\s*(?:\\.|->|::)\\s*[A-Za-z_$][A-Za-z0-9_$]*\\s*\\(`, "i");
  const member = new RegExp(`(?:\\.|->|::)\\s*${ident}${escaped}${ident}\\s*\\(`, "i");
  return receiver.test(source) || member.test(source);
}

/**
 * W9 (2026-08-22): `query` is scrubbed of generic path spans FIRST. Without
 * it, `slashGroups` below — a `/`-joined 2-3-segment scan meant for a real
 * collaborator reference like "wire up shipping/rate-quote" — matched EVERY
 * consecutive segment run of an absolute path mentioned in prose (confirmed
 * live: "...in /Users/…/TokenLighten/packages/mcp-server/src how does X
 * work" produced facets `users,takayuki,git,tokenlighten,packages,mcp-server`).
 * Each returned facet becomes a REQUIRED query facet for the `behavior-body`
 * obligation (buildReadinessObligations' BEHAVIOR_QUERY_RE branch) —
 * directory names can never appear as a call-site token in any real source
 * file, so an unrelated path mention permanently blocked `behavior-body`
 * from ever proving, even when the actual behavior WAS fully served. A short
 * bare reference ("shipping/rate-quote", "@scope/pkg" — one separator) is
 * unaffected; only an anchored or >=3-segment span is stripped.
 */
export function requiredQueryFacets(query: string): string[] {
  const cleaned = stripPathSpans("", query);
  const slashGroups = [...cleaned.matchAll(/([A-Za-z][A-Za-z0-9_-]{2,})\s*\/\s*([A-Za-z][A-Za-z0-9_-]{2,})(?:\s*\/\s*([A-Za-z][A-Za-z0-9_-]{2,}))?/g)]
    .flatMap((match) => match.slice(1).filter((value): value is string => Boolean(value)));
  const quoted = [...cleaned.matchAll(/[`"']([A-Za-z_][A-Za-z0-9_.:-]{2,})[`"']/g)].map((match) => match[1]!);
  return [...new Set([...slashGroups, ...quoted].map((value) => value.toLowerCase()))].slice(0, 6);
}

/**
 * F-V13-6 (2026-08-30, v0.13.0 external-verification P0-B): THE FINITE
 * PLAIN-PROSE CHECKLIST.
 *
 * A query can name several things that must each be accounted for without
 * using any of the four vocabularies the proof model already recognizes:
 * `requiredQueryFacets` extracts only quoted/backticked/slash-joined tokens,
 * `explicitCodeIdentifiers` only code-SHAPED ones, `BEHAVIOR_QUERY_RE` only
 * behavior wording, and v0.13's obligation ledger only fires behind
 * `hasOpenUniverseIntent` (quantifiers: "every caller", "すべての", "列挙").
 * "…what it does with clipboard, autosave, telemetry and shortcuts" is none of
 * those, so nothing in the proof model represented it and the certificate was
 * vacuously complete — the reported defect (an `act.answer` over a head slice
 * of a long file, reproduced here in its essential form: served bytes that
 * cover none of the enumerated items).
 *
 * WHAT COUNTS AS AN ENUMERATION, and why each rule is here. Only ONE new
 * judgment is added: is this prose a LIST of short noun phrases?
 *
 *  1. SEPARATORS are commas (ASCII and CJK), semicolons, the ideographic
 *     middle dot, EN "and"/"or", JA "や", and line-leading bullets/numbering.
 *     NOT "/" — slash groups are `requiredQueryFacets`' own axis, and treating
 *     a path-shaped span as a three-item list is exactly the W9 regression
 *     that once poisoned every facet on this file.
 *  2. AN ITEM IS A SHORT NOUN PHRASE: at most two words (after a leading
 *     determiner) and 32 characters. This is the rule that separates a list
 *     from ordinary clause prose — "when the panel loads, the store is read
 *     and the bus is bound" splits into three items, and every one of them is
 *     a clause with a verb, so none qualifies and nothing is minted.
 *  3. THE LEADING ITEM IS EXEMPT FROM (2) VIA ITS TAIL, because it carries the
 *     sentence's whole preamble ("explain what the settings panel does with
 *     clipboard"). Its last two words are re-tried as the noun phrase, which
 *     is where the first enumerated head actually sits — in both languages
 *     tested. The exemption is deliberately NOT extended to the other items:
 *     that is what keeps rule (2) load-bearing against clause prose.
 *  4. AT LEAST TWO NON-LEADING items must qualify, and at least three facets
 *     must survive in total. Two items are never an enumeration; three are.
 *  5. AN ITEM'S FACET IS ONE content-bearing LATIN token of it — the longest
 *     for a genuine list item, the LAST one for the leading segment's re-tried
 *     tail (see `enumerationItemFacet`). A facet must be provable against
 *     served text, and a purely ideographic item ("環境変数") can never appear
 *     literally in code — minting it would create a permanently unprovable
 *     obligation, which is over-strictness, not rigor. Japanese enumerations
 *     therefore contribute exactly the identifier-shaped items they name.
 *  6. ANYTHING THE EXISTING ROUTES ALREADY OWN IS DROPPED — a backticked or
 *     code-shaped item already has its own obligation, and two obligations
 *     over one requirement is double-counting, not extra proof.
 */
export const ENUMERATED_ITEM_OBLIGATION_PREFIX = "enumerated-item:";

/** Distinct facets required before a prose list is treated as an enumeration. */
export const ENUMERATED_QUERY_MIN_FACETS = 3;

/** Upper bound on minted enumerated obligations (cf. requiredQueryFacets' own cap). */
export const ENUMERATED_QUERY_MAX_FACETS = 8;

/** Shortest token carrying enough signal to look for in served code. */
export const ENUMERATED_FACET_MIN_CHARS = 3;

/** Words / characters an item may have and still read as a noun phrase, not a clause. */
export const ENUMERATED_ITEM_MAX_WORDS = 2;

export const ENUMERATED_ITEM_MAX_CHARS = 32;

/** Function words that carry no retrieval signal, so never a facet on their own. */
export const ENUMERATED_ITEM_STOPWORDS: ReadonlySet<string> = new Set([
  "the", "and", "but", "for", "its", "this", "that", "these", "those", "with", "from", "into",
  "than", "then", "what", "which", "who", "why", "does", "did", "are", "was", "were", "will",
  "would", "should", "could", "must", "may", "can", "not", "use", "uses", "used", "using", "via",
  "per", "any", "some", "other", "others", "same", "new", "old", "only", "just", "also", "etc",
  "more", "most", "each", "every", "all", "one", "two", "three", "four", "five", "six",
]);

/**
 * NUL, deliberately: a word-shaped sentinel (" enum ") would itself be split
 * by a query that happens to contain that word. NUL cannot occur in a request
 * the transport delivers, and it is already this file's join separator
 * elsewhere. Written as an escape so the source stays NUL-free.
 */
export const ENUMERATION_LIST_MARKER_RE = /(?:^|\n)[ \t]*(?:[-*•]|\(?\d{1,2}[.)])[ \t]+/gu;

export const ENUMERATION_SEPARATOR_RE = /[,;、，・]|\band\b|\bor\b|や/giu;

export const ENUMERATION_LEADING_DETERMINER_RE = /^(?:the|a|an|its|their|this|that|these|those)\s+/i;

export const ENUMERATION_LEADING_KEYWORD_RE = /^(?:including|include|includes)\s+/iu;

export interface EnumeratedQueryItem {
  facet: string;
  id: string;
  start: number;
  end: number;
}

/**
 * The facet an item contributes, or undefined when it is not a short noun
 * phrase.
 *
 * `pick` is the difference between the two callers, and it is not cosmetic. A
 * genuine list item is a noun phrase whose most distinctive word carries the
 * requirement ("autosave timer" -> autosave), so it takes the LONGEST token.
 * The leading segment's re-tried tail is the end of a SENTENCE ("…decides
 * allow"), where the enumerated head is the last word and everything before it
 * is the verb — taking the longest there mints the verb as a requirement,
 * observed live against replayCorpus's `resolveAccessPolicy decides allow,
 * deny, or needs-review` entry, which then could never prove.
 */
export function enumerationItemFacet(item: string, pick: "longest" | "last" = "longest"): string | undefined {
  // 2026-10-06 independent review (P2-1): an explanation aspect ("edge
  // cases") or a facet / answer-kind noun ("callers", "cases") names the KIND
  // of answer, never a word a served body must spell — as an item it minted
  // `enumerated-item:…:cases`, provable only by accident.
  const phrase = maskExplanationAspectPhrases(item).trim().replace(ENUMERATION_LEADING_DETERMINER_RE, "");
  if (phrase.length === 0 || phrase.length > ENUMERATED_ITEM_MAX_CHARS) return undefined;
  if (phrase.split(/\s+/).length > ENUMERATED_ITEM_MAX_WORDS) return undefined;
  // Internal hyphens are part of the token: "needs-review" is one enumerated
  // item, and splitting it into "needs"/"review" both loses the requirement and
  // weakens the substring match that proves it.
  const tokens = (phrase.match(/[A-Za-z_$][A-Za-z0-9_$]*(?:-[A-Za-z0-9_$]+)*/g) ?? [])
    .map((token) => token.toLowerCase())
    .filter((token) =>
      token.length >= ENUMERATED_FACET_MIN_CHARS
      && !ENUMERATED_ITEM_STOPWORDS.has(token)
      && !READINESS_PROBE_GENERIC_TOKENS.has(token)
      && !isFacetDescriptorTerm(token));
  if (tokens.length === 0) return undefined;
  return pick === "last"
    ? tokens[tokens.length - 1]!
    : tokens.reduce((best, token) => (token.length > best.length ? token : best));
}

/**
 * Exported for its own regression pin (enumeratedItemObligation.spec.ts),
 * matching the precedent set by `advanceExecutedLocateNextCall` and
 * `repairSuppressedNextCall`: a shape-classification heuristic whose
 * false-positive boundary is the whole risk is worth testing directly, not
 * only through six layers of pack assembly.
 */
export function enumeratedItemFacetFromId(id: string): string | undefined {
  if (!id.startsWith(ENUMERATED_ITEM_OBLIGATION_PREFIX)) return undefined;
  const rest = id.slice(ENUMERATED_ITEM_OBLIGATION_PREFIX.length);
  const separator = rest.indexOf(":");
  return separator < 0 ? rest || undefined : rest.slice(separator + 1) || undefined;
}
