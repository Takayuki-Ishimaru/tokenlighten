// structureMapElsewhere.ts — the members of a mapped type that live in OTHER
// files, counted and said, never mapped (design: bench/workflows/experiments/
// 2026-10-21-codex-copilot-proxy/drafts/fable-analysis-r16/out-of-line-maps-design.md,
// D4). A Go package declares one type's methods across its files (11 of the 27
// map-sized types of the audited standard library have methods in a sibling file,
// 6 outside tests: `Checker` in 34 files, `Transport` in 13, `Command` in
// cobra's 38); a Rust crate puts `impl` blocks of a type in other modules. The
// Stage 1 map is of ONE file: its rows, its required windows and its
// `remaining_ranges` are that file's, and the other files' members would be a
// map over several paths (Stage 2). What the reply owes the reader meanwhile is
// the fact that the map is not the whole type: one line in its `advisory`.
//
// LEXICAL AND BOUNDED. The scan counts, it does not parse: the sibling `*.go`
// files of the type's directory that declare the same package (never a
// `_test.go`), their `func (t *T) name` lines; the `*.rs` files of the type's
// directory and of the crate's `src/` above it, their `impl` blocks for the type
// (structureMapMembers.ts `rustImplBlocks`, the reading the same-file attribution
// uses). At most MAX_ELSEWHERE_FILES files are read, none larger than
// MAX_ELSEWHERE_FILE_BYTES; a directory the scan cannot list says nothing. The
// note names only what was counted.

import { listDirectory, posixDirname, posixJoin } from "./importGraphShared.js";
import { rustImplBlocks } from "./structureMapMembers.js";

/** At most this many sibling files are read per type. */
export const MAX_ELSEWHERE_FILES = 64;
/** A sibling over this many bytes is skipped (a generated table is not where a type's methods are hand-written). */
export const MAX_ELSEWHERE_FILE_BYTES = 1_500_000;
/** The note names at most this many files, most members first; the rest are counted. */
export const MAX_ELSEWHERE_NAMED_FILES = 5;

export interface StructureMapElsewhereEntry {
  /** Workspace-relative path of the file. */
  readonly path: string;
  readonly count: number;
}

