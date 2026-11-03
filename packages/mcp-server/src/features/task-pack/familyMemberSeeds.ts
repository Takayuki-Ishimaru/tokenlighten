/**
 * familyMemberSeeds.ts — the edit plan for "add a new member of an existing
 * family" requests (2026-11-02, external evaluation T2: "add a
 * SESSION_COOKIE_SALT config key" against a flask clone).
 *
 * The name the request asks to ADD does not exist yet, so every lexical
 * layer of the locator abstains on it, and the pack fell back to whatever
 * else the words of the request matched: the Sphinx `docs/conf.py` (the
 * `docs/` scope inferred from "docs/config.rst"), a three-line test fixture
 * whose file name is the project name, an import block that happened to
 * share a token. None of that is where the change goes. What the agent needs
 * from the first reply is where the SIBLINGS of the new name are defined and
 * consumed: a `SESSION_COOKIE_*` key belongs beside `SESSION_COOKIE_NAME`,
 * `SESSION_COOKIE_DOMAIN`, … in the defaults table, in the code that reads
 * those keys, in the page that documents them and in a test that exercises
 * one of them.
 *
 * Generic by construction: the family is derived from the identifier's own
 * shape (an underscore-separated name whose stem — every segment but the
 * last — names at least two OTHER identifiers in the workspace), never from a
 * vocabulary. `STATUS_ARCHIVED` beside `STATUS_OPEN`/`STATUS_CLOSED`,
 * `max_idle_seconds` beside `max_retry_seconds`/`max_wait_seconds`, a Go/Java
 * constant family — all the same rule. The seeds this module returns go
 * straight into the seeded builder (`buildSeededTaskPack`) as auto-discovered
 * caller paths, so the normal change-contract, readiness and closure
 * machinery owns the result; this module only decides WHICH windows.
 */

import * as fs from "node:fs";

import { readFileForRequest } from "../../util/requestFileCache.js";
import { decodeTextBuffer } from "../../util/textDecode.js";
import { walkCodeFiles } from "../../tools/walkRepo.js";
import type { TaskPackPathEntry } from "./model.js";

/** Documentation/config text the family's members are listed in beside the code files the walk tracks. */
const FAMILY_EXTRA_EXTS: readonly string[] = [".rst", ".md", ".mdx", ".txt", ".adoc", ".toml", ".yaml", ".yml", ".ini", ".cfg"];
const DOC_EXTS: ReadonlySet<string> = new Set([".rst", ".md", ".mdx", ".txt", ".adoc"]);
/** Files at/above this size are skipped by the family scan (fail-open, same bound as the locator's sibling scan). */
const FAMILY_SCAN_MAX_FILE_BYTES = 256 * 1024;
/** A definition/enumeration site lists >= 2 distinct siblings within this many lines. */
const FAMILY_WINDOW_LINES = 40;
const FAMILY_WINDOW_STEP_LINES = 20;
/** The widest served window: the siblings' own span when it fits, else the densest window. */
const FAMILY_MAX_SERVED_LINES = 96;
const FAMILY_WINDOW_MARGIN_LINES = 8;
const MAX_CODE_SEEDS = 3;
const MAX_DOC_SEEDS = 1;
const MAX_TEST_SEEDS = 1;
const MAX_FAMILY_IDENTIFIERS = 3;
/** The stem (without its trailing separator) must carry at least this many characters: `MAX_`/`ERR_` name no family. */
const MIN_STEM_CHARS = 4;

/**
 * An underscore-separated identifier (CONST_CASE or snake_case) with at least
 * two segments. A name glued to a path (`tests/test_config.py`) or carrying an
 * extension is a file, not a member.
 */
