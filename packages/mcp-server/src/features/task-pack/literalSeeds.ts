/**
 * literalSeeds.ts — literal-first seeds for a pathless answer-profile query
 * that names a DISTINCTIVE EXACT LITERAL (2026-11-03; TL_LITERAL_FIRST_SEEDS,
 * default ON — util/flags.ts).
 *
 * Measured on TokenLighten's own repository: "Where is <the tool-surface
 * env var> read and what values does it accept?" (server.ts
 * `resolveToolSurface`; the token itself is not spelled here, so this file
 * never joins its own hit set) ranked the
 * fuzzy candidates first — a bench experiment's `analyze_credits.mjs`, its
 * `run.mjs`, one `server.ts` window — and reached `act.answer` after three
 * turns and 33.6 KB, most of it bench bodies; `tl_search_files find` for the
 * same token found the reading site in 2.7 KB and 0.2 s. Billing on Claude
 * Code is driven by NEW tokens entering context, so a precise first reply is
 * worth far more than a wide one. The same request shape on a flask clone
 * ("What does SESSION_COOKIE_SAMESITE control?") answered from a test file,
 * never from `app.py`'s defaults table or `sessions.py`'s reader.
 *
 * THE RULE. A pathless `query` that ASKS ABOUT a distinctive literal — an
 * UPPER_SNAKE constant or env var (`SESSION_COOKIE_SAMESITE`), a quoted
 * string (`'trust proxy'`, `"cookie-session"`), or a long lowercase dotted key
 * (`tokenlighten.status`, `app.config.from_mapping`) — with a lookup lead
 * ("Where is X read", "What does X control", 「X は何を…」) and no other
 * code-shaped term beside it (`literalIsLookupSubject`) is first run through
 * TL's own find engine (`features/search/find/findText.ts`, the exact
 * `action:"find"` universe). A camelCase or PascalCase identifier is NOT a
 * literal here: it names a declared symbol the locator's symbol layer already
 * finds, and seeding windows around its mentions bypassed the structure map
 * (copilotCompactWorkflow's T03 `OrderOrchestrator` map pages, measured
 * 2026-11-03 while this module was built). Its whole-token hits
 * (askedPathClosure.ts `wholeTokenOccursIn`:
 * `callback` has no `back`) are grouped by file and the files classified:
 * product source ahead of bench/tests/examples/fixtures
 * (readCodeTaskPack.ts `isAuxiliaryTreePath`, the classifier `productPathsFirst`
 * uses) ahead of docs (`isDocLikePath`). When the product-source hits
 * CONCENTRATE in a few files — at most MAX_LITERAL_CODE_FILES of them, and the
 * literal rare in the universe (`literalSourceRarityLimit`) — those files, with
 * windows around their hit clusters, seed the pack through the seeded builder
 * (`buildSeededTaskPack`, `autoDiscoveredLocation:true`): the defining and
 * reading sites arrive in the first reply, with bodies, and the normal
 * readiness, closure and certificate machinery owns the result. One doc window
 * joins when the code seeds are few (flask's `docs/config.rst` entry for a
 * config key). A literal with no code-position hit anywhere (zero hits, a
 * comment-only mention, a changelog line) seeds nothing: today's pack, with
 * its quoted-literal absence reporting, is unchanged. A literal that is not
 * concentrated (more code files than the cap, or more files than the rarity
 * limit) seeds nothing either: that is a "where is it used" inventory, which
 * `find` answers better than a pack.
 *
 * The rule, the scan, the classification and the windows live here; the flag
 * gate, the universe (the prewalk's or one enumeration), the product/auxiliary
 * classifier and the routing site live in readCodeTaskPack.ts
 * (`literalSeedPlanFor`, `buildTaskPackCore`) beside the family-member seeds
 * (familyMemberSeeds.ts), which this module follows in shape.
 */

import { MCP_LANG_EXTS } from "@tokenlighten/types";

