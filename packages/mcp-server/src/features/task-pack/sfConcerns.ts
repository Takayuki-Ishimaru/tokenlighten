// Structural concern extraction — Semantic Frontier v2, WS4 / W-CONCERNS.
// Canonical design: DESIGN-v0.15-semantic-frontier-plan.md §3.6 (extraction),
// §3.2 (the schema the SF state adapter seeds obligations from), §6.1
// U-1/U-2/U-3 (the test tables), §11 Wave 3.
//
// WHAT CHANGED, IN ONE SENTENCE (decision D3): a concern is now grounded in
// STRUCTURE — an address the caller named, a `Class::method` a resolver
// located, an identifier the symbol index resolved, a path in the request —
// and the legacy regex vocabulary (`compileConcerns`, semanticFrontier.ts:65)
// survives only as an ADVISORY tier that can neither close a task nor block
// another concern. Engagement therefore stops depending on how a request is
// phrased, which is the single defect the v0.14 paid run isolated
// (DESIGN-v0.14-plan.md:120).
//
// PURITY. Every function here is total and deterministic over its arguments.
// Nothing touches the filesystem, the clock, the network, or module state: the
// two capabilities that would need the workspace — resolving `Class::method`
// and resolving a bare identifier — are INJECTED (`anchorResolver`,
// `workspaceIndex`), so the whole table is testable without a workspace, and
// the one integration test that does drive the real D5 resolver proves the
// injection point is honest rather than convenient.
//
// FLAG FENCE (plan §4.4). `extractStructuralConcerns` returns `[]` as its
// first statement when `TL_SF_STRUCTURAL_CONCERNS` is off. W-SATISFACTION
// added the FIRST production call site (`readCodeTaskPack.ts`'s task_pack
// seam), which guards the call on the same flag a second time and routes the
// result into a `WeakMap` side table that no serializer can reach — so
// flag-off wire bytes stay unreachable by construction, and flag-ON wire bytes
// are unchanged too until W-DEMOTE/W-NEXT consume that table. The importer
// guard in `sfConcerns.spec.ts` is now an ALLOWLIST naming exactly those
// importers, so a fourth one still fails the build.
//
// NOT HERE, DELIBERATELY: ranking (§3.5), satisfaction accounting (§3.3),
// `next` arbitration (§10.0), and anything that writes IR state. This module
// produces concern SEEDS and stops.

import { createHash } from "node:crypto";
import type { ObligationOrigin } from "@tokenlighten/types";
import type { SfConcernInput } from "../../task-state/sfState.js";
import { sfStructuralConcernsEnabled } from "../../util/flags.js";
import { stripPathSpans, tokenizeQuery } from "../../util/queryShape.js";
import { advisoryQueryAnchors, advisoryRegexConcerns } from "./semanticFrontier.js";
import { detectDisposition, obligationDisposition, type SfDisposition } from "./sfDisposition.js";
import { resolveIntent, type IntentDecision } from "./sfIntent.js";

export type { SfDisposition } from "./sfDisposition.js";

// ---------------------------------------------------------------------------
// Bounds (plan §3.2.2)
// ---------------------------------------------------------------------------

/** Half of `IRV2_OBLIGATIONS_MAX`; the rest stays available to existing checks. */
export const SF_CONCERN_MAX = 16;
/** Mirrors `MAX_QUALIFIED_ANCHORS` (readCodeTaskPack.ts:13975). */
export const SF_QUALIFIED_ANCHOR_MAX = 3;
/** Query tokens offered to the symbol index in one call. */
const SF_IDENTIFIER_TOKENS_MAX = 12;
/** Concerns one call may derive from bare identifiers. */
const SF_IDENTIFIER_CONCERNS_MAX = 6;
/** Path anchors honored from one query. */
const SF_PATH_ANCHOR_MAX = 6;
/** Bare `<name>.<ext>` filename tokens resolved through the index per query (D6). */
const SF_BASENAME_ANCHOR_MAX = 4;
/** Same-basename candidates carried on ONE ambiguous concern (D6, ruling (cc)). */
const SF_BASENAME_CANDIDATES_MAX = 8;
/** Bindings recorded per concern. */
const SF_BINDINGS_MAX = 8;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * What the concern is ABOUT. `definition`/`declaration`/`usage` come from
 * symbol structure, `relation` from an endpoint pair, `template`/`generated`
 * from path role, and `verify`/`answer` from the disposition a grounded anchor
 * inherited.
 */
export type SfConcernKind =
  | "definition"
  | "declaration"
  | "usage"
  | "relation"
  | "template"
  | "generated"
  | "verify"
  | "answer";

/** Where the concern came from. `advisory-regex` is the retired D3 tier. */
export type SfConcernSource = "structural" | "explicit-target" | "advisory-regex";

/**
 * The address (or lexical token) the concern hangs on. `verb` is the ONLY
 * ungrounded anchor kind: it names a vocabulary token rather than an address,
 * and a concern anchored on one is always advisory.
 */
export type SfConcernAnchor =
  | { readonly kind: "symbol"; readonly symbol: string }
  | {
    readonly kind: "qualified";
    readonly qualified: string;
    readonly qualifier: string;
    readonly member: string;
  }
  | { readonly kind: "path"; readonly path: string }
  // D6 (FX-R3b, 2026-09-04): a token that LOOKS addressable but resolves to no
  // workspace address — `wiring/imports` in the real SF05 query, a bare
  // filename with several or zero same-basename matches. It is deliberately
  // NOT a `path` anchor: `path` means "this file", and a concern carrying a
  // path anchor bound to a non-existent address is exactly the grounding
  // masquerade D3 retired the vocabulary for.
  | { readonly kind: "literal"; readonly literal: string }
  | { readonly kind: "verb"; readonly verb: string };

/**
 * The fields the SF state adapter seeds an `ObligationNode` from.
 *
 * NO LONGER A DUPLICATE. W-CONCERNS declared this shape locally because the
 * state adapter was import-fenced to `src/task-state/` for one wave; the
 * duplicate's only purpose was to avoid breaking that fence early, and its
 * only risk was the two drifting apart. W-SATISFACTION is the wave that wires
 * the two modules together, so the alias now points at the adapter's own
 * `SfConcernInput` and drift is impossible by construction: a field added
 * there is a field required here, and `tsc` says so.
 */
export type SfConcernSeed = SfConcernInput;