const UNDERSCORE_IDENTIFIER_RE = /(?<![\w./-])([A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+)(?![\w-]|\.[A-Za-z0-9]{1,5}\b)/g;

/**
 * The clause asks to add/introduce/create the name (EN) or 追加/新規/新しく/
 * 作成/導入/定義 it (JA). Judged on the item's own text, so "add a test that
 * covers X" and "add X" read the same: a name the clause adds and that occurs
 * nowhere yet is the thing to create, never a missing-code blocker.
 */
const INTRODUCE_EN_RE = /\b(?:add(?:s|ed|ing)?|introduc(?:e|es|ed|ing)|creat(?:e|es|ed|ing)|defin(?:e|es|ed|ing)|new|declar(?:e|es|ed|ing)|register(?:s|ed|ing)?|insert(?:s|ed|ing)?|append(?:s|ed|ing)?)\b/i;
const INTRODUCE_JA_RE = /追加|新規|新しく|新たに|作成|導入|定義|生やし|増やし|加え|足し/u;

export function requestIntroducesName(text: string, name: string): boolean {
  if (name.length === 0) return false;
  // The whole identifier, never a prefix of a longer one (`X` inside `X_FALLBACK`).
  if (!new RegExp(`(?<![\\w])${escapeRegExp(name)}(?![\\w])`).test(text)) return false;
  return INTRODUCE_EN_RE.test(text) || INTRODUCE_JA_RE.test(text);
}

/** The whole request carries an add/introduce intent (EN or JA), independent of a particular name. */
export function requestHasIntroduceIntent(query: string): boolean {
  return INTRODUCE_EN_RE.test(query) || INTRODUCE_JA_RE.test(query);
}

export interface FamilyMemberSeedPlan {
  /** The name the request adds (absent from the workspace). */
  readonly member: string;
  /** The family stem including its trailing separator (`SESSION_COOKIE_`). */
  readonly stem: string;
  /** Existing members of the family, most widely used first. */
  readonly siblings: readonly string[];
  /** Where the family is defined/enumerated most densely. */
  readonly definition: { readonly path: string; readonly range: string };
  /** Seeds for the seeded builder: definition, consumers, documentation, a test — in that order. */
  readonly seeds: readonly TaskPackPathEntry[];
}

interface FileFamilyHits {
  readonly relPath: string;
  readonly ext: string;
  readonly lineCount: number;
  /** Distinct siblings seen anywhere in the file. */
  readonly distinct: Set<string>;
  /** Sibling occurrences per line (1-based). */
  readonly lines: Map<number, Set<string>>;
  /** The densest FAMILY_WINDOW_LINES window: how many distinct siblings, where it starts. */
  readonly bestWindowDistinct: number;
  readonly bestWindowStart: number;
  /** Occurrence count, every sibling, every line. */
  readonly occurrences: number;
  /**
   * Declaration-shaped occurrences: the sibling is a key or an assignment
   * target (`"X": v`, `X = v`, `X: t`) — what a defaults table, an enum body,
   * a JSON/YAML object or a constants module looks like, as opposed to a read
   * (`config["X"]`, `:data:`X``). The definition site is the file that
   * declares the family, so this outranks raw occurrence counts.
   */
  readonly declarations: number;
}

/** `X` followed by an optional closing quote and a `:`/`=` that is not `==`. */
const DECLARATION_TAIL_RE = /^["'`]?\s*(?::(?!:)|=(?!=))/;

function isTestPath(relPath: string): boolean {
  return /(?:^|\/)(?:__tests__|tests?|specs?)(?:\/|$)/i.test(relPath)
    || /\.(?:spec|test)\.[^.]+$/i.test(relPath)
    || /(?:^|\/)test_[^/]*$/i.test(relPath)
    || /_test\.[a-z]+$/i.test(relPath);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The segment-class the member's own spelling uses, so `SESSION_COOKIE_` never claims `session_cookie_x`. */
function siblingTailClass(member: string): string {
  if (/^[A-Z0-9_]+$/.test(member)) return "[A-Z0-9_]";
  if (/^[a-z0-9_]+$/.test(member)) return "[a-z0-9_]";
  return "[A-Za-z0-9_]";
}

/** Candidate family members the request names, in request order, longest stem first on ties. */
export function familyMemberCandidates(query: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const match of query.matchAll(UNDERSCORE_IDENTIFIER_RE)) {
    const ident = match[1]!;
    if (seen.has(ident)) continue;
    const segments = ident.split("_");
    if (segments.length < 2) continue;
    const stem = segments.slice(0, -1).join("_");
    if (stem.length < MIN_STEM_CHARS) continue;
    seen.add(ident);
    out.push(ident);
    if (out.length >= MAX_FAMILY_IDENTIFIERS) break;
  }
  return out;
}

function scanFamily(
  workspace: string,
  member: string,
  stem: string,
): { memberExists: boolean; hits: FileFamilyHits[] } {
  const memberRe = new RegExp(`(?<![\\w])${escapeRegExp(member)}(?![\\w])`);
  const siblingRe = new RegExp(`(?<![\\w])${escapeRegExp(stem)}(${siblingTailClass(member)}+)(?![\\w])`, "g");
  const hits: FileFamilyHits[] = [];
  let memberExists = false;
  for (const file of walkCodeFiles(workspace, { extraExts: FAMILY_EXTRA_EXTS })) {
    let size: number;
    try { size = fs.statSync(file.absPath).size; } catch { continue; }
    if (size > FAMILY_SCAN_MAX_FILE_BYTES) continue;
    let text: string;
    try {
      const decoded = decodeTextBuffer(readFileForRequest(file.absPath));
      if (decoded === null) continue;
      text = decoded;
    } catch { continue; }
    if (!text.includes(stem)) continue;
    if (memberRe.test(text)) {
      memberExists = true;
      break;
    }
    const lines = text.split(/\r?\n/);
    const distinct = new Set<string>();
    const byLine = new Map<number, Set<string>>();
    let occurrences = 0;
    let declarations = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (!line.includes(stem)) continue;
      siblingRe.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = siblingRe.exec(line)) !== null) {
        const sibling = stem + m[1]!;
        if (sibling === member) continue;
        distinct.add(sibling);
        occurrences++;
        if (DECLARATION_TAIL_RE.test(line.slice(m.index + sibling.length))) declarations++;
        let set = byLine.get(i + 1);
        if (set === undefined) {
          set = new Set<string>();
          byLine.set(i + 1, set);
        }
        set.add(sibling);
      }
    }
    if (distinct.size === 0) continue;
    const lineNumbers = [...byLine.keys()].sort((a, b) => a - b);
    let bestWindowDistinct = 0;
    let bestWindowStart = lineNumbers[0]!;
    for (let start = 1; start <= lines.length; start += FAMILY_WINDOW_STEP_LINES) {
      const end = start + FAMILY_WINDOW_LINES - 1;
      const inWindow = new Set<string>();
      for (const lineNo of lineNumbers) {
        if (lineNo < start) continue;
        if (lineNo > end) break;
        for (const sibling of byLine.get(lineNo)!) inWindow.add(sibling);
      }
      if (inWindow.size > bestWindowDistinct) {
        bestWindowDistinct = inWindow.size;
        bestWindowStart = start;
      }
      if (start > lineNumbers[lineNumbers.length - 1]!) break;
    }
    hits.push({
      relPath: file.relPath,
      ext: file.ext,
      lineCount: lines.length,
      distinct,
      lines: byLine,
      bestWindowDistinct,
      bestWindowStart,
      occurrences,
      declarations,
    });
  }
  return { memberExists, hits };
}