import { collectSymbols, type CollectedSymbol } from "../../symbols/collectSymbols.js";
import { languageForPathWithContent } from "../../util/languages.js";
import { readFileForRequest } from "../../util/requestFileCache.js";
import { decodeTextBuffer } from "../../util/textDecode.js";
import {
  FIND_ACTION_EXTRA_EXTS,
  scanLiteral,
  type FindTextUniverse,
  type ScanContentCache,
} from "../search/find/findText.js";
import { isChangelogLikePath, isDocLikePath, quotedFormOccursIn, wholeTokenOccursIn } from "./askedPathClosure.js";
import { hasHashComments, maskNonCode } from "./callerExpansion.js";
import type { TaskPackPathEntry } from "./model.js";
import { extractRequestItems } from "./requestItems.js";

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** Distinctive literals one query may seed from (the first that concentrates leads). */
export const MAX_LITERALS_PER_QUERY = 2;
/**
 * Code files seeded per pack — the pack's own distinct-surface cap
 * (readCodeTaskPack.ts `MAX_SURFACES_DISTINCT`). Every concentrated product
 * file is served: a prose-only mention gets a narrow window, and the
 * request-item engine's remaining candidates are then all auxiliary, which
 * is what lets the first reply certify instead of chasing them.
 */
export const MAX_LITERAL_SEED_FILES = 6;
/** Hit-cluster windows served per file. */
export const MAX_LITERAL_WINDOWS_PER_FILE = 2;
/** Doc windows per pack, and only while the code seeds leave room (`MAX_CODE_FILES_WITH_DOC_SEED`). */
export const MAX_LITERAL_DOC_SEEDS = 1;
export const MAX_CODE_FILES_WITH_DOC_SEED = 2;
/** More code files than this and the literal is an inventory, not a location. */
export const MAX_LITERAL_CODE_FILES = 8;
/** Context lines around a hit cluster that spells the literal in code. */
export const LITERAL_WINDOW_LINES_BEFORE = 12;
export const LITERAL_WINDOW_LINES_AFTER = 8;
/** Context lines around a cluster of prose-only mentions (a doc block naming the env var): the sentence, not the module. */
export const LITERAL_PROSE_WINDOW_LINES = 4;
/** A file this short is served whole: the hit's window would be most of it, and the row then owes nothing. */
export const MAX_WHOLE_FILE_SEED_LINES = 60;
/** Hits this close join one window. */
export const LITERAL_WINDOW_JOIN_LINES = 24;
/** The widest served window; a longer cluster serves its head and the pack's `remaining` owes the rest. */
export const MAX_LITERAL_WINDOW_LINES = 80;
/** Files read to classify code vs comment hits (the cheap pass ranks by whole-token count first). */
export const MAX_LITERAL_FILES_READ = 12;
/** A quoted literal: at least this many characters, at most that many, at most five words. */
export const MIN_QUOTED_LITERAL_CHARS = 3;
export const MAX_QUOTED_LITERAL_CHARS = 64;
export const MAX_QUOTED_LITERAL_WORDS = 5;
/** A quoted SINGLE word this short (`"total"`, `'back'`, `'full'`) is ordinary vocabulary, not a distinctive literal; a phrase (`'trust proxy'`) needs no such floor. */
export const MIN_QUOTED_SINGLE_WORD_CHARS = 6;
/** A lowercase dotted key is distinctive when it is this long or has three segments (`res.redirect` is neither). */
export const MIN_DOTTED_IDENTIFIER_CHARS = 16;
/** Characters of the literal kept in a seed's `purpose` / the advisory. */
const LITERAL_LABEL_CHARS = 40;

// ---------------------------------------------------------------------------
// Distinctive literals in the request
// ---------------------------------------------------------------------------

export type DistinctiveLiteralKind = "quoted" | "constant" | "dotted";

export interface DistinctiveLiteral {
  readonly value: string;
  readonly kind: DistinctiveLiteralKind;
}

/** Every extension the walk or `find` knows, so `tokenlighten.status` is an identifier and `config.rst` a file. */
const KNOWN_FILE_EXTENSIONS: ReadonlySet<string> = new Set<string>([
  ...Object.values(MCP_LANG_EXTS).flat(),
  ...FIND_ACTION_EXTRA_EXTS,
  ".mdx", ".adoc", ".html", ".htm", ".vue", ".svelte", ".lock", ".map", ".d.ts", ".pyi", ".ipynb", ".svg", ".png",
]);

