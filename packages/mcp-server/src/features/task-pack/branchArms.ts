// branchArms.ts — TL_EFF_MAP_ANSWER_FIRST (2026-10-23, codex-copilot-proxy answer-first
// experiment): the ARMS of a body of source — the cases of a switch and the arms of an
// if / else if / else chain — so a list of the calls in that body can say which of them are
// ALTERNATIVES. Pure and fs-free, like structureMap.ts.
//
// A call index that lists `notifyFulfilled L541, release L562` reads as a sequence. In
// transitionTo they are two cases of one switch: the first runs when the order becomes
// FULFILLED, the second when it becomes DELIVERED, and never both. A reader that takes the
// list for a sequence describes an order that is notified and then released, which the
// source does not do (rubric DQ-F). The calls that DO run in sequence — cancel's refund,
// release and void, each behind its own `if` with no `else` — are not alternatives of one
// another and carry no label; only an arm that has a sibling arm is an arm.
//
// LEXICAL, NOT A PARSER. The text is read as the comment- and string-masked source of a
// language that marks its blocks with braces, tokenised into words and punctuation, with
// brackets paired. Recognised:
//
//   switch (x) { case A: … case B: … default: … }      colon form, with fall-through
//   switch (x) { case A -> … case B, C -> … }          arrow form
//   if (c) { … } else if (d) { … } else { … }          braced arms
//   if (c) stmt; else stmt;                            a single simple statement as an arm
//
// A switch with a colon-form case that can fall into the next (its body does not end in `break`,
// `return`, `throw`, `continue` or `yield`) records no arms: two calls that may both run are
// not alternatives, and the index would say they never do. A chain of one arm (an `if` with no
// `else`) is not an alternative of anything and records no arm. A statement form this reader does not follow (`if (c) for (…) …`, an unbalanced
// bracket) ends the chain it is in rather than guessing: a missing arm only costs a label.
// Python, Ruby and the other languages that mark blocks by indentation are not read at all
// (`braceBlocks`).

/** Labels cut their condition or case expression to this many characters. */
export const BRANCH_ARM_LABEL_WIDTH = 24;

export interface BranchArm {
  /** The switch or if/else chain this arm belongs to: arms with the same `construct` are alternatives of one another. */
  readonly construct: number;
  /** Unique to the arm. */
  readonly id: number;
  /** `case FULFILLED`, `case A, B`, `default`, `if from == SHIPPED`, `else if x`, `else`. */
  readonly label: string;
  /** The arm's extent in the text: `[start, end)`; a case's runs from its terminator to the next label (or the switch's closing brace). */
  readonly start: number;
  readonly end: number;
}

/** True for the languages that mark their blocks with braces (the ids of util/languages.ts); the others are not read. */
export function braceBlocks(lang: string | undefined): boolean {
  return lang === undefined || /^(?:java|kotlin|typescript|typescriptreact|javascript|javascriptreact|go|rust|c|cpp|csharp|php)$/u.test(lang);
}

interface Tok {
  readonly text: string;
  readonly start: number;
  readonly end: number;
  readonly word: boolean;
}

const WORD_START = /[A-Za-z_$]/u;
const WORD_PART = /[A-Za-z0-9_$]/u;
const DIGIT = /[0-9]/u;
/** A statement that starts with one of these takes a body of its own: not a "single simple statement". */
const STATEMENT_KEYWORDS = new Set(["if", "else", "for", "while", "do", "switch", "try", "synchronized", "with", "match"]);

function tokenize(masked: string, from: number, to: number): Tok[] {
  const out: Tok[] = [];
  let i = from;
  while (i < to) {
    const ch = masked[i]!;
    if (ch <= " ") {
      i += 1;
    } else if (WORD_START.test(ch)) {
      let j = i + 1;
      while (j < to && WORD_PART.test(masked[j]!)) j += 1;
      out.push({ text: masked.slice(i, j), start: i, end: j, word: true });
      i = j;
    } else if (DIGIT.test(ch)) {
      let j = i + 1;
      while (j < to && /[A-Za-z0-9_.]/u.test(masked[j]!)) j += 1;
      out.push({ text: masked.slice(i, j), start: i, end: j, word: false });
      i = j;
    } else {
      const two = masked.slice(i, i + 2);
      const text = two === "->" || two === "::" || two === "=>" ? two : ch;
      out.push({ text, start: i, end: i + text.length, word: false });
      i += text.length;
    }
  }
  return out;
}

