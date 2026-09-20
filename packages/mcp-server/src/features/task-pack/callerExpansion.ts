// callerExpansion.ts — TL_CALLER_EXPANSION (WP-S9, 2026-09-20).
// Turn-economy policy, DEFAULT OFF and a member of the TL_TURN_ECONOMY
// umbrella (see util/flags.ts's `callerExpansionEnabled` for the rollout
// rationale); with the flag unset nothing here is ever reached.
//
// PROBLEM (measured 2026-09-20, live GitHub Copilot sessions): an answer query
// that asks where a request ENTERS the system ("the cancellation API
// endpoint") is answered by a pack that serves the service class, the enum and
// the payment method — and not the HTTP handler that calls
// `orderService.cancel(id)`. The words of that clause ("API", "endpoint",
// "route", "entry point") do not occur in the handler's file at all, so no
// amount of LEXICAL locating can reach it: the relation is structural. The
// model then paid three extra turns (one `find`, two ranged reads) to walk one
// call edge the server already had every ingredient to walk, and one extra
// model turn prices at roughly 9-14 KB of served source on every host
// measured.
//
// MECHANISM: from the evidence the pack ALREADY selected, name at most two
// FOCAL MEMBERS (a surface focused on a method, or a method of a served type
// that the query names), find call sites of those members outside their own
// file, and serve the enclosing function of the best one. "Who calls this" is
// found by matching a call shape and a compatible RECEIVER, never by matching
// the clause's words.
//
// PURE / INJECTED I/O ONLY, exactly like concernRecovery.ts: every function
// here takes plain data — a line of text, a list of occurrences, a path pair.
// It never touches the filesystem, never reads a flag or env var, never sees
// task state. readCodeTaskPack.ts's small hook turns a real workspace scan and
// tree-sitter parse into these inputs, so this module is unit-testable from
// hand-built strings.
//
// GENERALITY: nothing below is keyed to a fixture, project, path or framework.
// The call shapes (`.m(`, `m(`, `::m(`, `->m(`), the receiver-naming
// convention (a field named after its type), and the "a thin entry layer calls
// a member once, a utility calls everything" ranking are properties of how
// code is written, not of any corpus. No annotation, decorator or framework
// name appears anywhere in this file.

// ---------------------------------------------------------------------------
// Tunables (structural, see module doc)
// ---------------------------------------------------------------------------

/** How many members one pack ever chases callers for. Two covers "the entry point" plus one collaborator; more turns an answer pack into a call graph. */
export const MAX_FOCAL_MEMBERS = 2;
/** Hard cap on added surfaces, whatever the pack's own remaining room is. */
export const MAX_CALLER_SURFACES = 2;
/** Hard cap on the total embedded bytes those surfaces may add. */
export const MAX_CALLER_EXPANSION_BYTES = 4096;
/** Margin each side of a call site when no enclosing symbol can be resolved. */
export const CALLER_WINDOW_MARGIN_LINES = 12;
/**
 * Files whose lines are examined in full after the cheap name scan has already
 * narrowed the workspace to files mentioning the member at all. A bound on
 * READS, next to the wall-clock budget the caller also applies: a member named
 * `get` in a large repo must not turn one pack into a whole-workspace parse.
 */
export const MAX_CALLER_FILES_EXAMINED = 40;
/**
 * Minimum normalized length for the WEAK receiver arm (a receiver that merely
 * ends with the type's name). The exact arm needs no guard; this one does,
 * because a two- or three-letter type name is the tail of far too many
 * unrelated identifiers. Mirrors salientWordMatch.ts's own reasoning about
 * short stems.
 */
const MIN_WEAK_RECEIVER_TYPE_CHARS = 4;
/** Receivers that can never denote the focal type: they denote the CALLING object. */
const SELF_RECEIVERS: ReadonlySet<string> = new Set(["this", "self", "super", "base", "cls", "me"]);
/** Extensions whose language starts a line comment with `#`. Anything not listed keeps `#` as ordinary code (C/C++ directives, C# regions). */
const HASH_COMMENT_EXTENSIONS: ReadonlySet<string> = new Set([
  ".py", ".rb", ".sh", ".bash", ".zsh", ".pl", ".pm", ".r", ".jl", ".yml", ".yaml", ".toml", ".ex", ".exs", ".cr", ".nim",
]);

// ---------------------------------------------------------------------------
// Focal members
// ---------------------------------------------------------------------------