export interface SfStructuralConcern extends SfConcernSeed {
  readonly kind: SfConcernKind;
  readonly anchor: SfConcernAnchor;
  readonly disposition: SfDisposition;
  /** True iff `origin === "heuristic"`; an advisory concern closes and blocks nothing (I-3). */
  readonly advisory: boolean;
  /** True iff the caller named this address, or a resolver grounded a definition for it. */
  readonly required: boolean;
  /** Workspace-relative paths this concern is bound to. Empty means ungrounded. */
  readonly bindings: readonly string[];
  readonly source: SfConcernSource;
  /** Set when `profile:"answer"` forbade the disposition the verb asked for. */
  readonly dispositionDowngradedFrom?: SfDisposition;
  /**
   * D6 (FX-R3b): the same-basename workspace paths a bare filename token
   * matched when NO single one dominates. Carried so the arbiter can surface
   * them as `await_input` candidates (ruling (cc) / AGENTS.md "several
   * candidates and none dominates => await_input with candidates") instead of
   * dead-ending on a basename it cannot bind. Never a binding: an ambiguous
   * concern grounds nothing.
   */
  readonly candidates?: readonly string[];
  /**
   * D6 (FX-R3b): the caller named a plausible filename the workspace does not
   * contain. An honest DISCLOSURE, not a silent drop — the concern stays
   * advisory and closes nothing.
   */
  readonly absent?: true;
  /**
   * D8 (FX-R3c, 2026-09-04): the tri-state answer to "is this concern's path
   * anchor a workspace FILE?", as PROVEN by the injected index at extraction
   * time.
   *
   *   `true`      an address a read can actually serve — the caller-named file
   *               D8 joins to the pack frontier of the SAME call, and the
   *               address DC2 targets when a cap prevented serving its body.
   *   `false`     PROVEN not a servable file: a DIRECTORY (the auto-narrowed
   *               `scope_inferred` subtree arrives here as an
   *               `explicit-target` path concern), or a path the index says
   *               does not exist. `selectCanonicalNext` skips such a concern
   *               rather than minting `read_file targets:[{path:<dir>}]` or a
   *               `search_files references` whose query TERM is a directory —
   *               the exact call the sealed SF05 replay produced.
   *   `undefined` UNKNOWN — no index was injected, or the anchor is not a
   *               path. Every pre-D8 behaviour is preserved on this value, so
   *               a caller that injects no workspace index keeps exactly its
   *               old concern set and its old arbitration.
   */
  readonly fileAnchor?: boolean;
}

/** A `Class::method` pair, exactly as the D5 machinery spells one. */
export interface SfQualifiedAnchor {
  readonly raw: string;
  readonly qualifier: string;
  readonly member: string;
}

/**
 * What a resolver found for one qualified anchor. Mirrors
 * `QualifiedAnchorResolution` (readCodeTaskPack.ts:14066).
 *
 * FX-W2 (round-21B finding 2, root cause part A): this type used to also
 * carry an optional `usages` field — a call-site channel §3.6.1 rule 2
 * described as opening a `relation` concern on its own. The real D5 resolver
 * (`resolveQualifiedSymbolAnchors`, readCodeTaskPack.ts) never populated it —
 * it collapses every non-definition/non-declaration mention of the anchored
 * member into `candidatePaths` without keeping the distinction a "usage"
 * would need — so that trigger was dead code in every production call,
 * regardless of query phrasing. Removed rather than wired: see this file's
 * `extractConcerns`, branch (2)'s own comment, and the module-level FX-W2
 * note for what replaced it.
 */
export interface SfAnchorResolution {
  readonly definitions?: readonly string[];
  readonly declarations?: readonly string[];
  readonly counterparts?: readonly string[];
}

/** Injected workspace capability. Total: it may return nothing for anything. */
export type SfAnchorResolver = (anchor: SfQualifiedAnchor) => SfAnchorResolution | undefined;

export interface SfWorkspaceIndex {
  /** Definition sites of a BARE identifier. One path = unique = groundable. */
  readonly definitionPathsFor?: (identifier: string) => readonly string[];
  /** Whether a workspace-relative path exists. Absent means UNKNOWN, never "no". */
  readonly hasPath?: (relPath: string) => boolean;
  /**
   * D6 (FX-R3b): every workspace-relative path whose BASENAME equals
   * `basename` (case-insensitively), bounded. Absent means the caller has no
   * such index, and the bare-filename rule then opens nothing at all — so a
   * caller without this capability keeps exactly its pre-D6 concern set.
   */
  readonly pathsForBasename?: (basename: string) => readonly string[];
  /** Existing role classification for a path, when the caller has one. */
  readonly roleFor?: (relPath: string) => "template" | "generated" | undefined;
  /** The other half of a template/generated pair, when one exists. */
  readonly counterpartsFor?: (relPath: string) => readonly string[];
}

/** One caller-declared address, in the shapes `read_file` accepts. */
export interface SfExplicitTarget {
  readonly path?: string;
  readonly symbol?: string;
  readonly handle?: string;
  /**
   * DESIGN-v0.15-sf-intent-layers.md §4.3. A caller-addressed line range —
   * like `handle`, proof this target is already a fully-specified READ
   * request, not an open relation for the server to resolve. `resolveIntent`
   * (sfIntent.ts) treats either field as the same veto over `relational`.
   */
  readonly range?: string;
}

export interface SfConcernExtractionInput {
  /** The verbatim request text. */
  readonly query: string;
  /** `targets[]` as the caller wrote them. ORDER IS LOAD-BEARING (I-2, §3.4). */
  readonly targets?: readonly (string | SfExplicitTarget)[];
  /** The BOUND profile. `"answer"` forbids edit dispositions (§3.6.2). */
  readonly profile?: string;
  /**
   * DESIGN-v0.15-sf-intent-layers.md §4.1. `ALLOW_WRITE` (server.ts:452).
   * Omitted (`undefined`) defaults to permissive (`true`) so every existing
   * caller that predates this field — direct `buildTaskPack` calls in tests,
   * chiefly — keeps its exact prior behavior; `readCodeTaskPack.ts` threads
   * the real flag through `TaskPackArgs.writeAllowed`.
   */
  readonly writeAllowed?: boolean;
  /**
   * DESIGN-v0.15-sf-intent-layers.md §4.4(a). True when this TASK's
   * `executedLocates` ledger (util/packServeLog.ts's `hasExecutedSearchAction`,
   * keyed `"references"`) already recorded a `references` call — a fact
   * about cross-call session state this module may not read directly (see
   * the purity note at the top of this file), so the caller injects it, the
   * same way `writeAllowed` is injected rather than read from `ALLOW_WRITE`
   * here. Omitted defaults to `false` (no observation).
   */
  readonly referencesObserved?: boolean;
  /** §4.2 (IL-W2): this task already landed an edit through `guardExecutionEdit`. Injected by the caller (session state), never read here. Omitted = `false`. */
  readonly editObserved?: boolean;
  readonly workspaceIndex?: SfWorkspaceIndex;
  readonly anchorResolver?: SfAnchorResolver;
}