/** `'…'`, `"…"`, `` `…` `` opened and closed at word edges (two possessive apostrophes quote nothing), plus 「…」/『…』. */
const QUOTED_SPAN_RE = /(?<![\w$])(["'`])([^"'`\n]{1,80})\1(?![\w$])|「([^」\n]{1,80})」|『([^』\n]{1,80})』/gu;
/** An UPPER_SNAKE name of two or more segments, not glued to a path or carrying an extension. */
const CONSTANT_RE = /(?<![\w.$/-])[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+(?![\w-]|\.[A-Za-z0-9]{1,5}\b)/g;
/** A lowercase dotted key (`tokenlighten.status`, `app.config.from_mapping`): a config/manifest key or attribute path, never a path segment or a `Class.member`. */
const DOTTED_RE = /(?<![\w./$-])[a-z_][a-z0-9_]*(?:\.[a-z_][a-z0-9_]*)+(?![\w./$-])/g;

function endsWithKnownExtension(term: string): boolean {
  const dot = term.lastIndexOf(".");
  return dot > 0 && KNOWN_FILE_EXTENSIONS.has(term.slice(dot).toLowerCase());
}

function quotedLiteralValue(raw: string): string | undefined {
  const value = raw.trim();
  if (value.length < MIN_QUOTED_LITERAL_CHARS || value.length > MAX_QUOTED_LITERAL_CHARS) return undefined;
  if (!/[\p{L}\p{N}]/u.test(value)) return undefined;
  if (/\s{2,}/.test(value) || value.split(/\s+/).length > MAX_QUOTED_LITERAL_WORDS) return undefined;
  if (!/\s/.test(value) && value.length < MIN_QUOTED_SINGLE_WORD_CHARS) return undefined;
  // A quoted file name is a named target (`augmentQueryNamedFileSurfaces`), not a literal to scan for.
  if (!/\s/.test(value) && endsWithKnownExtension(value)) return undefined;
  // A quoted sentence or question is an answer format, not a literal.
  if (/[.?!]$/.test(value) && /\s/.test(value)) return undefined;
  return value;
}

/**
 * The distinctive literals `query` names, most explicit first: quoted strings,
 * UPPER_SNAKE constants, long lowercase dotted keys. Deduplicated by exact
 * spelling; a literal contained in an earlier one is dropped. `url_for`,
 * `BuildError`, `resolveToolSurface`, `res.redirect`, `HTTP` and `config.rst`
 * are not distinctive by this rule.
 */
export function distinctiveLiteralsIn(query: string): DistinctiveLiteral[] {
  const out: DistinctiveLiteral[] = [];
  const add = (value: string, kind: DistinctiveLiteralKind): void => {
    if (out.some((entry) => entry.value === value || entry.value.includes(value))) return;
    out.push({ value, kind });
  };
  for (const match of query.matchAll(QUOTED_SPAN_RE)) {
    const value = quotedLiteralValue(match[2] ?? match[3] ?? match[4] ?? "");
    if (value !== undefined) add(value, "quoted");
  }
  for (const match of query.matchAll(CONSTANT_RE)) add(match[0], "constant");
  for (const match of query.matchAll(DOTTED_RE)) {
    const value = match[0];
    if (endsWithKnownExtension(value)) continue;
    const segments = value.split(".");
    if (segments.some((segment) => /^\d+$/.test(segment))) continue;
    if (value.length >= MIN_DOTTED_IDENTIFIER_CHARS || segments.length >= 3) add(value, "dotted");
  }
  return out;
}

// ---------------------------------------------------------------------------
// The literal is what the question is about
// ---------------------------------------------------------------------------

/** A lookup lead: the request asks where/what/how something is, or to explain, describe, show or find it. */
const LOOKUP_LEAD_EN_RE = /^\s*(?:please\s+)?(?:where|what|which|how|why|when|who|whom|explain|describe|show|tell|find|list|locate|is|are|does|do|can|could|should|in\s+which|under\s+what)\b/i;
/** JA question/explanation markers (どこで読まれる, 何を制御, について説明, とは). */
const LOOKUP_JA_RE = /(?:どこ|何|なに|どの|どう|なぜ|いつ|説明|教え|について|とは|ですか|ますか)/u;
/** Code-shaped terms other than the literal: camelCase, PascalCase words, snake_case, CONST_CASE, dotted paths, file names. */
const OTHER_CODE_SHAPED_RES: readonly RegExp[] = [
  /(?<![\w$])[a-z][a-z0-9]*[A-Z][A-Za-z0-9]*(?![\w$])/,
  /(?<![\w$])(?:[A-Z][a-z0-9]+){2,}(?![\w$])/,
  /(?<![\w$])[a-z][a-z0-9]*(?:_[a-z0-9]+)+(?![\w$])/,
  /(?<![\w$])[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+(?![\w$])/,
  /(?<![\w$./-])[A-Za-z_$][\w$]+(?:\.[A-Za-z_$][\w$]+)+(?![\w$./-])/,
];

/** A clause that refers back to the lead's subject (EN anaphora) rather than naming one of its own. */
const EN_ANAPHORA_RE = /(?<![\w$])(?:it|its|itself|they|them|their|theirs|this|that|these|those)(?![\w$])/i;
/** A JA clause that opens with an interrogative is a further question about the lead's subject (「どんな値を受け付けますか」). */
const JA_INTERROGATIVE_LEAD_RE = /^\s*(?:どんな|どの|どこ|どう|なぜ|いつ|いくつ|何|なに)/u;

/**
 * Is the literal WHAT THE REQUEST IS ABOUT? True when the request leads with a
 * lookup ("Where is X read", "What does X control", 「X は何を…」), names no
 * other code-shaped term — no camelCase or snake_case identifier, constant,
 * dotted path or file name beside the literal(s) — and every further clause
 * of a compound request is a facet of the literal rather than a question of
 * its own. A request that also names a function ("validateToken の有効期限判定…
 * MAX_RETRIES の値も"), traces a relation ("Trace X continuation relation while
 * retaining the supporting context") or quotes words as modifiers of another
 * subject keeps the answer builder: that builder's symbol focus, supporting
 * context and relation closure are about the OTHER subject, and seeding the
 * literal's windows alone would drop them (readCodeTaskPack.spec.ts's W3-B
 * answer-focus pins, handsOnReport0142's TL142-01A, measured 2026-11-03 while
 * this module was built).
 *
 * COMPOUND REQUESTS (completionHonesty.spec.ts D1/D2, same day): "Where does
 * order status transition between `pending`, `shipped`, …, how is a coupon
 * discount validated, and where are failed notifications retried?" quotes four
 * literals, but its other clauses ask about coupons and notifications. Seeding
 * the state machine alone certified `act.answer` with two of three questions
 * unserved — the exact false completion the compound/facet planners exist to
 * prevent. So with more than one request item (requestItems.ts
 * `extractRequestItems`, the same split the readiness engine proves against),
 * every item must either spell a literal or refer back to it ("what values does
 * it accept?", 「どんな値を受け付けますか」); an item with a subject of its own
 * hands the request to those planners.
 */
export function literalIsLookupSubject(query: string, literals: readonly DistinctiveLiteral[]): boolean {
  if (literals.length === 0) return false;
  if (!LOOKUP_LEAD_EN_RE.test(query) && !LOOKUP_JA_RE.test(query)) return false;
  let rest = query;
  for (const literal of literals) rest = rest.split(literal.value).join(" ");
  // Quote marks left behind by a removed quoted literal, and ordinary abbreviations.
  rest = rest.replace(/["'`「」『』]/g, " ").replace(/\b(?:e\.g|i\.e|etc)\.?/gi, " ");
  if (OTHER_CODE_SHAPED_RES.some((re) => re.test(rest))) return false;
  for (const token of rest.split(/\s+/)) {
    if (token.includes(".") && endsWithKnownExtension(token.replace(/[),.;:!?]+$/, ""))) return false;
  }
  const items = extractRequestItems(query);
  if (items.length > 1) {
    for (const item of items) {
      if (literals.some((literal) => item.text.includes(literal.value))) continue;
      if (EN_ANAPHORA_RE.test(item.text) || JA_INTERROGATIVE_LEAD_RE.test(item.text)) continue;
      return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Hits: whole-token, code position, windows
// ---------------------------------------------------------------------------

/**
 * Does `line` spell `literal` in a CODE position: on a line that carries code
 * once comments and string bodies are masked (`maskNonCode`), either the whole
 * token survives the mask (`const limit = OUTPUT_TOKEN_CEILING * 4`) or the
 * quoted form is on the line (an env read of `"X"`, `this.set('trust proxy', …)`,
 * `"SESSION_COOKIE_SAMESITE": None`)? A pure comment line is prose even when it
 * quotes the literal in backticks (a doc block naming the env var), and
 * `'trust proxy fn'` is another string. askedPathClosure.ts `sourceSpellsLiteral`
 * is the absence-proof cousin of this test; that one must count a comment's
 * quoted form (the literal is still spelled in source), a ranking of defining
 * and reading sites must not.
 */
export function literalSpelledInCode(line: string, literal: string, hashComment: boolean, relPath: string): boolean {
  const masked = maskNonCode(line, hashComment, relPath);
  if (masked.trim().length === 0) return false;
  return quotedFormOccursIn(line, literal) || wholeTokenOccursIn(masked, literal);
}

export interface LiteralHitCluster {
  /** The served window, 1-based, inclusive. */
  readonly start: number;
  readonly end: number;
  /** The first and last hit line the window was cut around. */
  readonly first: number;
  readonly last: number;
  readonly hits: number;
  readonly codeHits: number;
}

/**
 * Hit lines joined into clusters (`LITERAL_WINDOW_JOIN_LINES`), each widened
 * by the context margins and capped at `MAX_LITERAL_WINDOW_LINES` from its
 * head; the strongest `max` clusters (code hits, then hits, then position),
 * in file order.
 */
export function literalHitWindows(
  hitLines: readonly number[],
  codeLines: ReadonlySet<number>,
  lineCount: number,
  max = MAX_LITERAL_WINDOWS_PER_FILE,
): LiteralHitCluster[] {
  const sorted = [...new Set(hitLines)].sort((a, b) => a - b);
  const clusters: Array<{ first: number; last: number; hits: number; codeHits: number }> = [];
  for (const line of sorted) {
    const current = clusters[clusters.length - 1];
    if (current !== undefined && line - current.last <= LITERAL_WINDOW_JOIN_LINES) {
      current.last = line;
      current.hits++;
      if (codeLines.has(line)) current.codeHits++;
    } else {
      clusters.push({ first: line, last: line, hits: 1, codeHits: codeLines.has(line) ? 1 : 0 });
    }
  }
  const strongest = clusters
    .sort((a, b) => b.codeHits - a.codeHits || b.hits - a.hits || a.first - b.first)
    .slice(0, max)
    .sort((a, b) => a.first - b.first);
  // A short file is one window: the whole file, owing nothing.
  if (lineCount > 0 && lineCount <= MAX_WHOLE_FILE_SEED_LINES && strongest.length > 0) {
    return [{
      start: 1,
      end: lineCount,
      first: strongest[0]!.first,
      last: strongest[strongest.length - 1]!.last,
      hits: strongest.reduce((sum, cluster) => sum + cluster.hits, 0),
      codeHits: strongest.reduce((sum, cluster) => sum + cluster.codeHits, 0),
    }];
  }
  return strongest.map((cluster) => {
    const before = cluster.codeHits > 0 ? LITERAL_WINDOW_LINES_BEFORE : LITERAL_PROSE_WINDOW_LINES;
    const after = cluster.codeHits > 0 ? LITERAL_WINDOW_LINES_AFTER : LITERAL_PROSE_WINDOW_LINES;
    const start = Math.max(1, cluster.first - before);
    const wanted = Math.min(Math.max(1, lineCount), cluster.last + after);
    const end = Math.max(start, Math.min(wanted, start + MAX_LITERAL_WINDOW_LINES - 1));
    return { start, end, first: cluster.first, last: cluster.last, hits: cluster.hits, codeHits: cluster.codeHits };
  });
}

/** A window with the callable that holds its hits, when one does and it is short. */
export interface LiteralSeedWindow extends LiteralHitCluster {
  /** The function or method whose body holds every hit of the cluster (`resolveToolSurface`, `app.set`). */
  readonly symbol?: string;
}

/**
 * The function or method holding every hit of each window, when one does and
 * it spans at most `MAX_LITERAL_WINDOW_LINES`: the window widens to cover the
 * callable (a window cut around the hits left out the function's head — the
 * locator's `enclosingCallableRange` found solvers reading it in a turn of
 * its own), and the row carries the callable's name, which is what lets the
 * facet closure treat the reader as a focal ("what values does it accept"
 * resolves the constants `resolveToolSurface` reads). A hit outside any short
 * callable keeps its window and no symbol. Parse failures keep every window.
 */
export async function windowsWithEnclosingCallables(
  relPath: string,
  text: string,
  windows: readonly LiteralHitCluster[],
  lineCount: number,
): Promise<LiteralSeedWindow[]> {
  if (windows.length === 0) return [];
  let symbols: CollectedSymbol[];
  try {
    const lang = languageForPathWithContent(relPath, text);
    if (!lang) return [...windows];
    symbols = await collectSymbols(text, lang, {});
  } catch {
    return [...windows];
  }
  const callables = symbols.filter((symbol) => symbol.kind === "function" || symbol.kind === "method");
  const widened: LiteralSeedWindow[] = windows.map((window) => {
    let best: CollectedSymbol | undefined;
    for (const symbol of callables) {
      if (symbol.startLine > window.first || symbol.endLine < window.last) continue;
      if (symbol.endLine - symbol.startLine + 1 > MAX_LITERAL_WINDOW_LINES) continue;
      if (best === undefined || symbol.endLine - symbol.startLine < best.endLine - best.startLine) best = symbol;
    }
    if (best === undefined) return window;
    return {
      ...window,
      start: Math.min(window.start, best.startLine),
      end: Math.min(Math.max(1, lineCount), Math.max(window.end, best.endLine)),
      symbol: best.name,
    };
  });
  // Two windows widened into one callable are one window.
  const merged: LiteralSeedWindow[] = [];
  for (const window of [...widened].sort((a, b) => a.start - b.start)) {
    const previous = merged[merged.length - 1];
    if (previous !== undefined && window.start <= previous.end + 1) {
      merged[merged.length - 1] = {
        ...previous,
        end: Math.max(previous.end, window.end),
        last: Math.max(previous.last, window.last),
        hits: previous.hits + window.hits,
        codeHits: previous.codeHits + window.codeHits,
        ...(previous.symbol === undefined && window.symbol !== undefined ? { symbol: window.symbol } : {}),
      };
    } else {
      merged.push(window);
    }
  }
  return merged;
}

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

export interface LiteralSeedFileCounts {
  /** Distinct files with a whole-token hit. */
  readonly total: number;
  /** … of them product source (not auxiliary, not a doc). */
  readonly product: number;
  /** … under bench/tests/examples/fixtures. */
  readonly auxiliary: number;
  /** … documentation (by extension or changelog basename). */
  readonly docs: number;
}

export interface LiteralSeedPlan {
  /** The literal(s) whose hits seeded the pack, in seeding order. */
  readonly literals: readonly string[];
  /** Seeds for the seeded builder: product (or, failing that, auxiliary) code windows, then at most one doc window. */
  readonly seeds: readonly TaskPackPathEntry[];
  /** Whether the code seeds are product source or (when the product has none) auxiliary files. */
  readonly tree: "product" | "auxiliary";
  readonly files: LiteralSeedFileCounts;
}

export interface LiteralSeedDeps {
  /** The exact `action:"find"` universe (`enumerateFindTextUniverse`). */
  readonly universe: FindTextUniverse;
  /** Shared per-build content cache, when the caller has one. */
  readonly contentCache?: ScanContentCache;
  /** readCodeTaskPack.ts `isAuxiliaryTreePath`: bench, fixtures, tests, examples, vendored copies. */
  readonly isAuxiliaryTreePath: (relPath: string) => boolean;
  /** Distinct files a literal may occur in and still be rare (readCodeTaskPack.ts `literalSourceRarityLimit`). */
  readonly rarityLimit: number;
}

interface FileHits {
  readonly relPath: string;
  readonly absPath: string;
  /** Whole-token hit lines (from the scan's trimmed match text; re-checked on the full line when read). */
  lines: number[];
  /** Hit lines that spell the literal in a code position (`literalSpelledInCode`). */
  codeLines: Set<number>;
  /**
   * Code-position hits where the literal is a key or an assignment target
   * (`"X": None`, `X = v`, `X: t`) — a defaults table, an enum body, a constants
   * module — as opposed to a read (`config["X"]`, an env lookup of `"X"`). The
   * defining site outranks the readers (familyMemberSeeds.ts's `declarations`).
   */
  declarationLines: number;
  lineCount: number;
  /** The decoded file, kept for the enclosing-callable parse of a chosen file. */
  text?: string;
  read: boolean;
}

/** `X` followed by an optional closing quote and a `:`/`=` that is not `::`/`==`. */
const DECLARATION_TAIL_RE = /^["'`]?\s*(?::(?!:)|=(?!=))/;

function declaresLiteral(line: string, literal: string): boolean {
  let from = 0;
  for (;;) {
    const at = line.indexOf(literal, from);
    if (at < 0) return false;
    if (DECLARATION_TAIL_RE.test(line.slice(at + literal.length))) return true;
    from = at + 1;
  }
}

function literalLabel(literal: string): string {
  return literal.length > LITERAL_LABEL_CHARS ? `${literal.slice(0, LITERAL_LABEL_CHARS - 1)}…` : literal;
}

function readText(absPath: string): string | undefined {
  try {
    const decoded = decodeTextBuffer(readFileForRequest(absPath));
    return decoded === null ? undefined : decoded;
  } catch {
    return undefined;
  }
}

/** Read the file once and settle which hit lines spell the literal, and which in a code position. */
function classifyHits(file: FileHits, literal: string): void {
  if (file.read) return;
  file.read = true;
  const text = readText(file.absPath);
  if (text === undefined) {
    file.lines = [];
    return;
  }
  file.text = text;
  const lines = text.split(/\r?\n/);
  const hashComment = hasHashComments(file.relPath);
  file.lineCount = lines.length > 0 && lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
  const confirmed: number[] = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (!wholeTokenOccursIn(line, literal)) continue;
    confirmed.push(index + 1);
    if (literalSpelledInCode(line, literal, hashComment, file.relPath)) {
      file.codeLines.add(index + 1);
      if (declaresLiteral(line, literal)) file.declarationLines++;
    }
  }
  file.lines = confirmed;
}

/** The defining site first (keys/assignments), then the file that spells the literal in code most, then breadth, then path. */
function byStrength(a: FileHits, b: FileHits): number {
  return b.declarationLines - a.declarationLines
    || b.codeLines.size - a.codeLines.size
    || b.lines.length - a.lines.length
    || a.relPath.localeCompare(b.relPath);
}

/** The hits of one literal over the universe, grouped by file, with the cheap whole-token pass applied. */
function fileHitsFor(literal: string, workspace: string, deps: LiteralSeedDeps): Map<string, FileHits> {
  const byPath = new Map<string, FileHits>();
  const absByRel = new Map(deps.universe.files.map((file) => [file.relPath, file.absPath] as const));
  const matches = scanLiteral(literal, workspace, {
    caseInsensitive: false,
    files: deps.universe.files,
    ...(deps.contentCache ? { contentCache: deps.contentCache } : {}),
  });
  for (const match of matches) {
    // The scan is a substring scan; the trimmed match text still carries the
    // characters around the hit (`trimMatchText` centres the window on it).
    if (match.text !== undefined && !wholeTokenOccursIn(match.text, literal)) continue;
    const absPath = absByRel.get(match.path);
    if (absPath === undefined) continue;
    const file = byPath.get(match.path)
      ?? { relPath: match.path, absPath, lines: [], codeLines: new Set<number>(), declarationLines: 0, lineCount: 0, read: false };
    file.lines.push(match.line);
    byPath.set(match.path, file);
  }
  return byPath;
}

/**
 * The seed plan for `query`, or `undefined` when no distinctive literal of the
 * request concentrates in a few code files of the workspace (every other
 * request shape is untouched). Deterministic for a given workspace state.
 */
export async function literalSeedPlan(query: string, workspace: string, deps: LiteralSeedDeps): Promise<LiteralSeedPlan | undefined> {
  const literals = distinctiveLiteralsIn(query).slice(0, MAX_LITERALS_PER_QUERY);
  if (literals.length === 0 || !literalIsLookupSubject(query, literals)) return undefined;

  const seeds: TaskPackPathEntry[] = [];
  const seededLiterals: string[] = [];
  const seededPaths = new Set<string>();
  let tree: "product" | "auxiliary" | undefined;
  let counts: LiteralSeedFileCounts | undefined;

  for (const literal of literals) {
    if (seededPaths.size >= MAX_LITERAL_SEED_FILES) break;
    const hits = fileHitsFor(literal.value, workspace, deps);
    if (hits.size === 0) continue;
    const files = [...hits.values()];
    const docs = files.filter((file) => isDocLikePath(file.relPath));
    const code = files.filter((file) => !isDocLikePath(file.relPath));
    const product = code.filter((file) => !deps.isAuxiliaryTreePath(file.relPath));
    const auxiliary = code.filter((file) => deps.isAuxiliaryTreePath(file.relPath));
    // The literal is an inventory, not a location: too many files to be rare,
    // or spread over more code files than a pack can locate.
    if (files.length > deps.rarityLimit) continue;
    const pool = product.length > 0 ? product : auxiliary;
    if (pool.length === 0 || pool.length > MAX_LITERAL_CODE_FILES) continue;
    const poolTree: "product" | "auxiliary" = product.length > 0 ? "product" : "auxiliary";
    // A second literal only ever adds to the tree the first one chose.
    if (tree !== undefined && tree !== poolTree) continue;

    // Settle code-position hits on the strongest candidates (by cheap count).
    const candidates = pool.sort((a, b) => b.lines.length - a.lines.length || a.relPath.localeCompare(b.relPath)).slice(0, MAX_LITERAL_FILES_READ);
    for (const file of candidates) classifyHits(file, literal.value);
    const confirmed = candidates.filter((file) => file.lines.length > 0).sort(byStrength);
    // A literal spelled only in comments and prose is not a defining or
    // reading site; today's pack (and its absence reporting) stands.
    if (!confirmed.some((file) => file.codeLines.size > 0)) continue;

    const room = MAX_LITERAL_SEED_FILES - seededPaths.size;
    const chosen = confirmed.filter((file) => !seededPaths.has(file.relPath)).slice(0, room);
    if (chosen.length === 0) continue;
    const label = literalLabel(literal.value);
    for (const file of chosen) {
      const windows = await windowsWithEnclosingCallables(
        file.relPath, file.text ?? "", literalHitWindows(file.lines, file.codeLines, file.lineCount), file.lineCount,
      );
      for (const window of windows) {
        seeds.push({
          path: file.relPath,
          range: `${window.start}-${window.end}`,
          ...(window.symbol !== undefined ? { symbol: window.symbol } : {}),
          purpose: `${label} occurrence`,
        });
      }
      seededPaths.add(file.relPath);
    }
    seededLiterals.push(literal.value);
    tree = poolTree;
    counts ??= { total: files.length, product: product.length, auxiliary: auxiliary.length, docs: docs.length };

    // One doc window while the code seeds are few: the page that documents
    // the key (never a changelog line, which is history, not a description).
    if (seeds.length > 0 && seededLiterals.length === 1 && chosen.length <= MAX_CODE_FILES_WITH_DOC_SEED) {
      const docCandidates = docs
        .filter((file) => !isChangelogLikePath(file.relPath))
        .sort((a, b) => Number(deps.isAuxiliaryTreePath(a.relPath)) - Number(deps.isAuxiliaryTreePath(b.relPath)) || b.lines.length - a.lines.length || a.relPath.localeCompare(b.relPath))
        .slice(0, MAX_LITERAL_DOC_SEEDS);
      for (const doc of docCandidates) {
        classifyHits(doc, literal.value);
        if (doc.lines.length === 0) continue;
        const [window] = literalHitWindows(doc.lines, doc.codeLines, doc.lineCount, 1);
        if (window === undefined) continue;
        seeds.push({ path: doc.relPath, range: `${window.start}-${window.end}`, purpose: `${label} documented here` });
      }
    }
  }

  if (seeds.length === 0 || tree === undefined || counts === undefined) return undefined;
  return { literals: seededLiterals, seeds, tree, files: counts };
}

/** One advisory sentence for the pack: where the literal occurs and what the windows cover. */
export function literalSeedAdvisory(plan: LiteralSeedPlan): string {
  const names = plan.literals.map((literal) => `\`${literalLabel(literal)}\``).join(" and ");
  const { total, product, auxiliary, docs } = plan.files;
  const served = plan.tree === "product" ? "product source" : "bench/test/example";
  const parts: string[] = [];
  if (product > 0) parts.push(`${product} product source`);
  if (auxiliary > 0) parts.push(`${auxiliary} under bench/tests/examples`);
  if (docs > 0) parts.push(`${docs} docs`);
  const where = parts.length > 0 ? ` (${parts.join(", ")})` : "";
  return `${names} occurs in ${total} file${total === 1 ? "" : "s"}${where}; the served windows are its ${served} occurrences. tl_search_files find lists every other file.`;
}