export interface StructureMapElsewhere {
  /** What is counted: "method" (Go) or "impl block" (Rust). */
  readonly noun: "method" | "impl block";
  readonly entries: readonly StructureMapElsewhereEntry[];
  readonly total: number;
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

const basename = (relPath: string): string => relPath.slice(relPath.lastIndexOf("/") + 1);

/** The package clause of a Go source (its first `package x` line), or undefined. */
function goPackageOf(text: string): string | undefined {
  return /^\s*package\s+([A-Za-z_]\w*)/mu.exec(text)?.[1];
}

/** How many methods of `typeName` the Go source `text` declares (`func (t *T) name`, value, pointer, generic and unnamed receivers). */
export function goMethodCount(text: string, typeName: string): number {
  const method = new RegExp(`^func\\s*\\(\\s*(?:[A-Za-z_]\\w*\\s+)?\\*?\\s*${escapeRegExp(typeName)}\\s*(?:\\[[^\\]]*\\])?\\s*\\)\\s*[A-Za-z_]\\w*`, "gmu");
  return [...text.matchAll(method)].length;
}

/** The directories whose `.rs` files may hold `impl` blocks of a type declared in `typePath`: its own directory and, above it, the nearest `src/`. */
function rustDirectories(typePath: string): string[] {
  const own = posixDirname(typePath);
  const dirs = [own];
  for (let dir = own; dir !== ""; dir = posixDirname(dir)) {
    if (basename(dir) === "src") {
      if (dir !== own) dirs.push(dir);
      break;
    }
  }
  return dirs;
}

/**
 * The members of the type `typeName`, declared in `typePath`, that other files
 * declare — or undefined when `lang` has no such notion here, the directory
 * cannot be listed, or nothing was found. `read` gives a workspace-relative
 * file's text (the pack's memoized reader).
 */
export function structureMapElsewhere(input: {
  readonly workspace: string;
  readonly lang: string;
  readonly typeName: string;
  readonly typePath: string;
  readonly read: (relPath: string) => string | undefined;
}): StructureMapElsewhere | undefined {
  const { workspace, lang, typeName, typePath, read } = input;
  const entries: StructureMapElsewhereEntry[] = [];
  if (lang === "go") {
    const dir = posixDirname(typePath);
    const own = read(typePath);
    const ownPackage = own === undefined ? undefined : goPackageOf(own);
    const names = listDirectory(workspace, dir)
      .filter((name) => name.endsWith(".go") && !name.endsWith("_test.go") && posixJoin(dir, name) !== typePath)
      .slice(0, MAX_ELSEWHERE_FILES);
    for (const name of names) {
      const relPath = posixJoin(dir, name);
      const text = read(relPath);
      if (text === undefined || text.length > MAX_ELSEWHERE_FILE_BYTES) continue;
      const otherPackage = goPackageOf(text);
      if (ownPackage !== undefined && otherPackage !== undefined && otherPackage !== ownPackage) continue;
      const count = goMethodCount(text, typeName);
      if (count > 0) entries.push({ path: relPath, count });
    }
  } else if (lang === "rust") {
    let budget = MAX_ELSEWHERE_FILES;
    for (const dir of rustDirectories(typePath)) {
      for (const name of listDirectory(workspace, dir)) {
        const relPath = posixJoin(dir, name);
        if (!name.endsWith(".rs") || relPath === typePath || budget <= 0) continue;
        budget -= 1;
        const text = read(relPath);
        if (text === undefined || text.length > MAX_ELSEWHERE_FILE_BYTES) continue;
        const count = rustImplBlocks(text.split(/\r?\n/)).filter((block) => block.type === typeName).length;
        if (count > 0) entries.push({ path: relPath, count });
      }
    }
  } else return undefined;
  if (entries.length === 0) return undefined;
  entries.sort((left, right) => right.count - left.count || (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return { noun: lang === "go" ? "method" : "impl block", entries, total: entries.reduce((sum, entry) => sum + entry.count, 0) };
}

/**
 * The one line the reply's advisory carries for `elsewhere`:
 * `38 more methods of Command are declared in other files of this package:
 * completions.go (20), command_win.go (2), …`. Files in the type's own
 * directory are named by file name, others by path.
 */
export function structureMapElsewhereLine(typeName: string, typePath: string, elsewhere: StructureMapElsewhere): string {
  const dir = posixDirname(typePath);
  const named = elsewhere.entries.slice(0, MAX_ELSEWHERE_NAMED_FILES)
    .map((entry) => `${posixDirname(entry.path) === dir ? basename(entry.path) : entry.path} (${entry.count})`);
  const rest = elsewhere.entries.length - named.length;
  const list = `${named.join(", ")}${rest > 0 ? ` and ${rest} more file${rest === 1 ? "" : "s"}` : ""}`;
  const scope = elsewhere.noun === "method" ? "this package" : "this crate";
  const single = elsewhere.total === 1;
  const noun = single ? elsewhere.noun : `${elsewhere.noun}s`;
  return `${elsewhere.total} more ${noun} of ${typeName} ${single ? "is" : "are"} declared in ${single ? "another file" : "other files"} of ${scope}: ${list}`;
}

/** `structureMapElsewhere`, as its line, or undefined when there is nothing to say. */
export function structureMapElsewhereNote(input: Parameters<typeof structureMapElsewhere>[0]): string | undefined {
  const elsewhere = structureMapElsewhere(input);
  return elsewhere === undefined ? undefined : structureMapElsewhereLine(input.typeName, input.typePath, elsewhere);
}

/**
 * `existing` advisory with `line` appended after it — `; ` between, the way the
 * reply's other late additions join (protocol/readFamily.ts) — and never in its
 * place; `line` alone when there is no advisory yet.
 */
export function appendAdvisoryLine(existing: string | undefined, line: string): string {
  return existing === undefined || existing === "" ? line : `${existing}; ${line}`;
}

/** The shape of the line `structureMapElsewhereLine` writes. */
const ELSEWHERE_LINE_RE = /^\d+ more (?:methods?|impl blocks?) of \S+ (?:is|are) declared in (?:another file|other files) of this (?:package|crate): /u;

/**
 * The note line inside an advisory (`appendAdvisoryLine` joins lines with `; `), or
 * undefined. An auto-followed chain keeps this one line of the discover pack's
 * advisory (server.ts `mergeAutofollowReplies`): the note belongs to the pack that
 * served the map, which the follow-up's reply supersedes; any other advisory goes
 * with its pack, as it always has.
 */
export function structureMapElsewhereLineIn(advisory: string): string | undefined {
  return advisory.split("; ").find((part) => ELSEWHERE_LINE_RE.test(part));
}