/** The served window: the siblings' own span (with a margin) when it fits, otherwise the densest window. */
function servedRange(hit: FileFamilyHits, windowLines: number): string {
  const lineNumbers = [...hit.lines.keys()].sort((a, b) => a - b);
  const first = lineNumbers[0]!;
  const last = lineNumbers[lineNumbers.length - 1]!;
  let start: number;
  let end: number;
  if (last - first + 1 <= windowLines) {
    start = first - FAMILY_WINDOW_MARGIN_LINES;
    end = last + FAMILY_WINDOW_MARGIN_LINES;
  } else {
    // Densest window of `windowLines` lines over the sibling lines.
    let bestCount = -1;
    let bestStart = first;
    for (const candidateStart of lineNumbers) {
      const candidateEnd = candidateStart + windowLines - 1;
      let count = 0;
      for (const lineNo of lineNumbers) {
        if (lineNo < candidateStart) continue;
        if (lineNo > candidateEnd) break;
        count += hit.lines.get(lineNo)!.size;
      }
      if (count > bestCount) {
        bestCount = count;
        bestStart = candidateStart;
      }
    }
    start = bestStart - FAMILY_WINDOW_MARGIN_LINES;
    end = bestStart + windowLines - 1;
  }
  start = Math.max(1, start);
  end = Math.min(hit.lineCount, Math.max(end, start));
  return `${start}-${end}`;
}