/** A member the pack's own selected evidence is focused on — the thing whose CALLERS this expansion looks for. */
export interface CallerFocalMember {
  /** Workspace-relative file that DEFINES the member. Never added as its own caller. */
  readonly path: string;
  /** Simple name of the type the member belongs to (its enclosing class/interface, else the file's own stem) — the left-hand side of the receiver test. */
  readonly typeName: string;
  /** The member's own unqualified name. */
  readonly member: string;
}

export interface FocalMemberCandidate extends CallerFocalMember {
  /** Index of the selected surface this came from. The pack's own evidence order is the primary rank: surface 0 is what the locator certified. */
  readonly surfaceIndex: number;
  /** 0 when the SURFACE is focused on this member; 1 when the surface is a whole type and the QUERY named this member. A stated focus outranks an inferred one. */
  readonly tier: number;
  /** Character offset in the query of the word that named this member; Number.MAX_SAFE_INTEGER when the surface, not the query, named it. */
  readonly queryPosition: number;
  /**
   * Another selected surface is ALREADY focused on a member of this name, so
   * chasing this one asks the same question twice. Ranks last rather than
   * being dropped: with nothing else to pick it is still a real member.
   */
  readonly redundant: boolean;
}

/**
 * At most MAX_FOCAL_MEMBERS, preferring non-redundant members, then the pack's
 * own evidence order, then a stated focus over a query-named one, then the
 * earlier-named concern. One per FILE first, so two members of one served
 * class never crowd out a second served class's member — the pack's evidence
 * spread is the best proxy for what the request spread over.
 */
export function pickFocalMembers(candidates: readonly FocalMemberCandidate[]): FocalMemberCandidate[] {
  const ordered = [...candidates].sort((a, b) =>
    Number(a.redundant) - Number(b.redundant)
    || a.surfaceIndex - b.surfaceIndex
    || a.tier - b.tier
    || a.queryPosition - b.queryPosition
    || a.member.localeCompare(b.member)
  );
  const picked: FocalMemberCandidate[] = [];
  const takenKeys = new Set<string>();
  const takenPaths = new Set<string>();
  for (const pass of [0, 1]) {
    for (const candidate of ordered) {
      if (picked.length >= MAX_FOCAL_MEMBERS) return picked;
      const key = `${candidate.path}\0${candidate.member}`;
      if (takenKeys.has(key)) continue;
      if (pass === 0 && takenPaths.has(candidate.path)) continue;
      takenKeys.add(key);
      takenPaths.add(candidate.path);
      picked.push(candidate);
    }
  }
  return picked;
}

/** Case- and underscore-insensitive identifier normalization (the same rule readCodeTaskPack.ts's `normIdent` applies to token/surface matching). */
export function normalizeCallerIdent(text: string): string {
  return text.toLowerCase().replace(/[_$]/g, "");
}

// ---------------------------------------------------------------------------
// Call-site shapes
// ---------------------------------------------------------------------------

/** How a call names its member. `bare` carries no receiver and needs the file to name the focal type independently. */
export type CallQualifier = "dot" | "scope" | "arrow" | "bare";

export interface CallSiteOccurrence {
  /** 0-based index of the member name within the line. */
  readonly column: number;
  readonly qualifier: CallQualifier;
  /** The identifier immediately left of the qualifier when there is one (`orderService` in `this.orderService.cancel(`); absent for a bare call or a chained expression (`repo.find(id).cancel(`). */
  readonly receiver?: string;
  /** Masked line text left of the member name — the caller applies its own declaration-keyword test to this (a definition is not a call). */
  readonly before: string;
}

const IDENTIFIER_CHAR_RE = /[A-Za-z0-9_$]/;
const TRAILING_IDENTIFIER_RE = /([A-Za-z_$][A-Za-z0-9_$]*)$/;

/** True when `relPath`'s language opens a line comment with `#`. */
export function hasHashComments(relPath: string): boolean {
  const dot = relPath.lastIndexOf(".");
  return dot > 0 && HASH_COMMENT_EXTENSIONS.has(relPath.slice(dot).toLowerCase());
}

/**
 * Blanks out every span of `text` that is a string literal or a line/inline
 * comment, PRESERVING LENGTH so every column stays valid. A whole line that
 * opens with a block-comment marker or continuation is blanked outright: that
 * is the Javadoc/JSDoc body, where a prose sentence naming the member reads
 * exactly like a call.
 *
 * Deliberately single-line: a line in the middle of a multi-line string or
 * block comment with no opener of its own cannot be classified without
 * parsing, and this module abstains rather than guessing. The failure
 * direction is recall (a real call missed), never a false caller.
 */
