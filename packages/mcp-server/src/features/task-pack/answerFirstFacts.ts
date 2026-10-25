// answerFirstFacts.ts — TL_EFF_MAP_ANSWER_FIRST (2026-10-23, codex-copilot-proxy
// answer-first experiment): the FACTS an answer-first structure map states
// about what it left out. Pure and fs-free, like structureMap.ts.
//
// An answer-first map is `act.answer` on its core evidence (structureMap.ts
// `coverMembers`): the bodies of the other members that call the named concerns
// stay owed. A reader who is not told that may describe a body it never saw,
// and the questions this map answers invite exactly the descriptions a missing
// body gets wrong (what a constant declared in the header is written by, in
// what order a cancellation compensates, whether a retry loop sleeps before
// its last attempt). The reply carries four kinds of fact about the unserved
// bodies, in this priority, in its existing top-level `advisory`:
//
//   A. which member bodies were not served — those of the members that call a
//      requested concern, with their line ranges — which were served whole, and
//      that every other member is signature-only (so a member the list does not
//      name is not taken for served);
//   B. the loop guards inside them that the Java loop-guard review computes
//      (javaLoopGuardReview.ts: the call a guard protects and the bound at
//      which it does not run);
//   C. a same-file lexical index of the constants declared in the served
//      lines: where each is used outside them, as a `set` (the value is
//      stored: an argument of a `set…(` call, or the whole right-hand side of
//      an assignment) or a `read` (anything else), and which are never
//      referenced outside their declaration. The classification is there so a
//      line that merely compares or looks up a constant is not described as
//      one that writes it (rubric O9: the real statusNote writes are 684/778,
//      855, 1086/1284, while the same constant is also read at 1394);
//   D. the concern calls of each unserved member, in source order, with the
//      calls that are ALTERNATIVES — the cases of one switch, the arms of one
//      if/else chain — marked by their arm and joined by " / " instead of
//      ", " (branchArms.ts), so `notifyFulfilled` (case FULFILLED) and
//      `release` (case DELIVERED) are not read as a sequence.
//
// WHAT A CONCERN CALL IS. A fact that says a member "calls payment" must not name a
// record accessor on its parameter that happens to be called `paymentMethod()` (a
// reader takes `dryRunPlace … req.paymentMethod` for a payment role, rubric O11). So
// wherever these facts decide it — the members listed in A, the cover, the index in D —
// a call counts under ONE rule (structureMap.ts `ConcernCallRule`, chosen once per type
// by readCodeTaskPack.ts `answerFirstStructureMap`): a call that hangs from one of the
// type's collaborator fields (`concernCallMatches`), and — for a type whose concern calls
// do not hang from a field it receives — a call whose receiver chain or callee names a
// concern, except a data accessor on a parameter or a local (`namedConcernCallMatches`).
// A member that reaches a concern only through a helper of the type is listed as such
// (`name a-b via helper`), not as a member that calls it.
//
// Facts only: no verb that asks the reader to do something, no tool name, no
// argument. What to read next is the agent's own choice. The text is
// assembled under a byte budget by dropping from the end (`composeAnswerFirstAdvisory`):
// D, then C, then B, and the unserved list is cut with "+N more" last; the core
// the reply certifies is never touched.

import { measureResponseBytes } from "../../protocol/budget/measure.js";
import { alternativeArms, armsAt, braceBlocks, branchArms, type BranchArm } from "./branchArms.js";
import { maskCommentsAndStrings } from "./sfCodeMask.js";
import {
  concernCallMatchesIn,
  concernMembers,
  concernMembersByReach,
  directConcernMembers,
  type ConcernCallRule,
  type StructureMapMember,
  type StructureMapType,
} from "./structureMap.js";

interface LineSpan {
  readonly start: number;
  readonly end: number;
}

/** A Java loop-guard review note and the lines it is about (javaLoopGuardReview.ts `JavaLoopGuardCandidate`). */
export interface AnswerFirstGuard {
  readonly firstLine: number;
  readonly lastLine: number;
  readonly text: string;
}