// ---------------------------------------------------------------------------
// Anchors
// ---------------------------------------------------------------------------

/**
 * MIRRORS `qualifiedSymbolAnchors` (readCodeTaskPack.ts:13986) — same pattern,
 * same innermost-pair rule, same bound. It is copied rather than imported
 * because pulling the 28k-line pack module into a leaf helper would create a
 * cycle the moment W-SATISFACTION wires this file back into it. The copy is
 * not free-floating: `sfConcerns.spec.ts` asserts token-for-token parity
 * against the exported original over a shared corpus, so a change made to one
 * and not the other fails the build.
 */
const QUALIFIED_ANCHOR_RE = /\b([A-Za-z_][A-Za-z0-9_]*)::([A-Za-z_][A-Za-z0-9_]*)\b(?!::)/g;

export function sfQualifiedAnchors(query: string): SfQualifiedAnchor[] {
  const out: SfQualifiedAnchor[] = [];
  const seen = new Set<string>();
  for (const match of query.matchAll(QUALIFIED_ANCHOR_RE)) {
    const key = match[0]!.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ raw: match[0]!, qualifier: match[1]!, member: match[2]! });
    if (out.length >= SF_QUALIFIED_ANCHOR_MAX) break;
  }
  return out;
}

/** camelCase / snake_case / ALL_CAPS — the shape a caller types an identifier in. */
function isIdentifierShaped(token: string): boolean {
  return /[a-z][A-Z]/.test(token) || token.includes("_") || /^[A-Z0-9]{3,}$/.test(token);
}

/**
 * Identifier-mode tokens of `query`, path spans scrubbed first — the same
 * pipeline `concreteIdentifierTokens` (readCodeTaskPack.ts:12690) and
 * `concernAnchorTokens` (:8762) run on, reached through the shared tokenizer
 * rather than through the pack module.
 */
function identifierTokens(query: string): string[] {
  const cleaned = stripPathSpans("", query);
  const tokens = tokenizeQuery(cleaned, { minLen: 4, stopWords: new Set<string>(), mode: "identifier" });
  const lower = cleaned.toLowerCase();
  const positionOf = (token: string): number => {
    const at = lower.indexOf(token.toLowerCase());
    return at === -1 ? Number.MAX_SAFE_INTEGER : at;
  };
  const unique: string[] = [];
  for (const token of tokens) if (!unique.includes(token)) unique.push(token);
  const ordered = unique.sort((a, b) => positionOf(a) - positionOf(b));
  // Drop camel-hump / underscore FRAGMENTS of a token already accepted: the
  // identifier tokenizer emits both `PLL_LOCK` and `LOCK`, and the fragment
  // names nothing the caller wrote. Same rule `wiringCandidateTokens`
  // (readCodeTaskPack.ts:12915) applies to its own pool, for the same reason.
  const norm = (token: string): string => token.toLowerCase().replace(/[_-]/g, "");
  const kept: string[] = [];
  for (const token of ordered) {
    if (kept.some((earlier) => norm(earlier) !== norm(token) && norm(earlier).includes(norm(token)))) continue;
    kept.push(token);
  }
  return kept.slice(0, SF_IDENTIFIER_TOKENS_MAX);
}

const TEMPLATE_PATH_RE = /(?:^|\/)templates?\/|\.(?:tmpl|template|hbs|mustache|ejs|jinja2?|j2)(?:\.[A-Za-z0-9]+)?$/i;
const GENERATED_PATH_RE = /(?:^|\/)(?:generated|__generated__)\/|\.gen\.|\.g\.[A-Za-z0-9]+$|(?:^|\/)dist\//i;

/**
 * Path role, index first. The built-in patterns are a FALLBACK for a caller
 * that has no classifier; an injected `roleFor` always wins, so the product
 * keeps one classification authority rather than two.
 */
function pathRoleOf(relPath: string, index?: SfWorkspaceIndex): "template" | "generated" | undefined {
  const declared = index?.roleFor?.(relPath);
  if (declared !== undefined) return declared;
  if (TEMPLATE_PATH_RE.test(relPath)) return "template";
  if (GENERATED_PATH_RE.test(relPath)) return "generated";
  return undefined;
}

// ---------------------------------------------------------------------------
// D6 (FX-R3b, 2026-09-04) — BARE FILENAME TOKENS AS PATH ANCHORS
//
// THE DEFECT. `advisoryQueryAnchors`'s path pattern (semanticFrontier.ts)
// requires a `/`, so on the real SF05 query the only token it produced was
// `wiring/imports` — a phrase, not an address — while `CONTRACT.md`, the file
// the caller actually named, produced NOTHING. Rule (4) then bound a concern
// to the address `wiring/imports`, which does not exist, and the pack had no
// grounded concern for the one file it was about. Both halves are fixed here:
//
//   * A bare `<name>.<ext>` token IS an address the caller named; it is
//     resolved through the workspace index BY BASENAME. Exactly one match =>
//     a grounded path anchor bound to that path. Several matches => the
//     concern stays ADVISORY and carries the matches as `candidates`, so the
//     arbiter can surface them (ruling (cc)) instead of dead-ending; a
//     co-mentioned directory/family token ("aeroctl" beside three
//     `.../<family>/CONTRACT.md`) disambiguates to the unique match first.
//     Zero matches => advisory with an `absent` disclosure.
//   * A slash token that is NOT a workspace path and whose basename does not
//     resolve either is classified as a LITERAL (relation) token: no path
//     anchor, no bindings, nothing that can masquerade as grounding.
//
// The whole rule is INERT without the `pathsForBasename` capability, so a
// caller that injects no index keeps exactly its pre-D6 concern set, and the
// module stays pure (the index is injected, never read from disk here).
// ---------------------------------------------------------------------------

/**
 * `<name>.<ext>` typed WITHOUT a directory separator. The lookbehind rejects a
 * token that is part of a slash path (rule (4) owns those) and the lookahead
 * rejects one that continues into a path — but neither rejects a trailing `.`
 * or a CJK bracket/particle, so 「CONTRACT.md」 and `CONTRACT.md を読んで` and a
 * sentence-final `pyproject.toml.` all match exactly the token the caller typed.
 */
const BARE_FILENAME_RE = /(?<![A-Za-z0-9_./\\-])([A-Za-z0-9_][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)*\.([A-Za-z0-9]{1,8}))(?![A-Za-z0-9_/\\-])/g;

/** Tokens per query offered to the basename resolver before any filtering. */
const SF_FILENAME_TOKEN_SCAN_MAX = 8;