function listSiblings(siblings: readonly string[], limit = 4): string {
  const shown = siblings.slice(0, limit).join(", ");
  return siblings.length > limit ? `${shown}, …` : shown;
}

/**
 * The family plan for the first add-intent identifier in `query` whose stem
 * names an existing family and which itself occurs nowhere in the workspace;
 * undefined when the request names no such identifier (every other request
 * shape is untouched).
 */
export function familyMemberSeedPlan(query: string, workspace: string): FamilyMemberSeedPlan | undefined {
  if (!requestHasIntroduceIntent(query)) return undefined;
  for (const member of familyMemberCandidates(query)) {
    const segments = member.split("_");
    const stem = segments.slice(0, -1).join("_") + "_";
    const { memberExists, hits } = scanFamily(workspace, member, stem);
    if (memberExists || hits.length === 0) continue;

    // The definition site first: the densest window of distinct siblings,
    // then the file that DECLARES them (keys/assignments) over one that reads
    // them, then breadth and raw count.
    const code = hits.filter((hit) => !DOC_EXTS.has(hit.ext) && !isTestPath(hit.relPath) && hit.bestWindowDistinct >= 2)
      .sort((a, b) => b.bestWindowDistinct - a.bestWindowDistinct || b.declarations - a.declarations || b.distinct.size - a.distinct.size || b.occurrences - a.occurrences || a.relPath.localeCompare(b.relPath));
    // No code file lists two siblings together: no family to extend.
    if (code.length === 0) continue;
    const docs = hits.filter((hit) => DOC_EXTS.has(hit.ext) && !isTestPath(hit.relPath) && hit.distinct.size >= 2)
      .sort((a, b) => b.distinct.size - a.distinct.size || b.occurrences - a.occurrences || a.relPath.localeCompare(b.relPath));
    const tests = hits.filter((hit) => isTestPath(hit.relPath))
      .sort((a, b) => b.distinct.size - a.distinct.size || b.occurrences - a.occurrences || a.relPath.localeCompare(b.relPath));

    // Family members, most widely used (distinct files) first.
    const usage = new Map<string, number>();
    for (const hit of hits) for (const sibling of hit.distinct) usage.set(sibling, (usage.get(sibling) ?? 0) + 1);
    const siblings = [...usage.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([name]) => name);
    if (siblings.length < 2) continue;

    // Each purpose becomes the served row's `why` (the seeded builder appends
    // "; caller-supplied" and `whySummary` cuts the whole at 60 characters),
    // so it is short: the family and the row's part in it, with the member
    // count. The advisory names the member.
    const definition = code[0]!;
    const seeds: TaskPackPathEntry[] = [];
    seeds.push({
      path: definition.relPath,
      range: servedRange(definition, FAMILY_MAX_SERVED_LINES),
      purpose: `${stem}* defined here (${definition.distinct.size})`,
    });
    for (const consumer of code.slice(1, MAX_CODE_SEEDS)) {
      seeds.push({
        path: consumer.relPath,
        range: servedRange(consumer, FAMILY_MAX_SERVED_LINES),
        purpose: `${stem}* read here (${consumer.distinct.size})`,
      });
    }
    for (const doc of docs.slice(0, MAX_DOC_SEEDS)) {
      seeds.push({
        path: doc.relPath,
        range: servedRange(doc, FAMILY_MAX_SERVED_LINES),
        purpose: `${stem}* documented here (${doc.distinct.size})`,
      });
    }
    for (const test of tests.slice(0, MAX_TEST_SEEDS)) {
      seeds.push({
        path: test.relPath,
        range: servedRange(test, FAMILY_MAX_SERVED_LINES),
        purpose: `${stem}* tested here (${test.distinct.size})`,
      });
    }
    addQuotedLiteralSeeds(query, workspace, seeds);
    return {
      member,
      stem,
      siblings,
      definition: { path: definition.relPath, range: seeds[0]!.range! },
      seeds,
    };
  }
  return undefined;
}