/** What the reply states, before it is fitted to a budget. */
export interface AnswerFirstFacts {
  /** `name a-b` for each member served whole (signature through its last line). */
  readonly served: readonly string[];
  /** `name a-b` for each owed member whose body was not served (signature excluded), `name a-b via helper` for one that calls a concern only through a helper of the type. */
  readonly notServed: readonly string[];
  /** The loop-guard review notes inside the unserved bodies, in source order. */
  readonly guards: readonly string[];
  /** Constants declared in served lines that nothing else in the file mentions. */
  readonly unreferencedConstants: readonly string[];
  /** `NAME: set L1 L2, read L3` for constants declared in served lines and used outside them (`formatConstantUses`). */
  readonly referencedConstants: readonly string[];
  /** `member call L<line>, call L<line> [arm] / call L<line> [arm]` for each unserved member that makes concern calls (`renderConcernCalls`). */
  readonly calls: readonly string[];
  /** The concerns the request names (`payment`, `inventory`, `shipping`): what the members in `notServed` are said to call. */
  readonly concerns: readonly string[];
  /** What is true of every member the lists do not name, exactly: `every other member is signature-only` (with the exceptions named), or "" when nothing exact can be said. */
  readonly others: string;
}

/** At most this many constants are indexed. */
export const ANSWER_FIRST_MAX_CONSTANTS = 8;
/** At most this many using lines are named per constant, the `set` lines first. */
export const ANSWER_FIRST_MAX_CONSTANT_LINES = 4;
/** At most this many calls are named per unserved member. */
export const ANSWER_FIRST_MAX_CALLS_PER_MEMBER = 8;

const rangeOf = (name: string, start: number, end: number): string => `${name} ${start}-${end}`;

/** True when every non-blank line of `[start, end]` is inside one of `served`. */
function allCodeServed(lines: readonly string[], start: number, end: number, served: readonly LineSpan[]): boolean {
  for (let line = start; line <= end; line += 1) {
    if ((lines[line - 1] ?? "").trim() === "") continue;
    if (!served.some((span) => span.start <= line && line <= span.end)) return false;
  }
  return true;
}

const inside = (line: number, spans: readonly LineSpan[]): boolean => spans.some((span) => span.start <= line && line <= span.end);

// A constant declaration, by the modifiers each language puts in front of one:
// Java / C# (`static final`, `static readonly`, `const`), Kotlin (`const val`,
// an upper-case `val`), TypeScript (`static readonly`, `readonly`), Python (an
// upper-case class attribute).
const CONSTANT_DECLARATIONS: readonly RegExp[] = [
  /\b(?:static\s+final|final\s+static|static\s+readonly|const)\b[^=;()]*?\b([A-Z][A-Z0-9_]{2,})\s*(?:=|;|:)/u,
  /\b(?:val|var|readonly)\s+([A-Z][A-Z0-9_]{2,})\s*(?:=|:|;)/u,
  /^\s{1,8}([A-Z][A-Z0-9_]{2,})\s*(?::\s*[\w[\], .|]+)?=[^=]/u,
];

/** `name` and the line it is declared on, for each constant declared on a served line of the type, in source order. */
function constantsDeclaredIn(
  type: StructureMapType,
  masked: readonly string[],
  served: readonly LineSpan[],
): Array<{ name: string; line: number }> {
  const out: Array<{ name: string; line: number }> = [];
  for (let line = type.signatureStart; line <= type.end; line += 1) {
    if (!inside(line, served)) continue;
    const text = masked[line - 1] ?? "";
    for (const pattern of CONSTANT_DECLARATIONS) {
      const match = pattern.exec(text);
      if (match?.[1] !== undefined) {
        if (!out.some((entry) => entry.name === match[1])) out.push({ name: match[1], line });
        break;
      }
    }
  }
  return out;
}

/**
 * How an occurrence of a constant is used: `set` when its value is stored there,
 * `read` for every other use, and `assigned` when the constant is itself the TARGET
 * of an assignment — its initializer (`NOTE = …;` in a static block or a
 * constructor), which is part of its declaration and neither a use of its value nor
 * a reference to it.
 */
export type ConstantUse = "set" | "read" | "assigned";