/**
 * Extensions plausible enough that a token carrying one and matching NOTHING
 * is worth disclosing as `absent` rather than dropping. A token whose
 * extension is not here still grounds when the index resolves it — the set
 * only decides whether a MISS is reported, so `e.g` in prose opens nothing.
 */
const SF_FILENAME_EXTENSIONS: ReadonlySet<string> = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts", "py", "rb", "go", "rs",
  "java", "kt", "kts", "swift", "c", "h", "hh", "hpp", "hxx", "cc", "cpp",
  "cxx", "cs", "php", "scala", "sh", "bash", "zsh", "bat", "ps1", "sql", "md",
  "markdown", "mdx", "txt", "rst", "adoc", "json", "json5", "yaml", "yml",
  "toml", "ini", "cfg", "conf", "properties", "env", "xml", "html", "htm",
  "css", "scss", "sass", "less", "vue", "svelte", "proto", "graphql", "gradle",
  "lock", "cmake", "mk", "tf", "hcl", "csv", "tsv", "pdf", "docx", "xlsx",
  "pptx", "zip", "ipynb", "lua", "pl", "pm", "ex", "exs", "erl", "hs", "dart",
  "r", "jl", "m", "mm",
]);

/** `[token, extension]` for every bare filename in `query`, deduped, bounded. */
export function sfBareFilenameTokens(query: string): Array<readonly [string, string]> {
  const out: Array<readonly [string, string]> = [];
  const seen = new Set<string>();
  for (const match of query.matchAll(BARE_FILENAME_RE)) {
    const token = match[1]!;
    const key = token.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push([token, match[2]!.toLowerCase()] as const);
    if (out.length >= SF_FILENAME_TOKEN_SCAN_MAX) break;
  }
  return out;
}