/** A literal the request quotes (`'cookie-session'`, "…", `…`, 「…」), long enough to search for. */
const QUOTED_LITERAL_RE = /[`"']([^`"'\n]{4,})[`"']|「([^」\n]{4,})」/gu;
const LITERAL_WINDOW_MARGIN_LINES = 12;
const MAX_LITERAL_SEEDS = 2;
/** A literal site this close to a seed's window joins that window instead of becoming a seed of its own. */
const LITERAL_JOIN_DISTANCE_LINES = 60;

/**
 * The request's quoted literals name sites of their own — the current value the
 * new member replaces or defaults to ("default 'cookie-session'" is the
 * serializer's `salt = "cookie-session"`, 60 lines below the window where the
 * family is read). A site inside or near a seeded window widens that window;
 * a site elsewhere (same file or another) becomes its own seed, so the edit
 * that changes the value has its line in the first reply.
 */
function addQuotedLiteralSeeds(query: string, workspace: string, seeds: TaskPackPathEntry[]): void {
  const literals: string[] = [];
  for (const match of query.matchAll(QUOTED_LITERAL_RE)) {
    const literal = (match[1] ?? match[2] ?? "").trim();
    if (literal.length >= 4 && !/\s{2,}/.test(literal) && !literals.includes(literal)) literals.push(literal);
  }
  if (literals.length === 0) return;
  const spanOf = (range: string): [number, number] => range.split("-").map(Number) as [number, number];
  let added = 0;
  for (const file of walkCodeFiles(workspace, { extraExts: FAMILY_EXTRA_EXTS })) {
    if (added >= MAX_LITERAL_SEEDS) break;
    if (isTestPath(file.relPath) || DOC_EXTS.has(file.ext)) continue;
    let size: number;
    try { size = fs.statSync(file.absPath).size; } catch { continue; }
    if (size > FAMILY_SCAN_MAX_FILE_BYTES) continue;
    let text: string;
    try {
      const decoded = decodeTextBuffer(readFileForRequest(file.absPath));
      if (decoded === null) continue;
      text = decoded;
    } catch { continue; }
    const literal = literals.find((candidate) => text.includes(candidate));
    if (literal === undefined) continue;
    const lines = text.split(/\r?\n/);
    const lineNo = lines.findIndex((line) => line.includes(literal)) + 1;
    if (lineNo === 0) continue;
    const own = seeds.filter((seed) => seed.path === file.relPath && seed.range !== undefined);
    const covering = own.find((seed) => {
      const [start, end] = spanOf(seed.range!);
      return lineNo >= start && lineNo <= end;
    });
    if (covering !== undefined) continue;
    const near = own.find((seed) => {
      const [start, end] = spanOf(seed.range!);
      return lineNo >= start - LITERAL_JOIN_DISTANCE_LINES && lineNo <= end + LITERAL_JOIN_DISTANCE_LINES;
    });
    if (near !== undefined) {
      const [start, end] = spanOf(near.range!);
      near.range = `${Math.max(1, Math.min(start, lineNo - LITERAL_WINDOW_MARGIN_LINES))}-${Math.min(lines.length, Math.max(end, lineNo + LITERAL_WINDOW_MARGIN_LINES))}`;
      continue;
    }
    seeds.push({
      path: file.relPath,
      range: `${Math.max(1, lineNo - LITERAL_WINDOW_MARGIN_LINES)}-${Math.min(lines.length, lineNo + LITERAL_WINDOW_MARGIN_LINES)}`,
      purpose: `'${literal.slice(0, 24)}' set here`,
    });
    added++;
  }
}

/** One advisory sentence for the pack: what is new, where its family lives. */
export function familyMemberAdvisory(plan: FamilyMemberSeedPlan): string {
  return `${plan.member} occurs nowhere yet: it is the name to add. Its ${plan.stem}* family (${listSiblings(plan.siblings)}) is defined in ${plan.definition.path}:${plan.definition.range}; the served windows are where the siblings are defined, read, documented and tested.`;
}
