// ---------------------------------------------------------------------------
// Artifact consumers (v0.16 decision window 6t-7, T10 arm A).
//
// THE GAP. An artifact_build pack (`plan.artifact_requirements`) bundles the
// artifact sections and the implementation target and stops there. The T10
// first pack held the stub pricing/rating_engine.py, the BaseRates and Codes
// sheets and the methodology DOCX sections, with `max_additional_tl_calls` 0,
// and all three cells still explored before writing (tree, a batch of
// data/rate_table.py, data/occupation.py and pricing/premium.py, then
// api/app.py: 4-5 turns, about 25k thinking tokens in rep0) for the workspace
// code that already loads or names those artifacts. RateTable.load reads
// rate-table-2026.xlsx, OccupationRiskTable.load reads
// occupation-risk-codes.xlsx (its factor() is a stub returning 1.00, which a
// smoke test exposed only later, in two cells), the DOCX names
// policyarc_actuary.pricing.premium.PremiumCalculator.compute(), and
// create_app wires the workbooks in.
//
// THE RULE. Such a pack also carries the artifacts' CONSUMERS: workspace code
// files (never docs) that name an artifact's basename, in a code string
// literal or in a comment/docstring, or that a dotted module path in the
// artifact text this pack serves resolves to. Ranked by the edit target's own
// package first (its nearest ancestor holding a project manifest), then a
// dotted-path name, a code reference, a comment/docstring mention, then
// directory proximity to the target. A file outside that package joins only
// on a dotted name or a code reference. At most four files, a few KB in total.
//
// SERVED COMPACTLY. A consumer ships the members that matter as verbatim
// windows rendered by the pack's own slicer: the member holding a code
// reference, the member the artifact names, the member whose docstring names
// the artifact. The rest of the file is an outline in the first row's `why`
// (names and line spans, prose a ledger cannot book). Every window is its own
// surface, so `packServedSpans` books exactly the windows the reply carries.
//
// STUBS WHOLE, HELPERS ALONG (6t-7 follow-up). Doc-comment elision cut
// OccupationRiskTable.factor to two rows, its `def` line and a lone
// `return Decimal("1.00")`, with the docstring between them disclosed as
// elided. Over windows 6t-4..6t-7 arm A worked around that stub at its first
// module write in 5 of 12 T10 cells and arm B, reading the file whole, in 10
// of 12; 9 arm-A cells re-read occupation.py 52-62 to see it. So a member
// that elision would cut to its signature and at most two more lines ships
// whole, docstring and all, as a window of its own. And a served member's
// calls into its own file (RateTable.base_rate -> _age_band_lower, which
// decides the band key) bring the callee along, one level deep, after every
// other window and inside the same budget.
//
// NEVER AT ANOTHER PART'S EXPENSE. Consumers are optional context. They are
// attached only when the request itself names the implementation target (its
// file or module stem) or a create target is proved, so a discovery pack over
// a locator's guess stays as it was; and only inside the pack's spare budget.
// They never become change-contract obligations or readiness evidence, never
// raise the pack's byte tier, and `trimToCap` sheds them first, whole, before
// any other phase runs, so a pack that cannot afford them ships what it
// shipped before. Packs without artifact requirements never reach this module.
// ---------------------------------------------------------------------------

import * as path from "node:path";

import type { CollectedSymbol } from "../../symbols/collectSymbols.js";
import { elideDocCommentsWithWindows } from "../../util/formatCompress.js";
import { classifyCommentLines, lineCommentPrefixesFor } from "../../util/lineClassify.js";
import type { ArtifactTaskPackSection } from "./model.js";

/** Consumer files one pack may carry. */
export const MAX_ARTIFACT_CONSUMER_FILES = 4;
/** Display bytes (the pack's own comment-elided rendering) one consumer file may carry. */
export const ARTIFACT_CONSUMER_FILE_BYTES = 2304;
/** Serialized bytes every consumer surface together may add to a pack. */
export const ARTIFACT_CONSUMER_TOTAL_BYTES = 7168;
/** Pack headroom consumers leave for the passes that run after the trim. */
export const ARTIFACT_CONSUMER_RESERVE_BYTES = 4096;