export function maskNonCode(text: string, hashComment: boolean): string {
  const trimmed = text.trimStart();
  if (trimmed.startsWith("*") || trimmed.startsWith("/*") || trimmed.startsWith("//")) return " ".repeat(text.length);
  const out = [...text];
  let quote: string | undefined;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quote !== undefined) {
      out[i] = " ";
      if (ch === "\\") {
        if (i + 1 < text.length) out[i + 1] = " ";
        i++;
        continue;
      }
      if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      out[i] = " ";
      continue;
    }
    if ((ch === "/" && (text[i + 1] === "/" || text[i + 1] === "*")) || (hashComment && ch === "#")) {
      for (let j = i; j < text.length; j++) out[j] = " ";
      break;
    }
  }
  return out.join("");
}

/**
 * Every whole-word occurrence of `member` on `masked` that is shaped like a
 * CALL — the name followed by `(`, optionally preceded by `.`, `::` or `->`.
 * `masked` must already have been through `maskNonCode`.
 */
export function findCallOccurrences(masked: string, member: string): CallSiteOccurrence[] {
  if (member.length === 0) return [];
  const out: CallSiteOccurrence[] = [];
  for (let at = masked.indexOf(member); at >= 0; at = masked.indexOf(member, at + 1)) {
    const previous = at > 0 ? masked[at - 1]! : "";
    if (previous !== "" && IDENTIFIER_CHAR_RE.test(previous)) continue; // part of a longer identifier
    const after = masked.slice(at + member.length);
    if (!/^\s*\(/.test(after)) continue; // a mention, not a call
    const before = masked.slice(0, at);
    const beforeTrimmed = before.replace(/\s+$/u, "");
    let qualifier: CallQualifier = "bare";
    let receiverSide = beforeTrimmed;
    if (beforeTrimmed.endsWith("->")) {
      qualifier = "arrow";
      receiverSide = beforeTrimmed.slice(0, -2);
    } else if (beforeTrimmed.endsWith("::")) {
      qualifier = "scope";
      receiverSide = beforeTrimmed.slice(0, -2);
    } else if (beforeTrimmed.endsWith(".")) {
      qualifier = "dot";
      receiverSide = beforeTrimmed.slice(0, -1);
    }
    // A trailing `?`/`!` is optional chaining / a non-null assertion sitting
    // between the receiver and the dot (`svc?.cancel(`, `svc!.cancel(`), not
    // part of the receiver and not a reason to lose it.
    const receiver = qualifier === "bare"
      ? undefined
      : TRAILING_IDENTIFIER_RE.exec(receiverSide.replace(/[?!]+$/u, ""))?.[1];
    out.push({ column: at, qualifier, ...(receiver !== undefined ? { receiver } : {}), before });
  }
  return out;
}

/**
 * The part of an occurrence's preceding text that could be a DECLARATION HEAD:
 * everything after the last statement/expression separator on the line. A
 * declaration keyword only means "declaration" when it governs this name — in
 * `var response = orderService.cancel(id)` the `var` governs `response`, and
 * testing the whole prefix would read that ordinary call as a definition
 * (`var`, `let`, `const`, `public` and `static` are all in the shared
 * `IDENTIFIER_DEFINITION_KEYWORD_RE` keyword list for good reasons of their
 * own). The caller applies that ONE shared regex to this segment, so the
 * keyword list stays single-sourced.
 */
export function definitionSegment(before: string): string {
  const cut = /[=;{},(]/;
  let start = 0;
  for (let i = 0; i < before.length; i++) {
    if (cut.test(before[i]!)) start = i + 1;
  }
  return before.slice(start);
}

/**
 * True when a BARE occurrence (no receiver at all) sits at the head of its
 * line's code and that line opens a block — the shape of a method declaration
 * in a brace language whose declarations carry no keyword at all
 * (`cancel(id: number) {`). Costs recall on the rare bare call that opens a
 * block (`if (cancel(id)) {`), never a false caller, which is the direction
 * this whole mechanism errs in.
 */
export function opensBlockDeclaration(masked: string, before: string): boolean {
  return definitionSegment(before).trim().length === 0 && masked.trimEnd().endsWith("{");
}

/**
 * 2 = the receiver IS the focal type (`orderService.cancel(`, `OrderService::cancel(`);
 * 1 = the receiver only ENDS WITH the type's name (`primaryOrderService`), or
 *     the receiver is unrecognized / absent but the FILE names the focal type
 *     independently (an import, a field declaration, a parameter type) — a
 *     field is very often named for its role (`store.reserve(id)` for an
 *     `InventoryStore`), so the file-level reference is the corroboration that
 *     keeps the naming convention from being a requirement;
 * 0 = no compatible relation — this occurrence is NOT a call of this member,
 *     which is the abstain the whole mechanism rests on (`cache.cancel()` in a
 *     file that never mentions the focal type adds nothing).
 *
 * A self receiver (`this`, `self`, `super`) is 0 whatever the file names: it
 * denotes the CALLING object, so the call is that class's own same-named
 * method, not the focal one.
 */
export function receiverStrength(
  receiver: string | undefined,
  typeName: string,
  fileNamesType: boolean,
): 0 | 1 | 2 {
  const normalizedType = normalizeCallerIdent(typeName);
  if (normalizedType.length === 0) return 0;
  if (receiver !== undefined) {
    const normalizedReceiver = normalizeCallerIdent(receiver);
    if (SELF_RECEIVERS.has(normalizedReceiver)) return 0;
    if (normalizedReceiver === normalizedType) return 2;
    if (
      normalizedType.length >= MIN_WEAK_RECEIVER_TYPE_CHARS
      && normalizedReceiver.length > normalizedType.length
      && normalizedReceiver.endsWith(normalizedType)
    ) return 1;
  }
  return fileNamesType ? 1 : 0;
}

/** Whole-word occurrence of `typeName` anywhere in the file's code (an import, a field, a parameter, an extends clause). Comment/string spans are masked out first, so prose naming the type does not count. */
export function fileNamesType(lines: readonly string[], typeName: string, hashComment: boolean): boolean {
  if (typeName.length === 0) return false;
  for (const line of lines) {
    if (!line.includes(typeName)) continue;
    const masked = maskNonCode(line, hashComment);
    for (let at = masked.indexOf(typeName); at >= 0; at = masked.indexOf(typeName, at + 1)) {
      const previous = at > 0 ? masked[at - 1]! : "";
      const next = masked[at + typeName.length] ?? "";
      if (previous !== "" && IDENTIFIER_CHAR_RE.test(previous)) continue;
      if (next !== "" && IDENTIFIER_CHAR_RE.test(next)) continue;
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

export interface CallerSiteCandidate {
  readonly path: string;
  readonly line: number;
  readonly strength: 1 | 2;
  /** How many compatible call sites of this member the file holds — a thin entry layer calls it once; a utility that calls everything is not "the caller". */
  readonly callsInFile: number;
  /** Leading path segments shared with the focal file. */
  readonly proximity: number;
}

/** Leading path segments two workspace-relative paths share (the file's own basename never counts). */
export function sharedPathPrefixSegments(a: string, b: string): number {
  const left = a.split("/").slice(0, -1);
  const right = b.split("/").slice(0, -1);
  let shared = 0;
  while (shared < left.length && shared < right.length && left[shared] === right[shared]) shared++;
  return shared;
}

/**
 * (a) receiver-name match strength — how sure we are this really is a call of
 * the focal member; (b) fewer call sites in the file — a thin entry layer
 * calls the member once, a utility that calls everything is not the answer to
 * "where does the request enter"; (c) path proximity to the focal file. Then
 * path and line, so the order is total and stable across runs.
 */
export function rankCallSites(sites: readonly CallerSiteCandidate[]): CallerSiteCandidate[] {
  return [...sites].sort((a, b) =>
    b.strength - a.strength
    || a.callsInFile - b.callsInFile
    || b.proximity - a.proximity
    || a.path.localeCompare(b.path)
    || a.line - b.line
  );
}

/** The bounded window served when no enclosing symbol can be resolved around a call site. */
export function boundedCallerWindow(line: number, totalLines: number): { start: number; end: number } {
  return {
    start: Math.max(1, line - CALLER_WINDOW_MARGIN_LINES),
    end: Math.min(Math.max(totalLines, 1), line + CALLER_WINDOW_MARGIN_LINES),
  };
}

/** The `why` every added surface carries, so the addition is self-describing on the wire and greppable in a trace. */
export function callerExpansionWhy(focal: CallerFocalMember): string {
  return `caller-of:${focal.typeName}.${focal.member}`;
}

/** Does the request itself ask about tests? Only then may a test file be served as a caller. */
export function queryMentionsTests(query: string): boolean {
  return /\b(?:tests?|testing|spec|specs|fixtures?)\b/i.test(query) || query.includes("テスト");
}