/** The stretch of text looked back over for the call whose parenthesis a constant is inside. */
const CALL_LOOKBACK_CHARS = 1_500;
/** A parenthesis after one of these is a condition or a header, not a call: a constant inside it is read. */
const HEADER_WORDS = new Set(["if", "while", "for", "switch", "catch", "synchronized", "return", "throw", "assert", "case", "with", "foreach", "using", "lock", "when", "elif"]);
/** A setter-style callee: `setStatusNote`, `set_status_note`. A bare `set(` (a map's) is not one. */
const SETTER_CALLEE = /^set[A-Z_][A-Za-z0-9_$]*$/u;
/** Callees that begin with `set` and store nothing of their argument's: the timers (`setTimeout(fn, DELAY_MS)` reads DELAY_MS). */
const NOT_A_SETTER = /^set(?:Timeout|Interval|Immediate)$/u;
/** An operator after an operand that makes it compared or tested: `NOTE == a`, `NOTE != null`, `NOTE && b`, `NOTE ? a : b`, `NOTE instanceof T`. */
const TESTED_BY_FOLLOWER = /^(?:==|!=|<=|>=|<(?!<)|>(?!>)|&&|\|\||\?|instanceof\b)/u;
/** An operator before an operand that makes it compared or tested: `a == NOTE`, `a < NOTE`, `a && NOTE`, `!NOTE`, `a instanceof NOTE`. Not `->`, `=>`, `<<`, `>>`. */
const TESTED_BY_PRECEDER = /(?:==|!=|<=|>=|&&|\|\||(?<![-=>])>(?!>)|(?<![<])<(?!<)|(?<![!=<>])!|\binstanceof)$/u;

/**
 * The index of the last character that is not whitespace before the possibly
 * qualified name that starts at `start` (`NOTE`, `Desk.NOTE`, `this.NOTE`, `a.b.NOTE`),
 * or undefined when something other than a name stands before a dot (`foo().NOTE`: a
 * member of a value, not the constant itself).
 */
function beforeQualifiedName(masked: string, start: number): number | undefined {
  let before = start - 1;
  for (;;) {
    while (before >= 0 && /\s/u.test(masked[before]!)) before -= 1;
    if (before < 0 || masked[before] !== ".") return before;
    before -= 1;
    while (before >= 0 && /\s/u.test(masked[before]!)) before -= 1;
    let qualifier = before;
    while (qualifier >= 0 && /[A-Za-z0-9_$]/u.test(masked[qualifier]!)) qualifier -= 1;
    if (qualifier === before) return undefined;
    before = qualifier;
  }
}

/** True when the occurrence is only compared or tested, by the operator that follows it (from `after`) or the one that precedes it (at `before`). */
function comparedOrTested(masked: string, before: number | undefined, after: number): boolean {
  if (TESTED_BY_FOLLOWER.test(masked.slice(after, after + 12))) return true;
  return before !== undefined && before >= 0 && TESTED_BY_PRECEDER.test(masked.slice(Math.max(0, before - 11), before + 1));
}

/**
 * Whether the occurrence of a constant at `masked[start, end)` stores its value
 * (`set`) or only uses it (`read`), lexically, in the comment- and string-masked
 * source `masked`:
 *
 *   set     the constant is an argument of the innermost call it is inside, that
 *           call is setter-style (`order.setStatusNote(NOTE)`, `setNote(a ? NOTE : b)`,
 *           `setNote(prefix + NOTE)`) and the constant is not merely compared or tested
 *           there (`setNote(NOTE == a ? b : c)` reads it); or it is the WHOLE
 *           right-hand side of an assignment to a field or local (`this.note = NOTE;`,
 *           `String n = NOTE;`, `note += NOTE;`);
 *   read    everything else: a receiver (`NOTE.equals(x)`, `TABLE.get(k)`, `TABLE[i]`,
 *           `TABLE::get`), a comparison, a switch label, an argument of any other
 *           call (`log.warn("…", NOTE)`, `Duration.minus(TTL)`), an operand
 *           (`BASE * (1L << n)`), a ternary arm, a return value;
 *   assigned the constant is the target of an assignment (`NOTE = other;`,
 *           `this.NOTE = other;`): its initializer, which is not a use.
 *
 * Deliberately narrow on `set`: a line described as a write that only reads is
 * the mistake this classification exists to prevent. A value stored after being
 * combined with others is `read` here. Languages that end a statement by the end
 * of its line are read as well (`this.note = NOTE` as the last token of a line).
 */