/** `pair[i]` = the index of the bracket that closes the one at token `i` (-1 when unmatched or no bracket). */
function pairBrackets(tokens: readonly Tok[]): Int32Array {
  const pair = new Int32Array(tokens.length).fill(-1);
  const stack: number[] = [];
  const closer: Record<string, string> = { "(": ")", "[": "]", "{": "}" };
  tokens.forEach((token, index) => {
    if (token.text === "(" || token.text === "[" || token.text === "{") {
      stack.push(index);
    } else if (token.text === ")" || token.text === "]" || token.text === "}") {
      // A closer that does not match the innermost opener drops the openers above its own.
      for (let top = stack.length - 1; top >= 0; top -= 1) {
        if (closer[tokens[stack[top]!]!.text] === token.text) {
          pair[stack[top]!] = index;
          stack.length = top;
          break;
        }
      }
    }
  });
  return pair;
}

function clip(text: string): string {
  const flat = text.replace(/\s+/gu, " ").replace(/["'`]/gu, "").trim();
  return flat.length > BRANCH_ARM_LABEL_WIDTH ? `${flat.slice(0, BRANCH_ARM_LABEL_WIDTH - 2)}..` : flat;
}

interface Scan {
  readonly original: string;
  readonly tokens: readonly Tok[];
  readonly pair: Int32Array;
  readonly out: BranchArm[];
  nextConstruct: number;
  nextId: number;
}

/** The index after the bracket pair opening at `index`, or `index + 1` when it is unmatched. */
function skipBracket(scan: Scan, index: number): number {
  const close = scan.pair[index]!;
  return close > index ? close + 1 : index + 1;
}

interface Body {
  /** The tokens of the body: `[first, last)`. */
  readonly first: number;
  readonly last: number;
  readonly start: number;
  readonly end: number;
  /** The token after the body. */
  readonly next: number;
}

/** The body of an arm that starts at token `index`: a braced block or one simple statement; undefined when it is neither. */
function bodyAt(scan: Scan, index: number): Body | undefined {
  const token = scan.tokens[index];
  if (token === undefined) return undefined;
  if (token.text === "{") {
    const close = scan.pair[index]!;
    if (close < 0) return undefined;
    return { first: index + 1, last: close, start: token.start, end: scan.tokens[close]!.end, next: close + 1 };
  }
  if (token.word && STATEMENT_KEYWORDS.has(token.text)) return undefined;
  let k = index;
  while (k < scan.tokens.length) {
    const t = scan.tokens[k]!;
    if (t.text === "(" || t.text === "[" || t.text === "{") {
      if (scan.pair[k]! < 0) return undefined;
      k = skipBracket(scan, k);
    } else if (t.text === ";") {
      return { first: index, last: k + 1, start: token.start, end: t.end, next: k + 1 };
    } else if (t.text === "}" || t.text === ")" || t.text === "]") {
      return undefined;
    } else {
      k += 1;
    }
  }
  return undefined;
}

const JUMPS = new Set(["break", "return", "throw", "continue", "yield"]);

/** True when the colon-form case body `[first, stop)` ends in a statement that leaves the switch, so control never falls into the next case. */
function endsWithJump(scan: Scan, first: number, stop: number): boolean {
  if (first >= stop) return false;
  let end = stop - 1;
  // A braced body (`case A: { …; break; }`) ends with its own closing brace.
  if (scan.tokens[first]!.text === "{" && scan.pair[first] === end) end -= 1;
  if (end < first || scan.tokens[end]!.text !== ";") return false;
  let k = end - 1;
  while (k >= first && scan.tokens[k]!.text !== ";" && scan.tokens[k]!.text !== "{" && scan.tokens[k]!.text !== "}") k -= 1;
  const head = scan.tokens[k + 1];
  return head !== undefined && head.word && JUMPS.has(head.text);
}

function scanRange(scan: Scan, from: number, to: number): void {
  let i = from;
  while (i < to) {
    const token = scan.tokens[i]!;
    if (token.word && scan.tokens[i + 1]?.text === "(") {
      const next = token.text === "switch" ? parseSwitch(scan, i)
        : token.text === "if" && !(i > from && scan.tokens[i - 1]!.text === "else") ? parseIf(scan, i)
          : -1;
      if (next > i) {
        i = next;
        continue;
      }
    }
    i += 1;
  }
}

interface Label {
  readonly at: number;
  readonly term: number;
  readonly part: string;
}

function parseSwitch(scan: Scan, index: number): number {
  const { tokens, pair } = scan;
  const condClose = pair[index + 1]!;
  if (condClose < 0 || tokens[condClose + 1]?.text !== "{") return -1;
  const open = condClose + 1;
  const close = pair[open]!;
  if (close < 0) return -1;
  // The labels of THIS switch: `case …:` / `case … ->` / `default:` / `default ->` outside any nested bracket.
  const labels: Label[] = [];
  let j = open + 1;
  while (j < close) {
    const token = tokens[j]!;
    if (token.text === "{" || token.text === "(" || token.text === "[") {
      j = skipBracket(scan, j);
      continue;
    }
    if (token.word && (token.text === "case" || token.text === "default")) {
      let k = j + 1;
      let term = -1;
      while (k < close) {
        const t = tokens[k]!;
        if (t.text === "(" || t.text === "[" || t.text === "{") {
          k = skipBracket(scan, k);
          continue;
        }
        if (t.text === ":" || t.text === "->") {
          term = k;
          break;
        }
        if (t.text === ";" || t.text === "}" || (token.text === "default" && k > j)) break;
        k += 1;
      }
      if (term > 0) {
        const part = token.text === "default" ? "default" : scan.original.slice(token.end, tokens[term]!.start);
        labels.push({ at: j, term, part });
        j = term + 1;
        continue;
      }
    }
    j += 1;
  }
  const construct = scan.nextConstruct++;
  // One arm per run of labels sharing a body (`case A: case B: stmt` is the arm `case A, B`).
  const arms: BranchArm[] = [];
  let fallsThrough = false;
  for (let n = 0; n < labels.length; n += 1) {
    const parts = [labels[n]!.part];
    let last = n;
    while (last + 1 < labels.length && labels[last]!.term + 1 === labels[last + 1]!.at) {
      last += 1;
      parts.push(labels[last]!.part);
    }
    const first = labels[last]!.term + 1;
    const stop = last + 1 < labels.length ? labels[last + 1]!.at : close;
    const shown = parts.map((part) => clip(part));
    const label = shown.length === 1 && shown[0] === "default" ? "default" : `case ${shown.join(", ")}`;
    // A body that is not the switch's last and does not leave it runs on into the next case (the arrow form never does).
    if (stop !== close && tokens[labels[last]!.term]!.text === ":" && !endsWithJump(scan, first, stop)) fallsThrough = true;
    arms.push({
      construct,
      id: scan.nextId++,
      label,
      start: tokens[labels[last]!.term]!.end,
      end: stop < tokens.length ? tokens[stop]!.start : tokens[close]!.start,
    });
    scanRange(scan, first, stop);
    n = last;
  }
  if (!fallsThrough) scan.out.push(...arms);
  return close + 1;
}

function parseIf(scan: Scan, index: number): number {
  const { tokens, pair } = scan;
  const construct = scan.nextConstruct++;
  const arms: BranchArm[] = [];
  const finish = (next: number): number => {
    // An `if` without an `else` is the alternative of nothing.
    if (arms.length >= 2) scan.out.push(...arms);
    return next;
  };
  let cur = index;
  let first = true;
  for (;;) {
    const condClose = pair[cur + 1]!;
    if (condClose < 0) return arms.length === 0 ? -1 : finish(cur);
    const body = bodyAt(scan, condClose + 1);
    if (body === undefined) return arms.length === 0 ? -1 : finish(cur);
    const condition = scan.original.slice(tokens[cur + 1]!.end, tokens[condClose]!.start);
    arms.push({ construct, id: scan.nextId++, label: `${first ? "if" : "else if"} ${clip(condition)}`, start: body.start, end: body.end });
    scanRange(scan, body.first, body.last);
    const next = body.next;
    if (tokens[next]?.word === true && tokens[next]!.text === "else") {
      if (tokens[next + 1]?.text === "if" && tokens[next + 2]?.text === "(") {
        cur = next + 1;
        first = false;
        continue;
      }
      const elseBody = bodyAt(scan, next + 1);
      if (elseBody === undefined) return finish(next);
      arms.push({ construct, id: scan.nextId++, label: "else", start: elseBody.start, end: elseBody.end });
      scanRange(scan, elseBody.first, elseBody.last);
      return finish(elseBody.next);
    }
    return finish(next);
  }
}

/**
 * The arms of the switches and if/else chains inside `masked[start, end)`, outermost first.
 * `masked` is the source with its comments and string literals blanked in place
 * (sfCodeMask.ts `maskCommentsAndStrings`: offsets are the original's) and `original` the
 * source it came from, which the labels are cut from.
 */
export function branchArms(masked: string, original: string, start: number, end: number): BranchArm[] {
  const tokens = tokenize(masked, start, end);
  const scan: Scan = { original, tokens, pair: pairBrackets(tokens), out: [], nextConstruct: 0, nextId: 0 };
  scanRange(scan, 0, tokens.length);
  return scan.out.sort((left, right) => left.start - right.start || right.end - left.end);
}

/** The arms of `arms` that contain `offset`, outermost first. */
export function armsAt(arms: readonly BranchArm[], offset: number): BranchArm[] {
  return arms.filter((arm) => arm.start <= offset && offset < arm.end).sort((left, right) => left.start - right.start || right.end - left.end);
}

/** True when the two paths hold different arms of one construct: the calls under them are alternatives, not a sequence. */
export function alternativeArms(left: readonly BranchArm[], right: readonly BranchArm[]): boolean {
  return left.some((a) => right.some((b) => a.construct === b.construct && a.id !== b.id));
}