/** Files scanned for basenames, nearest to the edit target first. */
const MAX_CONSUMER_SCAN_FILES = 4000;
const MAX_DOTTED_NAMES = 64;
const OUTLINE_MAX_CHARS = 240;
/** Context lines around a reference no member encloses. */
const CONTEXT_BEFORE = 2;
const CONTEXT_AFTER = 6;
/** A clipped window keeps at least this many lines, or is not served. */
const MIN_WINDOW_LINES = 3;
/** Windows this close (blank lines between two members) ship as one. */
const MERGE_GAP_LINES = 2;
/** Code lines, signature included, a member may keep after doc-comment elision and still ship whole as a stub. */
const STUB_CODE_MAX_LINES = 3;

/** Files whose directory is a project or package root. */
const PACKAGE_MANIFESTS = [
  "pyproject.toml",
  "setup.py",
  "setup.cfg",
  "package.json",
  "Cargo.toml",
  "go.mod",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "composer.json",
  "Gemfile",
];

// ---------------------------------------------------------------------------
// The mark trimToCap sheds by. Same carrier as sfWithholdingMarks.ts: an own,
// enumerable, Symbol-keyed property survives `{...surface}` copies and never
// reaches JSON; the WeakSet answers for a frozen object.
// ---------------------------------------------------------------------------

export const ARTIFACT_CONSUMER_SURFACE_KEY: unique symbol = Symbol("tokenlighten.artifactConsumerSurface");
const consumerSurfaces = new WeakSet<object>();