const normalizeRel = (value: string): string => value.replace(/\\/g, "/").replace(/^\.\//, "");

/** Directory segments of `relPath`, lowercased — the basename is not one. */
function directorySegments(relPath: string): string[] {
  return normalizeRel(relPath).split("/").slice(0, -1).map((segment) => segment.toLowerCase());
}

/**
 * Word tokens of `query` usable as a FAMILY discriminator ("aeroctl" beside
 * three same-basename `CONTRACT.md` files). Lowercased, >=3 chars, and never
 * a piece of the filename itself — otherwise `contract` would "disambiguate"
 * a `contract/` directory the caller never mentioned.
 */
function familyQueryTokens(query: string): Set<string> {
  const out = new Set<string>();
  for (const match of query.matchAll(/[A-Za-z0-9_-]{3,}/g)) out.add(match[0]!.toLowerCase());
  for (const [token] of sfBareFilenameTokens(query)) {
    for (const piece of token.toLowerCase().split(/[._-]/)) out.delete(piece);
    out.delete(token.toLowerCase());
  }
  return out;
}

interface SfFileTokenResolution {
  /** The single workspace address this token names, when one dominates. */
  readonly path?: string;
  /** Every same-basename match, when more than one exists. */
  readonly candidates: readonly string[];
  /** True iff the index was consulted and answered (i.e. the rule is live). */
  readonly resolved: boolean;
}

/**
 * Resolve one caller-typed file token (bare or slash-bearing) to at most one
 * workspace address. Order: unique basename match, then the token's own path
 * suffix, then a co-mentioned family/directory token. Nothing else — a guess
 * that reaches two candidates stays a choice, not a binding.
 */
function resolveFileToken(
  token: string,
  index: SfWorkspaceIndex | undefined,
  family: ReadonlySet<string>,
): SfFileTokenResolution {
  const lookup = index?.pathsForBasename;
  if (lookup === undefined) return { candidates: [], resolved: false };
  const basename = normalizeRel(token).split("/").at(-1) ?? "";
  if (basename === "") return { candidates: [], resolved: false };
  // COST FENCE. `pathsForBasename` is backed by a workspace walk, and rule (4)
  // reaches here for EVERY slash token the workspace does not contain — most
  // of which are phrases ("wiring/imports", "read/write"). A file token has an
  // extension; a phrase's last word does not, so this skips the walk entirely
  // for the phrase case without changing any resolution rule (4b)'s own tokens
  // always carry one by construction).
  if (!basename.includes(".")) return { candidates: [], resolved: false };
  let matches: readonly string[] = [];
  try {
    matches = lookup(basename) ?? [];
  } catch {
    // I-1: a capability defect degrades this token, never fails the read.
    return { candidates: [], resolved: false };
  }
  const unique = [...new Set(matches.filter((value) => typeof value === "string" && value !== ""))];
  if (unique.length === 0) return { candidates: [], resolved: true };
  if (unique.length === 1) return { path: unique[0]!, candidates: unique, resolved: true };
  const wanted = normalizeRel(token);
  if (wanted !== basename) {
    const bySuffix = unique.filter((value) => {
      const normalized = normalizeRel(value);
      return normalized === wanted || normalized.endsWith(`/${wanted}`);
    });
    if (bySuffix.length === 1) return { path: bySuffix[0]!, candidates: unique, resolved: true };
  }
  // D9 (FX-R3c, 2026-09-04): a segment EVERY candidate shares discriminates
  // nothing. `bench/fixtures/<family>/CONTRACT.md` x5 all carry `bench` and
  // `fixtures`, so a query that happens to spell either one made the family
  // filter match all five and the caller's real discriminator (`aeroctl`) was
  // never reached — the token was ambiguous only because the query was MORE
  // specific, which is the wrong direction. Common segments are dropped first;
  // what remains is the discriminating vocabulary.
  const segmentsOf = unique.map((value) => new Set(directorySegments(value)));
  const shared = new Set<string>(segmentsOf[0] ?? []);
  for (const segments of segmentsOf.slice(1)) {
    for (const segment of [...shared]) if (!segments.has(segment)) shared.delete(segment);
  }
  const scoreOf = (index: number): number => {
    let score = 0;
    for (const segment of segmentsOf[index] ?? []) {
      if (shared.has(segment) || !family.has(segment)) continue;
      score += 1;
    }
    return score;
  };
  const scores = unique.map((_, index) => scoreOf(index));
  const best = Math.max(0, ...scores);
  if (best > 0 && scores.filter((score) => score === best).length === 1) {
    return { path: unique[scores.indexOf(best)]!, candidates: unique, resolved: true };
  }
  return { candidates: unique.slice(0, SF_BASENAME_CANDIDATES_MAX), resolved: true };
}

// ---------------------------------------------------------------------------
// Concern construction
// ---------------------------------------------------------------------------

function anchorValue(anchor: SfConcernAnchor): string {
  switch (anchor.kind) {
    case "symbol":
      return anchor.symbol;
    case "qualified":
      return anchor.qualified;
    case "path":
      return anchor.path;
    case "literal":
      return anchor.literal;
    default:
      return anchor.verb;
  }
}

/**
 * Stable identity: kind + anchor, and nothing else. Two calls that name the
 * same thing produce the same id across processes and across epochs, which is
 * what lets a resumed task recognize a concern it already opened.
 */
export function sfConcernId(kind: SfConcernKind, anchor: SfConcernAnchor): string {
  const digest = createHash("sha256")
    .update(`${kind}|${anchor.kind}|${anchorValue(anchor)}`)
    .digest("hex")
    .slice(0, 16);
  return `sf:${kind}:${digest}`;
}

const CLAIM_PREFIX: Readonly<Record<SfConcernKind, string>> = Object.freeze({
  definition: "definition of",
  declaration: "declaration of",
  usage: "usages of",
  relation: "relation endpoints for",
  template: "template source",
  generated: "generated product",
  verify: "verification for",
  answer: "explanation for",
});

interface ConcernDraft {
  readonly kind: SfConcernKind;
  readonly anchor: SfConcernAnchor;
  readonly source: SfConcernSource;
  readonly bindings?: readonly string[];
  readonly advisory?: boolean;
  readonly required?: boolean;
  readonly disposition?: SfDisposition;
  readonly candidates?: readonly string[];
  readonly absent?: true;
  readonly fileAnchor?: boolean;
}

function buildConcern(
  draft: ConcernDraft,
  disposition: SfDisposition,
  intentDecision: IntentDecision,
): SfStructuralConcern {
  const advisory = draft.advisory === true;
  // I-3, and the irStore decoder, both require `advisory === (origin === "heuristic")`.
  const origin: ObligationOrigin = advisory ? "heuristic" : "source-requirement";
  const wanted = draft.disposition ?? disposition;
  // §3.6.2: a caller-declared read-only task may not be handed an edit.
  // DESIGN-v0.15-sf-intent-layers.md §4.1: nor may ANY task, declared or not,
  // when write is not allowed at all — the same `dispositionDowngradedFrom`
  // disclosure covers both reasons; a caller reading the concern back cannot
  // tell which gate fired, and does not need to (both mean "not this run").
  // `intentDecision` is the ONE `resolveIntent` call `extractConcerns` made
  // for this whole extraction (both gates already folded in there); a
  // per-concern `wanted` disagreeing with it only when `wanted === "edit"`
  // and the shared decision came out otherwise is exactly the downgrade case.
  const downgraded = wanted === "edit" && intentDecision.disposition !== "edit";
  const bindings = [...new Set(draft.bindings ?? [])].slice(0, SF_BINDINGS_MAX);
  const settled: SfDisposition = downgraded ? "review" : wanted;
  return {
    id: sfConcernId(draft.kind, draft.anchor),
    claim: `${CLAIM_PREFIX[draft.kind]} ${anchorValue(draft.anchor)}`,
    origin,
    blockedBy: [],
    predicate: { kind: "any-grounded-evidence" },
    // SF-F8: the four-value IR spelling of the same decision, carried on the
    // seed so `openSfTask`'s `add` op persists it. `answer` folds to `review`
    // (`obligationDisposition`) — the obligation graph has no fifth value.
    nodeDisposition: obligationDisposition(settled),
    kind: draft.kind,
    anchor: draft.anchor,
    disposition: settled,
    advisory,
    // An advisory concern is NEVER required (I-3): it cannot close, so making
    // it required would make the task unclosable on the strength of a signal
    // that is, by construction, only a hint.
    required: advisory ? false : draft.required === true,
    bindings,
    source: draft.source,
    // D6: disclosure fields. `candidates` only ever rides an ADVISORY concern
    // (an unresolved choice grounds nothing); `absent` is the same for a
    // filename the workspace does not contain.
    ...(draft.candidates !== undefined && draft.candidates.length > 0
      ? { candidates: [...new Set(draft.candidates)].slice(0, SF_BASENAME_CANDIDATES_MAX) }
      : {}),
    ...(draft.absent === true ? { absent: true as const } : {}),
    // D8: carried verbatim — `undefined` (unknown) is NOT collapsed to
    // `false`, because "no index answered" and "the index proved it is not a
    // file" have opposite consequences at the arbiter.
    ...(draft.fileAnchor === undefined ? {} : { fileAnchor: draft.fileAnchor }),
    ...(downgraded ? { dispositionDowngradedFrom: "edit" as SfDisposition } : {}),
  };
}

/** How the retired regex vocabulary maps onto a structural kind (D3). */
const ADVISORY_KIND: Readonly<Record<string, SfConcernKind>> = Object.freeze({
  flag: "usage",
  measurement: "usage",
  template: "template",
  generated: "generated",
  relation: "relation",
});

/**
 * D8 (FX-R3c, 2026-09-04) — THE ONE AUTHORITY ON "WHICH FILES DID THE CALLER
 * NAME IN THIS REQUEST?".
 *
 * §3.6.1 rules (4) and (4b) used to spell this resolution INLINE inside
 * `extractConcerns`, which meant the answer existed only after the whole
 * concern set was built — i.e. at the pre-booking seam, long after the pack's
 * surfaces were chosen. D8 needs the same answer BEFORE surface selection, so
 * the caller-named file can join the frontier of the SAME call. Rather than
 * re-deriving it (two authorities that can disagree is exactly the class of
 * defect D3 and F-A1-1 both record), the rule body moved here and
 * `extractConcerns` became its first consumer; `readCodeTaskPack.ts`'s early
 * frontier join is the second, driven by the very same injected index (one
 * memoized workspace walk per call, not two).
 *
 * Order and bounds are unchanged from the inline version: slash-bearing
 * anchors first (`SF_PATH_ANCHOR_MAX`), then bare `<name>.<ext>` tokens
 * (`SF_BASENAME_ANCHOR_MAX`), a token claimed by the first pass never
 * re-claimed by the second, and `namedPaths` (the caller's structured
 * `targets`) suppressing both.
 *
 * PURE. The only workspace knowledge is what `workspaceIndex` answers.
 */
export type SfQueryFileAnchor =
  /** Resolved to ONE workspace address. `proven` = the index confirmed it is a file. */
  | { readonly kind: "path"; readonly token: string; readonly path: string; readonly proven: boolean }
  /** No single address dominates (or none exists) — advisory, with whatever choice there is. */
  | { readonly kind: "literal"; readonly token: string; readonly candidates: readonly string[] }
  /** Filename-shaped, the index answered, and nothing matched — an honest disclosure. */
  | { readonly kind: "absent"; readonly token: string; readonly candidates: readonly string[] };

export function sfQueryFileAnchors(
  query: string,
  workspaceIndex?: SfWorkspaceIndex,
  namedPaths?: ReadonlySet<string>,
): SfQueryFileAnchor[] {
  const out: SfQueryFileAnchor[] = [];
  const family = familyQueryTokens(query);
  const claimedFileTokens = new Set<string>();
  let pathAnchors = 0;
  // (4) Path anchors in the request text.
  for (const anchor of advisoryQueryAnchors(query)) {
    if (anchor.kind !== "path") continue;
    if (pathAnchors >= SF_PATH_ANCHOR_MAX) break;
    if (namedPaths?.has(anchor.raw) === true) continue;
    pathAnchors += 1;
    claimedFileTokens.add(anchor.raw.toLowerCase());
    const known = workspaceIndex?.hasPath?.(anchor.raw);
    if (known === false) {
      // D6: the token has a slash but names no workspace file. Its BASENAME
      // may still name one (`docs/CONTRACT.md` when the file lives at
      // `spec/docs/CONTRACT.md`), so try that before giving up — and if
      // nothing resolves, this is a LITERAL/relation token ("wiring/imports"),
      // never a path binding. Binding a concern to a non-existent address is
      // the grounding masquerade, not a hint.
      const resolution = resolveFileToken(anchor.raw, workspaceIndex, family);
      if (resolution.path !== undefined) {
        out.push({ kind: "path", token: anchor.raw, path: resolution.path, proven: true });
        continue;
      }
      out.push({ kind: "literal", token: anchor.raw, candidates: resolution.candidates });
      continue;
    }
    out.push({ kind: "path", token: anchor.raw, path: anchor.raw, proven: known === true });
  }

  // (4b) D6: bare `<name>.<ext>` filenames — the most common way a caller
  //      names a file, and invisible to rule (4)'s slash-requiring pattern.
  //      Inert without the `pathsForBasename` capability.
  if (workspaceIndex?.pathsForBasename === undefined) return out;
  let basenameAnchors = 0;
  for (const [token, extension] of sfBareFilenameTokens(query)) {
    if (basenameAnchors >= SF_BASENAME_ANCHOR_MAX) break;
    if (namedPaths?.has(token) === true || claimedFileTokens.has(token.toLowerCase())) continue;
    const resolution = resolveFileToken(token, workspaceIndex, family);
    if (resolution.path !== undefined) {
      basenameAnchors += 1;
      out.push({ kind: "path", token, path: resolution.path, proven: true });
      continue;
    }
    if (resolution.candidates.length > 0) {
      // Ruling (cc): several candidates and none dominates — carry them so
      // the arbiter can ask, rather than binding one at random or dropping
      // the concern the caller's own words opened.
      basenameAnchors += 1;
      out.push({ kind: "literal", token, candidates: resolution.candidates });
      continue;
    }
    // Nothing matched. Disclose the miss only for a token that really looks
    // like a filename, so prose ("e.g", "vs.no") opens no obligation.
    if (!resolution.resolved || !SF_FILENAME_EXTENSIONS.has(extension)) continue;
    basenameAnchors += 1;
    out.push({ kind: "absent", token, candidates: [] });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

/**
 * The ordered concerns `query` (plus any caller `targets`) grounds, bounded by
 * `SF_CONCERN_MAX`.
 *
 * ORDER IS THE PRIORITY (plan §3.6.1): explicit targets, then qualified
 * anchors, then index-resolved identifiers, then path anchors, then the
 * disposition's own follow-ups, then — ONLY when nothing above grounded — a
 * single advisory regex concern. The first rule to claim an anchor keeps it:
 * a later rule that would produce the same `(kind, anchor)` is dropped, which
 * is how "explicit targets bind first and are never reordered" is enforced
 * mechanically rather than by review.
 *
 * Returns `[]` when `TL_SF_STRUCTURAL_CONCERNS` is off.
 */
export function extractStructuralConcerns(input: SfConcernExtractionInput): SfStructuralConcern[] {
  if (!sfStructuralConcernsEnabled()) return [];
  return extractConcerns(input);
}

function extractConcerns(input: SfConcernExtractionInput): SfStructuralConcern[] {
  const { query, targets, profile, workspaceIndex, anchorResolver } = input;
  const writeAllowed = input.writeAllowed ?? true;
  // W3, §4.4(b): "resolved" means the SAME anchorResolver capability rule (2)
  // below calls returned at least one definition, declaration, or
  // counterpart for SOME qualified anchor in the query — computed here,
  // ahead of rule (2), purely from `query`/`anchorResolver` (both already in
  // hand), so this stays total/deterministic with no new capability.
  const qualifiedAnchorResolved = sfQualifiedAnchors(query).some((anchor) => {
    const resolution = anchorResolver?.(anchor) ?? {};
    return (
      (resolution.definitions?.length ?? 0) > 0 ||
      (resolution.declarations?.length ?? 0) > 0 ||
      (resolution.counterparts?.length ?? 0) > 0
    );
  });
  // DESIGN-v0.15-sf-intent-layers.md §2/§4.1: the same three-layer decision
  // `readCodeTaskPack.ts`'s profile-binding adjudication reads, so a declared
  // "answer" and a write-disallowed run land on the identical downgrade here
  // as there — one `IntentDecision`, two consumers, never two answers. The
  // concern-KIND classification below still runs off the raw lexical verb
  // (`disposition`, unchanged from before this module existed) — only the
  // edit-permitted GATE (`buildConcern`'s downgrade) and `relational` route
  // through `intentDecision`. `editObserved` is still §4.2 (W2): this call
  // always passes the W1 placeholder (`false`) for it — see `resolveIntent`'s
  // own doc comment. `referencesObserved` (§4.4a) is INJECTED by the caller
  // (session-ledger state this module may not read directly, per this file's
  // purity note); `explicitTargets` carries `targets` through unchanged so
  // `resolveIntent`'s own §4.3 veto (a range/handle target suppresses
  // `relational`) applies here too.
  const intentDecision = resolveIntent({
    declaredProfile: profile === "answer" ? "answer" : profile !== undefined ? "generic" : undefined,
    writeAllowed,
    editObserved: input.editObserved ?? false, // §4.2: injected by the caller (readCodeTaskPack passes getIntentEditObserved)
    referencesObserved: input.referencesObserved ?? false,
    qualifiedAnchorResolved,
    explicitTargets: (targets ?? []).map((entry) => (typeof entry === "string" ? { path: entry } : entry)),
    query,
  });
  const verb = detectDisposition(query);
  const disposition: SfDisposition = verb?.disposition ?? "review";

  const concerns: SfStructuralConcern[] = [];
  const claimed = new Set<string>();
  const push = (draft: ConcernDraft): void => {
    if (concerns.length >= SF_CONCERN_MAX) return;
    const concern = buildConcern(draft, disposition, intentDecision);
    if (claimed.has(concern.id)) return;
    claimed.add(concern.id);
    concerns.push(concern);
  };

  // (1) Explicit addresses. Never reordered, never demoted (I-2).
  const namedPaths = new Set<string>();
  const namedSymbols = new Set<string>();
  for (const entry of targets ?? []) {
    const target: SfExplicitTarget = typeof entry === "string" ? { path: entry } : entry;
    const relPath = typeof target.path === "string" && target.path !== "" ? target.path : undefined;
    const symbol = typeof target.symbol === "string" && target.symbol !== "" ? target.symbol : undefined;
    if (relPath === undefined) {
      // A handle-only target names an address this module cannot spell. The
      // state adapter already records it as a required use, so inventing a
      // path-less concern here would duplicate it, less accurately.
      if (symbol !== undefined) {
        namedSymbols.add(symbol.toLowerCase());
        push({ kind: "definition", anchor: { kind: "symbol", symbol }, source: "explicit-target", required: true });
      }
      continue;
    }
    namedPaths.add(relPath);
    if (symbol !== undefined) namedSymbols.add(symbol.toLowerCase());
    const role = pathRoleOf(relPath, workspaceIndex);
    const kind: SfConcernKind = symbol !== undefined ? "definition" : role ?? "relation";
    // FX-V3 (round-20B finding 4): a target naming BOTH a path and a symbol —
    // the discovery layer's own auto-narrow to a uniquely-resolved bare or
    // qualified-member query — must anchor on the SYMBOL, matching the
    // handle-only branch above (`{ kind: "symbol", symbol }`), never on the
    // path. `sfRelationSeam.ts`'s `anchorFor` only mints a relation packet for
    // a `symbol`/`qualified` anchor (a path anchor names a FILE relation, out
    // of that compiler's scope) — anchoring here on the path instead silently
    // forecloses rule (5)'s disposition follow-up (`verb?.relational===true`)
    // from ever reaching a packet for the query's own resolved symbol, and
    // branch (3)'s bare-identifier path can never step in instead because
    // `namedSymbols` (just above) already claims the name. `bindings` still
    // carries the path, so `evidenceCovers` (sfSatisfaction.ts) keeps closing
    // this concern from a served path exactly as before — only the anchor
    // IDENTITY changes, not what discharges it.
    const anchor: SfConcernAnchor = symbol !== undefined ? { kind: "symbol", symbol } : { kind: "path", path: relPath };
    push({
      kind,
      anchor,
      source: "explicit-target",
      required: true,
      bindings: [relPath],
      // D8 (FX-R3c): a caller "target" is not always a servable FILE. The
      // discovery layer's own auto-narrow publishes the inferred SUBTREE here
      // (`bench/fixtures/<x>/firmware` on the sealed SF05 replay), and a
      // directory is neither a `read_file` target nor a `references` query
      // term. `hasPath` answers `false` for it; absent index = unknown.
      ...(symbol !== undefined ? {} : { fileAnchor: workspaceIndex?.hasPath?.(relPath) }),
    });
  }

  // (2) Qualified `Class::method` anchors, through the injected D5 resolver.
  const qualifiedWords = new Set<string>();
  for (const anchor of sfQualifiedAnchors(query)) {
    qualifiedWords.add(anchor.qualifier.toLowerCase());
    qualifiedWords.add(anchor.member.toLowerCase());
    const resolution = anchorResolver?.(anchor) ?? {};
    const definitions = resolution.definitions ?? [];
    const declarations = [...(resolution.declarations ?? []), ...(resolution.counterparts ?? [])];
    const anchorRef: SfConcernAnchor = {
      kind: "qualified",
      qualified: anchor.raw,
      qualifier: anchor.qualifier,
      member: anchor.member,
    };
    // The definition concern is the required one. An anchor nothing resolved
    // still opens it, but only as advisory: a concern naming a site no
    // resolver could find must not be able to block the task.
    push({
      kind: "definition",
      anchor: anchorRef,
      source: "structural",
      bindings: definitions,
      required: definitions.length > 0,
      advisory: definitions.length === 0,
    });
    if (declarations.length > 0) {
      push({ kind: "declaration", anchor: anchorRef, source: "structural", bindings: declarations });
    }
    // FX-W2 (round-21B finding 2): §3.6.1 rule 2 used to open a `relation`
    // concern here too, from `resolution.usages` — deleted as dead code (see
    // `SfAnchorResolution`'s own doc comment): the real D5 resolver never
    // populated `usages`, so this trigger never fired in production, for any
    // qualified anchor, in any language, regardless of query phrasing. It is
    // superseded, not replaced 1:1: rule (5) below opens the SAME kind of
    // concern, on the SAME anchor, whenever a relational verb matches
    // ANYWHERE in the query — not only when it wins the disposition tie-break
    // (`sfDisposition.ts`'s `detectDisposition`, FX-W2's OR-over-all-matches
    // fix) — which is a live signal for every qualified anchor today, unlike
    // this one ever was.
  }

  // (3) Bare identifiers, grounded ONLY by the symbol index.
  const resolveIdentifier = workspaceIndex?.definitionPathsFor;
  if (resolveIdentifier !== undefined) {
    let opened = 0;
    for (const token of identifierTokens(query)) {
      if (opened >= SF_IDENTIFIER_CONCERNS_MAX) break;
      const lower = token.toLowerCase();
      if (qualifiedWords.has(lower) || namedSymbols.has(lower)) continue;
      const paths = resolveIdentifier(token) ?? [];
      const anchorRef: SfConcernAnchor = { kind: "symbol", symbol: token };
      if (paths.length === 1) {
        push({ kind: "definition", anchor: anchorRef, source: "structural", bindings: paths, required: true });
        opened += 1;
        continue;
      }
      // Ambiguous or unresolved. R4: an ungrounded identifier is advisory, and
      // a token that does not even LOOK like an identifier opens nothing —
      // prose words must not become obligations.
      if (!isIdentifierShaped(token)) continue;
      push({ kind: "usage", anchor: anchorRef, source: "structural", bindings: paths, advisory: true });
      opened += 1;
    }
  }

  // (4) Path anchors in the request text.
  //
  // `pushPathConcern` is the §3.6.1 rule-4 body, factored out so the D6
  // basename rule (4b) below opens the SAME concern shape for an address it
  // resolved — one rule-4 authority, not two.
  const pushPathConcern = (relPath: string, advisory: boolean, fileAnchor?: boolean): void => {
    const role = pathRoleOf(relPath, workspaceIndex);
    const counterparts = advisory ? [] : workspaceIndex?.counterpartsFor?.(relPath) ?? [];
    if (role !== undefined && counterparts.length > 0) {
      // A template/generated PAIR: both halves, each bound to the other.
      const other: SfConcernKind = role === "template" ? "generated" : "template";
      push({
        kind: role,
        anchor: { kind: "path", path: relPath },
        source: "structural",
        bindings: [relPath, ...counterparts],
        advisory,
        ...(fileAnchor === undefined ? {} : { fileAnchor }),
      });
      push({
        kind: other,
        anchor: { kind: "path", path: counterparts[0]! },
        source: "structural",
        bindings: [...counterparts, relPath],
        advisory,
        // A counterpart came out of `counterpartsFor`, which only ever returns
        // paths it proved are files.
        ...(fileAnchor === undefined ? {} : { fileAnchor: true }),
      });
      return;
    }
    // One half only, or no role at all: a single path concern (§3.6.1 rule 4).
    push({
      kind: role ?? "relation",
      anchor: { kind: "path", path: relPath },
      source: "structural",
      bindings: [relPath],
      advisory,
      ...(fileAnchor === undefined ? {} : { fileAnchor }),
    });
  };

  for (const anchor of sfQueryFileAnchors(query, workspaceIndex, namedPaths)) {
    if (anchor.kind === "path") {
      pushPathConcern(anchor.path, false, anchor.proven === true ? true : undefined);
      continue;
    }
    push({
      kind: "relation",
      anchor: { kind: "literal", literal: anchor.token },
      source: "structural",
      advisory: true,
      ...(anchor.candidates.length > 0 ? { candidates: anchor.candidates } : {}),
      ...(anchor.kind === "absent" ? { absent: true as const } : {}),
    });
  }

  // (5) Disposition follow-ups. These ride an anchor something already
  //     grounded — a verb ALONE never creates a concern (D3).
  //
  //     FX-W2 (round-21B finding 2, root cause part B): `verb` comes from
  //     `detectDisposition`, whose `.relational` is now an OR over EVERY
  //     matched vocabulary term in the query, not just the one that won the
  //     disposition tie-break (`sfDisposition.ts`). This is the live path to
  //     a relation concern for a qualified anchor now that rule (2)'s own
  //     `usages`-based trigger is deleted (dead in production regardless):
  //     "explain the callers of X" and "why is X called" open one here even
  //     though "explain"/"why" — not a relational term — wins the
  //     disposition, because the relational term still matched somewhere.
  const primary = concerns[0];
  if (primary !== undefined) {
    // DESIGN-v0.15-sf-intent-layers.md §4.4 (W3): `intentDecision.relational`
    // stays lexical-only in W1 (identical to `verb?.relational` before this
    // module existed) — OR'ing in `referencesObserved`/`qualifiedAnchorResolved`
    // is W3's job, not W1's; see `resolveIntent`'s own doc comment.
    if (intentDecision.relational) {
      push({
        kind: "relation",
        anchor: primary.anchor,
        source: primary.source,
        bindings: primary.bindings,
        advisory: primary.advisory,
      });
    }
    if (disposition === "verify" || disposition === "answer") {
      push({
        kind: disposition,
        anchor: primary.anchor,
        source: primary.source,
        bindings: primary.bindings,
        advisory: primary.advisory,
        disposition,
      });
    }
  }

  // (6) The retired regex vocabulary — the ONLY fallback, and only when
  //     nothing structural grounded (D3, §3.6.1 rule 6). One concern, always
  //     advisory, which by I-3 can neither close the task nor block a peer.
  if (concerns.length === 0) {
    const [legacy] = advisoryRegexConcerns(query);
    if (legacy !== undefined) {
      const spec = legacy.anchors[0];
      const anchor: SfConcernAnchor = spec === undefined || spec.kind === "kind"
        ? { kind: "verb", verb: legacy.kind }
        : spec.kind === "path"
          ? { kind: "path", path: spec.raw }
          : { kind: "symbol", symbol: spec.raw };
      push({
        kind: ADVISORY_KIND[legacy.kind] ?? "relation",
        anchor,
        source: "advisory-regex",
        advisory: true,
      });
    }
  }

  return concerns;
}

// ---------------------------------------------------------------------------
// Read-only helpers for the consumers named in §10.0
// ---------------------------------------------------------------------------

/**
 * Concern kinds whose CLAIM is about bytes (SF-F2). A `definition`, a
 * `template`/`generated` product, a `verify` recipe and an `answer` all assert
 * something about CONTENT, so only direct (body-bearing) evidence may close
 * one. `declaration`, `usage` and `relation` assert something about STRUCTURE
 * — a site exists, a page of references was taken, a packet joined two
 * endpoints — so a structural catalog entry closes them honestly.
 */
const DIRECT_GROUNDED_KINDS: ReadonlySet<SfConcernKind> = new Set<SfConcernKind>([
  "definition",
  "template",
  "generated",
  "verify",
  "answer",
]);

/**
 * The grounding class `sfState.markConcernSatisfied` must enforce for this
 * concern. Exported so the ONE table lives here, beside the kinds it reads,
 * rather than being re-derived at the seam.
 */
export function sfConcernGrounding(kind: SfConcernKind): "direct" | "structural" {
  return DIRECT_GROUNDED_KINDS.has(kind) ? "direct" : "structural";
}

/**
 * `concern_groundedness` (§7.1): the share of concerns whose origin is not
 * heuristic. It is the pre-registered detector for a slide back into
 * vocabulary dependence, so it is computed here rather than re-derived at each
 * call site. An empty set scores 1 — no concern was minted on a guess.
 */
export function concernGroundedness(concerns: readonly SfStructuralConcern[]): number {
  if (concerns.length === 0) return 1;
  const grounded = concerns.filter((concern) => !concern.advisory).length;
  return grounded / concerns.length;
}

/**
 * §3.6.2: a profile the server GUESSED with low confidence may not suppress,
 * demote, or close anything — SF is observation-only for such a call. Exposed
 * here so W-NEXT-ARBITER applies one rule instead of re-deriving the threshold.
 */
export function sfObservationOnly(
  binding?: { readonly source?: string; readonly confidence?: number },
): boolean {
  if (binding === undefined) return false;
  if (binding.source !== "inferred") return false;
  return (binding.confidence ?? 0) < 0.5;
}