export function classifyConstantUse(masked: string, start: number, end: number): ConstantUse {
  let after = end;
  while (after < masked.length && /[ \t\r\n]/u.test(masked[after]!)) after += 1;
  const follower = masked[after];
  // The constant is the target of an assignment (`==`, `<=`, `>=`, `!=` and `=>` are not).
  if (/^(?:[-+*/%&|^]|<<|>>>?)?=(?![=>])/u.test(masked.slice(after, after + 5))) return "assigned";
  if (follower === "." || follower === "[" || (follower === ":" && masked[after + 1] === ":")) return "read";
  const before = beforeQualifiedName(masked, start);
  // The innermost call whose parenthesis encloses the occurrence (grouping parentheses and casts are looked through).
  let depth = 0;
  for (let i = start - 1; i >= 0 && start - i <= CALL_LOOKBACK_CHARS; i -= 1) {
    const ch = masked[i]!;
    if (ch === ")") {
      depth += 1;
    } else if (ch === "(") {
      if (depth > 0) {
        depth -= 1;
        continue;
      }
      const callee = /([A-Za-z_$][A-Za-z0-9_$]*)\s*$/u.exec(masked.slice(Math.max(0, i - 80), i))?.[1];
      if (callee === undefined) continue;
      if (HEADER_WORDS.has(callee)) return "read";
      if (!SETTER_CALLEE.test(callee) || NOT_A_SETTER.test(callee)) return "read";
      return comparedOrTested(masked, before, after) ? "read" : "set";
    } else if (depth === 0 && (ch === ";" || ch === "{" || ch === "}")) {
      break;
    }
  }
  // The whole right-hand side of an assignment. A qualified name (`Desk.NOTE`, `this.NOTE`) is one expression: its qualifier is looked through.
  if (before === undefined || before < 0 || masked[before] !== "=" || /[=!<>]/u.test(masked[before - 1] ?? "")) return "read";
  let q = end;
  while (q < masked.length && (masked[q] === " " || masked[q] === "\t")) q += 1;
  const next = masked[q];
  if (next === undefined || next === ";" || next === "," || next === ")") return "set";
  if (next === "\n" || next === "\r") {
    let r = q;
    while (r < masked.length && /\s/u.test(masked[r]!)) r += 1;
    const continuation = masked[r];
    if (continuation === undefined || !/[-+*/%&|^?:.<>=[(]/u.test(continuation)) return "set";
  }
  return "read";
}

/** A constant declared in served lines and used outside them: the lines that store it and the lines that read it. */
export interface ConstantUses {
  readonly name: string;
  readonly set: readonly number[];
  readonly read: readonly number[];
}

/** `NAME: set L1 L2, read L3 L4 +2`: the `set` lines first, at most `ANSWER_FIRST_MAX_CONSTANT_LINES` lines in all, each group counting the lines it leaves out. */
export function formatConstantUses(uses: ConstantUses): string {
  let room = ANSWER_FIRST_MAX_CONSTANT_LINES;
  const groups: string[] = [];
  for (const [word, where] of [["set", uses.set], ["read", uses.read]] as const) {
    if (where.length === 0) continue;
    const shown = where.slice(0, room);
    room -= shown.length;
    groups.push(`${word}${shown.map((line) => ` L${line}`).join("")}${where.length > shown.length ? ` +${where.length - shown.length}` : ""}`);
  }
  return `${uses.name}: ${groups.join(", ")}`;
}

/**
 * How the constants declared in the served lines are used elsewhere in the same
 * file: for each, the lines (comment- and string-masked, so a name inside a
 * message is no use) that mention it, other than its own declaration, outside
 * the served rows, each classified (`classifyConstantUse`; a line that both
 * stores and reads it counts as a store, and an assignment TO the constant — its
 * initializer — is no mention at all). A constant mentioned only by served
 * lines needs no fact and is left out; one nothing mentions is `unreferenced`.
 */
export function constantUses(
  type: StructureMapType,
  lines: readonly string[],
  served: readonly LineSpan[],
): { unreferenced: string[]; referenced: ConstantUses[] } {
  const masked = maskCommentsAndStrings(lines.join("\n"));
  const maskedLines = masked.split("\n");
  const lineStart: number[] = [];
  let offset = 0;
  for (const text of maskedLines) {
    lineStart.push(offset);
    offset += text.length + 1;
  }
  const unreferenced: string[] = [];
  const referenced: ConstantUses[] = [];
  for (const { name, line: declared } of constantsDeclaredIn(type, maskedLines, served)) {
    const pattern = new RegExp(`(?<![\\w$])${name}(?![\\w$])`, "gu");
    const set: number[] = [];
    const read: number[] = [];
    let anywhere = false;
    maskedLines.forEach((text, index) => {
      const line = index + 1;
      if (line === declared) return;
      let use: ConstantUse | undefined;
      for (const match of text.matchAll(pattern)) {
        const at = lineStart[index]! + match.index!;
        const found = classifyConstantUse(masked, at, at + name.length);
        if (found === "assigned") continue;
        if (use === undefined || found === "set") use = found;
      }
      if (use === undefined) return;
      anywhere = true;
      if (inside(line, served)) return;
      (use === "set" ? set : read).push(line);
    });
    if (!anywhere) unreferenced.push(name);
    else if (set.length + read.length > 0) referenced.push({ name, set, read });
  }
  const room = Math.max(0, ANSWER_FIRST_MAX_CONSTANTS - unreferenced.length);
  return { unreferenced: unreferenced.slice(0, ANSWER_FIRST_MAX_CONSTANTS), referenced: referenced.slice(0, room) };
}

/** `constantUses`, with each constant's uses written as `formatConstantUses` does. */
export function constantUsageFacts(
  type: StructureMapType,
  lines: readonly string[],
  served: readonly LineSpan[],
): { unreferenced: string[]; referenced: string[] } {
  const found = constantUses(type, lines, served);
  return { unreferenced: found.unreferenced, referenced: found.referenced.map(formatConstantUses) };
}

/** A concern call found in an unserved body: its text, its line and where it starts in the whole text. */
export interface FoundConcernCall {
  readonly call: string;
  readonly line: number;
  readonly offset: number;
}

/**
 * The calls of one member as the call index writes them: in source order, `call L<line>`,
 * separated by ", " when one runs after the other and by " / " when they are in different
 * arms of one switch or if/else chain (`arms`: branchArms.ts), each such call followed by
 * the arm it is in — `[case FULFILLED]`, `[else]`, `[case RETURNED > if from == SHIPPED]`
 * with the arms that tell it from the others, outermost first. A call whose arm has no
 * sibling arm with a call of this list is in sequence with the rest and carries nothing:
 * an `if` without an `else` is the alternative of no call. Past
 * `ANSWER_FIRST_MAX_CALLS_PER_MEMBER` calls the rest are counted (`, +N`).
 */
export function renderConcernCalls(found: readonly FoundConcernCall[], arms: readonly BranchArm[]): string {
  const paths = found.map((entry) => armsAt(arms, entry.offset));
  const shown = found.slice(0, ANSWER_FIRST_MAX_CALLS_PER_MEMBER);
  let text = "";
  shown.forEach((entry, index) => {
    const marks = paths[index]!.filter((arm) => paths.some((other, at) => at !== index && other.some((o) => o.construct === arm.construct && o.id !== arm.id)));
    const label = marks.length > 0 ? ` [${marks.map((arm) => arm.label).join(" > ")}]` : "";
    const separator = index === 0 ? "" : alternativeArms(paths[index - 1]!, paths[index]!) ? " / " : ", ";
    text += `${separator}${entry.call} L${entry.line}${label}`;
  });
  return found.length > shown.length ? `${text}, +${found.length - shown.length}` : text;
}

/**
 * The words of `terms` some member of `type` actually calls (`directConcernMembers`),
 * in the order of `terms`: a request's terms hold words no member calls (`slack`, a
 * subject, a clause's own words), and a list of members said to "call" them would
 * name a concern nothing calls.
 */
function calledConcerns(type: StructureMapType, lines: readonly string[], terms: readonly string[], rule: ConcernCallRule | undefined): string[] {
  const called = new Set<string>();
  for (const words of directConcernMembers(type, lines, terms, rule).values()) for (const word of words) called.add(word);
  return [...new Set(terms.map((term) => term.toLowerCase()))].filter((term) => called.has(term));
}

/** The number of non-blank lines of `member`'s body (after its signature) that lie inside the served rows. (A member has a body when `allCodeServed` of its lines after the signature is false with nothing served.) */
function servedBodyLines(lines: readonly string[], member: StructureMapMember, served: readonly LineSpan[]): number {
  let count = 0;
  for (let line = member.signatureEnd + 1; line <= member.end; line += 1) {
    if ((lines[line - 1] ?? "").trim() !== "" && inside(line, served)) count += 1;
  }
  return count;
}

/**
 * What can be said exactly of every member other than the cover: that it is
 * signature-only — no line of its body is on the page. `every other member is
 * signature-only`, or `every other member but A, B is signature-only` when some
 * body lines did ride along (a small member between two signature rows, a
 * constructor kept in the header). The list of unserved bodies names only the members
 * that call a concern; this keeps a reader from taking every member it does not name
 * for served. "" when there is nothing worth saying: no other member has a body, or
 * the members with a body on the page are as many as those without one (the clause
 * would list more exceptions than members it describes).
 */
function otherMembersClause(type: StructureMapType, lines: readonly string[], cover: readonly StructureMapMember[], served: readonly LineSpan[]): string {
  const withBody = type.members.filter((member) => !cover.includes(member) && !allCodeServed(lines, member.signatureEnd + 1, member.end, []));
  const partly = withBody.filter((member) => servedBodyLines(lines, member, served) > 0);
  const bare = withBody.length - partly.length;
  if (bare === 0 || bare <= partly.length) return "";
  if (partly.length === 0) return "every other member is signature-only";
  const names = partly.map((member) => (member.constructor ? "the constructor" : member.name));
  return `every other member but ${names.slice(0, 3).join(", ")}${names.length > 3 ? ` +${names.length - 3}` : ""} is signature-only`;
}

/**
 * The facts an answer-first map states: `cover` are the members served whole,
 * `served` the rows the page carries (source order), `guards` the loop-guard
 * review notes of the file (empty for a language without a review), `terms`
 * the concerns the request names and `lang` the file's language (the arms of a
 * switch or an if/else chain are read in the languages that mark blocks with
 * braces; absent, they are read).
 *
 * `rule` (else `collaborators`, the type's collaborator fields) is the rule for what a
 * "concern call" is wherever these facts decide it: a call counts, for the list of
 * members that call a concern and for the call index, only when that rule counts it
 * (structureMap.ts `ConcernCallRule`), so a record accessor on a parameter
 * (`req.paymentMethod()`) makes no member a payment member and no entry of the index.
 * Absent, and `collaborators` absent or empty, the map's own looser rule
 * (`invokesConcern`) applies.
 */
export function answerFirstFacts(input: {
  readonly type: StructureMapType;
  readonly lines: readonly string[];
  readonly terms: readonly string[];
  readonly cover: readonly StructureMapMember[];
  readonly served: readonly LineSpan[];
  readonly guards: readonly AnswerFirstGuard[];
  readonly lang?: string;
  readonly collaborators?: ReadonlySet<string>;
  readonly rule?: ConcernCallRule;
}): AnswerFirstFacts {
  const { type, lines, terms, cover, served, guards } = input;
  const rule: ConcernCallRule | undefined = input.rule ?? (input.collaborators !== undefined && input.collaborators.size > 0 ? input.collaborators : undefined);
  const concern = rule !== undefined ? concernMembersByReach(type, lines, terms, rule).all : concernMembers(type, lines, terms);
  const direct = new Set(directConcernMembers(type, lines, terms, rule).keys());
  const owed = concern.filter((member) => !cover.includes(member) && !allCodeServed(lines, member.signatureEnd + 1, member.end, served));
  const bodies = owed.map((member) => ({ member, start: member.signatureEnd + 1, end: member.end }));
  const text = lines.join("\n");
  const masked = maskCommentsAndStrings(text);
  const maskedLines = masked.split("\n");
  const lineStart: number[] = [];
  let offset = 0;
  for (const line of maskedLines) {
    lineStart.push(offset);
    offset += line.length + 1;
  }
  const braces = braceBlocks(input.lang);
  const calls: string[] = [];
  for (const { member, start, end } of bodies) {
    const found: FoundConcernCall[] = [];
    for (let line = start; line <= end; line += 1) {
      for (const match of concernCallMatchesIn(rule, member, maskedLines[line - 1] ?? "", terms)) found.push({ call: match.call, line, offset: lineStart[line - 1]! + match.index });
    }
    if (found.length === 0) continue;
    const arms = braces ? branchArms(masked, text, lineStart[start - 1]!, lineStart[end - 1]! + (maskedLines[end - 1] ?? "").length) : [];
    calls.push(`${member.name} ${renderConcernCalls(found, arms)}`);
  }
  const usage = constantUsageFacts(type, lines, served);
  return {
    served: cover.map((member) => rangeOf(member.name, member.signatureStart, member.end)),
    notServed: bodies.map(({ member, start, end }) => `${rangeOf(member.name, start, end)}${direct.has(member) ? "" : " via helper"}`),
    guards: guards
      .filter((guard) => bodies.some(({ start, end }) => start <= guard.firstLine && guard.lastLine <= end))
      .sort((left, right) => left.firstLine - right.firstLine)
      .map((guard) => guard.text),
    unreferencedConstants: usage.unreferenced,
    referencedConstants: usage.referenced,
    calls,
    concerns: calledConcerns(type, lines, terms, rule),
    others: otherMembersClause(type, lines, cover, served),
  };
}

/** The key the advisory rides under on the wire (`,"advisory":`), counted in the budget beside its JSON string. */
const ADVISORY_KEY_BYTES = Buffer.byteLength(',"advisory":', "utf8");

/** The bytes the advisory `text` takes on the wire: its JSON string and its key. */
export function advisoryWireBytes(text: string): number {
  return measureResponseBytes(JSON.stringify(text)) + ADVISORY_KEY_BYTES;
}

/** The advisory text composed for a budget, and how many of the tiers (A-D, those with something to state) it carries whole. */
export interface ComposedAnswerFirstAdvisory {
  readonly text: string;
  readonly tiers: number;
}

/**
 * The advisory for `facts` within `budgetBytes` (`advisoryWireBytes`): `text`
 * is "" when there is nothing to state (every owed body is served) or not even
 * the first tier fits. Tiers are A (served whole; unserved member bodies), B
 * (loop guards), C (constant usage), D (concern calls), added in that order
 * while they fit; the unserved list and the call index are cut at an entry
 * boundary with "+N more" rather than dropped whole, and a cut tier does not
 * count in `tiers`. The core the reply certifies is not part of this budget.
 */
export function composeAnswerFirst(facts: AnswerFirstFacts, budgetBytes: number): ComposedAnswerFirstAdvisory {
  if (facts.notServed.length === 0) return { text: "", tiers: 0 };
  const fits = (text: string): boolean => advisoryWireBytes(text) <= budgetBytes;
  const lead = `structure map: served whole: ${facts.served.join(", ")}`;
  // The members the list names are those that call a requested concern; every other member's body is not served either (`facts.others`).
  const callers = facts.concerns.length > 0 ? ` of members that call ${facts.concerns.slice(0, 4).join("/")}${facts.concerns.length > 4 ? `/+${facts.concerns.length - 4}` : ""}` : "";
  const unservedClause = (count: number): string => {
    const shown = facts.notServed.slice(0, count).join(", ");
    return `bodies not served${callers}: ${count < facts.notServed.length ? `${shown}, +${facts.notServed.length - count} more` : shown}${facts.others !== "" ? `; ${facts.others}` : ""}`;
  };
  let count = facts.notServed.length;
  while (count > 0 && !fits(`${lead}; ${unservedClause(count)}`)) count -= 1;
  if (count === 0) return { text: "", tiers: 0 };
  let text = `${lead}; ${unservedClause(count)}`;
  if (count < facts.notServed.length) return { text, tiers: 0 };
  let tiers = 1;
  const wanted: string[] = [];
  if (facts.guards.length > 0) wanted.push(`loop guards in unserved bodies: ${facts.guards.join(" | ")}`);
  const constants: string[] = [];
  if (facts.referencedConstants.length > 0) constants.push(`same-file references to constants declared in served lines (lexical): ${facts.referencedConstants.join("; ")}`);
  if (facts.unreferencedConstants.length > 0) constants.push(`no reference outside the declaration: ${facts.unreferencedConstants.join(", ")}`);
  if (constants.length > 0) wanted.push(constants.join("; "));
  for (const tier of wanted) {
    const next = `${text}; ${tier}`;
    if (!fits(next)) return { text, tiers };
    text = next;
    tiers += 1;
  }
  if (facts.calls.length === 0) return { text, tiers };
  const callsClause = (take: number): string => {
    const shown = facts.calls.slice(0, take).join(" | ");
    return `concern calls in unserved bodies, in source order: ${take < facts.calls.length ? `${shown} | +${facts.calls.length - take} more members` : shown}`;
  };
  for (let take = facts.calls.length; take > 0; take -= 1) {
    const next = `${text}; ${callsClause(take)}`;
    if (fits(next)) return { text: next, tiers: take === facts.calls.length ? tiers + 1 : tiers };
  }
  return { text, tiers };
}

/** `composeAnswerFirst`'s text alone. */
export function composeAnswerFirstAdvisory(facts: AnswerFirstFacts, budgetBytes: number): string {
  return composeAnswerFirst(facts, budgetBytes).text;
}