export function markArtifactConsumerSurface(surface: object): void {
  consumerSurfaces.add(surface);
  try {
    Object.defineProperty(surface, ARTIFACT_CONSUMER_SURFACE_KEY, {
      value: true,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  } catch {
    // Frozen: the WeakSet still answers for this exact object.
  }
}

export function isArtifactConsumerSurface(surface: unknown): boolean {
  if (surface === null || typeof surface !== "object") return false;
  if ((surface as Record<symbol, unknown>)[ARTIFACT_CONSUMER_SURFACE_KEY] === true) return true;
  return consumerSurfaces.has(surface);
}

// ---------------------------------------------------------------------------
// What the served artifact text names.
// ---------------------------------------------------------------------------

/** The DOCX extractor escapes markdown punctuation (`policyarc\_actuary\.pricing`). */
export function unescapeArtifactText(text: string): string {
  return text.replace(/\\([\\`*_{}[\]()#+\-.!|<>~"'])/g, "$1");
}

/** The text one served artifact section carries, markdown escapes removed. */
export function artifactSectionText(section: ArtifactTaskPackSection): string {
  const parts: string[] = [];
  if ("sheet" in section) {
    parts.push(section.sheet, ...section.columns);
    for (const row of section.rows) {
      for (const cell of row) if (typeof cell === "string") parts.push(cell);
    }
  } else if (section.kind === "docx") {
    for (const item of section.sections) parts.push(item.heading, item.text);
  } else if (section.kind === "pptx") {
    for (const item of section.slides) parts.push(item.heading, item.text);
  } else {
    for (const item of section.pages) parts.push(item.text);
  }
  return unescapeArtifactText(parts.join("\n"));
}

export interface ArtifactNames {
  /** Dotted names (`a.b.c.D.e`) split into segments, first-seen order. */
  dotted: string[][];
  /** Identifiers the text calls (`name(`) or reaches through a dot (`x.name`). */
  members: Set<string>;
}

export function artifactNames(text: string): ArtifactNames {
  const dotted: string[][] = [];
  const seen = new Set<string>();
  const members = new Set<string>();
  for (const match of text.matchAll(/(?<![\w.])[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+/g)) {
    const segments = match[0].split(".");
    members.add(segments[segments.length - 1]!);
    if (seen.has(match[0]) || dotted.length >= MAX_DOTTED_NAMES) continue;
    seen.add(match[0]);
    dotted.push(segments);
  }
  for (const match of text.matchAll(/(?<![\w$])([A-Za-z_]\w*)\s*\(/g)) members.add(match[1]!);
  return { dotted, members };
}

export interface DottedResolution {
  /** The dotted name as the artifact spells it. */
  name: string;
  /** Member path below the module (`["PremiumCalculator", "compute"]`). */
  members: string[];
  /** Basename of the artifact whose text holds the name. */
  artifact: string;
}

function stemOf(relPath: string): string {
  return relPath.slice(0, relPath.length - path.posix.extname(relPath).length);
}

/**
 * Files a dotted name resolves to as a module path: the longest prefix of at
 * least two segments (a package and a module) that names a file stem, so
 * `policyarc_actuary.pricing.premium.PremiumCalculator.compute` reaches
 * `…/policyarc_actuary/pricing/premium.py` with members
 * `["PremiumCalculator", "compute"]`, and `PricingService.quote` (a class and
 * a method, no package) reaches nothing.
 */
export function resolveDottedModules(
  names: ReadonlyArray<{ segments: readonly string[]; artifact: string }>,
  files: readonly string[],
  editTarget: string,
): Map<string, DottedResolution[]> {
  const byModule = new Map<string, string[]>();
  for (const file of files) {
    const module = path.posix.basename(stemOf(file));
    const bucket = byModule.get(module) ?? [];
    bucket.push(file);
    byModule.set(module, bucket);
  }
  const resolved = new Map<string, DottedResolution[]>();
  for (const { segments, artifact } of names) {
    for (let take = segments.length; take >= 2; take--) {
      const modulePath = segments.slice(0, take).join("/");
      const matches = (byModule.get(segments[take - 1]!) ?? []).filter((file) => {
        const stem = stemOf(file);
        return stem === modulePath || stem.endsWith(`/${modulePath}`);
      });
      if (matches.length === 0) continue;
      const file = [...matches].sort((left, right) =>
        sharedSegments(right, editTarget) - sharedSegments(left, editTarget) || left.localeCompare(right)
      )[0]!;
      const entries = resolved.get(file) ?? [];
      entries.push({ name: segments.join("."), members: segments.slice(take), artifact });
      resolved.set(file, entries);
      break;
    }
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// Where a file names an artifact basename.
// ---------------------------------------------------------------------------

export interface ArtifactReference {
  /** 1-based line. */
  line: number;
  artifact: string;
  /** `code`: inside a string literal of a code line; `doc`: a comment, a docstring or bare prose. */
  kind: "code" | "doc";
}

/** Python string statements (`"""…"""` opening a line): docstrings, never code literals. */
function markPythonStringStatements(lines: readonly string[], flags: boolean[]): void {
  for (let index = 0; index < lines.length; index++) {
    const open = /^\s*[rRuUbBfF]{0,2}("""|''')/.exec(lines[index]!);
    if (open === null) continue;
    const quote = open[1]!;
    let end = index;
    if (!lines[index]!.slice(open[0].length).includes(quote)) {
      while (end + 1 < lines.length && !lines[end + 1]!.includes(quote)) end++;
      end = Math.min(lines.length - 1, end + 1);
    }
    for (let line = index; line <= end; line++) flags[line] = true;
    index = end;
  }
}

function docLineFlags(text: string, lines: readonly string[], language: string | undefined): boolean[] {
  const flags = language === undefined
    ? new Array<boolean>(lines.length).fill(false)
    : classifyCommentLines(text, language);
  for (const [start, end] of elideDocCommentsWithWindows(text, language, 1).elided) {
    for (let line = start; line <= end && line <= flags.length; line++) flags[line - 1] = true;
  }
  if (language === "python") markPythonStringStatements(lines, flags);
  return flags;
}

/** Index of the first line-comment prefix outside a quoted run, or -1. */
function lineCommentStart(line: string, prefixes: readonly string[]): number {
  let quote: string | undefined;
  for (let index = 0; index < line.length; index++) {
    const char = line[index]!;
    if (quote !== undefined) {
      if (char === "\\") index++;
      else if (char === quote) quote = undefined;
      continue;
    }
    if (char === "\"" || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (prefixes.some((prefix) => line.startsWith(prefix, index))) return index;
  }
  return -1;
}

/** The lines of `text` with comment and docstring lines blanked and trailing line comments cut. */
function codeLinesOf(text: string, language: string | undefined): string[] {
  const lines = text.split(/\r?\n/);
  const flags = docLineFlags(text, lines, language);
  const prefixes = lineCommentPrefixesFor(language) ?? [];
  return lines.map((line, index) => {
    if (flags[index] === true) return "";
    const comment = lineCommentStart(line, prefixes);
    return comment === -1 ? line : line.slice(0, comment);
  });
}

function isCodeLiteral(line: string, at: number, language: string | undefined): boolean {
  const comment = lineCommentStart(line, lineCommentPrefixesFor(language) ?? []);
  if (comment !== -1 && comment < at) return false;
  let cursor = at - 1;
  while (cursor >= 0 && /[\w\-./\\{}$:@~]/.test(line[cursor]!)) cursor--;
  return cursor >= 0 && (line[cursor] === "\"" || line[cursor] === "'" || line[cursor] === "`");
}

function boundedAt(lower: string, at: number, length: number): boolean {
  const before = at > 0 ? lower[at - 1]! : "";
  const after = lower[at + length] ?? "";
  return !/[a-z0-9_-]/.test(before) && !/[a-z0-9_]/.test(after);
}

/** Every line naming one of `basenames`, case-insensitively, as a whole name. */
export function artifactReferences(
  text: string,
  language: string | undefined,
  basenames: readonly string[],
): ArtifactReference[] {
  const wanted = basenames.map((basename) => basename.toLowerCase());
  const whole = text.toLowerCase();
  if (!wanted.some((basename) => whole.includes(basename))) return [];
  const lines = text.split(/\r?\n/);
  const flags = docLineFlags(text, lines, language);
  const out: ArtifactReference[] = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const lower = line.toLowerCase();
    wanted.forEach((basename, which) => {
      let kind: "code" | "doc" | undefined;
      for (let at = lower.indexOf(basename); at !== -1; at = lower.indexOf(basename, at + 1)) {
        if (!boundedAt(lower, at, basename.length)) continue;
        kind ??= "doc";
        if (flags[index] !== true && isCodeLiteral(line, at, language)) {
          kind = "code";
          break;
        }
      }
      if (kind !== undefined) out.push({ line: index + 1, artifact: basenames[which]!, kind });
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Paths and packages.
// ---------------------------------------------------------------------------

function parentDir(relPath: string): string {
  const dir = path.posix.dirname(relPath);
  return dir === "." ? "" : dir;
}

function joinRel(dir: string, name: string): string {
  return dir === "" ? name : `${dir}/${name}`;
}

export function isWithinDir(relPath: string, dir: string): boolean {
  return dir === "" || relPath === dir || relPath.startsWith(`${dir}/`);
}

function sharedSegments(left: string, right: string): number {
  const a = parentDir(left).split("/").filter(Boolean);
  const b = parentDir(right).split("/").filter(Boolean);
  let shared = 0;
  while (shared < a.length && shared < b.length && a[shared] === b[shared]) shared++;
  return shared;
}

/** Deepest directory holding every path ("" = the workspace root). */
export function commonDirectory(paths: readonly string[]): string {
  let common: string[] | undefined;
  for (const relPath of paths) {
    const segments = parentDir(relPath).split("/").filter(Boolean);
    if (common === undefined) {
      common = segments;
      continue;
    }
    let shared = 0;
    while (shared < common.length && shared < segments.length && common[shared] === segments[shared]) shared++;
    common = common.slice(0, shared);
  }
  return (common ?? []).join("/");
}

/** The edit target's own package: its nearest ancestor holding a project manifest, else `scanRoot`. */
export function packageRootOf(editTarget: string, scanRoot: string, hasFile: (relPath: string) => boolean): string {
  let dir = parentDir(editTarget);
  for (;;) {
    if (PACKAGE_MANIFESTS.some((name) => hasFile(joinRel(dir, name)))) return dir;
    if (dir === scanRoot || dir === "") return scanRoot;
    dir = parentDir(dir);
  }
}

// ---------------------------------------------------------------------------
// Which lines of one consumer ship.
// ---------------------------------------------------------------------------

export interface ArtifactConsumerWindow {
  start: number;
  end: number;
  /** Served with its comments: a stub member, most of which is its docstring. */
  whole?: true;
}

/** Lines of `text` as the pack counts them: a final newline ends the last line, it opens none. */
function lineCount(text: string): number {
  const lines = text.split(/\r\n|\r|\n/).length;
  return /(?:\r\n|\r|\n)$/.test(text) ? lines - 1 : lines;
}

function isCallable(symbol: CollectedSymbol): boolean {
  return symbol.kind === "function" || symbol.kind === "method";
}

function memberLabel(symbol: CollectedSymbol): string {
  return symbol.enclosingSymbol ? `${symbol.enclosingSymbol.name}.${symbol.name}` : symbol.name;
}

function innermostCallable(callables: readonly CollectedSymbol[], line: number): CollectedSymbol | undefined {
  let best: CollectedSymbol | undefined;
  for (const symbol of callables) {
    if (line < symbol.startLine || line > symbol.endLine) continue;
    if (best === undefined || symbol.endLine - symbol.startLine < best.endLine - best.startLine) best = symbol;
  }
  return best;
}

interface WindowCandidate {
  start: number;
  end: number;
  /** Where a window too large to ship whole is cut: its head, or around one line. */
  focus?: number;
  member?: string;
  /** The callable the window spans. */
  symbol?: CollectedSymbol;
}

interface ChosenWindow {
  start: number;
  end: number;
  member?: string;
  symbol?: CollectedSymbol;
  whole?: true;
}

/** The widest end in [start + MIN_WINDOW_LINES - 1, end] whose rendering fits `budget`. */
function clipEnd(
  start: number,
  end: number,
  budget: number,
  displayBytes: (start: number, end: number) => number | undefined,
): { end: number; bytes: number } | undefined {
  let low = start + MIN_WINDOW_LINES - 1;
  if (low > end) return undefined;
  const lowBytes = displayBytes(start, low);
  if (lowBytes === undefined || lowBytes > budget) return undefined;
  let best = { end: low, bytes: lowBytes };
  let high = end;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const bytes = displayBytes(start, middle);
    if (bytes !== undefined && bytes <= budget) {
      best = { end: middle, bytes };
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return best;
}

function fitWindow(
  candidate: WindowCandidate,
  budget: number,
  displayBytes: (start: number, end: number) => number | undefined,
): { start: number; end: number; bytes: number } | undefined {
  const whole = displayBytes(candidate.start, candidate.end);
  if (whole !== undefined && whole <= budget) return { start: candidate.start, end: candidate.end, bytes: whole };
  if (candidate.focus !== undefined) {
    const start = Math.max(candidate.start, candidate.focus - CONTEXT_AFTER);
    const end = Math.min(candidate.end, candidate.focus + CONTEXT_AFTER);
    const bytes = displayBytes(start, end);
    if (bytes !== undefined && bytes <= budget) return { start, end, bytes };
  }
  const clipped = clipEnd(candidate.start, candidate.end, budget, displayBytes);
  return clipped === undefined ? undefined : { start: candidate.start, ...clipped };
}

/**
 * A stub member's window with its comments, when that rendering fits
 * `budget`: a callable that doc-comment elision would cut to its signature
 * and at most two more lines (`def factor(...)`, `return Decimal("1.00")`).
 */
function fitStubWhole(
  candidate: WindowCandidate,
  budget: number,
  input: ConsumerWindowInput,
): { start: number; end: number; bytes: number; whole: true } | undefined {
  const symbol = candidate.symbol;
  if (symbol === undefined || input.docBlocks === undefined || input.rawBytes === undefined) return undefined;
  let docLines = 0;
  for (const [first, last] of input.docBlocks) {
    const from = Math.max(first, symbol.startLine);
    const to = Math.min(last, symbol.endLine);
    if (to >= from) docLines += to - from + 1;
  }
  if (docLines === 0 || symbol.endLine - symbol.startLine + 1 - docLines > STUB_CODE_MAX_LINES) return undefined;
  const bytes = input.rawBytes(symbol.startLine, symbol.endLine);
  return bytes !== undefined && bytes <= budget
    ? { start: symbol.startLine, end: symbol.endLine, bytes, whole: true }
    : undefined;
}

/**
 * Callables of this file the chosen windows call, one level deep, in
 * first-call order: a top-level function called by its bare name, or a method
 * of the caller's own class called through `self.`, `cls.` or `this.`. A
 * definition's own signature is not a call, and a name two callables share is
 * skipped.
 */
function calleesOf(
  chosen: readonly ChosenWindow[],
  callables: readonly CollectedSymbol[],
  codeLines: readonly string[] | undefined,
): CollectedSymbol[] {
  if (codeLines === undefined) return [];
  const found: CollectedSymbol[] = [];
  for (const window of chosen) {
    const owner = window.symbol?.enclosingSymbol;
    for (let line = window.start; line <= window.end; line++) {
      const text = codeLines[line - 1];
      if (text === undefined || text === "") continue;
      for (const match of text.matchAll(/(?<![\w$.])(?:(self|cls|this)\s*\.\s*)?([A-Za-z_$][\w$]*)\s*\(/g)) {
        const name = match[2]!;
        const throughReceiver = match[1] !== undefined;
        const named = callables.filter((symbol) => symbol.name === name && (throughReceiver
          ? owner !== undefined
            && symbol.enclosingSymbol?.name === owner.name
            && symbol.enclosingSymbol.startLine === owner.startLine
          : symbol.enclosingSymbol === undefined));
        if (named.length !== 1) continue;
        const callee = named[0]!;
        if (line >= callee.signatureStartLine && line <= callee.signatureEndLine) continue;
        if (!found.includes(callee)) found.push(callee);
      }
    }
  }
  return found;
}

export interface ConsumerWindowInput {
  symbols: readonly CollectedSymbol[];
  references: readonly ArtifactReference[];
  /** Member paths the artifacts' dotted names reach in this file. */
  dottedMembers: ReadonlyArray<readonly string[]>;
  /** Identifiers the artifacts call or dot into. */
  namedMembers: ReadonlySet<string>;
  totalLines: number;
  displayBytes: (start: number, end: number) => number | undefined;
  budget?: number;
  /** Bytes of lines start-end with their comments kept, or undefined when they cannot be embedded. */
  rawBytes?: (start: number, end: number) => number | undefined;
  /** File-absolute windows the pack's renderer elides (`elideDocCommentsWithWindows`). */
  docBlocks?: ReadonlyArray<readonly [number, number]>;
  /** The file's lines with comments and docstrings blanked: what a served member's calls are read from. */
  codeLines?: readonly string[];
}

/**
 * The windows one consumer ships, in priority order until the per-file budget
 * runs out: the member holding a code reference, the member a dotted name
 * reaches, a member the artifact text calls, the member whose docstring names
 * the artifact, then the callables of this file those windows call. A
 * reference no member encloses ships a few lines of context. A stub member
 * ships whole (`whole`), and never merges with an elided neighbour.
 */
export function consumerWindows(input: ConsumerWindowInput): { windows: ArtifactConsumerWindow[]; members: string[] } {
  const callables = input.symbols.filter(isCallable);
  const candidates: WindowCandidate[] = [];
  const forReference = (reference: ArtifactReference): WindowCandidate => {
    const owner = innermostCallable(callables, reference.line);
    return owner !== undefined
      ? { start: owner.startLine, end: owner.endLine, focus: reference.line, member: memberLabel(owner), symbol: owner }
      : {
          start: Math.max(1, reference.line - CONTEXT_BEFORE),
          end: Math.min(input.totalLines, reference.line + CONTEXT_AFTER),
        };
  };
  const forMember = (symbol: CollectedSymbol): WindowCandidate =>
    ({ start: symbol.startLine, end: symbol.endLine, member: memberLabel(symbol), symbol });

  for (const reference of input.references) if (reference.kind === "code") candidates.push(forReference(reference));
  for (const members of input.dottedMembers) {
    const last = members[members.length - 1];
    if (last === undefined) continue;
    const owner = members.length > 1 ? members[members.length - 2] : undefined;
    const symbol = callables.find((entry) =>
      entry.name === last && (owner === undefined || entry.enclosingSymbol?.name === owner)
    );
    if (symbol !== undefined) candidates.push(forMember(symbol));
  }
  for (const symbol of callables) if (input.namedMembers.has(symbol.name)) candidates.push(forMember(symbol));
  for (const reference of input.references) {
    if (reference.kind !== "doc") continue;
    const owner = innermostCallable(callables, reference.line);
    if (owner !== undefined) candidates.push(forMember(owner));
  }
  if (candidates.length === 0 && input.dottedMembers.length > 0) {
    // The artifact names this module but no member of it: its class head, or
    // the module head (docstring and imports) when the name reaches no class.
    const named = new Set(input.dottedMembers.flatMap((members) => members.slice(0, 1)));
    const owner = input.symbols.find((entry) => entry.enclosingSymbol === undefined && named.has(entry.name));
    if (owner !== undefined) {
      const firstMember = callables.find((entry) => entry.enclosingSymbol?.name === owner.name
        && entry.enclosingSymbol.startLine === owner.startLine);
      candidates.push({
        start: owner.startLine,
        end: firstMember !== undefined ? Math.max(owner.startLine, firstMember.startLine - 1) : owner.endLine,
        member: owner.name,
      });
    } else {
      candidates.push({ start: 1, end: Math.min(input.totalLines, CONTEXT_BEFORE + CONTEXT_AFTER + 1) });
    }
  }
  if (candidates.length === 0 && input.references.length > 0) candidates.push(forReference(input.references[0]!));

  const budget = input.budget ?? ARTIFACT_CONSUMER_FILE_BYTES;
  const chosen: ChosenWindow[] = [];
  let used = 0;
  const place = (candidate: WindowCandidate): void => {
    if (chosen.some((window) => window.start <= candidate.start && candidate.end <= window.end)) return;
    const fitted = fitStubWhole(candidate, budget - used, input) ?? fitWindow(candidate, budget - used, input.displayBytes);
    if (fitted === undefined) return;
    if (chosen.some((window) => window.start <= fitted.start && fitted.end <= window.end)) return;
    chosen.push({
      start: fitted.start,
      end: fitted.end,
      ...(candidate.member ? { member: candidate.member } : {}),
      ...(candidate.symbol ? { symbol: candidate.symbol } : {}),
      ...("whole" in fitted ? { whole: true as const } : {}),
    });
    used += fitted.bytes;
  };
  for (const candidate of candidates) place(candidate);
  for (const callee of calleesOf(chosen, callables, input.codeLines)) place(forMember(callee));
  chosen.sort((left, right) => left.start - right.start);
  const windows: ArtifactConsumerWindow[] = [];
  for (const window of chosen) {
    const last = windows[windows.length - 1];
    const near = last !== undefined && window.start <= last.end + 1 + MERGE_GAP_LINES;
    // Adjacent windows merge when both are whole or both elided; a whole window
    // that overlaps an elided one ships elided with it.
    if (last !== undefined && near && (window.start <= last.end || last.whole === window.whole)) {
      if (last.whole !== window.whole) delete last.whole;
      last.end = Math.max(last.end, window.end);
    } else {
      windows.push({ start: window.start, end: window.end, ...(window.whole ? { whole: true as const } : {}) });
    }
  }
  const members = [...new Set(chosen.flatMap((window) => window.member ? [window.member] : []))];
  return { windows, members };
}

/** Names and line spans of a file's declarations: the part of a consumer no window carries. */
export function consumerOutline(symbols: readonly CollectedSymbol[]): string {
  const parts: string[] = [];
  for (const symbol of symbols) {
    if (symbol.enclosingSymbol !== undefined) continue;
    const span = `L${symbol.signatureStartLine}-${symbol.endLine}`;
    if (isCallable(symbol)) {
      parts.push(`${symbol.name}() ${span}`);
      continue;
    }
    if (symbol.kind !== "class" && symbol.kind !== "interface" && symbol.kind !== "enum") continue;
    const members = symbols
      .filter((member) => isCallable(member)
        && member.enclosingSymbol?.name === symbol.name
        && member.enclosingSymbol.startLine === symbol.startLine)
      .map((member) => `${member.name} L${member.signatureStartLine}-${member.endLine}`);
    parts.push(`${symbol.kind} ${symbol.name} ${span}${members.length > 0 ? ` [${members.join(", ")}]` : ""}`);
  }
  const outline = parts.join(" | ");
  return outline.length <= OUTLINE_MAX_CHARS ? outline : `${outline.slice(0, OUTLINE_MAX_CHARS - 1)}…`;
}

// ---------------------------------------------------------------------------
// The plan.
// ---------------------------------------------------------------------------

export interface ArtifactConsumerInput {
  /** Workspace-relative POSIX path of the file the pack edits or creates. */
  editTarget: string;
  /** Workspace-relative paths of the artifacts the pack requires. */
  artifacts: readonly string[];
  /** The artifact text this pack serves, one entry per served section. */
  servedTexts: ReadonlyArray<{ artifact: string; text: string }>;
  /** Candidate code files (workspace-relative, POSIX), the target and the pack's own surfaces excluded. */
  files: readonly string[];
  /** The edit target's package directory ("" = the workspace root). */
  packageRoot: string;
  read(relPath: string): string | undefined;
  language(relPath: string): string | undefined;
  isTest(relPath: string): boolean;
  symbols(relPath: string, text: string, language: string): Promise<readonly CollectedSymbol[]>;
  /**
   * Bytes of the pack's own rendering of lines start-end (with their comments
   * when `keepComments`), or undefined when it cannot embed them.
   */
  displayBytes(relPath: string, start: number, end: number, keepComments?: boolean): number | undefined;
}

export interface ArtifactConsumerPlan {
  path: string;
  windows: ArtifactConsumerWindow[];
  /** The first row's `why`: what makes this file a consumer, and its outline. */
  why: string;
}

type ConsumerStrength = 1 | 2 | 3;

interface ConsumerCandidate {
  path: string;
  inPackage: boolean;
  /** 3: a dotted name reaches it; 2: a code reference; 1: a comment/docstring mention. */
  strength: ConsumerStrength;
  proximity: number;
  test: boolean;
  references: ArtifactReference[];
  dotted: DottedResolution[];
}

/** The strongest fact that makes the file a consumer, and the served members an artifact calls by name. */
function consumerReason(
  candidate: ConsumerCandidate,
  served: readonly string[],
  namedBy: ReadonlyArray<{ artifact: string; members: ReadonlySet<string> }>,
): string {
  const facts: string[] = [];
  const dotted = [...candidate.dotted].sort((left, right) => right.members.length - left.members.length)[0];
  const code = candidate.references.find((reference) => reference.kind === "code");
  const doc = candidate.references.find((reference) => reference.kind === "doc");
  if (dotted !== undefined) {
    const segments = dotted.name.split(".");
    facts.push(`${dotted.artifact} names ${dotted.members.length > 0 ? dotted.members.join(".") : segments[segments.length - 1]}`);
  } else if (code !== undefined) {
    facts.push(`loads ${code.artifact} (L${code.line})`);
  } else if (doc !== undefined) {
    facts.push(`docstring names ${doc.artifact} (L${doc.line})`);
  }
  const dottedNames = new Set(candidate.dotted.flatMap((entry) => entry.members));
  for (const { artifact, members } of namedBy) {
    const calls = served
      .map((member) => member.slice(member.lastIndexOf(".") + 1))
      .filter((name) => members.has(name) && !dottedNames.has(name));
    if (calls.length > 0) facts.push(`${artifact} calls ${[...new Set(calls)].join(", ")}`);
  }
  return `artifact-consumer: ${facts.join("; ")}`;
}

export async function planArtifactConsumers(input: ArtifactConsumerInput): Promise<ArtifactConsumerPlan[]> {
  const basenames = [...new Set(input.artifacts.map((artifact) => path.posix.basename(artifact)))];
  if (basenames.length === 0 || input.files.length === 0) return [];

  const named = input.servedTexts.map(({ artifact, text }) => ({ artifact: path.posix.basename(artifact), names: artifactNames(text) }));
  const namedMembers = new Set(named.flatMap(({ names }) => [...names.members]));
  const namedBy = named.map(({ artifact, names }) => ({ artifact, members: names.members }));
  const dottedByFile = resolveDottedModules(
    named.flatMap(({ artifact, names }) => names.dotted.map((segments) => ({ segments, artifact }))),
    input.files,
    input.editTarget,
  );

  const scanned = [...input.files]
    .sort((left, right) =>
      sharedSegments(right, input.editTarget) - sharedSegments(left, input.editTarget) || left.localeCompare(right)
    )
    .slice(0, MAX_CONSUMER_SCAN_FILES);
  const candidates: ConsumerCandidate[] = [];
  for (const file of new Set([...dottedByFile.keys(), ...scanned])) {
    const text = input.read(file);
    if (text === undefined) continue;
    const references = artifactReferences(text, input.language(file), basenames);
    const dotted = dottedByFile.get(file) ?? [];
    if (references.length === 0 && dotted.length === 0) continue;
    const strength: ConsumerStrength = dotted.length > 0
      ? 3
      : references.some((reference) => reference.kind === "code") ? 2 : 1;
    const inPackage = isWithinDir(file, input.packageRoot);
    // Outside the target's package only a code reference or a dotted name is
    // evidence about the code the target will use; a doc mention there (a
    // Java DTO's javadoc naming the same workbook) is noise.
    if (!inPackage && strength < 2) continue;
    candidates.push({
      path: file,
      inPackage,
      strength,
      proximity: sharedSegments(file, input.editTarget),
      test: input.isTest(file),
      references,
      dotted,
    });
  }
  candidates.sort((left, right) =>
    Number(right.inPackage) - Number(left.inPackage)
    || right.strength - left.strength
    || right.proximity - left.proximity
    || Number(left.test) - Number(right.test)
    || left.path.localeCompare(right.path)
  );

  const plans: ArtifactConsumerPlan[] = [];
  for (const candidate of candidates) {
    if (plans.length >= MAX_ARTIFACT_CONSUMER_FILES) break;
    const text = input.read(candidate.path);
    if (text === undefined) continue;
    const language = input.language(candidate.path);
    const symbols = language === undefined ? [] : await input.symbols(candidate.path, text, language);
    const { windows, members } = consumerWindows({
      symbols,
      references: candidate.references,
      dottedMembers: candidate.dotted.map((entry) => entry.members),
      namedMembers,
      totalLines: lineCount(text),
      displayBytes: (start, end) => input.displayBytes(candidate.path, start, end),
      rawBytes: (start, end) => input.displayBytes(candidate.path, start, end, true),
      docBlocks: elideDocCommentsWithWindows(text, language, 1).elided,
      codeLines: codeLinesOf(text, language),
    });
    if (windows.length === 0) continue;
    const outline = consumerOutline(symbols);
    plans.push({
      path: candidate.path,
      windows,
      why: `${consumerReason(candidate, members, namedBy)}${outline.length > 0 ? ` | outline: ${outline}` : ""}`,
    });
  }
  return plans;
}
